import { describe, expect, it } from 'vitest'
import {
  agentApprovalCancelPresentation,
  locatePendingApproval,
  shouldDismissAgentApproval
} from './agentApprovalLifecycle'

describe('agent approval lifecycle UI', () => {
  it('keeps the exact-review card when main rejects or cannot persist the response', () => {
    expect(shouldDismissAgentApproval(false)).toBe(false)
    expect(shouldDismissAgentApproval(true)).toBe(true)
    expect(shouldDismissAgentApproval({ ok: true })).toBe(true)
    expect(shouldDismissAgentApproval({ ok: false })).toBe(false)
  })

  it('labels only native Kimi wire cancellation as a run cancellation', () => {
    expect(
      agentApprovalCancelPresentation({
        provider: 'kimi',
        method: 'request/ApprovalRequest'
      })
    ).toMatchObject({ label: 'Cancel run' })
    expect(
      agentApprovalCancelPresentation({
        provider: 'claude',
        method: 'claude/canUseTool'
      })
    ).toMatchObject({ label: 'Cancel request' })
    expect(
      agentApprovalCancelPresentation({
        provider: 'kimi',
        method: 'gemini-mcp/tool'
      })
    ).toMatchObject({ label: 'Cancel request' })
  })

  it('locates an id in head or queue without trusting a pre-await snapshot', () => {
    expect(locatePendingApproval('b', { child: { id: 'b' } }, { child: [{ id: 'c' }] })).toEqual({
      chatId: 'child',
      inHead: true,
      inQueue: false
    })
    expect(locatePendingApproval('c', { child: { id: 'b' } }, { child: [{ id: 'c' }] })).toEqual({
      chatId: 'child',
      inHead: false,
      inQueue: true
    })
    // After head A was accepted and B promoted, live maps show B as head —
    // even if a stale snapshot still had B in the queue.
    expect(locatePendingApproval('b', { child: { id: 'b' } }, { child: [] })).toEqual({
      chatId: 'child',
      inHead: true,
      inQueue: false
    })
    expect(locatePendingApproval('missing', { child: { id: 'b' } }, {})).toBeNull()
  })
})
