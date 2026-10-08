/**
 * Inert publication admission for a trusted local desktop connection. Nothing
 * calls this from a record executor yet. Permits never cross the wire: capture
 * at authenticated request ingress, then publish after transfer preparation.
 */
import { lstatSync } from 'node:fs'
import { canTreatThreadPathAsMissingSync } from '../host-shared/thread-log/NodeThreadFileSystem'
import { threadAuthorityFilePath } from '../host-shared/thread-log/ThreadAuthorityFile'
import type { ThreadOwnerEpoch } from '../host-shared/thread-log/ThreadOwnership'

/**
 * The authority protocol replaces a regular file by atomic rename. Bind its
 * asynchronous read to that exact inode and metadata; no authority bytes are
 * read here. Missing is distinct from unreadable. This is a protocol witness,
 * not protection against arbitrary filesystem mutation after the final stat.
 */
export function threadPublicationAuthorityWitness(
  profilePath: string,
  threadId: string
): () => boolean {
  const file = threadAuthorityFilePath(profilePath, threadId)
  const identity = (): string | null => {
    try {
      const stat = lstatSync(file, { bigint: true })
      if (!stat.isFile()) return null
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        (process.platform !== 'win32' || canTreatThreadPathAsMissingSync(file))
        ? 'missing'
        : null
    }
  }
  const before = identity()
  return () => before !== null && identity() === before
}

export interface HostThreadPublicationOwner {
  readonly writerId: string
  readonly epoch: ThreadOwnerEpoch
}

export interface HostThreadPublicationBinding {
  readonly owner: HostThreadPublicationOwner | null
  /** Exact captured connection and grant, not a lookup that can gain a later grant. */
  isCurrent(): boolean
}

export type HostThreadPublicationResult<T> =
  | { readonly kind: 'published'; readonly value: T }
  | { readonly kind: 'refused'; readonly errorCode: 'thread_busy_in_desktop' | 'thread_fold_first' }

/** Promise-returning callbacks cannot put a wait between the guard and adoption. */
export type HostThreadPublicationCommit<T> = () => T &
  (T extends PromiseLike<unknown> ? never : unknown)

export interface HostThreadPublicationRegistry {
  publishFullCopy<T>(
    threadId: string,
    binding: HostThreadPublicationBinding,
    commit: HostThreadPublicationCommit<T>
  ): Promise<HostThreadPublicationResult<T>>
}

declare const publicationPermit: unique symbol
export interface HostThreadPublicationPermit {
  readonly [publicationPermit]: true
}

export const THREAD_PUBLICATION_BUSY = {
  kind: 'refused',
  errorCode: 'thread_busy_in_desktop'
} as const

/** The callback is synchronous by contract; reject a dishonest thenable result too. */
export function commitThreadPublication<T>(
  commit: HostThreadPublicationCommit<T>
): HostThreadPublicationResult<T> {
  const value = commit()
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  ) {
    throw new Error('Thread publication callback must be synchronous')
  }
  return { kind: 'published', value }
}

export class HostThreadPublicationGuard {
  private readonly permits = new WeakMap<
    HostThreadPublicationPermit,
    { threadId: string; binding: HostThreadPublicationBinding }
  >()

  constructor(private readonly registry: HostThreadPublicationRegistry | null) {}

  capture(threadId: string, binding: HostThreadPublicationBinding): HostThreadPublicationPermit {
    const permit = Object.freeze({}) as HostThreadPublicationPermit
    const owner = binding.owner
      ? Object.freeze({ ...binding.owner, epoch: Object.freeze({ ...binding.owner.epoch }) })
      : null
    this.permits.set(permit, {
      threadId,
      binding: { owner, isCurrent: binding.isCurrent.bind(binding) }
    })
    return permit
  }

  async publish<T>(
    permit: HostThreadPublicationPermit,
    commit: HostThreadPublicationCommit<T>
  ): Promise<HostThreadPublicationResult<T>> {
    const captured = this.permits.get(permit)
    if (!captured) return THREAD_PUBLICATION_BUSY
    // Single-use even when authority is refused, or the commit throws.
    this.permits.delete(permit)
    if (!this.registry) return commitThreadPublication(commit)
    return this.registry.publishFullCopy(captured.threadId, captured.binding, commit)
  }
}
