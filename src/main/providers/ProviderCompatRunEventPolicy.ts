/**
 * Decide whether one compat provider payload adds durable information when raw
 * payload retention is disabled. Incremental assistant text is already folded
 * into the canonical chat transcript, while its normalized run-item delta is
 * deliberately non-durable. Writing a payload-less `provider_raw` record for
 * every token therefore adds only an identical summary and blocks the provider
 * stdout handler on synchronous filesystem work.
 */
export function shouldPersistCompatProviderRawEvent(
  payload: unknown,
  storeRawEvents: boolean
): boolean {
  if (storeRawEvents) return true
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return true
  const event = payload as Record<string, unknown>
  if (event.type === 'content' || event.type === 'token') return false
  if (event.type === 'message' && event.role === 'assistant' && event.delta === true) return false
  return true
}
