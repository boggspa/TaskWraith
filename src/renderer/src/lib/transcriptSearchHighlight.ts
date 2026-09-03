/**
 * In-chat search (Cmd+F) match painting for the transcript.
 *
 * The search bar counts matches per MESSAGE (`currentChatSearch.ts`) and jumps
 * between them; this module is the other half — it paints the query inside the
 * transcript text the reader is actually looking at.
 *
 * It uses the CSS Custom Highlight API (`CSS.highlights` + `Range` +
 * `::highlight()`) rather than splicing `<mark>` elements into the rendered
 * markdown. That is deliberate and load-bearing:
 *
 * - The transcript is virtualised and rows are cached as built JSX
 *   (`rowElementCacheRef`), with two further memo layers below
 *   (`MarkdownMessage`, `StableMarkdownBlock`) that exist specifically so a
 *   streaming delta does not re-parse a whole message. Making the highlight a
 *   function of the markdown source would have to invalidate all three on
 *   every keystroke — exactly the work those layers were built to avoid.
 * - `Range`s never mutate the DOM, so a row that re-renders (streaming delta,
 *   or the virtualiser remounting it) can never hand React a node it does not
 *   own, and a syntax-highlighted code block's token spans stay intact.
 *
 * Ranges are rebuilt from scratch on every pass, so a stale `Range` into an
 * unmounted row can never linger.
 */

/** Registry key for every match currently painted. */
export const TRANSCRIPT_SEARCH_HIGHLIGHT_NAME = 'thread-search-match'
/** Registry key for the one match the "N / M" counter is pointing at. */
export const TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT_NAME = 'thread-search-match-active'

/**
 * Rendered subtrees a text walk must not enter — none of them are prose the
 * reader searched. Code (inline and fenced) is deliberately NOT excluded:
 * highlighting there is safe precisely because nothing is mutated.
 */
const HIGHLIGHT_SKIPPED_SELECTOR = 'script, style, textarea, input, svg'

/**
 * `CSS.highlights` is maplike, but lib.dom only types `forEach` on
 * `HighlightRegistry`, so the two methods this module needs are named here
 * rather than asserted away at every call site.
 */
type HighlightRegistryLike = {
  set: (name: string, highlight: Highlight) => void
  delete: (name: string) => void
}

export interface TranscriptSearchHighlightPass {
  /** The transcript scroller; rows are found under it by `data-vrow-id`. */
  scroller: HTMLElement | null | undefined
  /** Raw query straight from the search input. */
  query: string
  /** `rowKey`s of currently MOUNTED rows that the matcher counted as hits. */
  rowKeys: readonly string[]
  /** The active match's `rowKey`, when it happens to be mounted. */
  activeRowKey?: string | null
}

/** Case-insensitive, non-overlapping occurrences of `needle` in `haystack`. */
export function findQueryOccurrences(
  haystack: string,
  needle: string
): Array<{ start: number; end: number }> {
  if (!haystack || !needle) return []
  const hay = haystack.toLowerCase()
  const query = needle.toLowerCase()
  const found: Array<{ start: number; end: number }> = []
  let from = 0
  for (;;) {
    const index = hay.indexOf(query, from)
    if (index < 0) return found
    found.push({ start: index, end: index + query.length })
    from = index + query.length
  }
}

/**
 * The query as the DOM walk should look for it. The counter's own normaliser
 * additionally collapses internal whitespace runs; collapsing here would
 * desynchronise offsets from the text node, so this only trims.
 */
export function normalizeTranscriptHighlightQuery(query: string): string {
  return query.trim()
}

function highlightRegistry(): HighlightRegistryLike | null {
  if (typeof CSS === 'undefined' || typeof Highlight === 'undefined') return null
  const registry = (CSS as unknown as { highlights?: unknown }).highlights
  if (!registry) return null
  return registry as HighlightRegistryLike
}

function escapeSelectorValue(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}

/** Drop both highlight registrations. Safe to call when none were made. */
export function clearTranscriptSearchHighlights(): void {
  const registry = highlightRegistry()
  if (!registry) return
  registry.delete(TRANSCRIPT_SEARCH_HIGHLIGHT_NAME)
  registry.delete(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT_NAME)
}

function collectRangesInRow(row: HTMLElement, query: string, out: Range[]): void {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (!parent || parent.closest(HIGHLIGHT_SKIPPED_SELECTOR)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const { start, end } of findQueryOccurrences(node.nodeValue || '', query)) {
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      out.push(range)
    }
  }
}

/**
 * Repaint every mounted match. Returns the number of ranges painted, which is
 * per-OCCURRENCE and so is deliberately NOT the search bar's per-message count.
 */
export function applyTranscriptSearchHighlights({
  scroller,
  query,
  rowKeys,
  activeRowKey
}: TranscriptSearchHighlightPass): number {
  const registry = highlightRegistry()
  if (!registry) return 0
  const needle = normalizeTranscriptHighlightQuery(query)
  if (!scroller || !needle || rowKeys.length === 0) {
    clearTranscriptSearchHighlights()
    return 0
  }
  const all: Range[] = []
  const active: Range[] = []
  for (const rowKey of rowKeys) {
    const row = scroller.querySelector<HTMLElement>(
      `[data-vrow-id="${escapeSelectorValue(rowKey)}"]`
    )
    if (!row) continue
    const before = all.length
    collectRangesInRow(row, needle, all)
    if (rowKey === activeRowKey) active.push(...all.slice(before))
  }
  if (all.length === 0) {
    clearTranscriptSearchHighlights()
    return 0
  }
  registry.set(TRANSCRIPT_SEARCH_HIGHLIGHT_NAME, new Highlight(...all))
  if (active.length > 0) {
    const activeHighlight = new Highlight(...active)
    // The active ranges are a SUBSET of `all`, so the two highlights overlap.
    // Priority (not registration order) is what makes the active style win.
    activeHighlight.priority = 1
    registry.set(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT_NAME, activeHighlight)
  } else {
    registry.delete(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT_NAME)
  }
  return all.length
}
