const express = require('express');
const config = require('../config');
const { ping, setNodeOnline } = require('../db/pools');
const { FRAGMENT_PREDICATE } = require('../db/fragment');
const { getPendingLogs, replayPendingLogs } = require('../services/replication');

const router = express.Router();

const ROLE = {
  1: 'Central node: all rows',
  2: `Fragment: ${FRAGMENT_PREDICATE[2]}`,
  3: `Fragment: ${FRAGMENT_PREDICATE[3]}`,
};

router.get('/', async (req, res) => {
  const statuses = await Promise.all([1, 2, 3].map(ping));
  const pendingLogs = await getPendingLogs();
  const nodes = statuses.map((s) => ({
    ...s,
    role: ROLE[s.nodeId],
    host: `${config.nodes[s.nodeId].host}:${config.nodes[s.nodeId].port}`,
  }));
  const [n1, n2, n3] = nodes;
  const fragmentsAddUp = n1.up && n2.up && n3.up ? n2.rows + n3.rows === n1.rows : null;
  res.render('nodes', { title: 'Nodes', nodes, fragmentsAddUp, pendingLogs, isolationLevel: config.isolationLevel });
});

router.post('/:id/toggle', async (req, res) => {
  const id = Number(req.params.id);
  if (![1, 2, 3].includes(id)) return res.status(400).json({ error: 'Node ID must be 1, 2, or 3' });
  const online = req.body.online === true || req.body.online === 'true' || req.body.online === '1';
  const state = setNodeOnline(id, online);
  const recovered = online ? await replayPendingLogs(id) : [];

  if (req.headers.accept?.includes('application/json') || req.is('application/json')) {
    return res.json({ ...state, recovered });
  }
  const msg = online
    ? `Node ${id} brought ONLINE (${recovered.filter((r) => r.ok).length} pending log(s) applied).`
    : `Node ${id} simulated OFFLINE.`;
  res.redirect(`/nodes?notice=${encodeURIComponent(msg)}&level=${online ? 'ok' : 'warn'}`);
});

router.post('/recover', async (req, res) => {
  const targetNode = req.body.targetNode ? Number(req.body.targetNode) : null;
  const replayed = await replayPendingLogs(targetNode);
  if (req.headers.accept?.includes('application/json') || req.is('application/json')) {
    return res.json({ replayed });
  }
  const count = replayed.filter((r) => r.ok).length;
  res.redirect(`/nodes?notice=${encodeURIComponent(`Recovery complete: ${count} pending log(s) applied.`)}&level=ok`);
});

// JSON form of the same check, for test scripts and uptime monitors.
router.get('/status.json', async (req, res) => {
  res.json({
    servedBy: config.nodeId,
    nodes: await Promise.all([1, 2, 3].map(ping)),
    pendingLogs: await getPendingLogs(),
  });
});

module.exports = router;
