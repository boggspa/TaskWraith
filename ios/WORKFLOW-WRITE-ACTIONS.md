# iOS workflow write-actions — landed Mac contract and Swift handoff

Status: **COMPLETE on both sides.** Mac/TypeScript contract landed in
`d17bdd5a1`; the Swift client landed on `fable/ios-workflow-controls`:
`BridgeAction.workflowSetEnabled/.workflowRunNow` builders,
`RemoteSessionModel.setWorkflowEnabled/.runWorkflowNow` (optimistic flip +
ack reconcile + verbatim Mac denial reasons), and swipe/context-menu
controls on the sidebar workflow rows (run-now withheld while an execution
is live).
The Mac can now accept narrowly decoded pause/resume and run-now actions once
the Swift client emits them. It resolves and revalidates all workspace,
provider, and permission authority from its canonical workflow record; those
fields are deliberately absent from the phone payload.

## What already works on the phone (no contract change was needed)

- **Workflow chat creation**: `NewChatCanvas` has a `.workflow` mode and the
  composer actions already carry `workflowMode` (Models.swift `payload["workflowMode"]`),
  so creating/running a workflow **chat** from the phone is live today.
- **Scheduled-workflow projection**: `RemoteWorkflow` (Models.swift) projects
  id/name/workspaceId/threadId/provider/`enabled`/schedule/status/nextRunAt/
  lastRunAt + loop summary (iterations, stop reason, tokens). Rendered as
  read-only rows in the sidebar Workflows section (HomeListViews); tap opens
  the workflow's chat.

## Remaining phone-side gap

The sidebar rows are explicitly "Read-only on the phone for now": no
pause/resume, no run-now, no delete. Pause/resume and run-now now exist in the
phone→Mac action vocabulary, but the Swift row affordances and ack handling
have not been added. Delete remains intentionally deferred.

## Landed bridge actions

Paired-bridge actions are ack'd like the existing git*/roster actions:

1. `workflowSetEnabled` — payload `{ workflowId, enabled: Bool }`,
   ack data `{ workflowId, enabled? }`. Backs pause/resume swipe actions.
2. `workflowRunNow` — payload `{ workflowId }`, ack data
   `{ workflowId, scheduledTaskId?, workflowExecutionId? }`. There is no
   `runId`: acceptance materializes a scheduled occurrence, and the existing
   due-task path owns live-run creation.
3. (Optional, later) `workflowDelete` — payload `{ workflowId }`. Destructive;
   needs a confirm affordance and probably the same elevation posture as other
   destructive phone actions.

Projection: no new fields needed — after a mutation the Mac re-broadcasts the
workflows section and `RemoteWorkflow.enabled/status/nextRunAt` already carry
the result. Additive-decode convention means older phones ignore everything.

Landed security behavior:

- Strict payload decoding rejects extra client-supplied workspace, provider,
  or approval fields and rejects empty, padded, or oversized workflow IDs.
- `workflowId → workspace/provider/posture` resolution happens on the Mac.
  The target chat must be live, workspace-scoped, and match both canonical
  workspace ID and path.
- Enabling and run-now require the workspace `startTurn` capability; disabling
  requires `cancel`.
- Without a current verified unattended-elevation acknowledgement, start-work
  actions resolve to `plan`. A verified acknowledgement can authorize only its
  signed ceiling. The resolved tuple is checked again immediately before the
  workflow mutation or occurrence materialization.
- Run-now rejects an active occurrence and has a per-workflow three-second
  cooldown in addition to the bridge action replay/expiry guard.
- Materialized tasks use the existing signed-posture and headless-safe due-task
  path. Workflow, scheduled-task, and remote-projection updates are broadcast
  from the Mac after the mutation.

## Swift work now unblocked (ios/** only, ~small)

- Swipe actions / context menu on the workflow rows (pause–resume, run now)
  with optimistic `enabled` flip + ack reconcile (same pattern as roster
  updates), and a loop-badge refresh on `workflowRunNow` ack.
- Decode success through the standard bridge ack envelope. Read the optional
  `scheduledTaskId` / `workflowExecutionId` only for diagnostics or immediate
  UI correlation; do not wait for or invent a `runId`.
- No new views: the rows and their status/badge rendering already exist.
