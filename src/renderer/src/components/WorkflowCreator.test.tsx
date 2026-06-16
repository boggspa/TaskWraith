import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord, WorkspaceRecord } from '../../../main/store/types'
import { buildWorkflowCreatorTrigger, WorkflowCreator } from './WorkflowCreator'

function makeWorkspace(): WorkspaceRecord {
  return {
    id: 'ws-1',
    path: '/repo',
    displayName: 'Repo',
    lastOpenedAt: 1,
    createdAt: 1,
    pinned: false
  }
}

function makeChat(): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: 'Build thread',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    pinned: false,
    messages: [],
    runs: []
  }
}

describe('WorkflowCreator', () => {
  it('renders nothing while closed', () => {
    const html = renderToStaticMarkup(
      <WorkflowCreator
        open={false}
        workspace={makeWorkspace()}
        targetChat={makeChat()}
        initialPrompt=""
        localHistoryEnabled={true}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(html).toBe('')
  })

  it('renders a visible creator seeded from the current chat and prompt', () => {
    const html = renderToStaticMarkup(
      <WorkflowCreator
        open
        workspace={makeWorkspace()}
        targetChat={makeChat()}
        initialPrompt="Review the current diff."
        localHistoryEnabled={true}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(html).toContain('Create workflow')
    expect(html).toContain('Repo / Build thread')
    expect(html).toContain('Codex run settings will be captured')
    expect(html).toContain('Review the current diff.')
    expect(html).toContain('Max runs per day')
  })

  it('renders actionable workspace guidance when no workspace is active', () => {
    const html = renderToStaticMarkup(
      <WorkflowCreator
        open
        workspace={null}
        targetChat={null}
        initialPrompt=""
        localHistoryEnabled={true}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(html).toContain('Choose a workspace before creating a workflow.')
    expect(html).toContain('disabled=""')
  })

  it('blocks creation when local chat history is disabled', () => {
    const html = renderToStaticMarkup(
      <WorkflowCreator
        open
        workspace={makeWorkspace()}
        targetChat={makeChat()}
        initialPrompt=""
        localHistoryEnabled={false}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(html).toContain('Enable local chat history before creating workflows.')
    expect(html).toContain('disabled=""')
  })

  it('builds supported manual and interval triggers', () => {
    expect(buildWorkflowCreatorTrigger('manual', 60)).toEqual({ kind: 'manual' })
    const interval = buildWorkflowCreatorTrigger('interval', 15)

    expect(interval).toMatchObject({
      kind: 'interval',
      intervalMs: 15 * 60_000
    })
    expect(interval.startAt).toBeTruthy()
    expect(interval.timezone).toBeTruthy()
  })
})
