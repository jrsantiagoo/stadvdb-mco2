const path = require('path');
const express = require('express');
const config = require('./config');
const { closeAll } = require('./db/pools');
const { NotFoundError, AllNodesDownError } = require('./services/filmService');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Available to every view: which node rendered the page, plus any notice
// passed along by a redirect after a write.
app.use((req, res, next) => {
  res.locals.localNode = config.nodeId;
  res.locals.currentPath = req.path;
  res.locals.notice = typeof req.query.notice === 'string' ? req.query.notice : null;
  res.locals.noticeLevel = req.query.level === 'warn' ? 'warn' : 'ok';
  res.locals.servedBy = null;
  res.locals.warnings = [];
  next();
});

app.get('/', (req, res) => res.redirect('/films'));
app.use('/films', require('./routes/films'));
app.use('/reports', require('./routes/reports'));
app.use('/concurrency', require('./routes/concurrency'));
app.use('/nodes', require('./routes/nodes'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: `Nothing at ${req.path}.` });
});

app.use((err, req, res, _next) => {
  let status = 500;
  if (err instanceof NotFoundError) status = 404;
  else if (err instanceof AllNodesDownError) status = 503;
  if (status === 500) console.error(err);
  if (req.path.endsWith('.json')) {
    return res.status(status).json({ error: err.message, tried: err.tried });
  }
  res.status(status).render('error', {
    title: status === 404 ? 'Not found' : status === 503 ? 'Database unavailable' : 'Something went wrong',
    message: err.message,
  });
});

const server = app.listen(config.port, () => {
  console.log(`Node ${config.nodeId} app listening on http://localhost:${config.port} (isolation: ${config.isolationLevel})`);
});

function shutdown() {
  server.close(() => closeAll().finally(() => process.exit(0)));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;
