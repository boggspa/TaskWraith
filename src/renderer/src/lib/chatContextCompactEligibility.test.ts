import { describe, expect, it } from 'vitest'

import { canCompactSoloChatContext } from './chatContextCompactEligibility'

describe('canCompactSoloChatContext', () => {
  it('offers Path-B Cursor compact once the transcript has an assistant turn', () => {
    expect(
      canCompactSoloChatContext({
        isEnsemble: false,
        isRunning: false,
        provider: 'cursor',
        hasLinkedSession: false,
        hasAssistantMessage: true
      })
    ).toBe(true)
    expect(
      canCompactSoloChatContext({
        isEnsemble: false,
        isRunning: false,
        provider: 'cursor',
        hasLinkedSession: false,
        hasAssistantMessage: false
      })
    ).toBe(false)
  })

  it('keeps Codex gated on a linked session and hides the lever while a turn is live', () => {
    expect(
      canCompactSoloChatContext({
        isEnsemble: false,
        isRunning: false,
        provider: 'codex',
        hasLinkedSession: true,
        hasAssistantMessage: true
      })
    ).toBe(true)
    expect(
      canCompactSoloChatContext({
        isEnsemble: false,
        isRunning: true,
        provider: 'cursor',
        hasLinkedSession: false,
        hasAssistantMessage: true
      })
    ).toBe(false)
  })
})
