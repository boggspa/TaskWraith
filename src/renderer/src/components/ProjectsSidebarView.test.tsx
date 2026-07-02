import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProjectsSidebarView } from './ProjectsSidebarView'

describe('ProjectsSidebarView', () => {
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
  })
})
