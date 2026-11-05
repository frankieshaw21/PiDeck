import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ModelOption, SessionSnapshot, SessionSummary } from "../desktop/ipc-contract.js";
import type { RpcRecord, RuntimeEvent } from "../runtime/types.js";
import type { TaskIntent } from "../core/execution-controller.js";
import "./styles.css";

type ViewItem = { key: string; kind: "user" | "assistant" | "tool" | "notice"; text: string };

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return String(message ?? "");
  const value = message as Record<string, unknown>;
  const content = value.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => {
    if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text);
    return "";
  }).join("");
  return "";
}

function historyItems(messages: unknown[]): ViewItem[] {
  return messages.filter((message) => !(message && typeof message === "object" && "role" in message && (message as { role: unknown }).role === "system")).map((message, index) => {
    const role = message && typeof message === "object" && "role" in message ? String((message as { role: unknown }).role) : "notice";
    const kind = role === "user" ? "user" : role === "assistant" ? "assistant" : role === "toolResult" ? "tool" : "notice";
    return { key: `history-${index}`, kind, text: messageText(message) || `[${role}]` };
  });
}

function delta(record: RpcRecord): string | null {
  if (record.type !== "message_update") return null;
  const update = record.assistantMessageEvent;
  if (update && typeof update === "object" && (update as { type?: unknown }).type === "text_delta") {
    return String((update as { delta?: unknown }).delta ?? "");
  }
  return null;
}

function App() {
  const [project, setProject] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<SessionSnapshot | null>(null);
  const [items, setItems] = useState<Record<string, ViewItem[]>>({});
  const [draft, setDraft] = useState("");
  const [intent, setIntent] = useState<TaskIntent>("analysis");
  const [error, setError] = useState<string | null>(null);
  const [uiRequest, setUiRequest] = useState<RuntimeEvent | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [extensionStatus, setExtensionStatus] = useState<Record<string, Record<string, string>>>({});
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.piHarness.listSessions().then(setSessions).catch(showError);
    const offSessions = window.piHarness.onSessionsChanged(setSessions);
    const offEvents = window.piHarness.onRuntimeEvent(handleEvent);
    return () => { offSessions(); offEvents(); };
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [items, selected?.metadata.id]);

  const selectedSummary = useMemo(() => sessions.find((session) => session.id === selected?.metadata.id), [sessions, selected]);
  const currentItems = selected ? items[selected.metadata.id] ?? [] : [];

  function showError(value: unknown) { setError(value instanceof Error ? value.message : String(value)); }

  function handleEvent(event: RuntimeEvent) {
    if (event.record.type === "extension_ui_request") {
      const method = String(event.record.method);
      if (["select", "confirm", "input", "editor"].includes(method)) setUiRequest(event);
      if (method === "notify") {
        setItems((current) => ({ ...current, [event.harnessSessionId]: [...(current[event.harnessSessionId] ?? []), {
          key: `extension-${event.sequence}`, kind: "notice", text: String(event.record.message ?? "Extension notification"),
        }] }));
      }
      if (method === "setStatus") {
        const key = String(event.record.statusKey ?? "extension");
        const text = event.record.statusText == null ? "" : String(event.record.statusText);
        setExtensionStatus((current) => ({
          ...current,
          [event.harnessSessionId]: { ...(current[event.harnessSessionId] ?? {}), [key]: text },
        }));
      }
    }
    const text = delta(event.record);
    setItems((current) => {
      const list = [...(current[event.harnessSessionId] ?? [])];
      if (text !== null) {
        const key = `stream-${event.runId ?? "run"}`;
        const index = list.findIndex((item) => item.key === key);
        if (index >= 0) list[index] = { ...list[index]!, text: list[index]!.text + text };
        else list.push({ key, kind: "assistant", text });
      } else if (event.record.type === "tool_execution_start" || event.record.type === "tool_execution_end") {
        list.push({ key: `event-${event.sequence}`, kind: "tool", text: summarizeTool(event.record) });
      } else if (event.record.type === "auto_retry_start") {
        list.push({ key: `event-${event.sequence}`, kind: "notice", text: "Pi is retrying the request…" });
      }
      return { ...current, [event.harnessSessionId]: list };
    });
  }

  async function chooseProject() {
    const path = await window.piHarness.chooseProject();
    if (path) setProject(path);
  }

  async function createSession() {
    try {
      const path = project ?? await window.piHarness.chooseProject();
      if (!path) return;
      setProject(path);
      const snapshot = await window.piHarness.createSession(path);
      setSelected(snapshot);
      setItems((current) => ({ ...current, [snapshot.metadata.id]: [] }));
    } catch (value) { showError(value); }
  }

  async function openSession(id: string) {
    try {
      const snapshot = await window.piHarness.openSession(id);
      setSelected(snapshot);
      setProject(snapshot.metadata.projectDir);
      setItems((current) => ({ ...current, [id]: current[id] ?? historyItems(snapshot.messages) }));
      void window.piHarness.listModels(id).then(setModels).catch(showError);
    } catch (value) { showError(value); }
  }

  async function deleteSession(id: string, name: string) {
    if (!window.confirm(`Delete session “${name}”? This is separate from stopping a task and removes its Pi history.`)) return;
    try {
      await window.piHarness.deleteSession(id);
      setItems((current) => { const next = { ...current }; delete next[id]; return next; });
      if (selected?.metadata.id === id) setSelected(null);
    } catch (value) { showError(value); }
  }

  async function renameSession(id: string, currentName: string) {
    const name = window.prompt("Rename session", currentName)?.trim();
    if (!name || name === currentName) return;
    try {
      await window.piHarness.renameSession(id, name);
      if (selected?.metadata.id === id) setSelected({ ...selected, metadata: { ...selected.metadata, name } });
    } catch (value) { showError(value); }
  }

  async function send() {
    if (!selected || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    setItems((current) => ({
      ...current,
      [selected.metadata.id]: [...(current[selected.metadata.id] ?? []), { key: `user-${Date.now()}`, kind: "user", text }],
    }));
    try { await window.piHarness.prompt(selected.metadata.id, text, intent); } catch (value) {
      if (!String(value).includes("Queued task cancelled")) showError(value);
    }
  }

  async function answerUi(value: string | boolean | null) {
    if (!uiRequest) return;
    const record = uiRequest.record;
    const id = String(record.id);
    const response = value === null
      ? { type: "extension_ui_response" as const, id, cancelled: true as const }
      : typeof value === "boolean"
        ? { type: "extension_ui_response" as const, id, confirmed: value }
        : { type: "extension_ui_response" as const, id, value };
    try { await window.piHarness.respondToExtensionUi(uiRequest.harnessSessionId, response); } catch (reason) { showError(reason); }
    setUiRequest(null);
  }

  const running = selectedSummary && ["Queued", "Running", "WaitingForUser", "Stopping"].includes(selectedSummary.status);
  const currentModel = selected?.state.model ? `${selected.state.model.provider}/${selected.state.model.id}` : "";

  return <main className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="mark">π</span><span>Minimal Pi</span></div>
      <button className="project" onClick={() => void chooseProject()} title={project ?? "Choose project"}>
        <small>PROJECT</small><strong>{project ? project.split("/").pop() : "Choose folder"}</strong>
      </button>
      <div className="session-heading"><span>Sessions</span><button onClick={() => void createSession()} aria-label="New session">＋</button></div>
      <nav className="sessions">
        {sessions.filter((session) => !project || session.projectDir === project).map((session) =>
          <div key={session.id} className={selected?.metadata.id === session.id ? "session active" : "session"}>
            <button className="session-open" onClick={() => void openSession(session.id)}><span className={`dot ${session.status.toLowerCase()}`} />
              <span className="session-copy"><strong>{session.name}</strong><small>{session.status}</small></span></button>
            <button className="session-action" title="Rename session" onClick={() => void renameSession(session.id, session.name)}>✎</button>
            <button className="session-action session-delete" title="Delete session" onClick={() => void deleteSession(session.id, session.name)}>×</button>
          </div>)}
      </nav>
      <div className="sidebar-footer">Pi Runtime · RPC</div>
    </aside>
    <section className="chat">
      {selected ? <>
        <header className="chat-header">
          <div><h1>{selected.metadata.name}</h1><select className="model-select" value={currentModel} disabled={Boolean(running)} onChange={(event) => {
            const option = models.find((model) => `${model.provider}/${model.id}` === event.target.value);
            if (!option) return;
            void window.piHarness.setModel(selected.metadata.id, option.provider, option.id).then(async () => {
              const snapshot = await window.piHarness.openSession(selected.metadata.id);
              setSelected(snapshot);
            }).catch(showError);
          }}><option value={currentModel}>{currentModel || "No model"}</option>{models.filter((model) => `${model.provider}/${model.id}` !== currentModel).map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name ?? `${model.provider}/${model.id}`}</option>)}</select></div>
          <div className="status-stack"><span className={`status ${selectedSummary?.status.toLowerCase()}`}>{selectedSummary?.status ?? "Idle"}</span>
            {Object.values(extensionStatus[selected.metadata.id] ?? {}).filter(Boolean).map((text, index) => <small key={index}>{text}</small>)}
          </div>
        </header>
        <div className="messages">
          {currentItems.length === 0 && <div className="empty"><span>π</span><h2>Start a conversation</h2><p>This session shares the project folder, but keeps its own Pi context.</p></div>}
          {currentItems.map((item) => <article key={item.key} className={`message ${item.kind}`}><div className="label">{item.kind}</div><pre>{item.text}</pre></article>)}
          <div ref={endRef} />
        </div>
        <footer className="composer">
          {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
          <select className="intent-select" value={intent} disabled={Boolean(running)} onChange={(event) => setIntent(event.target.value as TaskIntent)} title="Workspace coordination intent">
            <option value="analysis">Analyze</option>
            <option value="write">May write</option>
          </select>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} disabled={Boolean(running)} placeholder={running ? "Pi is working…" : "Message Pi"} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
          }} />
          <button className={running ? "stop" : "send"} onClick={() => running ? void window.piHarness.abort(selected.metadata.id) : void send()}>{running ? "Stop" : "Send"}</button>
        </footer>
      </> : <div className="welcome"><span>π</span><h1>Minimal Pi Harness</h1><p>Choose a project and create an independent session.</p><button onClick={() => void createSession()}>Open a project</button></div>}
    </section>
    {uiRequest && <ExtensionDialog event={uiRequest} onAnswer={(value) => void answerUi(value)} />}
  </main>;
}

function summarizeTool(record: RpcRecord): string {
  const name = String(record.toolName ?? record.name ?? "tool");
  return record.type === "tool_execution_start" ? `Running ${name}…` : `${name} finished`;
}

function ExtensionDialog({ event, onAnswer }: { event: RuntimeEvent; onAnswer: (value: string | boolean | null) => void }) {
  const record = event.record;
  const method = String(record.method);
  const [value, setValue] = useState(String(record.prefill ?? ""));
  return <div className="modal-backdrop"><div className="modal">
    <small>PI EXTENSION · {method.toUpperCase()}</small><h2>{String(record.title ?? "Pi needs your input")}</h2>
    {record.message ? <p>{String(record.message)}</p> : null}
    {method === "select" ? <div className="options">{Array.isArray(record.options) && record.options.map((option) => <button key={String(option)} onClick={() => onAnswer(String(option))}>{String(option)}</button>)}</div> : null}
    {method === "input" ? <input autoFocus value={value} placeholder={String(record.placeholder ?? "")} onChange={(e) => setValue(e.target.value)} /> : null}
    {method === "editor" ? <textarea autoFocus value={value} onChange={(e) => setValue(e.target.value)} /> : null}
    <div className="modal-actions"><button onClick={() => onAnswer(null)}>Cancel</button>
      {method === "confirm" ? <><button onClick={() => onAnswer(false)}>No</button><button className="primary" onClick={() => onAnswer(true)}>Yes</button></> : null}
      {(method === "input" || method === "editor") && <button className="primary" onClick={() => onAnswer(value)}>Submit</button>}
    </div>
  </div></div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
