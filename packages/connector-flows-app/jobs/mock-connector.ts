import { job, schemas } from "../../../../prism-new3/packages/prism-flows/mod.ts";

export const connectorEventSchema = schemas.object({
  id: schemas.string(),
  kind: schemas.string(),
  scope: schemas.object({
    tenantId: schemas.string(),
    projectId: schemas.string(),
    connectionId: schemas.string(),
    provider: schemas.string(),
  }),
  correlationId: schemas.string(),
  idempotencyKey: schemas.string(),
  local: schemas.record(schemas.unknown()).optional(),
  external: schemas.record(schemas.unknown()).optional(),
  task: schemas.record(schemas.unknown()).optional(),
  comment: schemas.record(schemas.unknown()).optional(),
  evidence: schemas.record(schemas.unknown()),
  occurredAt: schemas.string(),
});

export const connectorDispatchInputSchema = schemas.object({
  event: connectorEventSchema,
  outboxEventId: schemas.string().optional(),
  attempt: schemas.number(),
});

job("mockConnectorApply", {
  runtime: "deno",
  batch: { mode: "scalar" },
  input: connectorDispatchInputSchema,
  output: connectorEventSchema,
  permissions: { connections: ["mock-external"] },
  run: ({ input }: { input: any }) => {
    const event = input.event;
    const taskId = event.local?.id ?? event.external?.id ?? "MOCK-1";
    return {
      id: `mock-inbound:${event.id}`,
      kind: "connector.inbound.task_upserted",
      scope: event.scope,
      correlationId: event.correlationId,
      idempotencyKey: `${event.idempotencyKey}:mock-inbound`,
      local: { kind: "task", id: taskId },
      external: {
        system: "mock",
        kind: "issue",
        id: taskId,
        url: `https://mock-connector.internal/issues/${encodeURIComponent(taskId)}`,
      },
      task: {
        id: taskId,
        title: `Mock external issue for ${taskId}`,
        description: "Produced by the hosted Unblock mock connector Flow.",
        lifecycle: "open",
        priority: 2,
      },
      evidence: {
        sourceOutboxEventId: input.outboxEventId ?? null,
        attempt: input.attempt,
      },
      occurredAt: new Date().toISOString(),
    };
  },
});
