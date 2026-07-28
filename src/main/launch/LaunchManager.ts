import { createHash } from 'node:crypto'
import os from 'node:os'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import type { WebContents } from 'electron'
import { isPathInsideWorkspace } from '../AgenticPolicy'
import {
  createUnixKillController,
  createWindowsKillController,
  escalateKill,
  processExists,
  type KillController,
  type KillResult
} from '../localServers/killer'
import type { TrackedSpawn } from '../localServers/types'
import type { LaunchTarget } from '../launchTargets/types'
import type { AgenticServiceId, ProviderId } from '../store/types'
import {
  createPackagedIsolatedInstanceId,
  isValidPackagedIsolatedInstanceId,
  PACKAGE_SMOKE_ARG,
  PACKAGE_SMOKE_USER_DATA_ARG,
  PACKAGE_SMOKE_USER_DATA_SWITCH,
  PACKAGED_ISOLATED_INSTANCE_ARG,
  PACKAGED_ISOLATED_INSTANCE_SWITCH
} from '../InstanceLaunchPosture'
import { MCP_BRIDGE_ENTRY_ARG, MCP_BRIDGE_ROUTE_FROM_ENV_ARG } from '../mcp/McpBridgeRoute'
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

type SelfLaunchDecision =
  | { kind: 'approved-direct-executable'; executable: string }
  | { kind: 'refused'; error: string }
  | null

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
  /**
   * This app's own install root and executable, used to refuse a launch that
   * would start a second copy of TaskWraith. Injected rather than read from
   * `app` so the guard is testable without Electron; omit both to disable it.
   */
  appRootPath?: () => string | undefined
  appExecutablePath?: () => string | undefined
  /** Only packaged builds support the argv-selected isolated profile posture. */
  isPackagedApp?: () => boolean
  /** Fresh opaque id for an approved exact direct self-launch. */
  createIsolatedInstanceId?: () => string
  /**
   * Resolve the canonical process-birth receipt for the exact PID returned by
   * spawn. Missing or rejected resolution leaves the launch usable but
   * intentionally view-only to native-window control.
   */
  resolveProcessStartedAt?: (pid: number) => Promise<string | null>
  trackSpawn?: (spawn: TrackedSpawn) => void
  untrackSpawn?: (pid: number) => void
  createKillController?: (pid: number, pgid?: number) => KillController
  killProcess?: (pid: number, pgid?: number) => Promise<KillResult>
  /** Liveness probe for a bare pid (defaults to a signal-0 check). */
  processExists?: (pid: number) => boolean
  /** Wall-clock of the current OS boot (defaults to now − os.uptime()). */
  bootTime?: () => Date
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
  private readonly appRootPath: LaunchManagerDeps['appRootPath']
  private readonly appExecutablePath: LaunchManagerDeps['appExecutablePath']
  private readonly isPackagedApp: () => boolean
  private readonly createIsolatedInstanceId: () => string
  private readonly resolveProcessStartedAt: (pid: number) => Promise<string | null>
  private readonly trackSpawn: (spawn: TrackedSpawn) => void
  private readonly untrackSpawn: (pid: number) => void
  private readonly createKillController: (pid: number, pgid?: number) => KillController
  private readonly killProcess: (pid: number, pgid?: number) => Promise<KillResult>
  private readonly processExists: (pid: number) => boolean
  private readonly bootTime: () => Date
  private readonly recordLifecycle: (event: LaunchLifecycleRecord) => void
  private readonly log: (line: string) => void
  private readonly listeners = new Set<LaunchListener>()
  // In-flight start reservations keyed by `${workspacePath}\0${targetId}`, held
  // across the async approval so two rapid starts can't both spawn one target.
  private readonly startingTargets = new Set<string>()
  private publishTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: LaunchManagerDeps) {
    this.store = deps.store
    this.platform = deps.platform || process.platform
    this.now = deps.now || (() => new Date())
    this.spawnProcess = deps.spawnProcess || spawn
    this.requestApproval = deps.requestApproval
    this.createEnv = deps.createEnv
    this.appRootPath = deps.appRootPath
    this.appExecutablePath = deps.appExecutablePath
    this.isPackagedApp = deps.isPackagedApp || (() => false)
    this.createIsolatedInstanceId =
      deps.createIsolatedInstanceId || createPackagedIsolatedInstanceId
    this.resolveProcessStartedAt = deps.resolveProcessStartedAt || (async () => null)
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
    this.processExists = deps.processExists || processExists
    this.bootTime = deps.bootTime || (() => new Date(Date.now() - os.uptime() * 1000))
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

  /**
   * Classify a launch that would start a second copy of TaskWraith itself.
   *
   * Packaged TaskWraith normally uses its primary app name, userData, and
   * single-instance lock. The one intentional exception is an exact direct
   * executable invocation: after an explicit approval, it receives a freshly
   * minted argv-only isolated profile selector before startup.
   *
   * Wrapper forms are still indistinguishable from a crash-loop to an agent and
   * can discard or duplicate that selector. Refusing those forms up front turns
   * an unbounded retry loop into one clear failure.
   *
   * Matches on the SHAPE of the launch (an Electron entry point resolving to this
   * app's own root, or a .app bundle whose executable is ours) rather than on the
   * product name, so a rename does not silently disable it and an unrelated
   * project that merely has "taskwraith" in its path is not blocked.
   */
  private describeSelfLaunch(command: {
    raw: string
    argv?: string[]
    cwd: string
    shell?: boolean
  }): SelfLaunchDecision {
    const ownRoot = this.appRootPath?.()
    const ownExecutable = this.appExecutablePath?.()
    if (!ownRoot && !ownExecutable) return null
    const argv = command.argv?.length
      ? command.argv
      : command.shell
        ? tokenizeShellCommand(command.raw)
        : []
    const ownExecutableIdentity = ownExecutable
      ? canonicalLaunchPath(ownExecutable, command.cwd, this.platform)
      : null
    const ownArtifactIdentities = new Set(
      [ownRoot, ownExecutable, ownAppBundlePath(ownExecutable, this.platform)]
        .map((candidate) =>
          candidate ? canonicalLaunchPath(candidate, command.cwd, this.platform) : null
        )
        .filter((candidate): candidate is string => Boolean(candidate))
    )
    const firstArgument = argv[0]
    const firstIdentity = firstArgument
      ? canonicalLaunchPath(firstArgument, command.cwd, this.platform)
      : null

    // Identity is established from a canonical, cwd-resolved executable path,
    // never from the human-readable command string. That accepts a legitimate
    // relative or symlink alias while rejecting lookalike prefixes and literals
    // passed to an unrelated command such as `echo`.
    if (firstIdentity && ownExecutableIdentity && firstIdentity === ownExecutableIdentity) {
      if (this.isPackagedApp() && !command.shell) {
        return { kind: 'approved-direct-executable', executable: ownExecutableIdentity }
      }
      return refusedSelfLaunch()
    }

    // Direct use of another app artifact (its app root or bundle) is never a
    // supported executable launch shape. Do not infer self-launching from later
    // arbitrary arguments: only known wrapper forms are examined below.
    if (firstIdentity && ownArtifactIdentities.has(firstIdentity)) return refusedSelfLaunch()

    if (
      containsExactSelfLaunchInKnownWrapper(argv, ownArtifactIdentities, command.cwd, this.platform)
    ) {
      return refusedSelfLaunch()
    }
    return null
  }

  async startTarget(input: StartLaunchTargetInput): Promise<LaunchStartResult> {
    const { target, provider, sender, chatId, runId } = input
    const existing = this.activeAttemptForTarget(target.id, target.workspacePath)
    if (existing) return { ok: true, attempt: existing }
    if (target.blockers.length > 0) {
      return { ok: false, error: target.blockers.join(' ') }
    }
    const command = target.command
    if (!command) {
      return { ok: false, error: 'Launch target is not executable by TaskWraith yet.' }
    }
    if (command.shell && target.source !== 'vscode-task') {
      return { ok: false, error: 'Shell-backed launch targets are only supported for VS Code tasks.' }
    }
    if (command.shell ? !command.raw.trim() : !command.argv?.length) {
      return { ok: false, error: 'Launch target is not executable by TaskWraith yet.' }
    }
    if (!isPathInsideWorkspace(target.workspacePath, command.cwd)) {
      return { ok: false, error: 'Launch target cwd is outside the workspace.' }
    }
    const selfLaunch = this.describeSelfLaunch(command)
    if (selfLaunch?.kind === 'refused') return { ok: false, error: selfLaunch.error }
    const approvedDirectSelfLaunch = selfLaunch?.kind === 'approved-direct-executable'
    const preparedCommand =
      selfLaunch?.kind === 'approved-direct-executable'
        ? commandForApprovedDirectSelfLaunch(command, selfLaunch.executable)
        : command
    // A target's environment is repo/caller-controlled input. Scrub it before
    // approval, persistence, and spawn so a saved launch target cannot forge an
    // internal bridge, route, or private-instance posture in a future child.
    const envDeltas = sanitizeLaunchEnv(preparedCommand.env || {})
    const launchCommand = commandWithSanitizedLaunchEnv(preparedCommand, envDeltas)
    const launchTarget = { ...target, command: launchCommand }

    // Reserve the target before awaiting approval so a second start for the same
    // target can't slip through the activeAttemptForTarget guard (which only sees
    // a persisted attempt, created after approval) and spawn a duplicate.
    const reservationKey = `${target.workspacePath}\u0000${target.id}`
    if (this.startingTargets.has(reservationKey)) {
      return { ok: false, error: 'Launch target is already starting.' }
    }
    this.startingTargets.add(reservationKey)
    try {
      const commandText = launchCommand.raw || launchCommand.argv?.join(' ') || ''
      // Strip library-injection vectors from discovered (repo-controlled) env
      // deltas so a workspace launch/tasks config can't pre-load code into the
      // spawned process; legitimate deltas still surface in the approval preview.
      const allowed = await this.requestApproval(
        sender,
        provider,
        'shellCommands',
        target.workspacePath,
        {
          method: 'launch/start',
          title: 'Approve launch target',
          body:
            `${target.label}\n${commandText}\n${launchCommand.cwd}` +
            (approvedDirectSelfLaunch
              ? '\n\nThis starts a new isolated TaskWraith profile with no existing chats or pairings.'
              : ''),
          runId,
          forcePrompt: true,
          preview: {
            kind: 'launch-target',
            targetId: target.id,
            label: target.label,
            source: target.source,
            kindLabel: target.kind,
            platform: target.platform,
            execution: launchCommand.longRunning ? 'long-running' : 'finite',
            command: commandText,
            shell: Boolean(launchCommand.shell),
            cwd: launchCommand.cwd,
            workspacePath: target.workspacePath,
            git: target.git,
            ...(approvedDirectSelfLaunch
              ? {
                  isolatedProfile: {
                    created: true,
                    disclosure: 'New isolated profile; no existing chats or pairings.'
                  }
                }
              : {}),
            ...(Object.keys(envDeltas).length > 0 ? { envDeltas } : {})
          }
        }
      )
      if (!allowed) return { ok: false, error: 'Launch denied by TaskWraith approval policy.' }

      let isolatedInstanceId: string | undefined
      if (approvedDirectSelfLaunch) {
        try {
          const candidate = this.createIsolatedInstanceId()
          if (!isValidPackagedIsolatedInstanceId(candidate)) {
            return { ok: false, error: 'Unable to create a new isolated TaskWraith profile.' }
          }
          isolatedInstanceId = candidate
        } catch {
          return { ok: false, error: 'Unable to create a new isolated TaskWraith profile.' }
        }
      }

      const now = this.isoNow()
      const attempt: LaunchAttempt = {
        schemaVersion: 1,
        id: this.store.createId(),
        targetId: target.id,
        targetLabel: target.label,
        targetSource: target.source,
        targetKind: target.kind,
        targetSnapshot: launchTarget,
        targetSnapshotHash: hashTargetSnapshot(launchTarget),
        provider,
        workspaceId: target.workspaceId,
        workspacePath: target.workspacePath,
        git: target.git,
        cwd: launchCommand.cwd,
        commandRaw: commandText,
        argv: launchCommand.argv || [commandText],
        ...(isolatedInstanceId ? { isolatedInstanceId } : {}),
        shell: launchCommand.shell || undefined,
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
        const spawnArgv = launchCommand.argv || [commandText]
        const [binary, ...args] = isolatedInstanceId
          ? [...spawnArgv, `${PACKAGED_ISOLATED_INSTANCE_ARG}${isolatedInstanceId}`]
          : spawnArgv
        child = this.spawnProcess(
          launchCommand.shell ? commandText : binary,
          launchCommand.shell ? [] : args,
          {
            cwd: launchCommand.cwd,
            shell: Boolean(launchCommand.shell),
            detached: this.platform !== 'win32',
            windowsHide: true,
            env: sanitizeLaunchEnv(
              this.createEnv(
                { ...envDeltas, FORCE_COLOR: '0', NO_COLOR: '1' },
                launchCommand.shell ? undefined : binary
              )
            )
          }
        )
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
      // Persist the kernel-assigned PID while the attempt is still starting;
      // receipt resolution below may be asynchronous, and an immediate child
      // exit must still be recorded against the PID that actually spawned.
      this.store.update(attempt.id, {
        pid,
        pgid,
        updatedAt: this.isoNow()
      })
      // Subscribe before awaiting the host receipt so an immediately exiting
      // child cannot escape lifecycle tracking during the async resolution.
      this.attachChild(attempt.id, child)
      const processStartedAt = await this.resolveCanonicalProcessStartedAt(pid)
      const currentAttempt = this.store.get(attempt.id)
      const childIsStillLive = child.exitCode === null && child.signalCode === null
      if (currentAttempt?.status !== 'starting' || !childIsStillLive) {
        // The child exited while its birth receipt was resolving. Either the
        // terminal listener persisted the outcome already, its observable exit
        // state will be finalized by close, or an explicit stop is in progress.
        // Never bind this receipt or resurrect the attempt as running.
        this.publishSoon()
        return { ok: true, attempt: currentAttempt || attempt }
      }
      const running = this.store.update(attempt.id, {
        status: 'running',
        pid,
        pgid,
        ...(processStartedAt ? { processStartedAt } : {}),
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
      this.recordLifecycleEvent(
        'launch_started',
        running || attempt,
        `Launch started: ${target.label}`,
        { pid, pgid }
      )
      this.publishSoon()
      return { ok: true, attempt: running || attempt }
    } finally {
      this.startingTargets.delete(reservationKey)
    }
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
    if (recoveredStoppable && !child && !this.recoveredProcessIsLive(attempt)) {
      // The persisted pid predates this boot (or no longer exists), so it may now
      // belong to an unrelated process. Never signal it: settle the attempt and
      // drop the stale pid/pgid so it can't be targeted again.
      const stopped = this.store.update(attemptId, {
        status: 'stopped',
        endedAt: this.isoNow(),
        updatedAt: this.isoNow(),
        pid: undefined,
        pgid: undefined,
        lastError: 'Launch process was no longer running; its stale PID was not signaled.'
      })
      if (attempt.pid) this.untrackSpawn(attempt.pid)
      this.activeChildren.delete(attemptId)
      this.publishSoon()
      this.recordLifecycleEvent(
        'launch_stopped',
        stopped || attempt,
        `Launch already stopped: ${attempt.targetLabel}`,
        { reason: 'stale_pid', pid: attempt.pid }
      )
      return { ok: true, attempt: stopped || attempt }
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
    // Decode as UTF-8 so multi-byte sequences split across chunk boundaries are
    // buffered by the stream rather than corrupted into replacement characters.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
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
    // High-frequency path: update memory now (live snapshots) and coalesce the
    // disk write. The next status transition flushes any buffered output.
    this.store.appendOutputState(attemptId, {
      outputTail,
      outputTailBytes: Buffer.byteLength(outputTail, 'utf8'),
      outputTruncated,
      ...(detectedUrls.length > 0 ? { detectedUrls } : {}),
      updatedAt: this.isoNow()
    })
    this.publishSoon()
  }

  /**
   * A recovered attempt carries a pid/pgid persisted by a previous session.
   * Before signaling it we must be sure it is still OUR process: if the machine
   * rebooted after the attempt started, the OS has recycled pids and that number
   * now belongs to a stranger — group-killing it (a negative-pgid signal on Unix)
   * could take down an unrelated app. Treat it as live only when it started after
   * the current boot AND the pid still exists.
   */
  private recoveredProcessIsLive(attempt: LaunchAttempt): boolean {
    if (!attempt.pid) return false
    const startedAtMs = Date.parse(attempt.startedAt)
    if (!Number.isFinite(startedAtMs)) return false
    if (startedAtMs < this.bootTime().getTime()) return false
    return this.processExists(attempt.pid)
  }

  private async resolveCanonicalProcessStartedAt(
    pid: number | undefined
  ): Promise<string | undefined> {
    if (!Number.isInteger(pid) || !pid || pid < 1) return undefined
    try {
      return canonicalProcessStartedAt(await this.resolveProcessStartedAt(pid))
    } catch {
      // The launch itself is still valid. Without a fresh canonical receipt it
      // simply cannot graduate from view-only observation to native control.
      return undefined
    }
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

// Env keys that can pre-load arbitrary native code into a child process. They
// have no legitimate use in a "run my dev server" launch delta, so they are
// dropped from discovered (repo-controlled) env before both spawn and the
// approval preview. PATH/NODE_OPTIONS are kept (legitimate) and remain visible
// in the approval modal.
const BLOCKED_LAUNCH_ENV_KEYS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH'
])

// These are host-private launch selectors, not a blanket namespace policy.
// Keep unrelated TASKWRAITH_* settings intact: launch targets may legitimately
// carry their own product configuration. MCP bridge values are deliberately a
// prefix because each one is live route/profile authority.
const PRIVATE_LAUNCH_ENV_KEYS = new Set([
  'TASKWRAITH_GEMINI_MCP_BRIDGE',
  'TASKWRAITH_INSTANCE_ID',
  'TASKWRAITH_PARENT_PROVIDER',
  'TASKWRAITH_RUN_ID',
  'TASKWRAITH_CHAT_ID',
  'TASKWRAITH_WORKSPACE_PATH',
  'TASKWRAITH_RUNTIME_PROFILE_ID'
])
const PRIVATE_LAUNCH_ENV_PREFIXES = ['TASKWRAITH_MCP_']
const CANONICAL_PROCESS_STARTED_AT_PATTERN =
  /^(?:procBSDInfo|nsRunningApplication):[1-9][0-9]{0,18}$/

function sanitizeLaunchEnv(env: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase()
    if (
      BLOCKED_LAUNCH_ENV_KEYS.has(normalizedKey) ||
      PRIVATE_LAUNCH_ENV_KEYS.has(normalizedKey) ||
      PRIVATE_LAUNCH_ENV_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix))
    ) {
      continue
    }
    sanitized[key] = value
  }
  return sanitized
}

function canonicalProcessStartedAt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return CANONICAL_PROCESS_STARTED_AT_PATTERN.test(value) ? value : undefined
}

function refusedSelfLaunch(): Extract<SelfLaunchDecision, { kind: 'refused' }> {
  return {
    kind: 'refused',
    error:
      'TaskWraith cannot launch this second-copy form of itself: packaged wrapper, shell, ' +
      'Electron, and open-based launches are hard-refused because they can crash-loop or ' +
      'reuse the primary profile. This is not a transient failure — do not retry. Only an ' +
      'exact direct TaskWraith executable launch can be approved as a new isolated profile.'
  }
}

function pathApiFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * Resolve a launch token exactly as `spawn` will resolve it: relative tokens
 * are anchored at the target cwd, then existing paths are physically
 * canonicalized to collapse symlink aliases. Lexical fallback keeps the guard
 * useful for injected/nonexistent test paths without turning a failed lookup
 * into a broad prefix match. Windows path identity is case-insensitive; macOS
 * follows the filesystem through realpath, which also respects case-sensitive
 * volumes.
 */
function canonicalLaunchPath(
  candidate: string,
  cwd: string,
  platform: NodeJS.Platform
): string | null {
  const raw = candidate.trim()
  if (!raw || raw.startsWith('-')) return null
  const pathApi = pathApiFor(platform)
  const lexical = pathApi.normalize(pathApi.isAbsolute(raw) ? raw : pathApi.resolve(cwd, raw))
  let canonical = lexical
  try {
    canonical = realpathSync.native(lexical)
  } catch {
    // The app root may be an injected path in a test or a file about to be
    // materialized by packaging. Equality still remains exact after normalize.
  }
  canonical = pathApi.normalize(canonical)
  return platform === 'win32' ? canonical.toLowerCase() : canonical
}

function ownAppBundlePath(
  ownExecutable: string | undefined,
  platform: NodeJS.Platform
): string | undefined {
  if (!ownExecutable) return undefined
  const separator = platform === 'win32' ? '\\' : '/'
  const normalized = ownExecutable.replace(/[\\/]/g, separator)
  const marker = `${separator}Contents${separator}MacOS${separator}`
  const index = normalized.lastIndexOf(marker)
  const bundle = index >= 0 ? normalized.slice(0, index) : ''
  return bundle.toLowerCase().endsWith('.app') ? bundle : undefined
}

function commandName(argument: string | undefined, platform: NodeJS.Platform): string {
  if (!argument) return ''
  return pathApiFor(platform).basename(argument).toLowerCase()
}

function isElectronCommand(argument: string | undefined, platform: NodeJS.Platform): boolean {
  const name = commandName(argument, platform)
  return name === 'electron' || name === 'electron.exe'
}

function isKnownSelfLaunchWrapper(argv: readonly string[], platform: NodeJS.Platform): boolean {
  const first = commandName(argv[0], platform)
  if (first === 'open' || first === 'open.exe' || isElectronCommand(argv[0], platform)) return true
  if (first !== 'npx' && first !== 'npx.cmd' && first !== 'npm' && first !== 'npm.cmd') return false

  const firstNonOption = argv
    .slice(1)
    .find((argument) => argument !== '--' && !argument.startsWith('-'))
  if (isElectronCommand(firstNonOption, platform)) return true
  // `npm exec electron <app-root>` has one structural subcommand before the
  // binary name. This remains an exact command-shape check, not a raw scan.
  if ((first === 'npm' || first === 'npm.cmd') && firstNonOption === 'exec') {
    const executable = argv
      .slice(argv.indexOf(firstNonOption) + 1)
      .find((argument) => argument !== '--' && !argument.startsWith('-'))
    return isElectronCommand(executable, platform)
  }
  return false
}

function shellWrapperPayload(argv: readonly string[], platform: NodeJS.Platform): string[] | null {
  const first = commandName(argv[0], platform)
  const shellCommandNames = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish'])
  const powershellCommandNames = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'])
  const commandFlag = (candidates: readonly string[]): string | undefined => {
    const index = argv.findIndex((argument, argumentIndex) => {
      return argumentIndex > 0 && candidates.includes(argument.toLowerCase())
    })
    return index >= 0 ? argv[index + 1] : undefined
  }
  if (shellCommandNames.has(first)) {
    const payload = commandFlag(['-c', '--command'])
    return payload ? tokenizeShellCommand(payload) : null
  }
  if (first === 'cmd' || first === 'cmd.exe') {
    const payload = commandFlag(['/c', '-c'])
    return payload ? tokenizeShellCommand(payload) : null
  }
  if (powershellCommandNames.has(first)) {
    const payload = commandFlag(['-command', '/command', '-c'])
    return payload ? tokenizeShellCommand(payload) : null
  }
  return null
}

/**
 * Shell-backed VS Code tasks are allowed generally, but a literal shell wrapper
 * around this app cannot safely receive the argv-only selector. Recursively
 * inspect only known shell/wrapper command positions; an own path merely
 * printed by echo remains an ordinary task.
 */
function containsExactSelfLaunchInKnownWrapper(
  argv: readonly string[],
  ownArtifactIdentities: ReadonlySet<string>,
  cwd: string,
  platform: NodeJS.Platform,
  depth = 0
): boolean {
  if (depth > 2) return false
  if (isKnownSelfLaunchWrapper(argv, platform)) {
    if (
      argv.slice(1).some((argument) => {
        const identity = canonicalLaunchPath(argument, cwd, platform)
        return Boolean(identity && ownArtifactIdentities.has(identity))
      })
    ) {
      return true
    }
  }
  const nestedArgv = shellWrapperPayload(argv, platform)
  if (!nestedArgv?.length) return false
  const firstIdentity = canonicalLaunchPath(nestedArgv[0], cwd, platform)
  if (firstIdentity && ownArtifactIdentities.has(firstIdentity)) return true
  return containsExactSelfLaunchInKnownWrapper(
    nestedArgv,
    ownArtifactIdentities,
    cwd,
    platform,
    depth + 1
  )
}

/** Tokenize only a literal shell command shape for refusal checks. */
function tokenizeShellCommand(raw: string): string[] {
  const tokens: string[] = []
  let token = ''
  let quote: 'single' | 'double' | null = null
  let escaping = false
  const push = (): void => {
    if (!token) return
    tokens.push(token)
    token = ''
  }
  for (const character of raw) {
    if (escaping) {
      token += character
      escaping = false
      continue
    }
    if (character === '\\') {
      escaping = true
      continue
    }
    if (quote === 'single') {
      if (character === "'") quote = null
      else token += character
      continue
    }
    if (quote === 'double') {
      if (character === '"') quote = null
      else token += character
      continue
    }
    if (character === "'") {
      quote = 'single'
      continue
    }
    if (character === '"') {
      quote = 'double'
      continue
    }
    if (/\s/.test(character)) {
      push()
      continue
    }
    // Shell syntax or expansion means this shallow parser cannot establish an
    // exact executable identity. Do not mistake an arbitrary substring for one.
    if ('|&;<>()$`'.includes(character)) return []
    token += character
  }
  if (quote || escaping) return []
  push()
  return tokens
}

/** Remove every caller-controlled private-profile selector before adding the one minted after approval. */
function stripCallerSuppliedPrivateLaunchArgs(argv: readonly string[]): string[] {
  const stripped: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const acceptsSeparatedValue =
      arg === PACKAGED_ISOLATED_INSTANCE_SWITCH || arg === PACKAGE_SMOKE_USER_DATA_SWITCH
    if (acceptsSeparatedValue) {
      // Supported selectors use '='. If a caller tries a separated value,
      // discard that value too so it cannot survive as a stray app argument.
      if (argv[index + 1] && !argv[index + 1].startsWith('-')) index += 1
      continue
    }
    if (
      arg === PACKAGE_SMOKE_ARG ||
      arg === MCP_BRIDGE_ENTRY_ARG ||
      arg === MCP_BRIDGE_ROUTE_FROM_ENV_ARG ||
      arg.endsWith('-gemini-mcp-bridge') ||
      arg.startsWith(PACKAGED_ISOLATED_INSTANCE_ARG) ||
      arg.startsWith(PACKAGE_SMOKE_USER_DATA_ARG)
    ) {
      continue
    }
    stripped.push(arg)
  }
  return stripped
}

function commandForApprovedDirectSelfLaunch(
  command: {
    raw: string
    argv?: string[]
    cwd: string
    env?: Record<string, string>
    longRunning: boolean
    shell?: boolean
  },
  executable: string
): typeof command {
  const argv = stripCallerSuppliedPrivateLaunchArgs(command.argv || [])
  const canonicalArgv = [executable, ...argv.slice(1)]
  return { ...command, raw: canonicalArgv.join(' '), argv: canonicalArgv }
}

function commandWithSanitizedLaunchEnv(
  command: {
    raw: string
    argv?: string[]
    cwd: string
    env?: Record<string, string>
    longRunning: boolean
    shell?: boolean
  },
  env: Record<string, string>
): typeof command {
  if (!command.env && Object.keys(env).length === 0) return command
  return { ...command, env }
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
