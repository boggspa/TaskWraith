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

What is missing:

- Renderer settings forms are not yet wired to use the secret status/mutation
  IPC instead of raw user MCP env/header values.
- Runtime profile settings surfaces are not yet wired to create/manage encrypted
  env refs directly.
- Plugin `requiredSecrets` are not an end-to-end launch-time secret delivery
  path for MCP materialization.
- Renderer and iOS settings surfaces are not yet wired to create or manage
  those encrypted refs directly.

Risk:

- A token in an MCP `Authorization` header, MCP env var, or runtime profile env
  can still be durable plaintext if it does not match the conservative
  migration heuristic, if encrypted storage is unavailable, or if a renderer
  settings form writes around the secret status/mutation flow.

Target:

- Wire the main-process secret store into user MCP and runtime-profile settings.
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
- Main/preload expose `purgeProductAuditRetention`, backed by opt-in
  `auditRetention` settings. It can dry-run or purge expired approval history,
  run-event files and artifacts, workspace-change records, audit runs,
  message-feedback receipts, external-publish receipts, and product-crash
  diagnostics. Live approval grants are preserved even when older than the
  retention cutoff.
- Each purge writes a capped `audit-retention-purges.json` receipt with
  counts-only, path-redacted evidence of what was scanned, retained, and
  deleted. Diagnostics and audit-bundle export include those purge summaries.
- Audit-bundle exports are now signed when Electron `safeStorage` is available:
  a long-lived Ed25519 key is generated once under `userData`,
  safeStorage-encrypted at rest, and reused so each exported bundle carries a
  `local_hashes_signed` manifest signature. Verification recomputes section
  hashes/counts and validates the signature over the final sanitized snapshot.
  If no protected key can be created, the export remains explicitly marked
  `local_hashes_unsigned`.

What is missing:

- A Settings/UI entry point for `exportProductAuditBundle`; the export route is
  callable through preload but not yet exposed as a polished control.
- A Settings/UI entry point for configuring `auditRetention` and invoking
  retention dry-run / purge. The main/preload route exists, but the control
  surface is not polished.
- A polished verification/export UI around the signed bundle evidence. The
  signer and verifier exist in main code and tests, but the user-facing control
  surface is still only the preload route.
- A clear separation between redacted-by-default export and explicit
  sensitive-field export.

Target:

- Add a Settings/UI entry point around the existing `exportProductAuditBundle`
  route, with explicit workspace/thread/run filter controls.
- Add Settings/UI controls for audit retention windows and purge dry-runs.
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
  JSON from `TASKWRAITH_MANAGED_POLICY_JSON` or
  `TASKWRAITH_MANAGED_POLICY_PATH`, compute locked/enforced setting keys, apply
  a startup clamp before update-service configuration, and filter future
  `SettingsService` writes. The first clamp surface covers update channel,
  auto-update, bridge enablement, Codex sandbox fallback, agentic-service
  policy, approval timeouts, user MCP servers (disable-only), and workspace
  grants (clear-only). Diagnostics export reports a redacted policy status
  summary.
- Session YOLO enablement is clamped when managed policy controls agentic
  service policy, workspace grants, or approval timeouts. The local IPC setter
  and paired-device bridge toggle return a managed-blocked state instead of
  enabling the in-memory session override.

What is missing:

- No signed or MDM-delivered managed policy source yet; the current source is
  local env/path JSON for managed test deployments.
- No locked-control affordances in Settings for enterprise-managed installs.
  Enforcement exists, but the UI does not yet explain why a control is locked.
- Other non-settings live controls still need explicit inventory and managed
  clamps. The current policy source is startup-loaded, so future live policy
  reload support must also revoke or re-materialize affected in-memory state.
- User MCP policy has launch-time and save-time managed allowlist enforcement.
  Locked Settings UI and deeper plugin provenance revalidation still land under
  B5.4.

Target:

- Promote the env/path policy format to a signed or MDM-delivered policy source,
  retaining the same effective-settings clamp seam.
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
  transports, stdio command roots, remote URL hosts, header names, env keys,
  and plugin provenance / plugin ids, and can report blocked-server reasons to
  callers.
- The managed-policy spine now accepts a `userMcpLaunchAllowlist` block and
  feeds it into the Claude, Cursor, and Codex user-MCP launch materialization
  paths. Diagnostics report only allowlist shape/counts, not the configured
  roots, hosts, headers, env keys, or plugin ids.
- Settings writes now apply the same managed user-MCP allowlist before
  persistence. Servers that fail the allowlist are preserved but saved disabled,
  so the user does not lose configuration while launch bypasses remain closed.
- Stdio command-root checks canonicalize existing commands and roots through
  realpath before allowlist comparison, blocking symlinks that point outside the
  managed root.
- Diagnostics and audit-bundle exports now include redacted
  `userMcpBlockedServers` evidence when the managed launch allowlist blocks
  enabled user MCP servers. Server ids/names and raw header/env names are
  hashed; the export carries reason categories, counts, and section hashes.
- Audit/previews redact values for display.

What is missing:

- Locked Settings UI and plugin materialization policy still need to sit on the
  B5.3 managed-policy plane.
- Plugin provenance checks are syntactic until a managed policy service
  revalidates installed plugin state, resource kind, object id, and manifest
  hash.
- Command-root checks are a launch allowlist, not a sandbox; argument policy
  still needs to come with managed policy enforcement.
- Remote checks currently gate host patterns, not full URL egress policy for
  scheme, port, path, userinfo, or DNS-rebinding behavior.
- Long-lived provider app servers, especially Codex app-server, need an
  explicit restart or re-materialization path before mid-session policy changes
  can remove previously attached user MCP servers.

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
- MCP tool context for brokered Codex/Claude/Kimi runs carries `ensembleRun`,
  so lane-aware write-lock previews and acquisitions can enforce against the
  dispatched lane instead of losing identity outside Gemini.
- Approval previews for ensemble services now include lane and stage role when
  present.

What is missing:

- Stage-role scheduling intent is not yet a first-class frozen receipt across
  every deferred path; this slice covers live participant dispatch and generic
  queue rows, not every scheduled/wakeup replay path.
- Ensemble wakeups and scheduled ensemble occurrences still need explicit
  proof that they resume the participant/stage/posture that was scheduled, not
  whatever a mutable live roster happens to contain later.
- Remote queued dispatch persists the raw request shape but not an enqueue-time
  signed posture, allowlist decision, or allowlist fingerprint. Dequeue replay
  rebuilds a wire action and dispatches directly, so it must either re-run the
  bridge router's allowlist decision or use an explicitly frozen signed posture.
- `EnsembleRunIdentity`, `ChatRun`, run queue metadata, approval previews, and
  run events now persist live dispatch `stageRole`/`laneId`, but there is still
  no dedicated dispatch receipt object or receipt hash spanning those fields.
- Native provider approval paths still need a separate lane-aware bypass audit
  for host reruns / native command approvals outside brokered MCP tools.

Target:

- Freeze participant id, provider, role, stageRole, permission preset,
  workflowMode, and posture proof on queued/scheduled/wakeup dispatch records.
- Persist a dispatch receipt when the run starts and include it in audit export.
- Preserve older-client semantics: absent `stageRole` means preserve; `''` means
  explicit clear.
- Add dequeue tests that enqueue a remote prompt, revoke workspace/provider or
  approval access before the queue pumps, and assert either a deny with audit or
  the intended frozen posture is used.
- Add ensemble wakeup tests that schedule as a reviewer, mutate the live roster
  to worker/default before firing, and verify the resumed run uses the frozen
  snapshot or records an explicit current-policy-at-resume decision.
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

- Thumbs are not yet harvested into AgentStats, EvidencePacks, or casting
  records.
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
- Add Settings/UI around the main-process retention settings and purge receipts.
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
