import { describe, expect, it } from 'vitest'
import { decideClaudeSdkFailure, isClaudeSdkAbortError } from './ClaudeSdkFallbackDecision'

describe('ClaudeSdkFallbackDecision', () => {
  it('recognizes the SDK AbortError class even when its name is generic', () => {
    class SdkAbortError extends Error {
      override name = 'Error'
    }
    const error = new SdkAbortError('stopped')

    expect(isClaudeSdkAbortError(error, SdkAbortError)).toBe(true)
    expect(
      decideClaudeSdkFailure({ error, runStatus: 'running', abortErrorConstructor: SdkAbortError })
    ).toBe('cancelled')
  })

  it.each([
    new DOMException('Aborted', 'AbortError'),
    Object.assign(new Error('transport stopped'), { code: 'ABORT_ERR' }),
    new Error('Claude Code process aborted by user'),
    new Error('Operation aborted'),
    new Error('outer', { cause: Object.assign(new Error('inner'), { code: 'ABORT_ERR' }) })
  ])('recognizes intentional abort shape %#', (error) => {
    expect(decideClaudeSdkFailure({ error, runStatus: 'running' })).toBe('cancelled')
  })

  it('treats an aborted signal and a cancelled app run as authoritative', () => {
    expect(
      decideClaudeSdkFailure({
        error: new Error('socket closed'),
        signalAborted: true,
        runStatus: 'running'
      })
    ).toBe('cancelled')
    expect(
      decideClaudeSdkFailure({ error: new Error('socket closed'), runStatus: 'cancelled' })
    ).toBe('cancelled')
  })

  it.each(['completed', 'failed'] as const)('does not replay a %s app run', (runStatus) => {
    expect(decideClaudeSdkFailure({ error: new Error('late stream error'), runStatus })).toBe(
      'terminal'
    )
  })

  it('allows fallback for a genuine non-terminal SDK transport failure', () => {
    expect(
      decideClaudeSdkFailure({ error: new Error('SDK socket unavailable'), runStatus: 'running' })
    ).toBe('fallback')
  })
})
