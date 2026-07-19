export interface PendingToolMediaPersistence {
  /** Retire exact rollback authority only after the trusted ref is publishable. */
  commit: () => boolean
  /** Strictly revoke only the grant introduced by this produced file. */
  rollback: () => Promise<void>
}

export type ToolMediaPersistOutput =
  | {
      ok: true
      path: string
      sha256: string
      byteLength: number
      pendingToolMediaPersistence: PendingToolMediaPersistence
    }
  | { ok: false; reason: string }

export interface ToolMediaPersistenceSettlement {
  authorityLive: boolean
  committed: boolean
}

export type ToolMediaProjectionCommit<T> =
  | { authorityLive: true; committed: true; value: T }
  | { authorityLive: false; committed: false }

export function toolMediaPublicationAuthorized(input: {
  publish: boolean
  isAuthorized: () => boolean
}): boolean {
  if (!input.publish) return false
  try {
    return input.isAuthorized() === true
  } catch {
    return false
  }
}

/**
 * Commit is deliberately synchronous: the dispatcher invokes it only after an
 * exact authority check and immediately before projection, leaving no await
 * boundary in which a cancelled run could lose authority after commit.
 */
export function commitPendingToolMediaPersistence(
  pending: PendingToolMediaPersistence | undefined
): void {
  if (pending && !pending.commit()) {
    throw new Error('Produced-media persistence receipt was no longer active at commit.')
  }
}

/**
 * Run every throw-capable projection step while exact rollback authority is
 * still live, then synchronously recheck authority and commit as the final
 * operation. A projection exception escapes without touching the receipt so
 * the caller's catch path can perform strict rollback.
 */
export function projectAndCommitToolMediaPersistence<T>(input: {
  pending: PendingToolMediaPersistence
  isAuthorized: () => boolean
  project: () => T
}): ToolMediaProjectionCommit<T> {
  if (!toolMediaPublicationAuthorized({ publish: true, isAuthorized: input.isAuthorized })) {
    return { authorityLive: false, committed: false }
  }
  const value = input.project()
  if (!toolMediaPublicationAuthorized({ publish: true, isAuthorized: input.isAuthorized })) {
    return { authorityLive: false, committed: false }
  }
  const committedProjection: ToolMediaProjectionCommit<T> = {
    authorityLive: true,
    committed: true,
    value
  }
  commitPendingToolMediaPersistence(input.pending)
  return committedProjection
}

/**
 * Settle at the final projection seam. The authorized commit path is entirely
 * synchronous; denied paths return a Promise because strict rollback may fsync.
 */
export function settleToolMediaPersistence(input: {
  pending?: PendingToolMediaPersistence
  publish: boolean
  isAuthorized: () => boolean
}): ToolMediaPersistenceSettlement | Promise<ToolMediaPersistenceSettlement> {
  const authorityLive = toolMediaPublicationAuthorized({
    publish: true,
    isAuthorized: input.isAuthorized
  })
  if (!input.pending) return { authorityLive, committed: false }
  if (authorityLive && input.publish) {
    commitPendingToolMediaPersistence(input.pending)
    return { authorityLive: true, committed: true }
  }
  return input.pending.rollback().then(() => ({ authorityLive, committed: false }))
}

/** Strict cleanup for an executor/dispatcher exception before final settlement. */
export async function rollbackPendingToolMediaPersistence(
  pending: PendingToolMediaPersistence | undefined
): Promise<void> {
  if (pending) await pending.rollback()
}

/** Remove the function-valued main capability before MCP/provider projection. */
export function stripPendingToolMediaPersistence<
  T extends { pendingToolMediaPersistence?: PendingToolMediaPersistence }
>(result: T): Omit<T, 'pendingToolMediaPersistence'> {
  const publicResult = { ...result }
  delete publicResult.pendingToolMediaPersistence
  return publicResult
}
