import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  createSkyDiffCloudFlight,
  createSkyMegaDeleteDiffCloudFlight,
  getNextSkyDiffCloudTiming,
  getNextSkyMegaDeleteDiffCloudTiming,
  getNextSkyUfoTiming,
  SkyWeatherVisual,
  type HostWeatherVisualState
} from './FxLayers'

const weather = (isDay: boolean): HostWeatherVisualState => ({
  kind: 'clear',
  description: isDay ? 'Clear day' : 'Clear night',
  isDay,
  updatedAt: '2026-06-30T03:00:00.000Z',
  source: 'fallback'
})

describe('SkyWeatherVisual', () => {
  it('keeps the existing sky orb as the day sun asset', () => {
    const html = renderToStaticMarkup(<SkyWeatherVisual weather={weather(true)} />)

    expect(html).toContain('sky-day')
    expect(html).toContain('sky-orb')
    expect(html).not.toContain('sky-moon-crescent')
  })

  it('renders a dedicated crescent moon for night skies', () => {
    const html = renderToStaticMarkup(<SkyWeatherVisual weather={weather(false)} />)

    expect(html).toContain('sky-night')
    expect(html).toContain('sky-moon')
    expect(html).toContain('sky-moon-crescent')
    expect(html).toContain('sky-orb')
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
