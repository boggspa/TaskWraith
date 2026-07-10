import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { RightDockSurfaceSwitcher } from './RightDockSurfaceSwitcher'

describe('RightDockSurfaceSwitcher', () => {
  it('recognizes Home as the active first-class surface', () => {
    const html = renderToStaticMarkup(
      <RightDockSurfaceSwitcher
        tabs={[
          {
            id: 'home',
            label: 'Home',
            icon: <span>H</span>,
            enabled: true,
            group: 'session',
            hint: 'All sidebar destinations'
          },
          {
            id: 'run',
            label: 'Run',
            icon: <span>R</span>,
            enabled: true,
            group: 'session'
          }
        ]}
        activeTab="home"
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).toContain('aria-label="Current surface: Home. Choose a surface"')
    expect(html).toContain('right-dock-switcher-label">Home</span>')
  })
})
