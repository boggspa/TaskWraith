import { describe, expect, it } from 'vitest'
import { isEnsembleFanoutDispatchPayload } from '../../shared/ensembleFanoutDispatch'
import { buildEnsembleFanoutDispatchPayload } from './EnsembleFanoutDispatchTranscript'

describe('Ensemble fan-out dispatch transcript builder', () => {
  it('freezes the relevant planned seats and their exact lane intents', () => {
    const payload = buildEnsembleFanoutDispatchPayload({
      label: 'User Fan-Out',
      category: 'user',
      lanes: [
        {
          participant: {
            id: 'researcher',
            provider: 'pi',
            role: 'Researcher',
            model: 'mistral/devstral-2512'
          },
          laneIntent: 'read'
        },
        {
          participant: {
            id: 'builder',
            provider: 'ollama',
            role: 'Builder',
            model: 'qwen3.5:9b'
          },
          laneIntent: 'write'
        }
      ]
    })

    expect(payload).toEqual({
      label: 'User Fan-Out',
      category: 'user',
      participants: [
        {
          participantId: 'researcher',
          provider: 'pi',
          role: 'Researcher',
          model: 'mistral/devstral-2512',
          intent: 'read'
        },
        {
          participantId: 'builder',
          provider: 'ollama',
          role: 'Builder',
          model: 'qwen3.5:9b',
          intent: 'write'
        }
      ]
    })
    expect(isEnsembleFanoutDispatchPayload(payload)).toBe(true)
  })

  it('uses a durable generic role and omits a blank model', () => {
    expect(
      buildEnsembleFanoutDispatchPayload({
        label: 'Review wave',
        category: 'orchestrated',
        lanes: [
          {
            participant: {
              id: 'reviewer',
              provider: 'claude',
              role: ' ',
              model: ' '
            },
            laneIntent: 'read'
          }
        ]
      }).participants[0]
    ).toEqual({
      participantId: 'reviewer',
      provider: 'claude',
      role: 'Participant',
      intent: 'read'
    })
  })
})
