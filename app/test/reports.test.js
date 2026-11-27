const test = require('node:test');
const assert = require('node:assert');
const { mergeGroups, finalizeGroups, fragmentCheck } = require('../src/services/reportService');

test('merging fragments adds up groups with the same key', () => {
  const node2 = [{ k: 0.99, films: 3, stock: 10, rateSum: 2.97 }, { k: 4.99, films: 1, stock: 2, rateSum: 4.99 }];
  const node3 = [{ k: 0.99, films: 1, stock: 5, rateSum: 0.99 }, { k: 2.99, films: 2, stock: 4, rateSum: 5.98 }];
  const merged = finalizeGroups(mergeGroups(node2, node3));
  assert.deepStrictEqual(merged.map((r) => [r.k, r.films, r.stock]), [[0.99, 4, 15], [2.99, 2, 4], [4.99, 1, 2]]);
});

test('merged averages are weighted by row count, not an average of averages', () => {
  // Node 2: 3 films at 1.00. Node 3: 1 film at 5.00. The true average is 2.00, not 3.00.
  const merged = finalizeGroups(mergeGroups(
    [{ k: 6, films: 3, stock: 3, rateSum: 3 }],
    [{ k: 6, films: 1, stock: 1, rateSum: 5 }],
  ));
  assert.strictEqual(merged[0].avgRate, 2);
});

test('shares add up to 1', () => {
  const rows = finalizeGroups([{ k: 3, films: 1, stock: 0, rateSum: 0 }, { k: 5, films: 3, stock: 0, rateSum: 0 }]);
  assert.strictEqual(rows.reduce((s, r) => s + r.share, 0), 1);
});

const node = (nodeId, films, stock, misplaced = 0) => ({ nodeId, up: true, totals: { films, stock, rateSum: 0 }, misplaced });

test('fragment check passes when fragments add up to central', () => {
  const check = fragmentCheck([node(1, 10, 50), node(2, 6, 30), node(3, 4, 20)]);
  assert.ok(check.filmsMatch && check.stockMatch);
  assert.strictEqual(check.misplaced, 0);
});

test('fragment check flags missing rows and misplaced rows', () => {
  const check = fragmentCheck([node(1, 10, 50), node(2, 5, 30, 1), node(3, 4, 20)]);
  assert.strictEqual(check.filmsMatch, false);
  assert.strictEqual(check.misplaced, 1);
});

test('fragment check is skipped when a node is down', () => {
  assert.strictEqual(fragmentCheck([node(1, 10, 50), { nodeId: 2, up: false }, node(3, 4, 20)]), null);
});
