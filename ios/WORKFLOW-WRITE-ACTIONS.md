# iOS workflow write-actions — landed bridge and Swift controls

Status: **COMPLETE for pause/resume and run-now.** The Mac/TypeScript contract
landed in `d17bdd5a1`; the Swift client landed in `a175ff111` and was integrated
by `bee0e467e` for TaskWraith 1.8.2:
`BridgeAction.workflowSetEnabled/.workflowRunNow` builders,
`RemoteSessionModel.setWorkflowEnabled/.runWorkflowNow` (optimistic flip +
ack reconcile + verbatim Mac denial reasons), and swipe/context-menu
controls on the sidebar workflow rows (run-now withheld when the projected
status is `running`). `workflowDelete` remains intentionally deferred.

The Mac accepts narrowly decoded pause/resume and run-now actions from the
Swift client. It resolves and revalidates all workspace, provider, and
permission authority from its canonical workflow record; those fields are
deliberately absent from the phone payload.

## What already works on the phone (no contract change was needed)

- **Workflow chat creation**: `NewChatCanvas` has a `.workflow` mode and the
  composer actions already carry `workflowMode` (Models.swift `payload["workflowMode"]`),
  so creating/running a workflow **chat** from the phone is live today.
- **Scheduled-workflow projection**: `RemoteWorkflow` (Models.swift) projects
  id/name/workspaceId/threadId/provider/`enabled`/schedule/status/nextRunAt/
  lastRunAt + loop summary (iterations, stop reason, tokens). The sidebar
  Workflows rows (HomeListViews) render that state, open the workflow's chat on
  tap, and host the pause/resume and run-now controls.

## Current phone-side status

- Pause/resume is available from the trailing swipe actions and context menu,
  with an optimistic `enabled` flip followed by ack/projection reconciliation.
- Run Now is available from both affordances and is withheld or disabled while
  the projected workflow status is `running`. Other queued/active conflicts are
  still revalidated by the Mac and can return an authoritative denial.
- Mac policy denials surface verbatim so the user can act on the real authority,
  cooldown, or active-execution reason.
- Delete is not exposed. A future `workflowDelete` action remains intentionally
  deferred because it needs a destructive confirmation and an agreed elevation
  posture.

## Landed bridge actions

Paired-bridge actions are ack'd like the existing git*/roster actions:

1. `workflowSetEnabled` — payload `{ workflowId, enabled: Bool }`,
   ack data `{ workflowId, enabled? }`. Backs pause/resume swipe actions.
2. `workflowRunNow` — payload `{ workflowId }`, ack data
   `{ workflowId, scheduledTaskId?, workflowExecutionId? }`. There is no
   `runId`: acceptance materializes a scheduled occurrence, and the existing
   due-task path owns live-run creation.
3. (Deferred) `workflowDelete` — payload `{ workflowId }`. Destructive;
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

## Landed Swift behavior (1.8.2)

- Swipe actions and context menus on existing workflow rows expose pause,
  resume, and run now without adding a separate view.
- The standard bridge ack envelope reconciles pause/resume state. Optional
  `scheduledTaskId` / `workflowExecutionId` values are decoded for diagnostics;
  the phone does not wait for or invent a `runId`.
- `workflowDelete` is still outside the shipped action vocabulary and UI.
