# Security Development Baseline

TaskWraith is a local Electron app that can run coding agents and CLIs against
user workspaces. Treat dependency updates, IPC bridges, shell execution, and
release signing as security-sensitive changes.

## Dependency Installs

- Use `npm ci` for clean installs. Avoid casual `npm install` or broad
  `npm update` during active npm incident windows.
- Run `npm run security:deps` after dependency changes and before releases.
  This checks the lockfile, registry signatures, critical production audit
  findings, known incident package names, suspicious persistence indicators,
  and the allowlist of packages with install lifecycle scripts.
- Review every `package-lock.json` diff. New install lifecycle scripts should
  be treated like code execution on developer and CI machines.

## Electron Runtime

- Keep renderer privileges low: `contextIsolation: true`,
  `nodeIntegration: false`, and renderer sandboxing on for app windows.
- Expose new main-process capabilities only through preload APIs backed by
  explicit IPC validation.
- Route external links and file paths through the safe shell-open policy; do
  not call `shell.openExternal` directly for untrusted renderer input.

## Remote Bridge And APNs

- The Mac bridge identity is protected by `safeStorage` and must fail closed if
  an existing identity cannot be read, protected, or persisted. Silent identity
  replacement breaks paired-device trust and should remain release-blocking.
- Pairing records store public-key metadata and routing state; APNs device
  tokens are local routing identifiers stored on the user's Mac.
- APNs payloads must remain generic and routing-only: reason, pair/device, and
  thread/run identifiers are acceptable; prompts, commands, paths, diffs,
  summaries, model output, and user messages are not.
- `TASKWRAITH_BRIDGE_PERMISSIVE` and similar bridge bypasses are dev/test-only
  switches. They should never be enabled in release builds or packaged app
  defaults.

## Provider Tooling Limits

- Network denial, filesystem confinement, approval enforcement, and MCP tool
  mediation are provider- and transport-dependent. Do not describe them as a
  universal OS sandbox unless the current adapter actually enforces that
  boundary.
- Provider CLIs, SDKs, browser automations, and native app bridges can expose
  user data outside TaskWraith's process. New integrations should document what
  the provider/runtime sees and how approval policy is applied.

## Secrets and Release

- Release signing, notarization, npm, GitHub, Apple, and provider API tokens
  should be scoped and available only to the jobs or local shells that need
  them.
- Apple notarization credentials should live in the macOS keychain as a named
  notarytool profile, not in shell history or repository files. Local release
  commands may reference the profile name, but must not print or commit the
  underlying Apple ID password.
- macOS public artifacts should be Developer ID signed, notarized, stapled, and
  validated with Gatekeeper/update-feed checks before release upload.
- Unsigned Windows and Linux artifacts should be produced by explicit GitHub
  Actions workflows and labelled as unsigned in release notes.
- CI release jobs should run dependency security checks before packaging or
  notarization.
- If a supply-chain incident may have affected a machine or CI run, pause
  releases, inspect lockfile/package names and lifecycle scripts, review CI
  logs, rotate exposed tokens, and rebuild from a clean checkout plus lockfile.
