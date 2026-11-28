#!/usr/bin/env node
// Concurrency test script for MCO2 Step 3 (Cases 1–3).
//
// Runs every case under every isolation level several times through the app's
// /concurrency/run.json endpoint, then writes:
//   test-logs/concurrency-<time>.jsonl  full result of every run (evidence)
//   test-logs/concurrency-<time>.md     summary tables for the report appendix
//
// A run PASSES when the replicas agree at the end and the final stock matches
// the committed writes. After each run the app puts the test film back as it
// was, so the dataset is left unchanged. Anomalies (dirty reads, non-repeatable reads, lock
// waits) are recorded separately: some are expected under weaker isolation.
//
// Usage (run on any node):
//   npm run test:concurrency
//   npm run test:concurrency -- --runs 5 --cases 2,3 --levels "READ COMMITTED,SERIALIZABLE"
//   npm run test:concurrency -- --apps http://10.20.200.175:3000,http://10.20.200.176:3000,http://10.20.200.177:3000
//
// Options:
//   --apps    app URLs; runs rotate across them   (default http://localhost:<PORT from app/.env>)
//   --cases   which cases to run                  (default 1,2,3)
//   --levels  isolation levels, or ALL            (default ALL)
//   --runs    repetitions per case and level      (default 3)
//   --films   film IDs to alternate between       (default 1,2: one per fragment)
//   --hold    hold time inside transactions, ms   (default 1500)
//   --out     folder for the logs                 (default test-logs)

const fs = require('fs');
const path = require('path');

const LEVELS = ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'];
const CASE_NAMES = {
  1: 'Concurrent reads',
  2: 'One write, concurrent reads',
  3: 'Concurrent writes',
};
const REQUEST_TIMEOUT_MS = 120000;

// The local app's port, read from app/.env like the app itself does.
function localAppUrl() {
  const env = {};
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), processEnv: env, quiet: true });
  return `http://localhost:${process.env.PORT || env.PORT || 3000}`;
}

function parseArgs(argv) {
  const opts = {
    apps: [localAppUrl()],
    cases: [1, 2, 3],
    levels: LEVELS,
    runs: 3,
    films: [1, 2],
    hold: 1500,
    out: 'test-logs',
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (!(key in opts) || value === undefined) throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    i++;
    const list = value.split(',').map((s) => s.trim()).filter(Boolean);
    switch (key) {
      case 'apps': opts.apps = list.map((u) => u.replace(/\/+$/, '')); break;
      case 'cases': opts.cases = list.map(Number); break;
      case 'levels': opts.levels = value.toUpperCase() === 'ALL' ? LEVELS : list.map((l) => l.toUpperCase()); break;
      case 'runs': opts.runs = Number(value); break;
      case 'films': opts.films = list.map(Number); break;
      case 'hold': opts.hold = Number(value); break;
      case 'out': opts.out = value; break;
    }
  }
  if (opts.cases.some((c) => !CASE_NAMES[c])) throw new Error('--cases must be from 1, 2, 3');
  if (opts.levels.some((l) => !LEVELS.includes(l))) throw new Error(`--levels must be ALL or from: ${LEVELS.join(', ')}`);
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error('--runs must be a positive whole number');
  if (!opts.films.length || opts.films.some((f) => !Number.isInteger(f) || f < 1)) throw new Error('--films must be positive whole numbers');
  return opts;
}

// Builds the test plan: every case × level × repetition, rotating films and apps.
function plan(opts) {
  const items = [];
  for (const caseNo of opts.cases) {
    for (const level of opts.levels) {
      for (let run = 1; run <= opts.runs; run++) {
        const n = items.length;
        items.push({
          caseNo,
          level,
          run,
          filmId: opts.films[(run - 1) % opts.films.length],
          app: opts.apps[n % opts.apps.length],
        });
      }
    }
  }
  return items;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(data.errors || [data.error || res.statusText]).join(' ')}`);
  return data;
}

// Reduces one app response to the facts the summary needs.
function summarise(item, response) {
  const run = response.runs[0];
  const issues = run.findings.filter((f) => f.level !== 'ok');
  // A failed restore doesn't fail the test, but the film's data may have changed.
  const unrestored = (response.restored || []).filter((r) => !r.ok);
  const restoreNotes = unrestored.map((r) => `Film ${item.filmId} was not restored on Node ${r.nodeId} (${r.error}).`);
  return {
    ...item,
    servedBy: response.servedBy,
    pass: run.consistent,
    anomalies: [...new Set([...issues.map((f) => f.kind), ...(unrestored.length ? ['restore-failed'] : [])])],
    findings: [...run.findings.map((f) => f.text), ...restoreNotes],
    restored: response.restored ? unrestored.length === 0 : null,
    transactions: run.transactions.map((t) => ({
      tx: t.tx,
      origin: t.origin,
      dbNode: t.dbNode,
      op: t.op,
      delta: t.delta,
      reads: t.reads.map((r) => r.value),
      status: t.status,
      error: t.error,
      waitedMs: t.waitedMs,
    })),
    finalStock: Object.fromEntries(run.after.map((r) => [`node${r.nodeId}`, r.up ? (r.row ? r.row.stock : null) : 'down'])),
    expected: run.expected,
    durationMs: run.durationMs,
  };
}

function failure(item, err) {
  return { ...item, pass: false, error: err.message, anomalies: ['request-failed'], findings: [err.message], transactions: [], finalStock: {} };
}

// ---------- report ----------

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');

function aggregate(results) {
  const groups = new Map();
  for (const r of results) {
    const key = `${r.caseNo}|${r.level}`;
    const g = groups.get(key) || { caseNo: r.caseNo, level: r.level, runs: 0, passed: 0, anomalies: {} };
    g.runs++;
    if (r.pass) g.passed++;
    for (const a of r.anomalies) g.anomalies[a] = (g.anomalies[a] || 0) + 1;
    groups.set(key, g);
  }
  return [...groups.values()];
}

function toMarkdown(results, opts, startedAt) {
  const lines = [];
  const passed = results.filter((r) => r.pass).length;
  lines.push('# Concurrency test results', '');
  lines.push(`- Started: ${startedAt}`);
  lines.push(`- Apps: ${opts.apps.join(', ')}`);
  lines.push(`- Films: ${opts.films.join(', ')} · hold time ${opts.hold} ms · ${opts.runs} runs per case and level`);
  lines.push(`- **${passed} of ${results.length} runs passed** (replicas agree and match the committed writes)`, '');

  lines.push('## Summary by case and isolation level', '');
  lines.push('| Case | Isolation level | Passed | Anomalies seen (runs) |');
  lines.push('|---|---|---|---|');
  for (const g of aggregate(results)) {
    const anomalies = Object.entries(g.anomalies).map(([k, n]) => `${k} (${n})`).join(', ') || 'none';
    lines.push(`| ${g.caseNo}. ${CASE_NAMES[g.caseNo]} | ${g.level} | ${g.passed}/${g.runs} | ${cell(anomalies)} |`);
  }

  lines.push('', '## Every run', '');
  lines.push('| # | Case | Isolation level | Run | Film | Coordinated by | Result | Values read / outcome per transaction | Final stock | Expected | Time |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  results.forEach((r, i) => {
    const txs = r.transactions
      .map((t) => `T${t.tx}@N${t.dbNode ?? '?'} ${t.op}${t.op === 'update' ? `(${t.delta >= 0 ? '+' : ''}${t.delta})` : ''}: ${t.reads.map((v) => v ?? '∅').join('→') || '–'} ${t.status}${t.error ? ` (${t.error})` : ''}`)
      .join('<br>');
    const finals = Object.entries(r.finalStock).map(([n, v]) => `${n}=${v ?? '∅'}`).join(', ');
    lines.push(`| ${i + 1} | ${r.caseNo} | ${r.level} | ${r.run} | ${r.filmId} | ${r.servedBy ? `Node ${r.servedBy}` : cell(r.app)} | ${r.pass ? 'PASS' : '**FAIL**'} | ${cell(txs || r.error)} | ${cell(finals)} | ${r.expected === undefined ? '–' : r.expected ?? 'deleted'} | ${r.durationMs ?? '–'} ms |`);
  });

  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    lines.push('', '## Failed runs: findings', '');
    for (const r of failed) {
      lines.push(`- **Case ${r.caseNo}, ${r.level}, run ${r.run} (film ${r.filmId})**`);
      for (const f of r.findings) lines.push(`  - ${f}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const items = plan(opts);
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-').slice(0, 19);
  fs.mkdirSync(opts.out, { recursive: true });
  const jsonlPath = path.join(opts.out, `concurrency-${stamp}.jsonl`);
  const mdPath = path.join(opts.out, `concurrency-${stamp}.md`);

  console.log(`Running ${items.length} scenarios (${opts.cases.length} cases × ${opts.levels.length} levels × ${opts.runs} runs)\n`);
  const results = [];
  for (const [i, item] of items.entries()) {
    const label = `[${String(i + 1).padStart(2)}/${items.length}] Case ${item.caseNo} · ${item.level.padEnd(16)} · run ${item.run} · film ${item.filmId}`;
    let result;
    try {
      const response = await postJson(`${item.app}/concurrency/run.json`, {
        case: item.caseNo,
        filmId: item.filmId,
        isolationLevel: item.level,
        holdMs: opts.hold,
      });
      result = summarise(item, response);
    } catch (err) {
      result = failure(item, err);
    }
    results.push(result);
    fs.appendFileSync(jsonlPath, `${JSON.stringify({ ...result, at: new Date().toISOString() })}\n`);
    console.log(`${label}  ${result.pass ? 'PASS' : 'FAIL'}${result.anomalies.length ? `  (${result.anomalies.join(', ')})` : ''}`);
  }

  fs.writeFileSync(mdPath, toMarkdown(results, opts, startedAt));
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  console.log(`Full log: ${jsonlPath}`);
  console.log(`Summary:  ${mdPath}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 2;
  });
}

module.exports = { parseArgs, plan, summarise, aggregate, toMarkdown };
