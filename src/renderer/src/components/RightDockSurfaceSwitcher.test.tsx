import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { RIGHT_DOCK_CANVAS_SURFACES, RightDockSurfaceSwitcher } from './RightDockSurfaceSwitcher'

describe('RightDockSurfaceSwitcher', () => {
  it('exposes every Canvas type as its own dock destination', () => {
    expect(RIGHT_DOCK_CANVAS_SURFACES.map((surface) => surface.label)).toEqual([
      'Browser',
      'Sketch Canvas',
      'Mesh Canvas',
      'Simulator Canvas'
    ])
  })

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
            id: 'files',
            label: 'Files',
            icon: <span>F</span>,
            enabled: true,
            group: 'work'
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

  it('shows a waiting surface on the closed header, not only inside the picker', () => {
    // The per-surface counts live in the picker, which is closed by default. A
    // stale sign-in that only announces itself to someone already looking for
    // it has not been announced at all.
    const html = renderToStaticMarkup(
      <RightDockSurfaceSwitcher
        tabs={[
          {
            id: 'home',
            label: 'Home',
            icon: <span>H</span>,
            enabled: true,
            group: 'session'
          },
          {
            id: 'logins',
            label: 'Logins',
            icon: <span>L</span>,
            enabled: true,
            badge: 2,
            group: 'work',
            hint: 'A saved sign-in needs you'
          }
        ]}
        activeTab="home"
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).toContain('right-dock-switcher-pending')
    expect(html).toContain('Choose a surface. Another surface needs you')
  })

  it('stays quiet when every saved sign-in is still good', () => {
    const html = renderToStaticMarkup(
      <RightDockSurfaceSwitcher
        tabs={[
          {
            id: 'home',
            label: 'Home',
            icon: <span>H</span>,
            enabled: true,
            group: 'session'
          },
          {
            id: 'logins',
            label: 'Logins',
            icon: <span>L</span>,
            enabled: true,
            badge: 0,
            group: 'work',
            hint: 'Sites you stay signed into'
          }
        ]}
        activeTab="home"
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).not.toContain('right-dock-switcher-pending')
    expect(html).not.toContain('needs you')
  })

  it('does not nag about the surface the user is already looking at', () => {
    const html = renderToStaticMarkup(
      <RightDockSurfaceSwitcher
        tabs={[
          {
            id: 'logins',
            label: 'Logins',
            icon: <span>L</span>,
            enabled: true,
            badge: 2,
            group: 'work'
          }
        ]}
        activeTab="logins"
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).not.toContain('right-dock-switcher-pending')
  })
})
