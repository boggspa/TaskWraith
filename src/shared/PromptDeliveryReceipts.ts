/**
 * Prompt blocks whose delivery may be inherited by a provider session.
 *
 * These are candidates until the provider reports successful terminal evidence.
 * The renderer then persists only candidates for the provider that completed.
 * They influence prompt deduplication only; they never grant capabilities.
 */
export interface PromptDeliveryStamp {
  provider: string
  value: string
}

export interface PromptDeliveryReceipts {
  workInvariants?: PromptDeliveryStamp
  skillDiscovery?: PromptDeliveryStamp
  sessionStartContext?: PromptDeliveryStamp
  workspaceDoctrine?: PromptDeliveryStamp
}
