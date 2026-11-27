const express = require('express');
const films = require('../services/filmService');

const router = express.Router();

// Turns the replication results into a short notice for the next page.
function writeNotice(action, filmId, { writtenTo, replication }) {
  const parts = [`Film ${filmId} ${action} on Node ${writtenTo}.`];
  for (const r of replication) {
    parts.push(r.ok ? `Replicated to Node ${r.nodeId}.` : `Not replicated to Node ${r.nodeId} (${r.error}).`);
  }
  return parts.join(' ');
}

function redirectWithNotice(res, path, notice, level = 'ok') {
  const qs = new URLSearchParams({ notice, level });
  res.redirect(`${path}?${qs}`);
}

function parseId(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return next(new films.NotFoundError(`No film with ID "${req.params.id}"`));
  req.filmId = id;
  next();
}

router.get('/', async (req, res, next) => {
  try {
    const result = await films.listFilms({ q: req.query.q, page: req.query.page });
    res.render('films/index', { title: 'Films', ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/new', (req, res) => {
  res.render('films/form', { title: 'Add film', film: {}, errors: {}, mode: 'create' });
});

router.post('/', async (req, res, next) => {
  try {
    const result = await films.createFilm(req.body);
    const failed = result.replication.some((r) => !r.ok);
    redirectWithNotice(res, `/films/${result.film.film_id}`, writeNotice('added', result.film.film_id, result), failed ? 'warn' : 'ok');
  } catch (err) {
    if (err instanceof films.ValidationError) {
      return res.status(422).render('films/form', { title: 'Add film', film: req.body, errors: err.errors, mode: 'create' });
    }
    next(err);
  }
});

router.get('/:id', parseId, async (req, res, next) => {
  try {
    const { film, servedBy, skipped } = await films.getFilm(req.filmId);
    res.render('films/show', { title: film.title, film, servedBy, skipped });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/edit', parseId, async (req, res, next) => {
  try {
    const { film } = await films.getFilm(req.filmId);
    res.render('films/form', { title: `Edit ${film.title}`, film, errors: {}, mode: 'edit' });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', parseId, async (req, res, next) => {
  try {
    const result = await films.updateFilm(req.filmId, req.body);
    const failed = result.replication.some((r) => !r.ok);
    redirectWithNotice(res, `/films/${req.filmId}`, writeNotice('updated', req.filmId, result), failed ? 'warn' : 'ok');
  } catch (err) {
    if (err instanceof films.ValidationError) {
      return res.status(422).render('films/form', {
        title: 'Edit film',
        film: { ...req.body, film_id: req.filmId },
        errors: err.errors,
        mode: 'edit',
      });
    }
    next(err);
  }
});

router.post('/:id/delete', parseId, async (req, res, next) => {
  try {
    const result = await films.deleteFilm(req.filmId);
    const failed = result.replication.some((r) => !r.ok);
    redirectWithNotice(res, '/films', writeNotice('deleted', req.filmId, result), failed ? 'warn' : 'ok');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
