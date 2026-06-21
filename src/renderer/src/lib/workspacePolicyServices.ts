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
  mcpTools: 'Tool calls',
  subThreadDelegation: 'Sub-thread delegation',
  canvasInteraction: 'Canvas interaction'
}

export const WORKSPACE_POLICY_SERVICE_HELP: Record<AgenticServiceId, string> = {
  shellCommands: 'Run workspace-scoped shell commands without asking again.',
  fileChanges: 'Write, replace, or patch workspace files without asking again.',
  mcpTools: 'Use read/search/status tools without asking again.',
  subThreadDelegation: 'Spawn cross-provider sub-threads without asking again.',
  canvasInteraction: 'Click and fill elements in a Canvas preview without asking again.'
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
  }
]
