const mysql = require('mysql2/promise');
const config = require('../config');

const pools = {};

function getPool(nodeId) {
  if (!pools[nodeId]) {
    pools[nodeId] = mysql.createPool({
      ...config.nodes[nodeId],
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 2000, // fail fast when a node is down
      decimalNumbers: true,
    });
  }
  return pools[nodeId];
}

// Errors meaning "the node is unreachable", as opposed to a bad query.
// Only these should make the app try another node.
const CONNECTION_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'PROTOCOL_CONNECTION_LOST',
  'ER_CON_COUNT_ERROR',
]);

function isConnectionError(err) {
  return Boolean(err && (CONNECTION_ERRORS.has(err.code) || err.fatal));
}

// Run fn(conn) in one transaction on one node, at the configured isolation level.
async function withTransaction(nodeId, fn, isolationLevel = config.isolationLevel) {
  if (!config.ISOLATION_LEVELS.includes(isolationLevel)) {
    throw new Error(`Unknown isolation level: ${isolationLevel}`);
  }
  const conn = await getPool(nodeId).getConnection();
  try {
    await conn.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      // the connection may already be gone; the original error matters more
    }
    throw err;
  } finally {
    conn.release();
  }
}

async function ping(nodeId) {
  const started = Date.now();
  try {
    const [[row]] = await getPool(nodeId).query('SELECT COUNT(*) AS n FROM film');
    return { nodeId, up: true, rows: row.n, ms: Date.now() - started };
  } catch (err) {
    return { nodeId, up: false, error: err.code || err.message, ms: Date.now() - started };
  }
}

async function closeAll() {
  await Promise.all(Object.values(pools).map((p) => p.end()));
}

module.exports = { getPool, withTransaction, isConnectionError, ping, closeAll };
