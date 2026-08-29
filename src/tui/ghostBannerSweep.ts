/**
 * The diagonal shimmer sweep over the home-frame Monoline Ghost.
 *
 * `ghostBanner.ts` composes the art and is forbidden colour; `theme.ts` owns
 * every motion and tone token. This module is the third piece: it takes banner
 * rows and paints a travelling highlight across them. It holds no state and no
 * design literals — the frame counter arrives from the caller, and every blend
 * amount comes from `TUI_MOTION`.
 *
 * Two decisions are worth stating, because both are invisible once it works.
 *
 * **The phase is `column + row`, not `column`.** A per-row sweep is the
 * existing `shimmerWorking` shape, and it is right for a single line of text.
 * Run over an 11-row block it lights a full-height vertical bar, which reads as
 * a scanner passing over the mark rather than as light travelling along it. The
 * diagonal costs nothing and is the whole difference between the two.
 *
 * **Cells are emitted in runs, not one at a time.** There are only three blend
 * buckets, and along any one row they can appear in at most four runs, so a row
 * needs at most four colour escapes rather than one per cell. At the home
 * frame's repaint rate a per-cell implementation would push several kilobytes
 * of escapes per second at a terminal that is otherwise idle. It would look
 * identical, which is exactly why the cheaper form has to be the one in the
 * file.
 *
 * The visible geometry is load-bearing and asserted by the tests:
 * `stripAnsi(sweep(line)) === line` for every row. `render.ts` centres the
 * banner as a block by centring each row on its own visible width, so a sweep
 * that changed a row's width by even one cell would shear the mark apart.
 */

import { mixHex, type Ansi } from './ansi'
import { TUI_MOTION, TUI_TONE } from './theme'

export interface GhostBannerSweepRequest {
  /** Banner rows to paint. Every row shares one visible width. */
  lines: readonly string[]
  /** Colour writer for the surface. */
  ansi: Ansi
  /** Monotonic animation frame. Advances one step per sweep interval. */
  frame: number
  /**
   * False under `--no-animation`. `NO_COLOR` and non-TTY arrive separately via
   * `ansi.enabled`; both fall through to the same still banner.
   */
  enabled: boolean
  /** Tone the mark rests at between sweeps. Defaults to the ensemble accent. */
  accent?: string
}

/**
 * Frames in one full sweep: the longest diagonal across the block, plus the
 * quiet tail that separates one pass from the next.
 */
export function ghostBannerSweepLoopLength(lines: readonly string[]): number {
  const rows = lines.length
  const columns = lines.reduce((widest, line) => Math.max(widest, Array.from(line).length), 0)
  if (rows === 0 || columns === 0) return 1
  return columns + rows - 1 + TUI_MOTION.bannerSweepTailPadding
}

/**
 * Paint one frame of the sweep. Returns one string per input row, each still
 * exactly as wide as the row it came from.
 */
export function sweepGhostBanner(request: GhostBannerSweepRequest): string[] {
  const accent = request.accent ?? TUI_TONE.ensemble
  // A still banner is the correct output, not a degraded one: under `NO_COLOR`
  // the heavy stroke is what carries the mark, and it is already drawn.
  if (!request.ansi.enabled || !request.enabled) {
    return request.lines.map((line) => request.ansi.provider(line, accent))
  }

  // A non-finite frame would make every distance NaN, and NaN fails both
  // bucket comparisons — so the mark would render at its resting tone and the
  // sweep would look like a feature that was never wired up. Resting is the
  // right output; arriving at it silently is not.
  const frame = Number.isFinite(request.frame) ? Math.trunc(request.frame) : 0
  const loopLength = ghostBannerSweepLoopLength(request.lines)
  const peak = mixHex(accent, TUI_TONE.highlight, TUI_MOTION.shimmerPeak)
  const mid = mixHex(accent, TUI_TONE.highlight, TUI_MOTION.shimmerMid)

  return request.lines.map((line, row) => {
    const cells = Array.from(line)
    let painted = ''
    let run = ''
    let runHex = ''
    for (let column = 0; column < cells.length; column += 1) {
      const phase = column + row - frame
      const distance = ((phase % loopLength) + loopLength) % loopLength
      const hex = distance <= 1 ? peak : distance === TUI_MOTION.shimmerFalloff ? mid : accent
      if (hex !== runHex) {
        if (run) painted += request.ansi.color(run, runHex)
        run = ''
        runHex = hex
      }
      run += cells[column]
    }
    if (run) painted += request.ansi.color(run, runHex)
    // Bold wraps the row once. Per-cell bolding would double the escape budget
    // the run-coalescing above exists to protect.
    return request.ansi.bold(painted)
  })
}
