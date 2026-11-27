// Fragmentation rule. This is the only place that decides which node holds a row.
//
//   Node 1 (central): every row
//   Node 2: films with an odd film_id
//   Node 3: films with an even film_id
//
// The rule uses film_id, the primary key, which never changes. An update can
// therefore never move a row from Node 2 to Node 3 or back, and replication
// only has to deal with insert, update and delete, never with migration.
// Nodes 2 and 3 don't overlap, and together they hold every row on Node 1.

const CENTRAL = 1;

function fragmentNodeFor(filmId) {
  return Number(filmId) % 2 === 1 ? 2 : 3;
}

// SQL condition that selects exactly the rows a fragment node should hold.
// Used to load the fragments and to check them against the central node.
const FRAGMENT_PREDICATE = {
  2: 'film_id % 2 = 1',
  3: 'film_id % 2 = 0',
};

// Every node that holds a copy of this film.
function nodesHolding(filmId) {
  return [CENTRAL, fragmentNodeFor(filmId)];
}

// Order to try nodes in for one film: this node first if it holds the row,
// otherwise the central node, then the fragment node.
function accessOrder(filmId, localNode) {
  const holders = nodesHolding(filmId);
  return holders.includes(localNode)
    ? [localNode, ...holders.filter((n) => n !== localNode)]
    : holders;
}

module.exports = { CENTRAL, fragmentNodeFor, nodesHolding, accessOrder, FRAGMENT_PREDICATE };
