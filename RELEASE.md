# Release checklist

## Prerequisites

- Node.js 22.19 or newer
- Pi authentication for the desired model provider
- macOS signing certificate and Apple notarization credentials for public macOS distribution
- Corresponding signing credentials for Windows distribution

## Verification

```sh
npm ci
npm run release:verify:full
npm audit --omit=dev
```

## Build artifacts

```sh
npm run dist:mac
npm run dist:win
npm run dist:linux
```

Build each platform on its native CI runner. Artifacts are written to `release/`.
The application bundles Pi 1.5.0, uses `PI_PATH` when specified, and falls back to
the managed launcher or `pi` on `PATH` if the bundle is unavailable. It preserves
the user's existing authentication and resources.

## Signing

Unsigned local artifacts are suitable for internal testing only. Public macOS builds
must be signed and notarized; public Windows builds should be Authenticode signed.
Never commit signing certificates, passwords, API tokens, or notarization credentials.

## Manual acceptance

1. Select a Git project and create three sessions.
2. Run two analysis tasks concurrently and switch to the third session.
3. Cancel one task and confirm the other completes.
4. Verify `Analyze` tasks can overlap and same-project `May write` tasks queue.
5. Restart the app and confirm history recovery.
6. Exercise model switching and an Extension UI dialog.
7. Confirm quit stops active work and no Pi child process remains.
8. On Windows, install Pi globally with npm, launch the packaged app, and repeat
   these checks with a project path containing spaces. Also check `PI_PATH` with
   an explicit path to `pi.cmd`.
