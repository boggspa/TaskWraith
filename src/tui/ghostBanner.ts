/**
 * The Monoline Ghost front-page banner.
 *
 * This module is deliberately pure: it takes a terminal size plus a glyph
 * variant and returns lines. It imports nothing, holds no state, and never
 * touches ANSI — `render.ts` owns colour, `theme.ts` owns tokens.
 *
 * The art is a hand-authored transcription of
 * `design-assets/ghost/ghost-guy-mark-monoline.svg`, which is a monoline mark
 * with four features worth preserving in a character grid:
 *
 *   1. a rounded crown that flares outward rather than a flat cap,
 *   2. two *rectangular* eyes (not dots) sitting symmetrically about centre,
 *   3. a pleated hem rather than a straight bottom edge, and
 *   4. three wisps trailing below that hem.
 *
 * The SVG's hem is an irregular wave (two deep valleys and one shallow one).
 * That irregularity is below the resolution of a 21-column raster, so the hem
 * is regularised to three evenly spaced pleats. The four features above are
 * what make the mark recognisable; sub-cell wave asymmetry is not.
 *
 * Two invariants hold for every row of every variant, and both are asserted by
 * `render.test.ts`:
 *
 *   - Every row is exactly `GHOST_BANNER_COLUMNS` code points wide. `render.ts`
 *     centres the banner as a *block*, and it can only do that by centring each
 *     row independently if all rows share one visible width.
 *   - Every character is printable and single-column. `visibleWidth()` counts
 *     code points, so a double-width or combining character would silently
 *     desynchronise the whole frame.
 */

/** Visible width of every banner row, in terminal columns. */
export const GHOST_BANNER_COLUMNS = 21

/** Number of rows in the full banner. */
export const GHOST_BANNER_ROWS = 11

/**
 * Columns the full banner needs before it is worth drawing: the art itself
 * plus two columns of margin on each side. Below this the home screen falls
 * back to the single-character mark, exactly as it did before the banner
 * existed.
 */
export const GHOST_BANNER_MIN_COLUMNS = GHOST_BANNER_COLUMNS + 4

/**
 * Rows the home screen spends on chrome beneath the banner: the wordmark, the
 * connection status, the hint strip, and the blank row separating each. The
 * banner is suppressed rather than clipped when it cannot coexist with them.
 */
export const GHOST_BANNER_CHROME_ROWS = 6

/** Rows the terminal must have before the full banner is drawn. */
export const GHOST_BANNER_MIN_ROWS = GHOST_BANNER_ROWS + GHOST_BANNER_CHROME_ROWS

/**
 * Box-drawing transcription. Box Drawing (U+2500..U+257F) is already the
 * chrome vocabulary in `theme.ts`, so this introduces no new font dependency.
 */
const GHOST_BANNER_UNICODE: readonly string[] = [
  '      ╭───────╮      ',
  '     ╱         ╲     ',
  '   ╱             ╲   ',
  '  │               │  ',
  '  │  ┌──┐   ┌──┐  │  ',
  '  │  │  │   │  │  │  ',
  '  │  └──┘   └──┘  │  ',
  '  │               │  ',
  '  ╰──┬────┬────┬──╯  ',
  '     │    │    │     ',
  '     ╵    ╵    ╵     '
]

/**
 * Pure-ASCII degradation, on the same grid and with the same feature set. A
 * terminal without UTF-8 is a supported terminal (theme.ts rule 3), and `tw
 * --ascii` must produce this variant rather than a mojibaked one.
 */
const GHOST_BANNER_ASCII: readonly string[] = [
  '      .-------.      ',
  '     /         \\     ',
  '   /             \\   ',
  '  |               |  ',
  '  |  +--+   +--+  |  ',
  '  |  |  |   |  |  |  ',
  '  |  +--+   +--+  |  ',
  '  |               |  ',
  "  '--+----+----+--'  ",
  '     |    |    |     ',
  "     '    '    '     "
]

export type GhostBannerVariant = 'unicode' | 'ascii'

export interface GhostBannerRequest {
  /** Terminal columns available to the home screen. */
  width: number
  /** Terminal rows available to the home screen canvas. */
  height: number
  /** Which glyph vocabulary the surface is drawing with. */
  variant: GhostBannerVariant
  /**
   * The single-character mark to fall back to when the banner does not fit.
   * Supplied by the caller so this module stays free of theme imports.
   */
  markGlyph: string
}

export interface GhostBanner {
  /** `full` is the art; `mark` is the one-glyph fallback. */
  kind: 'full' | 'mark'
  /** Rows to draw. Every row shares `width`. */
  lines: readonly string[]
  /** Visible width shared by every row. */
  width: number
}

export function ghostBannerArt(variant: GhostBannerVariant): readonly string[] {
  return variant === 'ascii' ? GHOST_BANNER_ASCII : GHOST_BANNER_UNICODE
}

/**
 * Resolve the banner for a given terminal. The fallback is a suppression, not
 * a clip: a half-drawn ghost reads as a broken app, whereas the bare mark is
 * the surface's established narrow-terminal identity.
 */
export function resolveGhostBanner(request: GhostBannerRequest): GhostBanner {
  const width = Math.floor(request.width)
  const height = Math.floor(request.height)
  if (width >= GHOST_BANNER_MIN_COLUMNS && height >= GHOST_BANNER_MIN_ROWS) {
    return {
      kind: 'full',
      lines: ghostBannerArt(request.variant),
      width: GHOST_BANNER_COLUMNS
    }
  }
  const mark = request.markGlyph || '*'
  return { kind: 'mark', lines: [mark], width: Array.from(mark).length }
}
