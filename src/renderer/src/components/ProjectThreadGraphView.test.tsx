import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ProjectThreadGraphView } from './ProjectThreadGraphView'
import {
  buildProjectThreadGraphProjection,
  type ProjectThreadGraphInput
} from '../lib/projectThreadGraphProjection'

const input: ProjectThreadGraphInput = {
  projectId: 'p1',
  projectName: 'Alpha',
  memberChatIds: ['a', 'b', 'c'],
  chats: [
    { appChatId: 'a', title: 'Design spec', provider: 'claude' },
    { appChatId: 'b', title: 'Implementation', parentChatId: 'a', parentChatRelation: 'subThread' },
    { appChatId: 'c', title: 'Review' }
  ],
  graphEdges: [
    { id: 'e1', projectId: 'p1', fromChatId: 'b', toChatId: 'c', kind: 'dependency', createdAt: 1 }
  ],
  runningChatIds: new Set(['b']),
  homeChatId: 'a'
}

describe('ProjectThreadGraphView', () => {
  it('renders the project title, thread nodes, stages, and dependency controls', () => {
    const projection = buildProjectThreadGraphProjection(input)
    const html = renderToStaticMarkup(
      <ProjectThreadGraphView
        projection={projection}
        projectName="Alpha"
        onAddDependency={() => {}}
        onRemoveDependency={() => {}}
        onOpenThread={() => {}}
      />
    )
    expect(html).toContain('Thread graph')
    expect(html).toContain('Alpha')
    expect(html).toContain('Design spec')
    expect(html).toContain('Implementation')
    expect(html).toContain('Review')
    expect(html).toContain('Roots')
    // Home + relation badges render.
    expect(html).toContain('Home')
    expect(html).toContain('Sub-thread')
    // The add-dependency picker renders for the selected (first) node.
    expect(html).toContain('This thread depends on')
    // Node/link counts summarised in the header.
    expect(html).toContain('3 threads')
  })

  it('shows the empty state when the project has no threads', () => {
    const projection = buildProjectThreadGraphProjection({ ...input, memberChatIds: [], chats: [] })
    const html = renderToStaticMarkup(
      <ProjectThreadGraphView projection={projection} projectName="Alpha" onBack={() => {}} />
    )
    expect(html).toContain('No threads yet')
  })
})
