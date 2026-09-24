import type { EffectiveRunPermissions } from '../store/types'
import { hasUltraTaskDelegationAutoAllow } from '../UltraTaskDelegationConsent'
import {
  PI_ENSEMBLE_COORDINATION_TOOL_NAMES,
  PI_EXACT_FILE_TOOL_NAMES,
  PI_MANAGED_SHELL_TOOL_NAMES,
  PI_MESH_TOOL_NAMES,
  PI_ULTRATASK_DELEGATION_TOOL_NAMES,
  type PiTaskWraithToolName
} from './PiEnsembleCoordination'

export interface ResolvePiTaskWraithToolSelectionInput {
  writeCapable: boolean
  shellCapable: boolean
  ensembleRun: boolean
  workspaceScoped: boolean
  coordinationAllowed: boolean
  meshAllowed: boolean
  effectivePermissions?: EffectiveRunPermissions | null
}

export interface PiTaskWraithToolSelection {
  exactFileToolsExpected: boolean
  shellToolsExpected: boolean
  coordinationExpected: boolean
  ultraTaskDelegationExpected: boolean
  meshToolsExpected: boolean
  managedToolsExpected: boolean
  toolNames: PiTaskWraithToolName[]
}

/**
 * Resolve the one fixed Pi broker allowlist for a run. UltraTask authority is
 * derived only from the signed run posture and is solo/workspace-only because
 * the durable graph rejects global chats and Ensemble seats. Ordinary
 * coordination policy cannot counterfeit or erase that run-scoped consent.
 */
export function resolvePiTaskWraithToolSelection(
  input: ResolvePiTaskWraithToolSelectionInput
): PiTaskWraithToolSelection {
  const exactFileToolsExpected = input.writeCapable
  const shellToolsExpected = input.shellCapable
  const coordinationExpected = input.ensembleRun && input.coordinationAllowed
  const ultraTaskDelegationExpected =
    !input.ensembleRun &&
    input.workspaceScoped &&
    hasUltraTaskDelegationAutoAllow(input.effectivePermissions)
  const meshToolsExpected = input.meshAllowed
  const toolNames = new Set<PiTaskWraithToolName>()

  if (exactFileToolsExpected) {
    for (const name of PI_EXACT_FILE_TOOL_NAMES) toolNames.add(name)
  }
  if (shellToolsExpected) {
    for (const name of PI_MANAGED_SHELL_TOOL_NAMES) toolNames.add(name)
  }
  if (coordinationExpected) {
    for (const name of PI_ENSEMBLE_COORDINATION_TOOL_NAMES) toolNames.add(name)
  }
  if (ultraTaskDelegationExpected) {
    for (const name of PI_ULTRATASK_DELEGATION_TOOL_NAMES) toolNames.add(name)
  }
  if (meshToolsExpected) {
    for (const name of PI_MESH_TOOL_NAMES) toolNames.add(name)
  }

  const managedToolsExpected =
    exactFileToolsExpected ||
    shellToolsExpected ||
    coordinationExpected ||
    ultraTaskDelegationExpected ||
    meshToolsExpected
  return {
    exactFileToolsExpected,
    shellToolsExpected,
    coordinationExpected,
    ultraTaskDelegationExpected,
    meshToolsExpected,
    managedToolsExpected,
    toolNames: [...toolNames]
  }
}
