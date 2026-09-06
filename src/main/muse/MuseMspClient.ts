/**
 * One Muse turn over MSP (`muse serve`).
 *
 * The exec lane (`MuseRun.ts`) spawns a one-shot child per turn and reads a
 * run-scoped stdout projection. MSP is a persistent JSON-RPC session host, so
 * this module owns a bidirectional connection instead: handshake, session
 * start/resume, one turn, approvals answered on the wire, mid-turn steering,
 * and an idempotent terminator.
 *
 * It mirrors `acp/AcpTurnClient.ts` deliberately — same injected-spawn seam
 * (`AcpChildProcess`, so the 40-line fake child in the ACP suites is reusable
 * verbatim), same default-deny permission posture, same startup/close join
 * pair, same SIGKILL backstop. Divergences from ACP are MSP facts, not taste:
 *
 * - Every command carries a caller-minted UUIDv7 `commandId`; the server never
 *   mints one, and a fresh turn's `turnId` derives from it.
 * - The approval plane is `approval/requested` (a NOTIFICATION, not an inbound
 *   request) answered by an `approval/decide` COMMAND. Nothing wedges if we
 *   never answer, so silence is not fail-closed here — see decideApproval.
 * - Approval decisions are a select-never-create choice id taken from the
 *   request's own `availableChoices`, guarded by a `currentRequirementId` CAS
 *   token that `approval/updated` can move underneath us.
 *
 * Emits `MuseExecNormalizedEvent` so the compat mapping the exec lane already
 * uses (`museExecEventToCompatPayload`) is shared rather than duplicated.
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto'

import type { AcpChildProcess } from '../acp/AcpTurnClient'
import type { MuseExecNormalizedEvent } from './MuseExecJson'
import {
  decodeMuseMspFrames,
  encodeMuseMspFrame,
  museMspCommandId,
  MUSE_MSP_CLIENT_NAME,
  type MuseMspApprovalChoice,
  type MuseMspApprovalMode,
  type MuseMspApprovalRequest,
  type MuseMspApprovalRequirementRef,
  type MuseMspItem,
  type MuseMspJsonRpcId,
  type MuseMspReasoningEffort,
  type MuseMspSession,
  type MuseMspTurnInputPart
} from './MuseMspProtocol'

export type { AcpChildProcess as MuseMspChildProcess } from '../acp/AcpTurnClient'

export type MuseMspApprovalVerdict = 'allow' | 'deny'

export interface MuseMspSessionReadyInfo {
  readonly sessionId: string
  readonly resumed: boolean
  readonly turnCount: number
  readonly workspaceRoot: string | null
  readonly modelId: string | null
}

export interface MuseMspUsageSnapshot {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cachedTokens?: number
  readonly reasoningTokens?: number
}

/** Provider-reported context occupancy. `windowTokens` is the server's own
 * pressure basis — the authoritative window size for this exact session, which
 * no hand-kept table can be. */
export interface MuseMspContextSnapshot {
  readonly usedTokens: number
  readonly windowTokens?: number
  readonly pressure?: string
}

export interface MuseMspTurnOptions {
  /** Injected so the client never imports child_process and stays testable. */
  readonly spawnProcess: () => AcpChildProcess
  /** Non-empty; sent as `clientInfo.version`. */
  readonly clientVersion: string
  readonly workspaceRoot: string
  readonly input: readonly MuseMspTurnInputPart[]
  readonly providerId?: string
  readonly modelId?: string
  readonly reasoningEffort?: MuseMspReasoningEffort
  readonly approvalMode?: MuseMspApprovalMode
  /** Resume this stored session instead of starting a fresh one. */
  readonly resumeSessionId?: string | null
  readonly onEvent: (event: MuseExecNormalizedEvent) => void
  readonly onSessionReady?: (info: MuseMspSessionReadyInfo) => void
  readonly onUsage?: (usage: MuseMspUsageSnapshot) => void
  readonly onContextUsage?: (context: MuseMspContextSnapshot) => void
  readonly onGoalChanged?: (goal: unknown) => void
  /** Absent means DENY — see decideApproval. */
  readonly onApprovalRequest?: (
    request: MuseMspApprovalRequest
  ) => MuseMspApprovalVerdict | Promise<MuseMspApprovalVerdict>
  readonly onClose?: (code: number | null, terminal: string | null) => void | Promise<void>
  readonly onRawFrame?: (direction: 'in' | 'out', frame: unknown) => void
  readonly endProcess?: (child: AcpChildProcess) => void
  readonly endProcessGraceMs?: number
  readonly now?: () => number
  readonly randomBytes?: (size: number) => Uint8Array
}

export interface MuseMspTurnHandle {
  /** Cancel the running turn, then terminate the host. Idempotent. */
  cancel(): void
  /** Fold input into the running turn. False when no turn is in flight. */
  steer(input: readonly MuseMspTurnInputPart[]): boolean
  readonly closed: Promise<void>
}

interface PendingCall {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  method: string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Pick the choice id that expresses `verdict`, from the request's own list.
 *
 * "Select, never create": a client may only choose an option the host offered.
 * The critical property is the FAILURE direction — when no approving choice is
 * offered we must never fall through to one that approves, so an unmatched
 * allow degrades to a denial and an unmatched denial degrades to abort. This
 * mirrors `buildAcpPermissionResponse`, which cancels rather than approves when
 * option matching fails.
 */
export function selectMuseMspApprovalChoice(
  choices: readonly MuseMspApprovalChoice[],
  verdict: MuseMspApprovalVerdict
): MuseMspApprovalChoice | null {
  const byDecision = (decision: string): MuseMspApprovalChoice | undefined =>
    choices.find((choice) => choice.decision === decision && choice.scope === 'once') ||
    choices.find((choice) => choice.decision === decision)
  if (verdict === 'allow') {
    // Only the narrowest grant. `approvedForSession` and
    // `approvedPolicyAmendment` outlive the call TaskWraith actually approved,
    // so a per-call allow must never silently widen into them.
    const approved = choices.find(
      (choice) => choice.decision === 'approved' && choice.scope === 'once'
    )
    if (approved) return approved
    // Fall through to the deny path rather than reaching for a wider grant.
  }
  return byDecision('denied') || byDecision('abort') || null
}

export function runMuseMspTurn(options: MuseMspTurnOptions): MuseMspTurnHandle {
  const now = options.now ?? (() => Date.now())
  const randomBytes = options.randomBytes ?? nodeRandomBytes
  const mintCommandId = (): string => museMspCommandId(randomBytes, now())

  const child = options.spawnProcess()
  let nextRpcId = 1
  const pending = new Map<MuseMspJsonRpcId, PendingCall>()
  let carry = ''
  let stdinClosed = false
  let terminationRequested = false
  let closed = false
  let killBackstop: ReturnType<typeof setTimeout> | null = null

  let sessionId = ''
  let activeTurnId = ''
  let turnTerminal: string | null = null
  let sawTurnCompleted = false
  const approvalRequirements = new Map<string, MuseMspApprovalRequirementRef>()

  let settleClosed: () => void = () => {}
  const closedPromise = new Promise<void>((resolve) => {
    settleClosed = resolve
  })
  let settleStartup: () => void = () => {}
  const startupSettled = new Promise<void>((resolve) => {
    settleStartup = resolve
  })

  const emit = (event: MuseExecNormalizedEvent): void => {
    try {
      options.onEvent(event)
    } catch {
      /* a throwing consumer must never kill the transport */
    }
  }

  const warn = (message: string): void => {
    emit({ type: 'unknown', payloadType: 'taskwraith.warning', text: message, raw: { message } })
  }

  const writeFrame = (frame: Record<string, unknown>): void => {
    if (stdinClosed || !child.stdin) return
    const stdin = child.stdin
    if (stdin.destroyed || stdin.writableEnded || stdin.writableDestroyed) {
      stdinClosed = true
      return
    }
    try {
      options.onRawFrame?.('out', frame)
    } catch {
      /* diagnostics only */
    }
    try {
      stdin.write(encodeMuseMspFrame(frame as never), (error) => {
        if (error) stdinClosed = true
      })
    } catch {
      stdinClosed = true
    }
  }

  const call = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    const id = nextRpcId++
    const settled = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject, method })
    })
    writeFrame({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
    return settled
  }

  const notify = (method: string, params?: Record<string, unknown>): void => {
    writeFrame({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
  }

  const clearKillBackstop = (): void => {
    if (killBackstop) {
      clearTimeout(killBackstop)
      killBackstop = null
    }
  }

  const endProcess = (): void => {
    if (terminationRequested) return
    terminationRequested = true
    try {
      if (options.endProcess) options.endProcess(child)
      else child.kill('SIGTERM')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    if (closed) return
    killBackstop = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, options.endProcessGraceMs ?? 4000)
  }

  /**
   * Answer one approval.
   *
   * MSP's approval plane is notification+command, not an inbound request, so an
   * unanswered approval does not fault the channel — it just stalls the turn
   * until the host times it out. That makes silence the WORST outcome, not the
   * safe one, which is why every failure path below still sends a decision, and
   * every one of them denies.
   */
  const decideApproval = async (request: MuseMspApprovalRequest): Promise<void> => {
    let verdict: MuseMspApprovalVerdict = 'deny'
    if (!options.onApprovalRequest) {
      warn(
        `Muse asked to run "${request.toolName}" but no TaskWraith approval handler is attached; denying.`
      )
    } else {
      try {
        verdict = (await options.onApprovalRequest(request)) === 'allow' ? 'allow' : 'deny'
      } catch {
        verdict = 'deny'
      }
    }
    const choice = selectMuseMspApprovalChoice(request.availableChoices, verdict)
    if (!choice) {
      warn(
        `Muse offered no usable choice for "${request.toolName}"; cancelling the turn rather than guessing.`
      )
      cancelTurn()
      return
    }
    // Echo the LATEST requirement id: approval/updated can move it, and a stale
    // one is rejected `approvalRequirementStale`.
    const requirementId =
      approvalRequirements.get(request.approvalId) || request.currentRequirementId
    void call('approval/decide', {
      commandId: mintCommandId(),
      sessionId: request.sessionId,
      approvalId: request.approvalId,
      requirementId,
      choiceId: choice.choiceId
    }).catch((error: Error) => {
      warn(`Muse rejected the approval decision for "${request.toolName}": ${error.message}`)
    })
  }

  const itemToEvent = (
    item: MuseMspItem,
    phase: 'started' | 'updated' | 'completed'
  ): MuseExecNormalizedEvent | null => {
    const base = {
      payloadType: `msp.item.${phase}`,
      payloadKind: String(item.kind),
      sessionId,
      runId: text(item.turnId) || activeTurnId,
      raw: item
    }
    if (item.kind === 'agentMessage') {
      if (phase !== 'completed') return null
      return { ...base, type: 'content', text: text(item.text) }
    }
    if (item.kind === 'reasoning') {
      if (phase !== 'completed') return null
      const summary = Array.isArray(item.summary)
        ? item.summary
            .map((part) => text(part))
            .filter(Boolean)
            .join('\n')
        : ''
      if (!summary) return null
      return {
        ...base,
        type: 'thinking',
        text: summary,
        thinkingId: item.itemId,
        thinkingCumulative: true
      }
    }
    if (item.kind === 'toolCall') {
      let toolInput: Record<string, unknown> | undefined
      if (typeof item.args === 'string' && item.args.trim()) {
        try {
          toolInput = record(JSON.parse(item.args))
        } catch {
          toolInput = { raw: item.args }
        }
      }
      if (phase === 'started') {
        return {
          ...base,
          type: 'tool_use',
          toolId: text(item.callId) || item.itemId,
          toolName: text(item.tool),
          ...(toolInput ? { toolInput } : {})
        }
      }
      if (phase === 'completed') {
        const failed = item.status !== 'completed' && item.status !== 'succeeded'
        return {
          ...base,
          type: 'tool_result',
          toolId: text(item.callId) || item.itemId,
          toolName: text(item.tool),
          toolOutput: text(item.visibleOutput) || text(item.failureReason),
          toolStatus: failed ? 'error' : 'success'
        }
      }
      return null
    }
    return null
  }

  const handleNotification = (method: string, params: Record<string, unknown>): void => {
    switch (method) {
      case 'item/delta': {
        // Only agentMessage text streams as user-visible content; a reasoning
        // delta is projected on completion so partial summaries never render as
        // the answer.
        if (text(params.field) !== 'text') return
        emit({
          type: 'content',
          payloadType: 'msp.item.delta',
          sessionId,
          runId: activeTurnId,
          text: text(params.delta),
          raw: params
        })
        return
      }
      case 'item/started':
      case 'item/updated':
      case 'item/completed': {
        const item = record(params.item) as unknown as MuseMspItem
        if (!item || !item.itemId) return
        const phase =
          method === 'item/started'
            ? 'started'
            : method === 'item/updated'
              ? 'updated'
              : 'completed'
        // A completed agentMessage repeats text already streamed as deltas.
        if (phase === 'completed' && item.kind === 'agentMessage') return
        const event = itemToEvent(item, phase)
        if (event) emit(event)
        return
      }
      case 'turn/started': {
        activeTurnId = text(params.turnId) || activeTurnId
        emit({
          type: 'run_started',
          payloadType: 'msp.turn.started',
          sessionId,
          runId: activeTurnId,
          raw: params
        })
        return
      }
      case 'turn/completed': {
        sawTurnCompleted = true
        turnTerminal = text(params.terminal) || 'completed'
        emit({
          type: 'terminal',
          payloadType: 'msp.turn.completed',
          sessionId,
          runId: text(params.turnId) || activeTurnId,
          terminal: turnTerminal,
          reason: text(params.reason) || undefined,
          raw: params
        })
        // The turn is the unit of work for this lane; the host process exists
        // only to serve it. Terminate after the terminal rather than idling a
        // connection whose sandbox posture is already fixed.
        endProcess()
        return
      }
      case 'session/tokenUsage': {
        const cumulative = record(params.cumulative)
        options.onUsage?.({
          inputTokens: num(cumulative.promptTokens) ?? num(params.promptTokens),
          outputTokens: num(cumulative.outputTokens),
          totalTokens: num(cumulative.totalTokens) ?? num(params.totalTokens),
          cachedTokens: num(record(params.usage).cachedTokens),
          reasoningTokens: num(record(params.usage).reasoningTokens)
        })
        return
      }
      case 'session/contextUsage': {
        const usedTokens = num(params.usedTokens)
        if (usedTokens === undefined) return
        options.onContextUsage?.({
          usedTokens,
          windowTokens: num(params.windowTokens),
          pressure: text(params.pressure) || undefined
        })
        return
      }
      case 'session/goalChanged': {
        options.onGoalChanged?.(params.goal ?? null)
        return
      }
      case 'approval/requested': {
        const request = params as unknown as MuseMspApprovalRequest
        if (!request?.approvalId) return
        approvalRequirements.set(request.approvalId, request.currentRequirementId)
        void decideApproval(request)
        return
      }
      case 'approval/updated': {
        const approvalId = text(params.approvalId)
        const requirementId = record(params.currentRequirementId)
        if (approvalId && requirementId.approvalId) {
          approvalRequirements.set(
            approvalId,
            requirementId as unknown as MuseMspApprovalRequirementRef
          )
        }
        return
      }
      case 'view/gap': {
        warn('Muse dropped pushed session events for this turn; the transcript may be incomplete.')
        return
      }
      default:
        return
    }
  }

  const handleFrame = (frame: ReturnType<typeof decodeMuseMspFrames>['frames'][number]): void => {
    if (frame.kind === 'unparsable') return
    try {
      options.onRawFrame?.('in', frame)
    } catch {
      /* diagnostics only */
    }
    if (frame.kind === 'response') {
      const inFlight = pending.get(frame.id)
      if (!inFlight) return
      pending.delete(frame.id)
      if (frame.error) {
        const kind = frame.error.data?.kind ? ` (${frame.error.data.kind})` : ''
        inFlight.reject(new Error(`${inFlight.method} failed${kind}: ${frame.error.message}`))
      } else {
        inFlight.resolve(frame.result)
      }
      return
    }
    if (frame.kind === 'request') {
      // MSP v1 has no server-to-client requests, but an unanswered id would
      // wedge the peer, so answer unknown methods rather than ignoring them.
      writeFrame({
        jsonrpc: '2.0',
        id: frame.id,
        error: { code: -32601, message: `unsupported method ${frame.method}` }
      })
      return
    }
    handleNotification(frame.method, frame.params)
  }

  const cancelTurn = (): void => {
    if (!sessionId || !activeTurnId) {
      endProcess()
      return
    }
    void call('turn/cancel', {
      commandId: mintCommandId(),
      sessionId,
      turnId: activeTurnId
    }).catch(() => undefined)
    endProcess()
  }

  child.stdout?.on('data', (chunk) => {
    const decoded = decodeMuseMspFrames(carry + chunk.toString())
    carry = decoded.rest
    for (const frame of decoded.frames) handleFrame(frame)
  })
  child.stderr?.on('data', () => {
    /* muse writes its banner to stderr; nothing here is user-facing */
  })
  child.on('error', (error: Error) => {
    warn(`Muse session host failed: ${error.message}`)
    endProcess()
  })
  child.on('close', (code: number | null) => {
    closed = true
    clearKillBackstop()
    for (const [id, inFlight] of pending) {
      pending.delete(id)
      inFlight.reject(new Error(`${inFlight.method} did not complete before the Muse host exited`))
    }
    void startupSettled
      .then(() => options.onClose?.(code, turnTerminal))
      .catch(() => undefined)
      .finally(() => settleClosed())
  })

  const start = async (): Promise<void> => {
    await call('initialize', {
      clientInfo: { name: MUSE_MSP_CLIENT_NAME, version: options.clientVersion }
    })
    notify('initialized')

    const resumeId = text(options.resumeSessionId).trim()
    let session: MuseMspSession | null = null
    let resumed = false
    if (resumeId) {
      try {
        const result = record(
          await call('session/resume', {
            commandId: mintCommandId(),
            sessionId: resumeId
          })
        )
        session = record(result.session) as unknown as MuseMspSession
        resumed = true
      } catch (error) {
        // A pruned or foreign session must degrade to a fresh one, never fault
        // the turn: the stored id is a hint, not a contract.
        warn(
          `Muse could not resume the stored session; starting a fresh one. ${(error as Error).message}`
        )
      }
    }
    if (!session) {
      const result = record(
        await call('session/start', {
          commandId: mintCommandId(),
          workspaceRoot: options.workspaceRoot,
          ...(options.providerId ? { providerId: options.providerId } : {}),
          ...(options.modelId ? { modelId: options.modelId } : {}),
          ...(options.approvalMode ? { approvalMode: options.approvalMode } : {})
        })
      )
      session = record(result.session) as unknown as MuseMspSession
    }
    sessionId = text(session?.sessionId)
    if (!sessionId) throw new Error('Muse did not return a session id')

    options.onSessionReady?.({
      sessionId,
      resumed,
      turnCount: num(session?.turnCount) ?? 0,
      workspaceRoot: session?.workspaceRoot ?? null,
      modelId: session?.modelId ?? null
    })
    emit({
      type: 'session_linked',
      payloadType: 'msp.session.linked',
      sessionId,
      raw: { sessionId, resumed }
    })

    const turn = record(
      await call('turn/start', {
        commandId: mintCommandId(),
        sessionId,
        input: options.input,
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {})
      })
    )
    activeTurnId = text(turn.turnId) || activeTurnId
  }

  void start()
    .catch((error: Error) => {
      warn(error.message)
      turnTerminal = turnTerminal ?? 'failed'
      endProcess()
    })
    .finally(() => settleStartup())

  return {
    cancel: () => {
      turnTerminal = turnTerminal ?? 'cancelled'
      cancelTurn()
    },
    steer: (input) => {
      if (!sessionId || !activeTurnId || sawTurnCompleted || input.length === 0) return false
      void call('turn/steer', {
        commandId: mintCommandId(),
        sessionId,
        // The race guard: MSP rejects `invalid_target` if this turn already
        // finished, which is exactly the outcome we want over injecting into a
        // turn the user was not looking at.
        expectedTurnId: activeTurnId,
        input
      }).catch((error: Error) => {
        warn(`Muse declined the mid-turn steer: ${error.message}`)
      })
      return true
    },
    closed: closedPromise
  }
}
