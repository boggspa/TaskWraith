import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WelcomeHeatmaps, welcomeHeatmapDirectionForDrag } from './WelcomeHeatmaps'

describe('welcomeHeatmapDirectionForDrag', () => {
  it('maps left drags to the previous panel and right drags to the next panel', () => {
    expect(welcomeHeatmapDirectionForDrag(-72, 4)).toBe('prev')
    expect(welcomeHeatmapDirectionForDrag(72, 4)).toBe('next')
  })

  it('ignores short or mostly vertical drags', () => {
    expect(welcomeHeatmapDirectionForDrag(-20, 2)).toBeNull()
    expect(welcomeHeatmapDirectionForDrag(70, 90)).toBeNull()
  })
})

describe('WelcomeHeatmaps', () => {
  it('marks multi-slot single layouts as swipe-enabled', () => {
    const html = renderToStaticMarkup(
      <WelcomeHeatmaps
        layout="single"
        slots={[
          { key: 'alpha', node: <div>Alpha</div> },
          { key: 'beta', node: <div>Beta</div> }
        ]}
      />
    )

    expect(html).toContain('welcome-standalone-heatmaps--single')
    expect(html).toContain('is-swipe-enabled')
    expect(html).toContain('Alpha')
    expect(html).not.toContain('Beta')
  })
})
