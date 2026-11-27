const express = require('express');
const { getReports } = require('../services/reportService');
const { FRAGMENT_PREDICATE } = require('../db/fragment');

const router = express.Router();

const ROLE = {
  1: 'Central: all rows',
  2: `Fragment: ${FRAGMENT_PREDICATE[2]}`,
  3: `Fragment: ${FRAGMENT_PREDICATE[3]}`,
};

router.get('/', async (req, res, next) => {
  try {
    const report = await getReports();
    res.render('reports', { title: 'Reports', roles: ROLE, ...report });
  } catch (err) {
    next(err);
  }
});

// Same data as JSON, for the test scripts.
router.get('/data.json', async (req, res, next) => {
  try {
    res.json(await getReports());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
