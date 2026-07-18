import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ProjectHomeHeader } from './ProjectHomeHeader'
import type { Project } from '../lib/projectsStore'

const project: Project = {
  schemaVersion: 1,
  id: 'project-a',
  name: 'Release Readiness',
  icon: { iconKind: 'seed', seed: 'project-a' },
  hue: 200,
  parentId: null,
  order: 1,
  memberChatIds: ['chat-home'],
  createdAt: 1,
  updatedAt: 2
}

describe('ProjectHomeHeader', () => {
  it('presents the project desk for the claimed home chat', () => {
    const html = renderToStaticMarkup(
      <ProjectHomeHeader
        project={project}
        isHome
        brief="Ship the Work surface."
        referenceCount={3}
        attentionCount={2}
        onOpenLibrary={() => undefined}
      />
    )
    expect(html).toContain('Release Readiness')
    expect(html).toContain('Project Home')
    expect(html).toContain('project-home-header-chip is-home')
    expect(html).toContain('Ship the Work surface.')
    expect(html).toContain('Library · 3')
    expect(html).toContain('project-home-header-attention')
    expect(html).toContain('aria-label="Open Release Readiness reference library (3 references)"')
  })

  it('presents member threads without home styling, brief, or attention badge', () => {
    const html = renderToStaticMarkup(
      <ProjectHomeHeader
        project={project}
        isHome={false}
        referenceCount={1}
        attentionCount={0}
        onOpenLibrary={() => undefined}
      />
    )
    expect(html).toContain('Project thread')
    expect(html).not.toContain('is-home')
    expect(html).not.toContain('project-home-header-brief')
    expect(html).not.toContain('project-home-header-attention')
    expect(html).toContain('(1 reference)')
  })
})
