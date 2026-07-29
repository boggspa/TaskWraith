import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { ReleaseCommandCheckOptions } from '../ReleaseCommandPolicy'
import type { WorkspaceLockGatedProcess } from '../WorkspaceLockGatedProcess'

export const BACKGROUND_PROCESS_LOG_LIMIT = 500_000
export const BACKGROUND_PROCESS_ENTRY_LIMIT = 80

export type BackgroundProcessStreamName = 'stdout' | 'stderr' | 'both'
export type BackgroundProcessSignalName = 'SIGTERM' | 'SIGKILL'

export type BackgroundProcessHistoryScope =
  | { kind: 'global' }
  | { kind: 'workspace'; workspaceId: string; chatIds?: readonly string[] }
  | { kind: 'chat' | 'truncate'; chatIds: readonly string[] }

export interface BackgroundProcessHistoryHold {
  readonly id: string
  readonly processIds: readonly string[]
  /** Resolves only after every frozen child emits its real `close` event. */
  readonly completion: Promise<void>
}

export interface BackgroundProcessStartOptions {
  appChatId: string
  workspaceId?: string
  name?: string
  initialWaitMs: number
  maxInitialChars: number
  releaseApproval?: ReleaseCommandCheckOptions
  /** Exact opaque owner issued by workspace-lock admission for this process. */
  workspaceLockOwnerId?: string
  workspaceLockLifecycle?: BackgroundProcessWorkspaceLockLifecycle
}

export interface BackgroundProcessWorkspaceLockLifecycleInput {
  processId: string
  appChatId: string
  workspaceId?: string
  command: string
  cwd: string
  child: ChildProcess
  pid: number
  workspaceLockOwnerId: string
}

/**
 * Transfers a pre-spawn acquisition to the exact child and releases the
 * transferred acquisition only after that child emits its real close event.
 */
export interface BackgroundProcessWorkspaceLockLifecycle {
  bind(input: BackgroundProcessWorkspaceLockLifecycleInput): Promise<void>
  /** Null means spawn returned no exact PID, so the pre-spawn owner remains. */
  release(input: BackgroundProcessWorkspaceLockLifecycleInput | null): Promise<void>
}

export interface BackgroundProcessRegistryDependencies {
  spawnProcess: (
    command: string,
    cwd: string,
    authority?: { workspaceLockOwnerId?: string }
  ) => ChildProcess
  spawnGatedProcess?: (
    command: string,
    cwd: string,
    authority: { workspaceLockOwnerId: string }
  ) => WorkspaceLockGatedProcess
  /** Signal the exact process group when one exists, with an exact-child fallback. */
  signalProcess: (child: ChildProcess, signal: BackgroundProcessSignalName) => void
  commandBlockReason?: (
    command: string,
    cwd: string,
    approval?: ReleaseCommandCheckOptions
  ) => string | null
  trackProcess?: (input: {
    pid: number
    pgid: number
    startedAt: string
    workspacePath: string
  }) => void
  untrackProcess?: (pid: number) => void
  now?: () => Date
  createId?: () => string
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  killGraceMs?: number
}

interface BackgroundProcessEntry {
  processId: string
  appChatId: string
  workspaceId?: string
  name?: string
  command: string
  cwd: string
  child: ChildProcess
  pid?: number
  startedAt: string
  endedAt?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  error?: string
  stdout: string
  stderr: string
  stdoutBase: number
  stderrBase: number
  stdoutLength: number
  stderrLength: number
  close: Promise<void>
  historyTermination?: Promise<void>
}

interface ActiveHistoryHold {
  publicHold: BackgroundProcessHistoryHold
  scope: NormalizedHistoryScope
}

type NormalizedHistoryScope =
  | { kind: 'global' }
  | { kind: 'workspace'; workspaceId: string; chatIds: ReadonlySet<string> }
  | { kind: 'chat'; chatIds: ReadonlySet<string> }

function normalizeScope(scope: BackgroundProcessHistoryScope): NormalizedHistoryScope {
  if (scope.kind === 'global') return { kind: 'global' }
  if (scope.kind === 'workspace') {
    const workspaceId = scope.workspaceId.trim()
    if (!workspaceId) throw new Error('Background-process history workspace id is required.')
    return {
      kind: 'workspace',
      workspaceId,
      chatIds: new Set(scope.chatIds || [])
    }
  }
  return { kind: 'chat', chatIds: new Set(scope.chatIds) }
}

function scopeMatches(
  scope: NormalizedHistoryScope,
  owner: { appChatId: string; workspaceId?: string }
): boolean {
  if (scope.kind === 'global') return true
  if (scope.kind === 'workspace') {
    return owner.workspaceId === scope.workspaceId || scope.chatIds.has(owner.appChatId)
  }
  return scope.chatIds.has(owner.appChatId)
}

/**
 * Owns agent-started detached processes for one Electron-main lifetime.
 *
 * History holds are synchronous admission fences. They freeze the exact matching
 * children, signal their process groups immediately, and retain a close-event join
 * through the outer durable history commit. A signal acknowledgement is never
 * treated as process termination.
 */
export class BackgroundProcessRegistry {
  private readonly entries = new Map<string, BackgroundProcessEntry>()
  private readonly activeHistoryHolds = new Map<string, ActiveHistoryHold>()
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly setTimer: NonNullable<BackgroundProcessRegistryDependencies['setTimer']>
  private readonly clearTimer: NonNullable<BackgroundProcessRegistryDependencies['clearTimer']>
  private readonly killGraceMs: number

  constructor(private readonly deps: BackgroundProcessRegistryDependencies) {
    this.now = deps.now ?? (() => new Date())
    this.createId = deps.createId ?? (() => `bg-${Date.now()}-${randomBytes(4).toString('hex')}`)
    this.setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer))
    this.killGraceMs = Math.max(0, deps.killGraceMs ?? 2_000)
  }

  async start(
    command: string,
    cwd: string,
    options: BackgroundProcessStartOptions
  ): Promise<Record<string, unknown>> {
    const startedAt = this.now().toISOString()
    const processId = this.createId()
    const owner = { appChatId: options.appChatId, workspaceId: options.workspaceId }
    const blockingHold = [...this.activeHistoryHolds.values()].find((hold) =>
      scopeMatches(hold.scope, owner)
    )
    if (blockingHold) {
      return {
        ok: false,
        processId,
        command,
        cwd,
        startedAt,
        error: 'Background-process authority was revoked by an active history deletion.'
      }
    }

    const blockedReleaseCommand = this.deps.commandBlockReason?.(
      command,
      cwd,
      options.releaseApproval
    )
    if (blockedReleaseCommand) {
      return {
        ok: false,
        processId,
        command,
        cwd,
        startedAt,
        error: blockedReleaseCommand
      }
    }

    if (options.workspaceLockLifecycle && !options.workspaceLockOwnerId) {
      return {
        ok: false,
        processId,
        command,
        cwd,
        startedAt,
        error: 'Workspace-lock process gate requires an exact owner id.'
      }
    }
    if (options.workspaceLockLifecycle && !this.deps.spawnGatedProcess) {
      return {
        ok: false,
        processId,
        command,
        cwd,
        startedAt,
        error: 'Workspace-lock process gate is unavailable.'
      }
    }

    let child: ChildProcess
    let gatedProcess: WorkspaceLockGatedProcess | null = null
    try {
      if (options.workspaceLockLifecycle && options.workspaceLockOwnerId) {
        gatedProcess = this.deps.spawnGatedProcess!(command, cwd, {
          workspaceLockOwnerId: options.workspaceLockOwnerId
        })
        child = gatedProcess.child
      } else {
        child = this.deps.spawnProcess(command, cwd, {
          workspaceLockOwnerId: options.workspaceLockOwnerId
        })
      }
    } catch (error) {
      return {
        ok: false,
        processId,
        command,
        cwd,
        startedAt,
        error: error instanceof Error ? error.message : String(error)
      }
    }

    let resolveRawClose!: () => void
    const rawClose = new Promise<void>((resolve) => {
      resolveRawClose = resolve
    })
    const workspaceLockLifecycleInput =
      options.workspaceLockLifecycle && options.workspaceLockOwnerId && child.pid
        ? {
            processId,
            appChatId: options.appChatId,
            ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
            command,
            cwd,
            child,
            pid: child.pid,
            workspaceLockOwnerId: options.workspaceLockOwnerId
          }
        : null
    let bindWorkspaceLock = Promise.resolve()
    let workspaceLockReleased = false
    const releaseWorkspaceLock = async (): Promise<void> => {
      if (workspaceLockReleased || !options.workspaceLockLifecycle) return
      workspaceLockReleased = true
      await options.workspaceLockLifecycle.release(workspaceLockLifecycleInput)
    }
    const close = rawClose.then(async () => {
      try {
        await bindWorkspaceLock
      } catch {
        // The bind failure is projected by start(); the pre-spawn acquisition
        // still needs its exact close-bound release.
      }
      try {
        await releaseWorkspaceLock()
      } catch (error) {
        entry.error = `Workspace-lock release failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
    })
    const entry: BackgroundProcessEntry = {
      processId,
      appChatId: options.appChatId,
      workspaceId: options.workspaceId,
      name: options.name,
      command,
      cwd,
      child,
      pid: child.pid,
      startedAt,
      stdout: '',
      stderr: '',
      stdoutBase: 0,
      stderrBase: 0,
      stdoutLength: 0,
      stderrLength: 0,
      close
    }

    // Register lifecycle listeners before exposing the entry to readers or to
    // the history-deletion selector. `spawn` is synchronous, so no competing
    // main-loop turn can enter between admission and this registration.
    child.stdout?.on('data', (chunk) => this.append(entry, 'stdout', chunk.toString()))
    child.stderr?.on('data', (chunk) => this.append(entry, 'stderr', chunk.toString()))
    child.on('error', (error) => {
      entry.error = error.message
    })
    child.once('close', (code, signal) => {
      entry.exitCode = code
      entry.signal = signal
      entry.endedAt = this.now().toISOString()
      if (entry.pid) this.deps.untrackProcess?.(entry.pid)
      resolveRawClose()
    })

    this.entries.set(processId, entry)
    this.prune()
    if (child.pid) {
      this.deps.trackProcess?.({
        pid: child.pid,
        pgid: child.pid,
        startedAt,
        workspacePath: cwd
      })
    }

    if (options.workspaceLockLifecycle) {
      if (!workspaceLockLifecycleInput) {
        entry.error =
          'Workspace-lock child binding requires an exact owner id and kernel-assigned PID.'
        await this.terminateAfterWorkspaceLockBindFailure(entry)
        return this.failedStart(entry)
      }
      bindWorkspaceLock = options.workspaceLockLifecycle.bind(workspaceLockLifecycleInput)
      try {
        await bindWorkspaceLock
        gatedProcess?.start()
      } catch (error) {
        entry.error = `Workspace-lock child binding failed: ${
          error instanceof Error ? error.message : String(error)
        }`
        await this.terminateAfterWorkspaceLockBindFailure(entry)
        return this.failedStart(entry)
      }
    }

    if (options.initialWaitMs > 0) {
      await new Promise<void>((resolveWait) => {
        this.setTimer(() => resolveWait(), options.initialWaitMs)
      })
    }

    const current = this.entries.get(processId)
    if (current !== entry) {
      return {
        ok: false,
        processId,
        command,
        cwd,
        startedAt,
        error: 'Background-process authority was revoked by history deletion before start returned.'
      }
    }
    return this.read(processId, {
      appChatId: options.appChatId,
      stdoutOffset: 0,
      stderrOffset: 0,
      maxChars: options.maxInitialChars,
      stream: 'both'
    })
  }

  /**
   * Synchronously raises an admission fence and begins exact termination.
   * The returned hold must remain active until the outer history commit.
   */
  beginHistoryDeletion(scope: BackgroundProcessHistoryScope): BackgroundProcessHistoryHold {
    const normalized = normalizeScope(scope)
    const id = `background-history-${randomBytes(8).toString('hex')}`
    const entries = [...this.entries.values()].filter((entry) => scopeMatches(normalized, entry))
    const processIds = entries.map((entry) => entry.processId).sort()
    const completion = Promise.all(
      entries.map(async (entry) => {
        await this.terminateForHistory(entry)
        if (this.entries.get(entry.processId) === entry) this.entries.delete(entry.processId)
      })
    ).then(() => undefined)
    const publicHold: BackgroundProcessHistoryHold = Object.freeze({
      id,
      processIds: Object.freeze(processIds),
      completion
    })
    this.activeHistoryHolds.set(id, { publicHold, scope: normalized })
    return publicHold
  }

  endHistoryDeletion(hold: BackgroundProcessHistoryHold): boolean {
    const active = this.activeHistoryHolds.get(hold.id)
    if (!active || active.publicHold !== hold) return false
    this.activeHistoryHolds.delete(hold.id)
    return true
  }

  list(filter: { appChatId: string }): Record<string, unknown> {
    const processes = [...this.entries.values()]
      .filter((entry) => entry.appChatId === filter.appChatId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((entry) => this.summary(entry))
    return { ok: true, count: processes.length, processes }
  }

  read(
    processId: string,
    options: {
      appChatId: string
      stdoutOffset?: number
      stderrOffset?: number
      maxChars: number
      stream: BackgroundProcessStreamName
    }
  ): Record<string, unknown> {
    const entry = this.entryFor(processId, options.appChatId)
    if (!entry) {
      return { ok: false, processId, error: 'Background process not found for this chat.' }
    }
    const stdout =
      options.stream === 'stdout' || options.stream === 'both'
        ? this.readStream(entry, 'stdout', options.stdoutOffset, options.maxChars)
        : undefined
    const stderr =
      options.stream === 'stderr' || options.stream === 'both'
        ? this.readStream(entry, 'stderr', options.stderrOffset, options.maxChars)
        : undefined
    return {
      ok: true,
      ...this.summary(entry),
      stdout,
      stderr
    }
  }

  async kill(
    processId: string,
    options: { appChatId: string; signal: BackgroundProcessSignalName }
  ): Promise<Record<string, unknown>> {
    const entry = this.entryFor(processId, options.appChatId)
    if (!entry) {
      return { ok: false, processId, error: 'Background process not found for this chat.' }
    }
    if (entry.endedAt) return { ok: true, alreadyExited: true, ...this.summary(entry) }
    try {
      this.deps.signalProcess(entry.child, options.signal)
      // Explicit process_kill retains its existing signal-acknowledgement
      // contract. History deletion uses terminateForHistory and joins `close`.
      return { ok: true, signal: options.signal, ...this.summary(entry) }
    } catch (error) {
      return {
        ok: false,
        ...this.summary(entry),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private terminateForHistory(entry: BackgroundProcessEntry): Promise<void> {
    if (entry.historyTermination) return entry.historyTermination
    if (entry.endedAt) return entry.close

    try {
      this.deps.signalProcess(entry.child, 'SIGTERM')
    } catch (error) {
      entry.error = `History SIGTERM failed: ${error instanceof Error ? error.message : String(error)}`
    }
    const killTimer = this.setTimer(() => {
      if (entry.endedAt) return
      try {
        this.deps.signalProcess(entry.child, 'SIGKILL')
      } catch (error) {
        entry.error = `History SIGKILL failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }, this.killGraceMs)
    killTimer.unref?.()

    entry.historyTermination = entry.close.finally(() => {
      this.clearTimer(killTimer)
    })
    return entry.historyTermination
  }

  private async terminateAfterWorkspaceLockBindFailure(
    entry: BackgroundProcessEntry
  ): Promise<void> {
    if (entry.endedAt) {
      await entry.close
      return
    }
    try {
      this.deps.signalProcess(entry.child, 'SIGTERM')
    } catch (error) {
      entry.error = `${entry.error || 'Workspace-lock binding failed.'} SIGTERM failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
    const killTimer = this.setTimer(() => {
      if (entry.endedAt) return
      try {
        this.deps.signalProcess(entry.child, 'SIGKILL')
      } catch (error) {
        entry.error = `${entry.error || 'Workspace-lock binding failed.'} SIGKILL failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
    }, this.killGraceMs)
    killTimer.unref?.()
    try {
      await entry.close
    } finally {
      this.clearTimer(killTimer)
    }
  }

  private failedStart(entry: BackgroundProcessEntry): Record<string, unknown> {
    return {
      ok: false,
      processId: entry.processId,
      command: entry.command,
      cwd: entry.cwd,
      startedAt: entry.startedAt,
      error: entry.error || 'Workspace-lock child binding failed.'
    }
  }

  private append(entry: BackgroundProcessEntry, stream: 'stdout' | 'stderr', chunk: string): void {
    if (!chunk) return
    const bufferKey = stream
    const baseKey = stream === 'stdout' ? 'stdoutBase' : 'stderrBase'
    const lengthKey = stream === 'stdout' ? 'stdoutLength' : 'stderrLength'
    entry[bufferKey] += chunk
    entry[lengthKey] += chunk.length
    if (entry[bufferKey].length > BACKGROUND_PROCESS_LOG_LIMIT) {
      entry[bufferKey] = entry[bufferKey].slice(-BACKGROUND_PROCESS_LOG_LIMIT)
      entry[baseKey] = entry[lengthKey] - entry[bufferKey].length
    }
  }

  private readStream(
    entry: BackgroundProcessEntry,
    stream: 'stdout' | 'stderr',
    offset: number | undefined,
    maxChars: number
  ): Record<string, unknown> {
    const buffer = entry[stream]
    const base = stream === 'stdout' ? entry.stdoutBase : entry.stderrBase
    const total = stream === 'stdout' ? entry.stdoutLength : entry.stderrLength
    const requestedOffset = typeof offset === 'number' ? offset : Math.max(base, total - maxChars)
    const startOffset = Math.max(base, Math.min(total, requestedOffset))
    const startIndex = Math.max(0, startOffset - base)
    const text = buffer.slice(startIndex, startIndex + maxChars)
    const cursor = startOffset + text.length
    return {
      text,
      offset: startOffset,
      cursor,
      length: total,
      truncatedBefore: requestedOffset < base,
      truncatedAfter: cursor < total
    }
  }

  private summary(entry: BackgroundProcessEntry): Record<string, unknown> {
    return {
      processId: entry.processId,
      name: entry.name,
      command: entry.command.length > 500 ? `${entry.command.slice(0, 500)}...` : entry.command,
      cwd: entry.cwd,
      pid: entry.pid,
      running: !entry.endedAt,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      error: entry.error,
      stdoutLength: entry.stdoutLength,
      stderrLength: entry.stderrLength
    }
  }

  private entryFor(processId: string, appChatId: string): BackgroundProcessEntry | undefined {
    const entry = this.entries.get(processId)
    if (!entry || entry.appChatId !== appChatId) return undefined
    return entry
  }

  private prune(): void {
    if (this.entries.size <= BACKGROUND_PROCESS_ENTRY_LIMIT) return
    const entries = [...this.entries.values()].sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt)
    )
    for (const entry of entries) {
      if (this.entries.size <= BACKGROUND_PROCESS_ENTRY_LIMIT) break
      if (!entry.endedAt) continue
      this.entries.delete(entry.processId)
    }
  }
}
