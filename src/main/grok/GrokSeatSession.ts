// Spike 7 (docs/ensemble-posture-fanout-preamble-design.md) — persistent
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
import type { AcpChildProcess } from './GrokAcpClient'

export interface GrokSeatSessionOptions {
  cwd: string
  /** Spawns `grok --no-auto-update agent stdio` (injected for testability). */
  spawnProcess: () => AcpChildProcess
  /** Raw frame tap (TASKWRAITH_GROK_DEBUG) — never affects behavior. */
  onRawFrame?: (direction: 'in' | 'out', message: unknown) => void
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
      if (text) this.activeTurn?.onEvent({ type: 'provider_warning', text })
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
    this.child.kill('SIGINT')
  }

  /** The raw child, for run-manager attachment / cancellation registries. */
  process(): AcpChildProcess {
    return this.child
  }

  runTurn(turn: GrokSeatTurnOptions): GrokSeatTurnHandle {
    const active: ActiveTurn = { ...turn, promptRpcId: this.nextRpcId++, ended: false }
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
    const turn = this.activeTurn || this.pendingPromptTurn
    if (turn) this.endTurn(turn, false, 'seat-session-exited', true)
  }

  private sendPrompt(turn: ActiveTurn): void {
    this.writeRpc(turn.promptRpcId, 'session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: turn.prompt }]
    })
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
        const rpcError = message.error as { message?: string; data?: unknown }
        const step =
          message.id === INITIALIZE_RPC_ID
            ? 'initialize'
            : message.id === SESSION_NEW_RPC_ID
              ? 'session/new'
              : 'session/prompt'
        const detail = typeof rpcError?.data === 'string' ? ` (${rpcError.data})` : ''
        const turn = this.activeTurn || this.pendingPromptTurn
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
          // Terminal stopReason: end the turn but KEEP the process + session
          // — this is the whole point of the persistent seat.
          if (turn) this.endTurn(turn, true, event.status, false)
        } else if (turn) {
          turn.onEvent(event)
        }
      }
    }
  }

  private answerPermissionRequest(request: AcpPermissionRequest): void {
    const handler = this.activeTurn?.onPermissionRequest
    const fallbackDeny = (): void =>
      this.writeFrame(buildAcpPermissionResponse(request.rpcId, request.options, 'deny'))
    if (!handler) {
      // No active turn (or no mediator) → default DENY, never a silent allow.
      fallbackDeny()
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
      .then((resolved) =>
        this.writeFrame(buildAcpPermissionResponse(request.rpcId, request.options, resolved))
      )
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
    existing?.session.dispose()
    const session = new GrokSeatSession(factory())
    this.entries.set(key, { session, fingerprint, lastUsedAt: this.now() })
    return { session, reused: false }
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) entry.session.dispose()
    this.entries.clear()
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
