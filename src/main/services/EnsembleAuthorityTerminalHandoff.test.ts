import { describe, expect, it } from 'vitest'
import { retainedAuthorityTerminalHandoffSignal } from './EnsembleAuthorityTerminalHandoff'

describe('retainedAuthorityTerminalHandoffSignal', () => {
  it('recognizes the Fable usage-credit terminal even when the provider reports success', () => {
    expect(
      retainedAuthorityTerminalHandoffSignal({
        provider: 'claude',
        status: 'answered',
        content:
          "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models."
      })
    ).toMatchObject({ kind: 'quota_wall' })
  })

  it('treats explicit provider failures, including output-limit failures, as terminal', () => {
    expect(
      retainedAuthorityTerminalHandoffSignal({
        provider: 'codex',
        status: 'failed',
        content: 'Maximum output token limit reached.'
      })
    ).toMatchObject({ kind: 'provider_failure' })
  })

  it('does not terminalize healthy or silent-success authority turns', () => {
    expect(
      retainedAuthorityTerminalHandoffSignal({
        provider: 'claude',
        status: 'answered',
        content: 'Synthesis complete.'
      })
    ).toBeNull()
    expect(
      retainedAuthorityTerminalHandoffSignal({
        provider: 'claude',
        status: 'skipped',
        content: ''
      })
    ).toBeNull()
  })

  it('lets a user-queued replacement run before judging the old terminal snapshot', () => {
    expect(
      retainedAuthorityTerminalHandoffSignal({
        provider: 'claude',
        status: 'answered',
        content:
          "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.",
        replacementSeatReady: true
      })
    ).toBeNull()
  })
})
