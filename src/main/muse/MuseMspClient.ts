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
  MuseMspRpcError,
  MUSE_MSP_CLIENT_NAME,
  MUSE_MSP_SCHEMA_FINGERPRINT,
  type MuseMspApprovalChoice,
  type MuseMspApprovalMode,
  type MuseMspApprovalRequest,
  type MuseMspApprovalRequirementRef,
  type MuseMspItem,
  type MuseMspJsonRpcId,
  type MuseMspReasoningEffort,
  type MuseMspSession,
  type MuseMspTurnError,
  type MuseMspTurnInputPart,
  type MuseMspUserInputRequest
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

/**
 * Session-cumulative usage.
 *
 * `CumulativeTokenUsage` carries only prompt/output/total, while the sibling
 * `usage` member is "raw counters verbatim from the durable record" — i.e. THIS
 * completion. Mixing the two produced three monotonic session figures beside
 * two that jump around, so the per-call counters ride their own field and any
 * consumer that wants cumulative cache/reasoning totals must accumulate them.
 */
export interface MuseMspUsageSnapshot {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  /** This model call only — NOT a session total. */
  readonly lastCallCachedTokens?: number
  /** This model call only — NOT a session total. */
  readonly lastCallReasoningTokens?: number
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
  /**
   * DIAGNOSTIC ONLY. TaskWraith owns the objective: `resolveActiveGoalMode`
   * grants a provider-native goal mode to codex/claude/grok/ollama and lands
   * every other provider — Muse included — on `taskwraith_steered`, so Muse
   * receives the goal through the injected `<taskwraith_active_goal>`
   * block and mutates it through the MCP `goal_*` tools like any other steered
   * provider. Muse's own `session/goalChanged` is a SECOND, competing steering
   * source; adopting it would let the model rewrite the objective the user set
   * without ever passing the goal-control handler. Observe it, never apply it.
   */
  readonly onNativeGoalObserved?: (goal: unknown) => void
  /** Absent means DENY — see decideApproval. */
  readonly onApprovalRequest?: (
    request: MuseMspApprovalRequest
  ) => MuseMspApprovalVerdict | Promise<MuseMspApprovalVerdict>
  /**
   * Absent means the prompt is CANCELLED rather than left open — an unanswered
   * `userInput` blocks its tool call and the turn never terminates.
   */
  readonly onUserInputRequest?: (request: MuseMspUserInputRequest) => void | Promise<void>
  readonly onClose?: (
    code: number | null,
    terminal: string | null,
    /** Present only when the turn terminal was `failed`; carries the server's
     * own `retryable` judgment, which the free-text `reason` never does. */
    error: MuseMspTurnError | null
  ) => void | Promise<void>
  /**
   * Diagnostics the user must see: a denied approval with no handler, a failed
   * handshake, a dropped-event gap. These are NOT transcript content and must
   * not ride `onEvent` — `museExecEventToCompatPayload` has no `unknown` arm,
   * so a warning emitted as a normalized event returns null and is discarded by
   * the pump. A host wires this to a `provider_warning` compat line.
   */
  readonly onWarning?: (message: string) => void
  readonly onRawFrame?: (direction: 'in' | 'out', frame: unknown) => void
  readonly endProcess?: (child: AcpChildProcess) => void
  readonly endProcessGraceMs?: number
  /**
   * Rolling inactivity deadline for the whole connection, reset by every
   * inbound frame. Injectable so the suites can drive it in milliseconds.
   * Zero or negative disables it — do not do that outside a test.
   */
  readonly inactivityTimeoutMs?: number
  /** Consecutive deadline extensions granted while Muse reports compaction. */
  readonly inactivityCompactionGrace?: number
  readonly now?: () => number
  readonly randomBytes?: (size: number) => Uint8Array
}

/**
 * Default inactivity deadline.
 *
 * Chosen well clear of the renderer's 20s "likely compacting" hint and of
 * CursorContextPressureRecovery's 45s quiet window, so the watchdog can never
 * race a UI affordance that is merely describing a normal pause. It is a
 * backstop against a host that has stopped talking altogether, not a latency
 * budget. A legitimately silent in-progress tool call suspends this timer;
 * item/updated frames are not required to keep a healthy turn alive.
 */
export const MUSE_MSP_INACTIVITY_TIMEOUT_MS = 180_000

/** Deadline extensions allowed while `session/contextUsage` reports compaction. */
export const MUSE_MSP_INACTIVITY_COMPACTION_GRACE = 3

/**
 * Item kinds that represent outstanding WORK, i.e. a legitimately silent gap.
 *
 * `compaction` is deliberately absent — it has its own counted grace below, and
 * folding it in here would give it two budgets. `reminderChild` is not work.
 */
const MUSE_MSP_LONG_WORK_ITEM_KINDS = new Set(['toolCall', 'userShell', 'subagent', 'workflow'])

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
  choices: readonly MuseMspApprovalChoice[] | null | undefined,
  verdict: MuseMspApprovalVerdict
): MuseMspApprovalChoice | null {
  // The server's payload is untrusted shape. An absent or non-array
  // `availableChoices` used to throw inside a bare `void decideApproval(...)`,
  // which became an unhandled rejection: no decision, no cancel, no warning —
  // exactly the silence this lane exists to avoid.
  if (!Array.isArray(choices)) return null
  // Narrowest scope first, and `localPersistent` only as a last resort: those
  // choices carry a `rulePreview`, i.e. picking one AUTHORS a durable policy
  // rule the user never asked for. Denying persistently is safer than allowing,
  // but it is still a side effect, so it must be the final fallback rather than
  // whatever `find` happens to reach.
  const byDecision = (decision: string): MuseMspApprovalChoice | undefined => {
    const matching = choices.filter((choice) => choice.decision === decision)
    return (
      matching.find((choice) => choice.scope === 'once') ||
      matching.find((choice) => choice.scope === 'session') ||
      matching[0]
    )
  }
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
  let turnError: MuseMspTurnError | null = null
  let sawTurnCompleted = false
  // itemId -> item.kind, recorded from the item lifecycle so a DELTA can be
  // routed by the kind of the item it belongs to. Without it a reasoning delta
  // with an absent `field` (the schema default is `text`) becomes user-visible
  // assistant text AND is concatenated into the final answer.
  const itemKinds = new Map<string, string>()
  // What reasoning text we have already shown per item, so the completed
  // summary is not restated on top of the deltas that built it — the same
  // duplicate suppression MuseReasoningProjection applies on the exec lane.
  const reasoningShown = new Map<string, string>()
  const approvalRequirements = new Map<string, MuseMspApprovalRequirementRef>()
  const settledUserInputs = new Set<string>()
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null
  // Our OWN in-flight work, deliberately not the host-owned
  // `approvalRequirements` map: that map is pruned by an `approval/resolved`
  // the host may never send, so keying suspension on it would let one leaked
  // entry restore the very unbounded wait this watchdog exists to end.
  let pendingApprovalDecisions = 0
  let pendingUserInputs = 0
  let compactionQuiet = false
  let compactionExtensionsUsed = 0
  // itemIds of long-running work started but not yet terminal. Non-empty
  // SUSPENDS the inactivity watchdog: silence is expected, and a wall-clock
  // kill here is the false-positive the user rejected. Independent escape is
  // MuseMspRun's shouldCancel poll → handle.cancel().
  const openLongWorkItems = new Set<string>()

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
    try {
      options.onWarning?.(message)
    } catch {
      /* a throwing consumer must never kill the transport */
    }
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
    // The close handler drains `pending` exactly once. A call issued after that
    // drain would never settle, and `start()` issues one on the resume-failure
    // path — so a host that died mid-resume left start() suspended forever,
    // settleStartup uncalled, onClose never delivered and `closed` unresolved.
    // That is the exit-before-finish wedge, reached on the DEFAULT config.
    if (closed || stdinClosed) {
      return Promise.reject(new Error(`${method} could not be sent: the Muse host is gone`))
    }
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

  const clearInactivityWatchdog = (): void => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer)
      inactivityTimer = null
    }
  }

  /**
   * True while TaskWraith itself owes the answer.
   *
   * An approval or a `userInput` prompt sitting in front of a human is not host
   * silence, and a person can legitimately be away from the keyboard for hours.
   * These counters are bounded by OUR code — once the decision is sent they
   * drop, and the host is back on the clock.
   */
  const awaitingTaskWraith = (): boolean => pendingApprovalDecisions > 0 || pendingUserInputs > 0

  /**
   * Arm the rolling inactivity deadline.
   *
   * MSP is a persistent session host, so a turn ends when the host says so:
   * `turn/completed` -> endProcess -> child 'close' -> onClose -> `closed`. A
   * host that handshakes and then goes silent says nothing, exits never, and
   * left `await handle.closed` suspended forever — the seat simply hung. This
   * is the only bound on that wait.
   *
   * On expiry it terminates the child rather than resolving `closed` directly,
   * so the verdict still travels the ONE existing close path. Short-circuiting
   * that would strand `sendAgentCompatExit`, which must fire before the run is
   * finished or the exit is discarded and every turn wedges in the renderer.
   */
  const armInactivityWatchdog = (): void => {
    clearInactivityWatchdog()
    if (closed || terminationRequested) return
    // An in-progress tool/shell/subagent/workflow is expected silence, not a
    // wedge. The wedge this timer exists for is a silent host with NOTHING in
    // flight (MCP admission rejection, no item/started). A wall-clock kill
    // here is the same false-positive the user just rejected on AntiGravity.
    // Same shape as awaitingTaskWraith: no timer. Independent escape remains
    // MuseMspRun's shouldCancel poll → handle.cancel().
    if (openLongWorkItems.size > 0) return
    const timeoutMs = options.inactivityTimeoutMs ?? MUSE_MSP_INACTIVITY_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return
    inactivityTimer = setTimeout(() => {
      inactivityTimer = null
      if (closed || terminationRequested) return
      if (awaitingTaskWraith()) {
        armInactivityWatchdog()
        return
      }
      // Compaction is a legitimately long quiet, but it is a bounded machine
      // operation — never a licence to hang. An unbounded extension here would
      // be the same infinite wait wearing a different name, so the grace is
      // counted and spent.
      const grace = options.inactivityCompactionGrace ?? MUSE_MSP_INACTIVITY_COMPACTION_GRACE
      // Compaction is a between-steps operation. Long work already suspended
      // this timer, but keep the empty-set guard so a race cannot stack grace
      // onto an outstanding tool call.
      if (compactionQuiet && openLongWorkItems.size === 0 && compactionExtensionsUsed < grace) {
        compactionExtensionsUsed += 1
        armInactivityWatchdog()
        return
      }
      const quiet = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
      const stage = !sessionId ? ' before the handshake completed' : ''
      turnTerminal = turnTerminal ?? 'failed'
      turnError = turnError ?? {
        kind: 'hostUnresponsive',
        message: `The Muse session host stopped responding${stage}: nothing arrived for ${quiet}. TaskWraith ended the turn instead of waiting indefinitely.`,
        // NOT the server's judgment — ours, and we cannot know this is
        // transient. Claiming retryable invites an automatic re-run straight
        // back into whatever wedged the host.
        retryable: false
      }
      warn(turnError.message)
      endProcess()
    }, timeoutMs)
  }

  /** Any sign of life from the host restarts the clock and refunds the grace. */
  const noteInboundActivity = (): void => {
    compactionExtensionsUsed = 0
    armInactivityWatchdog()
  }

  const endProcess = (): void => {
    if (terminationRequested) return
    terminationRequested = true
    clearInactivityWatchdog()
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
    // Suspend the inactivity watchdog for exactly as long as TaskWraith (or the
    // human behind it) owes the answer — and NOT a moment longer. Wrapping the
    // `approval/decide` round-trip below in this window would suspend the
    // watchdog on a call the host may never answer, which is the same unbounded
    // wait the watchdog exists to end.
    pendingApprovalDecisions += 1
    try {
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
    } finally {
      pendingApprovalDecisions -= 1
      // The ball is back in the host's court, so it gets a full fresh deadline.
      noteInboundActivity()
    }
    const choice = selectMuseMspApprovalChoice(request.availableChoices, verdict)
    if (!choice) {
      warn(
        `Muse offered no usable choice for "${request.toolName}"; cancelling the turn rather than guessing.`
      )
      cancelTurn()
      return
    }
    await sendApprovalDecision(request, choice, true)
  }

  /**
   * Send one decision, retrying ONCE on a stale CAS token.
   *
   * A rejected decide is not a sent decision. `approvalRequirementStale` is the
   * expected outcome of racing `approval/updated`, and the refreshed
   * requirement is already in hand — so retry it. Anything else leaves the tool
   * call gated forever, so the turn is cancelled rather than left hanging.
   */
  const sendApprovalDecision = async (
    request: MuseMspApprovalRequest,
    choice: MuseMspApprovalChoice,
    mayRetry: boolean
  ): Promise<void> => {
    // Echo the LATEST requirement id: approval/updated can move it, and a stale
    // one is rejected `approvalRequirementStale`.
    const requirementId =
      approvalRequirements.get(request.approvalId) || request.currentRequirementId
    try {
      await call('approval/decide', {
        commandId: mintCommandId(),
        sessionId: request.sessionId,
        approvalId: request.approvalId,
        requirementId,
        choiceId: choice.choiceId
      })
    } catch (error) {
      const kind = error instanceof MuseMspRpcError ? error.kind : ''
      if (kind === 'approvalAlreadyResolved') return
      if (mayRetry && kind === 'approvalRequirementStale') {
        await sendApprovalDecision(request, choice, false)
        return
      }
      warn(
        `Muse rejected the approval decision for "${text(request.toolName)}"; cancelling the turn rather than leaving it gated. ${(error as Error).message}`
      )
      cancelTurn()
    }
  }

  /**
   * Settle one `userInput` prompt.
   *
   * `autoResolutionMs` is OPTIONAL, so when the host sends none NOTHING times
   * the prompt out: the gated tool call blocks, `turn/completed` never arrives,
   * and the turn hangs with no explanation. Cancelling is therefore the
   * fail-safe — the schema says the tool call then "resolves with a cancelled
   * result the model sees", which the model can react to. Same asymmetry as
   * approvals: silence is the worst outcome, not the safe one.
   */
  const settleUserInput = (request: MuseMspUserInputRequest): void => {
    const userInputId = text(request?.userInputId)
    if (!userInputId || settledUserInputs.has(userInputId)) return
    settledUserInputs.add(userInputId)
    const finish = (): void => {
      void call('userInput/cancel', {
        commandId: mintCommandId(),
        sessionId: text(request.sessionId) || sessionId,
        userInputId,
        reason: 'TaskWraith answers Muse prompts through its own approval surface.'
      }).catch(() => undefined)
    }
    if (!options.onUserInputRequest) {
      warn(
        `Muse asked a question for "${text(request.toolName)}" and TaskWraith has no handler attached; declining so the turn can continue.`
      )
      finish()
      return
    }
    // Same suspension as an approval: a prompt in front of a human is not a
    // silent host. Bounded by our own handler, not by anything the host sends.
    pendingUserInputs += 1
    const settle = (): void => {
      pendingUserInputs -= 1
      finish()
      noteInboundActivity()
    }
    try {
      void Promise.resolve(options.onUserInputRequest(request))
        .catch(() => undefined)
        .finally(settle)
    } catch {
      // A handler that throws SYNCHRONOUSLY never reaches the finally above,
      // which would otherwise leak the counter and suspend the watchdog for
      // the rest of the turn.
      settle()
    }
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
      // Already streamed in full by the deltas — restating it would re-render
      // the whole summary under the answer.
      if (reasoningShown.get(item.itemId) === summary) return null
      reasoningShown.set(item.itemId, summary)
      return {
        ...base,
        type: 'thinking',
        text: summary,
        thinkingId: item.itemId,
        thinkingCumulative: true,
        // Narrowed deliberately: `item` carries the model's full reasoning
        // object. Only the exposed summary belongs on the diagnostic surface,
        // matching MuseReasoningProjection's `raw` contract.
        raw: { kind: item.kind, itemId: item.itemId, text: summary }
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
        // `ItemStatus` is an OPEN enum whose known members are inProgress,
        // completed, failed, cancelled, rejected and timedOut. Terminal is
        // anything but inProgress, and the schema says an unknown value is
        // "terminal-unknown, rendered generically" — so only an explicitly
        // known-good status counts as success, and everything else, including a
        // status this build has never heard of, surfaces as an error rather
        // than being quietly presented as a completed tool call.
        const failed = item.status !== 'completed'
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
    // Open enum: the schema requires unknown kinds to render GENERICALLY —
    // "kind name plus status plus fallbackText" — rather than vanishing. Five
    // known kinds (userShell, subagent, workflow, reminderChild, compaction)
    // reach this arm too, so a subagent run or a context compaction is visible
    // instead of silently absent from the transcript.
    if (phase !== 'completed') return null
    const fallback = text(item.fallbackText)
    if (!fallback) return null
    return { ...base, type: 'unknown', text: `${String(item.kind)}: ${fallback}` }
  }

  const handleNotification = (method: string, params: Record<string, unknown>): void => {
    switch (method) {
      case 'item/delta': {
        // `field` is NOT required, and the schema says "absent means `text`".
        // Treating an absent field as non-text discarded the whole assistant
        // reply, because item/completed for an agentMessage is suppressed below
        // as a duplicate of the deltas — deltas dropped AND the authoritative
        // final object suppressed is total, silent answer loss.
        const field = params.field === undefined ? 'text' : text(params.field)
        const itemId = text(params.itemId)
        const delta = text(params.delta)
        // Route by the kind of the item this delta belongs to. `summary` is
        // unambiguously reasoning whatever the kind map says, so an unannounced
        // item still cannot leak private reasoning as assistant text; an
        // unknown item on a text field stays content, which is what keeps the
        // answer-loss fix above intact.
        const isReasoning = field === 'summary' || itemKinds.get(itemId) === 'reasoning'
        if (isReasoning) {
          if (!delta) return
          reasoningShown.set(itemId, (reasoningShown.get(itemId) || '') + delta)
          emit({
            type: 'thinking',
            payloadType: 'msp.item.delta',
            payloadKind: 'reasoning',
            sessionId,
            runId: activeTurnId,
            text: delta,
            thinkingId: itemId,
            // Incremental, not a restatement.
            thinkingCumulative: false,
            raw: { kind: 'reasoning', itemId, text: delta }
          })
          return
        }
        if (field !== 'text') return
        emit({
          type: 'content',
          payloadType: 'msp.item.delta',
          sessionId,
          runId: activeTurnId,
          text: delta,
          raw: params
        })
        return
      }
      case 'item/started':
      case 'item/updated':
      case 'item/completed': {
        const item = record(params.item) as unknown as MuseMspItem
        if (!item || !item.itemId) return
        // Record the kind before anything else: a delta for this item may
        // arrive next, and routing it correctly depends on knowing the kind.
        if (item.kind) itemKinds.set(item.itemId, String(item.kind))
        const phase =
          method === 'item/started'
            ? 'started'
            : method === 'item/updated'
              ? 'updated'
              : 'completed'
        // Suspend the watchdog while long work runs, and re-arm the idle
        // deadline the instant that work goes terminal. `ItemStatus` is an OPEN
        // enum whose only non-terminal member is `inProgress`, so any other
        // value — including one this build has never seen — resumes the idle
        // clock rather than holding the suspension open on a guess.
        const workKind = String(item.kind || itemKinds.get(item.itemId) || '')
        if (MUSE_MSP_LONG_WORK_ITEM_KINDS.has(workKind)) {
          if (phase !== 'completed' && item.status === 'inProgress') {
            openLongWorkItems.add(item.itemId)
          } else {
            openLongWorkItems.delete(item.itemId)
          }
          // The frame-level reset at the top of handleFrame ran BEFORE this
          // mutation, so it armed (or left armed) against the previous set.
          // Re-arm now: suspend if work just started, idle if it just ended.
          armInactivityWatchdog()
        }
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
        // A resumed session can carry a still-running prior turn; its terminal
        // is not ours. Same guard the unqueued arm already applies.
        const completedTurnId = text(params.turnId)
        if (completedTurnId && activeTurnId && completedTurnId !== activeTurnId) return
        sawTurnCompleted = true
        turnTerminal = text(params.terminal) || 'completed'
        // Mid-turn failures arrive HERE and never as a JSON-RPC error, and the
        // sibling `reason` is documented display-only ("never branch on it").
        // `error.retryable` is the server's own judgment and the only field a
        // retry policy may read.
        const failure = record(params.error)
        turnError =
          typeof failure.kind === 'string' && typeof failure.message === 'string'
            ? {
                kind: failure.kind,
                message: failure.message,
                retryable: failure.retryable === true
              }
            : null
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
      case 'turn/unqueued': {
        // A reclaimed submit never launches, so NO turn/started or
        // turn/completed follows for that turnId. Without this the lane waits
        // for a terminal that can never arrive and the host idles.
        if (text(params.turnId) && text(params.turnId) !== activeTurnId) return
        sawTurnCompleted = true
        turnTerminal = turnTerminal ?? 'cancelled'
        emit({
          type: 'terminal',
          payloadType: 'msp.turn.unqueued',
          sessionId,
          runId: text(params.turnId) || activeTurnId,
          terminal: 'cancelled',
          reason: 'The queued Muse turn was reclaimed before it launched.',
          raw: params
        })
        endProcess()
        return
      }
      case 'session/tokenUsage': {
        const cumulative = record(params.cumulative)
        const lastCall = record(params.usage)
        options.onUsage?.({
          inputTokens: num(cumulative.promptTokens),
          outputTokens: num(cumulative.outputTokens),
          totalTokens: num(cumulative.totalTokens),
          lastCallCachedTokens: num(lastCall.cachedTokens),
          lastCallReasoningTokens: num(lastCall.reasoningTokens)
        })
        return
      }
      case 'session/contextUsage': {
        const usedTokens = num(params.usedTokens)
        if (usedTokens === undefined) return
        const pressure = text(params.pressure)
        // `pressure` is an open string on this schema, so match the family
        // rather than pinning a closed enum this build may not have served.
        // Note the sibling `compaction` ITEM kind is a different plane; the
        // two must not be conflated.
        compactionQuiet = /compact/i.test(pressure)
        options.onContextUsage?.({
          usedTokens,
          windowTokens: num(params.windowTokens),
          pressure: pressure || undefined
        })
        return
      }
      case 'session/goalChanged': {
        // Not adopted as the TaskWraith goal — see onNativeGoalObserved.
        options.onNativeGoalObserved?.(params.goal ?? null)
        return
      }
      case 'approval/requested': {
        const request = params as unknown as MuseMspApprovalRequest
        if (!request?.approvalId) return
        approvalRequirements.set(request.approvalId, request.currentRequirementId)
        void decideApproval(request).catch(() => cancelTurn())
        return
      }
      case 'approval/resolved': {
        // Protected delivery. An approval settled by policy, by the LLM judge,
        // or by another client must prune our CAS map — otherwise the entry
        // leaks and a later decide echoes a requirement that no longer exists.
        const approvalId = text(params.approvalId)
        if (approvalId) approvalRequirements.delete(approvalId)
        return
      }
      case 'userInput/requested': {
        settleUserInput(params as unknown as MuseMspUserInputRequest)
        return
      }
      case 'userInput/settled': {
        const userInputId = text(params.userInputId)
        if (userInputId) settledUserInputs.add(userInputId)
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
    // Every decoded frame is proof of life: responses, server-to-client
    // requests and all notifications (items, turn lifecycle, usage, context,
    // approvals). Reset before dispatch so a handler that throws still counts.
    noteInboundActivity()
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
        // Keep `data.kind` as STRUCTURED data: the schema's error table marks
        // -32001 overloaded and -32031 backpressured `retryable: true`, and
        // flattening the kind into the message makes that undecidable here.
        inFlight.reject(new MuseMspRpcError(inFlight.method, frame.error))
      } else {
        inFlight.resolve(frame.result)
      }
      return
    }
    if (frame.kind === 'request') {
      // Server-to-client requests DO exist: `approval/request` and
      // `userInput/request` share their params with the notification spellings,
      // and the schema says the full payloads "arrive as re-issued
      // server-to-client requests right after a session/resume response". A
      // blanket -32601 left a resumed session's pending approval undecided and
      // hung the turn. Acknowledge, then settle through the same handlers.
      writeFrame({ jsonrpc: '2.0', id: frame.id, result: {} })
      if (frame.method === 'approval/request') {
        const request = frame.params as unknown as MuseMspApprovalRequest
        if (request?.approvalId) {
          approvalRequirements.set(request.approvalId, request.currentRequirementId)
          void decideApproval(request).catch(() => cancelTurn())
        }
        return
      }
      if (frame.method === 'userInput/request') {
        settleUserInput(frame.params as unknown as MuseMspUserInputRequest)
        return
      }
      return
    }
    handleNotification(frame.method, frame.params)
  }

  const cancelTurn = (): void => {
    if (!sessionId) {
      // Nothing to cancel yet — the handshake never reached a session.
      endProcess()
      return
    }
    // `turnId` is OPTIONAL on turn/cancel: only commandId and sessionId are
    // required. Cancelling without it still stops the session's running turn,
    // so a lost turn/start response must not cost us the cancel — that would
    // leave `muse` billing a turn nobody is watching.
    void call('turn/cancel', {
      commandId: mintCommandId(),
      sessionId,
      ...(activeTurnId ? { turnId: activeTurnId } : {})
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
  let terminalCloseDelivered = false
  child.on('close', (code: number | null) => {
    if (terminalCloseDelivered) return
    terminalCloseDelivered = true
    closed = true
    clearKillBackstop()
    clearInactivityWatchdog()
    for (const [id, inFlight] of pending) {
      pending.delete(id)
      inFlight.reject(new Error(`${inFlight.method} did not complete before the Muse host exited`))
    }
    void startupSettled
      .then(() => options.onClose?.(code, turnTerminal, turnError))
      .catch(() => undefined)
      .finally(() => settleClosed())
  })

  const start = async (): Promise<void> => {
    const initialized = record(
      await call('initialize', {
        clientInfo: { name: MUSE_MSP_CLIENT_NAME, version: options.clientVersion }
      })
    )
    // The whole authority argument for the hand-translated types is that the
    // binary echoes its stable-surface fingerprint here. Not reading it left
    // MUSE_MSP_SCHEMA_FINGERPRINT as decoration. A mismatch is a warning
    // condition per the schema, not an error — the lane still runs.
    const fingerprint = text(record(initialized.schema).fingerprint)
    if (fingerprint && fingerprint !== MUSE_MSP_SCHEMA_FINGERPRINT) {
      warn(
        `This Muse build serves MSP schema ${fingerprint}, not the ${MUSE_MSP_SCHEMA_FINGERPRINT} TaskWraith was built against; re-export the schema if this lane misbehaves.`
      )
    }
    notify('initialized')

    const resumeId = text(options.resumeSessionId).trim()
    let session: MuseMspSession | null = null
    let resumed = false
    if (resumeId) {
      try {
        const result = record(
          await call('session/resume', {
            commandId: mintCommandId(),
            sessionId: resumeId,
            // Without this the host folds and pushes the ENTIRE transcript over
            // NDJSON on every resume, which we then parse and discard. This repo
            // has a documented freeze class from exactly that shape of work.
            excludeItems: true
          })
        )
        session = record(result.session) as unknown as MuseMspSession
        resumed = true
      } catch (error) {
        // A pruned or foreign session degrades to a fresh one — the stored id
        // is a hint, not a contract. But NOT every failure means "gone":
        // `overloaded`/`backpressured` are retryable, and `sessionInUse` means
        // another host holds it. Silently starting fresh in those cases resets
        // the user's Muse history, or forks the conversation behind their back.
        const rpc = error instanceof MuseMspRpcError ? error : null
        if (rpc && (rpc.retryable || rpc.kind === 'sessionInUse')) throw error
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

  // Armed BEFORE the handshake, not after it: a host that spawns and never
  // answers `initialize` leaves start() suspended on a call that can never
  // settle, which is the same unbounded wait one stage earlier.
  armInactivityWatchdog()

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
      if (closed || stdinClosed) return false
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
