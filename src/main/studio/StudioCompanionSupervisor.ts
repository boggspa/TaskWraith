/**
 * StudioCompanionSupervisor — host-side process supervision for the separate
 * TaskWraith Studio companion app.
 *
 * StudioProtocol.ts is the NORMATIVE wire contract; this module never
 * re-derives framing or error codes. Inbound companion bytes flow through a
 * per-instance StudioNdjsonDecoder into handleStudioMessage against the
 * durable StudioRevisionStore, and responses (plus studio/editCommitted
 * pushes after committed edits) are encoded with encodeStudioMessage back
 * onto the companion's stdin.
 *
 * Corrected v1 supervisor contract:
 * - Reconnect hydration is COMPANION-DRIVEN: a freshly (re)spawned companion
 *   sends studio/hello then studio/getDocument. Protocol v1 has NO
 *   host-pushed snapshot message, so the supervisor never fabricates one and
 *   the host never speaks first.
 * - Open-proposal replay is EXPLICITLY UNIMPLEMENTED: durable proposal state
 *   is not modelled in protocol v1. A later slice must model and version that
 *   state before any replay semantics can exist here.
 * - Single-instance is enforced per supervisor: start() while a companion is
 *   live, restarting, or stopping is rejected with a typed error. The
 *   production integration slice must construct exactly one supervisor.
 * - Launch-command resolution (locating the packaged "TaskWraith Studio.app"
 *   binary) belongs to the packaging/integration slice; callers inject spawn.
 * - Crash policy: a nonzero exit or signal death restarts the companion with
 *   a capped sliding window; a clean exit(0) is treated as a deliberate quit
 *   and does NOT respawn. stop() ends companion stdin first (a well-behaved
 *   companion exits on stdin EOF, preventing orphans), then escalates
 *   SIGTERM -> SIGKILL after a grace period.
 */
import * as childProcess from 'node:child_process'
import {
  STUDIO_METHODS,
  StudioNdjsonDecoder,
  encodeStudioMessage,
  studioError,
  type StudioApplyEditParams,
  type StudioApplyEditResult,
  type StudioEditOp,
  type StudioMessage,
  type StudioResponseMessage,
  type StudioSuccessResponseMessage
} from './StudioProtocol'
import { buildEditCommittedNotification, handleStudioMessage } from './StudioDispatcher'
import type { StudioRevisionStore } from './StudioRevisionStore'

/**
 * Narrow structural view of a spawned companion process. node:child_process
 * ChildProcess satisfies it; tests may substitute stream-backed fakes.
 */
export interface StudioCompanionChild {
  pid?: number | undefined
  stdin: NodeJS.WritableStream | null
  stdout: NodeJS.ReadableStream | null
  stderr?: NodeJS.ReadableStream | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type StudioSupervisorState =
  | 'idle'
  | 'running'
  | 'restarting'
  | 'stopping'
  | 'stopped'
  | 'failed'

export type StudioSupervisorEvent =
  | { type: 'spawned'; pid: number | undefined }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null; stderrTail: string }
  | { type: 'spawn_error'; message: string }
  | { type: 'restart_scheduled'; delayMs: number; restartsInWindow: number }
  | { type: 'restart_cap_exceeded'; restartsInWindow: number }
  | { type: 'clean_exit' }
  | { type: 'decode_error'; code: 'parse_error' | 'line_too_long'; message: string }
  | { type: 'dispatch_failed'; message: string }
  | { type: 'write_failed'; message: string }
  | { type: 'stopped' }

export interface StudioSupervisorStatus {
  state: StudioSupervisorState
  pid: number | undefined
  restartsInWindow: number
  lastExit: { code: number | null; signal: NodeJS.Signals | null } | null
}

export class StudioSupervisorError extends Error {
  readonly code: 'already_running'

  constructor(code: 'already_running', message: string) {
    super(message)
    this.name = 'StudioSupervisorError'
    this.code = code
  }
}

export interface StudioCompanionSupervisorOptions {
  /** Launches one companion instance. Called again for each capped restart. */
  spawn: () => StudioCompanionChild
  /** Host-owned durable state the dispatcher answers from. Not owned here. */
  store: StudioRevisionStore
  /** Maximum automatic crash restarts inside restartWindowMs. Default 3. */
  maxRestarts?: number
  /** Sliding window for the restart cap, in milliseconds. Default 60000. */
  restartWindowMs?: number
  /** Delay before a crash restart, in milliseconds. Default 250. */
  restartDelayMs?: number
  /** Grace per stop() escalation step (EOF -> SIGTERM -> SIGKILL). Default 2000. */
  stopGraceMs?: number
  /** Diagnostics hook; listener errors never break supervision. */
  onEvent?: (event: StudioSupervisorEvent) => void
}

const STDERR_TAIL_LIMIT = 8 * 1024

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * After a SUCCESSFUL studio/applyEdit response, surface the committed edit so
 * the supervisor can push the protocol's studio/editCommitted notification. A
 * success response implies the dispatcher already validated the params shape.
 */
function extractCommittedEdit(
  request: unknown,
  response: StudioResponseMessage
): { revision: number; op: StudioEditOp } | null {
  if (typeof request !== 'object' || request === null) return null
  const candidate = request as { method?: unknown; params?: unknown }
  if (candidate.method !== STUDIO_METHODS.applyEdit) return null
  if (!('result' in response)) return null
  const result = (response as StudioSuccessResponseMessage).result as StudioApplyEditResult
  const params = candidate.params as StudioApplyEditParams
  return { revision: result.revision, op: params.op }
}

export class StudioCompanionSupervisor {
  private readonly store: StudioRevisionStore
  private readonly spawnFn: () => StudioCompanionChild
  private readonly maxRestarts: number
  private readonly restartWindowMs: number
  private readonly restartDelayMs: number
  private readonly stopGraceMs: number
  private readonly onEvent: ((event: StudioSupervisorEvent) => void) | undefined

  private currentState: StudioSupervisorState = 'idle'
  private child: StudioCompanionChild | null = null
  private childSettled = false
  private decoder: StudioNdjsonDecoder | null = null
  private inbound: Promise<void> = Promise.resolve()
  private restartTimestamps: number[] = []
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private stopTimers: ReturnType<typeof setTimeout>[] = []
  private stopWaiters: (() => void)[] = []
  private stderrTail = ''
  private lastExit: { code: number | null; signal: NodeJS.Signals | null } | null = null

  constructor(options: StudioCompanionSupervisorOptions) {
    this.store = options.store
    this.spawnFn = options.spawn
    this.maxRestarts = Math.max(0, options.maxRestarts ?? 3)
    this.restartWindowMs = Math.max(1, options.restartWindowMs ?? 60_000)
    this.restartDelayMs = Math.max(0, options.restartDelayMs ?? 250)
    this.stopGraceMs = Math.max(1, options.stopGraceMs ?? 2000)
    this.onEvent = options.onEvent
  }

  get state(): StudioSupervisorState {
    return this.currentState
  }

  status(): StudioSupervisorStatus {
    return {
      state: this.currentState,
      pid: this.child === null ? undefined : this.child.pid,
      restartsInWindow: this.prunedRestarts().length,
      lastExit: this.lastExit
    }
  }

  /** Launch the companion. Rejects while an instance is live (single-instance). */
  start(): void {
    if (
      this.currentState === 'running' ||
      this.currentState === 'restarting' ||
      this.currentState === 'stopping'
    ) {
      throw new StudioSupervisorError(
        'already_running',
        `companion is ${this.currentState}; stop() it before starting again`
      )
    }
    this.restartTimestamps = []
    this.lastExit = null
    this.spawnChild()
  }

  /**
   * Tear the companion down without respawn: end stdin (EOF is the polite
   * quit signal), then SIGTERM, then SIGKILL, one grace period apart.
   */
  stop(): Promise<void> {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.currentState === 'restarting') {
      this.currentState = 'stopped'
      this.emit({ type: 'stopped' })
      return Promise.resolve()
    }
    if (this.currentState !== 'running' && this.currentState !== 'stopping') {
      return Promise.resolve()
    }
    const settled = new Promise<void>((resolve) => {
      this.stopWaiters.push(resolve)
    })
    if (this.currentState === 'running') {
      this.currentState = 'stopping'
      const child = this.child
      if (child !== null) {
        try {
          child.stdin?.end()
        } catch (error) {
          this.emit({ type: 'write_failed', message: describeError(error) })
        }
        this.stopTimers.push(
          setTimeout(() => child.kill('SIGTERM'), this.stopGraceMs),
          setTimeout(() => child.kill('SIGKILL'), this.stopGraceMs * 2)
        )
      }
    }
    return settled
  }

  private spawnChild(): void {
    let child: StudioCompanionChild
    try {
      child = this.spawnFn()
    } catch (error) {
      this.emit({ type: 'spawn_error', message: describeError(error) })
      this.handleCrash()
      return
    }
    this.child = child
    this.childSettled = false
    // Fresh decoder per companion instance: partial bytes from a dead
    // companion must never leak into the next one's stream.
    this.decoder = new StudioNdjsonDecoder()
    this.stderrTail = ''
    this.currentState = 'running'
    this.emit({ type: 'spawned', pid: child.pid })

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (this.child !== child || this.decoder === null) return
      for (const event of this.decoder.push(chunk)) {
        if (event.kind === 'message') {
          this.enqueueInbound(child, event.value)
        } else {
          this.emit({ type: 'decode_error', code: event.code, message: event.message })
          const studioCode = event.code === 'parse_error' ? 'parse_error' : 'invalid_request'
          this.writeToChild(child, studioError(null, studioCode, event.message))
        }
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (this.child !== child) return
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL_LIMIT)
    })
    child.on('exit', (code, signal) => this.handleChildSettled(child, code, signal))
    child.on('error', (error: Error) => {
      this.emit({ type: 'spawn_error', message: error.message })
      this.handleChildSettled(child, null, null)
    })
  }

  private handleChildSettled(
    child: StudioCompanionChild,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (child !== this.child || this.childSettled) return
    this.childSettled = true
    this.child = null
    this.decoder = null
    this.lastExit = { code, signal }
    for (const timer of this.stopTimers) clearTimeout(timer)
    this.stopTimers = []
    this.emit({ type: 'exit', code, signal, stderrTail: this.stderrTail })

    if (this.currentState === 'stopping') {
      this.currentState = 'stopped'
      this.emit({ type: 'stopped' })
      this.releaseStopWaiters()
      return
    }
    if (code === 0 && signal === null) {
      // Deliberate companion quit (window closed / clean shutdown): the host
      // may start() again on demand, but the supervisor must not respawn.
      this.currentState = 'stopped'
      this.emit({ type: 'clean_exit' })
      this.releaseStopWaiters()
      return
    }
    this.handleCrash()
  }

  private handleCrash(): void {
    const restarts = this.prunedRestarts()
    if (restarts.length >= this.maxRestarts) {
      this.restartTimestamps = restarts
      this.currentState = 'failed'
      this.emit({ type: 'restart_cap_exceeded', restartsInWindow: restarts.length })
      this.releaseStopWaiters()
      return
    }
    restarts.push(Date.now())
    this.restartTimestamps = restarts
    this.currentState = 'restarting'
    this.emit({
      type: 'restart_scheduled',
      delayMs: this.restartDelayMs,
      restartsInWindow: restarts.length
    })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.currentState === 'restarting') this.spawnChild()
    }, this.restartDelayMs)
  }

  private prunedRestarts(): number[] {
    const cutoff = Date.now() - this.restartWindowMs
    return this.restartTimestamps.filter((at) => at > cutoff)
  }

  private releaseStopWaiters(): void {
    const waiters = this.stopWaiters
    this.stopWaiters = []
    for (const resolve of waiters) resolve()
  }

  private enqueueInbound(child: StudioCompanionChild, value: unknown): void {
    // Serialise handling so responses and editCommitted pushes leave in a
    // deterministic order relative to their requests.
    this.inbound = this.inbound.then(() => this.handleInboundMessage(child, value))
  }

  private async handleInboundMessage(child: StudioCompanionChild, value: unknown): Promise<void> {
    let response: StudioResponseMessage | null
    try {
      response = await handleStudioMessage(this.store, value)
    } catch (error) {
      // handleStudioMessage maps its own failures; this is a last-resort guard.
      this.emit({ type: 'dispatch_failed', message: describeError(error) })
      return
    }
    if (response === null) return
    this.writeToChild(child, response)
    const committed = extractCommittedEdit(value, response)
    if (committed !== null) {
      this.writeToChild(child, buildEditCommittedNotification(committed.revision, committed.op))
    }
  }

  private writeToChild(child: StudioCompanionChild, message: StudioMessage): void {
    if (this.child !== child || child.stdin === null) return
    try {
      child.stdin.write(encodeStudioMessage(message))
    } catch (error) {
      this.emit({ type: 'write_failed', message: describeError(error) })
    }
  }

  private emit(event: StudioSupervisorEvent): void {
    try {
      this.onEvent?.(event)
    } catch {
      // Diagnostics listeners must never break supervision.
    }
  }
}

/**
 * Convenience launcher for a real companion binary over piped stdio. Command
 * resolution for the packaged "TaskWraith Studio.app" executable lives in the
 * packaging/integration slice; nothing here assumes a bundle exists yet.
 */
export function spawnStudioCompanionProcess(
  command: string,
  args: readonly string[] = []
): StudioCompanionChild {
  return childProcess.spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
}
