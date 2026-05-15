# Hosted Unblock Connector Flows

This Prism Flows app is the hosted connector orchestration boundary for Unblock.
It deliberately does not store Unblock task state in Prism. Unblock publishes
typed connector events from its Postgres outbox; this Flow app owns durable
external orchestration and posts resulting connector events back to the Unblock
inbox.

Current fixture:

- `unblock-connector-dispatch`: manual outbox dispatch plus scheduled
  reconciliation trigger.
- `mockConnectorApply`: deterministic mock connector job used to review the Flow
  boundary before GitHub Issues is implemented.
- `github-issues-inbound`: GitHub `issues` webhook ingestion with Prism trigger
  signature metadata, delivery dedupe, issue-to-task mapping, and Unblock inbox
  application.
- `github-issues-outbound`: Unblock outbox-triggered task sync to GitHub Issues
  with task/config lookup, rate-limited GitHub API calls, idempotency, and
  mapping writeback.
- `github-issues-reconcile`: manual and scheduled GitHub issue backfill/polling
  that reuses the same mapping/inbox path and advances a durable cursor only
  after Unblock writes are requested.
- `normalizeGitHubIssueWebhook`: deterministic webhook normalizer that converts
  GitHub issue payloads into typed Unblock connector events and mapping writes.
- `prepareGitHubIssueOutbound` / `finalizeGitHubIssueOutbound`: deterministic
  request shaping and mapping finalization for outbound GitHub sync.
- `prepareGitHubIssueBackfill` / `normalizeGitHubIssueBackfill`: deterministic
  polling request shaping and issue list normalization for reconciliation.
- `unblock-hosted-api`: redacted bearer-token connection to hosted Unblock.
- `github-api`: rate-limited GitHub REST API connection for installation-token
  issue writes. Set `GITHUB_API_BASE_URL` to point both the smoke runner and
  Prism Flow HTTP connection at the local simulator.
- `mock-external`: redacted API-key connection for the mocked connector target.

Run locally:

```sh
deno test --allow-read packages/connector-flows-app/tests
deno check packages/connector-flows-app/prism.flow.ts
```

Run the real GitHub connector smoke against a disposable repository:

```sh
UNBLOCK_HOSTED_API_URL=https://unblock.example.com \
UNBLOCK_HOSTED_API_TOKEN=... \
UNBLOCK_TENANT_ID=... \
UNBLOCK_PROJECT_ID=... \
UNBLOCK_GITHUB_CONNECTION_ID=github-main \
PRISM_RUNTIME_ENDPOINT=http://127.0.0.1:50051 \
PRISM_FLOWS_PROJECT_ID=unblock-flows \
GITHUB_REPOSITORY=owner/repo \
GITHUB_TOKEN=... \
GITHUB_INSTALLATION_TOKEN=... \
deno run --allow-env --allow-net --allow-read packages/connector-flows-app/scripts/github_smoke.ts
```

The smoke creates a GitHub issue, starts the `github-issues-inbound` Flow, waits
for the hosted Unblock task, updates the task, starts the
`github-issues-outbound` Flow, waits for the GitHub issue update, confirms the
mapping, and closes the test issue by default. Use `--no-cleanup` to leave the
issue open for inspection. Use `--allow-missing-env` for CI/preflight jobs that
should report missing credentials without failing the job.

To exercise the real GitHub webhook path instead of manually starting the
inbound Flow, expose Prism Flows ingress publicly and pass:

```sh
UNBLOCK_SMOKE_GITHUB_WEBHOOK=1 \
UNBLOCK_SMOKE_GITHUB_WEBHOOK_URL=https://example.ngrok-free.app/webhooks/github/issues \
UNBLOCK_SMOKE_GITHUB_WEBHOOK_SECRET=... \
deno run --allow-env --allow-net --allow-read packages/connector-flows-app/scripts/github_smoke.ts
```

In that mode the smoke creates a temporary GitHub `issues` webhook for the
target repository, creates the disposable issue, waits for Unblock to ingest it
through Prism ingress, then removes the webhook during cleanup.

`GITHUB_TOKEN` is only the smoke runner token for creating, polling, and
cleaning up the disposable issue. The deployed Flow app still needs its own
configured `UNBLOCK_HOSTED_API_TOKEN` and `GITHUB_INSTALLATION_TOKEN` secrets.
For local smoke runs, `GITHUB_INSTALLATION_TOKEN` may be the same token if the
repository permissions are sufficient.

The app imports the local Prism Flows SDK from `~/code/prism-new3`.

Run the GitHub simulator for deterministic connector tests and benchmarks:

```sh
deno run --allow-net packages/connector-flows-app/scripts/github_simulator.ts --port=49090
```

Then run the smoke or full E2E with:

```sh
GITHUB_API_BASE_URL=http://127.0.0.1:49090 \
GITHUB_REPOSITORY=owner/repo \
GITHUB_TOKEN=sim-token \
GITHUB_INSTALLATION_TOKEN=sim-token \
deno run --allow-env --allow-net --allow-read packages/connector-flows-app/scripts/github_smoke.ts
```

The simulator implements the GitHub Issues and repository webhook endpoints used
by the connector, signs outgoing `issues` webhooks with the configured hook
secret, records deliveries under `/_sim/deliveries`, exposes state at
`/_sim/state`, and can force primary, secondary, and content creation rate-limit
responses for benchmark scenarios.
