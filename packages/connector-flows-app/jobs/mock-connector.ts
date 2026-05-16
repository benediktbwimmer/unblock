import { schemas } from "../../../../prism-new3/packages/prism-flows/mod.ts";

export { mockConnectorApply } from "../helpers/mock-connector.ts";

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
