import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ContextItem } from "../desktop/context-management.js";
import type { ManagedExtension } from "../desktop/extensions.js";
import type { ModelOption, ProjectSummary, SessionSnapshot, SessionSummary, WorkspaceDiscovery } from "../desktop/ipc-contract.js";
import type { ContextUsage, ImageAttachment, RpcRecord, RuntimeEvent } from "../runtime/types.js";
import { composeFileContext, parseFileContext, type FileContext } from "./file-context.js";
import { lastModelUsage, modelUsage, type ModelUsage } from "./model-usage.js";
import { MarkdownMessage } from "./markdown.js";
import { DevicePanel } from "./device-panel.js";
import type { DeviceState } from "../desktop/devices.js";
import { applyAssistantEnd, applyMessageUpdate, applyToolEvent, groupMessages, groupTimeline, type ViewItem } from "./activity.js";
import "./styles.css";
import "./language.css";
import "./layout.css";
import { Icon } from "./icon.js";
import type { ThinkingLevel, PiSessionState } from "../runtime/types.js";

type Language = "zh" | "en";
const translations = {
  zh: { project:"项目", chooseProject:"选择项目", chooseFolder:"选择文件夹", sessions:"会话", search:"搜索会话…", newSession:"新建会话", rename:"重命名会话", delete:"删除会话", workspace:"工作台", workspaceDescription:"管理会话可用的上下文和能力。", connections:"连接", skills:"技能", knowledge:"知识", instructions:"指令", capabilities:"工作台功能", unavailable:"此应用暂不支持管理 MCP 连接、技能、知识和指令。", noModel:"未选择模型", start:"开始对话", empty:"此会话使用项目文件夹，并拥有独立的 Pi 上下文。", user:"用户", assistant:"助手", notice:"通知", toolActivity:"工具活动", context:"上下文", currentSession:"当前会话", mode:"模式", analyze:"分析", write:"允许写入", contextUnavailable:"更多运行时上下文暂不可在此查看。", intentTitle:"工作区操作模式", working:"Pi 正在工作…", message:"发送消息给 Pi", stop:"停止", send:"发送", welcome:"选择一个项目并创建独立会话。", openProject:"打开项目", cancel:"取消", no:"否", yes:"是", submit:"提交", inputNeeded:"Pi 需要你的输入", language:"语言", retry:"Pi 正在重试请求…", extensionNotification:"扩展通知", idle:"空闲", queued:"排队中", running:"运行中", waitingForUser:"等待确认", stopping:"正在停止", failed:"失败" },
  en: { project:"Project", chooseProject:"Choose project", chooseFolder:"Choose folder", sessions:"Sessions", search:"Search sessions…", newSession:"New session", rename:"Rename session", delete:"Delete session", workspace:"Workspace", workspaceDescription:"Manage the context and capabilities available to your sessions.", connections:"Connections", skills:"Skills", knowledge:"Knowledge", instructions:"Instructions", capabilities:"Workspace capabilities", unavailable:"MCP connections, skills, knowledge, and instructions are not yet managed by this app.", noModel:"No model", start:"Start a conversation", empty:"This session shares the project folder, but keeps its own Pi context.", user:"User", assistant:"Assistant", notice:"Notice", toolActivity:"Tool activity", context:"Context", currentSession:"Current session", mode:"Mode", analyze:"Analyze", write:"May write", contextUnavailable:"Additional runtime context is not available here yet.", intentTitle:"Workspace coordination intent", working:"Pi is working…", message:"Message Pi", stop:"Stop", send:"Send", welcome:"Choose a project and create an independent session.", openProject:"Open a project", cancel:"Cancel", no:"No", yes:"Yes", submit:"Submit", inputNeeded:"Pi needs your input", language:"Language", retry:"Pi is retrying the request…", extensionNotification:"Extension notification", idle:"Idle", queued:"Queued", running:"Running", waitingForUser:"Waiting for confirmation", stopping:"Stopping", failed:"Failed" },
} as const;

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
  const items: ViewItem[] = [];
  const toolIndexes = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    const content = Array.isArray(value.content) ? value.content : [];
    if (value.role === "assistant") {
      if (typeof value.content === "string" && value.content) items.push({ key: `history-${index}`, kind: "assistant", text: value.content });
      content.forEach((part, partIndex) => {
        if (!part || typeof part !== "object") return;
        if (part.type === "text" && typeof part.text === "string" && part.text) items.push({ key: `history-${index}-${partIndex}`, kind: "assistant", text: part.text });
        if (part.type === "thinking" && part.redacted !== true && typeof part.thinking === "string" && part.thinking) items.push({ key: `history-${index}-${partIndex}`, kind: "thinking", text: part.thinking });
        if (part.type === "toolCall") applyToolEvent(items, { type: "tool_execution_start", toolCallId: part.id, toolName: part.name, args: part.arguments }, index, toolIndexes);
      });
    } else if (value.role === "toolResult") {
      applyToolEvent(items, { type: "tool_execution_end", toolCallId: value.toolCallId, toolName: value.toolName ?? "tool", result: value.content, isError: value.isError }, index, toolIndexes);
    } else if (value.role === "user") {
      const images = content.filter((part): part is ImageAttachment => part && part.type === "image" && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(part.mimeType) && typeof part.data === "string");
      const parsed = parseFileContext(messageText(value));
      items.push({ key: `history-${index}`, kind: "user", text: parsed.text, ...(parsed.files.length ? { files: parsed.files } : {}), ...(images.length ? { images } : {}) });
    }
  });
  return items;
}

function WorkLog({ segment, language }: { segment: ViewItem[]; language: Language }) {
  const [open, setOpen] = useState(false);
  return <details className="work-log" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{language === "zh" ? "工作记录" : "Work log"} <span>{segment.length}</span></summary>{open && (<div className="work-log-entries">{segment.map((item) => <details key={item.key} className="tool-activity"><summary>{item.kind === "thinking" ? (item.streaming ? (language === "zh" ? "正在思考…" : "Thinking…") : (language === "zh" ? "思考过程" : "Thinking")) : (language === "zh" ? item.text.replace(/^Running (.*)…$/, "正在运行 $1…").replace(/^(.*) finished$/, "$1 已完成").replace(/^(.*) failed$/, "$1 失败") : item.text)}</summary><pre>{item.kind === "thinking" ? item.text || (language === "zh" ? "等待内容…" : "Waiting for content…") : item.detail || (language === "zh" ? "暂无详情" : "No details available")}</pre></details>)}</div>)}</details>;
}

function App() {
  const [devices, setDevices] = useState<Record<string, DeviceState>>({});
  useEffect(() => {
    let active = true;
    const apply = (state: DeviceState) => { if (active) setDevices((current) => ({ ...current, [state.sessionId]: state })); };
    const unsubscribe = window.piHarness.onDeviceChanged(apply);
    void window.piHarness.listDevices().then((states) => states.forEach(apply)).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  const [language, setLanguage] = useState<Language>(() => {
    const saved = localStorage.getItem("ui-language");
    return saved === "zh" || saved === "en" ? saved : navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  });
  const t = translations[language];
  const statusText = (status: SessionSummary["status"]) => ({ Idle:t.idle, Queued:t.queued, Running:t.running, WaitingForUser:t.waitingForUser, Stopping:t.stopping, Failed:t.failed })[status];
  useEffect(() => { localStorage.setItem("ui-language", language); document.documentElement.lang = language === "zh" ? "zh-CN" : "en"; }, [language]);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("sidebar-width"));
    return Number.isFinite(saved) && saved >= 200 && saved <= 480 ? saved : 222;
  });
  useEffect(() => { localStorage.setItem("sidebar-width", String(sidebarWidth)); }, [sidebarWidth]);
  const [project, setProject] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const openRequestRef = useRef(0);
  const snapshotsRef = useRef(new Map<string, SessionSnapshot>());
  const sendingRef = useRef(new Set<string>());
  const [sendingIds, setSendingIds] = useState<string[]>([]);
  const modelCacheRef = useRef(new Map<string, ModelOption[]>());
  const [visibleGroups, setVisibleGroups] = useState(30);
  const [selected, setSelected] = useState<SessionSnapshot | null>(null);
  const [items, setItems] = useState<Record<string, ViewItem[]>>({});
  const [composers, setComposers] = useState<Record<string, { draft: string; images: ImageAttachment[]; files: FileContext[] }>>({});
  const sessionId = selected?.metadata.id;
  const composer = (sessionId && composers[sessionId]) || { draft: "", images: [], files: [] };
  const { draft, images, files } = composer;
  function updateComposer(id: string | undefined, update: (current: typeof composer) => typeof composer) {
    if (id) setComposers((current) => ({ ...current, [id]: update(current[id] ?? { draft: "", images: [], files: [] }) }));
  }
  function setDraft(value: string) { updateComposer(sessionId, (current) => ({ ...current, draft: value })); }
  function setImages(value: ImageAttachment[] | ((current: ImageAttachment[]) => ImageAttachment[])) { updateComposer(sessionId, (current) => ({ ...current, images: typeof value === "function" ? value(current.images) : value })); }
  function setFiles(value: FileContext[] | ((current: FileContext[]) => FileContext[])) { updateComposer(sessionId, (current) => ({ ...current, files: typeof value === "function" ? value(current.files) : value })); }
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentSessionRef = useRef<string | null>(null);
  attachmentSessionRef.current = selected?.metadata.id ?? null;
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [authAction, setAuthAction] = useState<{ action: "login" | "logout"; provider: string } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [storedProviders, setStoredProviders] = useState<string[] | null>(null);
  function refreshAuth() { void window.piHarness.listStoredAuth().then((providers) => { setStoredProviders(providers); setAuthError(null); }).catch((error: unknown) => { setStoredProviders(null); setAuthError(String(error)); }); }
  useEffect(() => {
    if (!showLogin) return;
    refreshAuth();
    window.addEventListener("focus", refreshAuth);
    return () => window.removeEventListener("focus", refreshAuth);
  }, [showLogin]);
  const [search, setSearch] = useState("");
  const [projectRename, setProjectRename] = useState<{ path: string; value: string } | null>(null);
  const [projectRenameError, setProjectRenameError] = useState<string | null>(null);
  const [projectRenaming, setProjectRenaming] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [contextItems, setContextItems] = useState<ContextItem[] | null>(null);
  const [contextDialog, setContextDialog] = useState(false);
  const [contextVisibleCount, setContextVisibleCount] = useState(25);
  const [expandedContext, setExpandedContext] = useState<string | null>(null);
  const contextRequestRef = useRef(0);
  const [contextEdit, setContextEdit] = useState<{ id: string; text: string } | null>(null);
  const [contextBusy, setContextBusy] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [modelUsages, setModelUsages] = useState<Record<string, ModelUsage | null>>({});
  const [contextLoading, setContextLoading] = useState(false);
  const [workspace, setWorkspace] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<"connections" | "skills" | "knowledge" | "instructions" | "extensions">("connections");
  const [extensions, setExtensions] = useState<ManagedExtension[]>([]);
  const [extensionError, setExtensionError] = useState<string | null>(null);
  const [extensionBusy, setExtensionBusy] = useState(false);
  const [networkSource, setNetworkSource] = useState("");
  const [showNetworkInstall, setShowNetworkInstall] = useState(false);
  const [discovery, setDiscovery] = useState<WorkspaceDiscovery | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uiRequest, setUiRequest] = useState<RuntimeEvent | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [extensionStatus, setExtensionStatus] = useState<Record<string, Record<string, string>>>({});
  const endRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followMessagesRef = useRef(true);
  const assistantMessageStarts = useRef<Record<string, number>>({});
  const contextRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showContext) return;
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      if (!contextRef.current?.contains(event.target as Node)) setShowContext(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowContext(false);
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOnOutsidePointer);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [showContext]);

  useEffect(() => {
    if (!contextDialog) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); contextRequestRef.current++; setContextDialog(false); setContextEdit(null); }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [contextDialog]);

  useEffect(() => {
    void window.piHarness.listSessions().then(setSessions).catch(showError);
    void window.piHarness.listProjects().then(setProjects).catch(showError);
    const offSessions = window.piHarness.onSessionsChanged(setSessions);
    // Coalesce streaming bursts so React commits at most once per 32 ms.
    let pending: RuntimeEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const offEvents = window.piHarness.onRuntimeEvent((event) => {
      pending.push(event);
      timer ??= setTimeout(() => {
        timer = undefined;
        const events = pending;
        pending = [];
        events.forEach(handleEvent);
      }, 32);
    });
    return () => { offSessions(); offEvents(); clearTimeout(timer); };
  }, []);

  useEffect(() => { followMessagesRef.current = true; }, [selected?.metadata.id]);
  useEffect(() => {
    const container = messagesRef.current;
    if (container && followMessagesRef.current) container.scrollTop = container.scrollHeight;
  }, [items, selected?.metadata.id, workspace]);
  useEffect(() => {
    if (!workspace || !selected || selected.draft || selected.preview) return;
    let active = true;
    setDiscovery(null); setDiscoveryError(null);
    void window.piHarness.discoverWorkspace(selected.metadata.id).then((value) => { if (active) setDiscovery(value); }).catch((error: unknown) => { if (active) setDiscoveryError(String(error)); });
    return () => { active = false; };
  }, [workspace, selected?.metadata.id]);

  useEffect(() => {
    if (!workspace || workspaceTab !== "extensions") return;
    let active = true;
    void window.piHarness.listExtensions().then((items) => { if (active) { setExtensions(items); setExtensionError(null); } }).catch((error: unknown) => { if (active) setExtensionError(String(error)); });
    return () => { active = false; };
  }, [workspace, workspaceTab]);

  async function changeExtensions(action: () => Promise<ManagedExtension[]>) {
    if (extensionBusy) return;
    setExtensionBusy(true); setExtensionError(null);
    try { setExtensions(await action()); } catch (error) { setExtensionError(error instanceof Error ? error.message : String(error)); }
    finally { setExtensionBusy(false); }
  }

  const selectedSummary = useMemo(() => sessions.find((session) => session.id === selected?.metadata.id), [sessions, selected]);
  const currentItems = selected ? items[selected.metadata.id] : undefined;
  const messageGroups = useMemo(() => groupMessages(currentItems ?? []), [currentItems]);
  useEffect(() => { setVisibleGroups(30); }, [selected?.metadata.id]);

  useEffect(() => {
    if (!showContext || !selected || selected.draft || selected.preview) return;
    let active = true;
    setContextUsage(null);
    setContextLoading(true);
    void window.piHarness.getContextUsage(selected.metadata.id).then((usage) => {
      if (active) setContextUsage(usage);
    }).catch(() => { if (active) setContextUsage(null); }).finally(() => { if (active) setContextLoading(false); });
    return () => { active = false; };
  }, [showContext, selected?.metadata.id, selected?.state.model?.id, selectedSummary?.status]);

  function showError(value: unknown) { setError(value instanceof Error ? value.message : String(value)); }

  function handleEvent(event: RuntimeEvent) {
    if (event.record.type === "message_start" && (event.record.message as { role?: string } | undefined)?.role === "assistant") assistantMessageStarts.current[event.harnessSessionId] = event.sequence;
    const messageStart = assistantMessageStarts.current[event.harnessSessionId] ?? event.sequence;
    if (event.record.type === "message_end" && event.record.message && typeof event.record.message === "object" && (event.record.message as { role?: unknown }).role === "assistant") {
      const usage = modelUsage(event.record.message);
      setModelUsages((current) => ({ ...current, [event.harnessSessionId]: usage }));
    }
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
    if (!["message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "auto_retry_start"].includes(event.record.type)) return;
    setItems((current) => {
      const list = [...(current[event.harnessSessionId] ?? [])];
      if (event.record.type === "message_update") {
        applyMessageUpdate(list, event.record, event.sequence);
      } else if (event.record.type === "message_end") {
        applyAssistantEnd(list, event.record, event.sequence, messageStart);
      } else if (event.record.type === "tool_execution_start" || event.record.type === "tool_execution_update" || event.record.type === "tool_execution_end") {
        applyToolEvent(list, event.record, event.sequence);
      } else if (event.record.type === "auto_retry_start") {
        list.push({ key: `event-${event.sequence}`, kind: "notice", text: "Pi is retrying the request…" });
      }
      return { ...current, [event.harnessSessionId]: list };
    });
  }

  function closeContextManager() {
    contextRequestRef.current++;
    setContextDialog(false); setContextEdit(null); setExpandedContext(null);
  }
  async function openContextManager() {
    if (!selected || selected.draft || selected.preview) return;
    const request = ++contextRequestRef.current;
    setShowContext(false); setContextDialog(true); setContextItems(null); setContextError(null); setContextEdit(null); setExpandedContext(null); setContextVisibleCount(25);
    try { const items = await window.piHarness.listContextItems(selected.metadata.id); if (contextRequestRef.current === request) setContextItems(items); }
    catch (error) { if (contextRequestRef.current === request) { setContextItems([]); setContextError(error instanceof Error ? error.message : String(error)); } }
  }
  async function updateContext(id: string, edit: { excluded: boolean; text?: string } | null) {
    if (!selected || contextBusy) return;
    setContextBusy(true); setContextError(null);
    try { setContextItems(await window.piHarness.updateContextItem(selected.metadata.id, id, edit)); setContextEdit(null); }
    catch (error) { setContextError(error instanceof Error ? error.message : String(error)); }
    finally { setContextBusy(false); }
  }

  async function setContextRound(item: ContextItem) {
    if (!selected || contextBusy) return;
    setContextBusy(true); setContextError(null);
    try { setContextItems(await window.piHarness.setContextRound(selected.metadata.id, item.id, !item.roundExcluded)); setContextEdit(null); }
    catch (error) { setContextError(error instanceof Error ? error.message : String(error)); }
    finally { setContextBusy(false); }
  }

  function switchProject(path: string | null) {
    if (path === project) return;
    openRequestRef.current++;
    setProject(path);
    setSelected(null);
    setWorkspace(false);
    setShowContext(false);
    setContextDialog(false);
    setSearch("");
    setModels([]);
  }

  async function chooseProject() {
    try {
      const path = await window.piHarness.chooseProject();
      if (path) { setProjects(await window.piHarness.listProjects()); switchProject(path); }
    } catch (value) { showError(value); }
  }

  async function removeProject() {
    if (!project) return;
    if (!window.confirm(language === "zh" ? `从列表移除项目“${project}”？项目文件和会话记录不会被删除。` : `Remove project “${project}” from the list? Project files and session history will be kept.`)) return;
    try {
      await window.piHarness.removeProject(project);
      setProjects((current) => current.filter((item) => item.path !== project));
      switchProject(null);
    } catch (value) { showError(value); }
  }

  async function renameProject() {
    if (!projectRename || projectRenaming) return;
    const name = projectRename.value.trim();
    if (!name) { setProjectRenameError(language === "zh" ? "请输入项目名称。" : "Enter a project name."); return; }
    setProjectRenaming(true);
    try {
      await window.piHarness.renameProject(projectRename.path, name);
      setProjects((current) => current.map((item) => item.path === projectRename.path ? { ...item, name } : item));
      setProjectRename(null);
    } catch (value) { setProjectRenameError(value instanceof Error ? value.message : String(value)); }
    finally { setProjectRenaming(false); }
  }

  async function createSession() {
    const request = ++openRequestRef.current;
    try {
      const path = project ?? await window.piHarness.chooseProject();
      if (!path || request !== openRequestRef.current) return;
      if (!project) void window.piHarness.listProjects().then(setProjects).catch(showError);
      setProject(path);
      const id = `draft-${crypto.randomUUID()}`;
      const snapshot: SessionSnapshot = { draft: true, metadata: { id, piSessionId: "", projectDir: path, name: t.newSession, createdAt: "", updatedAt: "" }, state: { sessionId: "", isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0 }, messages: [], status: "Idle" };
      setModels([]);
      setVisibleGroups(30);
      setSelected(snapshot);
      setWorkspace(false);
      setShowContext(false);
      setError(null);
    } catch (value) { showError(value); }
  }

  async function openSession(id: string) {
    const request = ++openRequestRef.current;
    setVisibleGroups(30);
    setModels(modelCacheRef.current.get(id) ?? []);
    setWorkspace(false);
    setShowContext(false);
    setError(null);
    try {
      const cached = snapshotsRef.current.get(id);
      if (!cached) {
        const metadata = sessions.find((session) => session.id === id);
        if (metadata) setSelected({ metadata, preview: true, state: { sessionId: metadata.piSessionId, isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0 }, messages: [], status: metadata.status });
        void window.piHarness.previewSession(id).then((preview) => {
          if (preview && request === openRequestRef.current && !snapshotsRef.current.has(id)) {
            setSelected(preview);
            setItems((current) => ({ ...current, [id]: historyItems(preview.messages) }));
          }
        }).catch(() => {});
      }
      const snapshot = cached ?? await window.piHarness.openSession(id);
      const alreadyLoaded = snapshotsRef.current.has(id);
      snapshotsRef.current.set(id, { ...snapshot, messages: [] });
      // Keep completed loads even if the user has already switched away.
      if (!cached && !alreadyLoaded) setItems((current) => ({ ...current, [id]: historyItems(snapshot.messages) }));
      if (request !== openRequestRef.current) return;
      setSelected({ ...snapshot, messages: [] });
      setModelUsages((current) => ({ ...current, [id]: current[id] ?? lastModelUsage(snapshot.messages) }));
      setWorkspace(false);
      setProject(snapshot.metadata.projectDir);
    } catch (value) { if (request === openRequestRef.current) showError(value); }
  }

  async function deleteSession(id: string, name: string) {
    if (!window.confirm(language === "zh" ? `删除会话“${name}”？这会删除其 Pi 历史记录，并非仅停止任务。` : `Delete session “${name}”? This is separate from stopping a task and removes its Pi history.`)) return;
    try {
      await window.piHarness.deleteSession(id);
      snapshotsRef.current.delete(id);
      setItems((current) => { const next = { ...current }; delete next[id]; return next; });
      if (selected?.metadata.id === id) setSelected(null);
    } catch (value) { showError(value); }
  }

  async function renameSession() {
    if (!renameTarget || renaming) return;
    const name = renameValue.trim();
    if (!name || name.length > 120) { setRenameError(language === "zh" ? "请输入 1 到 120 个字符。" : "Enter between 1 and 120 characters."); return; }
    if (name === renameTarget.name) { setRenameTarget(null); return; }
    setRenaming(true); setRenameError(null);
    try {
      await window.piHarness.renameSession(renameTarget.id, name);
      snapshotsRef.current.delete(renameTarget.id);
      setSelected((current) => current?.metadata.id === renameTarget.id ? { ...current, metadata: { ...current.metadata, name } } : current);
      setRenameTarget(null);
    } catch (value) { setRenameError(value instanceof Error ? value.message : String(value)); }
    finally { setRenaming(false); }
  }

  async function addImages(files: File[]) {
    const targetSession = sessionId;
    try {
      if (images.length + files.length > 4) throw new Error(language === "zh" ? "最多添加 4 张图片。" : "Add up to 4 images.");
      const added = await Promise.all(files.map(async (file): Promise<ImageAttachment> => {
        if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024 || !file.size) throw new Error(language === "zh" ? "请选择不超过 10 MB 的 PNG、JPEG、GIF 或 WebP 图片。" : "Choose PNG, JPEG, GIF or WebP images up to 10 MB.");
        const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = () => reject(new Error("Could not read image")); reader.readAsDataURL(file); });
        return { type: "image", mimeType: file.type as ImageAttachment["mimeType"], data };
      }));
      updateComposer(targetSession, (current) => ({ ...current, images: [...current.images, ...added].slice(0, 4) }));
    } catch (value) { showError(value); }
  }

  async function addFiles(chosen: File[]) {
    const sessionId = selected?.metadata.id;
    try {
      if (files.length + chosen.length > 3) throw new Error(language === "zh" ? "最多添加 3 个文本文件。" : "Add up to 3 text files.");
      const added = await Promise.all(chosen.map(async (file): Promise<FileContext> => {
        if (!file.size || file.size > 200_000) throw new Error(language === "zh" ? "每个文件须不为空且不超过 200 KB。" : "Each file must be non-empty and at most 200 KB.");
        const bytes = await file.arrayBuffer();
        let content: string;
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error(language === "zh" ? "只支持 UTF-8 文本文件。" : "Only UTF-8 text files are supported."); }
        if (content.includes("\0")) throw new Error(language === "zh" ? "只支持 UTF-8 文本文件。" : "Only UTF-8 text files are supported.");
        return { name: file.name, content };
      }));
      updateComposer(sessionId, (current) => ({ ...current, files: [...current.files, ...added].slice(0, 3) }));
    } catch (value) { showError(value); }
  }

  async function send() {
    if (!selected || selected.preview || sendingRef.current.has(selected.metadata.id) || (!draft.trim() && !images.length && !files.length)) return;
    const text = draft.trim();
    const attached = images;
    const attachedFiles = files;
    const promptText = composeFileContext(text, attachedFiles);
    if (promptText.length > 2_000_000) { showError(language === "zh" ? "消息和文件内容过长，请减少内容后重试。" : "Message and file contents are too long."); return; }
    let targetId = selected.metadata.id;
    const originalId = targetId;
    const intent = sessionModes[targetId] ?? "write";
    sendingRef.current.add(targetId);
    setSendingIds([...sendingRef.current]);
    const key = `user-${Date.now()}-${Math.random()}`;
    updateComposer(targetId, () => ({ draft: "", images: [], files: [] }));
    followMessagesRef.current = true;
    setItems((current) => ({
      ...current,
      [selected.metadata.id]: [...(current[selected.metadata.id] ?? []), { key, kind: "user", text, images: attached, files: attachedFiles, delivery: "pending" }],
    }));
    try {
      if (selected.draft) {
        const snapshot = await window.piHarness.createSession(selected.metadata.projectDir);
        targetId = snapshot.metadata.id;
        sendingRef.current.add(targetId);
        setSendingIds([...sendingRef.current]);
        snapshotsRef.current.set(targetId, { ...snapshot, messages: [] });
        setItems((current) => { const next = { ...current, [targetId]: current[originalId] ?? [] }; delete next[originalId]; return next; });
        setComposers((current) => { const next = { ...current, [targetId]: current[originalId] ?? { draft: "", images: [], files: [] } }; delete next[originalId]; return next; });
        setSessionModes((current) => ({ ...current, [targetId]: intent }));
        setSelected((current) => current?.metadata.id === originalId ? { ...snapshot, messages: [] } : current);
      }
      await window.piHarness.prompt(targetId, promptText, intent, attached);
      setItems((current) => ({ ...current, [targetId]: (current[targetId] ?? []).map((item) => item.key === key ? { ...item, delivery: undefined } : item) }));
    } catch (value) {
      const cancelled = String(value).includes("Queued task cancelled");
      setItems((current) => ({ ...current, [targetId]: (current[targetId] ?? []).map((item) => item.key === key ? { ...item, delivery: cancelled ? "cancelled" : "failed", deliveryError: cancelled ? undefined : String(value) } : item) }));
    } finally {
      sendingRef.current.delete(originalId);
      sendingRef.current.delete(targetId);
      setSendingIds([...sendingRef.current]);
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

  const [modelChanging, setModelChanging] = useState(false);
  const [sessionModes, setSessionModes] = useState<Record<string, "analysis" | "write">>({});
  const [thinkingChanging, setThinkingChanging] = useState(false);
  const [thinkingSettings, setThinkingSettings] = useState<{ sessionId: string; model: string; level: ThinkingLevel; levels: ThinkingLevel[] } | null>(null);
  useEffect(() => {
    if (!sessionId || selected?.draft || selected?.preview) return;
    let active = true;
    if (!modelCacheRef.current.has(sessionId)) void window.piHarness.listModels(sessionId).then((value) => {
      modelCacheRef.current.set(sessionId, value);
      if (active) setModels(value);
    }).catch((reason) => { if (active) showError(reason); });
    setThinkingSettings(null);
    void window.piHarness.getThinkingSettings(sessionId).then((settings) => {
      if (active) setThinkingSettings({ sessionId, model: currentModel, ...settings });
    }).catch((reason) => { if (active) showError(reason); });
    return () => { active = false; };
  }, [sessionId, currentModel, selected?.draft, selected?.preview]);
  function updateSessionState(id: string, state: PiSessionState) {
    const cached = snapshotsRef.current.get(id);
    if (cached) snapshotsRef.current.set(id, { ...cached, state });
    setSelected((current) => current?.metadata.id === id ? { ...current, state } : current);
  }
  const activeThinking = thinkingSettings && thinkingSettings.sessionId === sessionId && thinkingSettings.model === currentModel ? thinkingSettings : null;
  const controlsBusy = Boolean(running) || modelChanging || thinkingChanging || sendingIds.includes(sessionId ?? "");

  return <main className="shell" style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
    <aside className="sidebar">
      <div className="brand"><span>π</span> PiDeck</div>
      <div className="project">
        <div className="project-heading"><small>{t.project}</small><div className="project-actions">
          <button onClick={() => void chooseProject()} title={language === "zh" ? "添加项目" : "Add project"} aria-label={language === "zh" ? "添加项目" : "Add project"}><Icon name="plus" /></button>
          <button onClick={() => { const item = projects.find((entry) => entry.path === project); if (item) { setProjectRename({ path: item.path, value: item.name }); setProjectRenameError(null); } }} disabled={!project} title={language === "zh" ? "编辑项目名称" : "Edit project name"} aria-label={language === "zh" ? "编辑项目名称" : "Edit project name"}><Icon name="edit" /></button>
          <button onClick={() => void removeProject()} disabled={!project} title={language === "zh" ? "移除项目" : "Remove project"} aria-label={language === "zh" ? "移除项目" : "Remove project"}>−</button>
        </div></div>
          <select aria-label={t.chooseProject} title={project ?? t.chooseProject} value={project ?? ""} onChange={(event) => switchProject(event.target.value || null)}>
            {!project && <option value="">{t.chooseProject}</option>}
            {projects.map((item) => <option key={item.path} value={item.path}>{item.name} — {item.path}</option>)}
          </select>
      </div>
      <button className="new-session" onClick={() => void createSession()}><Icon name="edit" />{t.newSession}<Icon name="plus" /></button>
      <label className="session-search"><Icon name="search" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t.search} aria-label={t.search} /></label>
      <div className="session-heading"><span>{t.sessions}</span><span>{sessions.filter((entry) => entry.projectDir === project).length}</span></div>
      <nav className="sessions">
        {sessions.filter((session) => (project && session.projectDir === project) && session.name.toLowerCase().includes(search.toLowerCase())).map((session) =>
          <div key={session.id} className={!workspace && selected?.metadata.id === session.id ? "session active" : "session"}>
            <button className="session-open" onClick={() => void openSession(session.id)}><span className={`dot ${session.status.toLowerCase()}`} />
              <span className="session-copy"><strong>{session.name}</strong><small>{statusText(session.status)}</small></span></button>
            <button className="session-action" title={t.rename} aria-label={t.rename} onClick={() => { setRenameTarget({ id: session.id, name: session.name }); setRenameValue(session.name); setRenameError(null); }}><Icon name="edit" /></button>
            <button className="session-action session-delete" title={t.delete} aria-label={t.delete} onClick={() => void deleteSession(session.id, session.name)}><Icon name="close" /></button>
          </div>)}
      </nav>
      <button className={workspace ? "workspace-link active" : "workspace-link"} onClick={() => setWorkspace(true)}><Icon name="workspace" /><span>{t.workspace}</span><Icon name="chevron" /></button>
      <button className="workspace-link login-link" onClick={() => setShowLogin(true)}><Icon name="user" /><span>{language === "zh" ? "登录" : "Sign in"}</span></button>
      <label className="language-control"><span>{t.language}</span><select aria-label={t.language} value={language} onChange={(event) => setLanguage(event.target.value as Language)}><option value="zh">中文</option><option value="en">English</option></select></label>
      <div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label={language === "zh" ? "调整侧边栏宽度" : "Resize sidebar"} aria-valuemin={200} aria-valuemax={480} aria-valuenow={sidebarWidth} tabIndex={0}
        onPointerDown={(event) => { if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setSidebarWidth(Math.max(200, Math.min(480, event.clientX))); }}
        onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setSidebarWidth((width) => Math.max(200, Math.min(480, width + (event.key === "ArrowLeft" ? -10 : 10)))); } }} />
    </aside>
    {contextDialog && selected && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeContextManager(); }}><div className="modal context-manager" role="dialog" aria-modal="true" aria-label={language === "zh" ? "管理上下文" : "Manage context"}>
      <h2>{language === "zh" ? "管理上下文" : "Manage context"}</h2><p>{language === "zh" ? "可排除整轮提问、回复及工具记录，也可单独调整用户消息和纯文本助手回复。原始聊天记录和已产生的结果保持不变。" : "Adjust user messages and plain-text assistant responses, or exclude a whole turn. Original chat history and previous changes remain unchanged."}</p>
      {running && <p>{language === "zh" ? "会话运行中，完成后才能修改。" : "Changes are available when the session is idle."}</p>}
      {contextError && <p className="workspace-warning" role="alert">{contextError}</p>}
      <div className="context-items">{!contextItems ? <p>{language === "zh" ? "正在读取…" : "Loading…"}</p> : !contextItems.length ? <p>{language === "zh" ? "当前没有用户消息。" : "No user messages yet."}</p> : <>{contextItems.length > contextVisibleCount && <button className="context-load-more" onClick={() => setContextVisibleCount((count) => count + 25)}>{language === "zh" ? `加载更早消息（剩余 ${contextItems.length - contextVisibleCount} 条）` : `Load earlier messages (${contextItems.length - contextVisibleCount} remaining)`}</button>}{contextItems.slice(-contextVisibleCount).map((item) => <div className="context-item" key={item.id}>
        <div className="context-item-head"><strong>{item.role === "assistant" ? (language === "zh" ? "助手回复" : "Assistant response") : (language === "zh" ? "用户消息" : "User message")}</strong><span>{item.reason === "compacted" ? (language === "zh" ? "已压缩，暂不可调整" : "Compacted, unavailable") : item.reason === "attachment" ? (language === "zh" ? "包含附件，暂不可调整" : "Contains attachments, unavailable") : item.reason === "complex" ? (language === "zh" ? "包含思考或工具调用，暂不可调整" : "Contains reasoning or tool calls, unavailable") : item.roundExcluded ? (language === "zh" ? "整轮已排除" : "Round excluded") : item.excluded ? (language === "zh" ? "不发送给模型" : "Excluded") : item.text !== item.original ? (language === "zh" ? "已修改" : "Modified") : (language === "zh" ? "发送给模型" : "Included")}</span></div>
        {contextEdit?.id === item.id ? <><textarea value={contextEdit.text} maxLength={100000} onChange={(event) => setContextEdit({ id: item.id, text: event.target.value })} /><div className="context-item-actions"><button disabled={contextBusy} onClick={() => setContextEdit(null)}>{t.cancel}</button><button disabled={contextBusy || !contextEdit.text.trim() || Boolean(running)} onClick={() => void updateContext(item.id, { excluded: item.excluded, text: contextEdit.text })}>{language === "zh" ? "保存" : "Save"}</button></div></> : <><pre>{expandedContext === item.id || item.text.length <= 600 ? item.text : `${item.text.slice(0, 600)}…`}</pre>{item.text.length > 600 && <button className="context-show-more" onClick={() => setExpandedContext((current) => current === item.id ? null : item.id)}>{expandedContext === item.id ? (language === "zh" ? "收起" : "Show less") : (language === "zh" ? "查看全文" : "Show full text")}</button>}<div className="context-item-actions">{item.role === "user" && <button disabled={!item.roundAvailable || contextBusy || Boolean(running)} onClick={() => void setContextRound(item)}>{item.roundExcluded ? (language === "zh" ? "恢复这一轮" : "Restore round") : (language === "zh" ? "排除这一轮" : "Exclude round")}</button>}<button disabled={!item.editable || item.roundExcluded || contextBusy || Boolean(running)} onClick={() => void updateContext(item.id, { excluded: !item.excluded, ...(item.text !== item.original ? { text: item.text } : {}) })}>{item.excluded ? (language === "zh" ? "重新包含" : "Include") : (language === "zh" ? "排除" : "Exclude")}</button><button disabled={!item.editable || item.roundExcluded || contextBusy || Boolean(running)} onClick={() => setContextEdit({ id: item.id, text: item.text })}>{language === "zh" ? "修改" : "Edit"}</button>{(item.excluded || item.text !== item.original) && <button disabled={!item.editable || item.roundExcluded || contextBusy || Boolean(running)} onClick={() => void updateContext(item.id, null)}>{language === "zh" ? "恢复原文" : "Restore original"}</button>}</div></>}
      </div>)}</>}</div><div className="modal-actions"><button onClick={closeContextManager}>{language === "zh" ? "完成" : "Done"}</button></div>
    </div></div>}
    <section className="chat">
      {workspace ? <div className="workspace-page"><h1>{t.workspace}</h1><p>{t.workspaceDescription}</p><div className="workspace-tabs">{(["connections", "skills", "knowledge", "instructions", "extensions"] as const).map((tab) => <button key={tab} className={workspaceTab === tab ? "workspace-tab active" : "workspace-tab"} onClick={() => setWorkspaceTab(tab)}>{tab === "extensions" ? (language === "zh" ? "扩展" : "Extensions") : t[tab]}</button>)}</div>
        {workspaceTab === "connections" ? <div className="workspace-empty"><h2>{language === "zh" ? "设备连接" : "Device connections"}</h2><p>{language === "zh" ? "在对话中连接 SSH 设备，查看状态及 Agent 与设备的输入输出。" : "Connect SSH devices inside conversations and inspect their status and activity."}</p>{sessions.filter((session) => devices[session.id]).map((session) => <div className="workspace-row" key={session.id}><strong>{session.name}</strong><DevicePanel id={session.id} state={devices[session.id]} zh={language === "zh"} agentBusy={["Running", "Queued", "WaitingForUser", "Stopping"].includes(session.status)} /></div>)}{!sessions.some((session) => devices[session.id]) && <p>{language === "zh" ? "尚未连接设备。打开一个对话，点击顶部的「连接设备」开始。" : "No devices yet. Open a conversation and select Connect device."}</p>}</div> : workspaceTab === "extensions" ? <div className="workspace-empty extensions-panel">
          <div className="extensions-heading"><h2>{language === "zh" ? "扩展" : "Extensions"}</h2><div><button disabled={extensionBusy} onClick={() => setShowNetworkInstall((open) => !open)}>{language === "zh" ? "网络添加" : "Add from network"}</button><button disabled={extensionBusy} onClick={() => void changeExtensions(() => window.piHarness.addExtension("file"))}>{language === "zh" ? "添加文件" : "Add file"}</button><button disabled={extensionBusy} onClick={() => void changeExtensions(() => window.piHarness.addExtension("directory"))}>{language === "zh" ? "添加文件夹" : "Add folder"}</button></div></div>
          <p>{language === "zh" ? "扩展会运行代码，请仅添加可信来源。此处管理通过本应用添加的本地扩展，原文件保留在原位置。新会话使用最新设置；已打开的会话需重启应用后生效。" : "Extensions run code; add only sources you trust. Manage local extensions added here; source files stay in place. New sessions use the latest settings; restart the app to apply changes to open sessions."}</p>
          {showNetworkInstall && <form className="network-extension" onSubmit={(event) => { event.preventDefault(); const source = networkSource.trim(); if (!source) return; void changeExtensions(async () => { const result = await window.piHarness.addNetworkExtension(source); setNetworkSource(""); setShowNetworkInstall(false); return result; }); }}>
            <label htmlFor="extension-source">{language === "zh" ? "npm 包或 Git 仓库地址" : "npm package or Git repository"}</label>
            <div><input id="extension-source" value={networkSource} onChange={(event) => setNetworkSource(event.target.value)} placeholder="npm:package@1.0.0 / git:github.com/user/repo" disabled={extensionBusy} /><button disabled={extensionBusy || !networkSource.trim()} type="submit">{extensionBusy ? (language === "zh" ? "安装中…" : "Installing…") : (language === "zh" ? "安装" : "Install")}</button></div>
            <small>{language === "zh" ? "安装可能运行包的安装脚本；扩展会在新会话中运行代码。请先检查来源。" : "Installation may run package scripts; extensions run code in new sessions. Review the source first."}</small>
          </form>}
          {extensionError && <p className="workspace-warning" role="alert">{extensionError}</p>}
          {!extensions.length && <p>{language === "zh" ? "还没有添加扩展。" : "No extensions added yet."}</p>}
          {extensions.map((item) => <div className="workspace-row extension-row" key={item.path}><div><strong>{item.name}</strong><small title={item.path}>{item.path}</small><small>{item.enabled ? (language === "zh" ? "已启用" : "Enabled") : (language === "zh" ? "已停用" : "Disabled")}</small></div><div className="extension-actions"><button disabled={extensionBusy} onClick={() => void changeExtensions(() => window.piHarness.setExtensionEnabled(item.path, !item.enabled))}>{item.enabled ? (language === "zh" ? "停用" : "Disable") : (language === "zh" ? "启用" : "Enable")}</button><button disabled={extensionBusy} onClick={() => { if (window.confirm(language === "zh" ? `移除扩展“${item.name}”？${item.managedRoot ? "应用下载的文件将被删除。" : "原文件不会被删除。"}` : `Remove “${item.name}”? ${item.managedRoot ? "The downloaded files will be deleted." : "Source files will not be deleted."}`)) void changeExtensions(() => window.piHarness.removeExtension(item.path)); }}>{language === "zh" ? "移除" : "Remove"}</button></div></div>)}
        </div> : !selected ? <div className="workspace-empty">{language === "zh" ? "请先打开一个会话以查看工作台。" : "Open a session to inspect its workspace."}</div> : discoveryError ? <div className="workspace-empty">{discoveryError}</div> : !discovery ? <div className="workspace-empty">{language === "zh" ? "正在读取…" : "Loading…"}</div> : <div className="workspace-empty">

          {workspaceTab === "skills" && <><h2>{t.skills}</h2><p>{language === "zh" ? "来自当前会话的技能命令；来源路径未由运行时提供。" : "Skill commands reported by this session; source paths are not provided by the runtime."}</p>{discovery.skillError ? <p>{discovery.skillError}</p> : discovery.skills?.length ? discovery.skills.map((item, i) => <div className="workspace-row" key={`${item.name}-${i}`}><strong>{item.name}</strong>{item.description && <small>{item.description}</small>}</div>) : <p>{language === "zh" ? "当前会话没有报告技能命令。" : "No skill commands reported by this session."}</p>}</>}
          {workspaceTab === "instructions" && <><h2>{t.instructions}</h2><p>{language === "zh" ? "发现的指令文件；是否已加载取决于运行时状态。" : "Discovered instruction files; actual loading depends on runtime state."}</p>{discovery.instructions.length ? discovery.instructions.map((item) => <div className="workspace-row" key={item.path}><strong>{item.name}</strong><small>{item.path}</small></div>) : <p>{language === "zh" ? "没有发现指令文件。" : "No instruction files found."}</p>}</>}
          {workspaceTab === "knowledge" && <><h2>{t.knowledge}</h2><p>{language === "zh" ? "知识库尚未接入。" : "Knowledge management is not available yet."}</p></>}
          {discovery.warnings.map((warning, i) => <p className="workspace-warning" key={i}>{warning.path}: {warning.message}</p>)}
        </div>}</div> : selected ? <>
        <header className="chat-header">
          <div className="chat-title"><div className="chat-breadcrumb"><span>{projects.find((entry) => entry.path === selected.metadata.projectDir)?.name ?? "PiDeck"}</span><Icon name="chevron" /><span>{t.sessions}</span></div><h1>{selected.metadata.name}</h1></div>
          <div className="status-stack"><span className={`status ${selectedSummary?.status.toLowerCase()}`}>{statusText(selectedSummary?.status ?? "Idle")}</span>
            {Object.values(extensionStatus[selected.metadata.id] ?? {}).filter(Boolean).map((text, index) => <small key={index}>{text}</small>)}
          </div>
        </header>
        {!selected.draft && <DevicePanel drawer key={selected.metadata.id} id={selected.metadata.id} state={devices[selected.metadata.id]} zh={language === "zh"} agentBusy={Boolean(running)} />}
        <div className="messages" ref={messagesRef} onScroll={(event) => { const element = event.currentTarget; followMessagesRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; }}>
          {!currentItems?.length && <div className="empty"><span>π</span><h2>{selected.preview ? (language === "zh" ? "正在加载会话…" : "Loading conversation…") : t.start}</h2><p>{selected.draft ? (language === "zh" ? "发送第一条消息后才会保存会话。" : "This conversation is saved when you send your first message.") : t.empty}</p></div>}
          {messageGroups.length > visibleGroups && <button onClick={() => { followMessagesRef.current = false; setVisibleGroups((count) => count + 30); }}>{language === "zh" ? "加载更早消息" : "Load earlier messages"}</button>}
          {messageGroups.slice(-visibleGroups).map((group) => group.kind === "single" ? group.items.map((item) => <article key={item.key} className={`message ${item.kind}`}>{item.kind === "notice" && <div className="label">{t.notice}</div>}{item.images?.length ? <div className="message-images">{item.images.map((image, index) => <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={language === "zh" ? "附加图片" : "Attached image"} />)}</div> : null}{item.files?.map((file, index) => <details className="file-attachment" key={`${file.name}-${index}`}><summary>📄 {file.name}</summary><pre>{file.content}</pre></details>)}<MarkdownMessage text={item.kind === "notice" && item.text === "Pi is retrying the request…" ? t.retry : item.text} />{item.delivery && <div className="delivery-status" role="status">{item.delivery === "pending" ? (selectedSummary?.status === "Queued" ? (language === "zh" ? "排队中，尚未发送" : "Queued, not sent yet") : (language === "zh" ? "正在发送…" : "Sending…")) : <>{item.delivery === "cancelled" ? (language === "zh" ? "已取消，未发送" : "Cancelled, not sent") : (language === "zh" ? "发送失败" : "Send failed")}{item.deliveryError && <span> · {item.deliveryError}</span>} <button onClick={() => { if ((draft || images.length || files.length) && !window.confirm(language === "zh" ? "恢复此消息会替换当前草稿，继续吗？" : "Restore this message and replace the current draft?")) return; updateComposer(selected.metadata.id, () => ({ draft: item.text, images: item.images ?? [], files: item.files ?? [] })); setItems((current) => ({ ...current, [selected.metadata.id]: (current[selected.metadata.id] ?? []).filter((entry) => entry.key !== item.key) })); }}>{language === "zh" ? "恢复到输入框" : "Restore to composer"}</button></>}</div>}</article>) : <article key={group.key} className="message assistant">
            {groupTimeline(group.items).map((segment) => segment[0]?.kind === "assistant" ? <MarkdownMessage key={segment[0].key} text={segment[0].text} /> : <WorkLog key={segment[0]?.key} segment={segment} language={language} />)}

          </article>)}
          <div ref={endRef} />
        </div>
        <footer className="composer">
          {selectedSummary?.status === "Queued" && <div className="queue-hint" role="status">{sessions.some((entry) => entry.id !== selected.metadata.id && entry.projectDir === selected.metadata.projectDir && ["Running", "WaitingForUser", "Stopping"].includes(entry.status)) ? (language === "zh" ? "同一项目有任务正在执行；完成后将自动开始。" : "Another task in this project is active; this will start when it finishes.") : (language === "zh" ? "正在等待可用的执行名额，满足条件后将自动开始。" : "Waiting for an available execution slot; this will start automatically.")} {language === "zh" ? "点击停止可取消排队。" : "Use Stop to cancel."}</div>}
          {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
          {files.length > 0 && <div className="pending-files">{files.map((file, index) => <div key={`${file.name}-${index}`}><details><summary>📄 {file.name}</summary><pre>{file.content}</pre></details><button type="button" disabled={Boolean(running)} aria-label={language === "zh" ? `移除 ${file.name}` : `Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}><Icon name="close" /></button></div>)}</div>}
          {images.length > 0 && <div className="image-previews">{images.map((image, index) => <div key={index}><img src={`data:${image.mimeType};base64,${image.data}`} alt={language === "zh" ? "图片预览" : "Image preview"} /><button type="button" aria-label={language === "zh" ? "移除图片" : "Remove image"} onClick={() => setImages((current) => current.filter((_, i) => i !== index))}><Icon name="close" /></button></div>)}</div>}
          <div className="composer-box">
          <textarea onPaste={(event) => { const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/")); if (files.length) { event.preventDefault(); void addImages(files); } }} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={controlsBusy} placeholder={running ? t.working : t.message} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!controlsBusy && !selected.preview) void send(); }
          }} />
          <div className="composer-tools"><div className="composer-controls">
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <button type="button" className="image-attach" disabled={Boolean(running)} aria-label={language === "zh" ? "添加文本文件" : "Add text files"} title={language === "zh" ? "添加文本文件" : "Add text files"} onClick={() => fileInputRef.current?.click()}><Icon name="attach" /></button>
          <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => { void addImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <button type="button" className="image-attach" disabled={Boolean(running)} aria-label={language === "zh" ? "添加图片" : "Add images"} title={language === "zh" ? "添加图片" : "Add images"} onClick={() => imageInputRef.current?.click()}><Icon name="image" /></button>
<select className="model-select" value={currentModel} aria-label={language === "zh" ? "选择模型" : "Model"} disabled={controlsBusy || selected.draft || selected.preview} onChange={(event) => {
            const option = models.find((model) => `${model.provider}/${model.id}` === event.target.value);
            if (!option) return;
            setModelChanging(true);
            void window.piHarness.setModel(selected.metadata.id, option.provider, option.id).then(async () => {
              const snapshot = await window.piHarness.openSession(selected.metadata.id);
              snapshotsRef.current.set(snapshot.metadata.id, { ...snapshot, messages: [] });
              setSelected((current) => current?.metadata.id === snapshot.metadata.id ? snapshot : current);
            }).catch(showError).finally(() => setModelChanging(false));
          }}><option value={currentModel}>{selected.state.model?.name ?? selected.state.model?.id ?? t.noModel}</option>{models.filter((model) => `${model.provider}/${model.id}` !== currentModel).map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name ?? `${model.provider}/${model.id}`}</option>)}</select><label className="thinking-control"><Icon name="brain" /><span>Think</span><select aria-label="Think level" value={activeThinking?.level ?? ""} disabled={controlsBusy || !activeThinking || activeThinking.levels.length < 2} title={!activeThinking ? (language === "zh" ? "正在读取模型支持的思考级别" : "Loading thinking levels") : activeThinking.levels.length < 2 ? (language === "zh" ? "此模型不支持调整思考级别" : "This model does not support adjustable thinking") : "Think level"} onChange={(event) => {
            const id = selected.metadata.id;
            const level = event.target.value as ThinkingLevel;
            setThinkingChanging(true);
            void window.piHarness.setThinkingLevel(id, level).then((state) => {
              updateSessionState(id, state);
              setThinkingSettings((current) => current?.sessionId === id ? { ...current, level: state.thinkingLevel ?? level } : current);
            }).catch(showError).finally(() => setThinkingChanging(false));
          }}>{!activeThinking && <option value="">…</option>}{activeThinking?.levels.map((level) => <option key={level} value={level}>{level === "xhigh" ? "XHigh" : level[0]!.toUpperCase() + level.slice(1)}</option>)}</select></label><select className="mode-select" aria-label={t.mode} title={t.intentTitle} disabled={controlsBusy} value={sessionModes[selected.metadata.id] ?? "write"} onChange={(event) => setSessionModes((current) => ({ ...current, [selected.metadata.id]: event.target.value as "analysis" | "write" }))}><option value="analysis">{t.analyze}</option><option value="write">{t.write}</option></select></div>
          <button className={running ? "stop" : "send"} aria-label={running ? t.stop : t.send} disabled={!running && (controlsBusy || selected.preview || (!draft.trim() && !images.length && !files.length))} onClick={() => running ? void window.piHarness.abort(selected.metadata.id) : void send()}>{running ? t.stop : <Icon name="up" />}</button>
          </div></div>

          <div className="context-wrap" ref={contextRef}><button className="context-toggle" disabled={selected.draft || selected.preview} onClick={() => setShowContext(!showContext)} aria-expanded={showContext}><Icon name="layers" />{t.context} {showContext ? "⌄" : "⌃"}</button>{showContext && <div className="context-popover"><strong>{t.currentSession}</strong>
            <div><span>{language === "zh" ? "上下文用量" : "Context usage"}</span><small>{contextLoading ? (language === "zh" ? "读取中…" : "Loading…") : contextUsage?.percent != null ? `${contextUsage.percent.toFixed(1)}%` : (language === "zh" ? "暂不可用" : "Unavailable")}</small></div>
            {contextUsage?.percent != null && <><progress max={100} value={Math.min(contextUsage.percent, 100)} aria-label={language === "zh" ? "上下文用量" : "Context usage"} /><p>{contextUsage.tokens?.toLocaleString()} / {contextUsage.contextWindow.toLocaleString()} tokens</p></>}
            <div><span>{language === "zh" ? "上次模型请求" : "Last model request"}</span><small>{modelUsages[selected.metadata.id] ? (language === "zh" ? "服务商返回" : "Provider reported") : (language === "zh" ? "暂无数据" : "Unavailable")}</small></div>
            {modelUsages[selected.metadata.id] && <p>{language === "zh" ? "输入" : "Input"} {(modelUsages[selected.metadata.id]!.input + modelUsages[selected.metadata.id]!.cacheRead + modelUsages[selected.metadata.id]!.cacheWrite).toLocaleString()} · {language === "zh" ? "输出" : "Output"} {modelUsages[selected.metadata.id]!.output.toLocaleString()} tokens{(modelUsages[selected.metadata.id]!.cacheRead || modelUsages[selected.metadata.id]!.cacheWrite) ? (language === "zh" ? "（输入含缓存）" : " (input includes cache)") : ""}</p>}
            <div><span>{t.project}</span><small title={selected.metadata.projectDir}>{selected.metadata.projectDir}</small></div>
            <div><span>{language === "zh" ? "模型" : "Model"}</span><small title={currentModel}>{currentModel || t.noModel}</small></div>
            <div><span>{language === "zh" ? "待发送附件" : "Pending attachments"}</span><small>{images.length || files.length ? (language === "zh" ? `${images.length} 张图片 · ${files.length} 个文件` : `${images.length} image(s) · ${files.length} file(s)`) : (language === "zh" ? "无" : "None")}</small></div>
            <p>{language === "zh" ? "文件作为消息内容发送，发送前可移除。" : "Files are sent as message content and can be removed before sending."}</p><button className="context-manage-button" onClick={() => void openContextManager()}>{language === "zh" ? "管理上下文" : "Manage context"}</button>
          </div>}<span className="composer-hint">{language === "zh" ? "Enter 发送 · Shift + Enter 换行" : "Enter to send · Shift + Enter for a new line"}</span></div>
        </footer>
      </> : <div className="welcome"><span>π</span><h1>PiDeck</h1><p>{t.welcome}</p><button onClick={() => void createSession()}>{t.openProject}</button></div>}
    </section>
    {showLogin && <div className="modal-backdrop login-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowLogin(false); }}><div className="modal login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title" onKeyDown={(event) => { if (event.key === "Escape") setShowLogin(false); }}>
      <button className="login-close" autoFocus onClick={() => setShowLogin(false)} aria-label={language === "zh" ? "关闭" : "Close"}><Icon name="close" /></button>
      <div className="login-mark">π</div><h2 id="login-title">{language === "zh" ? "连接模型服务" : "Connect a model provider"}</h2>
      <p>{language === "zh" ? "选择服务商，在终端完成授权后即可在会话中选择模型。" : "Connect a provider in your terminal, then select its model in a session."}</p>
      <div className="provider-list">
        {(["openai-codex", "deepseek", "other"] as const).map((provider) => <div key={provider}>
          <strong>{provider === "openai-codex" ? "OpenAI Codex" : provider === "deepseek" ? "DeepSeek" : (language === "zh" ? "其他服务商" : "Other providers")}</strong>
          {provider !== "other" && <small className="provider-status">{storedProviders === null ? (language === "zh" ? "状态未知" : "Status unknown") : storedProviders.includes(provider) ? (language === "zh" ? "已保存凭据 · 未验证" : "Credential saved · not verified") : (language === "zh" ? "无已保存凭据" : "No saved credential")}</small>}
          <small>{provider === "openai-codex" ? (language === "zh" ? "ChatGPT 账户" : "ChatGPT account") : provider === "deepseek" ? (language === "zh" ? "API 密钥" : "API key") : (language === "zh" ? "从 Pi 支持的服务商中选择" : "Choose from providers supported by Pi")}</small>
          <div className="provider-actions">{(["login", "logout"] as const).map((action) => <button key={action} onClick={() => { setAuthError(null); setAuthAction({ action, provider }); void window.piHarness.openAuthTerminal().catch((error: unknown) => setAuthError(String(error))); }}>{action === "login" ? (language === "zh" ? "登录" : "Connect") : (language === "zh" ? "断开连接" : "Disconnect")}</button>)}</div>
          {authAction?.provider === provider && <small>{language === "zh" ? "在打开的终端中输入：" : "In the terminal, enter:"} <code>/{authAction.action}{provider === "other" ? "" : ` ${provider}`}</code></small>}
        </div>)}
      </div>
      {storedProviders && storedProviders.filter((provider) => !["openai-codex", "deepseek"].includes(provider)).length > 0 && <p className="login-note">{language === "zh" ? "其他已保存凭据：" : "Other saved credentials: "}{storedProviders.filter((provider) => !["openai-codex", "deepseek"].includes(provider)).join(", ")}</p>}
      <button className="auth-refresh" onClick={refreshAuth}>{language === "zh" ? "刷新状态" : "Refresh status"}</button>
      {authError && <p className="login-note" role="alert">{authError}</p>}
      <p className="login-note">{language === "zh" ? "状态仅显示 Pi 保存的凭据，不包含环境变量，也不代表已验证。操作将在终端完成。断开连接只移除 Pi 保存的凭据，不撤销服务商授权或清除环境变量。变更后请新建会话或重启应用。" : "Status shows stored credentials only, excludes environment variables, and is not verified. Complete the action in the terminal. Disconnect removes Pi's stored credentials; it does not revoke provider access or clear environment variables. Start a new session or restart the app afterwards."}</p>
    </div></div>}
    {uiRequest && <ExtensionDialog event={uiRequest} language={language} onAnswer={(value) => void answerUi(value)} />}
    {projectRename && <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" aria-labelledby="project-rename-title" onSubmit={(event) => { event.preventDefault(); void renameProject(); }} onKeyDown={(event) => { if (event.key === "Escape" && !projectRenaming) setProjectRename(null); }}>
      <h2 id="project-rename-title">{language === "zh" ? "编辑项目名称" : "Edit project name"}</h2><p>{projectRename.path}</p>
      <input autoFocus aria-label={language === "zh" ? "项目名称" : "Project name"} value={projectRename.value} maxLength={120} disabled={projectRenaming} onChange={(event) => { setProjectRename({ ...projectRename, value: event.target.value }); setProjectRenameError(null); }} />
      {projectRenameError && <p role="alert">{projectRenameError}</p>}
      <div className="modal-actions"><button type="button" disabled={projectRenaming} onClick={() => setProjectRename(null)}>{t.cancel}</button><button type="submit" className="primary" disabled={projectRenaming}>{language === "zh" ? "保存" : "Save"}</button></div>
    </form></div>}
    {renameTarget && <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" aria-labelledby="rename-title" onSubmit={(event) => { event.preventDefault(); void renameSession(); }} onKeyDown={(event) => { if (event.key === "Escape" && !renaming) setRenameTarget(null); }}>
      <h2 id="rename-title">{t.rename}</h2><input autoFocus aria-label={t.rename} value={renameValue} maxLength={120} disabled={renaming} onChange={(event) => { setRenameValue(event.target.value); setRenameError(null); }} />
      {renameError && <p role="alert">{renameError}</p>}
      <div className="modal-actions"><button type="button" disabled={renaming} onClick={() => setRenameTarget(null)}>{t.cancel}</button><button type="submit" className="primary" disabled={renaming}>{language === "zh" ? "保存" : "Save"}</button></div>
    </form></div>}
  </main>;
}

function ExtensionDialog({ event, language, onAnswer }: { event: RuntimeEvent; language: Language; onAnswer: (value: string | boolean | null) => void }) {
  const t = translations[language];
  const record = event.record;
  const method = String(record.method);
  const [value, setValue] = useState(String(record.prefill ?? ""));
  return <div className="modal-backdrop"><div className="modal">
    <small>PI EXTENSION · {method.toUpperCase()}</small><h2>{String(record.title ?? t.inputNeeded)}</h2>
    {record.message ? <p>{String(record.message)}</p> : null}
    {method === "select" ? <div className="options">{Array.isArray(record.options) && record.options.map((option) => <button key={String(option)} onClick={() => onAnswer(String(option))}>{String(option)}</button>)}</div> : null}
    {method === "input" ? <input autoFocus value={value} placeholder={String(record.placeholder ?? "")} onChange={(e) => setValue(e.target.value)} /> : null}
    {method === "editor" ? <textarea autoFocus value={value} onChange={(e) => setValue(e.target.value)} /> : null}
    <div className="modal-actions"><button onClick={() => onAnswer(null)}>{t.cancel}</button>
      {method === "confirm" ? <><button onClick={() => onAnswer(false)}>{t.no}</button><button className="primary" onClick={() => onAnswer(true)}>{t.yes}</button></> : null}
      {(method === "input" || method === "editor") && <button className="primary" onClick={() => onAnswer(value)}>{t.submit}</button>}
    </div>
  </div></div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
