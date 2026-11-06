# Minimal Pi Desktop Harness

Lightweight multi-session desktop application built on the native Pi Coding Agent
runtime. Pi supplies the agent loop, models, authentication, tools, extensions,
skills, prompt templates, context management, and conversation storage; the Harness
supplies desktop interaction and explicit multi-session execution control.

## Current scope

- One Pi RPC subprocess per live Harness session
- Shared project working directory with independent Pi session IDs
- Pi-native JSONL session persistence
- Harness-owned session metadata index
- Strict LF-delimited JSONL transport (no `readline`)
- Stream/event routing with Harness session ID, run ID, and sequence
- Prompt, abort, state, messages, model selection, and Extension UI responses
- Graceful subprocess shutdown with bounded escalation
- POSIX process-group and Windows process-tree cleanup
- Electron main/preload/renderer security boundary
- Minimal two-column React interface
- Project picker, session list, history loading, streaming messages, and stop
- Model selector and standard Extension UI dialogs
- Background session event routing independent of the selected session
- Maximum two concurrent runs with an ordered eligibility queue
- Cooperative single-writer lease per project (`Analyze` vs `May write`)
- Session deletion kept separate from task cancellation

## Requirements

- Node.js 22.19 or newer for development
- Pi Coding Agent 1.5.x installed and authenticated
- macOS 12+, Windows 10+, or a current desktop Linux distribution

The packaged application does not bundle or replace Pi. It uses `PI_PATH`, the Pi
managed launcher, or `pi` on `PATH`, so existing Pi configuration is preserved.
On Windows, install Pi with npm and ensure its global bin directory is on `PATH`,
or set `PI_PATH` to the full path of `pi.cmd` before launching the application.
Restart the application after changing environment variables.

## Commands

```sh
npm ci
npm test
npm run probe
npm run probe:real
npm run probe:compat
npm run smoke:desktop
npm start
```

The probe starts two independent Pi RPC processes without sending a model prompt.
`probe:real` uses the configured model, runs two sessions concurrently, aborts A,
and verifies that B still completes with an isolated event stream.
`probe:compat` validates model reuse, Skill discovery, the built-in read tool,
Extension commands, and all RPC-supported dialog/status/notification methods.

## Persistence ownership

Pi owns conversation history and context in its native session files. The Harness
stores only its project/session index and the mapping to Pi session IDs. It does
not maintain a second transcript database.

Pi does not retain a completely empty session file on shutdown. The Harness index
therefore also acts as the durable identity for a session that has not yet received
its first persisted conversation entry; reopening it recreates the same Pi session
ID and reapplies its display name.

## Release builds

```sh
npm run release:verify:full
npm run dist:mac
npm run dist:win
npm run dist:linux
```

See [RELEASE.md](RELEASE.md) for signing, notarization, CI, and manual acceptance.

## Security limitation

The RPC process boundary is fault isolation, not a filesystem sandbox. Sessions
still share the project directory, and arbitrary shell/extension writes cannot be
reliably classified or prevented by the Harness.
