/**
 * UserMessageCollapse — pure helpers for deciding when a user message in the
 * transcript should be truncated, and for building the collapsed preview.
 *
 * Why this matters: long pasted briefs dominate the transcript scroll viewport
 * and push later assistant output off-screen. Collapsing them by default keeps
 * the conversation legible while preserving full content behind a "Show more"
 * toggle.
 *
 * The thresholds are intentionally generous: most ordinary prompts stay
 * uncollapsed, and only the heavy briefs (multi-paragraph plans, code dumps,
 * spec documents) get clipped.
 */

export interface UserMessageCollapseThresholds {
  /** Lines beyond this trigger collapse. */
  readonly maxLines: number
  /** Characters beyond this trigger collapse. */
  readonly maxChars: number
  /** Lines shown when collapsed. */
  readonly previewLines: number
  /** Characters shown when collapsed. */
  readonly previewChars: number
}

/**
 * Default thresholds: a message over 12 lines or 800 chars collapses, and the
 * preview shows 8 lines / 500 chars. Picked to cover typical pasted briefs
 * while keeping ordinary multi-sentence prompts intact.
 */
export const DEFAULT_USER_MESSAGE_COLLAPSE_THRESHOLDS: UserMessageCollapseThresholds = {
  maxLines: 12,
  maxChars: 800,
  previewLines: 8,
  previewChars: 500
}

function countLines(content: string): number {
  if (content.length === 0) return 0
  // Splitting on \n counts an N-line block as N lines even without a trailing
  // newline — that matches what a reader visually sees in the bubble.
  return content.split('\n').length
}

/**
 * Returns true when the message should be rendered in collapsed form.
 * Whitespace-only or empty strings never collapse: there is nothing to hide.
 */
export function shouldCollapseUserMessage(
  content: string,
  thresholds: UserMessageCollapseThresholds = DEFAULT_USER_MESSAGE_COLLAPSE_THRESHOLDS
): boolean {
  if (typeof content !== 'string') return false
  if (content.trim().length === 0) return false
  if (content.length > thresholds.maxChars) return true
  if (countLines(content) > thresholds.maxLines) return true
  return false
}

/**
 * Trim a string to end at a word boundary at or before `maxChars`.
 * Falls back to a hard cut if there is no whitespace in the run, so we never
 * exceed the budget.
 */
function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, maxChars)
  // Look for the last whitespace inside the slice. The match position is the
  // index of the trailing whitespace+word run we want to drop. Anything > 0
  // is a safe place to cut — we just need *some* word to remain in the
  // preview, otherwise the bubble would look empty.
  const lastWs = slice.search(/\s\S*$/)
  if (lastWs > 0) {
    return slice.slice(0, lastWs)
  }
  return slice
}

interface OpenMarkdownFence {
  /** The literal marker, including its full run length (for example `~~~~`). */
  readonly marker: string
  /** Offset where the marker starts in the preview. */
  readonly index: number
  /** Offset immediately after the marker. */
  readonly markerEnd: number
}

/**
 * Returns the opening marker from a fenced-code line. Keeping the marker's
 * exact character and length matters: a `~~~~` block may only be closed by
 * an equal-or-longer tilde fence, never by a short backtick fence.
 */
function markdownFenceMarker(line: string): string | null {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
  return match?.[1] || null
}

/**
 * Finds an opener left unmatched by this preview. This is deliberately
 * line-aware: literal ```/~~~ inside prose or code do not accidentally count
 * as block fences, and the two fence styles never close one another.
 */
function findUnclosedMarkdownFence(preview: string): OpenMarkdownFence | null {
  let offset = 0
  let open: OpenMarkdownFence | null = null

  for (const line of preview.split('\n')) {
    const marker = markdownFenceMarker(line)
    if (marker) {
      const markerIndex = offset + line.indexOf(marker)
      if (!open) {
        open = { marker, index: markerIndex, markerEnd: markerIndex + marker.length }
      } else {
        const closesOpenFence =
          marker[0] === open.marker[0] &&
          marker.length >= open.marker.length &&
          /^[ \t\r]*$/.test(line.slice(line.indexOf(marker) + marker.length))
        if (closesOpenFence) open = null
      }
    }
    offset += line.length + 1
  }

  return open
}

/**
 * A leading fence has no prose before it to fall back to. Close it
 * synthetically inside the existing preview budget instead of returning an
 * empty bubble or exposing an unterminated code block. If the line limit is
 * too small to include both fences, return a non-Markdown fallback.
 */
function closeLeadingMarkdownFencePreview(
  preview: string,
  fence: OpenMarkdownFence,
  thresholds: UserMessageCollapseThresholds
): string {
  const maxChars = Math.max(0, thresholds.previewChars)
  const closer = `\n${fence.marker}`
  const maxBodyChars = maxChars - closer.length

  // An extremely small custom budget cannot carry both a valid opener and
  // closer. Keep a non-empty, non-Markdown fallback rather than returning a
  // dangling fence (or a blank collapsed bubble).
  if (thresholds.previewLines < 2 || maxBodyChars < fence.markerEnd) {
    return 'Code block'.slice(0, maxChars)
  }

  let body = preview
  if (countLines(body) >= thresholds.previewLines) {
    const lastLineStart = body.lastIndexOf('\n')
    if (lastLineStart <= fence.index) return 'Code block'.slice(0, maxChars)
    body = body.slice(0, lastLineStart)
  }
  body = truncateAtWordBoundary(body, maxBodyChars).replace(/\s+$/, '')

  if (body.length < fence.markerEnd || countLines(body) >= thresholds.previewLines) {
    return 'Code block'.slice(0, maxChars)
  }
  return `${body}${closer}`
}

/**
 * Build the collapsed preview for a message that already passed
 * `shouldCollapseUserMessage`. The returned string is never longer than
 * `previewChars` and respects `previewLines` as a soft upper bound.
 *
 * The cut is taken at a word boundary so the preview reads as a coherent
 * sentence fragment, not "Lorem ips" mid-word.
 *
 * Markdown fences (both ``` and ~~~) are honoured: if the preview cut would
 * leave a fenced block unterminated, we step back to before the opening fence.
 * A leading fence has no preceding prose, so it receives a synthetic matching
 * closer within the preview budget instead of becoming an empty or broken
 * bubble.
 */
export function truncateUserMessagePreview(
  content: string,
  thresholds: UserMessageCollapseThresholds = DEFAULT_USER_MESSAGE_COLLAPSE_THRESHOLDS
): string {
  if (typeof content !== 'string' || content.length === 0) return ''

  const lines = content.split('\n')
  let byLines: string
  if (lines.length > thresholds.previewLines) {
    byLines = lines.slice(0, thresholds.previewLines).join('\n')
  } else {
    byLines = content
  }

  const byChars = truncateAtWordBoundary(byLines, thresholds.previewChars)

  // Guard against breaking a markdown code fence in half. For an ordinary
  // prose-led message, hide the partial block. When the message starts with a
  // fence, preserve a useful code preview by closing that opener synthetically.
  const unclosedFence = findUnclosedMarkdownFence(byChars)
  if (unclosedFence) {
    const beforeFence = byChars.slice(0, unclosedFence.index).replace(/\s+$/, '')
    if (beforeFence) return beforeFence
    return closeLeadingMarkdownFencePreview(byChars, unclosedFence, thresholds)
  }

  return byChars
}
