import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectChatSurfacePendingApprovals } from './chatSurfacePendingApprovals'

type Approval = { id: string }

describe('projectChatSurfacePendingApprovals', () => {
  it('projects only the requested chat head and queue', () => {
    const paneHead: Approval = { id: 'pane-head' }
    const paneTail: Approval = { id: 'pane-tail' }
    const otherHead: Approval = { id: 'other-head' }
    const otherTail: Approval = { id: 'other-tail' }

    const projection = projectChatSurfacePendingApprovals(
      'pane-chat',
      {
        'pane-chat': paneHead,
        'other-chat': otherHead
      },
      {
        'pane-chat': [paneTail],
        'other-chat': [otherTail]
      }
    )

    expect(projection).toEqual({
      pendingAgentApproval: paneHead,
      pendingApprovalQueueByChatId: { 'pane-chat': [paneTail] }
    })
    expect(projection.pendingAgentApproval).toBe(paneHead)
  })

  it('returns an empty pane-local projection when that chat has no approvals', () => {
    expect(
      projectChatSurfacePendingApprovals(
        'pane-chat',
        { 'other-chat': { id: 'other-head' } },
        { 'other-chat': [{ id: 'other-tail' }] }
      )
    ).toEqual({
      pendingAgentApproval: null,
      pendingApprovalQueueByChatId: {}
    })
  })

  it('preserves the queue reference for stable pane runtimes', () => {
    const queue: Approval[] = [{ id: 'pane-tail' }]
    const projection = projectChatSurfacePendingApprovals(
      'pane-chat',
      { 'pane-chat': { id: 'pane-head' } },
      { 'pane-chat': queue }
    )

    expect(projection.pendingApprovalQueueByChatId['pane-chat']).toBe(queue)
  })

  it('wires resting Multiview composers to the pane-local projection', () => {
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const projectionStart = appSource.indexOf('const panePendingApprovals =')
    const paneMapStart = appSource.indexOf('const paneComposerCtxByKey', projectionStart)
    expect(projectionStart).toBeGreaterThan(0)
    expect(paneMapStart).toBeGreaterThan(projectionStart)

    const paneComposerBuilder = appSource.slice(projectionStart, paneMapStart)
    expect(paneComposerBuilder).toContain('projectChatSurfacePendingApprovals(')
    expect(paneComposerBuilder).toContain('...panePendingApprovals')
    expect(paneComposerBuilder).not.toContain('pendingAgentApproval: null')
  })
})
