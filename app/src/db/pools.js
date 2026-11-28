const mysql = require('mysql2/promise');
const config = require('../config');

const pools = {};
const simulatedDown = new Set();

function makeDownError(nodeId) {
  const err = new Error(`Simulated outage: Node ${nodeId} is offline`);
  err.code = 'ECONNREFUSED';
  err.simulated = true;
  return err;
}

function isSimulatedDown(nodeId) {
  return simulatedDown.has(Number(nodeId));
}

function setNodeOnline(nodeId, online) {
  const id = Number(nodeId);
  if (![1, 2, 3].includes(id)) throw new Error(`Invalid nodeId: ${nodeId}`);
  if (online) simulatedDown.delete(id);
  else simulatedDown.add(id);
  return { nodeId: id, simulatedOnline: !simulatedDown.has(id) };
}

function getPool(nodeId) {
  const id = Number(nodeId);
  if (isSimulatedDown(id)) throw makeDownError(id);
  if (!pools[id]) {
    pools[id] = mysql.createPool({
      ...config.nodes[id],
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 2000, // fail fast when a node is down
      decimalNumbers: true,
    });
    // Applies to every connection the pool opens, replication included.
    pools[id].pool.on('connection', (conn) => {
      conn.query(`SET SESSION innodb_lock_wait_timeout = ${config.lockWaitTimeout}`);
    });
  }
  return pools[id];
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
  const id = Number(nodeId);
  if (isSimulatedDown(id)) {
    return { nodeId: id, up: false, simulated: true, error: 'SIMULATED_DOWN (ECONNREFUSED)', ms: 0 };
  }
  try {
    const [[row]] = await getPool(id).query('SELECT COUNT(*) AS n FROM film');
    return { nodeId: id, up: true, simulated: false, rows: row.n, ms: Date.now() - started };
  } catch (err) {
    return { nodeId: id, up: false, simulated: false, error: err.code || err.message, ms: Date.now() - started };
  }
}

async function closeAll() {
  await Promise.all(Object.values(pools).map((p) => p.end()));
}

module.exports = { getPool, withTransaction, isConnectionError, ping, closeAll, setNodeOnline, isSimulatedDown };
