import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { LaunchAttempt, LaunchAttemptStatus } from './types'

const ACTIVE_STATUSES = new Set<LaunchAttemptStatus>(['starting', 'running', 'stopping'])

// Keep the durable file bounded. Every still-active attempt is always retained;
// terminal attempts are capped to the most-recently-updated N so a long-lived
// install does not grow launch-attempts.json (and every read/serialize of it)
// without limit.
const MAX_TERMINAL_ATTEMPTS = 50

// Output arrives chunk-by-chunk from chatty dev servers. Persisting on every
// chunk would re-serialize + atomically rewrite the whole file per stdout line
// on the main thread. Status transitions still flush synchronously (durability),
// but the high-frequency output path is coalesced behind this debounce — and the
// next synchronous flush persists whatever was buffered, since a flush always
// writes the whole in-memory cache.
const OUTPUT_FLUSH_DEBOUNCE_MS = 250

export class LaunchAttemptStore {
  private cache: LaunchAttempt[] | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private pendingFlush = false

  constructor(
    private readonly storagePath: string,
    private readonly debounceMs: number = OUTPUT_FLUSH_DEBOUNCE_MS
  ) {}

  list(): LaunchAttempt[] {
    return [...this.load()].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.startedAt.localeCompare(a.startedAt)
    )
  }

  get(id: string): LaunchAttempt | null {
    return this.load().find((attempt) => attempt.id === id) || null
  }

  save(attempt: LaunchAttempt): LaunchAttempt {
    const attempts = this.load()
    const index = attempts.findIndex((item) => item.id === attempt.id)
    if (index >= 0) attempts[index] = attempt
    else attempts.push(attempt)
    this.flush()
    return attempt
  }

  update(id: string, partial: Partial<LaunchAttempt>): LaunchAttempt | null {
    const updated = this.applyUpdate(id, partial)
    if (updated) this.flush()
    return updated
  }

  /**
   * Like {@link update} but for the high-frequency output path: the in-memory
   * record updates immediately (so live snapshots reflect it) while the disk
   * write is coalesced behind {@link OUTPUT_FLUSH_DEBOUNCE_MS}. Any subsequent
   * synchronous flush (a status transition) persists the buffered output too.
   */
  appendOutputState(id: string, partial: Partial<LaunchAttempt>): LaunchAttempt | null {
    const updated = this.applyUpdate(id, partial)
    if (updated) this.scheduleFlush()
    return updated
  }

  recoverInterrupted(now = new Date().toISOString()): LaunchAttempt[] {
    const attempts = this.load()
    const recovered: LaunchAttempt[] = []
    const next = attempts.map((attempt) => {
      if (!ACTIVE_STATUSES.has(attempt.status)) return attempt
      const updated: LaunchAttempt = {
        ...attempt,
        status: 'interrupted',
        endedAt: now,
        updatedAt: now,
        lastError: attempt.lastError || 'TaskWraith restarted before this launch finished.'
      }
      recovered.push(updated)
      return updated
    })
    if (recovered.length > 0) {
      this.cache = next
      this.flush()
    }
    return recovered
  }

  createId(): string {
    return `launch-attempt-${randomUUID()}`
  }

  /** Force any debounced output write to disk immediately. */
  flushNow(): void {
    if (this.flushTimer || this.pendingFlush) this.flush()
  }

  private applyUpdate(id: string, partial: Partial<LaunchAttempt>): LaunchAttempt | null {
    const attempts = this.load()
    const index = attempts.findIndex((item) => item.id === id)
    if (index < 0) return null
    const updated: LaunchAttempt = {
      ...attempts[index],
      ...partial,
      id: attempts[index].id,
      schemaVersion: 1
    }
    attempts[index] = updated
    return updated
  }

  private load(): LaunchAttempt[] {
    if (!this.cache) this.cache = this.read().filter(isLaunchAttempt)
    return this.cache
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pendingFlush = false
    const pruned = pruneAttempts(this.load())
    this.cache = pruned
    this.write(pruned)
  }

  private scheduleFlush(): void {
    this.pendingFlush = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (this.pendingFlush) this.flush()
    }, this.debounceMs)
    // Never let a pending output flush keep the process alive on quit.
    this.flushTimer.unref?.()
  }

  private read(): unknown[] {
    try {
      const text = fs.readFileSync(this.storagePath, 'utf8')
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private write(attempts: LaunchAttempt[]): void {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true })
    const tempPath = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tempPath, `${JSON.stringify(attempts, null, 2)}\n`, 'utf8')
    fs.renameSync(tempPath, this.storagePath)
  }
}

/**
 * Retain every active attempt plus the most-recently-updated terminal records up
 * to {@link MAX_TERMINAL_ATTEMPTS}. Order of the surviving records is preserved
 * so callers that re-sort (e.g. {@link LaunchAttemptStore.list}) are unaffected.
 */
function pruneAttempts(attempts: LaunchAttempt[]): LaunchAttempt[] {
  const terminal = attempts.filter((attempt) => !ACTIVE_STATUSES.has(attempt.status))
  if (terminal.length <= MAX_TERMINAL_ATTEMPTS) return attempts
  const keptTerminal = new Set(
    [...terminal]
      .sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.startedAt.localeCompare(a.startedAt)
      )
      .slice(0, MAX_TERMINAL_ATTEMPTS)
      .map((attempt) => attempt.id)
  )
  return attempts.filter(
    (attempt) => ACTIVE_STATUSES.has(attempt.status) || keptTerminal.has(attempt.id)
  )
}

function isLaunchAttempt(value: unknown): value is LaunchAttempt {
  if (!value || typeof value !== 'object') return false
  const attempt = value as Partial<LaunchAttempt>
  return (
    attempt.schemaVersion === 1 &&
    typeof attempt.id === 'string' &&
    typeof attempt.targetId === 'string' &&
    typeof attempt.targetSnapshotHash === 'string' &&
    typeof attempt.workspacePath === 'string' &&
    typeof attempt.cwd === 'string' &&
    typeof attempt.commandRaw === 'string' &&
    Array.isArray(attempt.argv) &&
    typeof attempt.status === 'string' &&
    typeof attempt.startedAt === 'string' &&
    typeof attempt.updatedAt === 'string' &&
    typeof attempt.outputTail === 'string' &&
    typeof attempt.outputTailBytes === 'number' &&
    typeof attempt.outputTruncated === 'boolean'
  )
}
