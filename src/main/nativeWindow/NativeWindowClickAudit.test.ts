import { describe, expect, it, vi } from 'vitest'

import { createNativeWindowClickAuditClaim } from './NativeWindowClickAudit'

const request = {
  scope: {
    chatId: 'chat-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    consentEpoch: 'private-consent-epoch',
    generation: 3
  },
  ref: 'private-ax-reference',
  expectedObservationId: 'observation-1',
  inputEpoch: 7,
  previewDigest: 'a'.repeat(64)
}

describe('createNativeWindowClickAuditClaim', () => {
  it('strictly persists a value-free, identity-safe native click claim', () => {
    const appendRunEvent = vi.fn((input) => ({ ...input, sequence: 1 }))
    const claim = createNativeWindowClickAuditClaim({ appendRunEvent })

    claim.claim(request)

    expect(appendRunEvent).toHaveBeenCalledWith(
      {
        runId: 'run-1',
        chatId: 'chat-1',
        kind: 'tool',
        phase: 'control',
        source: 'main',
        summary: 'One-use native click confirmation claimed.',
        payload: {
          action: 'native_window_click',
          launchAttemptId: 'attempt-1',
          attachmentGeneration: 3,
          observationId: 'observation-1',
          inputEpoch: 7,
          refSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          previewDigest: 'a'.repeat(64)
        }
      },
      { durability: 'strict' }
    )
    const serialized = JSON.stringify(appendRunEvent.mock.calls[0]?.[0])
    expect(serialized).not.toContain('private-ax-reference')
    expect(serialized).not.toContain('private-consent-epoch')
    expect(serialized).not.toMatch(/pid|windowId|handleID|processStartedAt/)
  })

  it('throws before dispatch when strict persistence returns no record', () => {
    const claim = createNativeWindowClickAuditClaim({
      appendRunEvent: vi.fn(() => null)
    })

    expect(() => claim.claim(request)).toThrow(
      'The native click audit claim could not be persisted.'
    )
  })

  it('rejects malformed digests without attempting persistence', () => {
    const appendRunEvent = vi.fn()
    const claim = createNativeWindowClickAuditClaim({ appendRunEvent })

    expect(() =>
      claim.claim({
        ...request,
        previewDigest: 'not-a-digest'
      })
    ).toThrow('Native click preview digest is invalid.')
    expect(appendRunEvent).not.toHaveBeenCalled()
  })
})
