import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SkyWeatherVisual, type HostWeatherVisualState } from './FxLayers'

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
})
