# unblock

Dependency-first project management for implementation work.

This repository is a TypeScript workspace with four packages:

- `@unblock/core`: domain types, service layer, repository contracts, SQLite store, import/export.
- `@unblock/cli`: `unblock` command line interface.
- `@unblock/server`: Hono HTTP API over the same service layer.
- `@unblock/web`: React/Vite UI for the ready queue, task details, tracks, tags, and activity.

The core service layer depends on `AppStore` repository interfaces, not SQLite.
Unblock supports a local SQLite store and a Postgres store for shared
self-hosted deployments.

## Quick Start

```sh
npm install
npm run build
npm run test
npm link
unblock task add --id AUTH-001 --title "Add AST capture"
unblock task list --status ready
```

By default the SQLite database lives at `~/.unblock/unblock.sqlite`. Override
it with `--db` or `UNBLOCK_DB`.

For a shared self-hosted Postgres instance, point Unblock at a connection URL:

```sh
unblock config set --storage-mode postgres --postgres-url postgres://user:pass@host:5432/unblock
unblock db status
unblock serve
```

The same settings can be supplied with `UNBLOCK_STORAGE_MODE=postgres` and
`UNBLOCK_POSTGRES_URL=...`. `unblock db status`, `unblock db migrate`, and
`unblock doctor` report the Postgres migration and health state.

Run the storage CRUD baseline against the configured store:

```sh
unblock bench storage --tasks 1000 --dependencies 999 --tags 20 --task-tags 1000 --instructions 20 --comments 1000 --activity 1000 --format json
```

Run the reproducible benchmark matrix across local SQLite plus any supplied
Postgres targets:

```sh
unblock --format json bench matrix \
  --modes sqlite,postgres,hosted \
  --scenarios storage,matcher \
  --postgres-url postgres://user:pass@localhost:5432/unblock \
  --hosted-tenant-id tenant_benchmark \
  --tasks 1000 \
  --read-tasks 5000 \
  --iterations 50 \
  --pollers 50
```

If no Postgres URL is supplied, those matrix cases are reported as skipped
while the SQLite cases still run. Hosted mode uses the same Postgres store with
a tenant-scoped benchmark identity, matching the hosted deployment storage path.

Runtime UI settings live in `~/.unblock/config.json` and are created by
`unblock serve` if missing:

```json
{
  "ui": {
    "refreshIntervalMs": 5000,
    "persistState": true
  }
}
```

Run the API:

```sh
unblock serve
```
