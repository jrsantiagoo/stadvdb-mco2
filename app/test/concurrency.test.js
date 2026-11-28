const test = require('node:test');
const assert = require('node:assert');
const { preset, parseSpec, analyse, scheduleRows, ScenarioError } = require('../src/services/concurrency');

test('presets put transactions on the nodes that hold the film', () => {
  const odd = preset(2, 7); // film 7 lives on Node 1 and Node 2
  assert.deepStrictEqual(odd.transactions.map((t) => [t.origin, t.op]), [[2, 'update'], [2, 'read'], [1, 'read']]);
  const even = preset(1, 8); // film 8 lives on Node 1 and Node 3
  assert.deepStrictEqual(even.transactions.map((t) => t.origin), [1, 3, 2]);
  assert.ok(preset(3, 7).transactions.every((t) => t.op === 'update'));
  assert.strictEqual(preset(4, 7), null);
});

test('every preset passes validation', () => {
  for (const c of [1, 2, 3]) assert.doesNotThrow(() => parseSpec(preset(c, 5)));
});

test('unused form rows are dropped', () => {
  const spec = parseSpec({ ...preset(1, 5), transactions: [{ origin: 1, op: 'read' }, { origin: 2, op: 'none' }] });
  assert.strictEqual(spec.transactions.length, 1);
});

test('rejects bad input with a message per problem', () => {
  assert.throws(
    () => parseSpec({ filmId: 'x', isolationLevel: 'CHAOS', holdMs: -1, writeMode: 'atomic', transactions: [{ origin: 9, op: 'merge' }] }),
    (err) => err instanceof ScenarioError && err.errors.length === 5,
  );
});

// Helpers to build a finished run without a database.
const replica = (nodeId, stock) => ({ nodeId, up: true, row: stock == null ? null : { stock } });
const reader = (tx, dbNode, values) => ({ tx, op: 'read', dbNode, status: 'committed', reads: values.map(([t, value]) => ({ t, value })) });
const writer = (tx, dbNode, extra) => ({ tx, op: 'update', dbNode, status: 'committed', reads: [], delta: 5, writeT: 100, endT: 1500, ...extra });
const kinds = (r) => r.findings.map((f) => f.kind);

test('flags a dirty read when a reader sees an uncommitted value', () => {
  const result = analyse({
    transactions: [writer(1, 2, { writtenValue: 15, status: 'rolled back' }), reader(2, 2, [[300, 15], [1800, 10]])],
    before: [replica(1, 10), replica(2, 10)],
    after: [replica(1, 10), replica(2, 10)],
    baseline: 10,
  });
  assert.ok(kinds(result).includes('dirty-read'));
  assert.ok(kinds(result).includes('non-repeatable-read'));
});

test('a reader on another node cannot dirty-read', () => {
  const result = analyse({
    transactions: [writer(1, 2, { writtenValue: 15 }), reader(2, 1, [[300, 15]])],
    before: [replica(1, 10), replica(2, 10)],
    after: [replica(1, 15), replica(2, 15)],
    baseline: 10,
  });
  assert.ok(!kinds(result).includes('dirty-read'));
});

test('repeatable reads and matching replicas count as consistent', () => {
  const result = analyse({
    transactions: [writer(1, 2, { writtenValue: 15 }), reader(2, 1, [[300, 10], [1800, 10]])],
    before: [replica(1, 10), replica(2, 10)],
    after: [replica(1, 15), replica(2, 15)],
    baseline: 10,
  });
  assert.ok(result.consistent);
  assert.deepStrictEqual(kinds(result).sort(), ['consistent', 'expected', 'repeatable']);
});

test('flags a lost update when two committed updates do not both land', () => {
  const result = analyse({
    transactions: [writer(1, 1, { delta: 5, writtenValue: 15 }), writer(2, 2, { delta: -3, writtenValue: 7 })],
    before: [replica(1, 10), replica(2, 10)],
    after: [replica(1, 7), replica(2, 15)],
    baseline: 10,
  });
  assert.strictEqual(result.expected, 12);
  assert.ok(kinds(result).includes('lost-update'));
  assert.ok(kinds(result).includes('diverged'));
  assert.strictEqual(result.consistent, false);
});

test('a read that waited for a lock counts as blocked', () => {
  const result = analyse({
    transactions: [writer(1, 1, { writtenValue: 15 }), { ...reader(2, 1, [[1500, 15], [3000, 15]]), readWaitMs: 1200 }],
    before: [replica(1, 10), replica(2, 10)],
    after: [replica(1, 15), replica(2, 15)],
    baseline: 10,
  });
  assert.match(result.findings.find((f) => f.kind === 'blocked').text, /T2 waited 1200 ms .* before reading/);
});

test('a failed transaction is reported with its reason', () => {
  const result = analyse({
    transactions: [writer(1, 1, { status: 'failed', error: 'ER_LOCK_DEADLOCK' })],
    before: [replica(1, 10), replica(3, 10)],
    after: [replica(1, 10), replica(3, 10)],
    baseline: 10,
  });
  assert.match(result.findings.find((f) => f.kind === 'failed').text, /deadlock/);
});

test('schedule rows are in time order with one column per transaction', () => {
  const rows = scheduleRows([
    { t: 20, seq: 2, tx: 2, kind: 'read', text: 'READ' },
    { t: 0, seq: 0, tx: 1, kind: 'begin', text: 'BEGIN' },
    { t: 20, seq: 1, tx: 1, kind: 'write', text: 'UPDATE' },
  ], 2);
  assert.deepStrictEqual(rows.map((r) => [r.t, r.cells.findIndex(Boolean)]), [[0, 0], [20, 0], [20, 1]]);
});
