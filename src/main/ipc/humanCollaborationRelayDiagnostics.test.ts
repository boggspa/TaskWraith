import { describe, expect, it } from 'vitest'
import { describeRelayAttemptFailures } from './humanCollaborationHandlers'

/**
 * A cross-network invite advertises several relay doors and the join loop tries
 * each. The failure message is the ONLY diagnostic the joining collaborator
 * gets, so it has to name every door that was tried and why each one failed.
 */
describe('describeRelayAttemptFailures', () => {
  it('names every door tried and its individual reason', () => {
    const error = describeRelayAttemptFailures(
      [
        {
          relayUrl: 'wss://host.example.ts.net',
          error: new Error('Collaboration connect timed out.')
        },
        { relayUrl: 'ws://192.168.1.20:8787', error: new Error('connect ECONNREFUSED') }
      ],
      'fallback'
    )
    expect(error.message).toContain('2 collaboration relay URLs')
    expect(error.message).toContain('wss://host.example.ts.net — Collaboration connect timed out.')
    expect(error.message).toContain('ws://192.168.1.20:8787 — connect ECONNREFUSED')
  })

  it('does not claim a count when only one door existed', () => {
    const error = describeRelayAttemptFailures(
      [{ relayUrl: 'wss://tunnel.example.com', error: new Error('ENOTFOUND') }],
      'fallback'
    )
    expect(error.message).toContain('Could not reach the collaboration relay.')
    expect(error.message).not.toContain('1 collaboration relay URLs')
    expect(error.message).toContain('wss://tunnel.example.com — ENOTFOUND')
  })

  it('falls back when the loop never got as far as an attempt', () => {
    expect(describeRelayAttemptFailures([], 'Could not connect to any relay.').message).toBe(
      'Could not connect to any relay.'
    )
  })

  it('stringifies a non-Error rejection rather than printing [object Object]', () => {
    const error = describeRelayAttemptFailures(
      [{ relayUrl: 'ws://127.0.0.1:8788', error: 'socket hang up' }],
      'fallback'
    )
    expect(error.message).toContain('ws://127.0.0.1:8788 — socket hang up')
  })
})
