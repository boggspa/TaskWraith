import { describe, expect, it, vi } from 'vitest'
import type { AcpPermissionRequest } from '../grok/GrokAcpProtocol'
import type { MistralNativeShellGateDeps } from './MistralNativeShellGate'
import { createMistralNativeShellGate, mistralNativeShellPermitted } from './MistralNativeShellGate'

type ApprovalArg = Parameters<MistralNativeShellGateDeps['requestApproval']>[0]

function request(rawToolCall: unknown): AcpPermissionRequest {
  return {
    rpcId: 1,
    sessionId: 's-1',
    toolName: 'bash',
    toolKind: 'execute',
    rawToolCall: rawToolCall as AcpPermissionRequest['rawToolCall'],
    options: []
  }
}

describe('mistralNativeShellPermitted', () => {
  it('refuses a read-only seat whatever the posture says', () => {
    for (const shellPolicy of ['allow', 'workspace', 'ask'] as const) {
      expect(mistralNativeShellPermitted({ readOnlySeat: true, shellPolicy })).toBe(false)
    }
  })

  it('honours a deny posture on a write-capable seat', () => {
    expect(mistralNativeShellPermitted({ readOnlySeat: false, shellPolicy: 'deny' })).toBe(false)
  })

  it('permits a write-capable seat whose posture is not deny', () => {
    for (const shellPolicy of ['allow', 'workspace', 'ask'] as const) {
      expect(mistralNativeShellPermitted({ readOnlySeat: false, shellPolicy })).toBe(true)
    }
  })

  it('refuses when no posture is resolvable rather than assuming one', () => {
    expect(mistralNativeShellPermitted({ readOnlySeat: false, shellPolicy: null })).toBe(false)
    expect(mistralNativeShellPermitted({ readOnlySeat: false, shellPolicy: undefined })).toBe(false)
  })
})

describe('createMistralNativeShellGate', () => {
  it('sends the command through the chokepoint in the shape its classifiers read', async () => {
    const requestApproval = vi.fn(async (_request: ApprovalArg) => true)
    const decision = await createMistralNativeShellGate({ requestApproval })(
      request({ rawInput: { command: 'npm test' } })
    )
    expect(decision).toBe('allow')
    expect(requestApproval).toHaveBeenCalledTimes(1)
    const sent = requestApproval.mock.calls[0][0]
    expect(sent.body).toBe('npm test')
    // shellCommandFromApprovalPreview reads preview.params.command.
    expect(sent.preview).toMatchObject({ params: { command: 'npm test' } })
  })

  it('fails closed when the command text cannot be read', async () => {
    const requestApproval = vi.fn(async (_request: ApprovalArg) => true)
    const decision = await createMistralNativeShellGate({ requestApproval })(
      request({ rawInput: { notACommand: 1 } })
    )
    expect(requestApproval).not.toHaveBeenCalled()
    expect(decision).toMatchObject({ decision: 'deny', origin: 'host-policy' })
  })

  it('does not attribute a refusal to the user, because it cannot tell', async () => {
    const decision = await createMistralNativeShellGate({ requestApproval: async () => false })(
      request({ rawInput: { command: 'git reset --hard' } })
    )
    expect(decision).toMatchObject({ decision: 'deny', origin: 'unknown' })
    if (typeof decision === 'object') {
      expect(decision.reason).toContain('declined, or it timed out')
      expect(decision.reason).not.toContain('user rejected')
    }
  })
})
