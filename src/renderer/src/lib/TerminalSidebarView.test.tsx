import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceRecord } from '../../../main/store/types'
import type { TerminalRecipe } from './TerminalSidebarStore'
import { TerminalSidebarContent } from './TerminalSidebarView'

const workspaces = [
  {
    id: 'workspace-alpha',
    path: '/repos/alpha',
    displayName: 'Alpha',
    createdAt: 1,
    lastOpenedAt: 2,
    pinned: false
  },
  {
    id: 'workspace-beta',
    path: '/repos/beta',
    displayName: 'Beta',
    createdAt: 1,
    lastOpenedAt: 2,
    pinned: false
  }
] as WorkspaceRecord[]

const recipes: TerminalRecipe[] = [
  {
    id: 'recent-older',
    workspacePath: '/repos/alpha',
    command: 'npm test',
    lastUsedAt: 10,
    pinned: false
  },
  {
    id: 'pinned',
    workspacePath: '/repos/beta',
    command: 'npm run dev',
    lastUsedAt: 20,
    pinned: true
  },
  {
    id: 'recent-newer',
    workspacePath: '/repos/beta',
    command: 'git status',
    lastUsedAt: 30,
    pinned: false
  }
]

function renderSidebar() {
  return renderToStaticMarkup(
    <TerminalSidebarContent
      workspaces={workspaces}
      recipes={recipes}
      runningSessions={[{ sessionId: 'session-alpha', workspacePath: '/repos/alpha' }]}
      onLaunch={vi.fn()}
      onAttach={vi.fn()}
      onKill={vi.fn()}
    />
  )
}

describe('TerminalSidebarContent', () => {
  it('renders individually headed sections in the Chat and Code sidebar hierarchy', () => {
    const html = renderSidebar()
    const runningIndex = html.indexOf('>Running</h4>')
    const pinnedIndex = html.indexOf('>Pinned</h4>')
    const recentsIndex = html.indexOf('>Recents</h4>')
    const workspacesIndex = html.indexOf('>Workspaces</h4>')

    expect(runningIndex).toBeGreaterThan(-1)
    expect(runningIndex).toBeLessThan(pinnedIndex)
    expect(pinnedIndex).toBeLessThan(recentsIndex)
    expect(recentsIndex).toBeLessThan(workspacesIndex)
    expect(html).not.toContain('segmented-control')
    expect(html.match(/terminal-sidebar-section/g)).toHaveLength(4)
  })

  it('uses compact single-column copy and preserves attach and kill actions', () => {
    const html = renderSidebar()

    expect(html).toContain('terminal-sidebar-row-copy')
    expect(html).toContain('terminal-sidebar-row-title')
    expect(html).toContain('terminal-sidebar-row-detail')
    expect(html).toContain('npm run dev')
    expect(html).toContain('/repos/alpha')
    expect(html).toContain('aria-label="Attach to terminal session — Alpha"')
    expect(html).toContain('aria-label="Kill terminal session — Alpha"')
  })

  it('sorts recent recipes newest first without folding pinned recipes into Recents', () => {
    const html = renderSidebar()
    const recentsMarkup = html.slice(
      html.indexOf('>Recents</h4>'),
      html.indexOf('>Workspaces</h4>')
    )

    expect(recentsMarkup.indexOf('git status')).toBeLessThan(recentsMarkup.indexOf('npm test'))
    expect(recentsMarkup).not.toContain('npm run dev')
  })
})
