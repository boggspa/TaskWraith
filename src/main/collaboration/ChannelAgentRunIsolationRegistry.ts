import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { UsageRecord } from '../store/types'

const DEFAULT_MAX_ACTIVE_RUNS = 64
const DEFAULT_MAX_SETTLED_RUNS = 512
const MAX_ID_LENGTH = 512

export type ChannelAgentRunIsolationRegistryErrorCode =
  | 'binding_conflict'
  | 'capacity_exceeded'
  | 'duplicate_run'
  | 'invalid_input'

export class ChannelAgentRunIsolationRegistryError extends Error {
  constructor(
    readonly code: ChannelAgentRunIsolationRegistryErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentRunIsolationRegistryError'
  }
}

export interface ChannelAgentRunIsolationBinding {
  readonly runId: string
  readonly chatId: string
}

export interface ChannelAgentRunIsolationLease {
  readonly binding: ChannelAgentRunIsolationBinding
  settle(): boolean
}

export interface ChannelAgentRunIsolationRegistryOptions {
  readonly maxActiveRuns?: number
  readonly maxSettledRuns?: number
}

export type ChannelAgentUsageEntry = Omit<UsageRecord, 'id' | 'timestamp'>

interface ActiveEntry {
  readonly binding: ChannelAgentRunIsolationBinding
  readonly token: symbol
}

function fail(code: ChannelAgentRunIsolationRegistryErrorCode, message: string): never {
  throw new ChannelAgentRunIsolationRegistryError(code, message)
}

function exactId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_ID_LENGTH ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    fail('invalid_input', `${label} is invalid.`)
  }
  return value
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    fail('invalid_input', `${label} must be a positive safe integer.`)
  }
  return resolved
}

function bindingFromPayload(payload: AgentRunPayload): ChannelAgentRunIsolationBinding {
  if (!payload || typeof payload !== 'object') {
    fail('invalid_input', 'A Channel agent run payload is required.')
  }
  return Object.freeze({
    runId: exactId(payload.appRunId, 'Channel agent run id'),
    chatId: exactId(payload.appChatId, 'Channel agent chat id')
  })
}

/** Keep numeric accounting while removing optional persisted prompt/response bodies. */
export function redactChannelAgentUsageContent(
  entry: ChannelAgentUsageEntry
): ChannelAgentUsageEntry {
  const redacted = { ...entry }
  delete redacted.promptText
  delete redacted.responseText
  return redacted
}

/**
 * Process-owned privacy identity for exact Channel agent dispatches.
 *
 * The registry is intentionally not carried on `AgentRunPayload`: renderer
 * input, provider output, and a reroute cannot self-assert this narrower
 * persistence posture. Active entries are never evicted. Settled entries keep
 * late terminal/session writers isolated for a bounded tail after the adapter
 * promise has joined.
 */
export class ChannelAgentRunIsolationRegistry {
  private readonly maxActiveRuns: number
  private readonly maxSettledRuns: number
  private readonly active = new Map<string, ActiveEntry>()
  private readonly settled = new Map<string, ChannelAgentRunIsolationBinding>()

  constructor(options: ChannelAgentRunIsolationRegistryOptions = {}) {
    this.maxActiveRuns = positiveInteger(
      options.maxActiveRuns,
      DEFAULT_MAX_ACTIVE_RUNS,
      'Channel agent active-run capacity'
    )
    this.maxSettledRuns = positiveInteger(
      options.maxSettledRuns,
      DEFAULT_MAX_SETTLED_RUNS,
      'Channel agent settled-run capacity'
    )
  }

  register(payload: AgentRunPayload): ChannelAgentRunIsolationLease {
    const binding = bindingFromPayload(payload)
    const live = this.active.get(binding.runId)
    if (live) {
      if (live.binding.chatId !== binding.chatId) {
        fail('binding_conflict', 'Channel agent run id is already bound to another chat.')
      }
      fail('duplicate_run', 'Channel agent run id is already isolated.')
    }
    const terminal = this.settled.get(binding.runId)
    if (terminal) {
      if (terminal.chatId !== binding.chatId) {
        fail('binding_conflict', 'Settled Channel agent run id belongs to another chat.')
      }
      fail('duplicate_run', 'Settled Channel agent run id cannot be replayed.')
    }
    if (this.active.size >= this.maxActiveRuns) {
      fail('capacity_exceeded', 'Channel agent run isolation is at active capacity.')
    }

    const token = Symbol(binding.runId)
    this.active.set(binding.runId, { binding, token })
    return Object.freeze({
      binding,
      settle: () => {
        const current = this.active.get(binding.runId)
        if (!current || current.token !== token) return false
        this.active.delete(binding.runId)
        this.settled.delete(binding.runId)
        this.settled.set(binding.runId, binding)
        while (this.settled.size > this.maxSettledRuns) {
          const oldest = this.settled.keys().next().value
          if (typeof oldest !== 'string') break
          this.settled.delete(oldest)
        }
        return true
      }
    })
  }

  /**
   * Match by main-registered run identity, not mutable provider/chat fields.
   * A rebound payload therefore keeps the restrictive isolation posture while
   * the independent final-authorization seal rejects the changed dispatch.
   */
  isPayloadIsolated(payload: AgentRunPayload): boolean {
    return this.isRunIsolated(payload?.appRunId)
  }

  isRunIsolated(runId: unknown): boolean {
    if (
      typeof runId !== 'string' ||
      runId.length < 1 ||
      runId.length > MAX_ID_LENGTH ||
      runId.trim() !== runId
    ) {
      return false
    }
    return this.active.has(runId) || this.settled.has(runId)
  }
}
