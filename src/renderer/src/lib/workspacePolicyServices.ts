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
  sketchCanvas: 'Sketch Canvas',
  meshCanvas: 'Mesh Canvas',
  simulatorCanvas: 'Simulator Canvas',
  // canvasEval is deliberately absent from the broad per-workspace grant list.
  // Its own first desktop accept opens a 12h exact-live-surface window instead.
  // The label still exists for audit/ledger rendering of canvasEval rows.
  canvasEval: 'Canvas eval',
  // crossThreadRead is granted via the approval prompt (expiring), not the
  // per-workspace WORKSPACE_POLICY_SERVICES list below, so — like canvasEval —
  // it is absent from that array; the label is kept for audit/ledger rendering.
  crossThreadRead: 'Cross-thread read',
  // threadMessage follows crossThreadRead exactly: granted via the (expiring)
  // approval prompt rather than a standing per-workspace row, so it is absent from
  // WORKSPACE_POLICY_SERVICES below; the label is kept for audit/ledger rendering.
  threadMessage: 'Thread message',
  // Media editing IS grantable per-workspace (parity with shell/file) and has a
  // row in WORKSPACE_POLICY_SERVICES below.
  mediaEditing: 'Media editing',
  // mediaRecording is NON-GRANTABLE (default-deny capture scaffold), so — like
  // canvasEval — it is ABSENT from WORKSPACE_POLICY_SERVICES below; the label is
  // kept for audit/ledger rendering of any (future) mediaRecording rows.
  mediaRecording: 'Media recording',
  // Browser navigation IS grantable per-workspace (read-class browsing in the
  // sandboxed Canvas Browser) and has a row in WORKSPACE_POLICY_SERVICES below.
  webBrowsing: 'Browser navigation'
}

export const WORKSPACE_POLICY_SERVICE_HELP: Record<AgenticServiceId, string> = {
  shellCommands: 'Run workspace-scoped shell commands without asking again.',
  fileChanges: 'Write, replace, or patch workspace files without asking again.',
  externalPublish:
    'Push branches, create pull requests, or publish release artifacts without asking again.',
  mcpTools: 'Use read/search/status tools without asking again.',
  subThreadDelegation: 'Spawn cross-provider sub-threads without asking again.',
  canvasInteraction: 'Click and fill elements in a Canvas preview without asking again.',
  sketchCanvas:
    'Edit structured shapes and text in chat-owned Sketch Canvases without asking again.',
  meshCanvas:
    'Create, import, edit, and present chat-owned 3D scenes using workspace-local mesh assets without asking again.',
  simulatorCanvas: 'Control iOS / watchOS Simulator Canvas surfaces without asking again.',
  canvasEval:
    'The first eval on a live Canvas surface asks on desktop; accepting opens a 12-hour same-surface window across navigation and later turns.',
  crossThreadRead:
    'Read how far past runs on other threads got. Same-workspace reads are automatic; cross-workspace reads always ask.',
  threadMessage:
    'Send a message into another thread. Same-workspace sends are automatic; cross-workspace sends and wake requests always ask.',
  mediaEditing: 'Transcode, encode, probe, and mix workspace audio/video without asking again.',
  // Non-grantable: shown for completeness only; capture always re-prompts / is denied.
  mediaRecording:
    'Microphone / camera capture always asks (cannot be pre-authorised). Coming soon.',
  webBrowsing:
    'Open and navigate websites in the sandboxed Canvas Browser without asking again. Clicking, typing, and the first eval on each live surface keep their separate approval paths.'
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
    id: 'sketchCanvas',
    label: WORKSPACE_POLICY_SERVICE_LABELS.sketchCanvas,
    help: WORKSPACE_POLICY_SERVICE_HELP.sketchCanvas
  },
  {
    id: 'meshCanvas',
    label: WORKSPACE_POLICY_SERVICE_LABELS.meshCanvas,
    help: WORKSPACE_POLICY_SERVICE_HELP.meshCanvas
  },
  {
    id: 'simulatorCanvas',
    label: WORKSPACE_POLICY_SERVICE_LABELS.simulatorCanvas,
    help: WORKSPACE_POLICY_SERVICE_HELP.simulatorCanvas
  },
  {
    id: 'mediaEditing',
    label: WORKSPACE_POLICY_SERVICE_LABELS.mediaEditing,
    help: WORKSPACE_POLICY_SERVICE_HELP.mediaEditing
  },
  {
    id: 'webBrowsing',
    label: WORKSPACE_POLICY_SERVICE_LABELS.webBrowsing,
    help: WORKSPACE_POLICY_SERVICE_HELP.webBrowsing
  }
  // mediaRecording, canvasEval, crossThreadRead, and threadMessage are
  // deliberately absent: they are not pre-authorised from the workspace policy
  // list. Their label/help exist above for audit/ledger rendering.
]
