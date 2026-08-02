import type { AgentRunPayload } from './run/AgentRunTypes'

export type WorkspaceLockProviderRunInput = Pick<
  AgentRunPayload,
  'provider' | 'scope' | 'workspace' | 'approvalMode' | 'effectivePermissions' | 'model'
>

/**
 * Provider dispatch is never a workspace mutation and therefore never owns a
 * checkout lease. Opaque native mutators are contained at their transport;
 * brokered edits acquire exact targets only for the operation itself.
 */
export function providerRunRequiresCoarseWorkspaceLock(
  _payload: WorkspaceLockProviderRunInput
): boolean {
  return false
}
