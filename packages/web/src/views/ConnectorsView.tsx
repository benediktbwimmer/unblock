import { useEffect, useState } from "react";
import { Check, Pause, Play, PlugZap, RotateCcw, Trash2, X } from "lucide-react";
import { fetchJson, mutateJson, withProject } from "../api";
import type { ConnectorSyncQueueItemRecord, ConnectorSyncQueueItemStatus, GitHubConnectionRecord, JiraConnectionRecord } from "../types";

interface GitHubDraft {
  connectionId: string;
  appId: string;
  installationId: string;
  repositoryOwner: string;
  repositoryName: string;
  privateKeySecretId: string;
  webhookSecretId: string;
}

interface JiraDraft {
  connectionId: string;
  siteUrl: string;
  cloudId: string;
  projectKey: string;
  accountEmail: string;
  tokenSecretId: string;
  webhookSecretId: string;
}

type ProviderConnection = GitHubConnectionRecord | JiraConnectionRecord;

const emptyGitHubDraft: GitHubDraft = {
  connectionId: "github-main",
  appId: "",
  installationId: "",
  repositoryOwner: "",
  repositoryName: "",
  privateKeySecretId: "",
  webhookSecretId: ""
};

const emptyJiraDraft: JiraDraft = {
  connectionId: "jira-main",
  siteUrl: "",
  cloudId: "",
  projectKey: "",
  accountEmail: "",
  tokenSecretId: "",
  webhookSecretId: ""
};

export function ConnectorsView({ projectId, onError }: { projectId: string; onError: (message: string | null) => void }) {
  const [connections, setConnections] = useState<GitHubConnectionRecord[]>([]);
  const [jiraConnections, setJiraConnections] = useState<JiraConnectionRecord[]>([]);
  const [queueItems, setQueueItems] = useState<ConnectorSyncQueueItemRecord[]>([]);
  const [queueStatus, setQueueStatus] = useState<ConnectorSyncQueueItemStatus | "all">("all");
  const [draft, setDraft] = useState<GitHubDraft>(emptyGitHubDraft);
  const [jiraDraft, setJiraDraft] = useState<JiraDraft>(emptyJiraDraft);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const queuePath = queueStatus === "all"
        ? withProject("/api/connectors/sync-queue", projectId)
        : `${withProject("/api/connectors/sync-queue", projectId)}&status=${encodeURIComponent(queueStatus)}`;
      const [nextConnections, nextJiraConnections, nextQueue] = await Promise.all([
        fetchJson<GitHubConnectionRecord[]>(withProject("/api/connectors/github/connections", projectId)),
        fetchJson<JiraConnectionRecord[]>(withProject("/api/connectors/jira/connections", projectId)),
        fetchJson<ConnectorSyncQueueItemRecord[]>(queuePath)
      ]);
      setConnections(nextConnections);
      setJiraConnections(nextJiraConnections);
      setQueueItems(nextQueue);
      onError(null);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [projectId, queueStatus]);

  async function createConnection() {
    await mutateConnector(async () => {
      await mutateJson<GitHubConnectionRecord>("/api/connectors/github/connections", {
        method: "POST",
        body: {
          projectId,
          connectionId: draft.connectionId,
          appId: draft.appId,
          installationId: draft.installationId,
          repositoryOwner: draft.repositoryOwner,
          repositoryName: draft.repositoryName,
          privateKeySecretId: draft.privateKeySecretId,
          webhookSecretId: draft.webhookSecretId
        }
      });
      setDraft(emptyGitHubDraft);
      await load();
    });
  }

  async function createJiraConnection() {
    await mutateConnector(async () => {
      await mutateJson<JiraConnectionRecord>("/api/connectors/jira/connections", {
        method: "POST",
        body: {
          projectId,
          connectionId: jiraDraft.connectionId,
          siteUrl: jiraDraft.siteUrl,
          cloudId: jiraDraft.cloudId || null,
          projectKey: jiraDraft.projectKey,
          accountEmail: jiraDraft.accountEmail || undefined,
          tokenSecretId: jiraDraft.tokenSecretId,
          webhookSecretId: jiraDraft.webhookSecretId
        }
      });
      setJiraDraft(emptyJiraDraft);
      await load();
    });
  }

  async function transition(connection: ProviderConnection, action: "pause" | "resume" | "delete") {
    await mutateConnector(async () => {
      const provider = connection.provider;
      const path = action === "delete"
        ? withProject(`/api/connectors/${provider}/connections/${connection.id}`, projectId)
        : withProject(`/api/connectors/${provider}/connections/${connection.id}/${action}`, projectId);
      await mutateJson<ProviderConnection>(path, { method: action === "delete" ? "DELETE" : "POST" });
      await load();
    });
  }

  async function updateQueueItem(item: ConnectorSyncQueueItemRecord, status: ConnectorSyncQueueItemStatus) {
    await mutateConnector(async () => {
      await mutateJson<ConnectorSyncQueueItemRecord>(
        withProject(`/api/connectors/sync-queue/${item.id}/status`, projectId),
        {
          method: "POST",
          body: {
            status,
            resolvedAt: ["ignored", "resolved"].includes(status) ? new Date().toISOString() : null
          }
        }
      );
      await load();
    });
  }

  async function mutateConnector(fn: () => Promise<void>) {
    setLoading(true);
    try {
      await fn();
      onError(null);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="wide-view connectors-view">
      <div className="view-heading">
        <div>
          <h1>Connectors</h1>
          <p>Hosted issue sync through Prism Flows.</p>
        </div>
        <button className="icon-button" onClick={() => void load()} title="Refresh connectors"><PlugZap size={17} /></button>
      </div>

      <div className="connector-grid">
        <div className="connector-config">
          <h2>GitHub Installation</h2>
          <div className="connector-form">
            <input value={draft.connectionId} onChange={(event) => setDraft({ ...draft, connectionId: event.target.value })} placeholder="connection id" />
            <input value={draft.appId} onChange={(event) => setDraft({ ...draft, appId: event.target.value })} placeholder="GitHub App ID" />
            <input value={draft.installationId} onChange={(event) => setDraft({ ...draft, installationId: event.target.value })} placeholder="installation ID" />
            <input value={draft.repositoryOwner} onChange={(event) => setDraft({ ...draft, repositoryOwner: event.target.value })} placeholder="owner" />
            <input value={draft.repositoryName} onChange={(event) => setDraft({ ...draft, repositoryName: event.target.value })} placeholder="repository" />
            <input value={draft.privateKeySecretId} onChange={(event) => setDraft({ ...draft, privateKeySecretId: event.target.value })} placeholder="private key secret id" />
            <input value={draft.webhookSecretId} onChange={(event) => setDraft({ ...draft, webhookSecretId: event.target.value })} placeholder="webhook secret id" />
            <button disabled={loading || !draft.appId || !draft.installationId || !draft.repositoryOwner || !draft.repositoryName || !draft.privateKeySecretId || !draft.webhookSecretId} onClick={() => void createConnection()}>
              <PlugZap size={16} /> Save installation
            </button>
          </div>
        </div>

        <div className="connector-list">
          {connections.map((connection) => (
            <div className="connector-row" key={connection.id}>
              <div>
                <h2>{connection.metadata.repositoryOwner}/{connection.metadata.repositoryName}</h2>
                <p>{connection.id} · installation {connection.metadata.installationId}</p>
                <div className="connector-meta">
                  <span>{connection.status}</span>
                  <span>{connection.metadata.syncDirection}</span>
                  <span>{connection.metadata.conflictPolicy}</span>
                </div>
              </div>
              <div className="connector-actions">
                {connection.status === "paused" ? (
                  <button className="icon-button" onClick={() => void transition(connection, "resume")} title="Resume"><Play size={16} /></button>
                ) : (
                  <button className="icon-button" onClick={() => void transition(connection, "pause")} title="Pause"><Pause size={16} /></button>
                )}
                <button className="icon-button danger" onClick={() => void transition(connection, "delete")} title="Disconnect"><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
          {connections.length === 0 ? <p className="muted">{loading ? "Loading connector state..." : "No GitHub installations configured."}</p> : null}
        </div>
      </div>

      <div className="connector-grid">
        <div className="connector-config">
          <h2>Jira Project</h2>
          <div className="connector-form">
            <input value={jiraDraft.connectionId} onChange={(event) => setJiraDraft({ ...jiraDraft, connectionId: event.target.value })} placeholder="connection id" />
            <input value={jiraDraft.siteUrl} onChange={(event) => setJiraDraft({ ...jiraDraft, siteUrl: event.target.value })} placeholder="https://team.atlassian.net" />
            <input value={jiraDraft.cloudId} onChange={(event) => setJiraDraft({ ...jiraDraft, cloudId: event.target.value })} placeholder="cloud id" />
            <input value={jiraDraft.projectKey} onChange={(event) => setJiraDraft({ ...jiraDraft, projectKey: event.target.value })} placeholder="project key" />
            <input value={jiraDraft.accountEmail} onChange={(event) => setJiraDraft({ ...jiraDraft, accountEmail: event.target.value })} placeholder="account email" />
            <input value={jiraDraft.tokenSecretId} onChange={(event) => setJiraDraft({ ...jiraDraft, tokenSecretId: event.target.value })} placeholder="token secret id" />
            <input value={jiraDraft.webhookSecretId} onChange={(event) => setJiraDraft({ ...jiraDraft, webhookSecretId: event.target.value })} placeholder="webhook secret id" />
            <button disabled={loading || !jiraDraft.siteUrl || !jiraDraft.projectKey || !jiraDraft.tokenSecretId || !jiraDraft.webhookSecretId} onClick={() => void createJiraConnection()}>
              <PlugZap size={16} /> Save Jira project
            </button>
          </div>
        </div>

        <div className="connector-list">
          {jiraConnections.map((connection) => (
            <div className="connector-row" key={connection.id}>
              <div>
                <h2>{connection.metadata.projectKey}</h2>
                <p>{connection.id} · {connection.metadata.siteUrl}</p>
                <div className="connector-meta">
                  <span>{connection.status}</span>
                  <span>{connection.metadata.syncPreset}</span>
                  <span>{connection.metadata.scopes.length} scopes</span>
                </div>
              </div>
              <div className="connector-actions">
                {connection.status === "paused" ? (
                  <button className="icon-button" onClick={() => void transition(connection, "resume")} title="Resume"><Play size={16} /></button>
                ) : (
                  <button className="icon-button" onClick={() => void transition(connection, "pause")} title="Pause"><Pause size={16} /></button>
                )}
                <button className="icon-button danger" onClick={() => void transition(connection, "delete")} title="Disconnect"><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
          {jiraConnections.length === 0 ? <p className="muted">{loading ? "Loading connector state..." : "No Jira projects configured."}</p> : null}
        </div>
      </div>

      <div className="sync-queue-panel">
        <div className="sync-queue-toolbar">
          <div>
            <h2>Sync Queue</h2>
            <p>{queueItems.length} visible divergence{queueItems.length === 1 ? "" : "s"}</p>
          </div>
          <select value={queueStatus} onChange={(event) => setQueueStatus(event.target.value as ConnectorSyncQueueItemStatus | "all")}>
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="auto_applying">Auto applying</option>
            <option value="manual_review">Manual review</option>
            <option value="blocked">Blocked</option>
            <option value="failed">Failed</option>
            <option value="ignored">Ignored</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>

        <div className="sync-queue-list">
          {queueItems.map((item) => (
            <div className={`sync-queue-row severity-${item.severity}`} key={item.id}>
              <div className="sync-queue-main">
                <div className="sync-queue-title">
                  <h3>{item.localKind}:{item.localId}</h3>
                  <span>{item.status}</span>
                  <span>{item.decision.kind}</span>
                </div>
                <p>{item.connectionId} · {item.externalKind}:{item.externalId} · {item.diff.field}</p>
                <div className="sync-queue-diff">
                  <div>
                    <strong>External</strong>
                    <code>{formatQueueValue(item.diff.externalValue)}</code>
                  </div>
                  <div>
                    <strong>Unblock</strong>
                    <code>{formatQueueValue(item.diff.localValue)}</code>
                  </div>
                  <div>
                    <strong>Policy</strong>
                    <code>{item.policyRef.policyId ?? item.policyRef.preset}{item.policyRef.scopeQuery ? ` · ${item.policyRef.scopeQuery}` : ""}</code>
                  </div>
                </div>
                <p className="sync-queue-reason">{item.decision.reason}</p>
              </div>
              <div className="sync-queue-actions">
                {item.status !== "auto_applying" && item.status !== "resolved" && item.status !== "ignored" ? (
                  <button className="icon-button" onClick={() => void updateQueueItem(item, "auto_applying")} title="Apply"><Check size={16} /></button>
                ) : null}
                {item.status !== "pending" && item.status !== "resolved" && item.status !== "ignored" ? (
                  <button className="icon-button" onClick={() => void updateQueueItem(item, "pending")} title="Retry"><RotateCcw size={16} /></button>
                ) : null}
                {item.status !== "ignored" && item.status !== "resolved" ? (
                  <button className="icon-button danger" onClick={() => void updateQueueItem(item, "ignored")} title="Ignore"><X size={16} /></button>
                ) : null}
                {item.status !== "resolved" ? (
                  <button className="icon-button" onClick={() => void updateQueueItem(item, "resolved")} title="Resolve"><Check size={16} /></button>
                ) : null}
              </div>
            </div>
          ))}
          {queueItems.length === 0 ? <p className="muted">{loading ? "Loading sync queue..." : "No sync queue items match the current filter."}</p> : null}
        </div>
      </div>
    </section>
  );
}

function formatQueueValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
