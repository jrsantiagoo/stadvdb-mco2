# stadvdb-mco2

A three-node distributed film database with a web app on each node.

- `db/schema.sql`: the `film` table, identical on all three nodes
- `app/`: Node.js + Express web app, deployed to every node
- `docs/ui-plan.md`: pages, routing, fragmentation rule and interfaces between members

## Run the app

Requires Node 22+ and the three MySQL nodes, each loaded with `db/schema.sql`.

```sh
cd app
npm install
cp .env.example .env   # set NODE_ID and the three nodes' connection details
npm start              # http://localhost:3000
npm test               # unit tests, no database needed
```

Set `NODE_ID=1`, `2` or `3` to match the server the app runs on.
Every copy of the app needs connection details for all three nodes.

## Concurrency tests (Step 3, Cases 1–3)

Run on any node while the apps are up and the films are loaded:

```sh
cd app
npm run test:concurrency
```

By default this runs each case under all four isolation levels, 3 times each
(36 runs, about 2 minutes), alternating film 1 (Node 2) and film 2 (Node 3).
It writes two files to `app/test-logs/`:

- `concurrency-<time>.md`: summary tables for the report appendix
- `concurrency-<time>.jsonl`: the full result of every run

A run passes when every node holding the film ends with the same stock, and
that stock matches the committed writes. Dirty reads, non-repeatable reads and
lock waits are listed per run but don't fail it: they are what the isolation
levels are being compared on.

Options:

```sh
# have each node's app coordinate every third run
npm run test:concurrency -- --apps http://10.20.200.175:3000,http://10.20.200.176:3000,http://10.20.200.177:3000
# fewer combinations, more repetitions
npm run test:concurrency -- --cases 2,3 --levels "READ COMMITTED,SERIALIZABLE" --runs 5
```

Each run resets the film's stock to 10 on every node holding it, so pick film
IDs that are safe to modify (`--films`).
