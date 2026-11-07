import React, { useEffect, useRef, useState } from "react";
import type { DeviceState } from "../desktop/devices.js";
import type { DeviceProfile } from "../desktop/device-profiles.js";
import { deviceOutput } from "./device-output.js";

export function DevicePanel({ id, state, zh, agentBusy }: { id: string; state?: DeviceState | undefined; zh: boolean; agentBusy: boolean }) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState(state?.host ?? "");
  const [profiles, setProfiles] = useState<DeviceProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
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
    try { await window.piHarness.connectDevice(id, { host: host.trim(), port, username: username.trim(), password: secret, name: profileName.trim() || name.trim() || host.trim() }); }
    catch (e) { setError(String(e)); }
    finally { setSubmitting(false); }
  }
  return <section className="device-panel">
    <div className="device-heading"><button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} SSH · {state?.name || name || (state ? `${state.username}@${state.host}:${state.port}` : (zh ? "连接设备" : "Connect device"))}</button><span>{connecting ? (zh ? "连接中…" : "Connecting…") : connected ? (state?.busy ? (zh ? "执行中" : "Executing") : (zh ? "已连接" : "Connected")) : (zh ? "未连接" : "Disconnected")}</span></div>
    {open && <>
      {!connected && <form className="device-connect" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
        <p>{zh ? "命令将原样发送到 SSH 连接。登录密码仅用于本次连接。" : "Commands are sent directly over SSH. The password is used only for this connection."}</p>
        <label>{zh ? "已保存配置" : "Saved profiles"}<select value={profileId} disabled={connecting} onChange={(event) => { const selected = profiles.find((item) => item.id === event.target.value); setProfileId(event.target.value); if (selected) { setHost(selected.host); setPort(selected.port); setUsername(selected.username); setProfileName(selected.name); } else { setProfileName(""); } }}><option value="">{zh ? "新配置" : "New profile"}</option>{profiles.filter((item) => item.protocol === "ssh").map((item) => <option key={item.id} value={item.id}>{item.name} · {item.host}</option>)}</select></label>
        <label>{zh ? "配置名称" : "Profile name"}<input value={profileName} disabled={connecting} onChange={(e) => setProfileName(e.target.value)} /></label>
        <label>{zh ? "设备地址" : "Host"}<input required value={host} disabled={connecting} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10" /></label>
        <label>{zh ? "端口" : "Port"}<input required type="number" min={1} max={65535} value={port} disabled={connecting} onChange={(e) => setPort(Number(e.target.value))} /></label>
        <label>{zh ? "用户名" : "Username"}<input required autoComplete="off" value={username} disabled={connecting} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>{zh ? "密码" : "Password"}<input type="password" autoComplete="off" value={password} disabled={connecting} onChange={(e) => setPassword(e.target.value)} /></label>
        <button disabled={connecting || agentBusy} type="submit">{zh ? "连接 SSH" : "Connect SSH"}</button>
        <button type="button" disabled={connecting || !profileName.trim() || !host.trim() || !username.trim()} onClick={() => { void window.piHarness.saveDeviceProfile(id, { ...(profileId ? { id: profileId } : {}), name: profileName.trim(), protocol: "ssh", host: host.trim(), port, username: username.trim() }).then(async (profile) => { setProfileId(profile.id); await refreshProfiles(); }).catch((e) => setError(String(e))); }}>{zh ? "保存配置" : "Save profile"}</button>
        {profileId && <button type="button" disabled={connecting} onClick={() => { void window.piHarness.removeDeviceProfile(id, profileId).then(async () => { setProfileId(""); setProfileName(""); await refreshProfiles(); }).catch((e) => setError(String(e))); }}>{zh ? "删除配置" : "Delete profile"}</button>}
      </form>}
      {state && <pre ref={output} className="device-output" tabIndex={0} aria-label={zh ? "设备输入输出" : "Device input and output"}>{state.logs.map((row, i) => <span key={i} className={`device-log-${row.source}`}>{`[${new Date(row.time).toLocaleTimeString()} ${row.source === "user" ? (zh ? "手动" : "User") : row.source === "agent" ? "Agent" : "SSH"}] ${deviceOutput(row.text)}`}</span>)}</pre>}
      {connected && <form className="device-command" onSubmit={(event) => {
        event.preventDefault(); const value = command; setCommand(""); setError("");
        void window.piHarness.deviceCommand(id, value).catch((e) => setError(String(e)));
      }}><input aria-label={zh ? "设备命令" : "Device command"} value={command} disabled={state?.busy || agentBusy} placeholder={zh ? "输入设备命令" : "Device command"} onChange={(e) => setCommand(e.target.value)} /><button disabled={state?.busy || agentBusy || !command.trim()}>{zh ? "执行" : "Run"}</button></form>}
      {(connected || connecting) && <button type="button" onClick={() => void window.piHarness.disconnectDevice(id).catch((e) => setError(String(e)))}>{state?.busy ? (zh ? "中断并断开" : "Interrupt and disconnect") : (zh ? "断开" : "Disconnect")}</button>}
      {error && <p className="workspace-warning" role="alert">{error}</p>}
    </>}
  </section>;
}
