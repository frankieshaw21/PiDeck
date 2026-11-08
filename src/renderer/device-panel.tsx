import React, { useEffect, useRef, useState } from "react";
import type { DeviceState } from "../desktop/devices.js";
import type { DeviceProfile } from "../desktop/device-profiles.js";
import { deviceOutput } from "./device-output.js";
import { Icon } from "./icon.js";

export const DevicePanel = React.memo(function DevicePanel({ id, state, zh, agentBusy, drawer = false }: { id: string; state?: DeviceState | undefined; zh: boolean; agentBusy: boolean; drawer?: boolean }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [attached, setAttached] = useState<Awaited<ReturnType<typeof window.piHarness.listConversationDevices>>>([]);
  async function refreshAttached() { setAttached(await window.piHarness.listConversationDevices(id)); }
  useEffect(() => { void window.piHarness.listConversationDevices(id).then(setAttached).catch(() => {}); }, [id, state?.connectionId, state?.status]);
  useEffect(() => {
    if (!open || !drawer) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open, drawer]);
  const [host, setHost] = useState(state?.host ?? "");
  const [profiles, setProfiles] = useState<DeviceProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [protocol, setProtocol] = useState<"ssh" | "telnet">(state?.protocol ?? "ssh");
  const [port, setPort] = useState(state?.port ?? 22);
  const [username, setUsername] = useState(state?.username ?? "admin");
  const [name] = useState(() => localStorage.getItem(`device-name:${id}`) ?? "");
  const [password, setPassword] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const output = useRef<HTMLPreElement>(null);
  async function refreshProfiles() { setProfiles(await window.piHarness.listDeviceProfiles(id)); }
  useEffect(() => { let mounted = true; void window.piHarness.listDeviceProfiles(id).then((value) => { if (mounted) setProfiles(value); }).catch((e) => { if (mounted) setError(String(e)); }); return () => { mounted = false; }; }, [id]);
  useEffect(() => { if (output.current) output.current.scrollTop = output.current.scrollHeight; }, [state]);
  const connected = state?.status === "connected";
  const connecting = submitting || state?.status === "connecting";
  async function connect() {
    setSubmitting(true); setError("");
    const secret = password; setPassword("");
    try {
      const config = { protocol, host: host.trim(), port, username: username.trim(), password: secret, name: profileName.trim() || name.trim() || host.trim() };
      if (adding) { await window.piHarness.addConversationDevice(id, config); setAdding(false); await refreshAttached(); }
      else await window.piHarness.connectDevice(id, config);
    }
    catch (e) { setError(String(e)); }
    finally { setSubmitting(false); }
  }
  return <section className={`device-panel${drawer ? " device-drawer-mode" : ""}`}>
    <div className="device-heading">{drawer && <span className="device-project"><Icon name="folder" />{zh ? "当前项目" : "Current project"}</span>}<button type="button" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="terminal" />{state?.name || name || (state ? `${state.username}@${state.host}:${state.port}` : (zh ? "连接设备" : "Connect device"))}</button><span className={connected ? "device-connected" : ""}>{connecting ? (zh ? "连接中…" : "Connecting…") : connected ? (state?.busy ? (zh ? "执行中" : "Executing") : (zh ? "已连接" : "Connected")) : (zh ? "未连接" : "Disconnected")}</span></div>
    {open && <div className={drawer ? "device-drawer" : "device-body"} role={drawer ? "complementary" : undefined} aria-label={zh ? "会话设备" : "Session device"}>
      {drawer && <div className="device-drawer-heading"><strong>{zh ? "会话设备" : "Session device"}</strong><button autoFocus onClick={() => setOpen(false)} aria-label={zh ? "关闭设备面板" : "Close device panel"}><Icon name="close" /></button></div>}
      {(!connected || adding) && <form className="device-connect" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
        <p>{protocol === "telnet" ? (zh ? "Telnet 明文传输，包括登录信息；仅在可信网络中使用。" : "Telnet sends login details and commands in plaintext; use a trusted network.") : (zh ? "命令将原样发送到 SSH 连接。登录密码仅用于本次连接。" : "Commands are sent directly over SSH. The password is used only for this connection.")}</p>
        <label>{zh ? "连接方式" : "Protocol"}<select value={protocol} disabled={connecting} onChange={(event) => { const next = event.target.value as "ssh" | "telnet"; setProtocol(next); setPort(next === "ssh" ? 22 : 23); setProfileId(""); }}><option value="ssh">SSH</option><option value="telnet">Telnet</option></select></label>
        <label>{zh ? "已保存配置" : "Saved profiles"}<select value={profileId} disabled={connecting} onChange={(event) => { const selected = profiles.find((item) => item.id === event.target.value); setProfileId(event.target.value); if (selected) { setProtocol(selected.protocol); setHost(selected.host); setPort(selected.port); setUsername(selected.username); setProfileName(selected.name); } else { setProfileName(""); } }}><option value="">{zh ? "新配置" : "New profile"}</option>{profiles.filter((item) => item.protocol === protocol).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.host}</option>)}</select></label>
        <label>{zh ? "配置名称" : "Profile name"}<input value={profileName} disabled={connecting} onChange={(e) => setProfileName(e.target.value)} /></label>
        <label>{zh ? "设备地址" : "Host"}<input required value={host} disabled={connecting} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10" /></label>
        <label>{zh ? "端口" : "Port"}<input required type="number" min={1} max={65535} value={port} disabled={connecting} onChange={(e) => setPort(Number(e.target.value))} /></label>
        <label>{zh ? "用户名" : "Username"}<input required autoComplete="off" value={username} disabled={connecting} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>{zh ? "密码" : "Password"}<input type="password" autoComplete="off" value={password} disabled={connecting} onChange={(e) => setPassword(e.target.value)} /></label>
        <button disabled={connecting || agentBusy} type="submit">{zh ? `连接 ${protocol.toUpperCase()}` : `Connect ${protocol.toUpperCase()}`}</button>
        <button type="button" disabled={connecting || !profileName.trim() || !host.trim() || !username.trim()} onClick={() => { void window.piHarness.saveDeviceProfile(id, { ...(profileId ? { id: profileId } : {}), name: profileName.trim(), protocol, host: host.trim(), port, username: username.trim() }).then(async (profile) => { setProfileId(profile.id); await refreshProfiles(); }).catch((e) => setError(String(e))); }}>{zh ? "保存配置" : "Save profile"}</button>
        {profileId && <button type="button" disabled={connecting} onClick={() => { void window.piHarness.removeDeviceProfile(id, profileId).then(async () => { setProfileId(""); setProfileName(""); await refreshProfiles(); }).catch((e) => setError(String(e))); }}>{zh ? "删除配置" : "Delete profile"}</button>}
      </form>}
      {connected && !adding && <button disabled={agentBusy} type="button" onClick={() => { setAdding(true); setProfileId(""); setProfileName(""); setHost(""); setPassword(""); }}>{zh ? "连接另一台设备" : "Connect another device"}</button>}
      {adding && <button type="button" onClick={() => setAdding(false)}>{zh ? "取消添加" : "Cancel adding"}</button>}
      {attached.filter((device) => device.alias !== "current").map((device) => <div className="workspace-row" key={device.alias}><span>{device.name} · {device.host}:{device.port} · {device.status}</span><button type="button" disabled={agentBusy} onClick={() => { void window.piHarness.removeConversationDevice(id, device.alias).then(refreshAttached).catch((e) => setError(String(e))); }}>{zh ? "断开" : "Disconnect"}</button></div>)}
      {state && <pre ref={output} className="device-output" tabIndex={0} aria-label={zh ? "设备输入输出" : "Device input and output"}>{state.logs.map((row, i) => <span key={i} className={`device-log-${row.source}`}>{`[${new Date(row.time).toLocaleTimeString()} ${row.source === "user" ? (zh ? "手动" : "User") : row.source === "agent" ? "Agent" : "SSH"}] ${deviceOutput(row.text)}`}</span>)}</pre>}
      {connected && <form className="device-command" onSubmit={(event) => {
        event.preventDefault(); const value = command; setCommand(""); setError("");
        void window.piHarness.deviceCommand(id, value).catch((e) => setError(String(e)));
      }}><input aria-label={zh ? "设备命令" : "Device command"} value={command} disabled={state?.busy || agentBusy} placeholder={zh ? "输入设备命令" : "Device command"} onChange={(e) => setCommand(e.target.value)} /><button disabled={state?.busy || agentBusy || !command.trim()}>{zh ? "执行" : "Run"}</button></form>}
      {(connected || connecting) && <button type="button" onClick={() => void window.piHarness.disconnectDevice(id).catch((e) => setError(String(e)))}>{state?.busy ? (zh ? "中断并断开" : "Interrupt and disconnect") : (zh ? "断开" : "Disconnect")}</button>}
      {error && <p className="workspace-warning" role="alert">{error}</p>}
    </div>}
  </section>;
});
