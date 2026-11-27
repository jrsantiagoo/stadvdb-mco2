require('dotenv').config();

const ISOLATION_LEVELS = [
  'READ UNCOMMITTED',
  'READ COMMITTED',
  'REPEATABLE READ',
  'SERIALIZABLE',
];

const nodeId = Number(process.env.NODE_ID || 1);
if (![1, 2, 3].includes(nodeId)) {
  throw new Error(`NODE_ID must be 1, 2 or 3 (got "${process.env.NODE_ID}")`);
}

const isolationLevel = (process.env.ISOLATION_LEVEL || 'READ COMMITTED').toUpperCase();
if (!ISOLATION_LEVELS.includes(isolationLevel)) {
  throw new Error(`ISOLATION_LEVEL must be one of: ${ISOLATION_LEVELS.join(', ')}`);
}

function nodeConfig(id) {
  const p = (key, fallback) => process.env[`NODE${id}_${key}`] ?? fallback;
  return {
    host: p('HOST', '127.0.0.1'),
    port: Number(p('PORT', 3305 + id)),
    user: p('USER', 'mco2'),
    password: p('PASSWORD', ''),
    database: p('DATABASE', 'mco2_db'),
  };
}

module.exports = {
  nodeId,
  port: Number(process.env.PORT || 3000),
  isolationLevel,
  ISOLATION_LEVELS,
  nodes: { 1: nodeConfig(1), 2: nodeConfig(2), 3: nodeConfig(3) },
};
