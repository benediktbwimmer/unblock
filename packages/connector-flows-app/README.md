# Hosted Unblock Connector Flows

This Prism Flows app is the hosted connector orchestration boundary for
Unblock. It deliberately does not store Unblock task state in Prism. Unblock
publishes typed connector events from its Postgres outbox; this Flow app owns
durable external orchestration and posts resulting connector events back to the
Unblock inbox.

Current fixture:

- `unblock-connector-dispatch`: manual outbox dispatch plus scheduled
  reconciliation trigger.
- `mockConnectorApply`: deterministic mock connector job used to review the
  Flow boundary before GitHub Issues is implemented.
- `github-issues-inbound`: GitHub `issues` webhook ingestion with Prism trigger
  signature metadata, delivery dedupe, issue-to-task mapping, and Unblock inbox
  application.
- `github-issues-outbound`: Unblock outbox-triggered task sync to GitHub Issues
  with task/config lookup, rate-limited GitHub API calls, idempotency, and
  mapping writeback.
- `normalizeGitHubIssueWebhook`: deterministic webhook normalizer that converts
  GitHub issue payloads into typed Unblock connector events and mapping writes.
- `prepareGitHubIssueOutbound` / `finalizeGitHubIssueOutbound`: deterministic
  request shaping and mapping finalization for outbound GitHub sync.
- `unblock-hosted-api`: redacted bearer-token connection to hosted Unblock.
- `github-api`: rate-limited GitHub REST API connection for installation-token
  issue writes.
- `mock-external`: redacted API-key connection for the mocked connector target.

Run locally:

```sh
deno test --allow-read packages/connector-flows-app/tests
deno check packages/connector-flows-app/prism.flow.ts
```

The app imports the local Prism Flows SDK from `~/code/prism-new3`.
