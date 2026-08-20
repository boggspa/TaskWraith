import type { RunEventInput } from './store/types'

/**
 * Reasoning tool names are provider-prefixed and suffixed by role:
 * `pi_thinking`, `codex_reasoning`, `mistral_thinking`, and so on.
 */
const REASONING_TOOL_NAME = /_(?:thinking|reasoning)$/

/**
 * Open segments held across all runs. Each holds one accumulation, which is
 * the same string the provider stream state already carries, so this adds no
 * growth the run did not already have. Past the cap the oldest is written out
 * rather than dropped.
 */
const MAX_OPEN_SEGMENTS = 64

export interface CoalescedReasoningSegment {
  /**
   * The durable input the first chunk would have written, reused verbatim so
   * every routing field (chat, workspace, provider session) is preserved.
   */
  template: RunEventInput
  toolId: string
  toolName: string
  text: string
  chunkCount: number
  firstTimestamp: string
  lastTimestamp: string
}

export interface ReasoningAbsorbResult {
  /** True when the input was a reasoning chunk and must NOT be written. */
  deferred: boolean
  /** Segments that closed and are due to be written now, in order. */
  flushed: CoalescedReasoningSegment[]
}

interface ReasoningChunk {
  toolId: string
  toolName: string
  text: string
}

/** The reasoning chunk in a durable input, or null if it is anything else. */
export function reasoningChunkFromInput(input: RunEventInput): ReasoningChunk | null {
  const payload = input.payload
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (record.type !== 'tool_result') return null
  const toolName = typeof record.tool_name === 'string' ? record.tool_name : ''
  if (!REASONING_TOOL_NAME.test(toolName)) return null
  const text = typeof record.output === 'string' ? record.output : null
  if (text === null) return null
  const toolId = typeof record.tool_id === 'string' && record.tool_id ? record.tool_id : toolName
  return { toolId, toolName, text }
}

/** The consolidated record a closed segment writes. */
export function coalescedReasoningInput(segment: CoalescedReasoningSegment): RunEventInput {
  const basePayload =
    segment.template.payload && typeof segment.template.payload === 'object'
      ? (segment.template.payload as Record<string, unknown>)
      : {}
  const chunkLabel = `${segment.chunkCount} chunk${segment.chunkCount === 1 ? '' : 's'}`
  return {
    // Stamped when the segment CLOSED, which is when this record is written.
    // The ledger stays monotonic; the start is carried in the payload.
    ...segment.template,
    timestamp: segment.lastTimestamp,
    summary: `${segment.toolName} segment (${chunkLabel})`,
    payload: {
      ...basePayload,
      output: segment.text,
      reasoning: {
        coalesced: true,
        chunkCount: segment.chunkCount,
        firstTimestamp: segment.firstTimestamp,
        lastTimestamp: segment.lastTimestamp
      }
    }
  }
}

/**
 * Holds a run's open reasoning segment and releases ONE consolidated record
 * when it closes.
 *
 * Providers restate the whole segment on every chunk — the CLI stream sets
 * `thinkingText = current + chunk`, codex sends the accumulated group text —
 * and every restatement was persisted. That is quadratic in the segment's
 * length and it is what made the run-event corpus 28 GB: one measured ledger
 * held 1117.7 MB of reasoning across 71,544 records carrying just 59 segments,
 * whose final texts total 0.28 MB.
 *
 * A segment closes when a chunk arrives for a different tool id, or when any
 * other durable event is written for the run — which covers every terminal
 * path (lifecycle, provider_exit) without hooking each one. A segment still
 * open when the process dies is lost; every ordinary run end writes one.
 *
 * Reasoning that resumes on the SAME tool id after an interleaved event opens a
 * fresh segment, so one tool id can produce several consolidated records. Each
 * holds the segment's text as of its own close, which makes them cumulative
 * SNAPSHOTS rather than disjoint parts: the newest record for a tool id holds
 * the whole segment and earlier ones are prefixes of it. Read the last, do not
 * concatenate — the same rule the per-chunk records already obeyed, since every
 * chunk was itself a full restatement. Replayed over the live corpus this cost
 * 1,028 records for 59 tool ids on the largest ledger, which still took it from
 * 1119.1 MB to 1.4 MB.
 */
export class ReasoningLedgerCoalescer {
  private readonly open = new Map<string, CoalescedReasoningSegment>()

  private key(runId: string, toolId: string): string {
    return `${runId} ${toolId}`
  }

  absorb(input: RunEventInput, now: string): ReasoningAbsorbResult {
    const runId = input.runId
    const chunk = reasoningChunkFromInput(input)
    if (!chunk) {
      // Any other durable event for this run closes its reasoning, so the
      // consolidated record keeps its place ahead of what closed it.
      return { deferred: false, flushed: this.drain(runId) }
    }

    const flushed: CoalescedReasoningSegment[] = []
    const prefix = `${runId} `
    for (const [key, segment] of this.open) {
      if (key.startsWith(prefix) && segment.toolId !== chunk.toolId) {
        flushed.push(segment)
        this.open.delete(key)
      }
    }

    const key = this.key(runId, chunk.toolId)
    const existing = this.open.get(key)
    if (existing) {
      // Accumulating providers resend the whole segment; a delta-shaped
      // provider would not. Detecting which keeps this correct for both.
      existing.text = chunk.text.startsWith(existing.text)
        ? chunk.text
        : `${existing.text}${chunk.text}`
      existing.chunkCount += 1
      existing.lastTimestamp = now
    } else {
      this.open.set(key, {
        template: input,
        toolId: chunk.toolId,
        toolName: chunk.toolName,
        text: chunk.text,
        chunkCount: 1,
        firstTimestamp: input.timestamp || now,
        lastTimestamp: now
      })
    }

    while (this.open.size > MAX_OPEN_SEGMENTS) {
      const oldestKey = this.open.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      const oldest = this.open.get(oldestKey)
      this.open.delete(oldestKey)
      if (oldest) flushed.push(oldest)
    }

    return { deferred: true, flushed }
  }

  /** Close every open segment for a run. */
  drain(runId: string): CoalescedReasoningSegment[] {
    const prefix = `${runId} `
    const flushed: CoalescedReasoningSegment[] = []
    for (const [key, segment] of this.open) {
      if (!key.startsWith(prefix)) continue
      flushed.push(segment)
      this.open.delete(key)
    }
    return flushed
  }

  get openSegmentCount(): number {
    return this.open.size
  }
}
