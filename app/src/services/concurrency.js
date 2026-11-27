// Concurrency scenarios for Step 3 (Cases 1–3).
//
// A scenario is a set of transactions on one film. Each transaction starts at
// its own node and runs on the first reachable node holding the film (the same
// routing as the rest of the app). All transactions start together, and pauses
// inside them force them to overlap. Every step is timestamped so the page can
// show the schedule and flag anomalies.
//
// Writes are copied to the other node with the app's replicate(), so this keeps
// working unchanged when Member 3 replaces the replication module.

const { performance } = require('perf_hooks');
const config = require('../config');
const { getPool, isConnectionError } = require('../db/pools');
const { accessOrder, nodesHolding, fragmentNodeFor } = require('../db/fragment');
const { replicate } = require('./replication');

const OPS = ['read', 'update', 'delete'];
const WRITE_MODES = ['atomic', 'read-modify-write'];
const MAX_TRANSACTIONS = 6;
const BLOCKED_MS = 50; // a write slower than this was waiting for a lock

class ScenarioError extends Error {
  // status: 422 for bad input, 503 when a node needed for setup is down.
  constructor(errors, status = 422) {
    super(errors.join(' '));
    this.errors = errors;
    this.status = status;
  }
}

const nodeList = (ids) => (ids.length === 1 ? `Node ${ids[0]} is` : `Nodes ${ids.join(' and ')} are`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- presets ----------

// Builds Case 1–3 for a film. "f" is the fragment node holding the film.
function preset(caseNo, filmId) {
  const f = fragmentNodeFor(filmId);
  const base = { filmId, isolationLevel: config.isolationLevel, holdMs: 1500, writeMode: 'atomic', reset: true, baselineStock: 10 };
  const tx = (origin, op, startMs, extra = {}) => ({ origin, op, startMs, delta: 0, end: 'commit', ...extra });
  switch (Number(caseNo)) {
    case 1:
      return {
        ...base,
        title: 'Case 1: concurrent reads',
        transactions: [tx(1, 'read', 0), tx(f, 'read', 100), tx(f === 2 ? 3 : 2, 'read', 200)],
      };
    case 2:
      return {
        ...base,
        title: 'Case 2: one write, concurrent reads',
        transactions: [tx(f, 'update', 0, { delta: 5 }), tx(f, 'read', 300), tx(1, 'read', 300)],
      };
    case 3:
      return {
        ...base,
        title: 'Case 3: concurrent writes',
        transactions: [tx(1, 'update', 0, { delta: 5 }), tx(f, 'update', 300, { delta: -3 }), tx(1, 'update', 600, { delta: 2 })],
      };
    default:
      return null;
  }
}

// ---------- validation ----------

function intIn(value, min, max) {
  const s = String(value ?? '').trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

// Validates a scenario from JSON or from the form (already reshaped).
function parseSpec(body) {
  const errors = [];
  const spec = {};

  spec.filmId = intIn(body.filmId, 1, 2147483647);
  if (spec.filmId == null) errors.push('Film ID must be a positive whole number.');

  const level = String(body.isolationLevel || '').toUpperCase();
  if (level === 'ALL' || config.ISOLATION_LEVELS.includes(level)) spec.isolationLevel = level;
  else errors.push(`Isolation level must be one of ${config.ISOLATION_LEVELS.join(', ')} or ALL.`);

  spec.holdMs = intIn(body.holdMs, 0, 10000);
  if (spec.holdMs == null) errors.push('Hold time must be 0 to 10000 ms.');

  spec.writeMode = WRITE_MODES.includes(body.writeMode) ? body.writeMode : null;
  if (!spec.writeMode) errors.push(`Write mode must be ${WRITE_MODES.join(' or ')}.`);

  spec.reset = body.reset === true || body.reset === 'on' || body.reset === 'true';
  spec.baselineStock = intIn(body.baselineStock, 0, 1000000);
  if (spec.reset && spec.baselineStock == null) errors.push('Starting stock must be 0 to 1000000.');

  const txs = Array.isArray(body.transactions) ? body.transactions.filter((t) => t && t.op !== 'none') : [];
  if (txs.length < 1 || txs.length > MAX_TRANSACTIONS) {
    errors.push(`Use 1 to ${MAX_TRANSACTIONS} transactions.`);
  }
  spec.transactions = txs.slice(0, MAX_TRANSACTIONS).map((t, i) => {
    const n = i + 1;
    const out = {
      origin: intIn(t.origin, 1, 3),
      op: OPS.includes(t.op) ? t.op : null,
      delta: t.op === 'update' ? intIn(t.delta, -100000, 100000) : 0,
      startMs: intIn(t.startMs ?? 0, 0, 10000),
      end: t.end === 'rollback' ? 'rollback' : 'commit',
    };
    if (out.origin == null) errors.push(`T${n}: node must be 1, 2 or 3.`);
    if (!out.op) errors.push(`T${n}: operation must be ${OPS.join(', ')}.`);
    if (out.delta == null) errors.push(`T${n}: stock change must be a whole number.`);
    if (out.startMs == null) errors.push(`T${n}: start delay must be 0 to 10000 ms.`);
    return out;
  });

  if (errors.length) throw new ScenarioError(errors);
  return spec;
}

// ---------- running ----------

async function connectFirst(order) {
  const skipped = [];
  for (const nodeId of order) {
    try {
      return { conn: await getPool(nodeId).getConnection(), nodeId, skipped };
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      skipped.push({ nodeId, error: err.code || err.message });
    }
  }
  const err = new Error(`No node holding the film is reachable (${skipped.map((s) => `Node ${s.nodeId}: ${s.error}`).join('; ')})`);
  err.code = 'ALL_NODES_DOWN';
  throw err;
}

async function readReplicas(filmId) {
  return Promise.all(
    nodesHolding(filmId).map(async (nodeId) => {
      try {
        const [rows] = await getPool(nodeId).query('SELECT film_id, title, stock, rental_rate, rental_duration FROM film WHERE film_id = ?', [filmId]);
        return { nodeId, up: true, row: rows[0] || null };
      } catch (err) {
        if (!isConnectionError(err)) throw err;
        return { nodeId, up: false, error: err.code || err.message };
      }
    }),
  );
}

// Puts the film back to a known state on every node holding it, so runs are
// comparable. This is test setup, written straight to each node.
async function resetFilm(filmId, stock) {
  const before = await readReplicas(filmId);
  const down = before.filter((r) => !r.up);
  if (down.length) {
    throw new ScenarioError([`Can't reset the film: ${nodeList(down.map((d) => d.nodeId))} unreachable. Turn off "reset" to run anyway.`], 503);
  }
  const existing = before.find((r) => r.row)?.row;
  const row = {
    title: existing?.title ?? `Concurrency test film ${filmId}`,
    rental_rate: existing?.rental_rate ?? 0.99,
    rental_duration: existing?.rental_duration ?? 3,
  };
  for (const { nodeId } of before) {
    await getPool(nodeId).execute(
      `INSERT INTO film (film_id, title, stock, rental_rate, rental_duration) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE stock = VALUES(stock)`,
      [filmId, row.title, stock, row.rental_rate, row.rental_duration],
    );
  }
}

async function runTransaction(n, tx, ctx) {
  const { filmId, isolationLevel, holdMs, writeMode, log, now } = ctx;
  const result = { tx: n, ...tx, dbNode: null, reads: [], status: 'not started' };
  await sleep(tx.startMs);

  let conn;
  try {
    const connected = await connectFirst(accessOrder(filmId, tx.origin));
    conn = connected.conn;
    result.dbNode = connected.nodeId;
    for (const s of connected.skipped) log(n, 'info', `Node ${s.nodeId} unreachable (${s.error})`);

    await conn.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
    await conn.beginTransaction();
    log(n, 'begin', `BEGIN on Node ${result.dbNode}`);

    const read = async (label, own = false) => {
      const [rows] = await conn.query('SELECT film_id, title, stock, rental_rate, rental_duration FROM film WHERE film_id = ?', [filmId]);
      const row = rows[0] || null;
      const t = now();
      if (!own) result.reads.push({ t, value: row ? row.stock : null });
      log(n, 'read', `${label}: ${row ? `stock = ${row.stock}` : 'no row'}`);
      return row;
    };

    const first = await read('READ');

    if (tx.op === 'read') {
      await sleep(holdMs);
      await read('READ again');
    } else {
      const started = now();
      let sql;
      let affected;
      if (tx.op === 'delete') {
        sql = 'DELETE';
        [{ affectedRows: affected }] = await conn.execute('DELETE FROM film WHERE film_id = ?', [filmId]);
      } else if (writeMode === 'atomic') {
        sql = `UPDATE stock = stock ${tx.delta < 0 ? '-' : '+'} ${Math.abs(tx.delta)}`;
        [{ affectedRows: affected }] = await conn.execute('UPDATE film SET stock = stock + ? WHERE film_id = ?', [tx.delta, filmId]);
      } else {
        const target = first ? first.stock + tx.delta : null;
        sql = `UPDATE stock = ${target ?? '?'} (read ${first?.stock ?? 'nothing'} ${tx.delta < 0 ? '-' : '+'} ${Math.abs(tx.delta)})`;
        [{ affectedRows: affected }] = first
          ? await conn.execute('UPDATE film SET stock = ? WHERE film_id = ?', [target, filmId])
          : [{ affectedRows: 0 }];
      }
      const waited = now() - started;
      result.writeT = now();
      result.waitedMs = waited;
      log(n, 'write', `${sql} → ${affected} row${affected === 1 ? '' : 's'}${waited > BLOCKED_MS ? ` (waited ${waited} ms for a lock)` : ''}`, { waitedMs: waited });

      if (tx.op === 'update') {
        result.film = await read('Read own write', true);
        result.writtenValue = result.film?.stock ?? null;
      }
      await sleep(holdMs);
    }

    if (tx.op !== 'read' && tx.end === 'rollback') {
      await conn.rollback();
      result.status = 'rolled back';
      result.endT = now();
      log(n, 'rollback', 'ROLLBACK');
    } else {
      await conn.commit();
      result.status = 'committed';
      result.endT = now();
      log(n, 'commit', 'COMMIT');
    }
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
      } catch {
        // connection may be gone
      }
    }
    result.status = 'failed';
    result.endT = now();
    result.error = err.code || err.message;
    log(n, 'error', `${err.code || 'ERROR'}: ${err.sqlMessage || err.message}`);
  } finally {
    if (conn) conn.release();
  }

  // Replicate only committed writes that changed something.
  if (result.status === 'committed' && tx.op !== 'read' && (tx.op === 'delete' || result.film)) {
    const replication = await replicate({ op: tx.op, filmId, film: result.film, origin: result.dbNode });
    result.replication = replication;
    for (const r of replication) {
      log(n, 'replicate', r.ok ? `Replicated to Node ${r.nodeId}` : `Replication to Node ${r.nodeId} failed (${r.error})`);
    }
  }
  return result;
}

// ---------- analysis ----------

const stockOf = (replica) => (replica.up ? (replica.row ? replica.row.stock : null) : undefined);

function analyse({ transactions, before, after, baseline }) {
  const findings = [];
  const add = (kind, level, text) => findings.push({ kind, level, text });

  const writers = transactions.filter((t) => t.op !== 'read');
  for (const r of transactions.filter((t) => t.op === 'read')) {
    // Dirty read: saw a writer's value before that writer committed.
    for (const w of writers) {
      if (w.dbNode !== r.dbNode || w.writtenValue == null || w.writtenValue === baseline) continue;
      const commitT = w.status === 'committed' ? w.endT : Infinity;
      const dirty = r.reads.find((read) => read.value === w.writtenValue && read.t > w.writeT && read.t < commitT);
      if (dirty) {
        add('dirty-read', 'warn', `T${r.tx} read stock = ${dirty.value} before T${w.tx} ${w.status === 'committed' ? 'committed' : 'rolled back'} (dirty read).`);
      }
    }
    if (r.reads.length === 2 && r.reads[0].value !== r.reads[1].value) {
      add('non-repeatable-read', 'warn', `T${r.tx} read stock = ${r.reads[0].value}, then ${r.reads[1].value} in the same transaction (non-repeatable read).`);
    }
    if (r.reads.length === 2 && r.reads[0].value === r.reads[1].value && r.status === 'committed') {
      add('repeatable', 'ok', `T${r.tx} read the same value twice (${r.reads[0].value}).`);
    }
  }

  for (const t of transactions) {
    if (t.waitedMs > BLOCKED_MS) add('blocked', 'info', `T${t.tx} waited ${t.waitedMs} ms for a row lock on Node ${t.dbNode}.`);
    if (t.status === 'failed' && t.error === 'ALL_NODES_DOWN') {
      add('failed', 'warn', `T${t.tx} could not start: no node holding the film is reachable.`);
    } else if (t.status === 'failed') {
      const why = { ER_LOCK_DEADLOCK: 'deadlock', ER_LOCK_WAIT_TIMEOUT: 'lock wait timeout' }[t.error] || t.error;
      add('failed', 'warn', `T${t.tx} failed and was rolled back (${why}).`);
    }
    for (const r of t.replication || []) {
      if (!r.ok) add('replication-failed', 'warn', `T${t.tx}'s change was not replicated to Node ${r.nodeId} (${r.error}).`);
    }
  }

  // Final state across replicas.
  const live = after.filter((r) => r.up);
  const values = live.map(stockOf);
  const agree = live.length === after.length && values.every((v) => v === values[0]);
  if (live.length < after.length) add('replica-down', 'warn', 'A node holding the film is down, so the replicas could not all be compared.');
  else if (agree) add('consistent', 'ok', `All replicas agree: ${values[0] == null ? 'film deleted' : `stock = ${values[0]}`}.`);
  else add('diverged', 'warn', `Replicas disagree: ${after.map((r) => `Node ${r.nodeId} ${stockOf(r) == null ? 'has no row' : `stock = ${stockOf(r)}`}`).join(', ')}.`);

  // Expected final value from the committed writes.
  const committed = writers.filter((w) => w.status === 'committed');
  let expected;
  if (baseline != null && committed.length) {
    expected = committed.some((w) => w.op === 'delete') ? null : baseline + committed.reduce((s, w) => s + w.delta, 0);
    const wrong = live.filter((r) => stockOf(r) !== expected);
    if (wrong.length) {
      const kind = committed.filter((w) => w.op === 'update').length > 1 ? 'lost-update' : 'unexpected';
      add(kind, 'warn', `Expected ${expected == null ? 'the film to be deleted' : `stock = ${expected}`} after the committed writes, but ${wrong.map((r) => `Node ${r.nodeId} has ${stockOf(r) == null ? 'no row' : stockOf(r)}`).join(', ')}${kind === 'lost-update' ? ' (lost update)' : ''}.`);
    } else if (agree) {
      add('expected', 'ok', `Final state matches every committed write (${expected == null ? 'deleted' : `stock = ${expected}`}).`);
    }
  }

  return { findings, consistent: agree && !findings.some((f) => f.kind === 'lost-update' || f.kind === 'unexpected'), expected };
}

// Turns the event log into rows for a schedule table: one column per transaction.
function scheduleRows(events, txCount) {
  return [...events]
    .sort((a, b) => a.t - b.t || a.seq - b.seq)
    .map((e) => {
      const cells = Array.from({ length: txCount }, () => null);
      cells[e.tx - 1] = { kind: e.kind, text: e.text };
      return { t: e.t, cells };
    });
}

async function runOnce(spec, isolationLevel) {
  if (spec.reset) await resetFilm(spec.filmId, spec.baselineStock);
  const before = await readReplicas(spec.filmId);
  const baseline = spec.reset ? spec.baselineStock : stockOf(before.find((r) => r.nodeId === 1 && r.up) || before.find((r) => r.up) || {});

  const events = [];
  let seq = 0;
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const log = (tx, kind, text, extra = {}) => events.push({ t: now(), seq: seq++, tx, kind, text, ...extra });

  const ctx = { filmId: spec.filmId, isolationLevel, holdMs: spec.holdMs, writeMode: spec.writeMode, log, now };
  const transactions = await Promise.all(spec.transactions.map((tx, i) => runTransaction(i + 1, tx, ctx)));
  const after = await readReplicas(spec.filmId);
  const analysis = analyse({ transactions, before, after, baseline: baseline ?? null });

  return {
    isolationLevel,
    baseline: baseline ?? null,
    durationMs: now(),
    transactions,
    before,
    after,
    schedule: scheduleRows(events, spec.transactions.length),
    ...analysis,
  };
}

// Runs the scenario once, or once per isolation level when the level is ALL.
async function runScenario(spec) {
  const levels = spec.isolationLevel === 'ALL' ? config.ISOLATION_LEVELS : [spec.isolationLevel];
  // Comparing levels only makes sense from the same starting point.
  const effective = levels.length > 1 ? { ...spec, reset: true, baselineStock: spec.baselineStock ?? 10 } : spec;
  const runs = [];
  for (const level of levels) runs.push(await runOnce(effective, level));
  return { spec: effective, runs, ranAt: new Date().toISOString(), servedBy: config.nodeId };
}

module.exports = { preset, parseSpec, runScenario, analyse, scheduleRows, ScenarioError, OPS, WRITE_MODES };
