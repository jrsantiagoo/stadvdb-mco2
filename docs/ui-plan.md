# Web app: UI plan

The same Express app runs on all three nodes. Only `NODE_ID` in `.env` differs.
Users never pick a node: the app routes every read and write itself.
That is the data transparency the report asks about.

## Fragmentation rule (proposed, confirm at kickoff)

| Node | Holds |
|---|---|
| Node 1 (central) | every row |
| Node 2 | `film_id % 2 = 1` (odd ids) |
| Node 3 | `film_id % 2 = 0` (even ids) |

Why film_id parity:
- **No row migration.** `film_id` is the primary key and never changes.
  Splitting on `rental_rate` or `rental_duration` would force an update to
  delete the row from one fragment and insert it into the other, which makes
  replication and recovery harder.
- **Balanced.** Odd and even ids split the table about 50/50.
- **Easy to route.** The app finds a row's node with a modulo, no lookup.

Cost: the split carries no business meaning. A range split such as
`film_id <= 500` works just as well if the team prefers it. The rule is in
`app/src/db/fragment.js` and nowhere else.

## Routing

| Operation | Node order (stops at the first reachable node) |
|---|---|
| Read one film | this node if it holds the row → central → fragment |
| List / search | central; if it is down, merge Node 2 + Node 3 |
| Reports | all three nodes in parallel (for the fragment check); breakdowns from central, or merged from Node 2 + Node 3 when it is down |
| Insert / update / delete | same order as "read one film", then `replicate()` to the other node holding the row |

## Pages

| Page | Route | Status | Owner |
|---|---|---|---|
| Film list + search + paging | `GET /films` | done | M2 |
| Film detail | `GET /films/:id` | done | M2 |
| Add film | `GET /films/new`, `POST /films` | done | M2 |
| Edit film | `GET /films/:id/edit`, `POST /films/:id` | done | M2 |
| Delete film | `POST /films/:id/delete` | done | M2 |
| Node status (up/down, row counts, fragment check) | `GET /nodes`, `GET /nodes/status.json` | done | M2 |
| Reports: fragment check, breakdowns by rental rate and rental duration | `GET /reports`, `GET /reports/data.json` | done | M2 |
| Concurrency test script: every case × level × 3 runs, logs + Markdown summary | `npm run test:concurrency` | built, needs a real-DB run | M2 |
| Concurrency demo: Case 1–3 presets, isolation level picker or "compare all four", schedule table, anomaly checks | `GET /concurrency`, `POST /concurrency/run`, `POST /concurrency/run.json` | built, needs a real-DB run | M2 |
| Crash controls: take a node offline / bring it back | `/nodes` (buttons) | Checkpoint 3 | M3 |
| Recovery: pending log entries per node, replay | `/recovery` | Checkpoint 3 | M4 |

Every page shows which node rendered it (badge at the top right) and which node
supplied the data (footer). These two labels show replication and failover
during the demo.

## Interfaces for teammates

- **Replication (M3):** replace `app/src/services/replication.js`.
  Keep the signature `replicate({ op, filmId, film, origin }) → [{ nodeId, ok, error? }]`.
  The pages already display the results it returns.
- **Isolation level (M1/M3):** set `ISOLATION_LEVEL` in `.env`.
  Every transaction goes through `withTransaction()` in `app/src/db/pools.js`.
- **Recovery (M4):** a write whose replication fails comes back with `ok: false`.
  That is the point where a log entry should be recorded.
- **Node down detection:** `isConnectionError()` in `pools.js` decides whether
  to fail over to another node or report the error.

## Concurrency page

Each transaction starts at a node and runs on the first reachable node that
holds the film (the same routing as the rest of the app). Committed writes are
copied with `replicate()`, so Member 3's replication shows up here without changes.

| Preset (film on Node 1 + fragment F) | T1 | T2 | T3 |
|---|---|---|---|
| Case 1: reads | read @ Node 1 | read @ F | read @ other fragment (runs on Node 1) |
| Case 2: write + reads | update +5 @ F | read @ F, 300 ms later | read @ Node 1, 300 ms later |
| Case 3: writes | update +5 @ Node 1 | update −3 @ F, 300 ms later | update +2 @ Node 1, 600 ms later |

What it detects:
- **dirty read:** a reader saw a writer's value before that writer committed
- **non-repeatable read:** two reads in one transaction differ
- **lost update:** the committed updates don't all show in the final stock
- **replicas disagree:** Node 1 and the fragment differ at the end
- **lock waits, deadlocks and lock wait timeouts**

"Reset" puts the film back to a fixed stock on both nodes before each run, so
runs are comparable. "Compare all four" always resets.

`LOCK_WAIT_TIMEOUT` (default 10 s) replaces MySQL's 50 s default, so a blocked
run fails visibly instead of hanging the page.

For test scripts:

```sh
curl -X POST http://<node>:3000/concurrency/run.json \
  -H 'content-type: application/json' \
  -d '{"case": 2, "filmId": 7, "isolationLevel": "ALL"}'
```

## Known gaps in the skeleton

- `replication.js` is a placeholder: a failed replication is reported to the user, then dropped.
- New ids come from `MAX(film_id) + 1` when the ID field is left blank. Two
  concurrent inserts can pick the same id; the second then fails with
  "already exists". Revisit for concurrency Case 3.
- No authentication: this is a course demo.
