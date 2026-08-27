import type {
  PromptDeliveryReceipts,
  PromptDeliveryStamp
} from '../../../shared/PromptDeliveryReceipts'

function matchingValue(
  stamp: PromptDeliveryStamp | null | undefined,
  provider: string
): string | undefined {
  const expectedProvider = provider.trim()
  if (!stamp || !expectedProvider || stamp.provider !== expectedProvider) return undefined
  const value = stamp.value.trim()
  return value || undefined
}

/** Convert admitted prompt-delivery candidates into chat provider metadata. */
export function promptDeliveryReceiptMetadataPatch(
  receipts: PromptDeliveryReceipts | null | undefined,
  provider: string
): Record<string, string> {
  if (!receipts) return {}
  const patch: Record<string, string> = {}
  const workInvariants = matchingValue(receipts.workInvariants, provider)
  if (workInvariants) {
    patch.taskWraithWorkInvariantsVersion = workInvariants
    patch.taskWraithWorkInvariantsProvider = provider
  }
  const skillDiscovery = matchingValue(receipts.skillDiscovery, provider)
  if (skillDiscovery) {
    patch.taskWraithSkillDiscoveryDigest = skillDiscovery
    patch.taskWraithSkillDiscoveryProvider = provider
  }
  const sessionStartContext = matchingValue(receipts.sessionStartContext, provider)
  if (sessionStartContext) {
    patch.taskWraithSessionStartContextDigest = sessionStartContext
    patch.taskWraithSessionStartContextProvider = provider
  }
  const workspaceDoctrine = matchingValue(receipts.workspaceDoctrine, provider)
  if (workspaceDoctrine) {
    patch.taskWraithWorkspaceDoctrineDigest = workspaceDoctrine
    patch.taskWraithWorkspaceDoctrineProvider = provider
  }
  return patch
}

/** A failed/cancelled run may not have delivered its composed prompt. Repeating
 * stable context is harmless; falsely suppressing it is not. */
export function promptDeliveryReceiptsPersistableStatus(status: unknown): boolean {
  return status === 'success' || status === 'success_with_warnings' || status === 'completed'
}
