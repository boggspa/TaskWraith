import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorkspaceRecord } from '../../../main/store/types'
import { WorkspaceBoardCreatorSheet } from './WorkspaceBoardCreatorSheet'

const workspace: WorkspaceRecord = {
  id: 'ws-1',
  path: '/repo',
  displayName: 'Test 1',
  lastOpenedAt: 1,
  createdAt: 1,
  pinned: false
}

describe('WorkspaceBoardCreatorSheet', () => {
  it('renders nothing while closed', () => {
    const html = renderToStaticMarkup(
      <WorkspaceBoardCreatorSheet
        open={false}
        workspaces={[workspace]}
        currentWorkspace={workspace}
        onCreate={() => {}}
        onDismiss={() => {}}
      />
    )

    expect(html).toBe('')
  })

  it('renders the workspace board creator as a main-pane sheet', () => {
    const html = renderToStaticMarkup(
      <WorkspaceBoardCreatorSheet
        open
        workspaces={[workspace]}
        currentWorkspace={workspace}
        onCreate={() => {}}
        onDismiss={() => {}}
      />
    )

    expect(html).toContain('workspace-board-creator-sheet-backdrop')
    expect(html).toContain('workspace-board-creator-sheet')
    expect(html).toContain('New Workspace Board')
    expect(html).toContain('Test 1 Board')
    expect(html).toContain('sidebar-board-creator-form')
  })
})
