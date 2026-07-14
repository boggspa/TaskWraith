# iOS workflow write-actions — contract proposal (STOPPED AT BOUNDARY)

Status: **spec only — no code.** Adding phone-side workflow mutations requires
new bridge action vocabulary, i.e. a shared TypeScript interop contract change
that is out of bounds for the iOS-only worktree (`fable/ios-parallel`). This
doc is the stop-and-report artifact: what exists, what's missing, and the
exact contract the Mac side would need before the Swift work can proceed.

## What already works on the phone (no contract change was needed)

- **Workflow chat creation**: `NewChatCanvas` has a `.workflow` mode and the
  composer actions already carry `workflowMode` (Models.swift `payload["workflowMode"]`),
  so creating/running a workflow **chat** from the phone is live today.
- **Scheduled-workflow projection**: `RemoteWorkflow` (Models.swift) projects
  id/name/workspaceId/threadId/provider/`enabled`/schedule/status/nextRunAt/
  lastRunAt + loop summary (iterations, stop reason, tokens). Rendered as
  read-only rows in the sidebar Workflows section (HomeListViews); tap opens
  the workflow's chat.

## The gap

The sidebar rows are explicitly "Read-only on the phone for now": no
pause/resume, no run-now, no delete. Those verbs do not exist in the
phone→Mac action vocabulary — they are Mac-side scheduler mutations.

## Proposed contract additions (Mac/TS side — Codex to schedule)

New paired-bridge actions, ack'd like the existing git*/roster actions:

1. `workflowSetEnabled` — payload `{ workflowId, enabled: Bool }`,
   ack `{ ok } | { error }`. Backs pause/resume swipe actions.
2. `workflowRunNow` — payload `{ workflowId }`, ack `{ ok, runId? } | { error }`.
   Should respect the workspace remote-allowlist gate the same way run-queue
   dispatch does (phone-origin execution authority, not just UI copy).
3. (Optional, later) `workflowDelete` — payload `{ workflowId }`. Destructive;
   needs a confirm affordance and probably the same elevation posture as other
   destructive phone actions.

Projection: no new fields needed — after a mutation the Mac re-broadcasts the
workflows section and `RemoteWorkflow.enabled/status/nextRunAt` already carry
the result. Additive-decode convention means older phones ignore everything.

Security notes for the Mac-side review:
- Both actions are WRITE authority on a workspace-scoped resource: gate on the
  workspace remote allowlist and the run-permission posture clamp, and treat
  `workflowRunNow` as run-dispatch (HMAC-normalized payload), not as a UI ping.
- **Posture decision (must be explicit, else this is an escalation hole):** a
  workflow's SAVED posture may be full-access while phone-origin turns are
  clamped to plan/read_only. `workflowRunNow` MUST NOT silently dispatch at
  saved posture — that would let a plan-clamped phone execute arbitrary writes
  by proxy. Pick one: (a) dispatch clamped to the phone posture (schedule vs
  run-now then behave differently — document it in the ack), or (b) dispatch
  at saved posture ONLY behind the existing two-tier elevation sheet. Same
  shape applies one step removed to `workflowSetEnabled(enabled: true)`
  re-arming future saved-posture runs — at minimum surface the workflow's
  posture in the confirm affordance.
- `workflowId → workspaceId` resolution happens ON THE MAC (the payload
  carries no client workspaceId to trust); the allowlist gate runs against the
  resolved workspace.
- Rate-limit `workflowRunNow` acks per workflow to avoid a wedged phone
  retry-looping a scheduler dispatch.

## Swift work that unblocks once the contract lands (ios/** only, ~small)

- Swipe actions / context menu on the workflow rows (pause–resume, run now)
  with optimistic `enabled` flip + ack reconcile (same pattern as roster
  updates), and a loop-badge refresh on `workflowRunNow` ack.
- No new views: the rows and their status/badge rendering already exist.
