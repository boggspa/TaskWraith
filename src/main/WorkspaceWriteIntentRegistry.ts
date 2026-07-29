/**
 * 1.0.5-C2 compatibility model for historical tests and stored concepts.
 *
 * @deprecated Production mutation admission moved to WorkspaceLockRuntime and
 * WorkspaceLockAuthority in 1.9.2. Main and EnsembleOrchestrator must not
 * instantiate this in-memory registry: it is not an enforcement source, is
 * not projected to the UI, and must never be consulted alongside the durable
 * authority. It remains only so older imports/tests can describe the former
 * reader-writer semantics during migration.
 *
 * Catches cross-lane (and cross-chat!) write conflicts before
 * two participants can silently edit the same file. Implements a
 * reader-writer lock per resource path within a workspace:
 *
 *   - Multiple `read` holders can coexist on the same resource.
 *   - At most one `write` holder per resource; blocks all
 *     subsequent reads + writes until released.
 *   - A `read` holder blocks subsequent `write` acquisition but
 *     allows additional `read` holders to join.
 *
 * The orchestrator's concurrent-dispatch path (1.0.5-C1 lanes +
 * the follow-on integration) acquires a write-intent before
 * dispatching any tool that mutates a workspace path. On
 * conflict, the lane transitions to `'blocked'` (per the
 * `ConcurrentLane` state model from C1) and the user surfaces
 * the holding lane via the UI.
 *
 * Scope: per-workspace so two chats working in the same workspace
 * share the registry — catches cross-chat collisions, which is
 * the real filesystem-conflict surface. Per-chat scoping would
 * miss the most important case (a second ensemble run in the
 * same project touching the same file).
 *
 * Persistence: none. This is exactly why the class is compatibility-only.
 * The durable authority owns crash recovery, conflict enforcement, projection,
 * markers, and release in production.
 *
 * All methods are pure-ish — they mutate the internal Map but
 * have no other side effects (no logging, no I/O). Tests can
 * exercise every conflict shape without stubbing globals; the
 * `nowIso` field on requests is the only inject point and is
 * required so the registry never reaches for `Date.now()`
 * inside its core code path.
 */

export type WriteIntentMode = 'read' | 'write'

export interface WriteIntentRequest {
  workspacePath: string
  /** Canonical resource path (caller normalises — typically a
   * resolved absolute path, lowercased on case-insensitive
   * filesystems if cross-case collision is a concern). */
  resourcePath: string
  laneId: string
  mode: WriteIntentMode
  nowIso: string
}

export interface WriteIntentToken {
  workspacePath: string
  resourcePath: string
  laneId: string
  mode: WriteIntentMode
  acquiredAt: string
}

export interface WriteIntentHolder {
  laneId: string
  mode: WriteIntentMode
  acquiredAt: string
}

export interface AcquireWriteIntentResult {
  ok: boolean
  token?: WriteIntentToken
  /** Holders that blocked the acquisition. Empty when `ok` is true. */
  conflict?: {
    holders: WriteIntentHolder[]
    reason: string
  }
}

/**
 * 1.0.5-C2 — Per-workspace registry. One instance per process
 * (created once in main and shared); the orchestrator's
 * concurrent dispatch path injects + uses it.
 */
/** @deprecated Compatibility-only; use WorkspaceLockRuntime. */
export class WorkspaceWriteIntentRegistry {
  /** workspacePath → resourcePath → holders[] */
  private byWorkspace = new Map<string, Map<string, WriteIntentHolder[]>>()

  /**
   * Try to acquire a write-intent. Returns `{ ok: true, token }`
   * on success; `{ ok: false, conflict: { holders, reason } }`
   * on conflict.
   *
   * Conflict rules (reader-writer lock semantics):
   *   - mode === 'read' + existing write holder → reject
   *   - mode === 'write' + ANY existing holder → reject
   *   - mode === 'read' + only existing reads → grant
   *
   * Idempotent for the same `(laneId, mode)` on the same
   * resource: re-acquiring just returns the existing token-equivalent
   * so callers don't have to track whether they already hold the
   * lock (e.g. a lane that requests a write twice in a row gets
   * the same lock back, not a conflict).
   */
  acquire(input: WriteIntentRequest): AcquireWriteIntentResult {
    if (!input.workspacePath || !input.resourcePath || !input.laneId) {
      return {
        ok: false,
        conflict: {
          holders: [],
          reason: 'Write-intent acquisition requires workspacePath, resourcePath, and laneId.'
        }
      }
    }
    const resourceMap = this.getOrCreateResourceMap(input.workspacePath)
    const existing = resourceMap.get(input.resourcePath) ?? []
    // Idempotency: if this lane already holds the lock in the
    // requested mode (or stronger), grant without changing state.
    const selfHolder = existing.find(
      (h) => h.laneId === input.laneId && (h.mode === input.mode || h.mode === 'write')
    )
    if (selfHolder) {
      return {
        ok: true,
        token: {
          workspacePath: input.workspacePath,
          resourcePath: input.resourcePath,
          laneId: input.laneId,
          mode: selfHolder.mode,
          acquiredAt: selfHolder.acquiredAt
        }
      }
    }
    // Self holds read, wants upgrade to write — only allowed if
    // this lane is the SOLE reader. Otherwise it's a real
    // conflict (other readers would see a write mid-flight).
    const selfReader = existing.find((h) => h.laneId === input.laneId && h.mode === 'read')
    if (selfReader && input.mode === 'write') {
      const otherReaders = existing.filter((h) => h.laneId !== input.laneId)
      if (otherReaders.length > 0) {
        return {
          ok: false,
          conflict: {
            holders: otherReaders,
            reason: `Cannot upgrade read → write on ${input.resourcePath}: other lanes still hold read locks.`
          }
        }
      }
      // Upgrade in place — replace the read holder with a write holder.
      const upgraded: WriteIntentHolder = {
        laneId: input.laneId,
        mode: 'write',
        acquiredAt: input.nowIso
      }
      resourceMap.set(input.resourcePath, [upgraded])
      return {
        ok: true,
        token: {
          workspacePath: input.workspacePath,
          resourcePath: input.resourcePath,
          laneId: input.laneId,
          mode: 'write',
          acquiredAt: input.nowIso
        }
      }
    }
    // Foreign holders that block us:
    if (input.mode === 'write' && existing.length > 0) {
      return {
        ok: false,
        conflict: {
          holders: existing.slice(),
          reason: `Resource ${input.resourcePath} is locked by ${existing.length} other lane(s).`
        }
      }
    }
    if (input.mode === 'read') {
      const writer = existing.find((h) => h.mode === 'write')
      if (writer) {
        return {
          ok: false,
          conflict: {
            holders: [writer],
            reason: `Resource ${input.resourcePath} has an exclusive write lock held by lane ${writer.laneId}.`
          }
        }
      }
    }
    // Grant.
    const holder: WriteIntentHolder = {
      laneId: input.laneId,
      mode: input.mode,
      acquiredAt: input.nowIso
    }
    resourceMap.set(input.resourcePath, [...existing, holder])
    return {
      ok: true,
      token: {
        workspacePath: input.workspacePath,
        resourcePath: input.resourcePath,
        laneId: input.laneId,
        mode: input.mode,
        acquiredAt: input.nowIso
      }
    }
  }

  /**
   * Release a previously-acquired intent. Returns `true` if the
   * matching holder was found + removed, `false` if the token
   * was stale (already released / never held). Callers should
   * tolerate `false` — the registry stays consistent either way.
   */
  release(token: WriteIntentToken): boolean {
    const resourceMap = this.byWorkspace.get(token.workspacePath)
    if (!resourceMap) return false
    const holders = resourceMap.get(token.resourcePath)
    if (!holders) return false
    const next = holders.filter((h) => !(h.laneId === token.laneId && h.mode === token.mode))
    if (next.length === holders.length) return false
    if (next.length === 0) {
      resourceMap.delete(token.resourcePath)
    } else {
      resourceMap.set(token.resourcePath, next)
    }
    if (resourceMap.size === 0) {
      this.byWorkspace.delete(token.workspacePath)
    }
    return true
  }

  /**
   * Release every intent held by a lane, across every workspace
   * + resource it touched. Called on lane termination
   * (completed / failed / cancelled). Returns the released
   * tokens so the orchestrator can audit-log them.
   */
  releaseAllForLane(laneId: string): WriteIntentToken[] {
    const released: WriteIntentToken[] = []
    for (const [workspacePath, resourceMap] of this.byWorkspace.entries()) {
      for (const [resourcePath, holders] of resourceMap.entries()) {
        const remaining = holders.filter((h) => h.laneId !== laneId)
        const removed = holders.filter((h) => h.laneId === laneId)
        for (const r of removed) {
          released.push({
            workspacePath,
            resourcePath,
            laneId: r.laneId,
            mode: r.mode,
            acquiredAt: r.acquiredAt
          })
        }
        if (remaining.length === 0) {
          resourceMap.delete(resourcePath)
        } else if (remaining.length !== holders.length) {
          resourceMap.set(resourcePath, remaining)
        }
      }
      if (resourceMap.size === 0) {
        this.byWorkspace.delete(workspacePath)
      }
    }
    return released
  }

  /**
   * Read-only snapshot of currently-held intents. Used by the
   * orchestrator + a future debug IPC ("show me what's locked
   * right now"). Pass a workspacePath to scope; omit for a
   * global view. Returned array is in iteration order — not
   * sorted; callers that need sorting do their own.
   */
  snapshot(workspacePath?: string): Array<{
    workspacePath: string
    resourcePath: string
    holders: WriteIntentHolder[]
  }> {
    const out: Array<{
      workspacePath: string
      resourcePath: string
      holders: WriteIntentHolder[]
    }> = []
    const iter = workspacePath
      ? this.byWorkspace.get(workspacePath)
        ? [[workspacePath, this.byWorkspace.get(workspacePath)!] as const]
        : []
      : Array.from(this.byWorkspace.entries())
    for (const [ws, resourceMap] of iter) {
      for (const [resourcePath, holders] of resourceMap.entries()) {
        out.push({
          workspacePath: ws,
          resourcePath,
          holders: holders.map((h) => ({ ...h }))
        })
      }
    }
    return out
  }

  /** Clear all state. Test-only. */
  __reset(): void {
    this.byWorkspace.clear()
  }

  private getOrCreateResourceMap(workspacePath: string): Map<string, WriteIntentHolder[]> {
    let map = this.byWorkspace.get(workspacePath)
    if (!map) {
      map = new Map()
      this.byWorkspace.set(workspacePath, map)
    }
    return map
  }
}

// 1.9.2 durable authority. The legacy class above remains source-compatible
// while integration migrates callers from lane-local exact-path intents to
// run-owned workspace/tree/file/hunk leases.
export { WorkspaceLockAuthority } from './workLocks/WorkspaceLockAuthority'
export { NodeWorkspaceLockPersistence } from './workLocks/NodeWorkspaceLockPersistence'
export * from './workLocks/WorkspaceLockTypes'
