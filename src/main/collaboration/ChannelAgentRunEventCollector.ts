import { CHANNEL_AGENT_MAX_POST_BYTES } from '../../shared/collaboration/ChannelAgentProtocol'
import { foldBridgeRunText, isTaggedCumulativeRestatement } from '../bridge/BridgeTextFold'
import type { RunEvent, RunEventSink } from '../RunEventBus'
import type { RunSessionChangeEvent, TerminalRunSessionStatus } from '../RunManager'
import type { RunAdapterInvocationReceipt } from '../run/AgentRunTypes'
import { PROVIDER_RUN_MANAGEMENT_IDS } from '../run/ProviderRunManagementMatrix'
import type { ProviderId } from '../store/types'

const MAX_IDENTIFIER_LENGTH = 512
const MAX_TRACKED_RUNS = 64

const ROUTING_FAILURE = 'The Channel agent run failed its exact routing checks.'
const OUTPUT_LIMIT_FAILURE =
  'The Channel agent reply exceeded the signed post limit and was not published.'
const SIGNAL_CONFLICT_FAILURE =
  'The Channel agent run ended with conflicting terminal signals and no reply was published.'
const EMPTY_REPLY_FAILURE = 'The Channel agent run completed without a publishable reply.'
const RUN_FAILURE = 'The Channel agent run failed before a complete reply was available.'
const RUN_CANCELLED = 'The Channel agent run was cancelled before a complete reply was available.'

const PROVIDERS: ReadonlySet<string> = new Set(PROVIDER_RUN_MANAGEMENT_IDS)

export type ChannelAgentRunEventCollectorErrorCode =
  | 'capacity_exceeded'
  | 'duplicate_run'
  | 'invalid_binding'
  | 'launch_mismatch'
  | 'run_unavailable'

export class ChannelAgentRunEventCollectorError extends Error {
  constructor(
    readonly code: ChannelAgentRunEventCollectorErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentRunEventCollectorError'
  }
}

export interface ChannelAgentRunCollectionBinding {
  readonly runId: string
  readonly chatId: string
  readonly provider: ProviderId
  readonly workspacePath: string | null
  readonly launchIntentAt: number
  readonly maxPostBytes: number
}

export interface ChannelAgentRunTerminalEvidence {
  readonly status: 'succeeded' | 'failed' | 'cancelled'
  readonly exitCode: number | null
  readonly content: string
  readonly observedAt: number
}

export interface ChannelAgentRunCollectionHandle {
  readonly terminal: Promise<ChannelAgentRunTerminalEvidence>
  /** Stop tracking a preflight-declined or otherwise main-abandoned run. */
  stop(): boolean
}

export interface ChannelAgentRunEventCollectorOptions {
  readonly now?: () => number
}

interface TrackedRun {
  readonly binding: ChannelAgentRunCollectionBinding
  readonly terminal: Promise<ChannelAgentRunTerminalEvidence>
  readonly resolve: (terminal: ChannelAgentRunTerminalEvidence) => void
  content: string
  overflowed: boolean
  poisoned: boolean
  launchConfirmedAt: number | null
  lifecycleStatus: TerminalRunSessionStatus | null
  lifecycleObservedAt: number | null
  providerStatus: TerminalRunSessionStatus | null
  providerObservedAt: number | null
  exitCode: number | null
}

function collectorError(
  code: ChannelAgentRunEventCollectorErrorCode,
  message: string
): ChannelAgentRunEventCollectorError {
  return new ChannelAgentRunEventCollectorError(code, message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isIdentifier(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDERS.has(value)
}

function normalizedWorkspacePath(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function resultStatus(payload: Record<string, unknown>): TerminalRunSessionStatus | null {
  const raw = typeof payload.status === 'string' ? payload.status : payload.subtype
  const status = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  if (status === 'cancelled' || status === 'canceled') return 'cancelled'
  if (status === 'running') return null
  const failed =
    payload.is_error === true ||
    (typeof payload.error === 'string' && payload.error.trim().length > 0)
  if (
    status === '' ||
    status === 'success' ||
    status === 'successwithwarnings' ||
    status === 'completed' ||
    status === 'complete' ||
    status === 'endturn' ||
    status === 'stop'
  ) {
    return failed ? 'failed' : 'completed'
  }
  return 'failed'
}

function exitStatus(code: number | null): TerminalRunSessionStatus {
  if (code === 0) return 'completed'
  if (code === 130 || code === 143) return 'cancelled'
  return 'failed'
}

function terminalCopy(
  state: TrackedRun
): Pick<ChannelAgentRunTerminalEvidence, 'status' | 'content'> {
  if (state.poisoned) return { status: 'failed', content: ROUTING_FAILURE }
  if (state.overflowed) return { status: 'failed', content: OUTPUT_LIMIT_FAILURE }
  if (state.lifecycleStatus !== state.providerStatus) {
    return { status: 'failed', content: SIGNAL_CONFLICT_FAILURE }
  }
  if (state.lifecycleStatus === 'cancelled') {
    return { status: 'cancelled', content: RUN_CANCELLED }
  }
  if (state.lifecycleStatus === 'failed') {
    return { status: 'failed', content: RUN_FAILURE }
  }
  const content = state.content.trim()
  return content
    ? { status: 'succeeded', content }
    : { status: 'failed', content: EMPTY_REPLY_FAILURE }
}

/**
 * Main-only terminal collector for Channel-agent runs. Provider output and
 * RunManager lifecycle are independent signals: a reply becomes usable only
 * after both agree and the exact adapter invocation has been confirmed.
 */
export class ChannelAgentRunEventCollector implements RunEventSink {
  readonly id = 'channel-agent-run-terminal'

  private readonly tracked = new Map<string, TrackedRun>()
  private readonly now: () => number

  constructor(options: ChannelAgentRunEventCollectorOptions = {}) {
    this.now = options.now ?? Date.now
  }

  track(binding: ChannelAgentRunCollectionBinding): ChannelAgentRunCollectionHandle {
    this.assertBinding(binding)
    if (this.tracked.has(binding.runId)) {
      throw collectorError('duplicate_run', 'Channel agent run is already being tracked')
    }
    if (this.tracked.size >= MAX_TRACKED_RUNS) {
      throw collectorError('capacity_exceeded', 'Channel agent run collector is at capacity')
    }
    let resolve!: (terminal: ChannelAgentRunTerminalEvidence) => void
    const terminal = new Promise<ChannelAgentRunTerminalEvidence>((accept) => {
      resolve = accept
    })
    const state: TrackedRun = {
      binding: { ...binding },
      terminal,
      resolve,
      content: '',
      overflowed: false,
      poisoned: false,
      launchConfirmedAt: null,
      lifecycleStatus: null,
      lifecycleObservedAt: null,
      providerStatus: null,
      providerObservedAt: null,
      exitCode: null
    }
    this.tracked.set(binding.runId, state)
    return Object.freeze({
      terminal,
      stop: () => {
        if (this.tracked.get(binding.runId) !== state) return false
        this.tracked.delete(binding.runId)
        return true
      }
    })
  }

  confirmAdapterInvocation(receipt: RunAdapterInvocationReceipt, confirmedAt: number): void {
    const runId = isIdentifier(receipt?.appRunId) ? receipt.appRunId : ''
    const state = this.tracked.get(runId)
    if (!state) {
      throw collectorError('run_unavailable', 'Channel agent run is not tracked')
    }
    if (
      !isTimestamp(confirmedAt) ||
      confirmedAt < state.binding.launchIntentAt ||
      state.launchConfirmedAt !== null ||
      receipt.provider !== state.binding.provider ||
      normalizedWorkspacePath(receipt.effectiveWorkspacePath) !== state.binding.workspacePath
    ) {
      throw collectorError(
        'launch_mismatch',
        'Channel agent adapter invocation changed after launch intent'
      )
    }
    state.launchConfirmedAt = confirmedAt
    this.trySettle(state)
  }

  handle(event: RunEvent): void {
    if (
      event.channel !== 'agent-output' &&
      event.channel !== 'agent-error' &&
      event.channel !== 'agent-exit'
    ) {
      return
    }
    if (!isPlainObject(event.payload)) return
    const runId = event.payload.appRunId
    if (!isIdentifier(runId)) return
    const state = this.tracked.get(runId)
    if (!state) return
    const observedAt = this.observedAt(state)
    if (
      event.provider !== state.binding.provider ||
      event.payload.provider !== state.binding.provider ||
      event.payload.appChatId !== state.binding.chatId
    ) {
      this.poison(state, observedAt)
      return
    }
    try {
      if (event.channel === 'agent-output') {
        this.ingestOutput(state, event.payload, observedAt)
      } else if (event.channel === 'agent-exit') {
        const rawCode = event.payload.code
        const code = typeof rawCode === 'number' && Number.isSafeInteger(rawCode) ? rawCode : null
        state.exitCode = code
        this.recordProviderTerminal(state, exitStatus(code), observedAt)
      }
    } catch {
      this.poison(state, observedAt)
    }
  }

  handleRunSessionChange(event: RunSessionChangeEvent): void {
    const runId = event?.session?.runId
    if (!isIdentifier(runId)) return
    const state = this.tracked.get(runId)
    if (!state) return
    const observedAt = this.observedAt(state)
    if (
      event.session.provider !== state.binding.provider ||
      event.session.appChatId !== state.binding.chatId ||
      normalizedWorkspacePath(event.session.workspacePath) !== state.binding.workspacePath
    ) {
      this.poison(state, observedAt)
      return
    }
    if (event.type === 'removed' && !this.isTerminalStatus(event.session.status)) {
      state.poisoned = true
      state.lifecycleStatus = 'failed'
      state.lifecycleObservedAt = observedAt
      this.recordProviderTerminal(state, 'failed', observedAt)
      return
    }
    if (!this.isTerminalStatus(event.session.status)) return
    if (state.lifecycleStatus && state.lifecycleStatus !== event.session.status) {
      state.poisoned = true
    } else {
      state.lifecycleStatus = event.session.status
    }
    state.lifecycleObservedAt = Math.max(state.lifecycleObservedAt ?? 0, observedAt)
    this.trySettle(state)
  }

  pendingCount(): number {
    return this.tracked.size
  }

  private assertBinding(binding: ChannelAgentRunCollectionBinding): void {
    if (
      !binding ||
      !isIdentifier(binding.runId) ||
      !isIdentifier(binding.chatId) ||
      !isProvider(binding.provider) ||
      !isTimestamp(binding.launchIntentAt) ||
      binding.maxPostBytes !== CHANNEL_AGENT_MAX_POST_BYTES ||
      (binding.workspacePath !== null &&
        (typeof binding.workspacePath !== 'string' ||
          binding.workspacePath.length === 0 ||
          binding.workspacePath.trim() !== binding.workspacePath))
    ) {
      throw collectorError('invalid_binding', 'Channel agent run binding is invalid')
    }
  }

  private ingestOutput(
    state: TrackedRun,
    outer: Record<string, unknown>,
    observedAt: number
  ): void {
    const compatLine = outer.compatLine === true
    const data = outer.data
    let payload: Record<string, unknown>
    if (isPlainObject(data)) {
      payload = data
    } else if (typeof data === 'string') {
      const trimmed = data.trim()
      if (!trimmed) return
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (!isPlainObject(parsed)) throw new Error('not an object')
        payload = parsed
      } catch {
        if (compatLine) throw new Error('invalid compat line')
        this.appendFoldedText(state, data)
        return
      }
    } else if (typeof outer.type === 'string') {
      payload = outer
    } else {
      return
    }
    if (
      payload.appRunId !== state.binding.runId ||
      payload.appChatId !== state.binding.chatId ||
      payload.provider !== state.binding.provider
    ) {
      this.poison(state, observedAt)
      return
    }
    if (payload.type === 'content' || payload.type === 'token') {
      if (state.providerStatus !== null) {
        this.poison(state, observedAt)
        return
      }
      const text =
        typeof payload.text === 'string'
          ? payload.text
          : typeof payload.content === 'string'
            ? payload.content
            : ''
      if (text) this.ingestText(state, text, payload, compatLine)
      return
    }
    if (payload.type === 'result') {
      const status = resultStatus(payload)
      if (status) this.recordProviderTerminal(state, status, observedAt)
    }
  }

  private ingestText(
    state: TrackedRun,
    text: string,
    payload: Record<string, unknown>,
    trustedCompatLine: boolean
  ): void {
    if (state.overflowed || state.poisoned) return
    if (payload.cumulative === true && state.content.trim().length > 0) {
      const fold = foldBridgeRunText(state.content, text)
      if (fold.kind === 'tail') this.replaceText(state, text)
      return
    }
    if (trustedCompatLine && !isTaggedCumulativeRestatement(payload)) {
      this.appendText(state, text)
      return
    }
    this.appendFoldedText(state, text)
  }

  private appendFoldedText(state: TrackedRun, text: string): void {
    const fold = foldBridgeRunText(state.content, text)
    if (fold.kind === 'skip') return
    if (fold.kind === 'tail') {
      this.replaceText(state, text)
      return
    }
    this.appendText(state, text)
  }

  private appendText(state: TrackedRun, text: string): void {
    this.replaceText(state, state.content + text)
  }

  private replaceText(state: TrackedRun, content: string): void {
    if (Buffer.byteLength(content, 'utf8') > state.binding.maxPostBytes) {
      state.content = ''
      state.overflowed = true
      return
    }
    state.content = content
  }

  private recordProviderTerminal(
    state: TrackedRun,
    status: TerminalRunSessionStatus,
    observedAt: number
  ): void {
    if (state.providerStatus && state.providerStatus !== status) state.poisoned = true
    else state.providerStatus = status
    state.providerObservedAt = Math.max(state.providerObservedAt ?? 0, observedAt)
    this.trySettle(state)
  }

  private poison(state: TrackedRun, observedAt: number): void {
    state.poisoned = true
    state.content = ''
    state.providerObservedAt = Math.max(state.providerObservedAt ?? 0, observedAt)
    this.trySettle(state)
  }

  private trySettle(state: TrackedRun): void {
    if (
      state.launchConfirmedAt === null ||
      state.lifecycleStatus === null ||
      state.lifecycleObservedAt === null ||
      state.providerStatus === null ||
      state.providerObservedAt === null ||
      this.tracked.get(state.binding.runId) !== state
    ) {
      return
    }
    const copy = terminalCopy(state)
    const terminal: ChannelAgentRunTerminalEvidence = {
      ...copy,
      exitCode: state.exitCode,
      observedAt: Math.max(
        state.binding.launchIntentAt,
        state.launchConfirmedAt,
        state.lifecycleObservedAt,
        state.providerObservedAt
      )
    }
    this.tracked.delete(state.binding.runId)
    state.resolve(Object.freeze(terminal))
  }

  private observedAt(state: TrackedRun): number {
    let value: number
    try {
      value = this.now()
    } catch {
      state.poisoned = true
      return state.binding.launchIntentAt
    }
    if (!isTimestamp(value)) {
      state.poisoned = true
      return state.binding.launchIntentAt
    }
    return Math.max(value, state.binding.launchIntentAt)
  }

  private isTerminalStatus(value: unknown): value is TerminalRunSessionStatus {
    return value === 'completed' || value === 'failed' || value === 'cancelled'
  }
}
