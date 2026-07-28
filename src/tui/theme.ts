/**
 * TaskWraith TUI design tokens.
 *
 * This module is the single source of truth for every width-, glyph-, and
 * colour-level design decision the terminal surface makes. `render.ts` should
 * consume these tokens rather than branching on inline literals.
 *
 * Three rules govern this file:
 *
 * 1. Provider identity carries the colour; transcript prose stays neutral.
 *    Semantic tones below are for *state*, never for message bodies.
 * 2. Terminal-native only. No desktop affordance (hover, glass, motion depth,
 *    stacked modals) gets a token here — if it can't be expressed in a static
 *    cell grid it does not belong in the TUI.
 * 3. Every glyph must degrade. A terminal without UTF-8 is a supported
 *    terminal, exactly as a terminal without colour is.
 */

import { taskWraithProviderAccent } from '../shared/taskWraithProviderPresentation'

/* -------------------------------------------------------------------------
 * Semantic palette
 * ---------------------------------------------------------------------- */

/**
 * State tones. These are deliberately few: the TUI communicates state through
 * glyph + weight first and hue second, so that a NO_COLOR terminal loses
 * decoration rather than meaning.
 */
export const TUI_TONE = {
  good: '#55B985',
  warning: '#D49A47',
  error: '#D45B62',
  /** Shared accent for ensemble chrome (baton, roster, ghost mark). */
  ensemble: taskWraithProviderAccent('ensemble'),
  /** Blend target for the working shimmer and the reasoning ladder. */
  highlight: '#F4EEF7'
} as const

export type TuiToneName = keyof typeof TUI_TONE

/** Tone vocabulary usable by status text (`tone()` in render.ts). */
export type TuiSemanticTone = 'neutral' | 'good' | 'warning' | 'error'

export function tuiToneHex(tone: TuiSemanticTone): string | undefined {
  if (tone === 'good') return TUI_TONE.good
  if (tone === 'warning') return TUI_TONE.warning
  if (tone === 'error') return TUI_TONE.error
  return undefined
}

/* -------------------------------------------------------------------------
 * Glyph vocabulary
 * ---------------------------------------------------------------------- */

/**
 * Every glyph the chrome draws, named by MEANING rather than by shape.
 *
 * Naming by meaning is the point. The pre-token renderer used `◌` for three
 * unrelated states (queued thread, next seat, running tool), which made the
 * status ladders impossible to read consistently. Slots below are distinct
 * even where two of them may resolve to the same character.
 */
export interface TuiGlyphSet {
  /** The TaskWraith mark. */
  ghost: string

  // Run / seat status ladder.
  statusActive: string
  statusNext: string
  statusQueued: string
  statusPending: string
  statusDone: string
  statusFailed: string
  statusSkipped: string
  statusSleeping: string
  statusNeedsInput: string

  // Tool + thinking blocks.
  toolRunning: string
  toolDone: string
  toolFailed: string
  thinkingRunning: string
  thinkingSettled: string

  // Composer + selection.
  promptCaret: string
  cursor: string
  newline: string
  ellipsis: string
  selection: string
  separator: string

  // Tune lens (model/reasoning + seats).
  /** An ensemble seat that is enabled for upcoming rounds. */
  seatEnabled: string
  /** An ensemble seat that is disabled (kept on the roster, skipped). */
  seatDisabled: string
  /** A staged model/reasoning change that applies on the next send. */
  pendingChange: string

  // Reasoning ladder.
  reasoningOn: string
  reasoningOff: string

  // Empty-state sky.
  star: string

  // Box drawing.
  boxTopLeft: string
  boxTopRight: string
  boxBottomLeft: string
  boxBottomRight: string
  boxHorizontal: string
  boxVertical: string
}

export const TUI_GLYPHS_UNICODE: TuiGlyphSet = {
  ghost: 'ᜊ',

  statusActive: '●',
  statusNext: '›',
  statusQueued: '◌',
  statusPending: '·',
  statusDone: '✓',
  statusFailed: '×',
  statusSkipped: '–',
  statusSleeping: '◷',
  statusNeedsInput: '!',

  toolRunning: '◌',
  toolDone: '✓',
  toolFailed: '×',
  thinkingRunning: '◌',
  thinkingSettled: '◇',

  promptCaret: '›',
  cursor: '▏',
  newline: '↵',
  ellipsis: '…',
  selection: '›',
  separator: '·',

  seatEnabled: '■',
  seatDisabled: '□',
  pendingChange: '→',

  reasoningOn: '✦',
  reasoningOff: '·',

  star: '✦',

  boxTopLeft: '┌',
  boxTopRight: '┐',
  boxBottomLeft: '└',
  boxBottomRight: '┘',
  boxHorizontal: '─',
  boxVertical: '│'
}

/**
 * ASCII degradation. Every entry is exactly one column wide so that the
 * width arithmetic in `ansi.ts` (`visibleWidth`, `padAnsi`, composer viewport
 * slicing) is identical across glyph sets.
 */
export const TUI_GLYPHS_ASCII: TuiGlyphSet = {
  ghost: '*',

  statusActive: '@',
  statusNext: '>',
  statusQueued: 'o',
  statusPending: '.',
  statusDone: '+',
  statusFailed: 'x',
  statusSkipped: '-',
  statusSleeping: 'z',
  statusNeedsInput: '!',

  toolRunning: 'o',
  toolDone: '+',
  toolFailed: 'x',
  thinkingRunning: 'o',
  thinkingSettled: '~',

  promptCaret: '>',
  cursor: '|',
  newline: '\\',
  ellipsis: '~',
  selection: '>',
  separator: '.',

  seatEnabled: 'x',
  seatDisabled: '.',
  pendingChange: '>',

  reasoningOn: '#',
  reasoningOff: '.',

  star: '.',

  boxTopLeft: '+',
  boxTopRight: '+',
  boxBottomLeft: '+',
  boxBottomRight: '+',
  boxHorizontal: '-',
  boxVertical: '|'
}

/**
 * Detect whether the terminal can be trusted with the Unicode chrome.
 *
 * We are conservative: a terminal must positively advertise UTF-8 to get the
 * Unicode set. Mis-rendered box drawing is a worse failure than plain ASCII,
 * because broken chrome reads as a broken app.
 */
export function detectTuiUnicode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TASKWRAITH_TUI_ASCII === '1') return false
  if (env.TERM === 'dumb' || env.TERM === 'linux') return false
  const locale = String(env.LC_ALL || env.LC_CTYPE || env.LANG || '').toLowerCase()
  return locale.includes('utf-8') || locale.includes('utf8')
}

export function resolveTuiGlyphs(unicode: boolean): TuiGlyphSet {
  return unicode ? TUI_GLYPHS_UNICODE : TUI_GLYPHS_ASCII
}

/* -------------------------------------------------------------------------
 * Unified status vocabulary
 * ---------------------------------------------------------------------- */

export type TuiRunStatus =
  | 'working'
  | 'next'
  | 'queued'
  | 'needs-input'
  | 'failed'
  | 'done'
  | 'skipped'
  | 'sleeping'
  | 'idle'

/**
 * One ladder, one meaning per glyph. Thread rows, ensemble seats, and tool
 * lines all resolve through here so the same state never wears two shapes.
 */
export function tuiStatusGlyph(status: TuiRunStatus, glyphs: TuiGlyphSet): string {
  switch (status) {
    case 'working':
      return glyphs.statusActive
    case 'next':
      return glyphs.statusNext
    case 'queued':
      return glyphs.statusQueued
    case 'needs-input':
      return glyphs.statusNeedsInput
    case 'failed':
      return glyphs.statusFailed
    case 'done':
      return glyphs.statusDone
    case 'skipped':
      return glyphs.statusSkipped
    case 'sleeping':
      return glyphs.statusSleeping
    default:
      return glyphs.statusPending
  }
}

export function tuiStatusTone(status: TuiRunStatus): TuiSemanticTone {
  if (status === 'failed') return 'error'
  if (status === 'needs-input') return 'warning'
  if (status === 'done') return 'good'
  return 'neutral'
}

/* -------------------------------------------------------------------------
 * Responsive density
 * ---------------------------------------------------------------------- */

/**
 * The three documented tiers. The README's contract is the design contract;
 * everything below derives from it instead of inventing new cut points.
 */
export type TuiDensityTier = 'compact' | 'normal' | 'expanded'

export const TUI_BREAKPOINTS = {
  /** Below this the surface uses a short semantic checksum. */
  normal: 72,
  /** At and above this identity labels expand. */
  expanded: 100
} as const

/** The smallest terminal the renderer commits to. */
export const TUI_MIN_COLUMNS = 24
export const TUI_MIN_ROWS = 8

/** Baseline target: everything must be legible here. */
export const TUI_BASELINE_COLUMNS = 80
export const TUI_BASELINE_ROWS = 24

export function tuiDensityTier(width: number): TuiDensityTier {
  if (width < TUI_BREAKPOINTS.normal) return 'compact'
  if (width < TUI_BREAKPOINTS.expanded) return 'normal'
  return 'expanded'
}

/**
 * Every width-dependent presentation decision, resolved once.
 *
 * Previously these were seven bare numbers (64, 72, 86, 88, 92, 100, 104)
 * scattered across six render functions, which is why the README's three-tier
 * contract had drifted from the implementation. Naming them here makes the
 * drift visible and reviewable.
 */
export interface TuiDensity {
  width: number
  tier: TuiDensityTier

  /** Show the provider's full display name rather than its short code. */
  providerFullName: boolean
  /** Show the model label in the HUD. */
  hudModel: boolean
  /** Draw the three-step reasoning ladder rather than a single spark. */
  reasoningLadder: boolean
  /** Show the expanded `ENSEMBLE <preset> · <mode>` baton label. */
  batonExpandedLabel: boolean
  /** How many seats the baton may name before collapsing to `+n`. */
  batonCastSlots: number
  /** Label column width inside bordered overlays. */
  overlayLabelWidth: number
  /** How much of the composer hint strip fits. */
  composerHints: 'none' | 'short' | 'full'
  /** Separator used between HUD segments. */
  segmentSpacing: 'tight' | 'padded'
}

export function resolveTuiDensity(width: number): TuiDensity {
  const safeWidth = Math.max(TUI_MIN_COLUMNS, Math.floor(width))
  const tier = tuiDensityTier(safeWidth)
  return {
    width: safeWidth,
    tier,
    providerFullName: tier !== 'compact',
    hudModel: tier !== 'compact',
    reasoningLadder: safeWidth >= 88,
    batonExpandedLabel: tier === 'expanded',
    batonCastSlots: safeWidth >= 104 ? 4 : safeWidth >= 86 ? 3 : 2,
    overlayLabelWidth: tier === 'compact' ? 9 : 12,
    composerHints: safeWidth >= 88 ? 'full' : safeWidth >= 64 ? 'short' : 'none',
    segmentSpacing: tier === 'compact' ? 'tight' : 'padded'
  }
}

/* -------------------------------------------------------------------------
 * Layout
 * ---------------------------------------------------------------------- */

/**
 * The transcript is the canvas; the footer is the only persistent chrome.
 * There is no masthead — the terminal's own title bar is the masthead.
 */
export const TUI_LAYOUT = {
  /** Footer rows for a solo thread: HUD + composer. */
  soloFooterRows: 2,
  /** Footer rows for an ensemble thread: baton + HUD + composer. */
  ensembleFooterRows: 3,
  /** Left gutter for transcript speaker + prose. */
  transcriptGutter: 1,
  /** Left gutter for indented tool / thinking lines. */
  transcriptDetailGutter: 2,
  /** Minimum prose column before wrapping gives up. */
  minProseWidth: 12
} as const

/* -------------------------------------------------------------------------
 * Motion
 * ---------------------------------------------------------------------- */

/**
 * The TUI has exactly one animation: a shimmer sweep across the working mark.
 * It is state-bound (live runs only) and disabled by NO_COLOR, `--no-animation`,
 * and any non-TTY. Nothing animates while idle, and nothing else animates ever.
 */
export const TUI_MOTION = {
  /** Cells either side of the sweep head that receive partial highlight. */
  shimmerFalloff: 2,
  /** Blend amount at the sweep head. */
  shimmerPeak: 0.65,
  /** Blend amount one cell behind the head. */
  shimmerMid: 0.28,
  /** Trailing gap so the sweep reads as a loop rather than a scroll. */
  shimmerTailPadding: 5
} as const
