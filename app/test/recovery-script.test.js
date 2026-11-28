const test = require('node:test');
const assert = require('node:assert');
const { parseArgs, toMarkdown } = require('../scripts/recovery-tests');
const { setNodeOnline, isSimulatedDown, getPool } = require('../src/db/pools');

test('crash toggle marks node offline and online cleanly', () => {
  setNodeOnline(2, false);
  assert.strictEqual(isSimulatedDown(2), true);
  assert.throws(() => getPool(2), /Simulated outage/);

  setNodeOnline(2, true);
  assert.strictEqual(isSimulatedDown(2), false);
});

test('recovery CLI parser handles --apps, --cases, and --runs', () => {
  const opts = parseArgs(['--apps', 'http://n1:3000,http://n2:3000,http://n3:3000', '--cases', '1,2', '--runs', '4']);
  assert.deepStrictEqual(opts.apps, ['http://n1:3000', 'http://n2:3000', 'http://n3:3000']);
  assert.deepStrictEqual(opts.cases, [1, 2]);
  assert.strictEqual(opts.runs, 4);
});

test('toMarkdown generates summary table for report appendix', () => {
  const md = toMarkdown(
    [{ caseNo: 1, run: 1, filmId: 1, pass: true, detail: 'Queued log', durationMs: 45 }],
    { apps: ['http://n1:3000'] },
    '2026-11-28T00:00:00.000Z',
  );
  assert.match(md, /1 of 1 runs passed/);
  assert.match(md, /Queued log/);
});
