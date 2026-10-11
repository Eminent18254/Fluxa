# Fluxa projection API

A read-only mirror of Fluxa obligations in **SQLite**. There is no hosted
database: the datastore is a single file, created automatically on first run.

## Why it exists

The Intelligent Contract is the source of truth for every obligation and every
decision. This service only makes that state queryable and cheap to aggregate, so
a dashboard never has to walk the chain. It cannot create, verify or pay
anything - there is no endpoint for it, by design.

## Run it

```bash
npm install
npm run sync     # copy contract state into SQLite
npm run dev      # http://localhost:8787
```

`FLUXA_DB_PATH` sets the file location and defaults to `api/data/fluxa.sqlite`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness, storage backend, last sync |
| GET | `/api/summary` | Counts and totals grouped by status |
| GET | `/api/obligations?merchant=0x...` | Obligations for one merchant |
| GET | `/api/obligations/:id` | One obligation |
| GET | `/api/obligations/:id/decisions` | The append-only decision history |
| POST | `/api/sync` | Refresh the mirror from the contract |
