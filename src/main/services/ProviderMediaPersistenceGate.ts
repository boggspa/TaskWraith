export interface AuthorizedProviderMediaPersistence<T> {
  isAuthorized: () => boolean
  persist: () => T[]
  revokeOnLostAuthority: () => void | Promise<void>
}

/**
 * Provider image frames are untrusted late output. Check the exact live run
 * before bytes are written, then check again before refs can be published.
 * When authority is lost during persistence, schedule strict ownership purge
 * and return no refs to the transcript lane.
 */
export function persistAuthorizedProviderMedia<T>(
  input: AuthorizedProviderMediaPersistence<T>
): T[] {
  if (!input.isAuthorized()) return []
  const persisted = input.persist()
  if (persisted.length === 0 || input.isAuthorized()) return persisted
  try {
    const cleanup = input.revokeOnLostAuthority()
    if (cleanup && typeof cleanup.then === 'function') {
      void cleanup.catch(() => {})
    }
  } catch {
    // The strict media store retains its own recovery journal. Publication is
    // denied even when cleanup must be completed by restart recovery.
  }
  return []
}
