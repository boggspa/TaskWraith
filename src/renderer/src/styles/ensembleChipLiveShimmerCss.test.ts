import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/09-ensemble-work-session.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const readStrip = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/components/EnsembleParticipantsAboveRow.tsx'),
    'utf8'
  )

/** `@keyframes text-shimmer-sweep` lives with the transcript FX and is shared by
 * six call sites (working label, reasoning ladder, theme-picker overrides…), so
 * the chip may only tune ITS OWN side of the loop equation — never the frames. */
const sweepKeyframeStops = (): { from: number; to: number } => {
  const css = readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/02-transcript-messages-fx.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')
  const start = css.indexOf('@keyframes text-shimmer-sweep')
  expect(start, 'shared sweep keyframes').toBeGreaterThanOrEqual(0)
  const frames = css.slice(start, css.indexOf('\n}', start))
  const stops = [...frames.matchAll(/background-position:\s*(-?[\d.]+)%/g)].map((m) => Number(m[1]))
  expect(stops, 'a from- and a to- position').toHaveLength(2)
  return { from: stops[0], to: stops[1] }
}

const liveShimmerBlock = (): string =>
  blockAt(
    chipStateSection(readCss()),
    '.ensemble-above-chip.is-live-shimmer .ensemble-above-chip-role'
  )

/** How many whole highlight passes one animation cycle contains — the number
 * that turns a duration into a perceived cadence. */
const sweepLaps = (): number => {
  const declared = /background-size:\s*([\d.]+)%/.exec(liveShimmerBlock())
  expect(declared, 'declared background-size').not.toBeNull()
  const tiles = Number(declared![1]) / 100
  // `background-position` percentages resolve against (box − image), so with an
  // image WIDER than the box each 1% of position buys (tiles − 1)% of box
  // travel, against a repeating tile `tiles` box-widths wide.
  const { from, to } = sweepKeyframeStops()
  return ((Math.abs(from - to) / 100) * (tiles - 1)) / tiles
}

/** The live/failed chip-state section: from the shimmer rule to the
 * hover-tooltip block that follows it in source order. */
const chipStateSection = (css: string): string => {
  const start = css.indexOf('.ensemble-above-chip.is-live-shimmer')
  expect(start, 'live shimmer selector').toBeGreaterThanOrEqual(0)
  const end = css.indexOf('custom chip hover tooltip', start)
  expect(end, 'tooltip comment after the state section').toBeGreaterThan(start)
  return css.slice(start, end)
}

/** First declaration block at/after `marker` (single rule, no nesting). */
const blockAt = (source: string, marker: string): string => {
  const start = source.indexOf(marker)
  expect(start, `marker ${marker}`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', start)
  return source.slice(start, source.indexOf('}', open) + 1)
}

describe('ensemble chip live shimmer CSS', () => {
  it('sweeps the shared text-shimmer through the live role name', () => {
    const block = blockAt(
      chipStateSection(readCss()),
      '.ensemble-above-chip.is-live-shimmer .ensemble-above-chip-role'
    )
    // Reuses the transcript "Working…" keyframes rather than a private copy.
    expect(block).toContain('animation: text-shimmer-sweep')
    expect(block).toContain('background-clip: text')
    expect(block).toContain('-webkit-background-clip: text')
    expect(block).toContain('-webkit-text-fill-color: transparent')
    // Provider hue carries via currentColor from the per-provider role rules
    // above — no per-provider gradient fan-out.
    expect(block).toContain('color-mix(in srgb, currentColor')
    // Only the glyph PAINT may go transparent. `color: transparent` would
    // resolve currentColor to transparent, erasing the gradient AND the
    // currentColor-stroked leading SVGs (crown / hat / stage icon).
    expect(block).not.toMatch(/(?<!fill-)color: transparent/)
  })

  it('loops seamlessly — the sweep travels a whole number of gradient tiles', () => {
    const laps = sweepLaps()
    // The gradient repeats, so a FRACTIONAL lap count leaves the tile mid-sweep
    // when the animation restarts: the highlight snaps backwards every cycle —
    // which reads as "it gets partway and starts over". 260% gave 2.09 laps.
    expect(Math.abs(laps - Math.round(laps)), `laps = ${laps}`).toBeLessThan(0.005)
    expect(Math.round(laps), 'at least one full pass per cycle').toBeGreaterThanOrEqual(1)
  })

  it('sweeps at a calm pace, at constant speed across the loop point', () => {
    const shorthand = /animation:\s*text-shimmer-sweep\s+([\d.]+)s\s+(\S+)/.exec(liveShimmerBlock())
    expect(shorthand, 'sweep animation shorthand').not.toBeNull()
    // Duration alone is NOT the cadence — `background-size` decides how many
    // passes fit in a cycle, so the two must be pinned together. The chip
    // inherited the transcript working label's 2.4s over 2.09 laps (≈1.15s per
    // pass) and a whole strip of them read as frantic; this holds it at the
    // app's slow tier (`.digit-odometer__cell`, 4.6s over ~1.98 laps ≈ 2.32s).
    const secondsPerPass = Number(shorthand![1]) / sweepLaps()
    expect(secondsPerPass, 'seconds per highlight pass').toBeGreaterThanOrEqual(2.2)
    // A whole-tile loop is not enough on its own: `ease-in-out` parks the sweep
    // at zero velocity on BOTH ends, so it still stalls and lurches at the
    // restart. Constant velocity is what makes the seam disappear.
    expect(shorthand![2], 'timing function').toBe('linear')
  })

  it('replaces the old text-shadow glow outright', () => {
    const css = readCss()
    expect(css).not.toContain('is-live-glow')
    expect(css).not.toContain('is-failed-glow')
    expect(css).not.toContain('ensemble-chip-role-live-glow')
    // No glow of any kind in the live/failed state section — the strip's
    // provider tints clash with halo effects.
    expect(chipStateSection(css)).not.toContain('text-shadow')
  })

  it('re-mixes the sweep toward theme ink on light themes, specificity-neutral', () => {
    const section = chipStateSection(readCss())
    const light = blockAt(section, ':where([data-theme="light"]')
    expect(light).toContain('.ensemble-above-chip.is-live-shimmer .ensemble-above-chip-role')
    // Ink-based hotspot: a white flash washes out on near-white surfaces.
    expect(light).toContain('var(--text-primary)')
    expect(light).not.toContain('white')
    expect(light).not.toContain('#fff')
  })

  it('re-inks the failed chip leading identity icon in the trailing triangle red', () => {
    const css = readCss()
    const failed = blockAt(chipStateSection(css), '.ensemble-above-chip.is-failed-accent')
    for (const target of [
      '.ensemble-above-chip-stage-badge',
      '.ensemble-above-chip-stage-icon',
      '.ensemble-above-chip-crown',
      '.ensemble-above-chip-captain-hat'
    ]) {
      expect(failed, `failed accent covers ${target}`).toContain(target)
    }
    // Exactly the trailing `.status-failed` triangle mix, so the two marks
    // read as one system.
    const statusFailed = blockAt(css, '.ensemble-above-chip-status.status-failed')
    const dangerMix = 'color-mix(in srgb, var(--danger, #c44a4a) 85%, var(--text-primary))'
    expect(statusFailed).toContain(dangerMix)
    expect(failed).toContain(dangerMix)
    // The crown/hat drop-shadow halos would read as a gold/silver glow around
    // a red icon — flattened while the failure accent holds.
    expect(failed).toContain('filter: none')
  })

  it('stills the sweep under BOTH reduce-motion signals with an opaque fill', () => {
    const section = chipStateSection(readCss())
    const media = section.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(media, 'prefers-reduced-motion block').toBeGreaterThanOrEqual(0)
    const mediaBlock = blockAt(
      section.slice(media),
      '.ensemble-above-chip.is-live-shimmer .ensemble-above-chip-role'
    )
    const attrBlock = blockAt(
      section,
      ':root[data-reduce-motion="true"] .ensemble-above-chip.is-live-shimmer .ensemble-above-chip-role'
    )
    for (const block of [mediaBlock, attrBlock]) {
      expect(block).toContain('animation: none')
      expect(block).toContain('background-image: none')
      // A stranded transparent fill with no gradient behind it erases the
      // label outright (the epic-FX-shell lesson from the reasoning ladder).
      expect(block).toContain('-webkit-text-fill-color: currentColor')
    }
    // The attribute-signal rule must sit after the light-theme remix so its
    // `background-image: none` wins the source-order tiebreak.
    expect(section.indexOf(':root[data-reduce-motion="true"]')).toBeGreaterThan(
      section.indexOf(':where([data-theme="light"]')
    )
  })

  it('drives both states from the renamed chip classes in the strip', () => {
    const strip = readStrip()
    expect(strip).toContain("'is-live-shimmer'")
    expect(strip).toContain("'is-failed-accent'")
    expect(strip).not.toContain('is-live-glow')
    expect(strip).not.toContain('is-failed-glow')
  })
})
