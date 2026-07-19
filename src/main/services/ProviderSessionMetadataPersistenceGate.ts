export interface AuthorizedProviderSessionMetadataPersistence<TCurrent, TUpdate> {
  isAuthorized: () => boolean
  readCurrent: () => TCurrent | null | undefined
  buildUpdate: (current: TCurrent) => TUpdate | null | undefined
  saveAndPublish: (update: TUpdate) => void
}

/**
 * Provider session identifiers and containment receipts are late provider
 * output. Refuse the store read when the exact run has already lost durable
 * output authority, then revalidate after constructing the update and
 * immediately before its combined save/broadcast commit.
 *
 * `saveAndPublish` must remain synchronous so no destructive-clear boundary
 * can interleave between the final admission check and the commit.
 */
export function persistAuthorizedProviderSessionMetadata<TCurrent, TUpdate>(
  input: AuthorizedProviderSessionMetadataPersistence<TCurrent, TUpdate>
): boolean {
  if (!input.isAuthorized()) return false
  const current = input.readCurrent()
  if (current == null) return false
  const update = input.buildUpdate(current)
  if (update == null || !input.isAuthorized()) return false
  input.saveAndPublish(update)
  return true
}
