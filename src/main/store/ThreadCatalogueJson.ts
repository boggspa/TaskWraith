/** JSON encoding for the decoder isolate: never allocate a transcript-sized string or buffer. */
function* quoted(value: string): Generator<string> {
  yield '"'
  for (let start = 0; start < value.length; ) {
    let end = Math.min(value.length, start + 8192)
    const last = value.charCodeAt(end - 1)
    const next = value.charCodeAt(end)
    if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
      end -= 1
    yield JSON.stringify(value.slice(start, end)).slice(1, -1)
    start = end
  }
  yield '"'
}

function* pieces(value: unknown, seen: Set<object>, inArray = false): Generator<string> {
  if (value === null) {
    yield 'null'
    return
  }
  if (typeof value === 'string') {
    yield* quoted(value)
    return
  }
  if (typeof value === 'number') {
    yield Number.isFinite(value) ? String(value) : 'null'
    return
  }
  if (typeof value === 'boolean') {
    yield String(value)
    return
  }
  if (typeof value === 'bigint') throw new TypeError('Cannot encode a BigInt as JSON')
  if (typeof value !== 'object') {
    if (inArray) {
      yield 'null'
      return
    }
    throw new TypeError('Cannot encode an undefined JSON value')
  }
  if (seen.has(value)) throw new TypeError('Cannot encode cyclic history as JSON')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      yield '['
      for (let index = 0; index < value.length; index += 1) {
        if (index) yield ','
        yield* pieces(value[index], seen, true)
      }
      yield ']'
    } else {
      yield '{'
      let first = true
      for (const key of Object.keys(value)) {
        const entry = (value as Record<string, unknown>)[key]
        if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol')
          continue
        if (!first) yield ','
        first = false
        yield* quoted(key)
        yield ':'
        yield* pieces(entry, seen)
      }
      yield '}'
    }
  } finally {
    seen.delete(value)
  }
}

/** The yielded buffers own their ArrayBuffers and can be transferred with backpressure. */
export function* encodeThreadJsonChunks(
  value: unknown,
  maxBytes = 48 * 1024
): Generator<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 48 * 1024)
    throw new RangeError('Invalid history chunk budget')
  let buffer = new Uint8Array(maxBytes)
  let used = 0
  for (const piece of pieces(value, new Set())) {
    const encoded = Buffer.from(piece, 'utf8')
    for (let offset = 0; offset < encoded.byteLength; ) {
      const count = Math.min(maxBytes - used, encoded.byteLength - offset)
      buffer.set(encoded.subarray(offset, offset + count), used)
      offset += count
      used += count
      if (used === maxBytes) {
        yield buffer
        buffer = new Uint8Array(maxBytes)
        used = 0
      }
    }
  }
  if (used) yield buffer.slice(0, used)
}
