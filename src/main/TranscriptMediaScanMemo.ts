import type { ChatMessage } from './store/types'

/**
 * Remembers which transcript rows provably need no media normalisation.
 *
 * `normalizeTranscriptMarkdownMediaForChat` runs on EVERY chat save, and its
 * per-row guard is `content.includes('![')`. On the 2026-09-11 thread that is a
 * 1.65 MB substring scan across 1,493 rows — and that thread took 6,254
 * persistence revisions, ~4.19 saves per visible transcript row. The scan is
 * O(whole transcript) on the main thread, per save, forever, and it sits
 * directly in front of the work that makes a row visible.
 *
 * Whether a row needs normalisation is a pure function of the row object: its
 * role, its content, and its own `metadata.mediaRefs`. Grants, workspaces and
 * ownership can all change underneath it, but none of them can turn a row with
 * no image syntax and no managed refs into one that has them — only a new row
 * object can. So the answer is memoisable against object identity, and rows are
 * replaced rather than mutated when they change.
 *
 * A WeakSet is the right container precisely because it holds no transcript
 * alive: entries vanish with the records that own them, so a long session
 * cannot accumulate a second copy of every thread it has ever saved. That also
 * means a miss is always safe — the caller simply does the scan it would have
 * done anyway.
 */
export class TranscriptMediaScanMemo {
  private readonly inert = new WeakSet<ChatMessage>()
  private hits = 0
  private misses = 0

  /** True when this exact row object was already proven to need no rewrite. */
  isInert(message: ChatMessage | null | undefined): boolean {
    if (!message || typeof message !== 'object') return false
    if (this.inert.has(message)) {
      this.hits += 1
      return true
    }
    this.misses += 1
    return false
  }

  markInert(message: ChatMessage | null | undefined): void {
    if (!message || typeof message !== 'object') return
    this.inert.add(message)
  }

  /**
   * Index of the first row that still has to be inspected, or -1 when every
   * row is known inert.
   *
   * -1 lets the caller return the record untouched without allocating a
   * replacement array — which is the whole point on a transcript where the
   * answer is "nothing to do" thousands of times in a row.
   */
  firstUnknownIndex(messages: readonly ChatMessage[]): number {
    for (let index = 0; index < messages.length; index += 1) {
      if (!this.isInert(messages[index])) return index
    }
    return -1
  }

  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses }
  }

  resetStats(): void {
    this.hits = 0
    this.misses = 0
  }
}
