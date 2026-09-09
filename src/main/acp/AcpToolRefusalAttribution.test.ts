import { describe, expect, it, vi } from 'vitest'
import type { AcpPermissionRequest } from './AcpProtocol'
import type { AcpToolRecoveryContext } from './AcpTurnClient'
import { createAcpToolRefusalAttribution } from './AcpToolRefusalAttribution'

const request = (id: string): AcpPermissionRequest => ({
  rpcId: id,
  sessionId: 's',
  toolName: 'bash',
  toolKind: 'execute',
  options: [],
  rawToolCall: { toolCallId: id }
})
const context = (
  lastFailedToolId: string | null,
  deniedPermissionRequest: AcpPermissionRequest | null
): AcpToolRecoveryContext => ({
  reason: 'denied-permission-cancellation',
  terminalStatus: 'cancelled',
  deniedPermissionRequest,
  assistantTextSeen: false,
  toolFailureSeen: Boolean(lastFailedToolId),
  lastFailedToolId,
  lastFailedToolName: 'bash',
  lastFailedToolOutput: 'User rejected the tool call'
})

describe('ACP refusal provenance', () => {
  it('never promotes provider wording into human authority', () => {
    const tracker = createAcpToolRefusalAttribution({})
    expect(tracker.recoveryPrompt(context('x', null))).toContain('origin is unknown')
    expect(tracker.recoveryPrompt(context('x', null))).not.toContain('The user declined')
  })
  it.each(['human', 'host-policy'] as const)(
    'keeps a later %s denial separate from an earlier containment failure',
    async (origin) => {
      const onRefusal = vi.fn()
      const tracker = createAcpToolRefusalAttribution({
        onRefusal,
        routeObserved: () => true,
        mediate: (r) => ({
          decision: 'deny',
          origin: r.rpcId === 'a' ? 'host-containment' : origin,
          decisionSource: r.rpcId === 'b' && origin === 'human' ? 'user' : 'system',
          reason: String(r.rpcId)
        })
      })
      tracker.onRawFrame('out', { method: 'session/prompt' })
      const a = request('a'),
        b = request('b')
      await tracker.onPermissionRequest(a)
      tracker.onPermissionResponse(a, 'deny')
      await tracker.onPermissionRequest(b)
      tracker.onPermissionResponse(b, 'deny')
      const prompt = tracker.recoveryPrompt(context('a', b))
      expect(prompt).toContain('Different failed and denied')
      expect(prompt).toContain('Receipt for "b"')
      expect(prompt).not.toContain('once through')
      expect(onRefusal).toHaveBeenCalledTimes(2)
    }
  )
  it('retains successful write acknowledgements after a successor prompt and close, once', async () => {
    const onRefusal = vi.fn()
    const tracker = createAcpToolRefusalAttribution({
      onRefusal,
      mediate: () => ({
        decision: 'deny',
        origin: 'host-policy',
        decisionSource: 'system',
        reason: 'policy'
      })
    })
    tracker.onRawFrame('out', { method: 'session/prompt' })
    const a = request('a')
    await tracker.onPermissionRequest(a)
    tracker.onRawFrame('out', { method: 'session/prompt' })
    tracker.close()
    expect(onRefusal).not.toHaveBeenCalled()
    tracker.onPermissionResponse(a, 'deny')
    tracker.onPermissionResponse(a, 'deny')
    expect(onRefusal).toHaveBeenCalledOnce()
    expect(onRefusal.mock.calls[0][1]).toMatchObject({ generation: 1, reply: 'transport-written' })
  })
})
