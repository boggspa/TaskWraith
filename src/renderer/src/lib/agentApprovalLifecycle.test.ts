import { describe, expect, it } from 'vitest'
import {
  agentApprovalCancelPresentation,
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
})
