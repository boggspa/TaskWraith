export interface RegenerableHistoryByteCompletionOptions<T> {
  cleanup: () => Promise<void>
  isCurrent: () => boolean
  release?: () => void
  onCurrent: () => T
  onRevoked: () => T
}

/**
 * Keeps the revocation decision after the operation's final asynchronous
 * cleanup. Release and publication are synchronous after that decision, so a
 * history mutation cannot enter through an await gap and receive stale bytes.
 */
export async function completeRegenerableHistoryByteOperation<T>(
  options: RegenerableHistoryByteCompletionOptions<T>
): Promise<T> {
  await options.cleanup()
  const current = options.isCurrent()
  options.release?.()
  return current ? options.onCurrent() : options.onRevoked()
}
