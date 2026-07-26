/**
 * Shared diff line tone → CSS class mapping.
 *
 * Two transcript surfaces render tool output that is really a diff: the full
 * `ActivityRow` detail panel (`ActivityPreview`) and, at compact density, the
 * one-line `CompactToolTrace` foldout. They used to disagree — the full row
 * accented +/- lines, the compact foldout rendered the same patch as one plain
 * `<pre>` — so the identical edit read as a diff in one density and as flat
 * text in the other. The mapping lives here so a third surface can't drift the
 * same way.
 *
 * The class names are deliberately the pre-existing `activity-diff-line-*`
 * ones: the CSS carries the add/delete signal three ways (text hue, background
 * tint, left accent bar) off the per-theme `--diff-*` tokens, and one rule set
 * serving every surface is the point.
 */

export type DiffTone = 'diff' | 'addition' | 'deletion' | 'neutral'

/**
 * Per-line class for a block of text rendered under `tone`.
 *
 * - `diff` — a unified diff: `+` adds, `-` deletes, everything else context.
 *   `+++`/`---` file headers stay context (they are not content lines).
 * - `addition` / `deletion` — a block that IS wholly added or removed (an
 *   Edit's new_string / old_string). Every non-empty line takes the tone;
 *   a line carrying the OPPOSITE marker falls back to context rather than
 *   asserting a change direction the block doesn't have.
 * - `neutral` — not a diff; all context.
 */
export function diffToneLineClass(line: string, tone: DiffTone = 'neutral'): string {
  const prefix = line[0]

  if (tone === 'diff') {
    if (prefix === '+' && !line.startsWith('+++')) return 'activity-diff-line-add'
    if (prefix === '-' && !line.startsWith('---')) return 'activity-diff-line-delete'
    return 'activity-diff-line-context'
  }

  if (tone === 'addition') {
    if (!line) return 'activity-diff-line-context'
    if (prefix === '-' && !line.startsWith('---')) return 'activity-diff-line-context'
    return 'activity-diff-line-add'
  }

  if (tone === 'deletion') {
    if (!line) return 'activity-diff-line-context'
    if (prefix === '+' && !line.startsWith('+++')) return 'activity-diff-line-context'
    return 'activity-diff-line-delete'
  }

  return 'activity-diff-line-context'
}

/** True when `tone` produces any accented line — i.e. worth splitting per line. */
export function isAccentedDiffTone(tone: DiffTone | undefined): boolean {
  return tone === 'diff' || tone === 'addition' || tone === 'deletion'
}

/**
 * Cap on lines rendered as individual accented spans. Accenting costs one DOM
 * node per line, so a pathological multi-thousand-line patch would otherwise
 * trade a readability win for a transcript-wide render stall. Past the cap the
 * caller keeps its flat rendering — over-long output is already behind a
 * scroll box, and correctness beats colour at that size.
 */
export const MAX_ACCENTED_DIFF_LINES = 600

/**
 * Whether a block of tool output is a unified diff, so a section that was only
 * ever labelled "Result" can still be accented.
 *
 * Deliberately strict — it demands a real diff marker (`diff --git`, an `@@`
 * hunk header, or a `---`/`+++` file-header pair). A loose "starts with + or -"
 * test would paint ordinary bullet lists and shell output red and green, which
 * is a worse failure than leaving a diff flat.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (!text) return false
  if (/^diff --git /m.test(text)) return true
  if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text)) return true
  return /^--- /m.test(text) && /^\+\+\+ /m.test(text)
}
