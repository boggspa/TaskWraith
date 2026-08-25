/**
 * Pure protocol layer for the Pi coding agent's RPC mode (`pi --mode rpc`),
 * stdin/stdout JSONL. Mirrors the CursorStreamJson shape: a chunk parser with
 * cross-chunk carry, a normalized run-event vocabulary the compat ingestion
 * already understands, and a terminal-outcome contract.
 *
 * Pi differs from Cursor's stream-json in one structural way: there is no
 * single terminal "result" line. Usage arrives per assistant turn on
 * `turn_end` (a prompt with tool use produces several), errors arrive on
 * `message_update`/`response` lines, and the authoritative "no more work"
 * signal is `agent_settled` (pi's own transient-error auto-retry and queued
 * continuations are all drained by then). The reducer below carries that
 * state so the terminal event can be synthesized at settle time.
 *
 * Turn shutdown is stdin EOF: pi exits cleanly when stdin closes (verified
 * live on 0.82.1, ~0.6s) — never rely on signals alone.
 */

import { TASKWRAITH_CONTEXT_USAGE_KEY, withContextUsageSnapshot } from '../../shared/contextUsage'

export interface PiUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** USD as computed by pi's own rate table (message.usage.cost.total). */
  costUsd?: number
}

/** Keep Pi's summed turn usage for billing while attaching the final model
 * invocation as the atomic context-window snapshot. Pi's input counter excludes
 * cache reads/writes, so the shared projector adds those components exactly
 * once when it builds the atomic breakdown. */
export function piUsageToStats(usage: PiUsage, lastUsage?: PiUsage): Record<string, unknown> {
  const aggregate = {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cache_read_input_tokens: usage.cacheReadTokens ?? 0,
    cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
    total_cost_usd: usage.costUsd ?? 0
  }
  if (!lastUsage) return aggregate
  const atomic = withContextUsageSnapshot(
    {
      input_tokens: lastUsage.inputTokens ?? 0,
      output_tokens: lastUsage.outputTokens ?? 0,
      cache_read_input_tokens: lastUsage.cacheReadTokens ?? 0,
      cache_creation_input_tokens: lastUsage.cacheWriteTokens ?? 0
    },
    {
      source: 'provider-last-invocation',
      precision: 'exact'
    }
  )
  return atomic[TASKWRAITH_CONTEXT_USAGE_KEY]
    ? { ...aggregate, [TASKWRAITH_CONTEXT_USAGE_KEY]: atomic[TASKWRAITH_CONTEXT_USAGE_KEY] }
    : aggregate
}

export interface NormalizedPiRunEvent {
  type: 'init' | 'content' | 'thinking' | 'result' | 'provider_warning' | 'tool_use' | 'tool_result'
  text?: string
  sessionId?: string
  model?: string
  /** Display label for the model, distinct from the wire/model id. */
  modelLabel?: string
  /** Terminal status on a 'result' event ('success' or a failure reason). */
  status?: string
  /** Summed token usage across every turn_end, on the terminal 'result'. */
  usage?: PiUsage
  /** Usage from the final model invocation only. This is context occupancy,
   * unlike `usage`, which remains the aggregate used for billing/tallies. */
  lastUsage?: PiUsage
  toolId?: string
  toolName?: string
  toolKind?: string
  toolInput?: Record<string, unknown>
  toolStatus?: 'success' | 'error'
  toolOutput?: string
  raw?: unknown
}

export interface PiStreamLine {
  json?: Record<string, unknown>
  nonJson?: string
}

/** NDJSON splitter with cross-chunk carry ('' on first call). */
export function parsePiStreamChunk(
  rawChunk: string,
  carry: string
): { lines: PiStreamLine[]; carry: string } {
  const buffer = (carry || '') + (rawChunk || '')
  const segments = buffer.split(/\r?\n/)
  const nextCarry = segments.pop() ?? ''
  const lines: PiStreamLine[] = []
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        lines.push({ json: parsed as Record<string, unknown> })
      } else {
        lines.push({ nonJson: segment })
      }
    } catch {
      lines.push({ nonJson: segment })
    }
  }
  return { lines, carry: nextCarry }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Tool-call arguments, accepting the two shapes upstreams actually send.
 *
 * Pi's own events carry `arguments` as an object, but the OpenAI-shaped APIs it
 * fronts — Mistral among them — send it as a JSON STRING. `asRecord` rejects a
 * string, which meant `toolInput` was dropped entirely and a call arrived with
 * no arguments at all: `run_shell_command` reached the gate with no `command`
 * and was refused, on every single call, for any model whose upstream stringify
 * their arguments. The seat cannot tell that apart from its command being
 * censored, so it reports the harness as corrupting or stripping the call.
 *
 * An unparseable blob still returns undefined so the call is announced without
 * arguments and the gate refuses it visibly — better a refusal the seat can
 * read than a silently argument-less call.
 */
function asToolArguments(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value)
  if (direct) return direct
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    return asRecord(JSON.parse(trimmed))
  } catch {
    return undefined
  }
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Concatenate the text blocks of a pi tool result's `content` array. */
function extractPiToolOutputText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    const record = asRecord(block)
    if (record && typeof record.text === 'string') out += record.text
  }
  return out
}

/** Pi built-in tool name → AD3 canonical kind for the renderer's icon. */
export function piToolKind(name: string): string | undefined {
  switch (name) {
    case 'read':
      return 'read'
    case 'edit':
    case 'write':
      return 'edit'
    case 'bash':
      return 'execute'
    case 'grep':
    case 'find':
    case 'ls':
      return 'search'
    default:
      return undefined
  }
}

/** One buffered `toolcall_end` block, held until its burst can be merged. */
interface PendingPiToolCall {
  name: string
  id: string
  args?: Record<string, unknown>
  raw: unknown
}

/**
 * A forked block leaves `arguments: {}` behind, not a missing key, so emptiness
 * has to be counted rather than tested for truthiness — `{}` is truthy, and
 * treating it as "has arguments" is exactly what stops the hand-back.
 */
function hasToolArguments(call: PendingPiToolCall): boolean {
  return Boolean(call.args) && Object.keys(call.args as Record<string, unknown>).length > 0
}

export interface PiTerminalCompatOutcome {
  failed: boolean
  status: 'success' | 'failed'
  subtype: 'success' | 'error'
  text?: string
}

/**
 * Stateful per-turn reducer: feed every parsed JSONL line, emit normalized
 * events, and read the terminal outcome once `agent_settled` (or process
 * exit) has been seen. One instance per spawned pi process.
 */
export class PiRpcTurnReducer {
  private usageTotals: Required<Omit<PiUsage, 'costUsd'>> & { costUsd: number } = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0
  }
  private sawUsage = false
  private lastUsage: PiUsage | undefined
  private settled = false
  private errorText = ''
  private aborted = false
  private modelLabel = ''
  private sessionId = ''
  private pendingToolCalls: PendingPiToolCall[] = []
  private readonly forkedToolCallIds = new Set<string>()

  get isSettled(): boolean {
    return this.settled
  }

  get failureText(): string {
    return this.errorText
  }

  ingest(line: PiStreamLine): NormalizedPiRunEvent[] {
    const json = line.json
    if (!json) return []
    const type = typeof json.type === 'string' ? json.type : ''
    // Hold a contiguous run of toolcall_end blocks so a forked, nameless block
    // can hand its arguments back before anything is announced. Pi emits the
    // whole burst at stream end, ahead of every execution line, so nothing is
    // reordered relative to its result.
    if (type === 'message_update') {
      const delta = asRecord(json.assistantMessageEvent)
      if (delta && delta.type === 'toolcall_end') {
        this.bufferToolCall(delta, json)
        return []
      }
    }
    const flushed = this.flushPendingToolCalls()
    const events = this.ingestLine(type, json)
    return flushed.length ? [...flushed, ...events] : events
  }

  private ingestLine(type: string, json: Record<string, unknown>): NormalizedPiRunEvent[] {
    switch (type) {
      case 'response':
        return this.ingestResponse(json)
      case 'message_update':
        return this.ingestMessageUpdate(json)
      case 'tool_execution_start':
        return this.ingestToolStart(json)
      case 'tool_execution_end':
        return this.ingestToolEnd(json)
      case 'turn_end':
        return this.ingestTurnEnd(json)
      case 'auto_retry_start': {
        const message = typeof json.errorMessage === 'string' ? json.errorMessage : ''
        return [
          {
            type: 'provider_warning',
            text: message ? `Pi is retrying after a transient provider error: ${message}` : 'Pi is retrying after a transient provider error.',
            raw: json
          }
        ]
      }
      case 'auto_retry_end': {
        if (json.success === false && typeof json.finalError === 'string' && json.finalError) {
          this.errorText = this.errorText || json.finalError
        }
        return []
      }
      case 'agent_settled': {
        this.settled = true
        return [this.terminalEvent(json)]
      }
      default:
        return []
    }
  }

  /** Terminal contract if the process exits without ever settling. */
  unsettledExitOutcome(exitCode: number | null): PiTerminalCompatOutcome {
    if (this.settled) return this.terminalOutcome()
    const detail = this.errorText || `Pi exited before settling (exit code ${exitCode ?? 'unknown'}).`
    return { failed: true, status: 'failed', subtype: 'error', text: detail }
  }

  terminalOutcome(): PiTerminalCompatOutcome {
    const failed = Boolean(this.errorText) || this.aborted
    return {
      failed,
      status: failed ? 'failed' : 'success',
      subtype: failed ? 'error' : 'success',
      ...(this.errorText ? { text: this.errorText } : {})
    }
  }

  private terminalEvent(raw: unknown): NormalizedPiRunEvent {
    const outcome = this.terminalOutcome()
    return {
      type: 'result',
      status: outcome.failed ? (this.aborted ? 'aborted' : 'error') : 'success',
      ...(outcome.text ? { text: outcome.text } : {}),
      ...(this.sawUsage ? { usage: { ...this.usageTotals } } : {}),
      ...(this.lastUsage ? { lastUsage: { ...this.lastUsage } } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.modelLabel ? { modelLabel: this.modelLabel } : {}),
      raw
    }
  }

  private ingestResponse(json: Record<string, unknown>): NormalizedPiRunEvent[] {
    if (json.success !== false) {
      const data = asRecord(json.data)
      const sessionId = data && typeof data.sessionId === 'string' ? data.sessionId : ''
      if (sessionId) this.sessionId = sessionId
      const model = data && asRecord(data.model)
      const name = model && typeof model.name === 'string' ? model.name : ''
      if (name) this.modelLabel = name
      return []
    }
    const command = typeof json.command === 'string' ? json.command : 'command'
    const error = typeof json.error === 'string' && json.error ? json.error : 'unknown error'
    const text = `Pi rejected ${command}: ${error}`
    // A rejected prompt means no agent work will happen; treat as terminal-worthy.
    if (command === 'prompt') this.errorText = this.errorText || text
    return [{ type: 'provider_warning', text, raw: json }]
  }

  private ingestMessageUpdate(json: Record<string, unknown>): NormalizedPiRunEvent[] {
    const delta = asRecord(json.assistantMessageEvent)
    if (!delta) return []
    const kind = typeof delta.type === 'string' ? delta.type : ''
    switch (kind) {
      case 'text_delta': {
        const text = typeof delta.delta === 'string' ? delta.delta : ''
        return text ? [{ type: 'content', text, raw: json }] : []
      }
      case 'thinking_delta': {
        const text = typeof delta.delta === 'string' ? delta.delta : ''
        return text ? [{ type: 'thinking', text, raw: json }] : []
      }
      case 'error': {
        const reason = typeof delta.reason === 'string' ? delta.reason : 'error'
        if (reason === 'aborted') {
          this.aborted = true
        }
        const message = typeof delta.error === 'string' && delta.error ? delta.error : `Pi reported ${reason}.`
        this.errorText = this.errorText || message
        return [{ type: 'provider_warning', text: message, raw: json }]
      }
      default:
        return []
    }
  }

  private bufferToolCall(delta: Record<string, unknown>, json: Record<string, unknown>): void {
    const toolCall = asRecord(delta.toolCall)
    if (!toolCall) return
    this.pendingToolCalls.push({
      name: typeof toolCall.name === 'string' ? toolCall.name : '',
      id: typeof toolCall.id === 'string' ? toolCall.id : '',
      args: asToolArguments(toolCall.arguments),
      raw: json
    })
  }

  /**
   * Announce the buffered burst, having first put the forked blocks back
   * together.
   *
   * Pi's mistral-conversations accumulator keys on `${callId}:${index}`, and
   * Mistral's continuation deltas carry `id: "null"` with `name: ""` — a
   * different key, so the arguments fork into a SECOND, nameless block while
   * the named one keeps `{}`. Which block the arguments land in depends on
   * where the packet boundaries fell, which is the whole of the seat's
   * "intermittent" stripping.
   *
   * A nameless block is never executable, so it is dropped rather than shown —
   * but its arguments are moved onto the named block first. Dropping the empty
   * slot WITHOUT that hand-back would turn a coin-flip failure into silent,
   * total argument loss on every call whose arguments forked.
   */
  private flushPendingToolCalls(): NormalizedPiRunEvent[] {
    if (!this.pendingToolCalls.length) return []
    const pending = this.pendingToolCalls
    this.pendingToolCalls = []
    const merged: PendingPiToolCall[] = []
    for (const call of pending) {
      if (call.name) {
        merged.push(call)
        continue
      }
      if (hasToolArguments(call)) {
        // Forks arrive in the same order as the calls they were split from, so
        // claim the EARLIEST call still waiting for arguments. Walking back
        // from the end instead hands the first fork to the last call, which
        // silently swaps arguments between parallel tool calls.
        for (let index = 0; index < merged.length; index++) {
          const target = merged[index]
          if (target.name && !hasToolArguments(target)) {
            merged[index] = { ...target, args: call.args }
            break
          }
        }
      }
      if (call.id) this.forkedToolCallIds.add(call.id)
    }
    return merged.map((call) => {
      const kind = piToolKind(call.name)
      return {
        type: 'tool_use' as const,
        toolName: call.name,
        ...(call.id ? { toolId: call.id } : {}),
        ...(kind ? { toolKind: kind } : {}),
        ...(call.args ? { toolInput: call.args } : {}),
        raw: call.raw
      }
    })
  }

  private ingestToolStart(json: Record<string, unknown>): NormalizedPiRunEvent[] {
    // toolcall_end (from message_update) already announced the call with its
    // arguments; the execution-start line adds nothing for the transcript.
    void json
    return []
  }

  private ingestToolEnd(json: Record<string, unknown>): NormalizedPiRunEvent[] {
    const toolCallId = typeof json.toolCallId === 'string' ? json.toolCallId : ''
    const toolName = typeof json.toolName === 'string' ? json.toolName : ''
    // A forked block was never announced, so its `Tool  not found` result has
    // no row to attach to. It only reaches here when the managed extension is
    // absent and Pi dispatched the fork anyway.
    if (toolCallId && this.forkedToolCallIds.has(toolCallId)) return []
    const result = asRecord(json.result)
    const isError = json.isError === true || (result ? result.isError === true : false)
    // Live-verified shape (pi 0.82.1): `result.content` is an ARRAY of
    // content blocks — `[{type:'text', text:'…'}]`. Dumping it as JSON put
    // raw block markup in the transcript, so unwrap text blocks first and
    // only fall back to serialization for shapes we do not recognize.
    let output = extractPiToolOutputText(result?.content)
    if (!output) {
      const candidates: unknown[] = [json.output, result?.output, json.result]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate) {
          output = candidate
          break
        }
        if (candidate && typeof candidate === 'object') {
          try {
            output = JSON.stringify(candidate)
            break
          } catch {
            /* try the next shape */
          }
        }
      }
    }
    return [
      {
        type: 'tool_result',
        ...(toolCallId ? { toolId: toolCallId } : {}),
        ...(toolName ? { toolName } : {}),
        toolStatus: isError ? 'error' : 'success',
        ...(output ? { toolOutput: output } : {}),
        raw: json
      }
    ]
  }

  private ingestTurnEnd(json: Record<string, unknown>): NormalizedPiRunEvent[] {
    const message = asRecord(json.message)
    const events: NormalizedPiRunEvent[] = []
    // THE authoritative failure signal. Live-verified on pi 0.82.1: an API
    // rejection (401/429/5xx) produces NO `message_update` error delta — the
    // assistant message itself carries `stopReason: 'error'` plus
    // `errorMessage`, and the stream otherwise looks like a normal empty turn.
    // Reading only the delta lane made a bad key settle as SUCCESS with empty
    // text, the vacuous-pass class. Never remove this branch.
    if (message) {
      const stopReason = typeof message.stopReason === 'string' ? message.stopReason : ''
      const errorMessage =
        typeof message.errorMessage === 'string' && message.errorMessage
          ? message.errorMessage
          : ''
      if (stopReason === 'aborted') {
        this.aborted = true
        this.errorText = this.errorText || errorMessage || 'Pi turn aborted.'
      } else if (stopReason === 'error' || errorMessage) {
        this.errorText = this.errorText || errorMessage || 'Pi turn failed.'
        events.push({
          type: 'provider_warning',
          text: this.errorText,
          raw: json
        })
      }
    }
    const usage = message && asRecord(message.usage)
    if (!usage) return events
    const input = asNumber(usage.input)
    const output = asNumber(usage.output)
    const cacheRead = asNumber(usage.cacheRead)
    const cacheWrite = asNumber(usage.cacheWrite)
    const cost = asRecord(usage.cost)
    const costTotal = cost ? asNumber(cost.total) : undefined
    if (
      input === undefined &&
      output === undefined &&
      cacheRead === undefined &&
      cacheWrite === undefined
    ) {
      return events
    }
    this.sawUsage = true
    this.lastUsage = {
      inputTokens: input ?? 0,
      outputTokens: output ?? 0,
      cacheReadTokens: cacheRead ?? 0,
      cacheWriteTokens: cacheWrite ?? 0,
      ...(costTotal !== undefined ? { costUsd: costTotal } : {})
    }
    this.usageTotals.inputTokens += input ?? 0
    this.usageTotals.outputTokens += output ?? 0
    this.usageTotals.cacheReadTokens += cacheRead ?? 0
    this.usageTotals.cacheWriteTokens += cacheWrite ?? 0
    this.usageTotals.costUsd += costTotal ?? 0
    return events
  }
}

/** JSONL commands written to pi's stdin. */
export function piPromptCommand(message: string, id?: string): string {
  return JSON.stringify({ type: 'prompt', message, ...(id ? { id } : {}) })
}

export function piAbortCommand(): string {
  return JSON.stringify({ type: 'abort' })
}

export function piSteerCommand(message: string): string {
  return JSON.stringify({ type: 'steer', message })
}
