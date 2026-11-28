const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { parseArgs, plan } = require('../scripts/concurrency-tests');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'concurrency-tests.js');

test('plan covers every case, level and run, alternating films and apps', () => {
  const opts = parseArgs(['--runs', '3', '--apps', 'http://a,http://b']);
  const items = plan(opts);
  assert.strictEqual(items.length, 3 * 4 * 3);
  assert.deepStrictEqual(items.slice(0, 3).map((i) => i.filmId), [1, 2, 1]);
  assert.deepStrictEqual(items.slice(0, 3).map((i) => i.app), ['http://a', 'http://b', 'http://a']);
});

test('rejects bad options', () => {
  assert.throws(() => parseArgs(['--cases', '4']), /--cases/);
  assert.throws(() => parseArgs(['--levels', 'CHAOS']), /--levels/);
  assert.throws(() => parseArgs(['--bogus', '1']), /Unknown/);
});

// A stand-in for the app: Case 3 comes back inconsistent, the rest consistent.
function fakeApp() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { case: caseNo, isolationLevel } = JSON.parse(body);
      const consistent = caseNo !== 3;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        servedBy: 1,
        runs: [{
          isolationLevel,
          consistent,
          durationMs: 1600,
          expected: caseNo === 1 ? undefined : 15,
          findings: consistent
            ? [{ kind: 'consistent', level: 'ok', text: 'All replicas agree.' }]
            : [{ kind: 'lost-update', level: 'warn', text: 'Expected stock = 14 (lost update).' }],
          transactions: [{ tx: 1, origin: 1, dbNode: 1, op: 'read', delta: 0, reads: [{ t: 5, value: 10 }], status: 'committed' }],
          after: [{ nodeId: 1, up: true, row: { stock: 15 } }, { nodeId: 2, up: true, row: { stock: consistent ? 15 : 7 } }],
        }],
      }));
    });
  });
}

test('end to end: runs the plan, logs every run and writes a summary', async () => {
  const server = fakeApp();
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'conc-'));
  try {
    const { code, stdout } = await new Promise((resolve) => {
      execFile(process.execPath, [SCRIPT, '--apps', url, '--runs', '2', '--levels', 'READ COMMITTED,SERIALIZABLE', '--out', out],
        (err, stdout) => resolve({ code: err ? err.code : 0, stdout }));
    });
    assert.strictEqual(code, 1, 'exits 1 when any run fails');
    assert.match(stdout, /8\/12 passed/);

    const files = fs.readdirSync(out);
    const jsonl = fs.readFileSync(path.join(out, files.find((f) => f.endsWith('.jsonl'))), 'utf8').trim().split('\n');
    assert.strictEqual(jsonl.length, 12);
    assert.deepStrictEqual(JSON.parse(jsonl[0]).finalStock, { node1: 15, node2: 15 });

    const md = fs.readFileSync(path.join(out, files.find((f) => f.endsWith('.md'))), 'utf8');
    assert.match(md, /\*\*8 of 12 runs passed\*\*/);
    assert.match(md, /\| 3\. Concurrent writes \| SERIALIZABLE \| 0\/2 \| lost-update \(2\) \|/);
    assert.match(md, /## Failed runs: findings/);
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a request that fails is logged as a failed run, not a crash', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'conc-'));
  try {
    const { code, stdout } = await new Promise((resolve) => {
      execFile(process.execPath, [SCRIPT, '--apps', 'http://127.0.0.1:9', '--runs', '1', '--cases', '1', '--levels', 'READ COMMITTED', '--out', out],
        (err, stdout) => resolve({ code: err ? err.code : 0, stdout }));
    });
    assert.strictEqual(code, 1);
    assert.match(stdout, /FAIL\s+\(request-failed\)/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
