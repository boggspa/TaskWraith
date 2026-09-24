import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  mergeRecoveredPendingApprovals,
  PendingApprovalRecoveryWindow,
  projectChatSurfacePendingApprovals
} from './chatSurfacePendingApprovals'

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

  it('merges recovered requests before newer live events without duplicates', () => {
    const recoveredHead: Approval = { id: 'recovered-head' }
    const shared: Approval = { id: 'shared' }
    const liveHead: Approval = { id: 'live-head' }
    const unrelated: Approval = { id: 'unrelated' }

    expect(
      mergeRecoveredPendingApprovals(
        [
          { chatId: 'pane-chat', approval: recoveredHead },
          { chatId: 'pane-chat', approval: shared }
        ],
        {
          'pane-chat': liveHead,
          'other-chat': unrelated
        },
        {
          'pane-chat': [shared]
        }
      )
    ).toEqual({
      approvalHeadByChatId: {
        'pane-chat': recoveredHead,
        'other-chat': unrelated
      },
      approvalQueueByChatId: {
        'pane-chat': [shared, liveHead]
      }
    })
  })

  it('does not revive a settled approval from either snapshot', () => {
    const settled: Approval = { id: 'settled' }

    expect(
      mergeRecoveredPendingApprovals(
        [{ chatId: 'pane-chat', approval: settled }],
        { 'pane-chat': settled },
        { 'pane-chat': [settled] },
        new Set(['settled'])
      )
    ).toEqual({
      approvalHeadByChatId: { 'pane-chat': null },
      approvalQueueByChatId: {}
    })
  })

  it('coordinates live, settled, and cancelled recovery races', () => {
    const recovery = new PendingApprovalRecoveryWindow<Approval>()
    recovery.recordLive({ chatId: 'pane-chat', approval: { id: 'live' } })
    recovery.recordSettled('settled')

    expect(
      recovery.reconcile([
        { chatId: 'pane-chat', approval: { id: 'recovered' } },
        { chatId: 'pane-chat', approval: { id: 'settled' } }
      ])
    ).toEqual({
      approvalHeadByChatId: { 'pane-chat': { id: 'recovered' } },
      approvalQueueByChatId: { 'pane-chat': [{ id: 'live' }] }
    })

    recovery.cancel()
    expect(recovery.reconcile([])).toBeNull()
  })

  it('subscribes to every approval settlement before reading the recovery snapshot', () => {
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const ipcStart = appSource.indexOf('const ipcUnsubscriptions: Array<() => void> = []')
    const recoveryRead = appSource.indexOf('.getPendingAgentApprovals()', ipcStart)
    expect(ipcStart).toBeGreaterThan(0)
    expect(appSource.indexOf('onAgentApprovalRequest(', ipcStart)).toBeLessThan(recoveryRead)
    expect(appSource.indexOf('onAgentApprovalTimeout(', ipcStart)).toBeLessThan(recoveryRead)
    expect(appSource.indexOf('onAgentApprovalResolved(', ipcStart)).toBeLessThan(recoveryRead)

    const approvalRecoveryBlock = appSource.slice(ipcStart, recoveryRead + 2000)
    expect(approvalRecoveryBlock).toContain('previous?.id === request.id')
    expect(approvalRecoveryBlock).toContain('approvalRecovery?.recordSettled(')
    expect(approvalRecoveryBlock).toContain('approvalRecovery?.reconcile(recovered)')
  })
})
