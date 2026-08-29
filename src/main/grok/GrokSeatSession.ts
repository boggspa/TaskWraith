// Spike 7 (the staged fan-out design) — persistent
// per-seat Grok ACP session. The single-turn client (GrokAcpClient) opens a
// fresh `session/new` every turn and SIGINT-kills the process at turn end, so
// an ensemble Grok seat has ZERO provider-native memory across its turns —
// the capped tagged transcript is its whole world. This module keeps one
// `grok agent stdio` process + ACP session alive per ensemble seat and sends
// each new turn as another `session/prompt` on the SAME session.
//
// PROTOCOL ASSUMPTION (live-verify before enabling the gate): grok's ACP
// implementation accepts multiple sequential `session/prompt` requests on one
// session. Standard ACP semantics say yes; grok's binary has not been
// observed doing it. Verify with one TASKWRAITH_GROK_DEBUG=1 run under
// TASKWRAITH_GROK_SEAT_SESSIONS=1 — if the second prompt errors or hangs, the
// turn fails closed (error → dispose → next turn respawns fresh), so the
// worst case is one failed turn, never a hung round.
//
// SCOPE GUARD: callers must only route seats here when NO TaskWraith MCP
// servers are advertised on the session. The bridge env bakes
// TASKWRAITH_RUN_ID into `session/new`, so a reused session would route
// broker approvals to the FIRST turn's (long-finished) run — stale approval
// routing is unacceptable. Toolless read-only seats have no bridge child, so
// nothing consumes the stale env stamp.
//
// Process spawn is INJECTED (same testability contract as GrokAcpClient).

import {
  encodeAcpFrame,
  parseAcpStreamChunk,
  acpMessageToRunEvents,
  isAcpPermissionRequest,
  parseAcpPermissionRequest,
  buildAcpPermissionResponse,
  isAcpInboundRequest,
  buildAcpMethodNotFoundResponse,
  type NormalizedGrokRunEvent,
  type AcpPermissionRequest,
  type AcpPermissionDecision
} from './GrokAcpProtocol'
import {
  GROK_DENIED_TOOL_RECOVERY_PROMPT,
  isGrokDeniedToolCancellation,
  type AcpChildProcess
} from './GrokAcpClient'
import { isTransientAcpPromptFailure } from '../acp/AcpTransientPromptFailure'

export interface GrokSeatSessionOptions {
  cwd: string
  /** Spawns `grok --no-auto-update agent stdio` (injected for testability). */
  spawnProcess: () => AcpChildProcess
  /** Raw frame tap (TASKWRAITH_GROK_DEBUG) — never affects behavior. */
  onRawFrame?: (direction: 'in' | 'out', message: unknown) => void
  /**
   * How many times a TRANSIENT `session/prompt` failure may be re-sent on this
   * live seat before the turn fails and the seat is disposed (default 2). See
   * AcpTransientPromptFailure: a provider 5xx leaves the seat's process and ACP
   * session healthy, so disposing it discards the persistence this class exists
   * to provide. Auth and quota walls still dispose immediately.
   */
  transientPromptRetryLimit?: number
  /** Backoff before each transient retry (default 1s then 3s). Tests pass 0. */
  transientPromptRetryDelayMs?: number | ((attempt: number) => number)
  /**
   * How far back stderr counts as describing the prompt failure being
   * classified (default 10_000ms). grok logs the upstream body to its tracing
   * channel ~13ms before replying with a bare JSON-RPC envelope, so without
   * this correlation the classifier sees no evidence at all.
   */
  stderrCorrelationWindowMs?: number
}

export interface GrokSeatTurnOptions {
  prompt: string
  onEvent: (event: NormalizedGrokRunEvent) => void
  onPermissionRequest?: (
    request: AcpPermissionRequest
  ) => AcpPermissionDecision | Promise<AcpPermissionDecision>
  /**
   * Fired exactly once per turn: on the terminal stopReason (process stays
   * alive — the normal persistent case), on process exit mid-turn, or on a
   * lifecycle RPC error (which also disposes the session). `processExited`
   * distinguishes "turn ended, session alive" from "session died".
   */
  onTurnEnd: (turnComplete: boolean, terminalStatus: string | undefined, processExited: boolean) => void
}

export interface GrokSeatTurnHandle {
  /** User cancel: session/cancel then kill — the seat respawns next turn. */
  cancel: () => void
}

interface ActiveTurn extends GrokSeatTurnOptions {
  promptRpcId: number
  ended: boolean
  deniedPromptRpcId?: number
  deniedToolRecoveryAttempted: boolean
  cancelRequested: boolean
  /** Text of the prompt in flight — the recovery prompt once recovery ran. */
  inFlightPrompt: string
  transientRetries: number
}

const INITIALIZE_RPC_ID = 1
const SESSION_NEW_RPC_ID = 2

function isTerminalStdinWriteError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code
  return (
    code === 'EPIPE' ||
    code === 'ECONNRESET' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ERR_STREAM_WRITE_AFTER_END'
  )
}

export class GrokSeatSession {
  private readonly child: AcpChildProcess
  private readonly options: GrokSeatSessionOptions
  private carry = ''
  private sessionId = ''
  private sessionRequested = false
  private stdinClosed = false
  private aliveFlag = true
  private nextRpcId = 3
  private activeTurn: ActiveTurn | null = null
  /** A turn accepted before session/new resolved, waiting to send its prompt. */
  private pendingPromptTurn: ActiveTurn | null = null
  /** Pending transient-retry backoffs, cleared on cancel/dispose/death. */
  private readonly transientRetryTimers = new Set<ReturnType<typeof setTimeout>>()
  /**
   * Recent stderr, kept only long enough to explain a prompt failure that
   * arrives as a bare JSON-RPC envelope. A classification hint, never a log.
   */
  private readonly recentStderr: Array<{ at: number; text: string }> = []

  constructor(options: GrokSeatSessionOptions) {
    this.options = options
    this.child = options.spawnProcess()
    this.child.stdin?.on?.('error', (err) => {
      if (isTerminalStdinWriteError(err)) {
        this.stdinClosed = true
        return
      }
      this.activeTurn?.onEvent({ type: 'provider_warning', text: err.message || String(err) })
    })
    this.child.stdout?.on('data', (chunk) => this.handleStdout(chunk.toString()))
    this.child.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim()
      if (!text) return
      this.recentStderr.push({ at: Date.now(), text })
      while (this.recentStderr.length > 32) this.recentStderr.shift()
      this.activeTurn?.onEvent({ type: 'provider_warning', text })
    })
    this.child.on('error', (err) => {
      this.activeTurn?.onEvent({ type: 'provider_warning', text: err.message || String(err) })
      this.handleProcessGone()
    })
    this.child.on('close', () => this.handleProcessGone())
    this.writeRpc(INITIALIZE_RPC_ID, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'taskwraith', version: '1.0.6' }
    })
  }

  isAlive(): boolean {
    return this.aliveFlag
  }

  isBusy(): boolean {
    return this.activeTurn !== null
  }

  dispose(): void {
    if (!this.aliveFlag) return
    this.clearTransientRetryTimers()
    this.child.kill('SIGINT')
  }

  /** The raw child, for run-manager attachment / cancellation registries. */
  process(): AcpChildProcess {
    return this.child
  }

  runTurn(turn: GrokSeatTurnOptions): GrokSeatTurnHandle {
    const active: ActiveTurn = {
      ...turn,
      promptRpcId: this.nextRpcId++,
      ended: false,
      deniedToolRecoveryAttempted: false,
      cancelRequested: false,
      inFlightPrompt: turn.prompt,
      transientRetries: 0
    }
    if (!this.aliveFlag) {
      // Callers acquire via the registry (which respawns dead sessions), so a
      // dead-session turn is a race (process died between acquire and run).
      // Fail the turn closed instead of hanging it.
      this.endTurn(active, false, 'seat-session-dead', true)
      return { cancel: () => undefined }
    }
    if (this.activeTurn || this.pendingPromptTurn) {
      // The orchestrator serializes a seat's turns; a concurrent turn is a
      // caller bug. Fail the NEW turn closed and keep the in-flight one.
      this.endTurn(active, false, 'seat-session-busy', false)
      return { cancel: () => undefined }
    }
    if (this.sessionId) {
      this.activeTurn = active
      this.sendPrompt(active)
    } else {
      // initialize / session/new still in flight — park the turn; the
      // lifecycle handler sends the prompt when the session resolves.
      this.pendingPromptTurn = active
    }
    return {
      cancel: () => {
        active.cancelRequested = true
        active.deniedPromptRpcId = undefined
        this.clearTransientRetryTimers()
        if (this.sessionId && !active.ended) {
          this.writeRpc(null, 'session/cancel', { sessionId: this.sessionId })
        }
        // Cancel drops persistence deliberately: the next turn respawns
        // fresh, matching the single-turn client's guarantees.
        this.child.kill('SIGINT')
      }
    }
  }

  private endTurn(
    turn: ActiveTurn,
    turnComplete: boolean,
    terminalStatus: string | undefined,
    processExited: boolean
  ): void {
    if (turn.ended) return
    turn.ended = true
    if (this.activeTurn === turn) this.activeTurn = null
    if (this.pendingPromptTurn === turn) this.pendingPromptTurn = null
    turn.onTurnEnd(turnComplete, terminalStatus, processExited)
  }

  private handleProcessGone(): void {
    if (!this.aliveFlag) return
    this.aliveFlag = false
    this.clearTransientRetryTimers()
    const turn = this.activeTurn || this.pendingPromptTurn
    if (turn) this.endTurn(turn, false, 'seat-session-exited', true)
  }

  private sendPrompt(turn: ActiveTurn, prompt = turn.prompt): void {
    if (turn.cancelRequested || turn.ended || !this.aliveFlag || this.stdinClosed) return
    turn.inFlightPrompt = prompt
    this.writeRpc(turn.promptRpcId, 'session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: prompt }]
    })
  }

  /**
   * Re-send the in-flight prompt on this same live seat after a transient
   * upstream failure. Returns false when the budget is spent or the seat is no
   * longer eligible, in which case the caller disposes as before.
   */
  private scheduleTransientPromptRetry(turn: ActiveTurn, failureText: string): boolean {
    if (turn.cancelRequested || turn.ended || !this.aliveFlag || this.stdinClosed) return false
    if (!this.sessionId || !turn.inFlightPrompt) return false
    const limit = this.options.transientPromptRetryLimit ?? 2
    if (turn.transientRetries >= limit) return false
    const attempt = ++turn.transientRetries
    const configuredDelay = this.options.transientPromptRetryDelayMs
    const delayMs =
      typeof configuredDelay === 'function'
        ? configuredDelay(attempt)
        : typeof configuredDelay === 'number'
          ? configuredDelay
          : attempt === 1
            ? 1000
            : 3000
    const retryText = turn.inFlightPrompt
    turn.onEvent({
      type: 'provider_warning',
      text: `Grok ACP session/prompt failed: ${failureText} — transient provider failure; retrying (${attempt}/${limit}) in ${
        Math.round(delayMs / 100) / 10
      }s.`
    })
    // The failed rpc id already got its error response; take a fresh one so a
    // late duplicate of the old response cannot terminate the retried turn.
    turn.promptRpcId = this.nextRpcId++
    turn.deniedPromptRpcId = undefined
    const timer = setTimeout(() => {
      this.transientRetryTimers.delete(timer)
      this.sendPrompt(turn, retryText)
    }, Math.max(0, delayMs))
    this.transientRetryTimers.add(timer)
    return true
  }

  /** Stderr recent enough to describe the failure being classified. */
  private stderrEvidence(): string {
    const windowMs = this.options.stderrCorrelationWindowMs ?? 10_000
    // A non-positive window disables correlation outright; 0 would otherwise
    // still admit same-millisecond stderr.
    if (windowMs <= 0) return ''
    const cutoff = Date.now() - windowMs
    return this.recentStderr
      .filter((entry) => entry.at >= cutoff)
      .map((entry) => entry.text)
      .join('\n')
      .slice(-8192)
  }

  private clearTransientRetryTimers(): void {
    for (const timer of this.transientRetryTimers) clearTimeout(timer)
    this.transientRetryTimers.clear()
  }

  private handleStdout(chunkText: string): void {
    const parsed = parseAcpStreamChunk(chunkText, this.carry)
    this.carry = parsed.carry
    for (const message of parsed.messages) {
      this.options.onRawFrame?.('in', message)
      if (isAcpPermissionRequest(message)) {
        const request = parseAcpPermissionRequest(message)
        if (request) this.answerPermissionRequest(request)
        continue
      }
      // Lifecycle / prompt RPC errors fail the current turn AND the session:
      // the seat's state is unknown after an error, so dispose and let the
      // next turn respawn fresh (mirrors the single-turn client's kill).
      const activePromptId = this.activeTurn?.promptRpcId
      if (
        message.error &&
        (message.id === INITIALIZE_RPC_ID ||
          message.id === SESSION_NEW_RPC_ID ||
          (activePromptId !== undefined && message.id === activePromptId))
      ) {
        const rpcError = message.error as { code?: unknown; message?: string; data?: unknown }
        const step =
          message.id === INITIALIZE_RPC_ID
            ? 'initialize'
            : message.id === SESSION_NEW_RPC_ID
              ? 'session/new'
              : 'session/prompt'
        const detail = typeof rpcError?.data === 'string' ? ` (${rpcError.data})` : ''
        const turn = this.activeTurn || this.pendingPromptTurn
        // A transient upstream failure says nothing about THIS seat's state:
        // the process and the ACP session are both intact, only the model call
        // behind them failed. Retry on the same session rather than throwing
        // away the persistence a seat exists to hold. Auth and quota walls are
        // excluded by the classifier and still dispose immediately.
        if (
          step === 'session/prompt' &&
          this.activeTurn &&
          isTransientAcpPromptFailure(rpcError, { evidence: this.stderrEvidence() }) &&
          this.scheduleTransientPromptRetry(
            this.activeTurn,
            rpcError?.message || 'request error'
          )
        ) {
          continue
        }
        turn?.onEvent({
          type: 'provider_warning',
          text: `Grok ACP ${step} failed: ${rpcError?.message || 'request error'}${detail}`
        })
        this.child.kill('SIGINT')
        continue
      }
      if (message.id === INITIALIZE_RPC_ID && message.result) {
        if (!this.sessionRequested) {
          this.sessionRequested = true
          // Persistent seats are TOOLLESS by contract (see scope guard above)
          // — always an empty mcpServers list.
          this.writeRpc(SESSION_NEW_RPC_ID, 'session/new', {
            cwd: this.options.cwd,
            mcpServers: []
          })
        }
        continue
      }
      if (message.id === SESSION_NEW_RPC_ID && message.result) {
        const result = message.result as { sessionId?: string }
        this.sessionId = typeof result.sessionId === 'string' ? result.sessionId : ''
        if (!this.sessionId) {
          // Review P2 — a session/new result with no usable sessionId would
          // otherwise park every future turn forever (sessionRequested is
          // already true, so nothing would ever resolve the session). Fail
          // closed: warn, kill, and let the next turn respawn fresh.
          const turn = this.activeTurn || this.pendingPromptTurn
          turn?.onEvent({
            type: 'provider_warning',
            text: 'Grok ACP session/new returned no sessionId; restarting the seat session.'
          })
          this.child.kill('SIGINT')
          continue
        }
        const parked = this.pendingPromptTurn
        if (parked) {
          this.pendingPromptTurn = null
          this.activeTurn = parked
          parked.onEvent({ type: 'init', sessionId: this.sessionId })
          this.sendPrompt(parked)
        }
        continue
      }
      if (isAcpInboundRequest(message)) {
        this.writeFrame(buildAcpMethodNotFoundResponse(message.id as number | string))
        continue
      }
      const turn = this.activeTurn
      for (const event of acpMessageToRunEvents(message)) {
        if (event.type === 'result') {
          // Only the response id for the current prompt is authoritative.
          // Grok also emits an id-less prompt_complete notification and may
          // duplicate/delay the prior response after a recovery prompt starts.
          if (!turn || message.id !== turn.promptRpcId) continue
          if (
            !turn.cancelRequested &&
            turn.deniedPromptRpcId === turn.promptRpcId &&
            !turn.deniedToolRecoveryAttempted &&
            isGrokDeniedToolCancellation(event.status)
          ) {
            turn.deniedToolRecoveryAttempted = true
            turn.deniedPromptRpcId = undefined
            turn.onEvent({
              type: 'provider_warning',
              text: 'Grok cancelled after a refused native tool; continuing with clarified routing guidance.'
            })
            turn.promptRpcId = this.nextRpcId++
            this.sendPrompt(turn, GROK_DENIED_TOOL_RECOVERY_PROMPT)
            continue
          }
          // Terminal stopReason: end the turn but KEEP the process + session
          // — this is the whole point of the persistent seat.
          this.endTurn(turn, true, event.status, false)
        } else if (turn) {
          turn.onEvent(event)
        }
      }
    }
  }

  private answerPermissionRequest(request: AcpPermissionRequest): void {
    const turn = this.activeTurn
    const permissionPromptRpcId = turn?.promptRpcId
    const handler = turn?.onPermissionRequest
    const permissionPromptIsCurrent = (): boolean =>
      Boolean(
        turn &&
          permissionPromptRpcId !== undefined &&
          this.activeTurn === turn &&
          !turn.ended &&
          !turn.cancelRequested &&
          this.aliveFlag &&
          !this.stdinClosed &&
          turn.promptRpcId === permissionPromptRpcId
      )
    const recordDeniedPrompt = (): void => {
      if (turn && permissionPromptIsCurrent()) {
        turn.deniedPromptRpcId = permissionPromptRpcId
      }
    }
    const fallbackDeny = (): void => {
      if (!permissionPromptIsCurrent()) return
      recordDeniedPrompt()
      this.writeFrame(buildAcpPermissionResponse(request.rpcId, request.options, 'deny'))
    }
    if (!handler) {
      // No active turn (or no mediator) → default DENY, never a silent allow.
      recordDeniedPrompt()
      this.writeFrame(buildAcpPermissionResponse(request.rpcId, request.options, 'deny'))
      return
    }
    let decision: AcpPermissionDecision | Promise<AcpPermissionDecision>
    try {
      decision = handler(request)
    } catch {
      fallbackDeny()
      return
    }
    Promise.resolve(decision)
      .then((resolved) => {
        // Permission mediation can resolve after Stop or after a recovery
        // prompt replaced the originating prompt. Never apply that stale
        // decision (especially an allow) to the live ACP session.
        if (!permissionPromptIsCurrent()) return
        if (resolved === 'deny') recordDeniedPrompt()
        this.writeFrame(buildAcpPermissionResponse(request.rpcId, request.options, resolved))
      })
      .catch(fallbackDeny)
  }

  private writeRpc(id: number | null, method: string, params: unknown): void {
    const message =
      id == null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }
    this.writeFrame(message)
  }

  private writeFrame(message: Record<string, unknown>): void {
    this.options.onRawFrame?.('out', message)
    const stdin = this.child.stdin
    if (
      this.stdinClosed ||
      !stdin ||
      stdin.destroyed ||
      stdin.writableEnded ||
      stdin.writableDestroyed ||
      stdin.writable === false
    ) {
      return
    }
    try {
      stdin.write(encodeAcpFrame(message), (err?: Error | null) => {
        if (err && isTerminalStdinWriteError(err)) this.stdinClosed = true
      })
    } catch (err) {
      if (isTerminalStdinWriteError(err)) this.stdinClosed = true
    }
  }
}

/** Idle seats are reaped lazily on the next acquire after this long. */
export const GROK_SEAT_SESSION_IDLE_MS = 30 * 60 * 1000

interface RegistryEntry {
  session: GrokSeatSession
  fingerprint: string
  lastUsedAt: number
}

/**
 * Seat-keyed registry. `acquire` reuses a live, idle, fingerprint-matching
 * session; anything else (dead process, changed posture/argv fingerprint,
 * busy session, idle past the TTL) is disposed and replaced with a fresh
 * spawn. The fingerprint MUST cover everything baked into the spawn or the
 * session (argv incl. deny rules, cwd, model) so a posture change can never
 * ride a stale process.
 */
export class GrokSeatSessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>()
  private readonly now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.now = now
  }

  acquire(
    key: string,
    fingerprint: string,
    factory: () => GrokSeatSessionOptions
  ): { session: GrokSeatSession; reused: boolean } {
    this.sweep()
    const existing = this.entries.get(key)
    if (
      existing &&
      existing.session.isAlive() &&
      !existing.session.isBusy() &&
      existing.fingerprint === fingerprint
    ) {
      existing.lastUsedAt = this.now()
      return { session: existing.session, reused: true }
    }
    // Review P1 (documented tradeoff): this disposes a BUSY session too. The
    // orchestrator serializes a seat's turns, so a busy entry here is either
    // a cancelled-round orphan (killing it is the cleanup we want) or a
    // same-key collision from a forged/duplicated participantId — worst case
    // one killed turn in the caller's own app, never an escalation.
    existing?.session.dispose()
    const session = new GrokSeatSession(factory())
    this.entries.set(key, { session, fingerprint, lastUsedAt: this.now() })
    return { session, reused: false }
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) entry.session.dispose()
    this.entries.clear()
  }

  /**
   * Dispose one seat's live session and drop it from the registry — the seat's
   * next turn respawns a fresh `session/new`. This is the "reset" arm of host
   * seat compaction for Grok: a persistent seat accumulates server-side context
   * that no `--resume` can shrink, so compaction summarizes the transcript and
   * then discards the live session here. No-op when the key isn't held.
   */
  disposeSeat(key: string): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    entry.session.dispose()
    this.entries.delete(key)
    return true
  }

  private sweep(): void {
    const cutoff = this.now() - GROK_SEAT_SESSION_IDLE_MS
    for (const [key, entry] of this.entries) {
      if (!entry.session.isAlive() || (entry.lastUsedAt < cutoff && !entry.session.isBusy())) {
        entry.session.dispose()
        this.entries.delete(key)
      }
    }
  }
}
