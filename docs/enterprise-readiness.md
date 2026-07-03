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
  message states on save. Model/role aggregation, reason capture, recast
  actions, export bundling, and iOS parity remain B5 work.

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

What is missing:

- User-managed MCP server `env` and `headers` are not yet wired to secret
  references/status in settings, and existing plaintext records still need
  migration into the encrypted store.
- Runtime profile environment variables are not yet wired to secret
  references/status in profile records; reference-based values still remain
  ordinary profile JSON.
- Plugin `requiredSecrets` are not an end-to-end launch-time secret delivery
  path for MCP materialization.
- Provider/runtime launch paths do not yet resolve `ExtensionSecretStore`
  references into process env or request headers at the final boundary.

Risk:

- A token in an MCP `Authorization` header, MCP env var, or runtime profile env
  can be durable plaintext in user data, copied into generated provider config,
  or exposed through process/config surfaces.

Target:

- Wire the main-process secret store into user MCP and runtime-profile settings.
- Persist only secret references/status in settings/profile records.
- Resolve cleartext only at provider launch and prefer provider-supported env
  indirection over argv or workspace-local config files.
- Warn or reject raw keys matching obvious secret names unless stored through the
  encrypted path.
- Keep a migration path for existing plaintext records that lets users review,
  encrypt, or delete them.

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

What is missing:

- One complete audit bundle for a workspace/thread/run.
- Configurable retention windows for run events, artifacts, approval history,
  audit runs, and diagnostics.
- Export-time tamper evidence across approval ledger, run-event chains, posture
  proofs, evidence packs, and workspace-change summaries.
- A clear separation between redacted-by-default export and explicit
  sensitive-field export.

Target:

- Add `exportAuditBundle` with a manifest, schema version, filters, redaction
  mode, counts, hashes, and validation summary.
- Include approval ledger rows, run-event replay summaries, run-event hashes,
  permission posture proofs, audit runs, evidence/capability ledgers, workspace
  changes, external-publish receipts, thumbs/casting receipts, and diagnostics
  summary.
- Add retention settings and purge receipts.
- Hash-chain or snapshot-hash the approval ledger and sign/verify the exported
  manifest with a local key when available.

### B5.3 - Managed policy plane

What exists:

- Local settings and approval policy are comprehensive.
- Remote/iOS workspace allowlists are per-action and explicit.
- `canvasEval` and future `mediaRecording` are intentionally non-grantable.

What is missing:

- No signed/MDM/env managed policy source.
- No locked controls in Settings for enterprise-managed installs.
- Users can locally change update channel, disable updates, loosen agentic
  services to `allow`, grant workspace/session approvals, enable YOLO, and add
  user-managed MCP servers.

Target:

- Add `ManagedPolicyService` that loads signed or MDM-delivered policy, computes
  effective settings, and exposes which controls are locked.
- Clamp agentic service policy, workspace grants, approval timeouts, YOLO,
  update channel, auto-update, bridge access, and user-managed MCP according to
  managed policy.
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
- Audit/previews redact values for display.

What is missing:

- No managed policy source feeds the allowlist yet, so default behavior remains
  permissive for existing user settings and provider launches.
- The allowlist is launch-time only. Save-time validation, locked Settings UI,
  and plugin materialization policy still need the B5.3 managed-policy plane.
- Plugin provenance checks are syntactic until a managed policy service
  revalidates installed plugin state, resource kind, object id, and manifest
  hash.
- Command-root checks are a launch allowlist, not a sandbox; symlink/realpath
  validation and argument policy need to come with managed policy enforcement.
- Remote checks currently gate host patterns, not full URL egress policy for
  scheme, port, path, userinfo, or DNS-rebinding behavior.
- Long-lived provider app servers, especially Codex app-server, need an
  explicit restart or re-materialization path before mid-session policy changes
  can remove previously attached user MCP servers.
- Blocked-server reasons are callback-ready but are not yet written into
  diagnostics or audit bundles.

Target:

- Feed the launch allowlist from managed policy, then enforce compatible checks
  at sanitize/save time and again at launch time.
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
- Audit bundle export does not yet include external-publish receipts.

Target:

- Keep all external publication origins (`desktop-ui`, `ios-bridge`, and
  `agent`) on the shared receipt ledger so audit/export work has one schema.
- Keep the bridge `externalPublish` capability explicit and admin-only.
- Include external-publish receipts and bridge audit rows in the future audit
  bundle export.

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
- Do not present thumbs as audit-grade or enterprise-exportable until the
  durable receipt layer exists. `message.metadata.feedback` is only the pressed
  state cache for the row UI.

What exists:

- The thumbs UI capture layer is shipped and persists a message-local feedback
  state.
- `saveChat` now harvests assistant-message feedback into a bounded
  `thumbs-ledger.json` receipt store. Receipts include set/flip/clear/update
  semantics and attribution to chat, workspace, message, run, provider, model,
  and ensemble role/lane/stage role when available.
- Existing UI-only feedback state is backfilled into the receipt store on the
  next chat save, and repeated saves are idempotent against the latest ledger
  state.
- Message attribution can resolve to `(provider, model, role, run)` through
  `message.runId -> ChatRun` for solo and ensemble messages.
- EvidencePack/capability-ledger substrate exists for cited positive and
  negative evidence, but it is workspace/capability-key oriented and currently
  agent-authored.

What is missing:

- Thumbs are not yet harvested into AgentStats, EvidencePacks, casting records,
  or exportable audit bundles.
- No optional reason taxonomy UI exists for negative feedback.
- No "recast this turn with a different model" follow-through exists.
- No iOS parity exists for feedback capture.

Target:

- Keep the bounded, capped `thumbs-ledger.json` receipt store authoritative for
  analytics and export. Receipt fields cover vote, timestamp, provider, model,
  role, stage role, run id, chat id, workspace id, original message id, optional
  reason category, and optional note.
- Keep `message.metadata.feedback` as the UI pressed-state cache; make the
  ledger the source of truth for analytics and export. Toggle, clear, and flip
  semantics should update both surfaces deterministically.
- Add optional negative reason chips such as wrong approach, hallucinated/wrong,
  broke something, over-verbose, wrong model for role, and incomplete.
- Feed local AgentStats and future casting/capability ledgers from the receipt
  store rather than treating thumbs as external telemetry.
- Keep feedback local-first. Export only through the redaction/audit-bundle
  pipeline; counts are shareable, free-text notes are sensitive by default.
- Add a recast action that can rerun a disliked turn with a different model or
  seat, with the recast linked back to the original feedback receipt.

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
- Enforce restrictive file permissions on settings/profile files where
  practical.
- Wire plugin secrets into MCP materialization and launch-time resolution.
- Add migration + redaction tests.

### Phase 2 - Audit bundle and retention

Do this before claiming audit/compliance readiness.

- Add one export surface that validates and packages the local evidence.
- Add retention settings and purge receipts.
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
- Add reason capture and model/role aggregation.
- Feed AgentStats and future EvidencePack/casting ledgers from the same receipt
  objects.
- Add redacted export and iOS parity.
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
