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
const ACTIVE_STATUSES = new Set<LaunchAttempt['status']>(['starting', 'running', 'stopping'])
type LaunchListener = (snapshot: LaunchSnapshot) => void

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
    this.log = deps.log || (() => {})
    this.store.recoverInterrupted(this.isoNow())
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
        git: target.git
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
        env: this.createEnv({ FORCE_COLOR: '0', NO_COLOR: '1' }, binary)
      })
    } catch (err) {
      const failed = this.store.update(attempt.id, {
        status: 'failed',
        endedAt: this.isoNow(),
        updatedAt: this.isoNow(),
        lastError: err instanceof Error ? err.message : String(err)
      })
      this.publishSoon()
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
    this.publishSoon()
    return { ok: true, attempt: running || attempt }
  }

  async stopAttempt(attemptId: string): Promise<LaunchStopResult> {
    const attempt = this.store.get(attemptId)
    if (!attempt) return { ok: false, error: 'Launch attempt not found.' }
    if (!ACTIVE_STATUSES.has(attempt.status)) return { ok: true, attempt }
    const child = this.activeChildren.get(attemptId)
    if (!child || !attempt.pid) {
      const interrupted = this.store.update(attemptId, {
        status: 'interrupted',
        endedAt: this.isoNow(),
        updatedAt: this.isoNow(),
        lastError: 'Launch process is no longer owned by this TaskWraith session.'
      })
      this.publishSoon()
      return { ok: false, attempt: interrupted || attempt, error: interrupted?.lastError }
    }
    const stopping = this.store.update(attemptId, {
      status: 'stopping',
      updatedAt: this.isoNow()
    })
    const result = await this.killProcess(attempt.pid, attempt.pgid)
    if (!result.ok) {
      const failed = this.store.update(attemptId, {
        status: 'failed',
        updatedAt: this.isoNow(),
        lastError: 'Failed to stop launch process.'
      })
      this.publishSoon()
      return { ok: false, attempt: failed || stopping || attempt, error: 'Failed to stop launch process.' }
    }
    const cancelled = this.store.update(attemptId, {
      status: 'cancelled',
      endedAt: this.isoNow(),
      updatedAt: this.isoNow()
    })
    if (attempt.pid) this.untrackSpawn(attempt.pid)
    this.activeChildren.delete(attemptId)
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
    this.store.update(attemptId, {
      outputTail,
      outputTailBytes: Buffer.byteLength(outputTail, 'utf8'),
      outputTruncated,
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
}

function isTerminal(status: LaunchAttempt['status']): boolean {
  return status === 'stopped' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

function hashTargetSnapshot(target: LaunchTarget): string {
  return createHash('sha256').update(JSON.stringify(target)).digest('hex')
}
