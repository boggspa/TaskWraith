/*
 * workspacePolicyServices.ts — the canonical list of agentic
 * services the user can pre-authorise on a per-workspace basis.
 *
 * Originally lived inside `WorkspaceAccessControls.tsx` next to the
 * Tool Grants pill. Lifted to a shared module so the new
 * CombinedPermissionsPicker (which now hosts the Tool Grants column)
 * can consume the same definitions without duplicating them.
 */

import type { AgenticServiceId } from '../../../main/store/types'

export interface WorkspacePolicyService {
  id: AgenticServiceId
  label: string
  help: string
}

export const WORKSPACE_POLICY_SERVICE_LABELS: Record<AgenticServiceId, string> = {
  shellCommands: 'Shell commands',
  fileChanges: 'File changes',
  externalPublish: 'External publishing',
  mcpTools: 'Tool calls',
  subThreadDelegation: 'Sub-thread delegation',
  canvasInteraction: 'Canvas interaction',
  // canvasEval is NON-GRANTABLE (RCE / signed-elevated), so it is deliberately
  // ABSENT from WORKSPACE_POLICY_SERVICES below — no per-workspace grant row. The
  // label still exists for audit/ledger rendering of canvasEval rows.
  canvasEval: 'Canvas eval',
  // crossThreadRead is granted via the approval prompt (expiring), not the
  // per-workspace WORKSPACE_POLICY_SERVICES list below, so — like canvasEval —
  // it is absent from that array; the label is kept for audit/ledger rendering.
  crossThreadRead: 'Cross-thread read',
  // Media editing IS grantable per-workspace (parity with shell/file) and has a
  // row in WORKSPACE_POLICY_SERVICES below.
  mediaEditing: 'Media editing',
  // mediaRecording is NON-GRANTABLE (default-deny capture scaffold), so — like
  // canvasEval — it is ABSENT from WORKSPACE_POLICY_SERVICES below; the label is
  // kept for audit/ledger rendering of any (future) mediaRecording rows.
  mediaRecording: 'Media recording'
}

export const WORKSPACE_POLICY_SERVICE_HELP: Record<AgenticServiceId, string> = {
  shellCommands: 'Run workspace-scoped shell commands without asking again.',
  fileChanges: 'Write, replace, or patch workspace files without asking again.',
  externalPublish:
    'Push branches, create pull requests, or publish release artifacts without asking again.',
  mcpTools: 'Use read/search/status tools without asking again.',
  subThreadDelegation: 'Spawn cross-provider sub-threads without asking again.',
  canvasInteraction: 'Click and fill elements in a Canvas preview without asking again.',
  // Non-grantable: shown for completeness only; canvas_eval always re-prompts.
  canvasEval: 'Arbitrary eval in a Canvas preview always asks (cannot be pre-authorised).',
  crossThreadRead:
    'Read how far past runs on other threads got. Same-workspace reads are automatic; cross-workspace reads always ask.',
  mediaEditing:
    'Transcode, encode, probe, and mix workspace audio/video without asking again.',
  // Non-grantable: shown for completeness only; capture always re-prompts / is denied.
  mediaRecording:
    'Microphone / camera capture always asks (cannot be pre-authorised). Coming soon.'
}

export function getWorkspacePolicyServiceLabel(service: AgenticServiceId): string {
  return WORKSPACE_POLICY_SERVICE_LABELS[service]
}

export const WORKSPACE_POLICY_SERVICES: WorkspacePolicyService[] = [
  {
    id: 'shellCommands',
    label: WORKSPACE_POLICY_SERVICE_LABELS.shellCommands,
    help: WORKSPACE_POLICY_SERVICE_HELP.shellCommands
  },
  {
    id: 'fileChanges',
    label: WORKSPACE_POLICY_SERVICE_LABELS.fileChanges,
    help: WORKSPACE_POLICY_SERVICE_HELP.fileChanges
  },
  {
    id: 'externalPublish',
    label: WORKSPACE_POLICY_SERVICE_LABELS.externalPublish,
    help: WORKSPACE_POLICY_SERVICE_HELP.externalPublish
  },
  {
    id: 'mcpTools',
    label: WORKSPACE_POLICY_SERVICE_LABELS.mcpTools,
    help: WORKSPACE_POLICY_SERVICE_HELP.mcpTools
  },
  {
    id: 'subThreadDelegation',
    label: WORKSPACE_POLICY_SERVICE_LABELS.subThreadDelegation,
    help: WORKSPACE_POLICY_SERVICE_HELP.subThreadDelegation
  },
  {
    id: 'canvasInteraction',
    label: WORKSPACE_POLICY_SERVICE_LABELS.canvasInteraction,
    help: WORKSPACE_POLICY_SERVICE_HELP.canvasInteraction
  },
  {
    id: 'mediaEditing',
    label: WORKSPACE_POLICY_SERVICE_LABELS.mediaEditing,
    help: WORKSPACE_POLICY_SERVICE_HELP.mediaEditing
  }
  // mediaRecording, canvasEval, and crossThreadRead are
  // deliberately absent: they are not pre-authorised from the workspace policy
  // list. Their label/help exist above for audit/ledger rendering.
]
