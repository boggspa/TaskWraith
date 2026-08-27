/**
 * Prompt blocks whose delivery may be inherited by a provider session.
 *
 * These are candidates until the provider emits run_started. The renderer then
 * persists only candidates for the provider that actually admitted the run.
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
