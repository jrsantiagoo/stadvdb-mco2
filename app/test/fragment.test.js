const test = require('node:test');
const assert = require('node:assert');
const { fragmentNodeFor, nodesHolding, accessOrder } = require('../src/db/fragment');

test('odd ids go to node 2, even ids to node 3', () => {
  assert.strictEqual(fragmentNodeFor(1), 2);
  assert.strictEqual(fragmentNodeFor(999), 2);
  assert.strictEqual(fragmentNodeFor(2), 3);
  assert.strictEqual(fragmentNodeFor(1000), 3);
});

test('every row lives on the central node plus exactly one fragment', () => {
  for (let id = 1; id <= 50; id++) {
    const holders = nodesHolding(id);
    assert.strictEqual(holders.length, 2);
    assert.strictEqual(holders[0], 1);
    assert.ok([2, 3].includes(holders[1]));
  }
});

test('access order prefers the local node when it holds the row', () => {
  assert.deepStrictEqual(accessOrder(7, 1), [1, 2]);
  assert.deepStrictEqual(accessOrder(7, 2), [2, 1]);
  assert.deepStrictEqual(accessOrder(8, 3), [3, 1]);
});

test('access order goes to central first when the local node lacks the row', () => {
  assert.deepStrictEqual(accessOrder(8, 2), [1, 3]);
  assert.deepStrictEqual(accessOrder(7, 3), [1, 2]);
});
