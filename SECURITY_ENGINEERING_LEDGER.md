# Security Engineering Ledger

This ledger keeps release-sensitive security findings in the tracked source
tree. An entry records a code-verified risk or a bounded hypothesis; it does not
by itself assert exploitation, data loss, or a reportable security incident.
Confirmed vulnerabilities should still follow the private reporting process in
[SECURITY.md](SECURITY.md).

The original evidence was assessed on **2026-07-19** at commit
`87c8c0645a4d9d8a6a2c3c8e0f3646cfac05b0da`. Dated remediation updates below
also inspect the source-ahead working tree from that period. The 2026-07-21
notes below retain the historical v1.8.5/v1.8.6 ship-prep boundary: Path-B
Cursor (TW-SEC-2026-003) shipped in 1.8.5 with residual partial-backstop
disclosure, and TW-SEC-2026-014 moved from `Open` to `Remediated` after its
multi-store completeness pass. Those dated notes are provenance, not the
current release pointer.

**2026-07-27 v1.9.0 paperwork boundary:** the latest published baseline is
**v1.8.9** (`0867c80c2ec50a9429ccfb6885462bff5c4149bb`). The first reconciled
1.9.0 feature tip was `ce8c0c76d` (**178 commits** past that tag), with
release-paperwork commits following it. The requested first refresh reached
concurrent-work cutoff `de6dcd264` (**202 commits** past the tag, with three
refresh-paperwork commits interleaved). This second paperwork pass opened at
`3bf7bbca3` (**236 commits** past the tag, 31 committed changes after the prior
paperwork tip `d46229e8a`), after surface-scoped Canvas grants, durable
`canvas_fill` value redaction, per-call theme consent, Mistral UI/live-lane
evidence, Pi attribution, and a scoped history-deletion deadline attempt
landed. The final paperwork reconciliation opened at `37c60cfeb` (**261
commits** past the tag, 21 commits after second-pass paperwork tip `4089a9637`).
That late committed range adds repair-oriented Ensemble skip reasons, an
opt-in Codex credential lease, consent-gated product observation and volatile
presence, exhaustive provider selection, complete usage/rate-table projection,
a normal two-seat Ensemble floor, clearer People collaboration diagnostics,
and official provider identity assets. No foreign ship-hold marker was present
at that opening snapshot; 51 unrelated working-tree paths plus this pass's own
marker kept the tree dirty. During the pass the committed tip advanced through
`dd27996e6` (**267 commits** past the tag), adding per-device APNs environment
repair, guarded build-time feature flags, one completion-banner renderer, and
local/APNs-updated Live Activities including delayed push-to-start. At that
late-refresh snapshot the foreign working tree had cooled to two paths plus
this pass's marker, with no foreign ship hold. The tracked changelog and public
privacy-policy slices then reached `4f2e87fec` (**269 commits** past the tag).
This is still a mutable source-ahead snapshot, not a freeze: every per-entry
verify/`Block` disposition stays in force, and the exact integrated candidate
must be re-recorded and verified before a release claim. References use stable
symbols and test names rather than line numbers. Do not add secrets, raw
scripts, or weaponized payloads to this file or its verification artifacts.

## Working rules

- Severity is engineering triage, not a CVSS score.
- Status is one of `Investigating`, `Open`, `Remediated`, `Verified`, `Accepted`,
  or `Closed`.
- `Remediated` means the source-ahead candidate contains a bounded fix. It does
  not mean that the fix is released or that the exact integrated candidate has
  passed its full gate.
- Do not delete an entry when work lands. Add a dated update, preserve the
  original evidence, and link the regression or live-verification artifact.
- A named owner must replace `Unassigned` before remediation begins.
- `Block` is release-only authority: the finding must be disproved, remediated,
  verified, or explicitly accepted by the informed user before the next public
  release candidate is approved. It does not authorize an engineer or agent to
  hide, remove, or narrow the affected capability; capability changes still
  require the user's explicit approval under `AGENTS.md`.
- **An entry is a record, not a standing instruction.** Because entries are
  never deleted, most of this file is history: superseded hypotheses, interim
  postures that were later reversed, and residual risks that were weighed and
  accepted. Read an entry top to bottom, including its dated updates, before
  acting — the disposition at the end governs, not the heading. Where an entry
  carries a **Current state** note, that note is the posture; everything above
  it is provenance.
- **Do not re-remediate a remediated finding.** Re-opening one requires NEW
  evidence against the current source — a failing test, a reproduction, a
  changed dependency — not a fresh reading of the original evidence. An agent
  that re-derives a closed finding from the same facts and then removes,
  gates, or narrows a shipped capability has caused a regression, not a fix.
  TW-SEC-2026-003 is the worked example: a correct finding produced a
  fail-closed provider removal that was subsequently reversed, and its heading
  still describes a boundary the 2026-07-22 update closed.
- **`Accepted` means the informed user already weighed it.** Accepted residual
  risk is a decision, not an unfinished task. Disclose it; do not silently
  re-litigate or "fix" it into a capability change.

| ID | Finding | Severity | Status | Owner | Release disposition |
| --- | --- | --- | --- | --- | --- |
| TW-SEC-2026-001 | Desktop same-provider mention could route to an order-selected seat | High | Remediated | TaskWraith maintainers — Ensemble routing | Verify on the exact candidate tip before clearing the block |
| TW-SEC-2026-002 | `canvas_eval` exact scripts and results could enter first-party durable history without an approval-bound receipt | Medium | Remediated | TaskWraith maintainers — Canvas/audit | Verify every first-party durable sink; do not broaden the privacy claim beyond the tested boundary |
| TW-SEC-2026-003 | Authenticated Cursor startup can preload provider-managed execution surfaces before a turn | High | Remediated (Path-B re-entry) | TaskWraith maintainers — Cursor runtime | Ship Path-B contained `--sandbox` argv only; never bare uncontained spawn; disclose partial-backstop residual risks |
| TW-SEC-2026-004 | A signed-elevated approval could be accepted after cancellation or history-clear authority ended | High | Remediated | TaskWraith maintainers — Approval lifecycle | Verify the exact integrated cancellation/clear gate before release |
| TW-SEC-2026-005 | Conflicting compatibility aliases could evade `canvas_eval` redaction or result correlation | Medium | Remediated | TaskWraith maintainers — Canvas compatibility/audit | Verify all provider adapters and durable compatibility lanes on the candidate |
| TW-SEC-2026-006 | Provider-authored Canvas receipts could contaminate forensic attribution | Medium | Remediated | TaskWraith maintainers — Canvas receipt authority | Verify native and gateway paths use only host-minted receipts |
| TW-SEC-2026-007 | Canvas operations and live surfaces can outlive run cancellation or scoped history erasure | High | Remediated | TaskWraith maintainers — Canvas lifecycle | Source candidate accepted; verify the exact integrated scoped-erasure matrix before release |
| TW-SEC-2026-008 | Kimi production containment had check/use races around workspace config and client filesystem authority | High | Remediated | TaskWraith maintainers — Kimi runtime | Verify the exact integrated production composition and live native trace before clearing the block |
| TW-SEC-2026-009 | Concurrent Kimi OAuth refresh and writeback was not serialized or crash-replayable | Medium | Remediated | TaskWraith maintainers — Kimi authentication | Source candidate accepted; packaged Kimi now admits as labelled unattested-development (2026-07-21 update) — reviewed qualification remains externally commissioned |
| TW-SEC-2026-010 | Unknown Kimi runtime builds lacked an enforced normal-seat admission fence | High | Remediated | TaskWraith maintainers — Provider qualification | Source candidate accepted for managed ACP seats; scheduled Kimi remains available with an explicit unsealed receipt until its exact launch-plan handoff is wired, while packaged Kimi admits as labelled unattested-development pending reviewed qualification (2026-07-21 update) |
| TW-SEC-2026-011 | Provider diagnostics exposed live broker bearer tokens and local prompt/path data | High | Remediated | TaskWraith maintainers — MCP bridge and Kimi ACP diagnostics | Source candidate and focused bridge suite accepted; whole-tree and exact packaged verification remain pending |
| TW-SEC-2026-012 | Durable Kimi seat homes preserved unknown provider-created top-level artifacts | High | Remediated | TaskWraith maintainers — Kimi isolated-home lifecycle | Verify the strict continuity allowlist on the exact candidate; unknown builds now admit as labelled unattested-development rather than being fenced (2026-07-21 update) |
| TW-SEC-2026-013 | A provider dispatch can outlive the chat/history authority observed before asynchronous preflight | High | Remediated | TaskWraith maintainers — Run admission and history mutation | Source candidate accepted; verify the exact integrated lifecycle matrix before release |
| TW-SEC-2026-014 | Multi-store history deletion was best-effort and an internal orphan reaper bypassed lifecycle fencing | High | Remediated | TaskWraith maintainers — Data lifecycle and history erasure | Source candidate accepted 2026-07-21 (host-command, cancel/delete, Codex app-server joins closed; reaper fenced; checkpoint/collaboration stores joined); rerun exact-candidate whole-tree gates, preserve the provider-native/same-UID boundaries, and clear the related TW-SEC-2026-020 timeout regression before any release-level erasure claim |
| TW-SEC-2026-015 | A partial workflow rerun could refresh stale provider-attestation freshness without rerunning the live canary | High | Closed | TaskWraith maintainers — Release attestation | Closed by removal 2026-07-21: the hosted attestation apparatus was deleted by user decision (capability governance); fix preserved as provenance |
| TW-SEC-2026-016 | Usage journals retain content and scope identifiers outside the history-erasure transaction | High | Remediated | TaskWraith maintainers — Usage privacy and data lifecycle | Source candidate accepted; run exact-candidate whole-tree gates before clearing the release block |
| TW-SEC-2026-017 | `canvas_fill` typed values entered durable approval and run-event history despite the tool's non-retention contract | Medium | Remediated | TaskWraith maintainers — Canvas approval privacy | Forward-only source fix accepted; verify every approval ingress/durable sink and keep the existing-history disclosure before clearing the block |
| TW-SEC-2026-018 | A Canvas interaction grant applied beyond the exact surface the user approved | High | Remediated | TaskWraith maintainers — Canvas and approval authority | Verify surface identity on request, response, run-attached, fallback, and legacy-grant paths before clearing the block |
| TW-SEC-2026-019 | Theme writes could inherit an unrelated MCP grant, while writable spacing influenced consent-control adjacency | High | Remediated | TaskWraith maintainers — Appearance and consent surfaces | Verify every-call human prompting and the structural consent-row guard on the exact candidate before clearing the block |
| TW-SEC-2026-020 | The scoped history-deletion deadline rejects without retiring the durable intent or releasing retained holds | High | Remediated | TaskWraith maintainers — Data lifecycle and history erasure | **Permit 1.9.0:** exact-candidate delayed-sink matrix and whole-tree gates prove no late commit, exact hold reconciliation, retained durable intent, and a clean same-process retry |

## v1.9.0 release-boundary update — 2026-07-26

This release adds security-relevant surface and records three newly remediated
consent/retention findings plus one open history-lifecycle blocker:

- Isolated fan-out worktrees return durable candidates through explicit patch
  capture, comparison, and promotion contracts rather than silently merging a
  lane into the shared checkout. The candidate boundary is implemented in
  `FanoutCandidateService`, `FanoutCandidatePersistence`, and the
  `fanoutCandidateHandlers` IPC surface.
- Peer-thread messages cross independent top-level sessions through a
  permission-gated durable ledger. Delivery is labelled untrusted, enters the
  next provider turn exactly once, and keeps the optional wake as a separate
  authority; see `ThreadMessagePermission`, `ThreadMessageLedger`, and
  `ThreadMessageContext`. The three `thread-message:*` IPC channels are now
  listed explicitly as main-renderer-only in `RendererIpcPolicy`; this records
  the already-enforced boundary that renderer-originated sends are treated as
  user-authored and therefore do not take the agent-approval path.
- Pi's bring-your-own-key upstreams use a dedicated key store, isolated runtime
  homes, launch authority, model policy, and native-tool posture. This extends
  the provider surface, so secret-boundary and exact-launch evidence still
  belong in the final candidate verification.
- Mistral Vibe is now a tenth stable provider identity and a live ACP seat
  backed by the user's Mistral plan, distinct from Pi's metered `mistral/*`
  upstream. The approved live-set intent and hand-mirrored iOS membership land
  with the production adapter/dispatch route. The seat selects only Vibe's
  gated `plan`/`default` modes, scrubs inherited Mistral API credentials,
  re-checks launch authority across asynchronous pre-spawn boundaries, and
  injects host-composed context into each fresh session. An opt-in live
  `vibe-acp 2.22.0` exercise now proves the ordinary lane can carry non-empty
  client identity, accept Plan plus Devstral Small over the protocol, use the
  scrubbed plan-credential lane, answer, and close cleanly. It does not clear
  scheduled launch evidence: `SealEvidenceMistral` still reports blocked
  production wiring until session-mode acknowledgement and the final
  provider-visible steered prompt are bound. Do not translate that receipt
  into provider removal.
- Codex can now borrow the user's existing `~/.codex` sign-in only after the
  user enables the dedicated provider setting. The credential is leased into
  TaskWraith's isolated Codex home for one app-server lifetime rather than
  copied as a second independent refresh token; rotation is committed back
  monotonically, a concurrent borrower is refused, and release removes only
  the borrowed credential. No credential or no available lease degrades to the
  existing isolated behavior instead of failing an otherwise viable launch.
  Re-run `CodexOAuthCredentialLease.test.ts` and
  `CodexAppServerCredentialLease.test.ts` on the exact candidate.
- First-party product observation is an affirmative-choice surface, not a
  condition of using the app. Until the user selects Share, the stored
  preference stays off and no check-in or presence request is made. An enabled
  daily check-in has one fixed no-content schema and no stable installation
  identifier; the random live-presence lease is process-only, renewed while
  running, and specified to exist only in receiver memory for 150 seconds.
  Builds without an endpoint send nothing, and withdrawing consent stops
  renewals without disabling a feature. The complete field, retention,
  network-metadata, and purpose contract is public in `PRIVACY.md`; exact-tip
  verification must include `ActivityReportingService.test.ts`,
  `AppStoreSettings.test.ts`, and the first-launch choice tests.
- The normal Ensemble UI now treats two seats as the live panel floor: enabling
  Ensemble tops up a solo thread, while removing from a two-seat panel returns
  the thread to the surviving solo seat. Explicit agent-authored and saved
  one-seat rosters remain exempt, preserving stated user/agent intent instead
  of silently rewriting it.
- Human-collaboration surfaces are now labelled People and expose distinct
  invite/live/offline state plus the host audit timeline for admission,
  rejection, deduplication, and draft insertion. The new loopback invitation
  escape is confined to unpackaged, separately identified same-Mac rehearsal
  instances and appears only after the ordinary remote-reachability guard has
  refused the invite; it is not a packaged remote-access bypass or evidence
  that the unrelated-network exercise has passed.
- iOS Live Activities are an explicit, bounded exception to the paired
  companion's ordinary end-to-end-encrypted task projection. ActivityKit must
  decode attributes/content state, so Apple can read the strict allowlist:
  coarse phase and Unix start time; file, addition, and deletion counts;
  provider product names and no more than eight provider/phase seat pairs;
  compiled layout and colour values; and an opaque per-activity reference that
  is not a thread/run id. No privacy-sensitive value—including user-authored
  task/workspace content or a workspace/account-linkable identifier—may ever be
  seeded into this state. Any new field requires a fresh privacy/security and
  public-disclosure review, not a silent “status metadata” expansion.
  Per-activity and push-to-start tokens stay in Mac process memory. APNs
  delivery preserves the device's sandbox/production environment and deletes a
  stored device token only after `410 Unregistered`, not `BadDeviceToken`.
  Exact-tip verification must include `liveActivityPayload.test.ts`,
  `LiveActivityPushFanout.test.ts`, `TWRunActivityTests.swift`,
  `TWRunActivityPlannerTests.swift`, and `TWActivityPreferencesTests.swift`.
- Completion banners now share one closed/versioned rendering contract between
  the foreground app and Notification Service Extension, with preset fixture
  parity across TypeScript and Swift. Re-run
  `CompletionBannerRendererTests.swift`, `TWBannerFixtureTests.swift`, and the
  matching renderer fixture tests on the exact candidate.
- Office codecs operate on bounded document formats, while Outlook device-code
  access is limited to reading mail/calendar context, saving drafts, and
  creating personal time blocks. Release prose must not imply send-mail or
  invite authority; external message and event text remains untrusted.
- Agent-accessed appearance customisation is a typed token-data channel, not a
  CSS/code channel. `theme_tokens_set` remains write-classified; selectors,
  URLs, calculations, provider identity, focus rings, and approval geometry are
  excluded and renderer-side validation re-checks persisted values. The narrow
  main-to-renderer update is revalidated before applying live; its authoring
  commit records the broadcast hop as code-reviewed but not yet proven through
  a real provider tool turn, so retain that check in exact-candidate
  verification. The write tool now forces a human prompt on every call ahead of
  grants, Trusted Session, and Boss/YOLO auto-approval. Consent decision rows
  use literal layout values rather than agent-writable spacing, with a
  structural all-renderer CSS guard to catch future rows and allowlist changes.
- Canvas actuation now serializes interactions per surface, refuses stale
  targets and stale human-input epochs, keeps credential fields human-only,
  preserves an in-progress sketch stroke, and refuses to act while recent
  real input says the user is driving. AppDrive must never observe or actuate
  TaskWraith's own renderer or consent chrome: current Canvas tiers satisfy
  that structurally through isolated `WebContents`, while a future window
  driver must refuse TaskWraith's process by identity. Human-presence delay is
  not a substitute for that boundary. The exact candidate still needs its
  recorded Canvas audit/lifecycle verification. Session grants now bind to the
  exact `canvasId`, omission fails closed, no workspace-wide Canvas interaction
  grant can authorize an interaction, and stored grants from older builds are
  inert. Durable
  approval/run-event projections now redact `canvas_fill` values while the
  transient human prompt still shows the exact proposed text; this fix is
  forward-only, so existing history is not rewritten.
- The new scoped history-deletion deadline prevents a late sink from reaching
  `commitDelete`/`commitTruncate` after the deadline fires, but it does not
  perform the rollback its commit message and source comments cite. The scoped
  coordinator's failure contract retains the durable intent and process-local
  holds, and its production callers simply await the rejection. TW-SEC-2026-020
  therefore remains an explicit 1.9.0 block; no release note claims the stalled
  run gate is fixed.
- Provider run management now records additive lifecycle assurance across all
  ten stable provider identities: immutable launch plans, isolated homes,
  launch evidence, cancellation/settlement, and signed-posture checks improve
  receipts without being used as a provider-admission gate. Production adapter
  registration and renderer/default-model selection now walk that identity
  set exhaustively; an unhandled provider fails its guard or type-check instead
  of inheriting retired Gemini behavior.

No release gate was run or cleared by this documentation pass. Reconcile these
claims against the final clean tip, run each finding's recorded verification,
and preserve the provider-native and same-UID residual boundaries before
clearing any release disposition.

## TW-SEC-2026-001 — Main was not authoritative for desktop mention routing

- **Date:** 2026-07-19
- **Severity/status:** High / `Remediated` (source-ahead candidate; verification pending)
- **Owner:** TaskWraith maintainers — Ensemble routing and desktop IPC authority
- **Original evidence:**
  - The renderer mention path in
    [`ComposerMentionTrigger.ts`](src/renderer/src/lib/ComposerMentionTrigger.ts)
    could turn an ambiguous provider alias into one participant id, while the
    main-process resolver in
    [`EnsembleMentionAlias.ts`](src/main/services/EnsembleMentionAlias.ts)
    rejected ambiguity.
  - Desktop dispatch in [`index.ts`](src/main/index.ts) trusted the renderer's
    `dmTargetParticipantId`; remote dispatch re-resolved the raw prompt in main.
    The two ingress paths therefore had different routing authority.
  - A stale source comment said the picker inserted a stable
    `ensemble-dm://participant-id` link after the executable composer path had
    changed to plain `@Role` text. That documentation/code mismatch also removed
    exact identity from picker-originated mentions.
  - The supplied synthesis recorded two live same-provider `@claude` misroutes.
    They are retained here as evidence from the older build exercised by that
    round, not as a description of the source-ahead candidate. The production
    participant prompt was itself stale: it still taught that an ambiguous bare
    provider alias would choose one panelist non-deterministically.
- **Impact:** Roster order could select the wrong same-provider seat, including
  a seat with a different role or permission posture. This was a
  routing-integrity/confused-deputy risk, not evidence of a sandbox escape.
- **2026-07-19 remediation update:**
  - `resolveEnsembleDmTargetForDispatch` now owns authoritative resolution for
    desktop, remote, and scheduled ingress. Renderer ids are advisory; ambiguous,
    missing, disabled, stale, or prompt-mismatched targets fail before launch.
  - `formatEnsembleDmMention` and retry paths preserve exact participant identity
    in structured links.
  - [`EnsemblePrompt.ts`](src/main/EnsemblePrompt.ts) now states the actual
    fail-closed split: an ambiguous in-round provider mention emits a warning
    and changes no routing, while a new-round directed send is rejected before
    launch. It retains participant-picker and unique role/model guidance rather
    than teaching the older order-selected behavior.
  - Regression coverage lives in
    [`EnsemblePrompt.test.ts`](src/main/EnsemblePrompt.test.ts),
    [`EnsembleMentionAlias.test.ts`](src/main/services/EnsembleMentionAlias.test.ts),
    [`ComposerMentionTrigger.test.ts`](src/renderer/src/lib/ComposerMentionTrigger.test.ts),
    and the directed-run ingress suites.
- **Verification still required:** Run the exact integrated candidate through
  roster-order permutations with conflicting permission presets and a desktop
  E2E that proves the started participant and effective posture are the
  main-resolved values.
- **Release disposition:** `Block` until that candidate-level verification is
  green.

## TW-SEC-2026-002 — `canvas_eval` retention contradicted its audit contract

- **Date:** 2026-07-19
- **Severity/status:** Medium / `Remediated` (source-ahead candidate; verification pending)
- **Owner:** TaskWraith maintainers — Canvas and approval/audit storage
- **Original evidence:**
  - The interactive approval preview carried the exact `script` in its params.
    `createApprovalOrchestration` then copied that preview into both the durable
    run-event payload and approval ledger.
  - `CanvasService.evaluate` recorded an execution digest and outcome without a
    durable approval-id join.
  - The MCP tool contract promised exact interactive review while also saying
    the script and result were never written to audit history. The first claim
    described the UI; the second did not match the original durable payload.
- **Impact:** Agent-supplied JavaScript can contain workspace secrets. The
  original implementation retained it in cleartext in first-party durable
  stores, while its separate hash-only execution event could not prove which
  approval authorized it. No approval bypass was evidenced.
- **2026-07-19 remediation update:**
  - [`CanvasEvalAudit.ts`](src/main/canvas/CanvasEvalAudit.ts) now keeps the exact
    script in the transient desktop payload and projects a minimal schema-v2
    receipt into durable stores: approval id, exact UTF-16-code-unit SHA-256,
    character and byte lengths, redaction marker, and no script/result content.
  - `createApprovalOrchestration` requires a matching host-created receipt
    before registering `canvas_eval`; a missing or mismatched receipt fails
    closed.
  - `CanvasService.evaluate` persists an approval-bound `eval.started` receipt
    before execution and a matching `eval.completed` outcome afterwards. A
    pre-execution persistence failure blocks execution.
  - Integration and sink coverage lives in
    [`CanvasEvalPersistenceIntegration.test.ts`](src/main/canvas/CanvasEvalPersistenceIntegration.test.ts),
    [`CanvasEvalAudit.test.ts`](src/main/canvas/CanvasEvalAudit.test.ts),
    [`CanvasService.test.ts`](src/main/canvas/CanvasService.test.ts), and
    [`CanvasStore.test.ts`](src/main/canvas/CanvasStore.test.ts).
- **Boundary of the claim:** The digest is integrity/correlation metadata, not
  encryption. The candidate covers TaskWraith-owned structured durable sinks;
  provider-authored prose, opaque provider-native history, and external debug
  facilities are not silently promoted into that guarantee. Lifecycle erasure
  residuals are tracked separately in TW-SEC-2026-007.
- **Verification still required:** Put a unique sentinel through every provider
  adapter, direct and gateway invocation, denial, provider-error path,
  diagnostics/export path, and packaged desktop build. Prove that the exact
  transient script is reviewable, all first-party durable copies contain only
  the same approval-bound receipt, and raw results are absent.
- **Release disposition:** Do not clear the finding or repeat the unqualified
  “never logged” claim until the exact candidate passes that full sink matrix.

## TW-SEC-2026-003 — Cursor's authenticated startup surface is outside the broker boundary

- **Date:** 2026-07-19
- **Severity/status:** High / `Remediated` via Path-B re-entry (source-ahead; residual partial-backstop residual risk accepted)
- **Owner:** TaskWraith maintainers — Cursor provider containment
- **Current state (read this before acting on anything below).** Cursor is a
  LIVE, selectable, contained managed provider, and the governed TaskWraith
  broker is wired. The heading and the first two evidence sections describe the
  2026-07-19 hypothesis and the interim fail-closed removal that followed it;
  both are **superseded provenance**, retained per the working rules, not the
  current posture. What is still load-bearing today is narrow and specific:
  `--sandbox enabled` stays hard-pinned on both contained argv builders,
  `--force` is emitted only when the MCP bridge register+enable both succeeded,
  and the residual risks in the 2026-07-20 and 2026-07-22 notes stay disclosed
  rather than denied. Re-removing Cursor, re-gating its spawn per build, or
  narrowing the broker is **not** a remedy this entry asks for, and would be a
  capability change requiring the user's explicit approval under `AGENTS.md`.
- **Original evidence and superseded narrow hypothesis:**
  - The first assessment focused on TaskWraith's then-production Cursor launch:
    workspace MCP merge preserved non-reserved servers while
    `buildCursorCliArgs` supplied `--approve-mcps` and `--force`. Source review
    could not prove whether a preserved project server would execute outside
    TaskWraith mediation, so the impact was initially recorded as conditional.
  - That evidence remains useful history, but it was too narrow. An exact
    authenticated review of the Cursor 2026.07.16 build found provider-managed
    account/team hooks, skills, plugins, and MCP startup sources loading before
    a turn even with fresh HOME/config roots, an empty synthetic workspace,
    `--disable-project-configs`, `--exclude-workspace-context`, and Plan mode.
    This is an authenticated startup-surface finding, not merely a project-MCP
    merge bug.
- **Impact (pre Path-B):** TaskWraith could not bind those opaque startup sources
  to a seat's signed permission posture or audit every resulting action under
  the old uncontained argv path. Fail-closed no-spawn was the interim product
  response.
- **2026-07-19 interim remediation (fail-closed; superseded for product spawn):**
  - `cursorManagedRunAdmission` temporarily denied managed runs; Cursor was
    removed from live-selectable surfaces while historical records stayed
    decodable. That interim product posture is **no longer** the source-ahead
    runtime path (see Path-B re-entry below). The gate module remains as
    qualification/coarse-sync infrastructure and must not be confused with the
    production `runCursorProvider` entry.
- **2026-07-20 Path-B re-entry (initial posture; broker details superseded by
  the 2026-07-22 update below):**
  - Managed Cursor is live again in
    [`LIVE_SELECTABLE_PROVIDER_IDS`](src/shared/retiredProviders.ts).
  - Production `runCursorProvider` is **always-enabled** (no brittle per-build
    fingerprint gate on the spawn path). Containment lives on the argv:
    `buildContainedCursorReadOnlyArgv` / `buildContainedCursorWriteArgv` both
    hard-pin `--sandbox enabled`, seat-route read-only vs write, guard the
    prompt behind `--`, and initially emitted no force / yolo /
    sandbox-disabled / resume-token flags from the production entry.
  - Path B uses the user's real `~/.cursor` login (own-account trust). Account
    skills/plugins/MCP may load but are sandbox-bounded. The initial re-entry
    was native-only (`taskWraithMcpAdvertised = false`); the 2026-07-22 update
    below adds the governed TaskWraith broker without claiming mediation for
    Cursor-native actions.
  - Honest residual risk (accepted, not denied): sandbox is validated primarily
    as a FILE WRITE impact bound for normal project workspaces; a workspace
    placed directly under `$HOME` can leave `$HOME` writable; network egress is
    not proven blocked.
  - Regression anchors include
    [`CursorManagedRunGate.test.ts`](src/main/cursor/CursorManagedRunGate.test.ts)
    (production entry uses contained builders only),
    [`CursorCliArgs.test.ts`](src/main/cursor/CursorCliArgs.test.ts),
    [`ProviderAdapters.test.ts`](src/main/ProviderAdapters.test.ts),
    [`retiredProviders.test.ts`](src/shared/retiredProviders.test.ts), and the
    credentialed live suite
    [`CursorStartupContainment.live.test.ts`](src/main/cursor/CursorStartupContainment.live.test.ts).
- **Release disposition:** Source-ahead may ship Path-B Cursor as a selectable
  managed provider with the residual partial-backstop risks disclosed above.
  Do not reintroduce bare uncontained `cursor-agent` argv or claim TaskWraith
  per-tool mediation for Cursor-native actions. Brokered gateway calls do use
  TaskWraith policy, approval records, and workspace grants. Prefer project
  workspaces outside `$HOME` when untrusted repos matter.
- **2026-07-22 residual-risk update (WS-A MCP un-wall).** `runCursorProvider`
  now wires the "B"-mode TaskWraith broker bridge so Cursor seats can actually
  execute governed MCP tools headlessly (pass-1 finding: policy was
  `mcpTools: allow` but every broker call was client-rejected). The bridge is a
  gated triple — additive-merge register into GLOBAL `~/.cursor/mcp.json`
  (user servers preserved, restored on exit) → `cursor-agent mcp enable` (cached
  only on real success) → argv `--force` via `forceAllowMcpTools:
  cursorMcpBridgeActive`. **`--force` is now a legitimate BRIDGE-GATED production
  token** (previously never emitted): it is emitted ONLY after register + enable
  both succeed. Residual risks, disclosed: (a) the Cursor CLI's `--force` also
  headless-approves NATIVE tools, so RO seats fail closed to no-force if the
  transient `.cursor/cli.json` deny-list write fails, and `cli.json` is restored
  on every exit path via `runCliProviderProcess` `onComplete`; (b) Cursor native
  FS/shell remains OS-`--sandbox`-bounded and POST-EXEC-observed only — it is not
  path-preflightable at a TaskWraith seam (Cursor's stream is observational; see
  the WS-B runtime matrix), so the governed MCP broker path is the honest
  workspace-locked path for Cursor while native stays sandbox-bounded; (c) the
  global-registry write is additive and idempotent (socket token rotates each
  launch). Regression: `CursorStartupContainment.live.test.ts` now asserts
  `--force` is emitted ONLY via `forceAllowMcpTools` and never alongside
  `--yolo`/`--approve-mcps`/`--auto-review`, with `--sandbox enabled` retained.
  Live Cursor seats cannot re-validate the un-wall until an external Dev App
  rebuild; landed evidence is suites + review estimation.

## TW-SEC-2026-004 — Signed-elevated acceptance could race lifecycle revocation

- **Date:** 2026-07-19
- **Severity/status:** High / `Remediated` (source-ahead candidate; verification pending)
- **Owner:** TaskWraith maintainers — Approval lifecycle and history-clear authority
- **Original evidence:**
  - Ordinary cancellation could await a provider interrupt while the run still
    appeared active; terminal-event cleanup revoked approvals only later. A
    desktop acceptance could interleave after the user requested Cancel.
  - Global history clear cancelled a snapshot of pending approvals before
    awaited purge/graph work but had no admission fence preventing a new
    approval from registering during the transaction. Chat delete/truncate had
    the same ordering problem.
  - Strict Canvas ledger resolution treated any non-null record as success, and
    `AppStore.resolveApprovalRequest` could rewrite a recovered or already
    terminal row instead of compare-and-setting only a pending row.
- **Impact:** A signed-elevated action could resume after the user had revoked
  the run or begun erasing its history, undermining cancellation intent and the
  forensic ordering contract.
- **2026-07-19 remediation update:**
  - `cancelProviderRun` claims terminal authority and calls
    `ApprovalService.cancelForRun` synchronously before awaiting transport
    termination.
  - [`HistoryClearAdmissionGate.ts`](src/main/HistoryClearAdmissionGate.ts)
    fences global, workspace, and chat scopes before the first await. New tool
    and approval admission consult that gate; `ApprovalService.registrationBlocked`
    also rejects terminal-claimed runs.
  - `ApprovalService.cancelForRun`, `cancelForWorkspace`, `cancelForChat`, and
    `cancelAll` settle pending provider protocols, resolve durable lifecycle
    decisions, and publish `approval_resolved`.
  - `AppStore.resolveApprovalRequest` now performs a pending-only
    compare-and-set after expiry recovery. `ApprovalService.persistSignedElevatedAccept`
    writes that durable decision before any execution/provider lane resumes.
  - Coverage lives in
    [`ApprovalService.test.ts`](src/main/services/ApprovalService.test.ts),
    [`AuditService.test.ts`](src/main/services/AuditService.test.ts),
    [`AppStoreAuditRetention.test.ts`](src/main/AppStoreAuditRetention.test.ts),
    [`chatHandlers.test.ts`](src/main/ipc/chatHandlers.test.ts), and
    [`NativeCanvasApprovalContracts.test.ts`](src/main/canvas/NativeCanvasApprovalContracts.test.ts).
- **Boundary of the fix:** This closes acceptance of a still-pending approval
  after authority ended. It does not prove that an already-executing Canvas
  operation or live Canvas surface is retired by every lifecycle transition;
  TW-SEC-2026-007 tracks that separate residual.
- **Verification still required:** Exercise delayed Codex/Kimi cancellation,
  global/workspace/chat clear, late native frames, ledger failure, timeout, and
  two-window acceptance against the exact packaged candidate. No path may
  resume execution or leave a zombie approval card after the terminal claim.
- **Release disposition:** `Block` until that integrated lifecycle matrix is
  green.

## TW-SEC-2026-005 — Compatibility alias smuggling could bypass Canvas redaction

- **Date:** 2026-07-19
- **Severity/status:** Medium / `Remediated` (source-ahead candidate; verification pending)
- **Owner:** TaskWraith maintainers — Canvas compatibility and provider event adapters
- **Original evidence:** Provider compatibility events can duplicate tool
  identity under `toolName`, `tool_name`, `tool`, nested envelopes, gateway
  arguments, and multiple result-id aliases. A sanitizer that trusted one
  preferred spelling could classify a decoy non-Canvas identity and persist the
  exact script or a correlated result from another spelling.
- **Impact:** Exact `canvas_eval` scripts or results could leak into raw run
  events, transcript compatibility rows, error caches, or diagnostics despite
  the advertised redaction contract. This was a privacy/audit bypass, not an
  execution-authority bypass.
- **2026-07-19 remediation update:**
  - `sanitizeCanvasEvalCompatPayload` and
    `createCanvasEvalCompatSanitizer` in
    [`CanvasEvalAudit.ts`](src/main/canvas/CanvasEvalAudit.ts) canonicalize every
    explicit identity, inspect known nested/gateway envelopes, correlate every
    supported result-id alias under a run-scoped opaque digest, and fail closed
    on conflicting ids, id-less calls, saturation, malformed JSONL, and delayed
    result-only frames.
  - Durable projections are allowlists; copied provider fields are not spread
    into the safe event. Stateful stdout/stderr sanitizers run before raw
    forwarding or delayed provider-error caching.
  - [`CanvasEvalAudit.test.ts`](src/main/canvas/CanvasEvalAudit.test.ts) covers
    conflicting identity aliases, all result-id aliases, direct/gateway and
    JSON-string envelopes, nested decoys, saturation, split/malformed lines,
    delayed results, and provider-error caches.
- **Verification still required:** Run the same adversarial event corpus through
  every live provider adapter and packaged diagnostics/export path, not only the
  pure sanitizer.
- **Release disposition:** Keep `Remediated`, not `Verified`, until the complete
  adapter matrix is green on the candidate.

## TW-SEC-2026-006 — Canvas receipts require a host-only authority boundary

- **Date:** 2026-07-19
- **Severity/status:** Medium / `Remediated` (source-ahead candidate; verification pending)
- **Owner:** TaskWraith maintainers — Canvas receipt minting and execution authority
- **Original evidence:** Provider event envelopes can carry a shape-valid
  `canvasEvalReceipt`, duplicate scripts, or an outer decoy script around the
  canonical arguments. Trusting those fields would let provider-authored data
  claim that a different script or approval authorized a compatibility/audit
  event, corrupting forensic attribution even if the execution gate remained
  intact.
- **Impact:** An audit projection could falsely bind provider output to an
  approval id or script digest chosen by the provider. No evidence showed that
  such a receipt could itself authorize execution.
- **2026-07-19 remediation update:**
  - `createCanvasEvalApprovalReceiptFromCanonicalArgs` accepts only the
    host-selected `{ canvasId, script }` argument object. Native Kimi and Codex
    call sites derive the receipt from their canonical tool arguments rather
    than the outer provider envelope.
  - `canvasEvalApprovalPayloadForDurableStorage` accepts a separately supplied
    trusted receipt only when its approval id matches. `sanitizeCanvasEvalCompatPayload`
    ignores provider-embedded receipts; an absent host receipt results in
    redaction without false attribution.
  - `assertCanvasEvalApprovalReceipt` binds schema, algorithm, exact UTF-16 code
    units, both lengths, and approval id before execution.
  - The forged-receipt, nested-decoy, and canonical-argument cases are covered
    by [`CanvasEvalAudit.test.ts`](src/main/canvas/CanvasEvalAudit.test.ts) and
    native wiring by
    [`NativeCanvasApprovalContracts.test.ts`](src/main/canvas/NativeCanvasApprovalContracts.test.ts).
- **Verification still required:** Prove direct, gateway, native Kimi, native
  Codex, compat-only, and malformed-provider paths cannot mint or project an
  authoritative receipt from provider bytes.
- **Release disposition:** Keep the source-ahead candidate unverified until
  those integrated paths and the packaged desktop are green.

## TW-SEC-2026-007 — Canvas lifecycle is not fully joined to run/chat/workspace erasure

- **Date:** 2026-07-19
- **Severity/status:** High / `Remediated` (source-ahead candidate; exact-candidate verification pending)
- **Owner:** TaskWraith maintainers — Canvas lifecycle, chat deletion, and MCP result authority
- **Original evidence:**
  - `CanvasService.beginHistoryClear` retires the global Canvas generation and
    `CanvasStore.clearAll` purges Canvas records. `CanvasService.evaluate` checks
    that generation after its await, so global purge can discard a late eval
    completion.
  - Workspace history clear does not enter a scoped Canvas purge. Chat
    delete/truncate callbacks fence runs and approvals but do not retire or
    close Canvas sessions. Truncation preserves the chat id, leaving an old
    Canvas addressable on a later turn.
  - Ordinary run cancellation revokes pending approvals but does not invalidate
    an already-running `CanvasService.evaluate` before `eval.completed`.
  - Several other asynchronous Canvas methods lack a post-await ownership/
    generation check. The generic Canvas branch of `executeGeminiMcpTool` does
    not re-authorize the run/chat immediately before returning and projecting a
    completed result.
  - Root-chat deletion cascades descendants in `AppStore.deleteChat`; the
    callback fences the requested chat, not every descendant Canvas owner.
  - [`CanvasService.test.ts`](src/main/canvas/CanvasService.test.ts) proves global
    purge fencing for selected operations, but no regression covers scoped
    Canvas retirement plus late generic MCP results.
- **2026-07-19 source-ahead remediation:**
  - [`CanvasDeviceDriver.ts`](src/main/canvas/CanvasDeviceDriver.ts) now blocks
    new work during close, joins in-flight open/screenshot operations, prevents
    late frames, generation-fences install/launch races, uses strict private
    screenshot-temp cleanup, and retains failed native teardown for retry.
  - Independent review accepted that device-driver boundary; its focused suite
    passed 21/21, and the combined three-file lifecycle/privacy review passed
    65/65.
  - [`CanvasService.ts`](src/main/canvas/CanvasService.ts) now carries explicit
    chat/workspace history holds and revisions plus per-Canvas generations.
    `beginAuthorityHistoryClear` raises scoped admission synchronously, retires
    matching pending/live sessions before its first await, joins driver close,
    and strictly purges the durable Canvas authority; the matching end method
    releases holds only after the outer transaction commits. Global clear keeps
    the same transaction-long admission property.
  - Every live async Canvas result rechecks the owning session, Canvas/global
    generation, chat/workspace revision, and active hold before audit or durable
    projection. Main captures exact run/chat execution authority and rechecks it
    before generic MCP projection and media persistence. Scoped deletion covers
    frozen descendants, while cancellation and approval revocation prevent a
    late result from becoming actionable.
  - Final independent privacy/history review passed 391/391 across 25 files;
    the broader integrated Canvas/media/history run passed 523/523. The final
    media/AV review passed 230/230, including stale completion rollback and
    final-success-edge commit ordering.
- **Impact:** Sensitive Canvas outputs may return or persist after cancellation
  or erasure, deleted history may be recreated by a late completion, and live
  preview surfaces may survive a chat/workspace clear.
- **Source-ahead invariants to preserve:**
  1. Keep Canvas's explicit run/chat/workspace ownership index and scoped
     begin/end invalidation transactions authoritative.
  2. Abort or close matching sessions before the first await in cancel,
     truncate, delete, workspace-clear, and descendant-cascade paths.
  3. Re-check run/chat/Canvas generation after every asynchronous operation and
     immediately before audit/transcript/provider result projection.
  4. Preserve delayed-operation regressions for eval and non-eval methods across
     global, workspace, chat, descendant, and ordinary run-cancel scopes.
- **Release disposition:** Keep `Remediated`, not `Verified`, and retain the
  release block until the exact integrated candidate passes the scoped Canvas,
  cancellation, descendant, media, and packaged deletion/restart matrix above.

## TW-SEC-2026-008 — Kimi's production containment boundary had check/use races

- **Date:** 2026-07-19
- **Severity/status:** High / `Remediated` (source-ahead candidate; verification pending)
- **Owner:** TaskWraith maintainers — Kimi ACP runtime and filesystem authority
- **Original evidence:**
  - The production `runKimiAcpProvider` called
    `findUnsafeWorkspaceKimiConfig` and then awaited isolated-home and bridge
    setup before `session/new` used the real workspace as ACP cwd. A
    `.kimi-code/mcp.json` or plugin path could therefore appear after the check
    but before provider discovery.
  - The prior ACP client filesystem handler realpath-authorized a path and then
    performed a later path-based read/write. A symlink or parent swap could
    invalidate the check before use.
  - The reviewed live B3 probe invokes the detector and an intentionally raw
    unguarded hazard directly. It demonstrates why the guard is load-bearing;
    it does not prove that production `index.ts` has no check/use window.
- **Impact:** A workspace-controlled Kimi startup source or swapped filesystem
  path could reach provider execution outside TaskWraith's brokered workspace
  and approval boundary.
- **2026-07-19 remediation update:**
  - [`KimiProductionContainment.ts`](src/main/kimi/KimiProductionContainment.ts)
    introduces an unguessable, mode-0700, empty synthetic cwd under the isolated
    seat home; `assertReadyForSpawn` rechecks ownership, type, mode, and emptiness
    immediately before spawn.
  - `buildKimiProductionInitializeParams` advertises no client filesystem;
    `buildKimiProductionAcpSnapshot` requires the TaskWraith HTTP gateway as the
    only workspace surface and applies the static native fs/exec/egress/fan-out
    deny wall. `buildKimiProductionSessionPlan` refuses sessions born before the
    new posture version.
  - [`KimiAcpClient.ts`](src/main/kimi/KimiAcpClient.ts) now defaults to the
    fs-free initialize posture, and
    [`KimiProductionContainment.test.ts`](src/main/kimi/KimiProductionContainment.test.ts)
    exercises the pure boundary.
  - Both normal turns and native compaction in [`index.ts`](src/main/index.ts)
    now consume one `buildKimiProductionAcpSnapshot`: process and ACP cwd use the
    private directory, initialize parameters omit client filesystem, the
    authenticated loopback TaskWraith gateway is the sole workspace surface,
    and the static native deny wall remains in force. `assertReadyForSpawn` runs
    immediately before the synchronous `runKimiAcpTurn` spawn.
  - `createJoinedKimiCleanup` joins private-cwd, bridge, and isolated-home
    teardown. The source-ahead qualification suite in
    [`KimiProductionContainment.live.test.ts`](src/main/kimi/KimiProductionContainment.live.test.ts)
    now defines the exact 16-title `acp-synthetic-cwd-gateway-v1` contract:
    private process/session cwd, inert workspace config, fs-free initialize,
    the exact nine-tool native deny roster with same-id terminal denials and no
    client-fs fallback, positive authenticated gateway access, real legacy cold
    start, pre-spawn gateway failure, and strict teardown.
- **Boundary of the fix:** This source-ahead composition removes the reviewed
  real-workspace cwd and client-filesystem check/use paths. It does not make an
  arbitrary installed Kimi build admissible; TW-SEC-2026-010 separately tracks
  the missing fully integrated exact-build runtime fence. Gated-off discovery
  currently proves only that the suite loads and its non-credentialed admission
  cases pass; the 14 credentialed assertions were skipped. No reviewed hosted
  trace has commissioned a tuple, and the embedded runtime roster remains
  empty. Test design is not qualification of the exact release candidate,
  packaged tuple, or remote backend/model contract.
- **Required verification:** Record a sanitized exact-build trace proving the
  process cwd and ACP cwd are the same empty private directory, initialize omits
  client fs, only the governed HTTP gateway is advertised, legacy sessions cold
  start through the real dispatch path, every required native attempt yields a
  same-id structured terminal denial with no successful completion or client-fs
  fallback, and cleanup removes the credential-bearing runtime material on every
  exit. Without an independent network observer, FetchURL, WebSearch, and
  AgentSwarm denial evidence must not be promoted into proof that no outbound
  attempt preceded the terminal frame. Include normal and native compaction
  success, timeout, cancellation, bridge failure, resume, and failed-start
  teardown.
- **Release disposition:** Keep `Remediated`, not `Verified`, and retain the
  `Block` until the exact integrated candidate passes its focused tests,
  all credentialed production-composition assertions, and packaged trace.
- **2026-07-21 disposition update:** Desktop Kimi admission now always-enables
  labelled `unattested-development` seats in packaged builds too (see the
  TW-SEC-2026-010 2026-07-21 update); the containment composition described
  here applies to those seats regardless of admission mode. The
  exact-candidate verification and packaged-trace demands above are unchanged.

## TW-SEC-2026-009 — Kimi OAuth rotation is not concurrency-safe

- **Date:** 2026-07-19
- **Severity/status:** Medium / `Remediated` (source-ahead candidate; exact-candidate verification pending)
- **Owner:** TaskWraith maintainers — Kimi authentication and isolated-home lifecycle
- **Original evidence:**
  - `persistRotatedCredential` inside
    [`KimiAcpHome.ts`](src/main/kimi/KimiAcpHome.ts) performs an asynchronous
    read/compare/copy sequence with no process-wide lock, lease, compare-and-swap,
    or atomic multi-file transaction.
  - Kimi Code uses rotating, single-use refresh tokens. Two isolated seats may
    begin from the same source credential, race refresh, and then independently
    copy credential and OAuth artifacts back to the real home.
  - The test named “never regresses the real home to an older credential” in
    [`KimiAcpHome.test.ts`](src/main/kimi/KimiAcpHome.test.ts) is sequential: it
    proves the expiry comparison rejects one already-older snapshot, not that
    concurrent refresh or multi-file writeback is safe.
- **Impact:** Parallel seats can invalidate one another's refresh token, lose a
  newer credential, or leave mismatched credential artifacts. The likely
  outcome is authentication failure or forced re-login; no plaintext credential
  disclosure is claimed.
- **Required remediation:** Coordinate credential seeding, refresh ownership,
  and writeback under a source-home keyed authority. Use atomic replacement and
  a compare-and-set generation across all related artifacts, then test two
  deliberately interleaved seats, crashes between artifact writes, and a stale
  cleanup after a newer refresh.
- **2026-07-19 remediation update:**
  - [`KimiOAuthCredentialLease.ts`](src/main/kimi/KimiOAuthCredentialLease.ts)
    now owns a private source-home authority record for the entire managed OAuth
    lifetime: exact credential snapshot, isolated-home seed, provider process,
    rotated writeback, home scrub, and lease removal. A second OAuth-backed
    seat fails closed while that lease is live. API-key seats do not enter this
    authority and remain independently concurrent.
  - Before the first ACP initialize frame, ordinary turns and native compaction
    durably record the provider child PID plus process-birth identity. Recovery
    will not steal a dead-parent lease while that exact child may still be
    alive, and a seeded record with no durable child identity fails closed.
  - Writeback compares the source credential digest against the exact snapshot,
    rejects an independently advanced authority, writes private mode-0600 files
    through fsynced atomic replacement, and commits the primary credential last.
    Before mutating source artifacts it fsyncs the exact candidate digest and
    outcome intent. If the isolated candidate is later lost, recovery may finish
    forward only when a descriptor-validated source primary exactly matches that
    durable digest; every other missing/mismatched state fails closed. Its
    replayable phases are `claimed` → `seeded` → `committed` → `scrubbed`; the
    candidate home is scrubbed and fsynced before the durable lease is removed.
    Acquisition replays a dead owner's durable state before
    [`KimiAcpHome.ts`](src/main/kimi/KimiAcpHome.ts) may scrub or reseed that
    seat, preventing restart cleanup from deleting the only rotated candidate.
  - [`KimiOAuthCredentialLease.test.ts`](src/main/kimi/KimiOAuthCredentialLease.test.ts)
    exercises whole-lifetime exclusion, dead-owner recovery, live orphan-child
    refusal, stale-writer rejection, a private-path swap, an unsafe lock path,
    every durable crash boundary, candidate loss after the source commit, and
    same-seat recovery-before-scrub.
    [`KimiAcpHome.test.ts`](src/main/kimi/KimiAcpHome.test.ts) separately proves
    OAuth exclusion through joined cleanup and concurrent API-key preparation.
  - Independent reclaim review found a narrower pathname race in an intermediate
    `transition.lock` recovery. A contender that classified an old lock as stale
    can pause before rename/unlink; another contender can then create a new live
    lock at the same pathname, after which the delayed contender removes that
    replacement and enters overlapping OAuth work. Reclamation needs an
    exclusive generation-bound guard and release must verify the exact lock
    identity. A deterministic two-contender regression must prove a delayed
    stale reclaimer cannot remove its successor's live authority.
  - The final candidate adds an exclusive `transition.reclaim.lock` guard that
    is never auto-reclaimed. Normal creators check it before and after lock
    creation/owner publication; a stale reclaimer revalidates the exact observed
    directory generation under the guard before rename. Release verifies the
    owned directory identity and treats a missing or mismatched lock as an
    authority failure. An abandoned reclaim guard therefore fails closed rather
    than guessing that exclusion is safe. Candidate-digest recovery remains
    intact. Independent verification covered the delayed contender/new live
    winner, stale-guard availability failure, and missing/mismatch release;
    15/15 lease tests and the 57/57 integrated OAuth/Home/ACP/containment batch
    passed, with Node typecheck, scoped lint, and diff check green.
- **Release disposition:** Keep `Remediated`, not `Verified`, and rerun the full
  repository gates on the exact integrated candidate. This does not commission
  a packaged Kimi runtime: the embedded qualification roster remains
  intentionally empty and external commissioning remains red, so packaged Kimi
  must stay unavailable until TW-SEC-2026-010's distinct live qualification
  requirements pass.
- **2026-07-21 disposition update:** The "packaged Kimi must stay unavailable"
  rider above is superseded by the shipped always-enabled admission decision
  (see the TW-SEC-2026-010 2026-07-21 update): packaged Kimi now admits as
  labelled `unattested-development`. The OAuth authority fix and its
  verification demands are unchanged; external commissioning of a reviewed
  runtime tuple remains red.

## TW-SEC-2026-010 — Kimi qualification evidence was not a runtime admission fence

- **Date:** 2026-07-19
- **Severity/status:** High / `Remediated` (source-ahead candidate; verification and commissioning pending)
- **Owner:** TaskWraith maintainers — Provider qualification and Kimi admission
- **Original evidence:**
  - [`provider-containment-canary.cjs`](scripts/provider-containment-canary.cjs)
    and [`verify-provider-canary-aggregate.cjs`](scripts/verify-provider-canary-aggregate.cjs)
    validate an exact Kimi binary/capability/runtime tuple and explicitly stamp
    `fingerprintEnforcementScope: 'release-evidence-only'`.
  - At initial review, the qualification manifest was consumed by the
    canary/report path, not by normal Kimi seat admission. Production
    `runKimiProvider` resolved and classified an installed binary but did not
    compare its hash/capability fingerprint/runtime contract to the reviewed
    manifest before tool-capable dispatch.
- **2026-07-19 remediation update:**
  - The source-ahead canary now names the strict Kimi qualification scope
    `acp-synthetic-cwd-gateway-v1` and its reviewed roster contains only
    [`KimiProductionContainment.live.test.ts`](src/main/kimi/KimiProductionContainment.live.test.ts).
    The older empty-MCP native diagnostics remain useful manual evidence but are
    not release-qualifying suites. The hosted `macos-15` tuple uses the official
    native 0.27.0 ARM64 distribution and a protected workflow that writes its
    Kimi Code API key into the source config. Common desktop production instead
    uses the user's installed binary and provider-owned Kimi Code config/current
    OAuth state. A TaskWraith Settings-stored or legacy `~/.kimi` key is not
    projected into the isolated production home; managed status deliberately
    ignores the legacy key, which remains only for usage-history compatibility.
    Passing the hosted tuple does not automatically attest or authenticate a
    different production tuple.
  - [`KimiRuntimeAdmission.ts`](src/main/kimi/KimiRuntimeAdmission.ts) introduces
    an exact executable/startup gate: descriptor-bound identity capture, digest
    and stat revalidation, bounded inventory probes under fresh roots, exact
    version/capability/posture matching, a branded admitted path, and another
    identity assertion immediately before spawn.
  - Its build-generated `EMBEDDED_KIMI_RUNTIME_QUALIFICATIONS` roster is
    intentionally empty until credentialed live evidence commissions an exact
    tuple. That is the correct fail-closed release state, not an implicit
    development fallback.
  - The explicit unpackaged development escape hatch is labelled
    `unattested-development`, cannot run in a packaged build, and does not mint
    reviewed provenance or populate the embedded roster.
  - The current integration candidate calls `admitKimiRuntime` for managed
    normal turns, native compaction, status/auth inspection, and ensemble
    readiness. Normal and compaction launch through `launchKimiProductionAcp`,
    which rechecks the admitted executable identity immediately before spawning
    its branded path under the contained environment. Production Wire/print and
    legacy host-summary execution are not fallback transports, and global
    `kimi mcp add/remove` repair is retired from managed startup.
  - Independent review accepted the managed normal/compaction admission seam,
    per-spawn identity checks, contained environment, and exact governed-gateway
    classifier as a source remediation candidate. The Kimi-scoped typecheck was
    clean and the provider-terminal boundary suite passed 12/12. The
    credentialed lane has not commissioned an exact tuple: 14 live assertions
    were skipped, the release manifest/generated runtime roster is empty, and
    packaged Kimi execution must remain unavailable.
- **2026-07-19 deterministic verification update:** The integrated
  Kimi/bridge audit passed 319 assertions across 27 files with 24 expected live
  skips and a clean diff check. Exact qualification parity was green with zero
  commissioned tuples. No credentialed provider call ran, so this is strong
  source/composition evidence—not a live qualification or packaged-release
  attestation. A subsequent five-file schedule/authority, Kimi-debug, and bridge
  run passed 105/105 and independently confirmed the sealed-scheduling
  exclusion.
- **Impact:** Without the candidate fence, a new or locally different Kimi build
  can change startup discovery, native tools, ACP capabilities, denial
  semantics, or authentication behavior while TaskWraith still offers it a
  tool-capable seat. The original implementation had no rule that degraded an
  unknown production tuple to a separately attested safe posture.
- **Verification and remaining requirements:** Confirm that executable admission
  precedes every TaskWraith-managed Kimi provider invocation, including
  status/auth inspection, flavor/inventory helpers, normal turns, native
  compaction, and legacy/summary paths. Only the branded admitted realpath may
  reach a managed spawn, and its `assertReadyForSpawn` identity check must run
  immediately beforehand under the same contained environment qualified by the
  canary. An unknown tuple must fail closed; it may degrade only to a separately
  qualified posture.
- **Boundary of the control:** Local runtime admission can prove the
  executable, startup capability projection, platform/architecture, and
  containment-posture version. It cannot by itself prove that the remote
  authentication mode, backend, or model alias matches a hosted canary tuple;
  those dimensions require separate release/session evidence. The source-ahead
  OAuth authority tracked by TW-SEC-2026-009 is remediated but still awaits
  exact-candidate verification. User-initiated
  provider-terminal actions in
  [`providerTerminalHandlers.ts`](src/main/ipc/providerTerminalHandlers.ts)—Kimi
  login and upgrade—remain outside contained ACP and managed-run admission. The
  candidate labels them `scope: user-owned-provider-setup`, returns
  `managedRunReady: false`, and warns that success does not qualify a runtime;
  the former bare Kimi account/session handoff is removed. Ensemble readiness
  now consults admission, but binary presence alone must never be described as
  containment qualification.
- **Scheduled-run seal scope (2026-07-21):** The launch-authority schema now
  models Kimi's ACP posture, admission roster, private cwd, and authenticated
  gateway. Stage 2 wires live mint/persist/fresh-verify enforcement only for
  claimed solo Cursor occurrences, whose contained argv and inherited
  environment can be re-derived from the same dispatch seams. Kimi scheduled
  runs remain available but intentionally unsealed: its isolated-home, private
  cwd, and per-run gateway are created inside the ACP launch path and have not
  yet been injected as exact evidence. No Kimi digest is fabricated; Stage 3
  must wire those dispatch-owned facts before Kimi is added to the sealed lane.
- **Verification required:** Unit tests must reject unknown, partially matching,
  stale, and identity-swapped binaries. Production wiring tests must prove that
  neither a rejected binary nor any pre-admission helper reaches process spawn,
  for normal and compaction paths, and that the denial names the sanctioned
  alternative. Then run all credentialed production-composition assertions,
  generate and verify the exact embedded roster from that reviewed result, and
  rerun the strict release/whole-tree gates. Release attestation remains
  additional evidence, not a substitute for runtime admission.
- **Release disposition:** `Block` Kimi production qualification until the
  runtime consumes and enforces a commissioned executable tuple. With an empty
  embedded roster, reviewed Kimi provenance remains unavailable. Kimi
  scheduling remains available but unsealed until its authority seal binds the
  exact ACP launch post-image. Keep this entry `Remediated`, not `Verified`,
  until the credentialed exact tuple, populated generated roster, strict rerun,
  schedule migration, and whole-tree check are green.
- **2026-07-21 disposition update:** The shipped 1.8.5 admission seam
  deliberately drops the exact-tuple fence for desktop seats:
  [`KimiRuntimeAdmission.ts`](src/main/kimi/KimiRuntimeAdmission.ts) hardcodes
  `allowUnattestedDevelopment = true` with no packaged-build branch, so an
  unknown binary that passes the structural gate (descriptor-bound identity,
  bounded probes, exact version parse, ACP-only posture) admits as explicitly
  labelled `unattested-development` in any build, packaged included. The
  runtime containment — authenticated loopback gateway plus the native
  nine-tool deny wall — applies regardless of admission mode. This supersedes
  the statements above that the escape hatch "cannot run in a packaged build"
  and that "packaged Kimi execution must remain unavailable". Unchanged: the
  embedded reviewed roster remains empty, unattested admission mints no
  reviewed provenance and cannot satisfy release attestation. Kimi scheduled
  execution remains intentionally unsealed pending Stage-3 injection of its
  isolated-home, private-cwd, and authenticated-gateway launch evidence.

## TW-SEC-2026-011 — Provider diagnostics exposed live authority material

- **Date:** 2026-07-19
- **Severity/status:** High / `Remediated` (source-ahead candidate; full verification pending)
- **Owner:** TaskWraith maintainers — MCP bridge bootstrap, Kimi ACP diagnostics, and diagnostic storage
- **Original evidence:**
  - `startGeminiMcpBridgeProcess` in
    [`McpBridgeRuntime.ts`](src/main/mcp/McpBridgeRuntime.ts) passed
    `argv.slice(1)` verbatim to `bridgeLog` at process startup. The bridge argv
    contains `--token` followed by the live broker bearer secret and also
    contains the local socket route.
  - The same diagnostic line recorded the process cwd and
    `TASKWRAITH_WORKSPACE_PATH` in cleartext.
  - `bridgeLog` wrote that line to `bridge-subprocess.log` under the user's
    TaskWraith logs directory. Its Canvas-specific text sanitizer did not redact
    generic argv secrets or local paths.
  - The existing writer used mode 0600, `O_NOFOLLOW`, a regular-file check,
    bounded size, and a history-clear epoch. Those controls reduce exposure but
    do not make retention of a live bearer secret safe or prove the parent
    directory/existing file remains privately owned and non-aliased.
  - The production `runKimiAcpProvider` path in
    [`index.ts`](src/main/index.ts) also installed an `onRawFrame` callback. When
    `TASKWRAITH_KIMI_ACP_DEBUG` was enabled, it serialized the first part of
    every inbound and outbound ACP frame directly to process stderr.
  - The outgoing `session/new` frame carries the production HTTP MCP server
    definition from [`KimiHttpMcpBridge.ts`](src/main/kimi/KimiHttpMcpBridge.ts),
    including its local URL and `Authorization: Bearer` header. Other ACP frames
    can carry cwd, prompt, and path-bearing provider content. An opt-in debug
    environment flag is not a safe authority boundary for raw production
    frames.
- **Impact:** A reader of the bridge log or captured process stderr during the
  token lifetime could recover local broker authority and routing material,
  potentially authenticating an unmediated request to the corresponding local
  broker. The diagnostics also exposed workspace/cwd paths and potentially
  prompt content. This is confirmed secret disclosure to diagnostic sinks; no
  unauthorized broker call or downstream durable retention is asserted.
- **2026-07-19 remediation update:**
  - [`McpBridgeRuntime.ts`](src/main/mcp/McpBridgeRuntime.ts) now constructs
    launch and runtime diagnostics from structural allowlists. Startup logging
    records only fixed non-secret state; tool calls and failures expose bounded
    kinds/counts and allowlisted tool names rather than raw argv, unknown names,
    ids, arguments, errors, stacks, stream text, cwd, workspace, socket routes,
    or bearer values.
  - The bridge writer now validates private directory/file ownership, mode,
    link count, descriptor/path identity, and unsafe symlink, hardlink, and
    directory-swap states. A cross-process transaction lock serializes append
    against history-clear epoch advance and strict truncation, closing the
    reviewed paused-before-write race.
  - `formatKimiProductionAcpDebugFrame` in
    [`KimiProductionContainment.ts`](src/main/kimi/KimiProductionContainment.ts)
    emits only fixed frame direction/kind, method, RPC-id presence, and bounded
    error-code metadata. It does not serialize ACP params or results, so MCP
    Authorization headers, prompts, paths, and provider text do not reach
    stderr through that production debug hook.
  - Independent focused re-audit accepted the content minimization and
    append/clear serialization. The privacy and paused-race regressions in
    [`McpBridgeRuntimeSafeWrite.test.ts`](src/main/mcp/McpBridgeRuntimeSafeWrite.test.ts)
    and the Kimi frame-sentinel coverage in
    [`KimiProductionContainment.test.ts`](src/main/kimi/KimiProductionContainment.test.ts)
    passed. After retiring two stale/non-fail-closed Kimi expectations, the
    focused bridge pair passed 45/45; the three-file independent lifecycle and
    privacy review passed 65/65. The whole-tree check remains pending.
  - The later integrated Kimi/bridge deterministic audit passed 319 assertions
    across 27 files with 24 expected live skips and a clean diff check. It made
    no credentialed provider call and commissioned no runtime tuple.
  - A subsequent combined schedule/authority, Kimi-debug, and bridge run passed
    105/105 across five files. Independent review confirmed that Kimi debug
    records RPC identity only as the boolean `rpcIdPresent`, never the id value,
    and that stale Wire/print scheduling authority cannot be minted or verified.
  - A final bounded unexpected-exception review exercised a real broker
    executor rejection and missing Unix-socket path through the shared broker,
    Kimi HTTP bridge, and Kimi dispatch boundaries. Every provider-visible
    result used the constant host-minted internal-error classification and
    omitted the exception/path sentinels; the focused batch passed 58/58.
- **Source-ahead invariants to preserve:**
  1. Replace raw bridge launch logging with a strict allowlist of non-sensitive
     state; never serialize raw argv, token values, socket paths, cwd, workspace
     paths, credential-bearing environment variables, prompts, or tool
     arguments.
  2. Disable arbitrary ACP-frame logging in production. If a bounded diagnostic
     mode remains, construct method-specific allowlisted summaries before any
     string serialization; never pass header values, MCP server definitions,
     prompts, params, results, paths, or provider text to stderr. Redacting a
     completed JSON string or requiring an environment flag is insufficient.
  3. Prefer presence booleans and stable non-secret profile identifiers where
     diagnostics need correlation. Apply the semantic minimizer at the source
     so exception and rejection paths cannot reintroduce the raw values.
  4. Create and validate the log directory/file with private ownership and mode,
     reject symlink/hardlink/unsafe existing-file states, and keep bounded
     rotation plus history-clear generation fencing.
  5. Add spawned-child regressions with unique bridge-token, ACP-Authorization,
     prompt, cwd, workspace, and socket sentinels. Inspect both the real on-disk
     bridge log and captured stderr; cover existing unsafe storage and
     late-child writes after clear.
- **Verification still required:** The unexpected-exception disclosure class is
  clean at the reviewed shared/Kimi boundary. Run the whole-tree checks on the
  exact integrated candidate, then prove every bridge bootstrap path, packaged
  Kimi ACP turn path, diagnostic logger, and diagnostic export omits the
  sentinels while retaining enough non-secret evidence to diagnose startup.
- **Release disposition:** Keep `Remediated`, not `Verified`, and retain the
  `Block` until those full checks and the packaged sentinel exercise are green.

## TW-SEC-2026-012 — Durable Kimi homes used a cleanup deny-list instead of a continuity allowlist

- **Date:** 2026-07-19
- **Severity/status:** High / `Remediated` (source-ahead candidate; verification pending)
- **Owner:** TaskWraith maintainers — Kimi isolated-home and native-session lifecycle
- **Original evidence:** When `preserveSessionState` was enabled,
  `prepareKimiIsolatedHome` removed a fixed `KIMI_RUNTIME_ARTEFACTS` list. A new
  Kimi build could create an unrecognized top-level cache, config, plugin,
  credential, or executable artifact; because it was absent from the deny-list,
  it could survive cleanup and be observed by a later turn in that durable seat.
- **Impact:** Opaque provider-created state outside the two intended native
  continuity locations could cross run boundaries, retain sensitive material,
  or alter a later seat's startup behavior. This finding does not assert that a
  reviewed build actually created such an artifact.
- **2026-07-19 remediation update:**
  - [`KimiAcpHome.ts`](src/main/kimi/KimiAcpHome.ts) replaces the fixed cleanup
    list with `KIMI_SESSION_CONTINUITY_TOP_LEVEL`. Only `sessions/` and
    `session_index.jsonl` survive, and their file types are checked without
    following symlinks.
  - `scrubDurableHome` enumerates and removes every other top-level entry both
    before new credentials/config are materialized and again during cleanup. A
    strict preparation failure prevents provider spawn.
  - The same source-ahead change validates that the credential-bearing seat
    home stays inside a private real-directory boundary.
  - [`KimiAcpHome.test.ts`](src/main/kimi/KimiAcpHome.test.ts) proves native
    session continuity survives while runtime configuration, credentials,
    OAuth state, plugins/skills, and stale MCP material are removed; a scrub
    failure fails preparation closed.
- **Boundary of the fix:** The allowlist controls top-level persistence, not the
  semantics of provider-native session contents. An unknown build must still be
  rejected by the separate runtime qualification control in TW-SEC-2026-010.
- **Verification still required:** Add arbitrary unknown-file/directory,
  symlink, hardlink, nested-session, partial-removal, crash-restart, and packaged
  durable-seat cases. Prove cleanup failure cannot be silently converted into a
  resumable seat.
- **Release disposition:** Keep `Remediated`, not `Verified`, until the exact
  candidate passes that lifecycle matrix. Do not claim that only session state
  remains in released builds before then.
- **2026-07-21 disposition update:** The boundary note above ("an unknown build
  must still be rejected by the separate runtime qualification control in
  TW-SEC-2026-010") no longer holds as written: unknown builds now admit as
  labelled `unattested-development` (see the TW-SEC-2026-010 2026-07-21
  update), which makes this continuity allowlist and scrub path the operative
  controls for those seats. The verification matrix above is unchanged.

## TW-SEC-2026-013 — Provider dispatch lacks a final chat/history mutation fence

- **Date:** 2026-07-19
- **Severity/status:** High / `Remediated` (source-ahead candidate; exact-candidate verification pending)
- **Owner:** TaskWraith maintainers — Run admission, chat mutation, and approval lifecycle
- **Original evidence:**
  - `dispatchRunWithProviderPause` and the scheduled-dispatch wrapper in
    [`index.ts`](src/main/index.ts) consult `historyClearBlocksRunPayload` only
    before entering the asynchronous dispatch pipeline.
  - [`RunDispatchFacade.ts`](src/main/run/RunDispatchFacade.ts) can then await
    configuration repair and PDF expansion. [`RunCoordinator.ts`](src/main/services/RunCoordinator.ts)
    subsequently applies the runtime profile, awaits provider preflight and
    reference-context capture, and only then calls `authorizeBeforeAdapterRun`
    immediately before the adapter.
  - At initial review, `authorizeBeforeAdapterRun` revalidated exact durable
    authority for execution-graph attempts only. It returned early for an
    ordinary run and did not prove that the chat still existed or that its
    history-mutation generation was unchanged.
  - A chat delete, truncate, workspace clear, or global clear can therefore
    begin and finish while an ordinary dispatch is suspended in one of those
    awaited steps. Once the clear gate reopens, the stale continuation can reach
    the provider adapter and create new run events or messages for authority
    that was deleted or truncated.
  - At initial review, `PendingMainApproval` in
    [`ApprovalService.ts`](src/main/services/ApprovalService.ts) carried a run id
    and optional workspace path, but no `appChatId`. The preflight approval
    payload in [`ApprovalOrchestration.ts`](src/main/run/ApprovalOrchestration.ts)
    displayed the chat id without retaining it in the pending main record. Until
    `RunManager` has registered the run, `cancelForChat` therefore cannot
    correlate and settle that modal during delete or truncate.
- **2026-07-19 remediation update:**
  - [`HistoryClearAdmissionGate.ts`](src/main/HistoryClearAdmissionGate.ts) now
    maintains global/workspace/chat mutation generations and opaque dispatch
    reservations. [`RunCoordinator.ts`](src/main/services/RunCoordinator.ts)
    holds a supplied reservation across provider preflight/reference capture,
    re-authorizes immediately before the adapter, and releases it on every exit.
  - Main wiring now derives canonical chat existence, workspace, and durable
    `persistenceRevision` at reserve and authorize time. `PendingMainApproval`
    also carries `appChatId`, and approval registration/projection/cancellation
    use it before a `RunManager` session exists. Generation-bound dispatch and
    preflight visibility now cover tested same-chat concurrent preflights.
  - A first candidate still reserved too late, after configuration repair and
    PDF expansion. The current source-ahead candidate moves `reserveDispatch`
    to the first operation in
    [`RunDispatchFacade.ts`](src/main/run/RunDispatchFacade.ts), before either
    await, and passes that outer reservation through `RunCoordinator` for final
    authorization and release instead of recapturing post-mutation state.
  - The later candidate added persistence authorization and rollback around
    provider/Codex media ownership writes. Independent review also accepted the
    rich-MCP seam: authority is captured before execution, checked again before
    projection, image persistence uses `persistAuthorizedProviderMedia`, and
    trusted AV ownership grants are gated.
  - The source-ahead `ToolMediaPersistenceGate` candidate closes the earlier
    pre-ownership AV window. File producers now publish with exact chat/run
    authority and return a main-only pending commit/rollback capability. Final
    settlement rechecks authority and synchronously commits immediately before
    projection, strictly rolls back stale/error paths, and strips the capability
    before provider/transcript projection. Independent adversarial review of
    that boundary passed 232/232.
  - A stronger concurrent rollback probe found a narrower defect in
    [`TranscriptMediaAssetStore.ts`](src/main/services/TranscriptMediaAssetStore.ts).
    Two overlapping `rollbackOwnedFileWriteStrict` calls could make the second
    reject for singleton-purge contention after its caller had dropped the
    pending capability, leaving the second file bytes and chat grant durable
    without a retry handle.
  - The current source-ahead store serializes exact receipt rollbacks, publishes
    and awaits active-purge completion, performs receipt lookup/deletion inside
    that serialization, and deletes a receipt only after strict cleanup
    succeeds. Every queue waiter releases its successor in `finally`, and a
    failed cleanup retains its receipt for retry. The focused concurrent-
    rollback and history-purge-collision regressions passed in the independent
    222/222 media/AV batch plus 5/5 `ToolMediaPersistenceGate` tests.
  - A subsequent dispatcher re-audit found a distinct commit-order defect in
    [`index.ts`](src/main/index.ts): the pending AV rollback receipt can be
    committed and retired before later throw-capable result projection,
    injection, or grant work has completed. If that later work throws, the catch
    path returns an error without a live receipt to revoke the already-owned AV
    bytes and grant. The final candidate wraps all throw-capable projection in
    `projectAndCommitToolMediaPersistence`, retains rollback authority through
    that work, rechecks exact authority afterward, and commits synchronously as
    the last operation. No throw-capable work remains after commit; the catch
    path still owns strict rollback for every earlier exception.
  - Final independent review passed 230/230 across eight files, including the
    injected projection-failure bytes/grant cleanup and concurrent rollback/
    active-purge schedules. A separate boundary run passed 201/201 with Node
    typecheck and scoped lint green.
- **Impact:** A provider transport can start after the user completed an erasure
  or cancellation transaction, repopulating a deleted/truncated chat with late
  events, messages, or approvals. A pre-transport main approval may also remain
  actionable after its chat authority ended. This is a lifecycle/authorization
  race; no demonstrated provider escape or data exfiltration is asserted.
- **Source-ahead invariants to preserve:**
  1. Reserve a main-owned chat/history mutation generation synchronously at the
     outer dispatch entry, before configuration repair, PDF expansion, provider
     preflight, or any other await. Immediately before adapter invocation,
     atomically consume it only if the chat still exists, its provider and
     workspace identity still match, its generation is unchanged, and no
     scoped clear or terminal claim is active.
  2. Put `appChatId` on every pending approval record, durable projection, and
     lifecycle cancellation path, including approvals created before
     `RunManager` session registration.
  3. Make delete, truncate, workspace clear, global clear, and descendant
     deletion revoke matching reservations and approvals before their first
     await. A late continuation must fail without invoking an adapter.
  4. Preserve the exact pre-projection authority/rollback candidate and the
     lossless serialized per-receipt rollback. Retain retry authority until
     both cleanup and the final successful projection edge are durably verified;
     commit only after all throw-capable publication/injection work. Keep proving
     that rejection, cancellation, or a later exception cannot strand bytes or
     grants across global/workspace/chat clear, delete, truncate, descendants,
     and pre-`RunManager` main approvals.
- **Verification still required:** On the exact candidate, pause dispatch at
  every await boundary, complete each mutation transaction, then release the
  pause. Assert zero provider spawn, zero late history projection, and no live
  approval card for the revoked chat.
- **Release disposition:** Keep `Remediated`, not `Verified`, and retain the
  release block until the exact integrated candidate passes the await-boundary,
  approval, media-rollback, and packaged lifecycle exercises above.

## TW-SEC-2026-014 — History deletion was not one complete multi-store transaction

- **Date:** 2026-07-19
- **Severity/status:** High / `Remediated` (source-ahead candidate 2026-07-21; exact-candidate verification pending)
- **Owner:** TaskWraith maintainers — Data lifecycle, history erasure, and orphan recovery
- **Original evidence:**
  - At initial review, global `AppStore.clearChats` in
    [`store/index.ts`](src/main/store/index.ts) independently removes the chat
    directory/index, run events and artifacts, run queue and recovery data,
    approval and feedback ledgers, sub-thread mailboxes, and current/legacy Kimi
    seat state. Most of those calls use `deletePathBestEffort`, and the method
    has no durable prepare record, per-store commit receipt, rollback, or
    incomplete-deletion result.
  - At initial review, `AppStore.deleteChat` recursively deleted descendants
    and attempted run forensic, Kimi seat, mailbox, feedback, and
    project-membership cleanup around unlinking the chat. Several owned-store
    failures were intentionally swallowed so the visible chat could disappear
    while related records remained.
  - The first source-ahead `deleteChatWithLifecycle` path in
    [`chatHandlers.ts`](src/main/ipc/chatHandlers.ts) begins chat mutation holds,
    revokes approvals, and joins selected Canvas/execution-graph cleanup before
    the core delete. The renderer abandoned-chat reaper now routes candidates
    through that helper, which is useful remediation progress.
  - At initial review, the internal lazy orphan sweep
    `ensureOrphanSubThreadsReaped` called `AppStore.deleteChat` directly from
    `getChats`. It therefore bypassed the main-owned lifecycle helper, including
    scoped admission holds, approval
    revocation, Canvas retirement, and execution-graph cleanup.
- **2026-07-19 source-ahead remediation:**
  - [`store/index.ts`](src/main/store/index.ts) now contains durable
    `HistoryDeletionIntent` primitives that record quiescence and per-store
    completion, retry idempotent boundaries, retain the journal on failure,
    surface `HistoryDeletionIncompleteError`, and expose
    `recoverPendingHistoryDeletion`.
  - Queue/recovery records, approval and feedback ledgers, sub-thread
    mailboxes, run events and artifacts, Kimi seat state, chat records and list
    index, and project membership are mandatory ordered steps. A second sweep
    verifies those same boundaries while lifecycle authority remains held.
  - The candidate changes store reads to discover orphan sub-thread candidates
    rather than deleting them as a read side effect. Main now routes scoped
    chat deletion and truncation through
    [`ScopedHistoryDeletionCoordinator.ts`](src/main/ScopedHistoryDeletionCoordinator.ts),
    which durably prepares, raises Canvas/admission holds, revokes chat
    authority, records external-sink receipts, and commits through the store
    transaction. Renderer/remote orphan draining uses that lifecycle path.
  - Main now routes global/workspace clear through
    [`HistoryDeletionTransactionCoordinator.ts`](src/main/HistoryDeletionTransactionCoordinator.ts).
    It durably prepares before external destruction, acquires admission,
    Canvas, and bridge holds, quiesces provider/graph/media/bridge targets,
    records receipts, and commits the store transaction. Startup resumes a
    pending broad or scoped preparation before run-queue recovery rather than
    recomputing its topology.
  - The recovery candidate also uses `requireReacquiredHistoryDeletionHolds` in
    [`HistoryDeletionQuiescence.ts`](src/main/services/HistoryDeletionQuiescence.ts)
    to remove old Canvas/bridge receipt projections for each resumed attempt.
    Fresh strict purges are re-awaited and re-receipted before commit. Current-tip
    independent review confirmed that earlier false-green recovery window is
    closed.
  - Full-size Canvas screenshots and their durable ownership ledger live in
    [`TranscriptMediaAssetStore.ts`](src/main/services/TranscriptMediaAssetStore.ts).
    It now has strict scoped purge and owned-write rollback, a synchronous
    transaction-long `beginHistoryMutation` hold, ingest-generation invalidation,
    and active-ingest join/rollback. Broad and scoped coordinators retain that
    hold through commit; descendant media purge is batched in one strict call.
    Current-tip independent review accepted writes/grants during that held
    transaction. TW-SEC-2026-013 records the subsequent concurrent rollback
    defect, its independently accepted serialized-retry remediation, and the
    final-success-edge dispatcher remediation.
  - Purge-journal committed recovery and prepared-ledger rollback, asset and
    ownership-directory fsync, owned writes, late grants/transfers,
    global/workspace wiring, cascade batching, and overlapping async-ingest
    rollback are independently clean on the current tip. The focused media set
    in
    [`TranscriptMediaAssetStore.test.ts`](src/main/services/TranscriptMediaAssetStore.test.ts)
    and adjacent lifecycle suites passed 110/110 across eight files.
  - At the first reviewed Project-reference boundary, capture had a pre-capture
    authority fence but its content-addressed snapshots had no chat/run
    ownership, refcount, rollback, deletion step, or external-sink target.
    [`ProjectReferenceArtifactLedger.ts`](src/main/services/ProjectReferenceArtifactLedger.ts)
    and [`ProjectReferenceArtifactStore.ts`](src/main/services/ProjectReferenceArtifactStore.ts)
    now add exact owners, batch rollback, history holds, durable purge recovery,
    strict scoped/global deletion, reconciliation, and fsynced publication. The
    broad/scoped coordinators also carry a distinct Project-reference deletion
    target and receipt.
  - A later independent crash probe superseded the earlier green integration
    batch: the inner Project-reference purge can be receipted before the outer
    history deletion commits, while the old durable reference event still
    exists. On restart, Project-reference reconciliation sees that stale event
    and rejects the now-missing artifact before pending outer deletion recovery
    can finish, leaving recovery wedged. The final source-ahead candidate fixes
    that ordering by projecting the pending fsynced deletion scope into startup
    reachability before reconciliation: global deletion supplies an empty set;
    scoped deletion excludes its frozen chat/run ids; shared-SHA owners outside
    the scope survive. Reconciliation then runs before the exact outer deletion
    resumes. Strict event fsync precedes ownership commit, and only canonical
    main-owned Project-reference events contribute reachability. Independent
    verification cleared the exact crash probe and passed 95/95 across nine
    files.
  - A subsequent review found two derived local stores outside the complete
    transaction at that point.
    [`PdfAttachmentRenderService.ts`](src/main/services/PdfAttachmentRenderService.ts)
    wrote rendered attachment pages beneath the first-party
    `pdf-page-cache`, without a history-scope owner/hold, deletion target, or
    startup purge tied to the originating chat. [`index.ts`](src/main/index.ts)
    also used the shared first-party `media-staging` directory for daemon AV
    outputs and `composer-dictation-*.wav`. Its cleanup was per-call
    best-effort plus an age/prefix sweep; it did not synchronously block new
    writers, join in-flight daemon/dictation work, strictly purge every derived
    entry, receipt that purge, or replay cleanup before startup recovery. These
    stores could therefore retain or recreate attachment/audio derivatives
    after the owning history scope committed deletion.
  - At that same review point, `compactProviderContextForRequest` had no
    history-clear/durable-intent admission fence, and native maintenance
    compactions ran outside `RunManager`
    and the deletion quiescence roster. The strongest case was Kimi: an async
    admitted `/compact` could resume and mutate durable seat-isolated native state
    after a chat/workspace/global prepare and purge because
    `activeKimiNativeCompactions` and `pendingSeatCompactions` were not joined.
    Codex and Claude native compaction could also mutate provider-owned session
    state after prepare; Grok summary children/checkpoints were not transport-
    joined. The AppStore mutation gate did prevent the corresponding late host
    chat/checkpoint save, so this residual is scoped to unfenced native
    maintenance work and provider-session state, not host transcript
    resurrection.
  - [`RegenerableHistoryByteStore.ts`](src/main/services/RegenerableHistoryByteStore.ts)
    now owns first-party regenerable PDF cache, daemon/media staging, dictation,
    and temporary preview bytes under one process-lifetime generation. Scoped
    and broad history transactions synchronously raise admission holds, revoke
    and join active reservations, quarantine and strictly purge every entry, persist
    an operation-bound journal, replay incomplete cleanup before recovery, and
    perform a final all-root absence check before releasing the hold. The
    purge-journal file is bounded and its retirement receipt binds descriptor
    and path identity, size, mode, link count, owner, timestamps, operation, and
    digest. Ordinary tree entries are owner/type/link-count checked and bound to
    their device/inode identity at retirement. Purge-journal mutation or growth,
    ordinary-entry replacement, unsafe type/owner, hard links, or a late added
    entry fail closed, subject to the explicit final-pathname limitation below;
    same-inode content changes are removed with the entry rather than treated as
    a separate mismatch.
  - [`PdfAttachmentRenderService.ts`](src/main/services/PdfAttachmentRenderService.ts)
    now keys cache entries from descriptor-read content rather than pathname or
    mtime, renders from a stable private copy, validates complete PNG structure,
    CRCs, DEFLATE data, dimensions, and scanlines, and publishes only a complete
    success manifest through atomic rename. Main holds the exact derived-byte
    reservation until every page is durably promoted to chat-owned
    [`TranscriptMediaAssetStore.ts`](src/main/services/TranscriptMediaAssetStore.ts)
    storage and the ownership receipts commit as one batch. Authority loss,
    zero pages, partial output, or validation failure is a retryable fail-closed
    result; the provider never receives a silently stripped PDF.
  - Clipboard PNGs are written directly to the canonical chat-owned transcript
    media store. PDF/non-PDF previews, daemon AV output, and dictation staging
    use active regenerable-byte reservation roots and clean up before release,
    so there is no independent age-only temporary-media lifecycle left outside
    the deletion transaction.
  - The source-ahead remediation introduces the main-owned
    [`MaintenanceCompactionRegistry.ts`](src/main/services/MaintenanceCompactionRegistry.ts).
    Reservations precede provider work, a deletion hold synchronously blocks
    new native activity, and cancellation joins request completion separately
    from exact provider-child quiescence. Native quiescence is re-armed on every
    zero-to-active edge, so a completed child A cannot make a later child B look
    already closed; deletion rechecks the live activity count after each edge.
    Definitive Codex rejection balances the reservation, while unknown or
    restart-only process state fails closed instead of minting a receipt.
    Independent verification reproduced the A-close/B-open schedule and kept
    deletion pending until B closed. The reviewer batch passed 27/27 and the
    owner integration batch passed 54/54, including main and scoped deletion
    wiring. This removes native maintenance compaction from the substantive
    source-ahead residual list.
  - Persistent Grok seats are now unconditionally disabled for new runs, and an
    environment variable cannot reopen them. The exact-exit residual is the
    ordinary one-shot ACP path in
    [`GrokAcpClient.ts`](src/main/grok/GrokAcpClient.ts): callback-driven
    `runGrokAcpTurn` starts the child while `runGrokProvider` returns, so the
    tracked adapter promise can settle before the child `close` event. History
    termination can kill and eagerly finish `RunManager`, then receipt before
    exact close. Crash recovery with an unreceipted target and no recoverable
    in-memory PID fails closed, but can remain wedged rather than falsely
    completing.
- **2026-07-19 exact Grok-exit remediation update:**
  - [`GrokAcpClient.ts`](src/main/grok/GrokAcpClient.ts) now returns a
    provider-owned `closed` promise for ordinary one-shot ACP runs. It resolves
    only after the real child `close` event has fired and the caller's terminal
    projection/cleanup callback has returned; issuing a kill or finishing the
    `RunManager` session is not accepted as close evidence.
  - Grok cancellation requests `SIGTERM` first. The shared ACP lifecycle sends
    the existing bounded `SIGKILL` backstop when the grace window expires, but
    the join remains pending until the child actually closes.
  - [`index.ts`](src/main/index.ts) publishes that exact promise to
    `ProviderOperationRegistry` and awaits the same promise in the outer
    provider-adapter invocation. History deletion therefore joins both the
    pre-publication setup window and the published transport operation without
    constructing a second, potentially divergent lifecycle receipt.
  - The deterministic provider-delete race in
    [`GrokAcpClient.test.ts`](src/main/grok/GrokAcpClient.test.ts) proves the
    deletion receipt stays pending after `SIGTERM`, after the `SIGKILL`
    backstop, and until explicit child close plus terminal cleanup. The static
    integration contract in
    [`ProviderTransportHistoryIntegration.test.ts`](src/main/ProviderTransportHistoryIntegration.test.ts)
    pins the authority-before-spawn, exact-promise publication, adapter join,
    and bounded deletion retry wiring.
- **2026-07-19 provider and wakeup lifecycle remediation update:**
  - [`ProviderOperationRegistry.ts`](src/main/run/ProviderOperationRegistry.ts)
    now carries exact per-run settlement authority. Claude CLI, Grok ACP, Kimi
    ACP, Codex exec fallback, and Codex app-server turns/native reviews remain
    registered through real child/turn terminal evidence and main-owned cleanup
    and projection. History termination cannot mint a receipt from a kill or
    interrupt acknowledgement. Ollama and Claude SDK already await their inline
    stream/tool loops; the provider-path audit found no separate callback child
    to join there.
  - Kimi and Codex revalidate history/persistence authority after asynchronous
    setup and again at the final synchronous launch boundary. Deterministic
    revocation tests prove deletion during setup produces zero child spawn.
    Ambiguous Codex app-server start/review timeouts retain the operation and
    await a delayed terminal notification instead of falling back into a second
    transport. Automatic continuation after the narrow approved host-rerun
    fallback now mints an independent continuation run R1
    (`HostRerunContinuation`) that resumes the existing Codex provider session
    rather than reusing R0; missing session fails closed. See
    `papercuts/2026-07-19-retro.md` (Remediated).
  - Solo and Ensemble wakeup services synchronously fence chat/workspace/global
    generations, cancel target timers (including persisted orphan timers), join
    already-fired callbacks, round/fan-out activities, and exact provider
    transports, then revalidate the exact chat/record incarnation before any
    dispatch or persistence. Ensemble history cancellation has a dedicated
    runtime-only path and performs no AppStore/checkpoint write after durable
    prepare; startup replay safely handles the pre-orchestrator phase.
- **2026-07-19 exact Grok-exit verification update:** The focused Grok ACP,
  neutral ACP, provider-operation registry, and provider-history integration
  batch passed 42/42 across four files. Scoped ESLint reported no errors and
  `git diff --check` was clean. A fresh Node typecheck was also green after the
  concurrent architecture work settled. Independent integrated verification
  then passed 252/252 across the broader lifecycle batch. Persistent Grok seats
  remain hard-disabled; this evidence clears only the ordinary one-shot
  exact-close residual on the source-ahead candidate.
- **2026-07-19 Grok legacy-fallback remediation update:**
  [`grokGate.ts`](src/main/grokGate.ts) now normalizes the former opt-out values
  (`0`, `false`, `no`, and `off`) as a fail-closed configuration rather than an
  emergency route to the unjoined headless CLI. `GROK_ACP_REQUIRED_MESSAGE`
  explains that exact joined ACP closure is required. `runGrokProvider` no
  longer imports or calls the headless process/argument builders: a disabled
  gate emits failed, setup-required, security-unavailable state before spawn;
  the admitted branch only awaits `runGrokAcpProvider`.
  [`ProviderTransportHistoryIntegration.test.ts`](src/main/ProviderTransportHistoryIntegration.test.ts)
  pins the absence of a headless launch branch, while
  [`grokGate.test.ts`](src/main/grokGate.test.ts) covers the retired values and
  operator message. Focused verification passed 197/197 across seven files;
  Node typecheck, scoped ESLint, and diff check were green. An independent
  exact-close recheck passed 46/46. This clears the legacy fallback and makes
  joined ACP the sole source-ahead managed one-shot Grok transport.
- **2026-07-19 verification update:** At that reviewed source-ahead point, the
  Node typecheck was green. A fresh lifecycle/privacy integration batch passed
  284/284 across 18 files,
  covering history transaction/scoped/quiescence/startup/AppStore/chat-handler,
  Canvas, transcript-media/ownership, and provider media/session gates. That
  batch preceded the exact Grok-exit remediation above and did not by itself
  close the broader derived-store/full-transaction boundary.
- **2026-07-19 integrated completion update:** The consolidated current-tip
  lifecycle batch passed 771/771 across 21 files, covering broad/scoped/startup
  history transactions, Solo/Ensemble wakeups, exact provider settlement,
  regenerable bytes, PDF rendering/publication, transcript-media ownership,
  clipboard persistence, and dispatch revocation. Node typecheck, targeted
  lint, and diff checks were green on the same source-ahead candidate. This is
  source verification, not a packaged-release or externally commissioned
  provider-canary attestation.
- **2026-07-21 completeness-pass remediation update (named joins closed):**
  This pass re-mapped every durable store a chat id reaches on both erasure
  paths and closed the three joins the release disposition named, plus two
  stores the mapping found outside the transaction entirely.
  - *Store map.* Transactional in-store steps: scheduled orchestration,
    workflow-run history, run queue, run recovery, approval ledger, message
    feedback, sub-thread mailboxes, run events, run artifacts, Kimi seat
    state, chat records/list index, and project membership (including project
    graph edges and work-profile home bindings). Receipted external sinks:
    provider runs, maintenance compactions, Canvas, execution graphs, usage,
    Project-reference artifacts, transcript media plus regenerable bytes, and
    global bridge logs. Process-local joins: host commands, background
    processes, Codex thread admission, and solo/Ensemble wakeups. Newly
    joined this pass: Ensemble session checkpoints and human-collaboration
    shares/audit (below). Disclosed residuals: `AgentStatsStore` retains
    aggregate leaderboard rows carrying run/chat ids (no content) by design,
    and provider-native session files in shared provider homes are out of
    TaskWraith-owned scope (dedicated boundary below). Read-only tool
    subprocesses (FCPXML `xmllint` preflight, Canvas `simctl` device driver)
    write no chat-scoped durable state and stay outside the lifecycle
    registries.
  - *Exact host-command joins.* Both erasure paths were confirmed to await
    the registry cancellation completion before commit (broad quiesce and the
    per-chat mutation bundle inside the scoped coordinator's fenced begin).
    Two identity gaps were closed: [`HostCommandOperationRegistry.ts`](src/main/run/HostCommandOperationRegistry.ts)
    now resolve()-normalizes workspace paths on registration and cancellation
    scopes (a raw stored `WorkspaceRecord.path` no longer misses its
    normalized identity twin), and the projection-scope factory accepts
    partial identity, so a command carrying only workspace context joins
    workspace-scoped clears instead of registering unowned (unowned commands
    remain joined by global clears).
  - *Cancel-during-delete joins.* `AppStore.appendRunEvent` now refuses
    appends into a prepared (fsynced, uncommitted) deletion scope with the
    same strict-throw/soft-synthetic semantics as the post-commit tombstones;
    `saveRunQueueJob` refuses tombstoned inserts — `RunRepository.transition`
    routes terminal cancels through save-as-insert, which previously let a
    cancel settling after commit resurrect a queue job for the erased chat
    (a legitimately re-created chat file queues again, mirroring `saveChat`);
    `acknowledgeSubThreadMailboxDelivery` gained the durable fence its
    sibling mailbox writers already had. The Ensemble session-checkpoint
    store (`checkpoints/session-checkpoints.json` — round prompts, queued
    prompts, blackboard snapshots) was outside the transaction with no fence
    and no purge: [`SessionCheckpoint.ts`](src/main/checkpoints/SessionCheckpoint.ts)
    now soft-skips writers (upsert/accept/dismiss) for chats inside a
    prepared erasure or whose record is gone, purges strictly under the
    frozen intent from both scoped commit callbacks and the broad commit
    (throwing persists keep a failed purge pending/resumable), and runs a
    delete-only startup orphan sweep strictly after pending recovery
    resumes. `runManager.claimTerminalStatus` same-status idempotency —
    which lets a user cancel proceed after deletion claimed `'cancelled'` —
    is retained deliberately; with the writer-side fences above, that path
    can no longer produce durable frozen-scope writes. The solo-Codex seal
    and the stale-run reconciler now skip fenced chats cleanly (the
    reconciler continues its batch) instead of propagating the store fence
    throw.
  - *Codex app-server joins.* A fresh (non-resumable) run holds no admission
    reservation before `thread/start`, so a clear prepared during the
    `ensureStarted` await could mint a provider-native rollout for the frozen
    scope: the adapter now re-checks history authority synchronously between
    `ensureStarted` and the RPC, and
    [`ProviderTransportHistoryIntegration.test.ts`](src/main/ProviderTransportHistoryIntegration.test.ts)
    pins that ordering. The stale-MCP daemon restart guard
    ([`CodexRunRouting.ts`](src/main/CodexRunRouting.ts)) now also refuses to
    dispose the shared daemon while any thread-admission lane is held or
    awaited — a manual compaction or native review owns no RunManager session
    and no startup lease, so the restart previously tore the daemon down
    under it ungated. Startup ordering (pending-deletion resume before
    run-queue/graph/schedule recovery, with recovery skipped on failure) and
    the ambiguous-timeout retention contract were re-verified on the current
    tree.
  - *Reaper fencing.* The abandoned-chat reap handler deleted candidates via
    `Promise.all`, but the store admits one durable intent at a time, so any
    multi-candidate reap self-collided (first deletion detached, rest
    rejected, renderer told the predicted rather than actual list).
    [`chatHandlers.ts`](src/main/ipc/chatHandlers.ts) now deletes strictly
    sequentially, defers entirely while a durable erasure is pending (fail
    closed on an unreadable intent), stops mid-loop when one starts,
    re-validates every candidate against live records immediately before its
    own deletion, and returns exactly the deleted ids. The store-side orphan
    discovery remains read-only with its startup drain routed through the
    broad coordinator after pending recovery. The dead
    `deleteChatCascadeWithLifecycle` export — no production callers, a
    docstring claiming to be the deletion choke, and a direct store-delete
    call that would mint an empty-target intent if rewired — was removed.
  - *Stores newly joined to erasure.* `human-collaboration.json` share
    records were revoke-only on single-chat delete (root chat only) and
    untouched by broad clears, so enabled shares survived erasure and
    `reopenCollaborationRooms` re-opened their relay seats after restart;
    `human-collaboration-audit.json` retained bounded previews/hashes of
    chat contributions indefinitely.
    [`HumanCollaborationStore.ts`](src/main/collaboration/HumanCollaborationStore.ts)
    and [`HumanCollaborationAuditLog.ts`](src/main/collaboration/HumanCollaborationAuditLog.ts)
    now purge share records and audit rows (by chat id and by share id, since
    admission/invite rows carry no chat id) under the frozen intent from both
    commit paths; the runtime already denies by absence and drops the live
    session on the next inbound frame. Truncate keeps share capability but
    purges the content-adjacent audit rows, matching the approval/feedback
    ledger steps. Both stores are constructed above startup deletion
    recovery so a resumed transaction cannot hit their temporal dead zone.
  - *Regression evidence.* New deterministic coverage: prepared-window
    append/acknowledge fences and post-commit queue-insert refusal in
    [`AppStoreRunEvents.test.ts`](src/main/AppStoreRunEvents.test.ts),
    [`AppStoreSubThreadMailbox.test.ts`](src/main/AppStoreSubThreadMailbox.test.ts),
    and [`AppStoreHistoryDeletionTransaction.test.ts`](src/main/AppStoreHistoryDeletionTransaction.test.ts);
    checkpoint purge/fence/orphan-sweep and strict-persist failure in
    [`SessionCheckpoint.test.ts`](src/main/checkpoints/SessionCheckpoint.test.ts);
    reaper sequencing, in-flight-erasure deferral, mid-loop stop,
    per-candidate revalidation, and honest partial reporting in
    [`chatHandlers.test.ts`](src/main/ipc/chatHandlers.test.ts);
    canonical-path scope matching in
    [`HostCommandOperationRegistry.test.ts`](src/main/run/HostCommandOperationRegistry.test.ts);
    admission-lane restart refusal in
    [`CodexRunRouting.test.ts`](src/main/CodexRunRouting.test.ts) and
    [`CodexThreadAdmission.test.ts`](src/main/codex/CodexThreadAdmission.test.ts);
    collaboration purge behavior in
    [`HumanCollaborationStore.test.ts`](src/main/collaboration/HumanCollaborationStore.test.ts)
    and [`HumanCollaborationAuditLog.test.ts`](src/main/collaboration/HumanCollaborationAuditLog.test.ts).
    The consolidated lifecycle batch passed 361/361 across 28 files, the 20
    index-source contract suites passed 132/132, and Node plus web
    typechecks were green on the source-ahead candidate. The whole-tree
    vitest run passed 13498/13499 (29 skipped): the single failure is the
    pre-existing `provider-containment-canary` expectation of the release
    npm lane that the TW-SEC-2026-015 apparatus removal deliberately
    deleted — red at this pass's baseline, unrelated to this entry, and
    tracked for its own fix.
- **2026-07-26 scoped-deadline audit update:** Commit `3bf7bbca3` adds a
  two-minute bound around `ScopedHistoryDeletionCoordinator` quiescence and
  correctly refuses `commitDelete`/`commitTruncate` if a sink settles after the
  deadline. It does not, however, implement the claimed rollback. This
  coordinator deliberately retains its durable intent and every process-local
  hold after failure; its release callbacks run only after a successful commit.
  `deleteChatWithLifecycle`, `truncateChatWithLifecycle`, and their IPC handlers
  simply await the rejected promise. The rollback catch cited by the commit
  belongs to the separate broad history-deletion acquisition path, not to
  scoped deletion. The new tests prove timeout and no late commit, but do not
  assert durable-intent retirement, hold release, fresh-run admission, or a
  same-process retry. TW-SEC-2026-020 records that open regression; this update
  does not weaken the 2026-07-21 transaction invariants or count the deadline
  attempt as a completed remediation.
- **Explicit provider-native session boundary:** TaskWraith's erasure claim
  covers TaskWraith-owned state: `userData` stores, the external sinks above,
  and Kimi's TaskWraith-owned isolated seat homes (erased by the
  `kimi-seat-state` step). Provider-native session files created by
  provider-owned runtimes in shared user homes — Codex app-server
  rollouts/session indexes under `~/.codex`, Claude CLI project session files,
  Cursor state under `~/.cursor` — are the user's own provider-account data,
  shared with those CLIs outside TaskWraith. Deletion severs TaskWraith's
  linkage (chat records, participant `linkedProviderSessionId`, run thread
  ids) and the pre-`thread/start` recheck above stops new native threads from
  being minted for a frozen scope, but TaskWraith does not delete inside
  shared provider homes, and no release claim may imply otherwise.
- **Explicit platform limitation:** Portable Node/Electron does not expose a
  directory-descriptor-relative `unlinkat`/`renameat` primitive for the final
  pathname operation. The store descriptor-checks identity immediately before
  retirement and fails closed on every observed mismatch, but it does not claim
  race freedom against a malicious process running as the same local UID with
  write access to TaskWraith's private `userData` directory. That actor is
  outside TaskWraith's process-isolation boundary; the limitation remains
  documented rather than being hidden by a stronger erasure claim.
- **Original impact:** “Delete all chat history” or a per-chat deletion could
  report normal completion after only part of the owned state was removed. Surviving queue,
  ledger, mailbox, Canvas, run, or provider-session artifacts can retain history
  or help a late operation recreate it. This is a deletion-completeness and
  authority-ordering defect; it is not evidence that another user can read the
  residual data.
- **Retained remediation and verification invariants:**
  1. Build one main-owned deletion transaction that first resolves the exact
     chat/descendant cascade and every owned artifact, then raises all scoped
     lifecycle holds and revocations before any destructive await.
  2. Persist a deletion intent and per-store completion journal so a crash or
     individual filesystem failure resumes idempotently. Do not return success
     until every mandatory sink confirms the same deletion generation; surface
     a typed incomplete result with safe retry when it cannot.
  3. Route renderer, remote-draft, startup-orphan, abandoned-chat, workspace,
     global, and direct store call sites through that authority. Internal read
     paths must not trigger an unfenced destructive side effect.
  4. Add transcript-media asset and ownership-ledger purge as a mandatory,
     journaled step for chat, descendants, truncate, workspace, and global
     scopes. Preserve the transaction-long admission hold, active-ingest join,
     owned-write rollback, and batched descendant purge. Verify no target
     ownership or bytes remain before the visible chat/index commit.
  5. Preserve and regression-test the new restart rule: re-acquire every
     process-local hold, re-await/re-receipt fresh strict purges, and fail before
     commit if any resumed attempt rejects.
  6. Fence late writes, provider transport/session cleanup, native maintenance
     compactions, Project-reference snapshots, PDF page cache, media staging,
     and composer dictation with the same generation. Give both derived stores
     whole-store deletion targets: synchronously block admission, join active
     work, strictly purge/receipt every entry, replay startup cleanup, and verify
     absence before releasing the holds.
  7. Add failure injection at every store boundary—including transcript
     media—plus crash/restart recovery,
     parent/descendant cascades, direct orphan reap, concurrent dispatch, and
     late Canvas/provider completion tests.
- **Boundary links:** TW-SEC-2026-004 covers accepting a pending elevated
  approval after revocation; TW-SEC-2026-007 covers Canvas operations/surfaces;
  TW-SEC-2026-013 covers stale provider dispatch and owned-media rollback;
  TW-SEC-2026-016 covers the independently durable usage-history family.
  Closing any one of them does not prove this multi-store transaction complete.
- **Release disposition:** `Remediated` as of the 2026-07-21 completeness pass:
  the exact host-command, cancel/delete, and Codex app-server joins are closed
  on the source-ahead candidate, the reaper is erasure-fenced, and the
  checkpoint/collaboration stores joined the transaction. Keep any
  release-level claim of complete TaskWraith-owned erasure gated on the exact
  candidate's whole-tree CI, a packaged crash/recovery exercise, and the two
  explicit boundaries above (provider-native session files in shared homes;
  the same-UID platform limitation). Provider canary commissioning remains a
  separate qualification concern; it is not evidence for or against this local
  history transaction.

## TW-SEC-2026-015 — Release-attestation freshness was based on a rerunnable timestamp

- **Date:** 2026-07-19
- **Severity/status:** High / `Remediated` (source-ahead candidate; focused code review clean, external commissioning pending)
- **Owner:** TaskWraith maintainers — Provider canary and signed-release attestation
- **Original evidence:**
  - `successfulReleaseAttestation` in
    [`verify-provider-release-attestation.cjs`](scripts/verify-provider-release-attestation.cjs)
    measured freshness from a workflow run's mutable `updated_at` timestamp.
  - GitHub permits a partial job rerun without rerunning successful dependencies.
    The lightweight attestation-completion job could therefore be rerun later,
    refreshing the workflow update timestamp while reusing an older live
    containment result.
  - The verifier did not reject `run_attempt > 1` or require the newest exact
    release-dispatch candidate to be the successful one. A stale or superseded
    attestation could consequently appear fresh to a signed publisher.
- **Impact:** A release publication gate could accept live-provider evidence
  older than its configured freshness window, allowing a changed external
  provider/runtime condition to escape the intended just-in-time qualification.
  No evidence shows that an affected release was actually published.
- **2026-07-19 remediation update:**
  - The verifier now filters the exact workflow name, release-dispatch title,
    commit SHA, default branch, and repository-dispatch event, then selects the
    newest matching candidate by immutable `created_at` plus run id.
  - It requires a valid, non-future creation instant inside the age window,
    `status === 'completed'`, `conclusion === 'success'`, and
    `run_attempt === 1`. A newer failed or in-progress exact candidate blocks an
    older success instead of silently falling back to it.
  - [`verify-provider-release-attestation.test.ts`](scripts/verify-provider-release-attestation.test.ts)
    covers partial-rerun timestamp refresh, malformed/future/stale creation
    times, rerun attempts, newer failures, exact SHA/branch/event identity, and
    the publisher re-check call sites in [`ci.yml`](.github/workflows/ci.yml).
- **2026-07-19 verification update:** Independent re-review found the code
  remediation clean. The focused suite passed 27/27 with a clean diff check;
  all three CI queries include running/failed candidates, and both signed
  publication lanes re-run this exact helper immediately before mutation.
- **External commissioning boundary:** Code verification does not create a
  protected `provider-containment-canaries` environment or immutable/protected
  `v*` tag rules. Those controls must be configured and independently checked
  before their commissioning flags are enabled; they remain release blockers
  even after this timestamp defect is verified.
- **Release disposition:** `Block` signed publication until the source-ahead
  remediation is on the exact candidate and the external environment/tag
  controls are commissioned. Keep the code finding `Remediated`, not `Verified`,
  and preserve it as release-attestation provenance.
- **2026-07-21 apparatus removal (user decision):** The hosted release-attestation
  apparatus this finding governed was removed under AGENTS.md "Capability
  governance — the user decides": the dispatch workflow, the exact-SHA
  attestation job and freshness verifier, the release aggregate, and both
  commissioning variables are deleted from the tree. The user judged the gate
  over-complex and in conflict with their intent (it blocked signed publication
  on external commissioning state that was never chosen, against an empty
  required-fingerprint manifest, while actual releases use the local notary
  runbook). The timestamp-refresh defect and its fix are preserved above as
  provenance; with no attestation consumer, the release disposition is
  inoperative. Live containment canaries remain available as local, user-invoked
  qualification evidence (`verify:provider-permissions:live`), and the signed
  release jobs retain their artifact verification and remote-tag integrity
  checks. Closed by removal.

## TW-SEC-2026-016 — Usage history is outside scoped and global erasure

- **Date:** 2026-07-19
- **Severity/status:** High / `Remediated` (source-ahead candidate; whole-tree verification pending)
- **Owner:** TaskWraith maintainers — Usage privacy and data lifecycle
- **Evidence at the initial reviewed source-ahead point:**
  - `UsageRecord` in [`types.ts`](src/main/store/types.ts) always carries
    workspace, chat, and run identifiers. When the user enables prompt/response
    storage, the same record may also carry `promptText` and `responseText`;
    disabling the setting prevents those fields on new records but does not
    purge records already written.
  - [`UsageJournalStore.ts`](src/main/store/UsageJournalStore.ts) serializes the
    record into the `usage.json` checkpoint, live `usage-journal.jsonl`, claimed
    journals, immutable spill journals, and `usage-archive.jsonl`. A malformed
    journal or checkpoint can additionally create a byte-preserving quarantine
    or corrupt-backup artifact.
  - Compaction deliberately preserves replayability across crashes: it claims
    inputs, appends expired rows to the archive, commits the checkpoint, and
    retires claimed inputs last. The idempotency key prevents duplicate display,
    but it does not remove duplicate durable copies at intermediate crash
    boundaries.
  - [`usageRotation.ts`](src/main/store/usageRotation.ts) explicitly moves old
    rows to the append-only archive without deleting history. That archive is
    not served by the normal usage reader, but it remains TaskWraith-owned
    durable content.
  - The `HistoryDeletionIntent` and `HISTORY_DELETION_STEPS` in
    [`index.ts`](src/main/store/index.ts) did not include the usage store, and
    `recordUsage` did not bind an append to the pending deletion scope. Chat,
    truncate, workspace, or global history deletion could therefore complete
    while matching usage rows or a late matching append could survive.
- **2026-07-19 remediation in progress:**
  - [`UsageJournalStore.ts`](src/main/store/UsageJournalStore.ts) now has a
    durable operation-id-bound inner mutation intent, a synchronous hold,
    scope-aware append admission, compaction exclusion, strict atomic rewrites,
    residual verification, and idempotent recovery. Its scoped path covers the
    checkpoint, live/claimed/spill journals, archive, valid quarantine/corrupt
    copies, and managed temporary files; unparseable forensic bytes fail scoped
    deletion closed, while global deletion strictly removes every managed copy.
  - [`UsageHistoryDeletionTarget.ts`](src/main/services/UsageHistoryDeletionTarget.ts)
    freezes the outer preparation scope, awaits strict purge before a receipt
    can be written, and releases the inner hold only after outer commit.
    `AppStore.recordUsage` also consults the general history-mutation gate, and
    AppStore exposes begin/purge/end/recovery methods for the usage store. The
    implementation is typecheck- and lint-clean; the store-focused batch passed
    49/49, and the AppStore-integrated batch passed 65/65.
  - The current integration candidate registers usage as a distinct target in
    both broad and scoped history deletion. It acquires the correlated hold
    before destructive awaits, writes the strict-purge receipt through the
    outer coordinator, releases the inner hold only after outer commit, and
    runs inner-intent recovery before outer deletion and run-queue recovery even
    when the outer journal has already been retired.
  - The owner lane passed 81/81 focused integration/store checks plus 32/32
    AppStore/transaction/maintenance checks. An overlapping combined store,
    target, quiescence, startup, broad/scoped coordinator, and AppStore batch
    passed 101/101 across eight files. Final independent usage review passed
    99/99, manually verified hold/receipt/recovery ordering, and covered a crash
    after the inner intent reached completed state. Scoped lint and diff checks
    are green; no substantive usage-history residual remains.
  - Final adversarial review tightened the managed-artifact boundary further.
    Exact legacy `usage.json.corrupt-<timestamp>` backups and historical
    `usage.json.<pid>.<timestamp>.tmp` files are now included without treating
    arbitrary sibling names as owned. Readers observe the active deletion
    intent, so a corrupt checkpoint read cannot mint a new forensic backup
    behind a pending sweep. Private retirement directories are replayed after a
    crash immediately following rename, and an empty retirement left after
    unlink is removed on restart. The final store suite passed 55/55; the
    integrated usage, Project-reference, and deletion cluster passed 135/135,
    with Node typecheck green.
- **Impact:** Prompt and response text can contain workspace secrets, while the
  identifiers preserve linkage to an erased chat, run, or workspace. This is a
  first-party retention and deletion-completeness defect; it is not evidence of
  cross-user disclosure.
- **Candidate invariants to preserve:** New prompt/response content remains
  conditional on the user's explicit retention setting. Scoped and global
  purge must continue to cover every hot, replay, archive, forensic, and
  temporary artifact under one serialized store authority; unprovable scoped
  bytes fail closed, late matching reads/appends stay fenced, and recovery
  remains idempotent across durable prepare, private retirement rename/unlink,
  and every tested crash boundary. Managed-name recognition must remain exact
  so cleanup neither misses historical TaskWraith artifacts nor claims an
  unrelated sibling file.
- **Verification still required:** Run the exact reconciled candidate through
  the whole-tree typecheck/test gates and repeat the packaged deletion/restart
  sentinel exercise. Preserve failure injection between the inner intent,
  outer receipt, visible commit, post-commit release, and both recovery
  directions; no path may report success or revive queue work while either
  correlated intent remains incomplete.
- **Release disposition:** Keep `Remediated`, not `Verified`, until those final
  candidate gates are green. The source-ahead usage residual itself is closed;
  unqualified claims about released v1.8.4 behavior remain out of bounds.

## TW-SEC-2026-017 — `canvas_fill` approval history retained typed values

- **Date:** 2026-07-26
- **Severity/status:** Medium / `Remediated` (source-ahead, forward-only fix;
  exact-candidate verification pending)
- **Owner:** TaskWraith maintainers — Canvas approval privacy and durable audit
- **Original evidence:**
  - A `canvas_fill` approval carries the exact proposed text in
    `preview.params.value` so the human can review what the agent will type.
    [`ApprovalOrchestration.ts`](src/main/run/ApprovalOrchestration.ts) projected
    that same payload into both the durable run-event store and Approval Ledger.
  - The Canvas audit log itself retained only target metadata, and the tool
    catalogue told agents that the typed value was never recorded. The durable
    approval path therefore contradicted the advertised retention contract.
  - Text entered into a login, form, document, or other Canvas field can contain
    credentials, personal data, or unpublished content. This is first-party
    local retention, not evidence of cross-user access or off-box disclosure.
- **2026-07-26 remediation update:**
  - `redactCanvasFillValueForDurableStorage` now creates a separate durable
    projection: the value becomes `[redacted]` with `valueRedacted: true`, while
    `canvasId`, target ref, and other non-secret audit metadata remain intact.
    The transient approval card still receives the exact value the human is
    being asked to approve.
  - [`ApprovalOrchestration.test.ts`](src/main/run/ApprovalOrchestration.test.ts)
    asserts that neither durable sink contains the sentinel value, the redaction
    marker remains inspectable, target metadata survives, and the live prompt
    still shows the exact proposal.
- **Retained boundary:** The change is forward-only. Existing Approval Ledger
  and run-event history is not rewritten; users who may have approved sensitive
  Canvas fills on an earlier source-ahead build should clear the affected chat's
  history. Release notes must preserve that disclosure.
- **Verification still required:** Exercise every provider/native approval
  ingress on the exact candidate and inspect all first-party durable
  projections, exports, and paired-device payloads. Do not broaden “never
  recorded” beyond the tested value field and TaskWraith-owned sinks.
- **Release disposition:** Keep `Remediated`, not `Verified`, until that matrix
  is green and the forward-only residual remains visible.

## TW-SEC-2026-018 — Canvas grants were not bound to the approved surface

- **Date:** 2026-07-26
- **Severity/status:** High / `Remediated` (source-ahead candidate;
  exact-candidate verification pending)
- **Owner:** TaskWraith maintainers — Canvas and approval authority
- **Original evidence:**
  - Session grants for `canvasInteraction` were keyed by provider, service, and
    workspace/run, without the `canvasId` shown in the approval prompt. One
    “allow for session” response therefore covered every Canvas already open
    and every Canvas opened later in that run.
  - `canvas_list` lets an agent enumerate a chat's surfaces. The unscoped grant
    could consequently reach a renderer-created preview the user had never
    approved, including a surface carrying an authenticated web session.
  - A workspace grant was broader still: “interact with any preview, in any
    chat, until revoked” outlived the surface and was not a bounded consent
    scope. Persisted grants from older builds could also continue promoting the
    service.
- **2026-07-26 remediation update:**
  - [`PermissionService.ts`](src/main/PermissionService.ts),
    [`RunManager.ts`](src/main/RunManager.ts), the native approval route, and
    [`ApprovalService.ts`](src/main/services/ApprovalService.ts) now thread the
    exact `surfaceId` through grant lookup and response-time grant creation.
    Both run-attached and fallback session keys include that identity.
  - Omitting the surface fails closed for `canvasInteraction`: it neither
    matches nor mints a session grant. Workspace grants for this service are
    refused at lookup and filtered from effective posture, so a legacy stored
    grant is inert rather than honoured.
  - [`PermissionService.test.ts`](src/main/PermissionService.test.ts),
    [`EffectiveRunPermissions.test.ts`](src/main/EffectiveRunPermissions.test.ts),
    and [`ApprovalOrchestration.test.ts`](src/main/run/ApprovalOrchestration.test.ts)
    cover cross-surface refusal, omission, run-scoped storage, legacy workspace
    state, and request/response identity propagation.
- **Boundary of the fix:** A user may still grant repeated actions on one exact
  Canvas for the session; the remediation intentionally avoids a modal for
  every click. It does not replace the stronger structural rule that Canvas
  drivers cannot target TaskWraith's renderer or consent chrome. Under a stored
  `workspace` policy, the generic action builder can still offer
  `acceptForWorkspace` and persist an inert row; it cannot authorize any Canvas
  interaction, but the false-scope UI/audit affordance should be removed or
  down-clamped before the boundary is described as “no workspace tier.”
- **Verification still required:** On the exact candidate, exercise
  Gemini/Claude/native and run-attached/fallback approval paths with two
  canvases, renderer-created post-grant surfaces, missing ids, stale ids, and
  imported legacy settings. Assert no cross-surface auto-allow and no
  workspace-tier promotion, and pin the effective action shown/recorded for a
  stored `workspace` policy.
- **Release disposition:** Keep `Remediated`, not `Verified`, until the
  integrated surface-identity matrix is green.

## TW-SEC-2026-019 — Theme writes inherited grants and shaped consent spacing

- **Date:** 2026-07-26
- **Severity/status:** High / `Remediated` (source-ahead candidate;
  live-tool-turn and exact-candidate verification pending)
- **Owner:** TaskWraith maintainers — Appearance authority and consent surfaces
- **Original evidence:**
  - `theme_tokens_set` rides the generic `mcpTools` service. A session grant
    accepted for any unrelated MCP tool could therefore silence every later
    appearance write, despite the intended “never auto-allow, never elevate”
    contract for a capability that changes the surface used for later trust
    decisions.
  - The appearance allowlist correctly excluded consent colours, text,
    backgrounds, focus rings, provider identity, and approval-sheet geometry.
    It still allowed `space-sm` down to zero, while consent decision rows used
    that token for their flex gap. An agent could place Accept and Reject
    edge-to-edge, turning a near-miss on Reject into an acceptance.
  - Flex wrapping and non-negative gap meant controls could not overlap, hide,
    or be pushed out of reach. The bounded exposure was consequential-control
    adjacency, not arbitrary CSS execution or invisible consent.
- **2026-07-26 remediation update:**
  - [`McpRouteGuards.ts`](src/main/mcp/McpRouteGuards.ts) now classifies
    `theme_tokens_set` as an every-call human prompt. Its `forcePrompt` path is
    evaluated ahead of standing grants, Trusted Session, and Boss/YOLO
    auto-approval. `theme_tokens_get` remains a read and does not inherit this
    mutation-only rule.
  - Consent decision rows now use literal spacing that the appearance channel
    cannot alter. [`consentSurfaceTokens.test.ts`](src/renderer/src/styles/consentSurfaceTokens.test.ts)
    derives forbidden tokens from the actual agent-writable allowlist and finds
    consent control rows structurally across renderer CSS, so future token or
    surface additions cannot pass through a hand-maintained two-rule list.
  - [`McpRouteGuards.test.ts`](src/main/mcp/McpRouteGuards.test.ts) pins the
    every-call classification and its distinction from ordinary grantable MCP
    tools.
- **Verification still required:** Run a real provider tool turn that first
  acquires an unrelated MCP session/workspace grant, then calls
  `theme_tokens_set`; the second call must still show the exact human modal.
  Re-run the structural CSS guard on the final candidate and inspect every
  consequential consent row. The separate live multi-window broadcast check
  also remains pending.
- **Release disposition:** Keep `Remediated`, not `Verified`, until those
  exact-candidate and live-tool-turn checks are green.

## TW-SEC-2026-020 — Scoped deletion timeout retains its blocking authority

- **Date:** 2026-07-26
- **Severity/status:** High / `Remediated`
- **Owner:** TaskWraith maintainers — Data lifecycle, history erasure, and run
  admission
- **Evidence:**
  - [`ScopedHistoryDeletionCoordinator.ts`](src/main/ScopedHistoryDeletionCoordinator.ts)
    explicitly defines failed attempts as retaining their durable intent,
    Canvas/admission holds, and external-store holds for a resumable retry. Its
    release callbacks and `retainedByOperation.delete` run only after
    `commitDelete` or `commitTruncate` succeeds.
  - Commit `3bf7bbca3` wraps `settleAndCommit` in a two-minute deadline. The
    timer sets `deadlineExceeded` and rejects the caller, but it neither retires
    the pending `HistoryDeletionIntent` nor calls any retained hold's `end`
    method. When the underlying sink settles later, the new pre-commit check
    correctly refuses the destructive commit, leaving those authorities
    retained.
  - The production `deleteChatWithLifecycle` and `truncateChatWithLifecycle`
    wrappers simply await `coordinator.run`; their IPC handlers do the same.
    The rollback catch cited by the commit is inside the separate broad
    history-deletion acquisition callback and cannot unwind the scoped
    coordinator's private retained state.
  - `deadlineExceeded` is not reset on same-process retry. Even after the
    original slow sink settles, a retry reuses the retained operation and
    refuses to commit. Restart reconstructs process-local state and can replay
    the durable intent, which is the same restart dependency the change was
    meant to remove.
  - The new tests assert that the promise rejects and no late commit occurs.
    They do not assert `endCanvasClear`/other releases, pending-intent state,
    intended run admission, or a successful/explicitly aborted retry.
- **Impact:** A stalled abandoned-chat reap, delete, or truncate can continue
  blocking new work in its frozen history scope after the visible timeout. The
  exact breadth to unrelated chats remains unverified. The late-commit guard
  prevents an erasure from committing after authority should have ended, so
  this is an availability and transaction-convergence defect, not evidence of
  unauthorized data deletion.
- **Required remediation and evidence:**
  1. Define one durable timeout state that safely converges partial external
     purges, the deletion intent, every process-local hold, and future write
     admission. Do not merely delete the intent after some sinks may already
     have purged, and do not release holds while a late continuation can still
     commit.
  2. Make retry or explicit abort deterministic in the same process. A retry
     must not inherit a permanently true deadline flag, duplicate holds, or
     reuse authority that has already been released.
  3. Add production-composition tests that stall each sink in turn, cross the
     deadline, settle late, and assert: zero late commit, exact once-only hold
     reconciliation, honest durable-intent state, intended run admission, and
     safe retry/restart behavior.
- **2026-07-27 remediation and exact-candidate evidence:**
  - Commit `55ead7220` replaces the operation-wide permanent deadline bit with
    attempt-local authority. A timed-out attempt keeps every exact hold while
    its uncancellable continuation is live, and an overlapping retry is
    rejected before it can duplicate teardown or authority.
  - A late continuation that successfully quiesces every sink is still refused
    at the commit boundary. Only then are usage, maintenance, background
    process, Project-reference, transcript-media, and Canvas holds exhausted
    exactly once. The process-local retained operation is retired, while the
    outer durable intent and its honest receipts remain for an explicit retry.
  - A fresh same-process retry no longer inherits the expired attempt. It
    reacquires process-local holds and strictly re-purges usage,
    Project-reference, and transcript-media state before committing. The
    production usage adapter now has an explicit completion-aware release path,
    so a reconciled timeout does not falsely claim the outer deletion committed.
  - [`ScopedHistoryDeletionCoordinator.test.ts`](src/main/ScopedHistoryDeletionCoordinator.test.ts)
    crosses the deadline independently for background-process join, Ensemble
    cancellation, provider termination, maintenance compaction, Canvas close,
    execution-graph deletion, usage purge, Project-reference purge, and
    transcript-media purge. Every case proves zero late commit, no release
    while work is outstanding, one reconciliation release, retained durable
    intent, no duplicate holds, and a successful fresh retry.
  - Exact-candidate validation passed the focused lifecycle suites plus the
    complete repository gate: 1,283 test files and 16,364 tests passed, with
    both TypeScript projects, lint, architecture, provider-intent, doctrine,
    iOS plist, formatting ratchet, bundled-secret guard, dependency signatures,
    zero production audit findings, and the native PTY smoke check green.
- **Release disposition:** The 1.9.0 block is cleared on this exact candidate.
  Keep the delayed-sink matrix and completion-aware release boundary
  load-bearing; releasing a hold before its continuation settles or allowing a
  late commit reopens this finding.

## Combined AntiGravity/Gemini API certification contract

The source-ahead combined-mode implementation has a tracked threat model and
migration contract in
[`docs/antigravity-gemini-api-threat-model-and-migration.md`](docs/antigravity-gemini-api-threat-model-and-migration.md).
It is the authoritative concise reference for the dedicated main-only
purpose-bound safeStorage boundary, unsafe-backend fail-closed behavior,
official `@google/genai` public transport, and the prohibition on OAuth,
keyring, `agy`, retired-Gemini, legacy-profile, environment, argv, or private
endpoint credential reuse. It also records default-null upgrade behavior,
set/clear/dormant/rollback semantics, Free/Paid data-use disclosure without
tier inference, separate billing/project limits/quota, AGY parity, and
renderer/paired-iOS nonsecret projection. The contract preserves the static
live set, retired `gemini`, First Launch, and marketing boundaries; it does not
authorize capability removal. Verify the linked source regressions on the
exact release candidate before clearing the combined-mode release block.
