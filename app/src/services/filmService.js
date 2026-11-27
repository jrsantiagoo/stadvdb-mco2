// Film data access with location transparency: callers never choose a node.
// This module routes each read and write using the fragmentation rule, and
// tries the next node holding the data when one is unreachable.

const config = require('../config');
const { getPool, withTransaction, isConnectionError } = require('../db/pools');
const { CENTRAL, accessOrder } = require('../db/fragment');
const { replicate } = require('./replication');

const LOCAL = config.nodeId;
const PAGE_SIZE = 20;
const COLUMNS = 'film_id, title, stock, rental_rate, rental_duration';

class NotFoundError extends Error {}
class ValidationError extends Error {
  constructor(errors) {
    super('Invalid film data');
    this.errors = errors;
  }
}
class AllNodesDownError extends Error {
  constructor(tried) {
    super(`No node holding this data is reachable (tried ${tried.map((t) => `node ${t.nodeId}: ${t.error}`).join('; ')})`);
    this.tried = tried;
  }
}

// Run fn(nodeId) on each node in order until one is reachable.
// Errors other than connection errors (bad data, missing row) stop at once.
async function withFailover(order, fn) {
  const tried = [];
  for (const nodeId of order) {
    try {
      const result = await fn(nodeId);
      return { result, nodeId, skipped: tried };
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      tried.push({ nodeId, error: err.code || err.message });
    }
  }
  throw new AllNodesDownError(tried);
}

// ---------- validation ----------

function parseFilm(body, { requireId = false } = {}) {
  const errors = {};
  const film = {};

  const rawId = String(body.film_id ?? '').trim();
  if (rawId === '') {
    if (requireId) errors.film_id = 'Film ID is required.';
  } else if (!/^\d+$/.test(rawId) || Number(rawId) < 1 || Number(rawId) > 2147483647) {
    errors.film_id = 'Film ID must be a positive whole number.';
  } else {
    film.film_id = Number(rawId);
  }

  film.title = String(body.title ?? '').trim();
  if (!film.title) errors.title = 'Title is required.';
  else if (film.title.length > 255) errors.title = 'Title must be at most 255 characters.';

  const stock = String(body.stock ?? '').trim();
  if (!/^\d+$/.test(stock) || Number(stock) > 2147483647) errors.stock = 'Stock must be a whole number, 0 or more.';
  else film.stock = Number(stock);

  const rate = String(body.rental_rate ?? '').trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(rate)) errors.rental_rate = 'Rental rate must be between 0.00 and 99.99.';
  else film.rental_rate = Number(rate);

  const duration = String(body.rental_duration ?? '').trim();
  if (!/^\d+$/.test(duration) || Number(duration) < 1 || Number(duration) > 127) {
    errors.rental_duration = 'Rental duration must be between 1 and 127 days.';
  } else film.rental_duration = Number(duration);

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return film;
}

// ---------- reads ----------

async function getFilm(filmId) {
  const { result, nodeId, skipped } = await withFailover(accessOrder(filmId, LOCAL), async (n) => {
    const [rows] = await getPool(n).execute(`SELECT ${COLUMNS} FROM film WHERE film_id = ?`, [filmId]);
    return rows[0] || null;
  });
  if (!result) throw new NotFoundError(`Film ${filmId} not found`);
  return { film: result, servedBy: [nodeId], skipped };
}

function searchClause(q) {
  if (!q) return { where: '', params: [] };
  if (/^\d+$/.test(q)) return { where: 'WHERE film_id = ? OR title LIKE ?', params: [Number(q), `%${q}%`] };
  return { where: 'WHERE title LIKE ?', params: [`%${q}%`] };
}

async function pageFrom(nodeId, where, params, limit, offset) {
  const pool = getPool(nodeId);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM film ${where}`, params);
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM film ${where} ORDER BY film_id LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { total, rows };
}

// Lists the whole table. Reads from the central node. If it is down, rebuilds
// the same page from the union of Node 2 and Node 3.
async function listFilms({ q = '', page = 1 } = {}) {
  q = String(q).trim();
  page = Math.max(1, Number.parseInt(page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const { where, params } = searchClause(q);

  try {
    const { total, rows } = await pageFrom(CENTRAL, where, params, PAGE_SIZE, offset);
    return { films: rows, total, page, pageSize: PAGE_SIZE, q, servedBy: [CENTRAL], warnings: [] };
  } catch (err) {
    if (!isConnectionError(err)) throw err;
  }

  // Central node down: each fragment returns its first offset+PAGE_SIZE rows,
  // and merging them by film_id gives the requested page.
  const warnings = [`Node ${CENTRAL} is unreachable, so this list was built from Node 2 and Node 3.`];
  const parts = await Promise.all(
    [2, 3].map((n) =>
      pageFrom(n, where, params, offset + PAGE_SIZE, 0).then(
        (r) => ({ nodeId: n, ...r }),
        (err) => {
          if (!isConnectionError(err)) throw err;
          warnings.push(`Node ${n} is also unreachable, so its films are missing from this list.`);
          return null;
        },
      ),
    ),
  );
  const live = parts.filter(Boolean);
  if (!live.length) throw new AllNodesDownError([1, 2, 3].map((nodeId) => ({ nodeId, error: 'unreachable' })));

  const merged = live.flatMap((p) => p.rows).sort((a, b) => a.film_id - b.film_id);
  return {
    films: merged.slice(offset, offset + PAGE_SIZE),
    total: live.reduce((sum, p) => sum + p.total, 0),
    page,
    pageSize: PAGE_SIZE,
    q,
    servedBy: live.map((p) => p.nodeId),
    warnings,
  };
}

// ---------- writes ----------
// Each write commits on the first reachable node holding the row (this node
// first if it holds it, else central), then replicate() copies the change to
// the other node holding the row.

async function nextFilmId() {
  const { result } = await withFailover([CENTRAL, 2, 3], async (n) => {
    const [[row]] = await getPool(n).query('SELECT COALESCE(MAX(film_id), 0) AS maxId FROM film');
    return row.maxId;
  });
  // If central is down this only sees one fragment. Duplicates are then caught
  // by the primary key on the fragment, but not across nodes. Member 3/4 should
  // revisit this together with recovery.
  return result + 1;
}

async function createFilm(body) {
  const film = parseFilm(body);
  if (film.film_id == null) film.film_id = await nextFilmId();

  const { nodeId } = await withFailover(accessOrder(film.film_id, LOCAL), (n) =>
    withTransaction(n, async (conn) => {
      try {
        await conn.execute(
          `INSERT INTO film (${COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
          [film.film_id, film.title, film.stock, film.rental_rate, film.rental_duration],
        );
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') throw new ValidationError({ film_id: `Film ID ${film.film_id} already exists.` });
        throw err;
      }
    }),
  );
  const replication = await replicate({ op: 'insert', filmId: film.film_id, film, origin: nodeId });
  return { film, writtenTo: nodeId, replication };
}

async function updateFilm(filmId, body) {
  const film = { ...parseFilm(body), film_id: filmId };

  const { nodeId } = await withFailover(accessOrder(filmId, LOCAL), (n) =>
    withTransaction(n, async (conn) => {
      const [rows] = await conn.execute('SELECT film_id FROM film WHERE film_id = ? FOR UPDATE', [filmId]);
      if (!rows.length) throw new NotFoundError(`Film ${filmId} not found`);
      await conn.execute(
        'UPDATE film SET title = ?, stock = ?, rental_rate = ?, rental_duration = ? WHERE film_id = ?',
        [film.title, film.stock, film.rental_rate, film.rental_duration, filmId],
      );
    }),
  );
  const replication = await replicate({ op: 'update', filmId, film, origin: nodeId });
  return { film, writtenTo: nodeId, replication };
}

async function deleteFilm(filmId) {
  const { nodeId } = await withFailover(accessOrder(filmId, LOCAL), (n) =>
    withTransaction(n, async (conn) => {
      const [res] = await conn.execute('DELETE FROM film WHERE film_id = ?', [filmId]);
      if (!res.affectedRows) throw new NotFoundError(`Film ${filmId} not found`);
    }),
  );
  const replication = await replicate({ op: 'delete', filmId, origin: nodeId });
  return { writtenTo: nodeId, replication };
}

module.exports = {
  PAGE_SIZE,
  parseFilm,
  getFilm,
  listFilms,
  createFilm,
  updateFilm,
  deleteFilm,
  NotFoundError,
  ValidationError,
  AllNodesDownError,
};
