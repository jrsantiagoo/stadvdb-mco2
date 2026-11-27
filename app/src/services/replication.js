// PLACEHOLDER: Member 3 replaces this with the real replication strategy.
//
// Contract the rest of the app relies on:
//   replicate(change) -> Promise<Array<{ nodeId, ok, error? }>>
//   change = { op: 'insert' | 'update' | 'delete', filmId, film, origin }
//     origin is the node where the write already committed.
//
// For now each change is applied directly to the other node that holds the row.
// Nothing is retried or logged, so a change is lost if that node is down.
// Recovery (Member 4) will need a transaction log that replays it.

const { withTransaction } = require('../db/pools');
const { nodesHolding } = require('../db/fragment');

async function applyChange(conn, { op, filmId, film }) {
  if (op === 'insert' || op === 'update') {
    await conn.execute(
      `INSERT INTO film (film_id, title, stock, rental_rate, rental_duration)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title), stock = VALUES(stock),
         rental_rate = VALUES(rental_rate), rental_duration = VALUES(rental_duration)`,
      [filmId, film.title, film.stock, film.rental_rate, film.rental_duration],
    );
  } else if (op === 'delete') {
    await conn.execute('DELETE FROM film WHERE film_id = ?', [filmId]);
  } else {
    throw new Error(`Unknown replication op: ${op}`);
  }
}

async function replicate(change) {
  const targets = nodesHolding(change.filmId).filter((n) => n !== change.origin);
  const results = [];
  for (const nodeId of targets) {
    try {
      await withTransaction(nodeId, (conn) => applyChange(conn, change));
      results.push({ nodeId, ok: true });
    } catch (err) {
      results.push({ nodeId, ok: false, error: err.code || err.message });
    }
  }
  return results;
}

module.exports = { replicate };
