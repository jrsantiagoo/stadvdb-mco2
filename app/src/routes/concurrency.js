const express = require('express');
const config = require('../config');
const scenarios = require('../services/concurrency');

const router = express.Router();
const FORM_ROWS = 3;
const DEFAULT_FILM = 1;

// The form posts flat fields (t1_op, t1_origin, ...). Reshape them into a scenario.
function formToBody(form) {
  const transactions = [];
  for (let i = 1; i <= FORM_ROWS; i++) {
    transactions.push({
      origin: form[`t${i}_origin`],
      op: form[`t${i}_op`],
      delta: form[`t${i}_delta`],
      startMs: form[`t${i}_start`],
      end: form[`t${i}_end`],
    });
  }
  return { ...form, transactions };
}

// What the form shows: always FORM_ROWS rows, unused ones set to "none".
function formModel(spec) {
  const rows = Array.from({ length: FORM_ROWS }, (_, i) => spec.transactions?.[i] || { origin: 1, op: 'none', delta: 0, startMs: 0, end: 'commit' });
  return { ...spec, transactions: rows };
}

function render(res, { spec, errors = [], result = null, status = 200 }) {
  res.status(status).render('concurrency', {
    title: 'Concurrency',
    form: formModel(spec),
    errors,
    result,
    levels: config.ISOLATION_LEVELS,
    writeModes: scenarios.WRITE_MODES,
    servedBy: result ? [...new Set(result.runs.flatMap((r) => r.transactions.map((t) => t.dbNode)).filter(Boolean))].sort() : null,
  });
}

router.get('/', (req, res) => {
  const filmId = Number.parseInt(req.query.film, 10) || DEFAULT_FILM;
  const spec = scenarios.preset(req.query.case || 1, filmId) || scenarios.preset(1, filmId);
  render(res, { spec });
});

router.post('/run', async (req, res, next) => {
  const body = formToBody(req.body);
  let spec;
  try {
    spec = scenarios.parseSpec(body);
  } catch (err) {
    if (err instanceof scenarios.ScenarioError) return render(res, { spec: body, errors: err.errors, status: 422 });
    return next(err);
  }
  try {
    const result = await scenarios.runScenario(spec);
    render(res, { spec, result });
  } catch (err) {
    if (err instanceof scenarios.ScenarioError) return render(res, { spec, errors: err.errors, status: err.status });
    next(err);
  }
});

// For test scripts. Send a full scenario, or { "case": 1|2|3, "filmId": n }
// plus any fields to override (e.g. "isolationLevel": "ALL").
router.post('/run.json', async (req, res, next) => {
  const body = req.body || {};
  const base = body.case ? scenarios.preset(body.case, Number(body.filmId) || DEFAULT_FILM) : {};
  if (body.case && !base) return res.status(422).json({ errors: ['case must be 1, 2 or 3.'] });
  try {
    const spec = scenarios.parseSpec({ ...base, ...body, transactions: body.transactions || base.transactions });
    res.json(await scenarios.runScenario(spec));
  } catch (err) {
    if (err instanceof scenarios.ScenarioError) return res.status(err.status).json({ errors: err.errors });
    next(err);
  }
});

module.exports = router;
