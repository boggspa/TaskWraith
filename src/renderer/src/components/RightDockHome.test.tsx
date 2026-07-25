import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { RIGHT_DOCK_HOME_DESTINATIONS, RightDockHome } from './RightDockHome'

describe('RightDockHome', () => {
  it('defines every requested destination and route in order', () => {
    expect(
      RIGHT_DOCK_HOME_DESTINATIONS.map((destination) => [
        destination.id,
        destination.label,
        destination.target.surface,
        destination.target.surface === 'inspector' ? destination.target.inspectorTab : undefined
      ])
    ).toEqual([
      ['run', 'Live Lanes', 'run', undefined],
      ['chat', 'Side Chats', 'chat', undefined],
      ['media', 'Media Attachments', 'media', undefined],
      ['pins', 'Pinned Messages', 'pins', undefined],
      ['files', 'File Editor', 'files', undefined],
      ['office', 'Office Suite', 'office', undefined],
      ['canvas', 'Canvas', 'canvas', undefined],
      ['diff', 'Diff Studio', 'inspector', 'diff'],
      ['candidates', 'Fan-out Candidates', 'candidates', undefined],
      ['raw', 'Raw Events', 'inspector', 'raw'],
      ['invocations', 'Invocations', 'inspector', 'delegation'],
      ['timeline', 'Invocation Timeline', 'inspector', 'timeline'],
      ['live', 'Live Invocations', 'inspector', 'background-tasks'],
      ['safety', 'Safety', 'inspector', 'safety'],
      ['capabilities', 'Capabilities', 'inspector', 'capabilities']
    ])
  })

  it('renders a navigation landmark with all cards and contextual disabled states', () => {
    const html = renderToStaticMarkup(
      <RightDockHome
        mediaCount={3}
        pinnedCount={2}
        hasCurrentChat={false}
        hasWorkspaceContext={false}
        onOpenSurface={vi.fn()}
        onOpenInspector={vi.fn()}
      />
    )
    const destinationIds = Array.from(
      html.matchAll(/data-right-dock-home-destination="([^"]+)"/g),
      (match) => match[1]
    )

    expect(html).toContain('<nav')
    expect(html).toContain('aria-labelledby="right-dock-home-title"')
    expect(destinationIds).toEqual(RIGHT_DOCK_HOME_DESTINATIONS.map(({ id }) => id))
    expect(html.match(/<button/g)).toHaveLength(15)
    expect(html.match(/class="pill-card right-dock-home-card/g)).toHaveLength(15)
    expect(html.match(/class="pill-card-inner right-dock-home-card-inner"/g)).toHaveLength(15)
    expect(html).toContain('class="right-dock-home-content"')
    expect(html.match(/ disabled=""/g)).toHaveLength(6)
    expect(html).toMatch(/data-right-dock-home-destination="chat"[^>]*disabled=""/)
    expect(html).toContain('Side Chats. Linked branches and focused follow-ups')
    expect(html).toContain('Media Attachments. Images, audio, video, and paths. 3 items')
    expect(html).toContain('Pinned Messages. Notes and saved transcript items. 2 items')
  })

  it('enables chat and workspace cards when their context exists', () => {
    const html = renderToStaticMarkup(
      <RightDockHome
        mediaCount={0}
        pinnedCount={0}
        hasCurrentChat
        hasWorkspaceContext
        onOpenSurface={vi.fn()}
        onOpenInspector={vi.fn()}
      />
    )

    expect(html).not.toContain(' disabled=""')
  })
})
