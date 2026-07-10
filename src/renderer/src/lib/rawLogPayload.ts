/**
 * Bound the per-line cost of the renderer's raw-log lane.
 *
 * Every provider stdout line is pretty-printed (`JSON.stringify(_, null, 2)`)
 * and regex-redacted before it lands in the Raw panel's ring buffer. Thinking
 * deltas re-send the FULL accumulated trace per line (100KB+ at high
 * reasoning tiers), so stringify + redact costs grow linearly per delta —
 * quadratic over a stream — and the 1000-entry ring can retain ~100MB of
 * near-duplicate text. The raw panel is a debugging surface: truncating the
 * middle of pathologically long string FIELDS (head + tail preserved, with an
 * explicit elision marker) keeps it useful while bounding cost. Small
 * payloads (errors, exits, tool headers) pass through untouched, so
 * downstream string matching (quota markers, "Process exited with code")
 * still works.
 *
 * Pure and dependency-free.
 */

export const RAW_LOG_FIELD_CHAR_CAP = 16_000
const HEAD_CHARS = 12_000
const TAIL_CHARS = 3_000
/** Provider payloads come from JSON.parse (acyclic); the depth bound is a
 * pure runaway guard, deep enough for any real nesting (item.content[0].text
 * sits at depth 3). Strings truncate wherever they are reached. */
const MAX_WALK_DEPTH = 8
/** Prefer cutting on a newline within this window of each boundary so a
 * secret token (which never spans lines) can't be SPLIT across the head/tail
 * seam into fragments the redaction regexes no longer match. */
const CUT_ALIGN_WINDOW = 1_000

function alignedHeadEnd(value: string): number {
  const windowStart = HEAD_CHARS - CUT_ALIGN_WINDOW
  const nl = value.lastIndexOf('\n', HEAD_CHARS)
  return nl > windowStart ? nl : HEAD_CHARS
}

function alignedTailStart(value: string): number {
  const from = value.length - TAIL_CHARS
  const nl = value.indexOf('\n', from)
  return nl >= 0 && nl < from + CUT_ALIGN_WINDOW ? nl + 1 : from
}

function truncateField(value: string): string {
  if (value.length <= RAW_LOG_FIELD_CHAR_CAP) return value
  const headEnd = alignedHeadEnd(value)
  const tailStart = alignedTailStart(value)
  const elided = tailStart - headEnd
  return `${value.slice(0, headEnd)}\n… [raw log: ${elided.toLocaleString()} chars elided] …\n${value.slice(tailStart)}`
}

/**
 * Walk `data` (bounded depth — see MAX_WALK_DEPTH) and return a copy with
 * oversized string fields truncated. Returns the ORIGINAL reference when
 * nothing needed truncation, so the common small-payload path allocates
 * nothing.
 */
export function rawLogPayloadForStringify(data: unknown, depth = 0): unknown {
  if (typeof data === 'string') return truncateField(data)
  if (!data || typeof data !== 'object' || depth >= MAX_WALK_DEPTH) return data
  if (Array.isArray(data)) {
    let changed = false
    const next = data.map((entry) => {
      const out = rawLogPayloadForStringify(entry, depth + 1)
      if (out !== entry) changed = true
      return out
    })
    return changed ? next : data
  }
  let changed = false
  const record = data as Record<string, unknown>
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    const out = rawLogPayloadForStringify(value, depth + 1)
    next[key] = out
    if (out !== value) changed = true
  }
  return changed ? next : data
}
