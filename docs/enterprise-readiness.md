# Enterprise readiness plan

Status: 2026-07-03

This document tracks the current enterprise-facing posture after the July 2026
permission, plan-mode, audit, iOS bridge, and staged-roster work. It is meant to
keep the release claim honest: the product can be safe and useful for managed
technical teams before it has the full enterprise control plane that larger
organizations expect.

## Current release claim

TaskWraith is ready to describe its agent safety posture in precise terms:

- Provider tool access is routed through TaskWraith policy where the provider
  exposes a brokered surface.
- Read-only / recon is a permission posture, not a degraded Ollama/local-only
  mode. Ollama should keep equal tool parity where the capability is available;
  tiering is for efficient delegation and context control, not for safety
  coddling.
- Network-denied runs deny TaskWraith `web_search` / `web_fetch` and hide Ollama
  web tools only when network is actually denied.
- Plan workflow and Read-Only/Recon are now distinct product states even when
  both use the provider's read-only approval posture.
- Approval decisions and run lifecycle events now carry a durable permission
  posture proof snapshot so later review can compare what was requested, signed,
  and executed.
- The iOS bridge can preserve Plan workflow separately from Read-Only/Recon, so
  older phone builds fail conservative while newer builds can request the right
  product state.

This is not yet a complete enterprise-managed deployment story. The sections
below separate the remaining managed-enterprise blockers from release hygiene.

## Recent landed work

### B1 - Network policy honesty

Shipped in `e133722dc`.

- `web_search` and `web_fetch` are classified as network tools and are denied
  under effective or global `networkAccess: deny`.
- Native tool preflight receives the tool name, so provider-specific filtering
  can make a tool-level decision rather than relying on coarse defaults.
- Ollama web-capable tools remain visible when network is allowed and are hidden
  only when the run/network posture denies network.

### B2 - Durable permission posture proof

Shipped in `aa32ec633`.

- Run queue jobs, lifecycle events, `ChatRun` snapshots, and approval-ledger
  decisions now receive a `permissionPosture` proof snapshot.
- The proof stores normalized posture, signature presence, a posture hash, and a
  prompt hash only. It deliberately does not store raw prompts.
- This gives support, audit, and later export flows a stable object to compare
  against without replaying renderer state.

### B3 - iOS plan-workflow parity

Shipped in `1e8548636`.

- Bridge composer actions accept `workflowMode: 'normal' | 'plan'`.
- Old iOS builds that send `approvalMode: 'plan'` without `workflowMode` still
  map to the read-only floor.
- New iOS builds expose Default, Read-Only/Recon, and Plan. General/global chats
  stay pinned to Read-Only/Recon.
- Queued remote composer state preserves `workflowMode`.

### B4 - Label and copy honesty

Shipped in `5bbb59a9b`.

- Read-only labels now say Read-Only/Recon rather than Plan.
- Plan workflow summary cards require `workflowMode === 'plan'`.
- Run-complete summaries distinguish Plan from read-only posture.

### Human feedback capture layer

Shipped in `5c2e34b70`.

- Assistant messages can now capture thumbs up/down feedback in the message row
  and context menu.
- The visible state persists on `message.metadata.feedback` through the existing
  chat-save path.
- The durable, local `thumbs-ledger.json` receipt layer now harvests those
  message states on save. Closed-set poor-rating reasons and redacted
  diagnostics summaries are shipped; the redacted audit-bundle builder includes
  feedback receipt summaries. Model/role aggregation, recast actions, a
  user-facing export flow, and iOS parity remain B5 work.

### Adjacent stage-role bridge work

Fable's stage-role bridge work should be treated as part of the same audit
surface:

- Mac to phone roster and ensemble-preset projections carry `stageRole`.
- Phone to Mac `ensembleRosterUpdate` accepts only `scout`, `worker`,
  `reviewer`, or `''`; an absent field preserves the existing stage and `''`
  explicitly clears it.
- iOS roster editing can set Any / Scout / Worker / Reviewer and now uses the
  Mac-side 20-seat roster cap.

This closes the bridge round-trip for live roster editing. It does not by
itself make stage-role scheduling a durable enterprise receipt. The remaining
work is to ensure queued, wakeup, scheduled, and exported run records freeze the
stage-role intent that actually dispatched the turn.

## Enterprise baseline from comparable products

The current market baseline is not just "does the app have approvals." Official
materials from larger competitors consistently emphasize:

- organization-level admin controls and data controls
- configurable retention or privacy posture
- compliance artifacts / trust-center documentation
- admin-enforced policy rather than user-owned local settings

Reference points used for this plan:

- OpenAI business data and retention controls:
  <https://openai.com/business-data/>
- OpenAI enterprise privacy and admin-managed retention:
  <https://openai.com/enterprise-privacy/>
- OpenAI app admin/security/compliance controls:
  <https://help.openai.com/en/articles/11509118-admin-controls-security-and-compliance-in-apps-enterprise-edu-and-business>
- Anthropic Claude Enterprise governance/data/admin positioning:
  <https://www.anthropic.com/product/enterprise>
- Claude Code security documentation:
  <https://code.claude.com/docs/en/security>
- Anthropic Trust Center:
  <https://trust.anthropic.com/>
- Cursor security and admin-enforced privacy mode:
  <https://cursor.com/security>

Hermes/OpenClaw references found during the quick pass were mostly third-party
or community commentary, so they should be used as risk context only, not as a
source for enterprise feature claims.

## Confirmed remaining blockers

### B5.1 - Secrets at rest for user-managed extension surfaces

What exists:

- First-party provider keys and plugin secrets already use Electron
  `safeStorage` patterns.
- Plugin secret status is exposed without cleartext, and plugin secret files use
  restrictive permissions.
- Settings sanitization now rejects obvious inline plaintext secrets for
  user-managed MCP env/header fields and runtime-profile env fields unless the
  value is an environment-variable reference such as `$TOKEN` or `${TOKEN}`.
- A main-process `ExtensionSecretStore` now provides the encrypted-at-rest
  foundation for user-managed MCP server env/header fields and runtime-profile
  env fields. It is backed by Electron `safeStorage`, stores only encrypted
  ref-bound payloads on disk, exposes status snapshots without cleartext,
  returns typed main-process resolution statuses for launch-time callers,
  supports owner-wide cleanup, and writes the store file with restrictive
  permissions.
- `AppStore` exposes the extension-secret status/mutation/resolution surface and
  clears owner-scoped encrypted secrets when a user MCP server or runtime
  profile is deleted.
- AppStore JSON writes now create and rewrite settings/profile-store files with
  owner-only `0600` permissions where the filesystem supports POSIX modes.
- Main/preload settings IPC exposes encrypted extension-secret status, set, and
  clear operations without exposing any plaintext resolution API to the renderer.
- User-managed MCP server configs can carry env/header `secretRefs`. Launch
  assembly resolves those refs from the encrypted store, applies enterprise
  allowlists to the ref names before decryption, blocks servers with missing or
  undecryptable refs, and passes remote bearer-token values through provider
  process env where the provider supports env indirection.
- Plugin MCP presets now validate `requiredSecrets` against declared plugin
  secrets and materialize `$ENV_VAR` / `${ENV_VAR}` preset env/header
  placeholders into user-MCP `secretRefs`. Placeholder literals are stripped
  from the saved server config, so plugin-backed MCP servers use the same
  encrypted launch-time resolution path and block if a required secret is
  missing or undecryptable.
- Runtime profile records can carry env `secretRefs`. Launch env assembly
  resolves those refs centrally through `createCliEnv`, blocks runs when a
  referenced encrypted value is missing or undecryptable, and lets the encrypted
  value override any same-name placeholder in the profile JSON.
- Legacy user MCP env/header values and runtime-profile env values matching the
  plaintext-secret policy are migrated on main-process load into encrypted
  `secretRefs`. Plaintext is removed from settings/profile JSON only after the
  encrypted write succeeds; if OS encryption is unavailable or a ref write
  fails, the plaintext value remains in place for user review instead of being
  silently lost.
- The manual Settings -> MCP servers editor now exposes separate encrypted
  environment/header fields. Values entered there are written through
  `setExtensionSecret` before the server is persisted, and the saved
  `userMcpServers` record carries only `secretRefs`. Existing encrypted secrets
  render as blank `NAME=` placeholders and can be preserved without exposing
  cleartext to the renderer.

What is missing:

- Imported user MCP configs can still contain non-obvious plaintext values that
  rely on the main-process sanitizer and migration heuristic rather than an
  interactive encrypted-field review flow.
- Runtime profile settings surfaces are not yet wired to create/manage encrypted
  env refs directly.
- iOS settings surfaces are not yet wired to create or manage those encrypted
  refs directly.

Risk:

- A token in an MCP `Authorization` header, MCP env var, or runtime profile env
  can still be durable plaintext if it does not match the conservative
  migration heuristic, if encrypted storage is unavailable, or if a renderer
  settings form writes around the secret status/mutation flow.

Target:

- Complete the main-process secret store wiring for imported user MCP configs
  and runtime-profile settings.
- Persist only secret references/status in settings/profile records.
- Resolve cleartext only at provider launch and prefer provider-supported env
  indirection over argv or workspace-local config files.
- Warn or reject raw keys matching obvious secret names unless stored through the
  encrypted path.
- Keep the automatic no-loss migration path for obvious legacy plaintext records,
  and add a review surface for values that are not migrated automatically.

### B5.2 - Audit export, retention, and tamper evidence

What exists:

- Approval ledger records are durable and capped.
- Run events are persisted, sequenced, and hash-chained.
- Diagnostics export exists but is capped and operationally oriented.
- Chat deletion cleans up known run-event artifacts for that chat.
- Diagnostics export now includes a redacted `auditReceipts` section with
  counts and SHA-256 hashes for approval ledger rows, workspace-change sets,
  thumbs/casting receipts, and external-publish receipts, plus bounded redacted
  summaries for the newer receipt ledgers.
- Default diagnostics export now summarizes queued-run, recovery, approval, and
  workspace-change records instead of exporting raw queued prompts, approval
  bodies/params/previews, process commands, or diff bodies.
- A redacted audit-bundle snapshot builder exists for workspace/thread/run
  scopes. It emits a manifest with schema version, filters, redaction mode,
  section counts, section hashes, retention labels, run-event hash-chain
  validation, and permission-posture proof counts.
- The audit-bundle snapshot includes redacted summaries for approval ledger
  rows, run-event replays, workspace changes, audit runs, evidence packs,
  capability ledger cells, message-feedback receipts, and external-publish
  receipts.
- Main/preload expose `exportProductAuditBundle`, which writes the redacted
  bundle JSON with optional workspace/thread/run filters. Chat-scoped exports
  read each persisted run event file directly rather than using the
  UI-optimized chat event cap.
- The audit-bundle IPC route now accepts only the default redacted export mode.
  Unsupported sensitive-export modes fail before export, so future sensitive
  bundles require an explicit separate user/admin flow rather than appearing as
  a tolerated option.
- Main/preload expose `purgeProductAuditRetention`, backed by opt-in
  `auditRetention` settings. It can dry-run or purge expired approval history,
  run-event files and artifacts, workspace-change records, audit runs,
  message-feedback receipts, external-publish receipts, and product-crash
  diagnostics. Live approval grants are preserved even when older than the
  retention cutoff.
- Each purge writes a capped `audit-retention-purges.json` receipt with
  counts-only, path-redacted evidence of what was scanned, retained, and
  deleted. Diagnostics and audit-bundle export include those purge summaries.
- Settings -> System -> Product operations now exposes the default signed audit
  bundle export, the opt-in audit-retention enabled flag, per-surface retention
  windows, a dry-run control, and a confirmation-gated purge control. Both
  dry-runs and purges flow through the main/preload receipt-writing route.
- The Settings audit-bundle export surface now includes scoped controls for the
  full local bundle, current workspace, current thread, and current run. Disabled
  buttons make unavailable scopes explicit instead of silently exporting a
  broader bundle.
- Main/preload expose `verifyProductAuditBundle`, and Settings -> System ->
  Product operations now has a verifier action that lets the user pick an
  exported JSON bundle and records whether its payload hash, signature, section
  hashes, and counts verify.
- Audit-bundle exports are now signed when Electron `safeStorage` is available:
  a long-lived Ed25519 key is generated once under `userData`,
  safeStorage-encrypted at rest, and reused so each exported bundle carries a
  `local_hashes_signed` manifest signature. Verification recomputes section
  hashes/counts and validates the signature over the final sanitized snapshot.
  If no protected key can be created, the export remains explicitly marked
  `local_hashes_unsigned`.

What is missing:

- A polished verification/export UI around the signed bundle evidence. The
  Settings action reports pass/fail into the app log, but there is not yet a
  detailed verifier status pane or retained verification receipt browser.
- An explicit sensitive-field export flow. The current route is redacted-only
  and rejects unsupported sensitive modes, but there is not yet a separate
  user/admin decision path for exporting sensitive fields.

Target:

- Add an explicit sensitive export mode only behind a separate user/admin
  decision; keep the default bundle redacted.
- Expose verification results for signed audit bundles in the Settings/UI flow
  and keep unsigned exports clearly labeled when safeStorage is unavailable.

### B5.3 - Managed policy plane

What exists:

- Local settings and approval policy are comprehensive.
- Remote/iOS workspace allowlists are per-action and explicit.
- `canvasEval` and future `mediaRecording` are intentionally non-grantable.
- A first managed-policy spine exists in main: `ManagedPolicyService` can load
  JSON from macOS managed preferences (`TaskWraithManagedPolicy` /
  `TaskWraithManagedPolicyJSON`) before falling back to
  `TASKWRAITH_MANAGED_POLICY_JSON` or `TASKWRAITH_MANAGED_POLICY_PATH`, compute
  locked/enforced setting keys, apply a startup clamp before update-service
  configuration, and filter future `SettingsService` writes. The first clamp
  surface covers update channel, auto-update, bridge enablement, Codex sandbox
  fallback, agentic-service policy, approval timeouts, user MCP servers
  (disable-only), and workspace grants (clear-only). Diagnostics export reports
  a redacted policy status summary.
- The managed-preferences/env/path managed policy source can now be a signed
  Ed25519 envelope. When
  `TASKWRAITH_MANAGED_POLICY_PUBLIC_KEY_DER_BASE64`,
  `TASKWRAITH_MANAGED_POLICY_PUBLIC_KEY`, or
  `TASKWRAITH_MANAGED_POLICY_PUBLIC_KEY_PATH` is configured, unsigned policies
  fail closed and only a verified envelope payload is applied. Diagnostics
  report signature presence/validity, key id, and payload hash but not key
  material.
- Session YOLO enablement is clamped when managed policy controls agentic
  service policy, workspace grants, or approval timeouts. The local IPC setter
  and paired-device bridge toggle return a managed-blocked state instead of
  enabling the in-memory session override.
- Workspace approval grants now persist through `SettingsService`, so
  `acceptForWorkspace` cannot re-add standing grants after managed policy has
  enforced `agenticWorkspaceGrants: []`.
- Approval-timeout settings and managed-policy clamps now cover every current
  provider (`gemini`, `codex`, `claude`, `kimi`, `grok`, `cursor`, and
  `ollama`) instead of silently pinning the newer provider adapters to hidden
  runtime defaults.
- Settings can now read a redacted managed-policy status snapshot and render a
  "Managed by organization" notice with policy source, organization label,
  locked setting keys, and error count. The notice gives users an immediate
  explanation for enforced controls without exposing raw policy payload details.

What is missing:

- Per-control locked/disabled affordances in Settings are not complete yet.
  Enforcement exists, and the top-level managed notice explains why controls are
  locked, but individual controls do not all render inline lock badges.
- Other non-settings live controls still need explicit inventory and managed
  clamps. The current policy source is startup-loaded, so future live policy
  reload support must also revoke or re-materialize affected in-memory state.
- User MCP policy has launch-time and save-time managed allowlist enforcement.
  Locked Settings UI and deeper plugin provenance revalidation still land under
  B5.4.

Target:

- Expand the MDM-delivered managed-preferences format only when new policy
  fields need it; keep it on the same effective-settings clamp seam as env/path
  fallback policies.
- Clamp agentic service policy, workspace grants, approval timeouts, session
  YOLO, update channel, auto-update, bridge access, and user-managed MCP
  according to managed policy, including revocation behavior for any future
  live policy reload path.
- Add UI "managed by organization" affordances rather than silently ignoring
  user input.
- Add tests at `SettingsService`, `PermissionService`, update service, remote
  bridge, MCP sanitizer, and renderer locked-control seams.

### B5.4 - User-managed MCP allowlisting

What exists:

- User MCP server shape is sanitized.
- Transport-specific readiness checks exist.
- The launch builder now has an optional allowlist policy decision point before
  enabled user MCP servers materialize into provider launch config. It can gate
  transports, stdio command roots and argument prefixes, remote URL
  scheme/host/port/path, header names, env keys, and plugin provenance /
  plugin ids, and can report
  blocked-server reasons to callers.
- The managed-policy spine now accepts a `userMcpLaunchAllowlist` block and
  feeds it into the Claude, Cursor, and Codex user-MCP launch materialization
  paths. Diagnostics report only allowlist shape/counts, not the configured
  roots, remote URL policies, headers, env keys, or plugin ids.
- Settings writes now apply the same managed user-MCP allowlist before
  persistence. Servers that fail the allowlist are preserved but saved disabled,
  so the user does not lose configuration while launch bypasses remain closed.
- Settings writes also revalidate plugin MCP provenance through the same plugin
  catalog verifier used at launch time before preserving a plugin-backed server
  as enabled.
- Stdio command-root checks canonicalize existing commands and roots through
  realpath before allowlist comparison, blocking symlinks that point outside the
  managed root.
- Stdio argument checks can require every configured command argument to match
  a managed prefix allowlist. Blocked evidence reports argument position rather
  than the raw argument value.
- Remote checks can also block loopback, private, link-local, carrier-grade NAT,
  benchmarking, localhost, common cloud-metadata DNS labels, and well-known
  NAT64 encodings of private/local IPv4 remote MCP hosts when the managed policy
  opts in.
- Codex app-server tracks whether its running MCP launch config is stale; when
  there are no active Codex runs, the next Codex accessor disposes the idle
  app-server so the following start rematerializes the current managed/user-MCP
  config.
- Launch-time user-MCP materialization now revalidates saved plugin MCP
  provenance against the current plugin catalog before including the server:
  installed/enabled state, trust/preflight/update status, source identity,
  manifest hash, and MCP preset object id must still match.
- Diagnostics and audit-bundle exports now include redacted
  `userMcpBlockedServers` evidence when the managed launch allowlist blocks
  enabled user MCP servers. Server ids/names and raw header/env names are
  hashed; the export carries reason categories, counts, and section hashes.
- Audit/previews redact values for display.

What is missing:

- Locked Settings UI and plugin materialization policy still need to sit on the
  B5.3 managed-policy plane.
- Command-root and argument-prefix checks are launch allowlists, not a sandbox.
  They constrain configured process materialization but do not confine a
  process after it starts.
- Remote checks cover managed scheme/host/port/path allowlists, reject URL
  userinfo, and can block private/local literal, metadata-name, and NAT64 hosts,
  but they are still not a full DNS-rebinding or runtime egress policy.
- Long-lived provider app servers now have an idle rematerialization path, but
  active in-flight runs still intentionally keep their launch-time MCP surface
  until a future live revocation/cancellation policy is designed.

Target:

- Keep compatible checks at sanitize/save time and again at launch time.
- Keep command-root, remote-host, env/header, and provenance decisions
  centralized in the user-MCP launch builder so Codex, Claude, Cursor, and
  provider capability previews cannot drift.
- Export blocked-server reasons in diagnostics and audit bundles.

### B5.4b - External publishing receipts and remote capability split

What exists:

- Agent-routed `git_push` and `git_create_pr` are classified under the
  non-grantable `externalPublish` service. Session/workspace grants and YOLO do
  not pre-authorize them.
- Release-style shell commands are blocked by a launch-time classifier before
  host shell/background/run-task execution.
- CLI and Git subprocess environments scrub common publishing/signing tokens.
- Paired-device bridge actions now split local Git mutation from external
  publishing: staging/unstaging/committing require `fileWrite`, while
  `gitPush` and `githubCreatePr` require the explicit admin-only
  `externalPublish` remote capability.
- Remote device audit rows for bridge push/PR actions record
  `capability: externalPublish`.
- Desktop Git push and PR creation now write an origin-aware
  `external-publish-receipts.json` record before side effects. The same
  receipt surface is used by agent-routed `git_push` / `git_create_pr` and
  paired-device bridge push/PR actions. Completion metadata records commit SHA,
  PR URL, or failure reason where available.

What is missing:

- The remote-access UI and iOS copy need to expose the new external-publish
  capability separately from file editing before paired-device publishing can
  be presented as a polished managed feature.
- The redacted audit-bundle export route includes external-publish receipts, but
  there is not yet a Settings/UI entry point for those summaries.
- External-publish receipts are included in the opt-in age-based
  audit-retention purge route, but there is not yet a Settings/UI entry point
  for configuring that retention window.

Target:

- Keep all external publication origins (`desktop-ui`, `ios-bridge`, and
  `agent`) on the shared receipt ledger so audit/export work has one schema.
- Keep the bridge `externalPublish` capability explicit and admin-only.
- Add Settings/UI affordances for exporting external-publish receipt summaries
  and bridge audit rows through the redacted audit-bundle route.
- Add Settings/UI retention controls for external-publish receipt age windows.

### B5.5 - Stage-role and queued-dispatch receipts

What exists:

- Live roster/preset bridge now round-trips `stageRole`.
- The orchestrator uses stage roles for scout/worker/reviewer scheduling.
- Solo wakeups capture a permission snapshot.
- Remote queued composer work now preserves `workflowMode`.
- Ensemble run identity now preserves `laneId` and `stageRole` across dispatch
  normalization.
- Participant `ChatRun` records, participant transcript metadata, run queue
  rows, and runtime lifecycle events now freeze the dispatch participant,
  lane, role, stage role, and posture metadata where available.
- Run queue rows saved through the repository now carry a `dispatchReceipt`
  hash that spans the frozen provider, source, chat/workspace, ensemble
  lane/stage, workflow mode, remote-composer workflow posture, and
  permission-posture proof fields available at enqueue time. Direct remote
  composer enqueues that bypass the generic IPC normalizer are stamped at the
  repository boundary.
- Remote queued composer receipts now include the enqueue-time remote allowlist
  decision and a stable allowlist policy fingerprint for the effective
  workspace/provider/approval/capability gate.
- Workflow-backed scheduled tasks now preserve `workflowMode` and carry a
  schedule-time `dispatchReceipt` that freezes their scheduled source,
  chat/workspace, provider, approval mode, and workflow mode.
- Scheduled tasks saved through the main IPC boundary, materialized from
  workflows, or backfilled as older due tasks now receive a main-signed
  permission posture snapshot before broadcast/dispatch. Their dispatch receipt
  hashes the posture and records signature presence; renderer-supplied
  `permissionPosture` / `dispatchReceipt` fields are stripped by the sanitizer.
- Scheduled task dispatch receipts now have regression coverage proving the
  signed schedule-time posture remains authoritative when mutable approval-mode
  fields change before the task is marked running.
- Redacted diagnostics/audit export now includes queued and scheduled
  `dispatchReceipt` summaries, with chat/thread ids hashed and remote-composer
  text omitted.
- Lifecycle dequeue tickets and steer-promotion handoffs now carry the queued
  `dispatchReceipt`, so renderer-dispatched deferred runs keep the enqueue-time
  proof attached through claim/lease.
- Runtime session lifecycle events now attach the queued `dispatchReceipt` when
  a matching run queue row exists, so durable run-start/update/remove events
  retain the enqueue-time proof.
- Runtime session lifecycle events also fall back to a matching scheduled task
  `dispatchReceipt`, so non-queued scheduled runs carry their signed scheduled
  posture proof into run-start/update/remove durable events.
- MCP tool context for brokered Codex/Claude/Kimi runs carries `ensembleRun`,
  so lane-aware write-lock previews and acquisitions can enforce against the
  dispatched lane instead of losing identity outside Gemini.
- Approval previews for ensemble services now include lane and stage role when
  present.
- Ensemble wakeup records now freeze the participant role and stage role at
  schedule time, including an explicit "unstaged" marker for new records, and
  active/restarted wakeup resume uses that frozen identity instead of inheriting
  later live-roster stage edits.
- Ensemble wakeups now carry a schedule-time `dispatchReceipt` that hashes the
  frozen chat/workspace, provider, participant, role, and stage identity used on
  resume.
- Ensemble wakeups now carry a schedule-time signed permission posture snapshot,
  and their dispatch receipt hashes that posture alongside the frozen
  participant identity.
- Ensemble wakeup replay now has higher-level coverage proving a frozen
  reviewer/worker stage and role are honored when the live roster changes before
  the wakeup fires or after an app restart.
- Remote queued dispatch now freezes a queue-time signed permission posture and
  includes that posture hash/signature presence in its dispatch receipt, alongside
  the allowlist decision and policy fingerprint.
- Remote queued dispatch also revalidates the current bridge allowlist when a
  queued item is dequeued, failing the queue job if the workspace/provider
  `startTurn` grant was revoked after enqueue.
- Codex native approval preflights and host-rerun approval requests now carry
  the same Ensemble participant/lane/stage metadata in approval cards and audit
  ledger entries as the central brokered approval path.

What is missing:

- Stage-role scheduling intent now has a first-class frozen receipt and signed
  posture proof across queue rows, workflow-backed scheduled tasks, direct
  scheduled tasks, and Ensemble wakeups; the remaining work is policy-choice
  testing for resume-time revocation vs frozen scheduled intent.
- Remote queued dispatch now has both an enqueue-time posture/allowlist receipt
  and a dequeue-time allowlist re-check; remaining work is broader lifecycle
  export review, not the replay authorization gate itself.
- Verified elevated scheduled dispatch now has coverage that distinguishes
  frozen scheduled intent from current managed policy: the scheduled run can
  keep its verified elevation, but the effective service posture is still
  resolved against the current policy and signed with any revocations applied.
- `EnsembleRunIdentity`, `ChatRun`, run queue metadata, approval previews, and
  run events now persist live dispatch `stageRole`/`laneId`; scheduled-task
  receipts now have signed posture coverage, and elevated scheduled composer
  dispatch now proves current managed-service revocation is reflected in the
  signed effective posture.
- Remaining native-provider work is a broader provider-by-provider audit beyond
  Codex: verify every future native command/approval seam either routes through
  the central gate or stamps equivalent participant/lane metadata.

Target:

- Freeze participant id, provider, role, stageRole, permission preset,
  workflowMode, and posture proof on queued/scheduled/wakeup dispatch records.
  The queue/scheduled/wakeup record-level receipt is in place; keep the next
  work focused on end-to-end replay policy tests rather than adding parallel
  receipt schemas.
- Persist a dispatch receipt when the run starts and include it in audit export.
  Queued and scheduled runtime lifecycle events now retain that receipt; keep
  future work focused on exported summaries and replay-policy tests.
- Preserve older-client semantics: absent `stageRole` means preserve; `''` means
  explicit clear.
- Add higher-level dequeue integration tests that enqueue a remote prompt,
  revoke workspace/provider or approval access before the queue pumps, and
  assert the denial audit path end to end. The pure replay authorization helper
  now has coverage for the current-policy deny decision.
- Keep scheduled-task dispatch tests explicit about the split between frozen
  scheduled intent and current live policy. Managed service revocation is pinned
  for elevated scheduled composer dispatch; remaining remote-policy coverage
  should focus on any future scheduled entry point that is actually remote-gated.
- Preserve `stageRole` and `laneId` through run normalization, `ChatRun`,
  queue jobs, approval previews, and run events.

### B5.6 - Run-time provider tier receipts

What exists:

- Ollama computes a run-start tool-control tier and advertises tools from that
  tier.
- The local tool request carries a `toolControlTier` field.
- The local execution gate now prefers that request-carried run-start tier and
  falls back to live settings/chat metadata only for callers that do not carry a
  tier.

What is missing:

- If product policy wants mid-run revocation instead of frozen run receipts,
  revocation still needs to be explicit and audited.

Target:

- Keep the run-start tier as the default execution receipt.
- Add explicit revocation events later only if managed policy requires live
  cancellation of an active Ollama tool surface.

### B5.7 - Stage-role desktop mutation parity

What exists:

- Roster/preset editing and bridge editing can carry stage role.
- Desktop participant seat changes now recognize, apply, clear, and label
  `stageRole`.

What is missing:

- Stage-role dispatch receipts are still tracked under B5.5.

Target:

- Keep stage-only set and clear covered through participant seat-change tests.

### B5.8 - Provider capability caveat pinning

Shipped in `a683ec16e`.

What exists:

- Dynamic capability contracts are explicit about Cursor/Grok write-mode bridge
  injection.
- Static provider descriptors now carry serializable capability caveats for
  Cursor and Grok explaining that the full TaskWraith MCP bridge is mode-scoped:
  read-only runs do not advertise it by default, while write-capable runs
  auto-inject a governed bridge.
- Descriptor tests now cover Cursor and Grok alongside the older provider set
  and assert the caveat survives descriptor projection.

What is missing:

- No B5.8-specific blocker remains. Future UI work can choose how prominently
  to render `capabilityCaveats`.

Target:

- Keep static descriptor caveats aligned with dynamic capability contracts when
  provider bridge behavior changes.

### B5.9 - Human feedback and casting receipts

Design posture:

- Treat each thumb as a local human casting receipt, not vague product
  telemetry. The vote is attached to a concrete assistant message and should be
  resolvable to the provider, model, role, run, chat, and workspace that
  produced it.
- Use the receipt to improve future cast decisions and to explain them later.
  A negative vote should be able to count against the model-in-role for similar
  work; a positive vote should be able to count as a good example.
- Do not present thumbs as audit-grade. The durable receipt layer is useful
  local casting evidence, but it is still a mutable, privacy-respecting local
  store rather than an append-only tamper-evident audit log.

What exists:

- The thumbs UI capture layer is shipped and persists a message-local feedback
  state.
- `saveChat` now harvests assistant-message feedback into a hard-capped
  `thumbs-ledger.json` receipt store. Receipts include set/flip/update
  semantics and attribution to chat, workspace, message, run, provider, model,
  and ensemble role/lane/stage role when available. Clearing a rating, deleting
  a rated message, deleting a chat, clearing chat history, or disabling local
  chat history removes the corresponding feedback receipts.
- Existing UI-only feedback state is backfilled into the receipt store on the
  next chat save, and repeated saves are idempotent against the latest ledger
  state. The retention cap preserves the newest latest states first and fills
  remaining room with recent history, but never exceeds the configured cap; very
  old feedback state can age out.
- Message attribution can resolve to `(provider, model, role, run)` through
  `message.runId -> ChatRun` for solo and ensemble messages.
- Metadata-only attribution is marked as incomplete, and unchanged ratings can
  refresh into a new update receipt when later saves gain run-backed provider /
  model / role attribution.
- Default diagnostics export redacted feedback summaries and hashes; raw
  receipt ids, message ids, run ids, model labels, role labels, reason codes,
  timestamps, and free-text notes are not exported by default.
- The redacted audit-bundle snapshot builder includes message-feedback receipt
  summaries in the same privacy posture as diagnostics.
- Diagnostics and audit bundles now also include privacy-preserving local
  casting aggregates derived from the latest thumbs-ledger state. These group
  by provider/model/role/stage for local analytics, but exported snapshots hash
  model, role, and reason labels and only expose counts.
- The transcript context menu can attach a closed-set negative reason code
  (wrong approach, hallucinated/wrong, broke something, over-verbose, wrong
  model for role, incomplete) to a poor-rating receipt.
- Sub-thread result reads strip local `metadata.feedback` before returning
  assistant messages to agents, so private human feedback notes are not fed back
  into provider context.
- EvidencePack/capability-ledger substrate exists for cited positive and
  negative evidence, but it is workspace/capability-key oriented and currently
  agent-authored.

What is missing:

- Thumbs are not yet consumed by AgentStats, EvidencePacks, or runtime casting
  decisions. The current bridge is derived analytics only; it does not silently
  mutate other ledgers or task artifacts.
- No "recast this turn with a different model" follow-through exists.
- No iOS parity exists for feedback capture.
- No Settings/UI entry point exists yet; feedback summaries are available
  through the main-process redacted audit-bundle export route.
- No append-only hash chain, actor identity, source-device id, or tamper
  evidence exists for thumbs receipts.

Target:

- Keep the hard-capped `thumbs-ledger.json` receipt store authoritative for
  local analytics. Receipt fields cover vote, timestamp, provider, model, role,
  stage role, run id, chat id, workspace id, original message id, optional
  reason category, and optional note, but default exports must stay redacted.
- Keep `message.metadata.feedback` as the UI pressed-state cache; make the
  ledger the source of truth for analytics. Toggle and flip semantics should
  update both surfaces deterministically; clear/delete semantics should erase
  the local receipt state.
- Keep optional negative reason chips such as wrong approach,
  hallucinated/wrong, broke something, over-verbose, wrong model for role, and
  incomplete flowing into the same local receipt store.
- Feed local AgentStats and future casting/capability ledgers from the receipt
  store rather than treating thumbs as external telemetry.
- Keep feedback local-first. Export only through the redaction/audit-bundle
  pipeline; counts are shareable, free-text notes are sensitive by default.
- Add a recast action that can rerun a disliked turn with a different model or
  seat, with the recast linked back to the original feedback receipt.
- Do not silently mutate AgentStats, EvidencePacks, or Workspace Boards from a
  thumb click. Those systems have different lifecycle and erasure semantics; any
  promotion from feedback into task/evidence artifacts must be explicit.

## Phase order

### Phase 0 - Release honesty checkpoint

Use this phase for the near-term public/internal release.

- Keep B1-B4 shipped and tested.
- Document the remaining B5 blockers without implying managed-enterprise
  completion.
- Avoid old Ollama language that frames local models as capability-restricted
  for safety. The modern contract is parity where available, plus tiered task
  allocation for cost, speed, and context hygiene.
- Ship a release note that distinguishes local safety guarantees from managed
  organization guarantees.

### Phase 1 - Secret hygiene foundation

Do this before broadening user-managed extension claims.

- Add the encrypted user MCP/runtime secret store.
- Keep restrictive file permissions on settings/profile files where practical.
- Wire plugin secrets into MCP materialization and launch-time resolution.
- Add migration + redaction tests.

### Phase 2 - Audit bundle and retention

Do this before claiming audit/compliance readiness.

- Add one export surface that validates and packages the local evidence.
- Extend the Settings/UI retention surface with purge receipt browsing and signed
  bundle verification status.
- Add manifest hashing/signing and verification tooling.
- Update docs to show exactly what is stored, capped, exported, redacted, and
  deleted.

### Phase 3 - Managed policy plane

Do this before enterprise-managed deployment claims.

- Add managed policy loading and effective-settings clamps.
- Lock update channel/auto-update where policy requires it.
- Clamp safety loosening controls and user MCP surfaces.
- Add admin-visible diagnostics explaining which policy source locked each
  control.

### Phase 4 - Deferred dispatch receipts

Do this before presenting staged orchestration as an audit-grade workflow
primitive.

- Freeze participant/stage/posture metadata for queued, wakeup, and scheduled
  ensemble dispatch.
- Include receipts in run events and audit bundles.
- Add tests that mutate the live roster after scheduling and verify the resumed
  run uses the frozen receipt or fails closed.
- Revalidate or freeze remote queue allowlist decisions at dequeue.
- Preserve `stageRole` and `laneId` through run identity normalization and
  write-lock context.

### Phase 4b - Provider tier and capability receipts

Do this before claiming provider parity is fully auditable across local and
brokered providers.

- Freeze or explicitly revoke Ollama tool-control tiers during an active run.
- Keep Cursor/Grok static provider caveats pinned to their dynamic capability
  descriptors.

### Phase 4c - Human feedback receipts

Do this before presenting thumbs as more than local UI state.

- Keep the durable thumbs receipt ledger covered by save-hook tests.
- Add model/role aggregation from the reason-capable receipt store.
- Feed AgentStats and future EvidencePack/casting ledgers from the same receipt
  objects.
- Maintain redacted export and add iOS parity.
- Keep free-text feedback notes out of default exports unless the redaction
  profile explicitly permits them.
- Add recast actions only after receipts can link original turn, recast run, and
  final outcome.

### Phase 5 - Enterprise claim matrix

Finish by updating public-facing docs and ship prep checklists.

- Map every claim to code, tests, and docs.
- Use three labels: "local safety", "audit export", and "managed enterprise".
- Keep unverified provider live-behavior checks as explicit release gates rather
  than burying them in roadmap text.

## Ship checklist

For the current release:

- TypeScript typecheck passes.
- Swift package tests pass when iOS bridge code changes.
- Approval/network/plan/iOS bridge tests pass.
- Release notes mention B1-B4 and call B5 managed-enterprise work remaining.
- No docs claim org-managed retention, SSO/SCIM, MDM policy, or SIEM/WORM audit
  export until those slices land.

For managed enterprise:

- Encrypted secret refs replace plaintext user MCP/runtime secret values.
- Audit bundle export verifies and includes posture proofs.
- Retention and purge receipts are configurable and tested.
- Managed policy clamps safety, updates, MCP, and remote controls.
- Deferred dispatch receipts freeze stage-role and posture intent.
- Provider tier/capability caveats are captured in run receipts and static UX
  descriptors.
- Human feedback is stored as local receipts, not vague telemetry, and exports
  through the same redaction path as other evidence.
- Docs state unsupported areas plainly.
