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
