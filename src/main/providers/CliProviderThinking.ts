export interface CliProviderThinkingMergeOptions {
  cumulative?: boolean
}

/**
 * Mutable per-run thinking-trace state threaded through the CLI provider
 * stream pipeline (a structural slice of CliProviderStreamState).
 *
 * Chronological segmentation (1.0.7): a run's reasoning is emitted as a
 * SEQUENCE of trace activities, not one run-scoped blob. Whenever a
 * transcript-visible, non-reasoning line (assistant text, tool call, progress
 * card…) lands between thinking chunks, the next chunk opens a NEW segment —
 * so late reasoning renders at its true transcript position instead of
 * growing the turn's first trace in place.
 */
export interface CliProviderThinkingSegmentsState {
  /** Current segment's accumulated text (the activity's `output`). */
  thinkingText?: string
  /** Whether the current segment's `tool_use` line has been emitted. */
  thinkingStarted?: boolean
  /** 1-based segment ordinal; segments ≥ 2 suffix the activity id. */
  thinkingSegmentSeq?: number
  /** Set when visible non-reasoning output landed since the last chunk. */
  thinkingChronoBreak?: boolean
  /** Concatenated text of CLOSED segments — lets cumulative envelopes that
   * restate the whole turn (Claude interleaved-thinking messages) be
   * recognised as already-emitted instead of duplicated into a new segment. */
  thinkingTextCommitted?: string
}

export interface CliProviderThinkingAdvance {
  /** Full text of the current segment after this chunk (activity output). */
  text: string
  /** True when this chunk opens a new trace activity (emit a `tool_use`). */
  startedNewActivity: boolean
  /** Segment ordinal the chunk belongs to (1-based). */
  segmentSeq: number
}

/** Compat payload types that materialise transcript rows between thinking
 * chunks. Anything outside this set (init / result / exit / usage…) leaves
 * the reasoning stream unbroken. */
const THINKING_CHRONOLOGY_BREAK_TYPES = new Set([
  'content',
  'token',
  'message',
  'tool_use',
  'tool_call',
  'tool_result',
  'tool_output',
  'tool_response',
  'progress',
  'tool_progress',
  'update_topic',
  'invoke_agent',
  'summary',
  'intent',
  'provider_warning',
  'media_refs',
  'compaction_event'
])

/** Whether a tool name denotes a reasoning/thinking pseudo-tool (the trace
 * lines themselves must never break their own chronology). */
export function isThinkingTraceToolName(toolName: unknown): boolean {
  if (typeof toolName !== 'string') return false
  const name = toolName.trim().toLowerCase()
  return (
    name === 'thinking' ||
    name === 'reasoning' ||
    name.endsWith('_thinking') ||
    name.endsWith('_reasoning')
  )
}

/**
 * Whether a transcript-visible compat payload should mark a thinking
 * chronology break on the emitting run's stream state.
 */
export function shouldBreakThinkingChronology(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (!THINKING_CHRONOLOGY_BREAK_TYPES.has(type)) return false
  if (isThinkingTraceToolName(record.tool_name)) return false
  // Only assistant-authored `message` envelopes render as transcript rows.
  if (type === 'message' && record.role !== undefined && record.role !== 'assistant') return false
  return true
}

/**
 * Fold one thinking chunk into the segmented trace state. Returns null when
 * the chunk changes nothing visible (empty, or a cumulative restatement of
 * text already emitted); otherwise returns the current segment's full text
 * plus whether a NEW trace activity must be opened for it.
 *
 * Behaviour is byte-identical to the pre-segmentation merge until a
 * chronology break is observed: append deltas grow the segment, cumulative
 * envelopes replace-or-drop against it. After a break, the next genuinely new
 * chunk closes the segment and opens the next one.
 */
export function advanceCliProviderThinkingSegments(
  state: CliProviderThinkingSegmentsState,
  rawText: string,
  options: CliProviderThinkingMergeOptions = {}
): CliProviderThinkingAdvance | null {
  if (shouldIgnoreCliProviderThinkingChunk(rawText, options)) return null
  const current = state.thinkingText || ''
  const committed = state.thinkingTextCommitted || ''
  const total = committed + current

  let chunk: string
  if (options.cumulative) {
    if (rawText === current || rawText === total) return null
    if (total && rawText.startsWith(total)) {
      // Whole-turn restatement grown by a suffix — only the suffix is new.
      chunk = rawText.slice(total.length)
    } else if (current && rawText.startsWith(current)) {
      // Current-statement growth (Kimi-style growing envelope).
      chunk = rawText.slice(current.length)
    } else if (state.thinkingStarted && !state.thinkingChronoBreak) {
      // Divergent restatement with nothing visible in between — keep the
      // legacy replace-in-place semantics for the current segment.
      state.thinkingText = rawText
      return {
        text: rawText,
        startedNewActivity: false,
        segmentSeq: state.thinkingSegmentSeq ?? 1
      }
    } else {
      // Divergent restatement after a break (or before any thinking): a new
      // reasoning statement in full.
      chunk = rawText
    }
    if (!chunk) return null
  } else {
    chunk = rawText
  }

  if (state.thinkingStarted && state.thinkingChronoBreak) {
    // Visible activity landed since the last chunk — this reasoning belongs
    // BELOW it, in a fresh trace activity. Whitespace-only bridges are noise
    // on either side of the boundary; drop them without opening a segment.
    if (!chunk.trim()) return null
    state.thinkingTextCommitted = total
    state.thinkingSegmentSeq = (state.thinkingSegmentSeq ?? 1) + 1
    state.thinkingStarted = true
    state.thinkingText = chunk
    state.thinkingChronoBreak = false
    return { text: chunk, startedNewActivity: true, segmentSeq: state.thinkingSegmentSeq }
  }

  const startedNewActivity = !state.thinkingStarted
  state.thinkingStarted = true
  state.thinkingSegmentSeq = state.thinkingSegmentSeq ?? 1
  state.thinkingChronoBreak = false
  state.thinkingText = current + chunk
  return {
    text: state.thinkingText,
    startedNewActivity,
    segmentSeq: state.thinkingSegmentSeq
  }
}

/** Activity id for a thinking segment — the first segment keeps the legacy
 * un-suffixed id so existing transcripts/tests are unaffected. */
export function cliProviderThinkingSegmentToolId(
  provider: string,
  appRunId: string | undefined,
  segmentSeq: number
): string {
  const suffix = segmentSeq > 1 ? `-seg${segmentSeq}` : ''
  return `${provider}-thinking-${appRunId || 'run'}${suffix}`
}

/** Whether an incoming thinking chunk should be ignored. */
export function shouldIgnoreCliProviderThinkingChunk(
  text: string,
  options: CliProviderThinkingMergeOptions = {}
): boolean {
  if (!text) return true
  // Claude/Kimi cumulative envelopes may be whitespace-only when thinking is redacted.
  if (options.cumulative) return !text.trim()
  // Grok/Cursor append deltas preserve whitespace (match content token handling).
  return false
}

/**
 * Merge one thinking chunk into accumulated text. Returns null when the chunk is
 * ignored or would not change the accumulated trace.
 */
export function mergeCliProviderThinkingChunk(
  accumulated: string | undefined,
  text: string,
  options: CliProviderThinkingMergeOptions = {}
): string | null {
  if (shouldIgnoreCliProviderThinkingChunk(text, options)) return null
  if (options.cumulative) {
    const current = accumulated || ''
    if (text === current) return null
    return text
  }
  return `${accumulated || ''}${text}`
}
