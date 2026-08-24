import type { AgenticServiceId, EffectiveRunPermissions, ProviderId } from './store/types'

export const ULTRATASK_DELEGATION_AUTO_ALLOW_SOURCE = 'ultratask' as const

export type UltraTaskDelegationAutoAllowSource = typeof ULTRATASK_DELEGATION_AUTO_ALLOW_SOURCE

const ULTRATASK_REASONING_SELECTION = 'ultratask'

export const ULTRATASK_DELEGATION_TOOL_NAMES = Object.freeze([
  'delegate_wave',
  'ultra_task',
  'delegate_to_subthread'
] as const)

export type UltraTaskDelegationToolName = (typeof ULTRATASK_DELEGATION_TOOL_NAMES)[number]

const ULTRATASK_DELEGATION_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  ULTRATASK_DELEGATION_TOOL_NAMES
)

export interface ExplicitUltraTaskSelectionInput {
  provider: ProviderId
  reasoningEffort?: unknown
  /** AntiGravity maps UltraTask onto a real High wire model and persists this
   * presentation marker as its only exact synthetic-selection receipt. */
  antigravityUltraTaskSelected?: unknown
}

/**
 * Match only the synthetic UltraTask picker stop. Ordinary provider tiers such
 * as Ultra and Ultracode are reasoning choices, not delegation consent.
 */
export function isExplicitUltraTaskSelection(input: ExplicitUltraTaskSelectionInput): boolean {
  const reasoningEffort =
    typeof input.reasoningEffort === 'string' ? input.reasoningEffort.trim().toLowerCase() : ''
  if (reasoningEffort === ULTRATASK_REASONING_SELECTION) return true
  return input.provider === 'antigravity' && input.antigravityUltraTaskSelected === true
}

/** Stamp or clear the exact run-scoped consent before the posture is signed. */
export function withUltraTaskDelegationAutoAllow(
  permissions: EffectiveRunPermissions,
  input: ExplicitUltraTaskSelectionInput
): EffectiveRunPermissions {
  if (isExplicitUltraTaskSelection(input)) {
    if (permissions.subThreadDelegationAutoAllowSource === ULTRATASK_DELEGATION_AUTO_ALLOW_SOURCE) {
      return permissions
    }
    return {
      ...permissions,
      subThreadDelegationAutoAllowSource: ULTRATASK_DELEGATION_AUTO_ALLOW_SOURCE
    }
  }
  return stripUltraTaskDelegationAutoAllow(permissions)
}

export function hasUltraTaskDelegationAutoAllow(
  permissions: EffectiveRunPermissions | null | undefined
): boolean {
  return permissions?.subThreadDelegationAutoAllowSource === ULTRATASK_DELEGATION_AUTO_ALLOW_SOURCE
}

/** Delegated workers never inherit the parent turn's picker consent. */
export function stripUltraTaskDelegationAutoAllow(
  permissions: EffectiveRunPermissions
): EffectiveRunPermissions {
  if (!hasUltraTaskDelegationAutoAllow(permissions)) return permissions
  const stripped = { ...permissions }
  delete stripped.subThreadDelegationAutoAllowSource
  return stripped
}

export function isUltraTaskDelegationAutoAllowRequest(input: {
  service: AgenticServiceId | null | undefined
  toolName: unknown
  effectivePermissions: EffectiveRunPermissions | null | undefined
}): boolean {
  return (
    input.service === 'subThreadDelegation' &&
    typeof input.toolName === 'string' &&
    ULTRATASK_DELEGATION_TOOL_NAME_SET.has(input.toolName) &&
    hasUltraTaskDelegationAutoAllow(input.effectivePermissions)
  )
}
