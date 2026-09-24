/**
 * Tail buffer for captured child-process output.
 *
 * The capture path used to do this per data chunk:
 *
 *   stdout += chunk.toString()
 *   if (stdout.length > 80_000) stdout = stdout.slice(-80_000)
 *
 * `slice` forces the rope to flatten and allocates a fresh limit-sized string
 * on EVERY chunk once past the cap. At 1KB chunks against an 80KB cap that is
 * ~80x write amplification in both copying and garbage, inside a libuv stream
 * `onread` callback on the main process -- which is the exact stack the main
 * process was sampled burning in, and the exact stack it later died in under
 * memory shortage.
 *
 * Holding the chunks and flattening only when the buffer grows past twice the
 * limit makes compaction amortised O(1) per character: at most one flatten per
 * `limit` characters ingested, instead of one per chunk. The visible result is
 * unchanged -- `value()` is the last `limit` characters, exactly as before.
 */
export const CAPTURED_OUTPUT_LIMIT = 80_000

export class CapturedOutputBuffer {
  private chunks: string[] = []
  private length = 0
  private compactionCount = 0

  constructor(private readonly limit: number = CAPTURED_OUTPUT_LIMIT) {}

  push(text: string): void {
    if (!text) return
    this.chunks.push(text)
    this.length += text.length
    // Twice the limit is the headroom that makes this amortised: every
    // compaction discards at least `limit` characters, so the cost of the
    // flatten is spread over at least that many pushes' worth of input.
    if (this.length > this.limit * 2) this.compact()
  }

  /** The last `limit` characters ingested. */
  value(): string {
    if (this.chunks.length !== 1 || this.length > this.limit) this.compact()
    return this.chunks[0] ?? ''
  }

  /** Visible for tests: how many times the buffer had to flatten. */
  get compactions(): number {
    return this.compactionCount
  }

  private compact(): void {
    this.compactionCount += 1
    const joined = this.chunks.join('')
    const trimmed = joined.length > this.limit ? joined.slice(-this.limit) : joined
    this.chunks = [trimmed]
    this.length = trimmed.length
  }
}
