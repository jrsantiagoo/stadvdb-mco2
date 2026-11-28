#!/usr/bin/env node
// Recovery test script for MCO2 Step 4 (Cases 1–4).
//
// Usage:
//   node scripts/recovery-tests.js --apps http://103.231.240.136:10175,http://103.231.240.136:10176,http://103.231.240.136:10177
//
// Options:
//   --apps    comma-separated Node 1, 2, 3 URLs (default http://localhost:3000)
//   --cases   which cases to run: 1,2,3,4       (default 1,2,3,4)
//   --runs    repetitions per case              (default 3)
//   --out     folder for logs                   (default test-logs)

const fs = require('fs');
const path = require('path');

const CASE_NAMES = {
  1: 'Fragment -> Central write fails (Node 1 offline)',
  2: 'Central Node 1 recovers and replays missed write',
  3: 'Central -> Fragment write fails (Node 3 offline)',
  4: 'Fragment Node 3 recovers and replays missed write',
};

function localAppUrl() {
  const env = {};
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), processEnv: env, quiet: true });
  return `http://localhost:${process.env.PORT || env.PORT || 3000}`;
}

function parseArgs(argv) {
  const defaultUrl = localAppUrl();
  const opts = {
    apps: [defaultUrl, defaultUrl, defaultUrl],
    cases: [1, 2, 3, 4],
    runs: 3,
    out: 'test-logs',
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (!(key in opts) || value === undefined) throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    i++;
    const list = value.split(',').map((s) => s.trim()).filter(Boolean);
    switch (key) {
      case 'apps':
        opts.apps = list.map((u) => u.replace(/\/+$/, ''));
        while (opts.apps.length < 3) opts.apps.push(opts.apps[0]);
        break;
      case 'cases':
        opts.cases = list.map(Number);
        break;
      case 'runs':
        opts.runs = Number(value);
        break;
      case 'out':
        opts.out = value;
        break;
    }
  }
  return opts;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error || res.statusText}`);
  return data;
}

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
  if (res.status >= 400) throw new Error(`Form POST failed: HTTP ${res.status}`);
}

async function readFilm(appUrl, filmId) {
  const res = await fetch(`${appUrl}/films/${filmId}`);
  const html = await res.text();
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const stockMatch = html.match(/Stock<\/dt>\s*<dd>(\d+)<\/dd>/i);
  const rateMatch = html.match(/Rental rate<\/dt>\s*<dd>\$?([0-9.]+)<\/dd>/i);
  const durMatch = html.match(/Rental duration<\/dt>\s*<dd>(\d+)/i);
  return {
    title: titleMatch ? titleMatch[1].trim() : `FILM ${filmId}`,
    stock: stockMatch ? Number(stockMatch[1]) : null,
    rental_rate: rateMatch ? rateMatch[1] : '0.99',
    rental_duration: durMatch ? Number(durMatch[1]) : 3,
  };
}

async function executeRun(opts, run) {
  const [n1Url, n2Url, n3Url] = opts.apps;
  const results = [];
  const t0 = Date.now();

  // Save baseline films 1 (odd -> Node 2) and 2 (even -> Node 3)
  const base1 = await readFilm(n1Url, 1);
  const base2 = await readFilm(n1Url, 2);

  try {
    // Ensure all nodes start online
    await postJson(`${n2Url}/nodes/1/toggle`, { online: true });
    await postJson(`${n1Url}/nodes/3/toggle`, { online: true });

    // --- CASE 1: Node 1 offline -> write odd film_id=1 on Node 2 ---
    const targetOddStock = (base1.stock ?? 10) + run;
    if (opts.cases.includes(1)) {
      const start = Date.now();
      await postJson(`${n2Url}/nodes/1/toggle`, { online: false });
      await postForm(`${n2Url}/films/1`, {
        title: base1.title,
        stock: String(targetOddStock),
        rental_rate: String(base1.rental_rate),
        rental_duration: String(base1.rental_duration),
      });
      const status = await (await fetch(`${n2Url}/nodes/status.json`)).json();
      const queued = status.pendingLogs.some((l) => l.target_node === 1 && l.film_id === 1);
      results.push({
        caseNo: 1,
        run,
        filmId: 1,
        pass: queued,
        detail: queued ? `Queued PENDING log on Node 2 for target Node 1 (stock=${targetOddStock})` : 'Missing pending log for Node 1',
        durationMs: Date.now() - start,
      });
    }

    // --- CASE 2: Node 1 recovers -> replays missed write ---
    if (opts.cases.includes(2)) {
      const start = Date.now();
      const rec = await postJson(`${n2Url}/nodes/1/toggle`, { online: true });
      const n1After = await readFilm(n1Url, 1);
      const pass = rec.recovered.some((r) => r.targetNode === 1 && r.filmId === 1 && r.ok) && n1After.stock === targetOddStock;
      results.push({
        caseNo: 2,
        run,
        filmId: 1,
        pass,
        detail: `Node 1 recovered; stock=${n1After.stock} (expected ${targetOddStock})`,
        durationMs: Date.now() - start,
      });
    }

    // --- CASE 3: Node 3 offline -> write even film_id=2 on Node 1 ---
    const targetEvenStock = (base2.stock ?? 10) + run;
    if (opts.cases.includes(3)) {
      const start = Date.now();
      await postJson(`${n1Url}/nodes/3/toggle`, { online: false });
      await postForm(`${n1Url}/films/2`, {
        title: base2.title,
        stock: String(targetEvenStock),
        rental_rate: String(base2.rental_rate),
        rental_duration: String(base2.rental_duration),
      });
      const status = await (await fetch(`${n1Url}/nodes/status.json`)).json();
      const queued = status.pendingLogs.some((l) => l.target_node === 3 && l.film_id === 2);
      results.push({
        caseNo: 3,
        run,
        filmId: 2,
        pass: queued,
        detail: queued ? `Queued PENDING log on Node 1 for target Node 3 (stock=${targetEvenStock})` : 'Missing pending log for Node 3',
        durationMs: Date.now() - start,
      });
    }

    // --- CASE 4: Node 3 recovers -> replays missed write ---
    if (opts.cases.includes(4)) {
      const start = Date.now();
      const rec = await postJson(`${n1Url}/nodes/3/toggle`, { online: true });
      const n3After = await readFilm(n3Url, 2);
      const pass = rec.recovered.some((r) => r.targetNode === 3 && r.filmId === 2 && r.ok) && n3After.stock === targetEvenStock;
      results.push({
        caseNo: 4,
        run,
        filmId: 2,
        pass,
        detail: `Node 3 recovered; stock=${n3After.stock} (expected ${targetEvenStock})`,
        durationMs: Date.now() - start,
      });
    }
  } finally {
    // Restore nodes online and revert test films back to original stock
    await postJson(`${n2Url}/nodes/1/toggle`, { online: true }).catch(() => {});
    await postJson(`${n1Url}/nodes/3/toggle`, { online: true }).catch(() => {});
    if (base1.stock != null) await postForm(`${n1Url}/films/1`, { ...base1, stock: String(base1.stock) }).catch(() => {});
    if (base2.stock != null) await postForm(`${n1Url}/films/2`, { ...base2, stock: String(base2.stock) }).catch(() => {});
  }

  return results;
}

function toMarkdown(results, opts, startedAt) {
  const passed = results.filter((r) => r.pass).length;
  const lines = [
    '# Global Failure & Recovery Test Results (Step 4)',
    '',
    `- Started: ${startedAt}`,
    `- Apps: ${opts.apps.join(', ')}`,
    `- **${passed} of ${results.length} runs passed**`,
    '',
    '| # | Case | Description | Run | Film | Result | Outcome | Time |',
    '|---|---|---|---|---|---|---|---|',
  ];
  results.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.caseNo} | ${CASE_NAMES[r.caseNo]} | ${r.run} | ${r.filmId} | ${r.pass ? 'PASS' : '**FAIL**'} | ${r.detail} | ${r.durationMs} ms |`);
  });
  return `${lines.join('\n')}\n`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-').slice(0, 19);
  fs.mkdirSync(opts.out, { recursive: true });
  const jsonlPath = path.join(opts.out, `recovery-${stamp}.jsonl`);
  const mdPath = path.join(opts.out, `recovery-${stamp}.md`);

  const allResults = [];
  for (let run = 1; run <= opts.runs; run++) {
    const runResults = await executeRun(opts, run);
    for (const r of runResults) {
      allResults.push(r);
      fs.appendFileSync(jsonlPath, `${JSON.stringify({ ...r, at: new Date().toISOString() })}\n`);
      console.log(`[Run ${run}/${opts.runs}] Case ${r.caseNo}  ${r.pass ? 'PASS' : 'FAIL'} — ${r.detail}`);
    }
  }

  fs.writeFileSync(mdPath, toMarkdown(allResults, opts, startedAt));
  const passed = allResults.filter((r) => r.pass).length;
  console.log(`\n${passed}/${allResults.length} passed`);
  console.log(`Full log: ${jsonlPath}`);
  console.log(`Summary:  ${mdPath}`);
  process.exitCode = passed === allResults.length ? 0 : 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 2;
  });
}

module.exports = { parseArgs, toMarkdown };
