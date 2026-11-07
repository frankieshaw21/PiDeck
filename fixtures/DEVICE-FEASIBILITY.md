# Device session feasibility verification

Verified on Windows on 2026-11-07 using the installed Pi 1.5.0 runtime.

## Result

Feasible. A desktop-owned device broker can hold a persistent SSH shell and
serve both manual commands and a Pi extension tool. Pi's separate process is
not a blocker: authenticated loopback communication works, and the existing
RPC adapter forwards intermediate `tool_execution_update` records.

This is a runnable, isolated feasibility experiment, not an application feature.
Neither fixture is loaded by the desktop application. No production dependencies,
saved sessions, model credentials, or application UI are changed.

## Reproduce (PowerShell, from the repository root)

```powershell
$probeDeps = Join-Path $env:TEMP 'pideck-ssh-feasibility-deps'
npm install --prefix $probeDeps --no-audit --no-fund --ignore-scripts ssh2@1.17.0
npm run build:node
node fixtures/device-feasibility.mjs
```

Set `DEVICE_PROBE_DEPS` if dependencies were installed into another directory.
The script starts an SSH server and HTTP broker on ephemeral loopback ports,
uses generated credentials and a pinned generated host key, and starts the real
Pi RPC process with an isolated agent directory. Its deterministic local model
issues a real `device_exec` tool call through Pi's agent pipeline. It makes no
external AI request. Temporary session files and processes are cleaned up.

The SSH server simulates a device command interpreter; it does not run a real
remote operating-system shell or connect to a physical device.

## Checks that passed

- Real SSH authentication and encrypted shell traffic over loopback.
- Pi loads the extension and invokes its registered device tool.
- A manual command changes shell state; the Agent's subsequent command sees it.
- Manual and Agent commands reuse the same shell; a second connection has its own state.
- Tool start, multiple intermediate output events, and successful completion reach the RPC subscriber.
- Manual command submission is rejected while the Agent owns the device.
- Stopping Pi's run cancels the broker operation and releases its busy state.
- A broker request without the bearer credential receives HTTP 403.
- The generated SSH password is absent from captured RPC events.

## Recommended application implementation

1. Add a session-scoped device broker to the desktop main process. It owns SSH
   credentials, host-key trust, channel lifecycle, bounded output history, and
   command ownership. Bind a capability to exactly one session; do not allow a
   model-supplied address or session ID to select another device.
2. Connect before chatting. Expose address, user, port, connection state, and
   disconnect/reconnect actions in the conversation and workspace connections tab.
3. Load a device extension for Pi. Expose explicit device tools and tell the
   Agent which device is attached. Preserve the distinction between local project
   tools and device tools; never silently fall back to executing locally.
4. Publish broker input/output events to a terminal panel. Include timestamps and
   input ownership. Add `tool_execution_update` handling to the conversation;
   the renderer currently handles only tool start/end events.
5. Serialize command ownership. Allow manual takeover after cancellation and
   require reconnect when interruption leaves the remote shell state uncertain.
6. Close channels on session deletion and application exit. Keep host trust and
   login secrets outside the Agent transcript. Define reconnect behavior explicitly.

## Work still requiring validation

- Real device passwords, keys, host-key enrollment/change, and authentication prompts.
- Device command completion and output parsing. This fixture uses an explicit
  `__DONE__` marker; network appliances often require prompt/pager adapters.
- Interactive programs, ANSI rendering, terminal resize, Ctrl-C, and long output.
- Connection loss, network timeouts, output backpressure, and reconnect semantics.
- Electron terminal UI and IPC wiring (not implemented or visually tested here).
- Real model behavior and tool selection (the test model is deterministic).
- Telnet negotiation, encodings, login prompts, and device-specific behavior.

The included Pi `examples/extensions/ssh.ts` confirms remote tool support, but
launches SSH per command and assumes remote bash. It is reference material,
not sufficient for the requested shared interactive device terminal.
