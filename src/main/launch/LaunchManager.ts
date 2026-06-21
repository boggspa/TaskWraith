import { createHash } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { WebContents } from 'electron'
import { isPathInsideWorkspace } from '../AgenticPolicy'
import {
  createUnixKillController,
  createWindowsKillController,
  escalateKill,
  type KillController,
  type KillResult
} from '../localServers/killer'
import type { TrackedSpawn } from '../localServers/types'
import type { LaunchTarget } from '../launchTargets/types'
import type { AgenticServiceId, ProviderId } from '../store/types'
import { LaunchAttemptStore } from './LaunchAttemptStore'
import type {
  LaunchAttempt,
  LaunchSnapshot,
  LaunchStartResult,
  LaunchStopResult
} from './types'

const OUTPUT_TAIL_LIMIT = 32_000
const DETECTED_URL_LIMIT = 8
const ACTIVE_STATUSES = new Set<LaunchAttempt['status']>(['starting', 'running', 'stopping'])
const RECOVERED_STOPPABLE_STATUSES = new Set<LaunchAttempt['status']>(['interrupted'])
type LaunchListener = (snapshot: LaunchSnapshot) => void

export type LaunchLifecycleEventType =
  | 'launch_started'
  | 'launch_failed'
  | 'launch_stop_requested'
  | 'launch_stop_failed'
  | 'launch_cancelled'
  | 'launch_stopped'
  | 'launch_interrupted'

export interface LaunchLifecycleRecord {
  eventType: LaunchLifecycleEventType
  attempt: LaunchAttempt
  summary: string
  payload?: Record<string, unknown>
}

export interface LaunchManagerDeps {
  store: LaunchAttemptStore
  platform?: NodeJS.Platform
  now?: () => Date
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  requestApproval: (
    sender: WebContents | null,
    provider: ProviderId,
    service: AgenticServiceId,
    workspacePath: string | undefined,
    request: {
      method: string
      title: string
      body: string
      preview?: unknown
      runId?: string
      forcePrompt?: boolean
    }
  ) => Promise<boolean>
  createEnv: (extra: Record<string, string>, binaryPath?: string | null) => Record<string, string>
  trackSpawn?: (spawn: TrackedSpawn) => void
  untrackSpawn?: (pid: number) => void
  createKillController?: (pid: number, pgid?: number) => KillController
  killProcess?: (pid: number, pgid?: number) => Promise<KillResult>
  recordLifecycleEvent?: (event: LaunchLifecycleRecord) => void
  log?: (line: string) => void
}

export interface StartLaunchTargetInput {
  sender: WebContents | null
  provider: ProviderId
  target: LaunchTarget
  chatId?: string
  runId?: string
}

export class LaunchManager {
  private readonly store: LaunchAttemptStore
  private readonly platform: NodeJS.Platform
  private readonly now: () => Date
  private readonly spawnProcess: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  private readonly activeChildren = new Map<string, ChildProcess>()
  private readonly requestApproval: LaunchManagerDeps['requestApproval']
  private readonly createEnv: LaunchManagerDeps['createEnv']
  private readonly trackSpawn: (spawn: TrackedSpawn) => void
  private readonly untrackSpawn: (pid: number) => void
  private readonly createKillController: (pid: number, pgid?: number) => KillController
  private readonly killProcess: (pid: number, pgid?: number) => Promise<KillResult>
  private readonly recordLifecycle: (event: LaunchLifecycleRecord) => void
  private readonly log: (line: string) => void
  private readonly listeners = new Set<LaunchListener>()
  private publishTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: LaunchManagerDeps) {
    this.store = deps.store
    this.platform = deps.platform || process.platform
    this.now = deps.now || (() => new Date())
    this.spawnProcess = deps.spawnProcess || spawn
    this.requestApproval = deps.requestApproval
    this.createEnv = deps.createEnv
    this.trackSpawn = deps.trackSpawn || (() => {})
    this.untrackSpawn = deps.untrackSpawn || (() => {})
    this.createKillController =
      deps.createKillController ||
      ((pid, pgid) =>
        this.platform === 'win32'
          ? createWindowsKillController(pid)
          : createUnixKillController(pid, pgid))
    this.killProcess =
      deps.killProcess || ((pid, pgid) => escalateKill(this.createKillController(pid, pgid)))
    this.recordLifecycle = deps.recordLifecycleEvent || (() => {})
    this.log = deps.log || (() => {})
    for (const attempt of this.store.recoverInterrupted(this.isoNow())) {
      this.recordLifecycleEvent(
        'launch_interrupted',
        attempt,
        `Launch interrupted after restart: ${attempt.targetLabel}`,
        { reason: attempt.lastError }
      )
    }
  }

  subscribe(listener: LaunchListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): LaunchSnapshot {
    return {
      sampledAt: this.isoNow(),
      attempts: this.store.list()
    }
  }

  async startTarget(input: StartLaunchTargetInput): Promise<LaunchStartResult> {
    const { target, provider, sender, chatId, runId } = input
    const existing = this.activeAttemptForTarget(target.id, target.workspacePath)
    if (existing) return { ok: true, attempt: existing }
    if (target.blockers.length > 0) {
      return { ok: false, error: target.blockers.join(' ') }
    }
    const command = target.command
    if (!command?.argv?.length) {
      return { ok: false, error: 'Launch target is not executable by TaskWraith yet.' }
    }
    if (command.shell) {
      return { ok: false, error: 'Shell-backed launch targets are not executable yet.' }
    }
    if (!isPathInsideWorkspace(target.workspacePath, command.cwd)) {
      return { ok: false, error: 'Launch target cwd is outside the workspace.' }
    }

    const commandText = command.raw || command.argv.join(' ')
    const envDeltas = command.env || {}
    const allowed = await this.requestApproval(sender, provider, 'shellCommands', target.workspacePath, {
      method: 'launch/start',
      title: 'Approve launch target',
      body: `${target.label}\n${commandText}\n${command.cwd}`,
      runId,
      forcePrompt: true,
      preview: {
        kind: 'launch-target',
        targetId: target.id,
        label: target.label,
        source: target.source,
        kindLabel: target.kind,
        command: commandText,
        cwd: command.cwd,
        workspacePath: target.workspacePath,
        git: target.git,
        ...(Object.keys(envDeltas).length > 0 ? { envDeltas } : {})
      }
    })
    if (!allowed) return { ok: false, error: 'Launch denied by TaskWraith approval policy.' }

    const now = this.isoNow()
    const attempt: LaunchAttempt = {
      schemaVersion: 1,
      id: this.store.createId(),
      targetId: target.id,
      targetLabel: target.label,
      targetSource: target.source,
      targetKind: target.kind,
      targetSnapshot: target,
      targetSnapshotHash: hashTargetSnapshot(target),
      provider,
      workspaceId: target.workspaceId,
      workspacePath: target.workspacePath,
      git: target.git,
      cwd: command.cwd,
      commandRaw: commandText,
      argv: command.argv,
      status: 'starting',
      startedAt: now,
      updatedAt: now,
      outputTail: '',
      outputTailBytes: 0,
      outputTruncated: false,
      chatId,
      runId
    }
    this.store.save(attempt)
    this.publishSoon()

    let child: ChildProcess
    try {
      const [binary, ...args] = command.argv
      child = this.spawnProcess(binary, args, {
        cwd: command.cwd,
        shell: false,
        detached: this.platform !== 'win32',
        windowsHide: true,
        env: this.createEnv({ ...envDeltas, FORCE_COLOR: '0', NO_COLOR: '1' }, binary)
      })
    } catch (err) {
      const failed = this.store.update(attempt.id, {
        status: 'failed',
        endedAt: this.isoNow(),
        updatedAt: this.isoNow(),
        lastError: err instanceof Error ? err.message : String(err)
      })
      this.publishSoon()
      this.recordLifecycleEvent(
        'launch_failed',
        failed || attempt,
        `Launch failed before start: ${target.label}`,
        { phase: 'spawn', error: failed?.lastError || (err instanceof Error ? err.message : String(err)) }
      )
      return { ok: false, attempt: failed || attempt, error: failed?.lastError || 'Launch failed.' }
    }

    this.activeChildren.set(attempt.id, child)
    const pid = child.pid
    const pgid = this.platform !== 'win32' && pid ? pid : undefined
    const running = this.store.update(attempt.id, {
      status: 'running',
      pid,
      pgid,
      updatedAt: this.isoNow()
    })
    if (pid) {
      this.trackSpawn({
        pid,
        pgid,
        workspacePath: target.workspacePath,
        chatId,
        runId: runId || attempt.id,
        provider,
        startedAt: attempt.startedAt
      })
    }
    this.attachChild(attempt.id, child)
    this.recordLifecycleEvent(
      'launch_started',
      running || attempt,
      `Launch started: ${target.label}`,
      { pid, pgid }
    )
    this.publishSoon()
    return { ok: true, attempt: running || attempt }
  }

  async stopAttempt(attemptId: string): Promise<LaunchStopResult> {
    const attempt = this.store.get(attemptId)
    if (!attempt) return { ok: false, error: 'Launch attempt not found.' }
    const recoveredStoppable = RECOVERED_STOPPABLE_STATUSES.has(attempt.status) && Boolean(attempt.pid)
    if (!ACTIVE_STATUSES.has(attempt.status) && !recoveredStoppable) return { ok: true, attempt }
    const child = this.activeChildren.get(attemptId)
    if (!attempt.pid) {
      const interrupted = this.store.update(attemptId, {
        status: 'interrupted',
        endedAt: this.isoNow(),
        updatedAt: this.isoNow(),
        lastError: 'Launch process is no longer owned by this TaskWraith session.'
      })
      this.publishSoon()
      this.recordLifecycleEvent(
        'launch_interrupted',
        interrupted || attempt,
        `Launch interrupted: ${attempt.targetLabel}`,
        { reason: interrupted?.lastError || 'missing_pid' }
      )
      return { ok: false, attempt: interrupted || attempt, error: interrupted?.lastError }
    }
    if (!child && !recoveredStoppable) {
      const interrupted = this.store.update(attemptId, {
        status: 'interrupted',
        endedAt: this.isoNow(),
        updatedAt: this.isoNow(),
        lastError: 'Launch process is no longer owned by this TaskWraith session.'
      })
      this.publishSoon()
      this.recordLifecycleEvent(
        'launch_interrupted',
        interrupted || attempt,
        `Launch interrupted: ${attempt.targetLabel}`,
        { reason: interrupted?.lastError || 'missing_child' }
      )
      return { ok: false, attempt: interrupted || attempt, error: interrupted?.lastError }
    }
    const stopping = this.store.update(attemptId, {
      status: 'stopping',
      updatedAt: this.isoNow()
    })
    this.recordLifecycleEvent(
      'launch_stop_requested',
      stopping || attempt,
      `Launch stop requested: ${attempt.targetLabel}`,
      { pid: attempt.pid, pgid: attempt.pgid }
    )
    const result = await this.killProcess(attempt.pid, attempt.pgid)
    if (!result.ok) {
      const failed = this.store.update(attemptId, {
        status: 'failed',
        updatedAt: this.isoNow(),
        lastError: 'Failed to stop launch process.'
      })
      this.publishSoon()
      this.recordLifecycleEvent(
        'launch_stop_failed',
        failed || stopping || attempt,
        `Launch stop failed: ${attempt.targetLabel}`,
        { pid: attempt.pid, pgid: attempt.pgid }
      )
      return { ok: false, attempt: failed || stopping || attempt, error: 'Failed to stop launch process.' }
    }
    const cancelled = this.store.update(attemptId, {
      status: 'cancelled',
      endedAt: this.isoNow(),
      updatedAt: this.isoNow()
    })
    if (attempt.pid) this.untrackSpawn(attempt.pid)
    this.activeChildren.delete(attemptId)
    this.recordLifecycleEvent(
      'launch_cancelled',
      cancelled || stopping || attempt,
      `Launch stopped by user: ${attempt.targetLabel}`,
      { pid: attempt.pid, pgid: attempt.pgid }
    )
    this.publishSoon()
    return { ok: true, attempt: cancelled || stopping || attempt }
  }

  private attachChild(attemptId: string, child: ChildProcess): void {
    child.stdout?.on('data', (chunk) => this.appendOutput(attemptId, chunk))
    child.stderr?.on('data', (chunk) => this.appendOutput(attemptId, chunk))
    child.on('error', (err) => {
      const attempt = this.store.get(attemptId)
      if (attempt?.pid) this.untrackSpawn(attempt.pid)
      this.activeChildren.delete(attemptId)
      this.store.update(attemptId, {
        status: 'failed',
        endedAt: this.isoNow(),
        updatedAt: this.isoNow(),
        lastError: err.message
      })
      const failed = this.store.get(attemptId)
      this.recordLifecycleEvent(
        'launch_failed',
        failed || attempt,
        `Launch failed: ${attempt?.targetLabel || attemptId}`,
        { phase: 'process_error', error: err.message }
      )
      this.publishSoon()
      this.log(`[LaunchManager] ${attemptId} failed: ${err.message}`)
    })
    child.on('close', (exitCode, signal) => {
      const attempt = this.store.get(attemptId)
      if (attempt?.pid) this.untrackSpawn(attempt.pid)
      this.activeChildren.delete(attemptId)
      if (!attempt || isTerminal(attempt.status)) return
      const status =
        attempt.status === 'stopping' || signal
          ? 'cancelled'
          : exitCode === 0
            ? 'stopped'
            : 'failed'
      this.store.update(attemptId, {
        status,
        exitCode,
        signal,
        endedAt: this.isoNow(),
        updatedAt: this.isoNow(),
        ...(status === 'failed' ? { lastError: `Process exited ${exitCode ?? signal ?? 'unknown'}.` } : {})
      })
      const updated = this.store.get(attemptId)
      this.recordLifecycleEvent(
        status === 'failed'
          ? 'launch_failed'
          : status === 'cancelled'
            ? 'launch_cancelled'
            : 'launch_stopped',
        updated || attempt,
        launchTerminalSummary(status, attempt.targetLabel),
        { exitCode, signal }
      )
      this.publishSoon()
    })
  }

  private appendOutput(attemptId: string, chunk: unknown): void {
    const attempt = this.store.get(attemptId)
    if (!attempt) return
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    const nextTail = `${attempt.outputTail}${text}`
    const outputTruncated = attempt.outputTruncated || nextTail.length > OUTPUT_TAIL_LIMIT
    const outputTail = nextTail.length > OUTPUT_TAIL_LIMIT ? nextTail.slice(-OUTPUT_TAIL_LIMIT) : nextTail
    const detectedUrls = mergeDetectedUrls(attempt.detectedUrls, detectLaunchUrls(text))
    this.store.update(attemptId, {
      outputTail,
      outputTailBytes: Buffer.byteLength(outputTail, 'utf8'),
      outputTruncated,
      ...(detectedUrls.length > 0 ? { detectedUrls } : {}),
      updatedAt: this.isoNow()
    })
    this.publishSoon()
  }

  private activeAttemptForTarget(targetId: string, workspacePath: string): LaunchAttempt | null {
    return (
      this.store
        .list()
        .find(
          (attempt) =>
            attempt.targetId === targetId &&
            attempt.workspacePath === workspacePath &&
            ACTIVE_STATUSES.has(attempt.status)
        ) ||
      null
    )
  }

  private isoNow(): string {
    return this.now().toISOString()
  }

  private publishSoon(): void {
    if (this.publishTimer) return
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null
      const snapshot = this.snapshot()
      for (const listener of this.listeners) {
        try {
          listener(snapshot)
        } catch (err) {
          this.log(
            `[LaunchManager] listener failed: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
    }, 100)
  }

  private recordLifecycleEvent(
    eventType: LaunchLifecycleEventType,
    attempt: LaunchAttempt | null | undefined,
    summary: string,
    payload?: Record<string, unknown>
  ): void {
    if (!attempt) return
    try {
      this.recordLifecycle({ eventType, attempt, summary, payload })
    } catch (err) {
      this.log(
        `[LaunchManager] lifecycle recorder failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

function isTerminal(status: LaunchAttempt['status']): boolean {
  return status === 'stopped' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

function hashTargetSnapshot(target: LaunchTarget): string {
  return createHash('sha256').update(JSON.stringify(target)).digest('hex')
}

function launchTerminalSummary(status: LaunchAttempt['status'], label: string): string {
  if (status === 'failed') return `Launch failed: ${label}`
  if (status === 'cancelled') return `Launch cancelled: ${label}`
  return `Launch completed: ${label}`
}

function detectLaunchUrls(text: string): string[] {
  const matches = text.match(
    /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s'"<]*)?/gi
  )
  return matches ? matches.map((url) => url.replace(/[),.;]+$/, '')) : []
}

function mergeDetectedUrls(existing: string[] | undefined, next: string[]): string[] {
  if (next.length === 0) return existing || []
  const seen = new Set<string>()
  const merged: string[] = []
  for (const url of [...(existing || []), ...next]) {
    if (seen.has(url)) continue
    seen.add(url)
    merged.push(url)
    if (merged.length >= DETECTED_URL_LIMIT) break
  }
  return merged
}
