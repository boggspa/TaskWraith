# Safety Guidelines

TaskWraith runs AI coding agents and provider CLIs against local developer
workspaces. Treat every feature that can read files, write files, execute shell
commands, automate apps, or answer approvals as security-sensitive.

For the user-facing trust model, safe-first-run path, capability matrix, local
storage notes, and release verification steps, see
[TRUST_AND_SAFETY.md](TRUST_AND_SAFETY.md). This file is the shorter engineering
checklist for changes that add or widen app authority.

## Default User Posture

- Prefer Read-only/Recon or Plan workflow for first-run and unfamiliar
  workspaces.
- Make broad grants explicit and visible: full-workspace, yolo, unattended
  workflow, remote allowlist, and local-model run profiles or full-surface
  permission choices should never be implied by a UI shortcut.
- Treat optional surfaces such as iOS remote access, human collaboration, Screen
  Watch, Canvas/browser tooling, creative-app AppleScript, and Discord context
  as advanced features. They should stay off until the user intentionally
  configures them.
- Keep "what can leave the Mac" understandable. Provider-visible prompts, file
  snippets, command output, screenshots, media-derived context, and diagnostics
  exports should be described plainly where the feature is exposed.

## Implemented Guardrails

- **Workspace Confinement**: Workspace operations are scoped to the explicitly
  selected workspace directory wherever the provider adapter can enforce that
  boundary.
- **Approval Modes**: Read-only planning, default approval, and provider-specific
  edit modes are surfaced explicitly. Broad allow-all/session trust states must
  be user-selected and remain visible/auditable. Plan workflow's markdown-plan
  artifact save is a narrow product-managed carve-out under validated workspace
  paths; it is not a grant for ordinary read-only/recon tool calls to write
  files.
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

## Known Safety Limits

- TaskWraith is not a universal OS sandbox. Network denial, filesystem
  confinement, approval enforcement, and MCP mediation depend on the selected
  provider adapter and transport.
- Provider CLIs, SDKs, browser automations, native app bridges, and external
  APIs can expose user data outside TaskWraith's process.
- Approval prompts and audit logs help users see and control actions, but they do
  not make arbitrary third-party tools or untrusted provider output safe.
- Redaction is best effort for display surfaces. Raw local history, run events,
  provider output, media, and diagnostics should be handled as sensitive.

## Runtime Boundaries

- Keep renderer privileges low: `contextIsolation: true`, `nodeIntegration:
false`, and a narrow preload bridge.
- New filesystem, shell, network, automation, or keychain capabilities should be
  added only through explicit main-process APIs with validation.
- High-risk native/MCP surfaces such as web fetch/search, browser capture,
  attached-window capture, Screen Watch, creative-app bridges, Canvas tools, and
  `canvas_eval` should be documented, policy-gated, and tested as code- or
  data-execution boundaries.
- Main must be authoritative for Ensemble participant dispatch. Renderer
  projections and participant ids are advisory UI state; main re-resolves the
  prompt against the current roster, preserves exact picker identity, and
  rejects ambiguous aliases instead of selecting by roster order.
- Signed-elevated `canvas_eval` approvals require an exact transient desktop
  review. Human-approved execution and Canvas-audit receipts retain a
  content-minimised binding (approval id, unkeyed SHA-256 digest, lengths, and
  outcome), not the script or returned value/error. Auto-denial and
  compatibility/tool-event rows are content-redacted but may omit the full
  receipt. The digest is reproducible correlation/integrity metadata, not
  encryption or confidentiality. Provider-authored transcript prose can echo
  and persist the script/result; that prose, provider-native history, and
  explicitly enabled debug capture remain outside the guarantee.
- A TaskWraith-managed provider launch must not silently inherit external MCP
  namespaces that bypass the broker's policy and ledger. Prefer fresh
  TaskWraith-owned home/config roots and advertise only the sanctioned surface.
  A legacy adapter that must mutate provider configuration must restore the
  exact original bytes afterward and fail closed on unsafe config targets.
- Managed Cursor (Path-B) is always-enabled with containment on the argv:
  hard-pinned `--sandbox enabled`, seat-routed read-only vs write shapes, and
  never sandbox-disabled / force / yolo / resume-token from the production
  entry. Path B accepts own-account trust (real `~/.cursor` login; account
  skills/plugins/MCP may load but are sandbox-bounded). The sandbox is an
  honest partial backstop — it blocks many `$HOME`-root sensitive writes for a
  normal project workspace, but a workspace under `$HOME` can leave `$HOME`
  writable, and network egress is not proven blocked. Prefer project workspaces
  outside `$HOME` when untrusted repos matter.
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
