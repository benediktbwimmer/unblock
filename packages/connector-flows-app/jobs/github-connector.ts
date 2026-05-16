import { schemas } from "../../../../prism-new3/packages/prism-flows/mod.ts";

export {
  finalizeGitHubIssueOutbound,
  normalizeGitHubIssueBackfill,
  normalizeGitHubIssueWebhook,
  prepareGitHubIssueBackfill,
  prepareGitHubIssueOutbound,
} from "../helpers/github-connector.ts";

export const githubWebhookInputSchema = schemas.object({
  deliveryId: schemas.string(),
  event: schemas.string(),
  scope: schemas.object({
    tenantId: schemas.string(),
    projectId: schemas.string(),
    connectionId: schemas.string(),
  }),
  payload: schemas.record(schemas.unknown()),
});

export const githubReconcileInputSchema = schemas.object({
  tenantId: schemas.string(),
  projectId: schemas.string(),
  connectionId: schemas.string(),
  cursor: schemas.string().optional(),
  replayWindowSeconds: schemas.number().optional(),
  reason: schemas.string().optional(),
});
