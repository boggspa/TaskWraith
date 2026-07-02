import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProjectsSidebarView, normalizeProjectCreateName } from './ProjectsSidebarView'

describe('ProjectsSidebarView', () => {
  it('normalizes inline project creation names before writing to the store', () => {
    expect(normalizeProjectCreateName('  Client Work  ')).toBe('Client Work')
    expect(normalizeProjectCreateName('   ')).toBeNull()
  })

  it('renders the Projects header with the standard sidebar chevron hook', () => {
    const html = renderToStaticMarkup(
      <ProjectsSidebarView
        chats={[]}
        currentChat={null}
        searchQuery=""
        isSearchActive={false}
        onSelectChat={() => undefined}
      />
    )

    expect(html).toContain('sidebar-projects-header')
    expect(html).toContain('sidebar-tree-chevron is-expanded')
    expect(html).toContain('<h4 class="sidebar-section-title">Projects</h4>')
    expect(html).toContain('class="sidebar-section-header-action sidebar-project-create"')
    expect(html).toContain('class="sidebar-project-create-large"')
  })
})
