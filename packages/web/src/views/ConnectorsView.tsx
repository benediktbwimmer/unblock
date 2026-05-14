import { useEffect, useState } from "react";
import { Pause, Play, PlugZap, Trash2 } from "lucide-react";
import { fetchJson, mutateJson, withProject } from "../api";
import type { GitHubConnectionRecord } from "../types";

interface Draft {
  connectionId: string;
  appId: string;
  installationId: string;
  repositoryOwner: string;
  repositoryName: string;
  privateKeySecretId: string;
  webhookSecretId: string;
}

const emptyDraft: Draft = {
  connectionId: "github-main",
  appId: "",
  installationId: "",
  repositoryOwner: "",
  repositoryName: "",
  privateKeySecretId: "",
  webhookSecretId: ""
};

export function ConnectorsView({ projectId, onError }: { projectId: string; onError: (message: string | null) => void }) {
  const [connections, setConnections] = useState<GitHubConnectionRecord[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setConnections(await fetchJson<GitHubConnectionRecord[]>(withProject("/api/connectors/github/connections", projectId)));
      onError(null);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [projectId]);

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
      setDraft(emptyDraft);
      await load();
    });
  }

  async function transition(connection: GitHubConnectionRecord, action: "pause" | "resume" | "delete") {
    await mutateConnector(async () => {
      const path = action === "delete"
        ? withProject(`/api/connectors/github/connections/${connection.id}`, projectId)
        : withProject(`/api/connectors/github/connections/${connection.id}/${action}`, projectId);
      await mutateJson<GitHubConnectionRecord>(path, { method: action === "delete" ? "DELETE" : "POST" });
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
          <h1>GitHub Connector</h1>
          <p>GitHub App installations synced through Prism Flows.</p>
        </div>
        <button className="icon-button" onClick={() => void load()} title="Refresh connectors"><PlugZap size={17} /></button>
      </div>

      <div className="connector-grid">
        <div className="connector-config">
          <h2>Installation</h2>
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
    </section>
  );
}
