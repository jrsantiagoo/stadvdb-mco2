// Two-way replication service (Member 3).
//
// Contract preserved for filmService.js and concurrency.js:
//   replicate(change) -> Promise<Array<{ nodeId, ok, logged?, logId?, error? }>>
//   change = { op: 'insert' | 'update' | 'delete', filmId, film, origin }

const config = require('../config');
const { getPool, withTransaction } = require('../db/pools');
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

async function logFailedReplication(originNode, targetNode, change, errorMessage) {
  const payload = change.film ? JSON.stringify(change.film) : null;
  const candidates = [...new Set([originNode, config.nodeId, 1, 2, 3])];

  for (const logNode of candidates) {
    if (logNode === targetNode) continue;
    try {
      const [res] = await getPool(logNode).execute(
        `INSERT INTO replication_log (origin_node, target_node, op, film_id, payload, status, error_msg)
         VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
        [originNode, targetNode, change.op, change.filmId, payload, String(errorMessage).slice(0, 255)],
      );
      return { logged: true, logNode, logId: res.insertId };
    } catch {
      // Try next reachable node
    }
  }
  return { logged: false };
}

async function replicate(change) {
  const targets = nodesHolding(change.filmId).filter((n) => n !== change.origin);
  const results = [];
  for (const nodeId of targets) {
    try {
      await withTransaction(nodeId, (conn) => applyChange(conn, change));
      results.push({ nodeId, ok: true });
    } catch (err) {
      const error = err.code || err.message;
      const logResult = await logFailedReplication(change.origin, nodeId, change, error);
      results.push({ nodeId, ok: false, error, ...logResult });
    }
  }
  return results;
}

async function replayPendingLogs(targetNodeFilter = null) {
  const replayed = [];
  for (const sourceNode of [1, 2, 3]) {
    let rows;
    try {
      const sql = targetNodeFilter
        ? `SELECT * FROM replication_log WHERE status = 'PENDING' AND target_node = ? ORDER BY log_id ASC`
        : `SELECT * FROM replication_log WHERE status = 'PENDING' ORDER BY log_id ASC`;
      [rows] = await getPool(sourceNode).query(sql, targetNodeFilter ? [Number(targetNodeFilter)] : []);
    } catch {
      continue;
    }

    for (const entry of rows) {
      const film = typeof entry.payload === 'string' ? JSON.parse(entry.payload) : entry.payload;
      try {
        await withTransaction(entry.target_node, (conn) =>
          applyChange(conn, { op: entry.op, filmId: entry.film_id, film }),
        );
        await getPool(sourceNode).execute(
          `UPDATE replication_log SET status = 'APPLIED', applied_at = CURRENT_TIMESTAMP WHERE log_id = ?`,
          [entry.log_id],
        );
        replayed.push({ sourceNode, logId: entry.log_id, targetNode: entry.target_node, filmId: entry.film_id, ok: true });
      } catch (err) {
        replayed.push({ sourceNode, logId: entry.log_id, targetNode: entry.target_node, filmId: entry.film_id, ok: false, error: err.code || err.message });
      }
    }
  }
  return replayed;
}

async function getPendingLogs() {
  const all = [];
  for (const nodeId of [1, 2, 3]) {
    try {
      const [rows] = await getPool(nodeId).query(
        `SELECT ${nodeId} AS stored_on, log_id, origin_node, target_node, op, film_id, status, error_msg, created_at
         FROM replication_log WHERE status = 'PENDING' ORDER BY log_id ASC`,
      );
      all.push(...rows);
    } catch {
      // Skip offline node
    }
  }
  return all;
}

module.exports = { replicate, applyChange, replayPendingLogs, getPendingLogs };
