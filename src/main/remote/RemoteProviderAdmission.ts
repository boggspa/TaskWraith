import { isLiveSelectableProvider, isRetiredProvider } from '../../shared/retiredProviders'
import type {
  RemoteWorkspaceAllowlist,
  RemoteWorkspaceCapability
} from '../RemoteWorkspaceAllowlist'

export type RemoteProviderDispatchability = (provider: string) => boolean

/**
 * Static paired-device dispatch policy. Retired providers remain valid for
 * continuation actions against existing chats, while conditional providers
 * must be admitted by a runtime-supplied predicate.
 */
export function isRemoteProviderDispatchable(
  provider: string,
  isConditionalProviderAvailable?: RemoteProviderDispatchability
): boolean {
  return (
    isLiveSelectableProvider(provider) ||
    isRetiredProvider(provider) ||
    isConditionalProviderAvailable?.(provider) === true
  )
}

export interface RemoteProviderGrantCheck {
  allowlist: RemoteWorkspaceAllowlist
  workspaceId: string
  provider: string
  capability: RemoteWorkspaceCapability
  approvalMode?: string
}

/**
 * Revalidate a nested provider field against the workspace grant. The action
 * router can only see a payload's top-level provider, so roster/create actions
 * must explicitly check every newly admitted participant provider too.
 */
export function assertRemoteProviderGrant(check: RemoteProviderGrantCheck): void {
  const decision = check.allowlist.evaluate({
    workspaceId: check.workspaceId,
    provider: check.provider,
    capability: check.capability,
    ...(check.approvalMode !== undefined ? { approvalMode: check.approvalMode } : {})
  })
  if (!decision.allowed) throw new Error(decision.reason)
}
