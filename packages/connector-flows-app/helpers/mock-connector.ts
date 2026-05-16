export function mockConnectorApply(input: any) {
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
}
