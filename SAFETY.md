# Safety Guidelines

TaskWraith runs AI coding agents and provider CLIs against local developer
workspaces. Treat every feature that can read files, write files, execute shell
commands, automate apps, or answer approvals as security-sensitive.

## Implemented Guardrails

- **Workspace Confinement**: Workspace operations are scoped to the explicitly
  selected workspace directory wherever the provider adapter can enforce that
  boundary.
- **Approval Modes**: Read-only planning, default approval, and provider-specific
  edit modes are surfaced explicitly. Broad allow-all/session trust states must
  be user-selected and remain visible/auditable.
- **Trust Visibility**: Trust and workspace status are shown in-app so users can
  inspect what a provider is allowed to do before starting a run.
- **Diff Review**: Diff Studio keeps generated changes reviewable before commit.
  It does not silently commit, publish, or revert user files.
- **Audit Logs**: Approval responses, automatic decisions, run events, and raw
  provider events are retained locally for review.
- **Remote/iOS Bridge**: Paired-device actions are default-closed and revalidate
  the pair, workspace ownership, capability, approval mode, provider, expiry,
  and replay status for every action. Global scope stays plan-oriented; remote
  file, git, pull-request, `pin`, and `yolo` actions require explicit allowlist
  capabilities.
- **Goal Lifecycle**: Persistent thread goals are stored separately from
  `todo_write` so agents can complete or block the objective explicitly instead
  of silently treating a checklist as the stopping condition.
- **Audit Orchestration**: `/audit` runs use configured providers, local
  findings/verdict state, and dismissible UI banners. They should never assume a
  provider account the user has not configured.
- **Log Redaction**: Raw stdout/stderr displayed in the app is redacted for
  common secrets such as bearer tokens, email addresses, and local home paths.
  This is best-effort redaction for display and preview surfaces only; local
  transcripts, raw events, artifacts, provider output, and exported diagnostics
  should still be treated as sensitive.

## Runtime Boundaries

- Keep renderer privileges low: `contextIsolation: true`, `nodeIntegration:
false`, and a narrow preload bridge.
- New filesystem, shell, network, automation, or keychain capabilities should be
  added only through explicit main-process APIs with validation.
- High-risk native/MCP surfaces such as web fetch/search, browser capture,
  attached-window capture, Screen Watch, creative-app bridges, Canvas tools, and
  `canvas_eval` should be documented, policy-gated, and tested as code- or
  data-execution boundaries.
- External links and file paths should route through the safe shell-open policy;
  do not call `shell.openExternal` directly for untrusted renderer input.

## Branding and Assets

TaskWraith uses original app artwork and custom provider hint glyphs. It should not
bundle provider logos, proprietary provider fonts, or copied provider UI. Product
and provider names may be used nominatively to describe compatibility.

## Manual Review

Review the generated `git diff` before committing agent output. For public
releases, also verify the source tree contains no private credentials, signing
material, local build artifacts, or historical secret-bearing commits.
Mac release artifacts should be signed, notarized, stapled, and validated before
upload. Unsigned Windows/Linux artifacts should come from explicit CI workflows
and be labelled as unsigned.
