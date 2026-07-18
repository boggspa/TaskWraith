import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  createSkyDiffCloudFlight,
  createSkyMegaDeleteDiffCloudFlight,
  getNextSkyDiffCloudTiming,
  getNextSkyMegaDeleteDiffCloudTiming,
  getNextSkyUfoTiming,
  LivingWorkspaceLayer,
  RunDataVizLayer,
  SkyWeatherVisual,
  type HostWeatherVisualState
} from './FxLayers'

// Cambridge coordinates + fixed instants keep the scene deterministic no
// matter when or where the suite runs (the component recomputes day/night
// from real solar elevation, not the snapshot's isDay flag).
const weather = (isDay: boolean): HostWeatherVisualState => ({
  kind: 'clear',
  description: isDay ? 'Clear day' : 'Clear night',
  isDay,
  updatedAt: '2026-06-30T03:00:00.000Z',
  source: 'open-meteo',
  latitude: 52.2,
  longitude: 0.1,
  cloudCoverPct: 5
})

const NOON_UTC = Date.UTC(2026, 5, 30, 12, 0)
const MIDNIGHT_UTC = Date.UTC(2026, 5, 30, 0, 30)
// The original regression instant: 20:33 BST with sunset at 21:11 BST.
const LATE_EVENING_SUN_UTC = Date.UTC(2026, 6, 17, 19, 33)

describe('SkyWeatherVisual', () => {
  it('keeps the existing sky orb as the day sun asset without invisible star work', () => {
    const html = renderToStaticMarkup(<SkyWeatherVisual weather={weather(true)} nowMs={NOON_UTC} />)

    expect(html).toContain('sky-day')
    expect(html).toContain('sky-orb')
    expect(html).toContain('sky-gradient')
    expect(html).not.toContain('sky-starfield')
    expect(html).not.toContain('sky-moon-disc')
  })

  it('renders a phase-accurate moon disc for night skies', () => {
    const html = renderToStaticMarkup(
      <SkyWeatherVisual weather={weather(false)} nowMs={MIDNIGHT_UTC} />
    )

    expect(html).toContain('sky-night')
    expect(html).toContain('sky-moon')
    expect(html).toContain('sky-moon-disc')
    expect(html).toContain('sky-moon-maria')
    expect(html).toContain('sky-orb')
  })

  it('projects the real bright-star catalog over dimmed dust when coords exist', () => {
    const withCoords = renderToStaticMarkup(
      <SkyWeatherVisual weather={weather(false)} nowMs={MIDNIGHT_UTC} />
    )
    expect(withCoords).toContain('sky-catalog-stars')
    expect(withCoords).toContain('sky-cat-star')
    expect(withCoords).toContain('is-major')
    expect(withCoords).toContain('sky-starfield is-dust')

    // Coordinate-free fallback: procedural dust only, at full strength.
    const { latitude: _lat, longitude: _lon, ...coordless } = weather(false)
    const withoutCoords = renderToStaticMarkup(
      <SkyWeatherVisual weather={coordless} nowMs={MIDNIGHT_UTC} />
    )
    expect(withoutCoords).not.toContain('sky-catalog-stars')
    expect(withoutCoords).not.toContain('is-dust')
  })

  it('lights the correct limb through the real lunar cycle', () => {
    // Three nights AFTER the 2024-04-08 eclipse (new moon): waxing — lit on
    // the right, highlight aimed right. Three nights BEFORE: waning — left.
    const waxingNight = Date.UTC(2024, 3, 11, 21, 0)
    const waningNight = Date.UTC(2024, 3, 5, 21, 0)

    const waxing = renderToStaticMarkup(
      <SkyWeatherVisual weather={weather(false)} nowMs={waxingNight} />
    )
    expect(waxing).toContain('sky-moon-disc')
    expect(waxing).toContain('cx="68%"')

    const waning = renderToStaticMarkup(
      <SkyWeatherVisual weather={weather(false)} nowMs={waningNight} />
    )
    expect(waning).toContain('sky-moon-disc')
    expect(waning).toContain('cx="32%"')
  })

  it('shows a sun — not a moon — while the UK evening sun is still up', () => {
    // The snapshot even claims night (stale isDay): real solar elevation wins.
    const html = renderToStaticMarkup(
      <SkyWeatherVisual weather={weather(false)} nowMs={LATE_EVENING_SUN_UTC} />
    )

    expect(html).toContain('sky-day')
    expect(html).not.toContain('sky-moon-disc')
    expect(html).toContain('sky-scene-golden')
  })

  it('offsets the diff-cloud pass from the UFO pass', () => {
    const bootedAt = 1_000
    const ufoLaunchAt = bootedAt + 60_000
    const diffLaunchAt = ufoLaunchAt + 20 * 60_000
    const megaDeleteLaunchAt = ufoLaunchAt + 30 * 60_000

    expect(getNextSkyUfoTiming(ufoLaunchAt, bootedAt).delayMs).toBe(0)
    expect(getNextSkyDiffCloudTiming(ufoLaunchAt, bootedAt).delayMs).toBeGreaterThan(10 * 60_000)
    expect(getNextSkyDiffCloudTiming(diffLaunchAt, bootedAt).delayMs).toBe(0)
    expect(getNextSkyUfoTiming(diffLaunchAt, bootedAt).delayMs).toBeGreaterThan(10 * 60_000)
    expect(getNextSkyMegaDeleteDiffCloudTiming(megaDeleteLaunchAt, bootedAt).delayMs).toBe(0)
    expect(getNextSkyMegaDeleteDiffCloudTiming(diffLaunchAt, bootedAt).delayMs).toBeGreaterThan(
      5 * 60_000
    )
  })

  it('generates scary floating diff deletions', () => {
    const flight = createSkyDiffCloudFlight(1)
    const additions = Number(flight.additions.replace(/[+,]/g, ''))
    const deletions = Number(flight.deletions.replace(/[-,]/g, ''))

    expect(deletions).toBeGreaterThan(additions)
    expect(flight.style).toMatchObject({
      '--sky-diff-duration': '58000ms'
    })
  })

  it('generates a separate tiny-addition / huge-deletion diff variant', () => {
    const flight = createSkyMegaDeleteDiffCloudFlight(1)
    const additions = Number(flight.additions.replace(/[+,]/g, ''))
    const deletions = Number(flight.deletions.replace(/[-,]/g, ''))

    expect(flight.variant).toBe('mega-delete')
    expect(additions).toBeLessThanOrEqual(24)
    expect(deletions).toBeGreaterThanOrEqual(125_000)
  })
})

describe('FX layer runtime budgets', () => {
  const countInlineCustomProperty = (html: string, property: string): number =>
    (html.match(new RegExp(`${property}:`, 'g')) || []).length

  it('keeps Epic living workspace denser than cinematic while skipping invisible weather particles', () => {
    const clearEpic = renderToStaticMarkup(
      <LivingWorkspaceLayer weather={weather(true)} intensity="epic" nowMs={NOON_UTC} />
    )
    const clearCinematic = renderToStaticMarkup(
      <LivingWorkspaceLayer weather={weather(true)} intensity="cinematic" nowMs={NOON_UTC} />
    )
    const stormEpic = renderToStaticMarkup(
      <LivingWorkspaceLayer
        weather={{ ...weather(false), kind: 'storm', description: 'Storm' }}
        intensity="epic"
        nowMs={MIDNIGHT_UTC}
      />
    )

    expect(countInlineCustomProperty(clearEpic, '--mote-index')).toBe(12)
    expect(countInlineCustomProperty(clearCinematic, '--mote-index')).toBe(8)
    expect(countInlineCustomProperty(clearEpic, '--particle-index')).toBe(0)
    expect(countInlineCustomProperty(stormEpic, '--particle-index')).toBe(10)
  })

  it('does not redraw run telemetry just because hidden raw-event progress changes', () => {
    const baseProps = {
      provider: 'codex' as const,
      intensity: 'epic' as const,
      queueCount: 3,
      approvalWaiting: false,
      status: 'running' as const
    }
    const quiet = renderToStaticMarkup(<RunDataVizLayer {...baseProps} rawEventCount={0} />)
    const noisy = renderToStaticMarkup(<RunDataVizLayer {...baseProps} rawEventCount={999} />)

    expect(noisy).toBe(quiet)
    expect(noisy).toContain('M8 92 H 76')
  })
})
