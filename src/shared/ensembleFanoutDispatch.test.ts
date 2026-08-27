import { describe, expect, it } from 'vitest'
import {
  ensembleFanoutDispatchIntentCounts,
  isEnsembleFanoutDispatchPayload
} from './ensembleFanoutDispatch'

const payload = {
  label: 'User Fan-Out',
  category: 'user' as const,
  participants: [
    {
      participantId: 'researcher',
      provider: 'pi',
      role: 'Researcher',
      model: 'mistral/devstral-2512',
      intent: 'read' as const
    },
    {
      participantId: 'builder',
      provider: 'ollama',
      role: 'Builder',
      model: 'qwen3.5:9b',
      intent: 'write' as const
    }
  ]
}

describe('Ensemble fan-out dispatch payload', () => {
  it('accepts attributed reader and writer lanes', () => {
    expect(isEnsembleFanoutDispatchPayload(payload)).toBe(true)
    expect(ensembleFanoutDispatchIntentCounts(payload)).toEqual({ read: 1, write: 1 })
  })

  it('rejects empty, duplicate, and malformed participant records', () => {
    expect(isEnsembleFanoutDispatchPayload({ ...payload, participants: [] })).toBe(false)
    expect(
      isEnsembleFanoutDispatchPayload({
        ...payload,
        participants: [payload.participants[0], payload.participants[0]]
      })
    ).toBe(false)
    expect(
      isEnsembleFanoutDispatchPayload({
        ...payload,
        participants: [{ ...payload.participants[0], provider: 'pi); color: red' }]
      })
    ).toBe(false)
  })

  it('rejects unknown categories and lane intents', () => {
    expect(isEnsembleFanoutDispatchPayload({ ...payload, category: 'system' })).toBe(false)
    expect(
      isEnsembleFanoutDispatchPayload({
        ...payload,
        participants: [{ ...payload.participants[0], intent: 'admin' }]
      })
    ).toBe(false)
  })
})
