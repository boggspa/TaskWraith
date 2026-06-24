# Queue and Steering Lifecycle Plan

Status: research plus adversarial review synthesis. No runtime edits are approved by this document.

## Objective

Improve TaskWraith queueing and steering so busy-chat follow-up feels smooth and
intentional across providers, without changing the composer/above-row stack UX.
The change should target transcript, agent-run, run-queue, participant, wakeup,
and scheduled lifecycle semantics.

## Evidence Summary

Codex public behavior separates next-turn queueing from active-turn steering.
The Codex manual documents CLI follow-up queueing while a turn runs, and
documents app-server `turn/steer` as appending user input to an in-flight turn.
It does not document desktop-app internals for this behavior. Thread
automations are the closest public equivalent to wakeups: recurring wake calls
attached to a thread that preserve context.

TaskWraith solo chat queueing already has a useful substrate:

- `queueRunRequest` persists a `RunQueueJob`, stores a full request snapshot,
  appends an optimistic renderer queue entry, and writes a queued system card.
- The above-row queue owns live pending-intent display; transcript queued cards
  are hidden while the job is still pending.
- The queue pump dispatches by target-chat idleness, not provider-wide idleness.

The current hard edge is steering. Composer Steer has a guarded flow:

1. mark `cancelling`
2. suppress late assistant deltas
3. mark the active run as an intentional cancel
4. call provider cancel
5. wait for the active run to clear
6. append a `steerHandoff` marker
7. dispatch the replacement request
8. fallback to queue on timeout

Queued-row Steer bypasses this harness. It removes the queued item, marks the
durable queued job `cancelled`, calls the cancel path, and dispatches
immediately. That creates audit ambiguity and can race with active-run cleanup.

Provider capability research says no current provider supports true generic
"add this prompt to the active model turn" behavior:

- Codex has graceful `turn/interrupt` plus native thread resume, but one
  `turn/start` per TaskWraith run.
- Claude and Cursor can resume next runs natively, but active follow-up is not
  available.
- Gemini, Kimi, Grok ACP, Gemini API, and Ollama need host-managed context or
  app memory for continuity.
- Grok ACP exposes protocol cancellation, but TaskWraith appears to route common
  cancellation through process kill today.

Ensemble and wakeup lifecycles provide a better precedent: normal active sends
queue and let the current participant finish; explicit Steer interrupts.
Wakeups and scheduled tasks remain distinct continuation sources and avoid
canceling active work unless the user explicitly asks for interruption.

## Design Direction

Model three separate lifecycle concepts:

1. **Queued follow-up**: next-turn user intent. It waits for the active chat run
   or ensemble round to reach a boundary.
2. **Steer handoff**: explicit interrupt and replacement. It is cancellation
   plus a new run, with a visible lifecycle marker and durable audit trail.
3. **Wake/scheduled continuation**: time-triggered continuation. It should share
   queue substrate where possible but keep provenance distinct.

Do not promise live active-turn instruction injection unless a provider later
advertises it explicitly.

Adversarial review changed the center of gravity of this plan: the clean
solution is not a renderer-only shared steer harness. Queue promotion, cancel
intent, run-summary visibility, lifecycle events, and restart recovery need one
main-owned authority. Renderer state can provide immediate affordances, but it
must not be the source of truth for queue state transitions or lifecycle
history.

The user-visible "Task Complete" / run-summary flash during Steer is a symptom
of the same issue. A steer handoff should not briefly present the interrupted
run as a normal completed boundary. It should stay in an interrupt-and-replace
continuation state until either the replacement dispatch starts or the handoff
falls back to an ordinary queued follow-up.

## Proposed Architecture

### Dispatch Interaction Capabilities

Add a small interaction capability layer separate from session resume. This
must be resolved per dispatch surface and transport, not as a static
provider-only table:

```ts
type InFlightPromptCapability = 'unsupported' | 'native-interrupt-only' | 'native-active-followup'

type CancelPrimitive =
  | 'codex-turn-interrupt'
  | 'abort-controller'
  | 'process-kill'
  | 'grok-acp-session-cancel'
  | 'none'

interface DispatchInteractionCaps {
  inFlightPrompt: InFlightPromptCapability
  appQueueWhileRunning: true
  cancelPrimitive: CancelPrimitive
  cancelFallback?: CancelPrimitive
  cancelIsGraceful: boolean
  nativeConversationResume: boolean
  hostTranscriptReplay: boolean
  runtimePreambleReinjection: boolean
  requiresResumeSessionId: boolean
  hasRemoteComposerContext: boolean
}
```

Initial policy:

- Default busy submit to app-level queue for every provider.
- Keep Steer copy honest: "interrupt current run and start this prompt".
- Only expose live active steering if a provider later supports
  `native-active-followup`.
- Treat current Codex integration as interrupt-and-replace. Public Codex
  app-server `turn/steer` exists in documentation, but this codebase currently
  wires `turn/start` and `turn/interrupt`.
- Do not advertise Grok ACP session cancellation as implemented until the ACP
  run handle is retained on the active run session and called before process
  kill fallback.

### Main-Owned Run Lifecycle Coordinator

Introduce a main-process coordinator for queue leasing, queued-row promotion,
Steer cancellation, lifecycle event emission, and restart recovery. The
renderer may still host visual state and dispatch existing run requests, but
the authoritative transition must happen in main.

Required coordinator behavior:

- Provide `promoteQueuedJobForSteer(jobId, expectedStatus, ownerToken)` or an
  equivalent IPC/API that atomically reserves the selected job before cancel
  begins.
- Move queued jobs through an explicit nonterminal promotion state such as
  `promoting` or `steer_promoting`; the normal queue pump must never lease this
  state.
- Require dispatch to prove it owns the promotion token.
- Persist intentional cancel state before signaling the provider.
- Observe the active run terminal/cancelled state before replacement dispatch
  unless a provider-specific route can prove safe active handoff.
- Emit ordered lifecycle events in the same authority path as queue mutation.
- Fall back by returning the promoted job to ordinary queued state or creating a
  new queued follow-up, with a durable reason.
- Keep renderer run-summary/Task Complete UI suppressed for intentional steer
  handoff until the replacement dispatch or fallback is known.

Terminal queue statuses should be irreversible except through explicit recovery
that creates a new run identity. The current cancellation-as-promotion behavior
must be removed.

### Durable Lifecycle Events

Queue and steer transitions should be main-owned durable lifecycle events, not
only renderer raw logs. Candidate event summaries:

- `queued_followup_requested`
- `queued_followup_leased`
- `queued_followup_cancelled`
- `queued_followup_promoted`
- `steer_requested`
- `steer_cancel_landed`
- `steer_dispatch_started`
- `steer_fallback_queued`

These should remain lifecycle/control events, not `tool` messages, and should
not be replayed into provider prompt history as user/system task content.

Every event needs a deterministic idempotency key, for example
`{queueJobId}:{transition}:{attempt}` or a monotonic transition version on the
queue job. Retried IPC or recovery replay must not append duplicate lifecycle
records.

The queue job should carry the id spine used to correlate UI and audit state:
`queueJobId`, `queueMessageId`, `appRunId` or `dispatchRunId`, source
provenance, promotion owner token, and structured transition metadata.

### Transcript Rules

Pending queued intent stays above the composer. Transcript cards are historical
lifecycle records only after dispatch/cancel/promotion.

`system` cards are assistant stream boundaries, so `steerHandoff` must not be
inserted until the old run has cleared. Otherwise late deltas can be routed into
a fresh assistant bubble and appear to belong to the wrong turn.

Renderer-created lifecycle cards are not reliable as source of truth. They can
be lost during active-run chat reconciliation, and stale "will dispatch" cards
can resurface after edit/delete/cancel with misleading content. Prefer
projecting lifecycle UI from durable main-owned queue/run events. If transcript
cards remain stored messages, chat reconciliation must preserve queue/steer
system markers by deterministic ids and update them on terminal transitions.

Do not use `role: 'tool'` for queue or steer lifecycle rows. Tool rows affect
assistant delta targeting and tool rendering. Reserve `tool` for real tool
activity or explicitly modeled untrusted child output.

### Ensemble and Wakeups

Preserve ensemble semantics:

- active send queues by default
- explicit steer cancels current round
- queued prompts are FIFO next-round work
- wakeup waiting happens only when no queued prompt is ready

Fix queued-message steer for ensemble by either preserving/re-staging the
remaining FIFO queue after a steer or restricting queued-row Steer to the head
item until preservation exists. Silent loss of later queued prompts is not an
acceptable final behavior.

Queued ensemble entries need stable ids; index-based edit/delete/steer can
target the wrong item if the queue changes between render and click. Desktop and
remote queue-item steer must share the same head-only or preserve/restage rule.

Wakeups and scheduled tasks can reuse queue-pump primitives, but their
provenance should stay distinct from user-submitted queued follow-ups.

Queue-drain precedence must be explicit across desktop queueing, remote
composer, scheduled/headless dispatch, wakeups, Work Session continuations, and
sub-thread auto-resume. A starting priority matrix:

1. active-run cleanup and steer handoff
2. user and remote FIFO queued follow-ups
3. Work Session continuation
4. scheduled/headless tasks
5. wakeups
6. sub-thread auto-resume

Wakeups and Work Session continuations carry state that ordinary prompts do
not: permissions, provider session id, scratchpad inputs, wakeup identity,
manager/participant gates, budgets, target role, and duplicate/no-progress
guards. If they enter a shared queue, they must be structured jobs with
provenance-specific dequeue validation, not flattened prompt text.

## Candidate File Work

Planning-only list for implementation agents:

- `src/main/store/types.ts`: add queue/steer event metadata or extend run event
  kinds if needed; add promotion state, owner token, idempotency/version fields,
  schema version, and structured provenance beyond prompt text.
- `src/main/services/RunQueueService.ts`: include `remote` in the accepted
  source set to match `RunQueueJobSource`; preserve `remoteComposer` and other
  declared snapshot fields; add atomic promotion/lease semantics.
- `src/main/RunQueue.ts`: replace permissive status updates with an explicit
  transition graph; reject terminal-to-nonterminal resurrection; define or
  remove `paused`.
- `src/main/RunLifecycleCoordinator.ts` or similar: own per-chat arbitration,
  queued-row promotion, steer cancellation, fallback, lifecycle events, and
  restart recovery.
- `src/main/ProviderCapabilities.ts` or a new sibling module: define per
  dispatch/transport interaction capabilities.
- `src/renderer/src/lib/steerState.ts`: keep the state machine pure, but make it
  a visual projection of coordinator state rather than the authority.
- `src/renderer/src/App.tsx`: extract unified `steerThenDispatch`; route both
  composer Steer and queued-row Steer through the main coordinator; preserve
  live chat rebasing only where renderer still owns dispatch; suppress
  run-summary/Task Complete banners during intentional steer handoff.
- `src/renderer/src/lib/queuedMessageRows.ts` and
  `src/renderer/src/components/QueuedMessagesAboveRow.tsx`: keep UI shape, but
  route actions through durable lifecycle semantics; add rollback/error handling
  for edit/delete/reorder and keyboard-accessible reorder controls.
- `src/main/services/EnsembleOrchestrator.ts`: preserve remaining queued prompts
  on steer or reject non-head queued steer explicitly; add stable queued entry
  ids.
- `src/main/SoloChatWakeupService.ts`, `src/main/WakeupTimerService.ts`,
  `src/main/HeadlessScheduledDispatch.ts`: reuse only where provenance stays
  explicit.
- `src/renderer/src/components/TranscriptPanel.tsx` and
  `src/renderer/src/lib/assistantDeltaTarget.ts`: keep queued/steer lifecycle
  markers out of active assistant streams and tool rendering.
- Tests: `steerState`, `queuedMessageRows`, `RunQueue`, `RunQueueService`,
  `EnsembleOrchestrator`, `SoloChatWakeupService`, and App-level queue pump
  tests where existing harnesses allow it.

## Adversarial Review Findings

These findings are now implementation constraints:

- **Atomic promotion:** queued-row Steer must reserve the selected queue job in
  main before active-run cancel begins. The normal pump must ignore reserved
  jobs, and dispatch must hold the promotion token.
- **Main authority:** renderer-only lifecycle events and renderer-owned
  transcript markers are insufficient. Main must own queue state, cancel intent,
  durable lifecycle events, and restart recovery.
- **Terminal irreversibility:** terminal queue jobs must not be resurrected as
  active/queued by generic upsert paths. Recovery creates explicit new identity
  or terminalizes stale state with a reason.
- **Stale queue reconciliation:** startup must validate queued, starting,
  promoting, cancelling, and paused jobs against existing chats, workspaces,
  request snapshots, active sessions, and recovery rules.
- **Remote parity:** `remote` is already a declared source and must not be
  sanitized to `manual`; `remoteComposer` must survive queue snapshot
  normalization before remote flows use shared primitives.
- **No data loss in ensemble:** queued-row Steer cannot drop later FIFO entries;
  until preservation is implemented, disable unsafe steer actions.
- **Run-summary continuity:** intentional Steer should not flash a normal
  completion summary or "Task Complete" banner between interrupted and
  replacement runs.
- **Delta isolation:** suppression must be run/epoch based, not only `chatId`
  based. For events without reliable run ids, do not start replacement dispatch
  until the old provider exit has landed.
- **Source-specific queueing:** wakeups, scheduled tasks, Work Session
  continuations, remote prompts, and sub-thread auto-resume require distinct
  structured jobs and dequeue validation.
- **Accessibility:** queued rows need list semantics, keyboard reorder or move
  controls, contextual action labels, and announced position changes.

## Revised Implementation Phases

### First Implementation Slice

Ship one narrow first slice: main-owned solo queued-row Steer promotion, run
completion/banner suppression for Steer handoff, and enough lifecycle projection
to avoid stale queued cards. Do not fold wakeups, scheduled/headless dispatch,
Work Session continuations, or sub-thread auto-resume into this slice.

1. Define queue schema, transition graph, idempotency spine, `paused` semantics,
   and remote snapshot preservation. Add migration/recovery tests.
2. Add repository/service APIs for atomic promotion:
   `promoteQueuedJobForSteer`, `leasePromotedSteerJob`, and
   `fallbackPromotedSteerJob`. Same-token retries are idempotent; different
   tokens fail.
3. Add the main lifecycle coordinator beside `RunCoordinator`. For the first
   slice it can return a sanitized request snapshot plus promotion token to the
   existing renderer `executeRun`; it does not need to move all dispatch into
   main.
4. Wire desktop solo queued-row Steer through the coordinator. Delete the
   current `cancelled`-as-promotion path.
5. Suppress run-summary/Task Complete UI only for intentional Steer handoff.
   Stop-button cancellation should continue to show stopped/cancelled feedback.
6. Add a small lifecycle projection helper so cancelled, edited, or promoted
   queued cards do not resurface with stale "will dispatch" text.
7. Preserve/restage remaining FIFO entries for desktop ensemble queued-row
   Steer, or disable unsafe multi-item steer until preservation exists. Remote
   queue-item steer can follow once its projection/indexing is aligned.

### Later Slices

1. Move composer Steer cancellation intent fully into the main coordinator and
   add run/epoch delta isolation.
2. Project queue/steer lifecycle UI from durable state; retire or harden
   renderer-created queued/steer transcript markers.
3. Harden remote ensemble queue identity and queued-row steer preservation with
   stable queued entry ids.
4. Bring remote composer onto the same promote/lease path after generic queue
   normalization preserves remote provenance.
5. Bring scheduled/headless dispatch, wakeups, Work Session continuations, and
   sub-thread auto-resume onto the same per-chat arbitration model with
   source-specific provenance.
6. Add per dispatch/transport interaction capabilities and provider conformance
   tests after the coordinator API is stable.

## Implementation Work Split

Suggested disjoint patches for implementation agents:

1. **Schema and transition graph**
   - Files: `src/main/store/types.ts`, `src/main/RunQueue.ts`,
     `src/main/RunRecovery.ts`, `src/main/services/RunQueueService.ts`.
   - Add `steer_promoting` or `promoting`, promotion token/attempt/version
     metadata, `queueMessageId`, strict terminal irreversibility, explicit
     `paused` recovery semantics, and `remote`/`remoteComposer` preservation.

2. **Atomic promotion APIs and lifecycle events**
   - Files: `src/main/RunRepository.ts`,
     `src/main/services/RunQueueService.ts`, main IPC/preload API surfaces.
   - Add compare-and-swap style promotion/lease/fallback helpers and emit
     `kind: 'lifecycle'`, `phase: 'control'` events with idempotency keys in
     payload.

3. **Lifecycle coordinator**
   - Files: new `src/main/services/RunLifecycleCoordinator.ts`, main wiring.
   - Reserve queue job, persist cancel intent, call/correlate cancel, wait for
     active run cleanup, return dispatch permission or durable fallback.

4. **Renderer solo queued-row Steer**
   - Files: `src/renderer/src/App.tsx`, preload types.
   - Replace `handleSteerToQueuedMessage`'s `cancelled` transition with
     coordinator promotion. Remove optimistic row only after promotion succeeds;
     rollback or report error on failure.

5. **Run-summary and stale lifecycle UI**
   - Files: `src/renderer/src/lib/runCompleteNotice.ts`,
     `src/renderer/src/App.tsx`,
     `src/renderer/src/components/TranscriptPanel.tsx`,
     `src/renderer/src/lib/queuedMessageRows.ts`.
   - Add run/reason-aware suppression for intentional Steer, and derive queued
     lifecycle copy so terminal/promoted rows do not say "Will dispatch".

6. **Ensemble safety gate**
   - Files: `src/renderer/src/App.tsx`,
     `src/renderer/src/components/QueuedMessagesAboveRow.tsx`,
     remote queue-item steer path in `src/main/index.ts` if applicable.
   - Disable non-head or multi-item queued Steer before mutation unless the same
     patch preserves/restages remaining FIFO entries.

## Acceptance Tests

- Queued-row Steer and queue pump race: one selected job is promoted exactly
  once; no duplicate dispatch; the job is never terminal `cancelled` before it
  starts.
- Cancel timeout: promoted job returns to ordinary queue or creates a fallback
  queued follow-up with a lifecycle reason; UI exits steer state cleanly.
- Intentional steer cancellation: interrupted run records cancelled/steered
  status from main, replacement dispatch starts after cancel landing, and the
  Task Complete/run-summary banner does not flash between them.
- Late provider output: old-run assistant deltas cannot attach to replacement
  assistant bubbles.
- Startup recovery: valid queued jobs survive; invalid queued/promoting/paused
  jobs terminalize or requeue according to explicit rules.
- Remote queue: `source: 'remote'` and `remoteComposer` survive request,
  snapshot, lifecycle event, dispatch, and projection.
- Ensemble queue `[A, B, C]`: steering `B` either starts `B` and preserves
  `[A, C]` in documented order or the action is disabled before mutation.
- Edit/delete/reorder failure: durable mutation failure rolls the UI back or
  reports an error instead of stranding optimistic rows.
- Lifecycle idempotency: retrying request/lease/promote/fallback IPC does not
  create duplicate events or duplicate transcript projections.

Concrete first-slice test targets:

- `src/main/RunQueue.test.ts`
  - rejects `cancelled|failed|completed -> queued|starting|active|steer_promoting`
  - allows `queued -> steer_promoting -> starting`
  - allows `steer_promoting -> queued` fallback
  - excludes `steer_promoting` from ordinary runnable queue jobs
- `src/main/services/RunQueueService.test.ts`
  - preserves `source: 'remote'` and `request.remoteComposer`
  - idempotently promotes with the same token
  - rejects a second token for an already promoted job
  - refuses ordinary lease for `steer_promoting`
  - requires matching token for promoted lease
- `src/main/RunRecovery.test.ts`
  - recovers stale `steer_promoting` by explicit requeue or terminalization rule
  - keeps stale `cancelling` behavior consistent with active-run recovery
- `src/renderer/src/lib/steerState.test.ts` or a new focused helper test
  - suppresses run-complete notice for intentional Steer handoff
  - still shows stopped/cancelled notice for plain Stop
  - isolates old-run late delta by run id or epoch
- `src/renderer/src/lib/queuedMessageRows.test.ts`
  - disables ensemble queued Steer for FIFO length greater than one
  - allows singleton ensemble queued Steer if the existing path remains safe
  - never projects cancelled/promoted queued cards as "Will dispatch"
- Existing source-specific smoke tests for deferred paths:
  - `src/main/services/EnsembleOrchestrator.test.ts`
  - `src/main/SoloChatWakeupService.test.ts`
  - `src/main/HeadlessScheduledDispatch.test.ts`

Suggested validation after implementation:

```sh
npx vitest run src/main/RunQueue.test.ts src/main/services/RunQueueService.test.ts src/main/RunRepository.test.ts src/main/RunRecovery.test.ts src/renderer/src/lib/queuedMessageRows.test.ts src/renderer/src/lib/steerState.test.ts src/main/services/EnsembleOrchestrator.test.ts src/main/SoloChatWakeupService.test.ts src/main/HeadlessScheduledDispatch.test.ts
npm run typecheck
```

Do not run repository-wide `npm run format`; preserve local style and run only
targeted formatting if a touched file requires it.

## Non-Goals

- Do not redesign the above-row/composer UX.
- Do not claim unsupported providers can accept live in-flight guidance.
- Do not encode queued/steered user intent as provider tool activity.
- Do not introduce provider-global serialization; preserve per-chat queue
  dispatch.
- Do not silently drop queued prompts during ensemble steer.

## Open Questions For Adversarial Review

- Is a unified renderer steer harness enough, or should steering move to main
  with a new service and IPC?
- Can queued job promotion safely reuse the same `appRunId`, or should it create
  a child run with `parentRunId` while preserving the original queue job as a
  lifecycle record?
- How should transcript cards, run events, and queue jobs line up after restart?
- Should `paused` become a true active queue status or be removed from queue
  semantics?
- What is the lowest-risk path to main-owned queue pumping without destabilizing
  current renderer dispatch?
- How should Grok ACP cancellation be improved without coupling generic steer
  semantics to one provider protocol?
