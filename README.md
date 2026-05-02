# not-jira

Dependency-first project management for implementation work.

This repository is a TypeScript workspace with four packages:

- `@not-jira/core`: domain types, service layer, repository contracts, SQLite store, import/export.
- `@not-jira/cli`: `not-jira` command line interface.
- `@not-jira/server`: Hono HTTP API over the same service layer.
- `@not-jira/web`: React/Vite UI for the ready queue, task details, tracks, tags, and activity.

The core service layer depends on `AppStore` repository interfaces, not SQLite.
The V1 concrete store is `createSqliteStore`, and a future Postgres store should
only need to implement the same repositories and transaction contract.

## Quick Start

```sh
npm install
npm run build
npm run test
npm link
not-jira task add --id AUTH-001 --title "Add AST capture"
not-jira task list --status ready
```

By default the SQLite database lives at `~/.not-jira/not-jira.sqlite`. Override
it with `--db` or `NOT_JIRA_DB`.

Run the API:

```sh
not-jira serve
```
