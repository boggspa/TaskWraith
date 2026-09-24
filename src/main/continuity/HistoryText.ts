/** Bounded text projection of captured tool values. No whole-result JSON/Buffer copies. */
export const HISTORY_READ_MAX_BYTES = 8_192
const CHUNK_CHARS = 1_024
const JSON_ENVELOPE_MAX_CHARS = 128 * 1_024

function* stringChunks(text: string): Generator<string> {
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + CHUNK_CHARS)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    yield text.slice(start, end)
    start = end
  }
}

function* quotedChunks(text: string): Generator<string> {
  yield '"'
  for (const chunk of stringChunks(text)) yield JSON.stringify(chunk).slice(1, -1)
  yield '"'
}

export interface HistoryTextProjection {
  omitted: boolean
  visited: number
}

function* valueChunks(
  value: unknown,
  state: HistoryTextProjection,
  depth = 0,
  plainString = true,
  parents = new Set<object>()
): Generator<string> {
  if (value === undefined && plainString) return
  state.visited += 1
  if (depth > 24 || state.visited > 65_536) {
    state.omitted = true
    yield '"[history projection traversal limit]"'
    return
  }
  if (typeof value === 'string') {
    // Historical providers may wrap their JSON result in a string, including
    // nested result/output/content strings. Parse only bounded envelopes.
    const start = value.slice(0, 256).trimStart()
    if (start.startsWith('[') || start.startsWith('{')) {
      if (value.length > JSON_ENVELOPE_MAX_CHARS) {
        state.omitted = true
        yield '"[large encoded tool envelope omitted]"'
        return
      }
      try {
        const parsed: unknown = JSON.parse(value)
        state.omitted = true // Parsed envelopes are a projection, not verbatim text.
        yield* valueChunks(parsed, state, depth + 1, false, parents)
        return
      } catch {
        // Ordinary tool text that resembles JSON remains ordinary text.
      }
    }
    yield* plainString ? stringChunks(value) : quotedChunks(value)
    return
  }
  if (!value || typeof value !== 'object') {
    yield JSON.stringify(value) ?? 'null'
    return
  }
  if (parents.has(value)) {
    state.omitted = true
    yield '"[circular value omitted]"'
    return
  }
  const record = value as Record<string, unknown>
  if (['image', 'audio', 'thinking', 'redacted_thinking'].includes(String(record.type || ''))) {
    state.omitted = true
    yield '{"omitted":"non-text content"}'
    return
  }
  parents.add(value)
  try {
    let first = true
    const array = Array.isArray(value)
    yield array ? '[' : '{'
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      if (state.visited > 65_536) {
        state.omitted = true
        break
      }
      if (['signature', 'encrypted_content', 'image_url', 'audio_url'].includes(key)) {
        state.omitted = true
        continue
      }
      const item = record[key]
      if (!array && item === undefined) continue
      if (!first) yield ','
      first = false
      if (!array) {
        yield* quotedChunks(key)
        yield ':'
      }
      yield* valueChunks(item, state, depth + 1, false, parents)
    }
    yield array ? ']' : '}'
  } finally {
    parents.delete(value)
  }
}

function pageChunks(
  chunks: Iterable<string>,
  offset: number,
  maxBytes: number
): {
  text: string
  offset: number
  nextOffset?: number
  totalBytes?: number
} {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid history offset.')
  const parts: Buffer[] = []
  let traversed = 0
  let length = 0
  let hasMore = false
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk)
    if (traversed + bytes.length <= offset) {
      traversed += bytes.length
      continue
    }
    const start = Math.max(0, offset - traversed)
    if ((bytes[start] & 0xc0) === 0x80) {
      throw new Error('History offset must address a UTF-8 character boundary in this record.')
    }
    let end = Math.min(bytes.length, start + maxBytes - length)
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1
    parts.push(bytes.subarray(start, end))
    length += end - start
    if (end < bytes.length) {
      hasMore = true
      break
    }
    traversed += bytes.length
  }
  if (!hasMore && offset > traversed) throw new Error('History offset exceeds this record.')
  return {
    text: Buffer.concat(parts, length).toString('utf8'),
    offset,
    ...(hasMore ? { nextOffset: offset + length } : { totalBytes: traversed })
  }
}

function pageLimit(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
    throw new Error('History byte limits must be whole numbers of at least four bytes.')
  }
  return Math.min(maxBytes, HISTORY_READ_MAX_BYTES)
}

export function historyTextPage(text: string, offset = 0, maxBytes = 2_048) {
  return pageChunks(stringChunks(text), offset, pageLimit(maxBytes))
}

export function historyValuePage(value: unknown, offset = 0, maxBytes = 2_048) {
  const state = { omitted: false, visited: 0 }
  const page = pageChunks(valueChunks(value, state), offset, pageLimit(maxBytes))
  return { ...page, textProjection: true, omittedContent: state.omitted }
}

export function historyValueText(value: unknown): string {
  return historyValuePage(value, 0, HISTORY_READ_MAX_BYTES).text
}
