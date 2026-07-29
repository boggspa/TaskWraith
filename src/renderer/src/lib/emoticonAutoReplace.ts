/**
 * 1.0.5 — Classic-emoticon → emoji auto-replacement for the composer.
 *
 * Pure planner: given the draft value AFTER a space was typed and the
 * caret position (immediately after that space), decide whether the
 * token before the space is a convertible emoticon and produce the
 * replaced draft + adjusted caret. The component layer
 * (`Composer.tsx` onChange) applies the plan through the normal
 * draft pipeline, so the replacement behaves exactly like typing:
 * the string is the single source of truth and both the textarea and
 * the highlight overlay re-render from it. No overlay/metric surface
 * is touched — this cannot desync the caret.
 *
 * Conversion fires ONLY on a just-typed space (the caller gates on
 * `InputEvent.inputType === 'insertText' && data === ' '`), never on
 * paste, IME composition, or send. A one-shot Backspace immediately
 * after a conversion restores the literal emoticon (see
 * `composerEmoticonRevertRef` in Composer.tsx).
 *
 * Boundary rules:
 *   - The emoticon must start the draft, a line, or follow
 *     whitespace: `1<3` and `word:)` never convert.
 *   - Nothing converts inside inline code or fenced code blocks
 *     (backtick-parity + fence-line tracking below) — this is a dev
 *     tool; `:-)` inside a snippet is content, not sentiment.
 */

interface EmoticonReplacementPlan {
  /** Full draft with the emoticon replaced (typed space preserved). */
  value: string
  /** Caret position after the replacement (UTF-16 units). */
  caret: number
  /** Start offset of the replaced emoticon in the original draft. */
  replacedStart: number
  /** The literal emoticon that was replaced (for tests/telemetry). */
  emoticon: string
}

/**
 * Slack-style classic set. Longest-first matching is enforced at
 * module init so `</3` wins over `<3` and `:-)` over `:)`.
 * Keep this list boring: every entry must be unambiguous at a
 * whitespace boundary. (`xD`, `8)`, `D:` are deliberately absent —
 * they collide with prose and identifiers.)
 */
const EMOTICON_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [':-)', '🙂'],
  [':)', '🙂'],
  [':-D', '😄'],
  [':D', '😄'],
  [':-(', '🙁'],
  [':(', '🙁'],
  [';-)', '😉'],
  [';)', '😉'],
  [':-P', '😛'],
  [':P', '😛'],
  [':-p', '😛'],
  [':p', '😛'],
  [':-O', '😮'],
  [':O', '😮'],
  [':-o', '😮'],
  [':o', '😮'],
  [":'(", '😢'],
  [':-/', '😕'],
  [':/', '😕'],
  [':-|', '😐'],
  [':|', '😐'],
  ['</3', '💔'],
  ['<3', '❤️']
]

const ORDERED_REPLACEMENTS = [...EMOTICON_REPLACEMENTS].sort(
  (left, right) => right[0].length - left[0].length
)

const FENCE_LINE_REGEX = /^\s{0,3}```/

/**
 * Is `index` inside a code context — on/inside a fenced block, or in
 * the odd half of a line's single-backtick parity? Mirrors the
 * pragmatic rules in `composerMarkdownHighlight.ts` without pulling
 * that module in (this one stays dependency-free for testing).
 */
function isInsideCodeContext(value: string, index: number): boolean {
  let fenceOpen = false
  let lineStart = 0
  while (lineStart <= index) {
    const newlineAt = value.indexOf('\n', lineStart)
    const lineEnd = newlineAt === -1 ? value.length : newlineAt
    const isFenceLine = FENCE_LINE_REGEX.test(value.slice(lineStart, lineEnd))
    if (index <= lineEnd) {
      // On a fence line itself, or on any line while a fence is open:
      // conservative skip — never convert inside code.
      if (isFenceLine || fenceOpen) return true
      let backticks = 0
      for (let i = lineStart; i < index; i++) {
        if (value.charCodeAt(i) === 96 /* ` */) backticks++
      }
      return backticks % 2 === 1
    }
    if (isFenceLine) fenceOpen = !fenceOpen
    if (newlineAt === -1) break
    lineStart = newlineAt + 1
  }
  return false
}

/**
 * Plan an emoticon → emoji replacement for a draft where the user
 * just typed a space. `caret` is the position immediately AFTER that
 * space. Returns null when nothing should convert.
 */
export function planEmoticonAutoReplace(
  value: string,
  caret: number
): EmoticonReplacementPlan | null {
  if (caret < 2 || caret > value.length) return null
  if (value[caret - 1] !== ' ') return null
  const beforeSpace = value.slice(0, caret - 1)
  for (const [emoticon, emoji] of ORDERED_REPLACEMENTS) {
    if (!beforeSpace.endsWith(emoticon)) continue
    const start = beforeSpace.length - emoticon.length
    // Left boundary: start of draft, or whitespace (incl. newline).
    if (start > 0 && !/\s/.test(value[start - 1])) continue
    if (isInsideCodeContext(value, start)) continue
    return {
      value: `${value.slice(0, start)}${emoji}${value.slice(caret - 1)}`,
      caret: start + emoji.length + 1,
      replacedStart: start,
      emoticon
    }
  }
  return null
}
