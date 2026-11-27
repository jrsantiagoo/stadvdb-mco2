const express = require('express');
const config = require('../config');
const { ping } = require('../db/pools');
const { FRAGMENT_PREDICATE } = require('../db/fragment');

const router = express.Router();

const ROLE = {
  1: 'Central node: all rows',
  2: `Fragment: ${FRAGMENT_PREDICATE[2]}`,
  3: `Fragment: ${FRAGMENT_PREDICATE[3]}`,
};

router.get('/', async (req, res) => {
  const statuses = await Promise.all([1, 2, 3].map(ping));
  const nodes = statuses.map((s) => ({
    ...s,
    role: ROLE[s.nodeId],
    host: `${config.nodes[s.nodeId].host}:${config.nodes[s.nodeId].port}`,
  }));
  const [n1, n2, n3] = nodes;
  const fragmentsAddUp = n1.up && n2.up && n3.up ? n2.rows + n3.rows === n1.rows : null;
  res.render('nodes', { title: 'Nodes', nodes, fragmentsAddUp, isolationLevel: config.isolationLevel });
});

// JSON form of the same check, for test scripts and uptime monitors.
router.get('/status.json', async (req, res) => {
  res.json({ servedBy: config.nodeId, nodes: await Promise.all([1, 2, 3].map(ping)) });
});

module.exports = router;
