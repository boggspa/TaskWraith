export interface SharedWorkspaceRecordFileIdentity {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  mode: bigint
}

interface CacheEntry<T> {
  identity: SharedWorkspaceRecordFileIdentity
  byteLength: number
  value: T
}

// A real repository can hold well over 1,300 active prepared receipts. Keep the
// count ceiling above the journal's 2,000-record scan bound so a sequential
// full scan does not evict its own warm entries; the byte ceiling remains the
// tighter bound for unusually large bodies.
export const SHARED_WORKSPACE_RECORD_CACHE_MAX_ENTRIES = 4_096
export const SHARED_WORKSPACE_RECORD_CACHE_MAX_BYTES = 8 * 1024 * 1024

/**
 * Process-local cache for validated immutable prepared-record bodies.
 *
 * Callers still stat every path and read every directory/state sibling on each
 * scan. A different file identity evicts the old body immediately; this cache
 * never stores live workspace bytes or any derived current-file hash.
 */
export class SharedWorkspaceRecordCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>()
  private totalBytes = 0

  constructor(
    private readonly maxEntries = SHARED_WORKSPACE_RECORD_CACHE_MAX_ENTRIES,
    private readonly maxBytes = SHARED_WORKSPACE_RECORD_CACHE_MAX_BYTES
  ) {}

  get(path: string, identity: SharedWorkspaceRecordFileIdentity): T | undefined {
    const entry = this.entries.get(path)
    if (!entry) return undefined
    if (!sameSharedWorkspaceRecordFileIdentity(entry.identity, identity)) {
      this.remove(path, entry)
      return undefined
    }
    this.entries.delete(path)
    this.entries.set(path, entry)
    return entry.value
  }

  set(
    path: string,
    identity: SharedWorkspaceRecordFileIdentity,
    byteLength: number,
    value: T
  ): void {
    const existing = this.entries.get(path)
    if (existing) this.remove(path, existing)
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.maxBytes) return
    const entry = { identity: { ...identity }, byteLength, value }
    this.entries.set(path, entry)
    this.totalBytes += byteLength
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry<T>] | undefined
      if (!oldest) break
      this.remove(oldest[0], oldest[1])
    }
  }

  delete(path: string): void {
    const entry = this.entries.get(path)
    if (entry) this.remove(path, entry)
  }

  private remove(path: string, entry: CacheEntry<T>): void {
    if (this.entries.get(path) !== entry) return
    this.entries.delete(path)
    this.totalBytes -= entry.byteLength
  }
}

export function sameSharedWorkspaceRecordFileIdentity(
  left: SharedWorkspaceRecordFileIdentity,
  right: SharedWorkspaceRecordFileIdentity
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  )
}
