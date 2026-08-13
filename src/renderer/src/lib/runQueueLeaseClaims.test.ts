import { describe, expect, it } from 'vitest'
import { createRunQueueLeaseClaims, removeExactQueuedRunRequest } from './runQueueLeaseClaims'

describe('run queue lease claims', () => {
  it('allows only one lease attempt per durable run until it is released', () => {
    const claims = createRunQueueLeaseClaims()

    expect(claims.tryClaim('run-1')).toBe(true)
    expect(claims.has('run-1')).toBe(true)
    expect(claims.tryClaim('run-1')).toBe(false)

    claims.release('run-1')
    expect(claims.tryClaim('run-1')).toBe(true)
  })

  it('releases claims once their durable rows leave the queued projection', () => {
    const claims = createRunQueueLeaseClaims()
    claims.tryClaim('run-1')
    claims.tryClaim('run-2')

    claims.retainQueuedRunIds(['run-2', 'run-3'])

    expect(claims.has('run-1')).toBe(false)
    expect(claims.has('run-2')).toBe(true)
  })
})

describe('removeExactQueuedRunRequest', () => {
  const first = { appRunId: 'run-1', prompt: 'First' }
  const second = { appRunId: 'run-2', prompt: 'Second' }

  it('removes only the leased request', () => {
    expect(removeExactQueuedRunRequest([first, second], 'run-1')).toEqual([second])
  })

  it('preserves the state reference when the request was already absent', () => {
    const requests = [second]
    expect(removeExactQueuedRunRequest(requests, 'run-1')).toBe(requests)
  })
})
