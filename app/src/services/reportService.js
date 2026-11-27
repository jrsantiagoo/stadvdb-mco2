// Cross-node reports. Each node's figures are read in one transaction, so they
// agree with each other. Breakdowns come from the central node; if it is
// down, they are rebuilt from Node 2 + Node 3.
//
// Each node returns counts and sums (never averages): merged averages are
// computed afterwards, because averaging two nodes' averages is wrong when the
// nodes hold different numbers of rows.

const { withTransaction, isConnectionError } = require('../db/pools');
const { CENTRAL, FRAGMENT_PREDICATE } = require('../db/fragment');
const { AllNodesDownError } = require('./filmService');

const AGG = 'COUNT(*) AS films, COALESCE(SUM(stock), 0) AS stock, COALESCE(SUM(rental_rate), 0) AS rateSum';
const FRAGMENTS = [2, 3];

async function nodeAggregates(nodeId) {
  return withTransaction(nodeId, async (conn) => {
    const [[totals]] = await conn.query(`SELECT ${AGG} FROM film`);
    const [byRate] = await conn.query(`SELECT rental_rate AS k, ${AGG} FROM film GROUP BY rental_rate`);
    const [byDuration] = await conn.query(`SELECT rental_duration AS k, ${AGG} FROM film GROUP BY rental_duration`);
    // Rows on a fragment that the fragmentation rule says belong elsewhere.
    let misplaced = 0;
    if (nodeId !== CENTRAL) {
      const [[m]] = await conn.query(`SELECT COUNT(*) AS n FROM film WHERE NOT (${FRAGMENT_PREDICATE[nodeId]})`);
      misplaced = Number(m.n);
    }
    return { totals: toNumbers(totals), byRate: byRate.map(toNumbers), byDuration: byDuration.map(toNumbers), misplaced };
  });
}

function toNumbers(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) out[key] = Number(value);
  return out;
}

// Adds up grouped rows from several nodes that share the same key.
function mergeGroups(...lists) {
  const byKey = new Map();
  for (const row of lists.flat()) {
    const acc = byKey.get(row.k) || { k: row.k, films: 0, stock: 0, rateSum: 0 };
    acc.films += row.films;
    acc.stock += row.stock;
    acc.rateSum += row.rateSum;
    byKey.set(row.k, acc);
  }
  return [...byKey.values()];
}

// Sorts groups by key and adds averages and each group's share of all films.
function finalizeGroups(rows) {
  const totalFilms = rows.reduce((sum, r) => sum + r.films, 0);
  return rows
    .map((r) => ({
      ...r,
      share: totalFilms ? r.films / totalFilms : 0,
      avgStock: r.films ? r.stock / r.films : 0,
      avgRate: r.films ? r.rateSum / r.films : 0,
    }))
    .sort((a, b) => a.k - b.k);
}

// Compares Node 2 + Node 3 with Node 1. Returns null when a node is down.
function fragmentCheck(nodes) {
  const [n1, n2, n3] = [1, 2, 3].map((id) => nodes.find((n) => n.nodeId === id));
  if (![n1, n2, n3].every((n) => n.up)) return null;
  const sum = {
    films: n2.totals.films + n3.totals.films,
    stock: n2.totals.stock + n3.totals.stock,
  };
  return {
    sum,
    filmsMatch: sum.films === n1.totals.films,
    stockMatch: sum.stock === n1.totals.stock,
    misplaced: n2.misplaced + n3.misplaced,
  };
}

async function getReports() {
  const nodes = await Promise.all(
    [1, 2, 3].map((nodeId) =>
      nodeAggregates(nodeId).then(
        (data) => ({ nodeId, up: true, ...data }),
        (err) => {
          if (!isConnectionError(err)) throw err;
          return { nodeId, up: false, error: err.code || err.message };
        },
      ),
    ),
  );

  const central = nodes.find((n) => n.nodeId === CENTRAL);
  const liveFragments = nodes.filter((n) => FRAGMENTS.includes(n.nodeId) && n.up);
  const warnings = [];
  let source;

  if (central.up) {
    source = [central];
  } else if (liveFragments.length) {
    source = liveFragments;
    warnings.push(`Node ${CENTRAL} is unreachable, so the breakdowns were merged from Node ${liveFragments.map((n) => n.nodeId).join(' + ')}.`);
    if (liveFragments.length < FRAGMENTS.length) {
      const down = FRAGMENTS.filter((id) => !liveFragments.some((n) => n.nodeId === id));
      warnings.push(`Node ${down.join(', ')} is also unreachable, so its films are missing from the breakdowns.`);
    }
  } else {
    throw new AllNodesDownError(nodes.map((n) => ({ nodeId: n.nodeId, error: n.error })));
  }

  return {
    nodes,
    check: fragmentCheck(nodes),
    byRate: finalizeGroups(mergeGroups(...source.map((n) => n.byRate))),
    byDuration: finalizeGroups(mergeGroups(...source.map((n) => n.byDuration))),
    servedBy: source.map((n) => n.nodeId),
    warnings,
  };
}

module.exports = { getReports, mergeGroups, finalizeGroups, fragmentCheck };
