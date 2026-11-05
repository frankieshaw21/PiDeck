# Security

Minimal Pi Harness intentionally runs Pi tools and extensions with the user's OS
permissions. RPC subprocess isolation limits crash propagation; it is not a file,
network, or command sandbox.

## Trust boundary

- The Electron renderer has no Node.js integration and uses a sandboxed, isolated preload.
- IPC exposes an allowlisted API and validates session IDs, project paths, text sizes,
  task intents, model identifiers, and Extension UI responses.
- Project directories must be selected by the user or restored from the Harness index.
- All Pi sessions for a project share that project's filesystem.
- The single-writer lease is cooperative. Shell commands and extensions can write
  outside the Harness's intent classification.

Only install Pi extensions and skills from sources you trust.

## Reporting

Do not include authentication files, provider tokens, prompts, or project contents
in a public report. Include the application version, Pi version, operating system,
and minimal reproduction steps.
