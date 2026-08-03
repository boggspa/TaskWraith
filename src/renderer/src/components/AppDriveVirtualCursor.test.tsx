import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AppDriveVirtualCursor } from './AppDriveVirtualCursor'

describe('AppDriveVirtualCursor', () => {
  it('renders a display-only overlay at normalized coordinates', () => {
    const html = renderToStaticMarkup(
      <AppDriveVirtualCursor point={{ x: 0.25, y: 0.75, label: 'click' }} />
    )
    expect(html).toContain('data-testid="appdrive-virtual-cursor"')
    expect(html).toContain('data-cursor-role="display-only"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('--appdrive-cursor-x:25%')
    expect(html).toContain('--appdrive-cursor-y:75%')
    expect(html).toContain('click')
    expect(html).toContain('does not move the Mac pointer')
  })

  it('omits the overlay when hidden or out of bounds', () => {
    expect(renderToStaticMarkup(<AppDriveVirtualCursor point={null} />)).toBe('')
    expect(
      renderToStaticMarkup(<AppDriveVirtualCursor point={{ x: 0.5, y: 0.5 }} visible={false} />)
    ).toBe('')
    expect(renderToStaticMarkup(<AppDriveVirtualCursor point={{ x: 1.2, y: 0.5 }} />)).toBe('')
  })
})
