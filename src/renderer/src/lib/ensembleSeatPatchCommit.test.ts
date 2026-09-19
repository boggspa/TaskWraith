import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'
import { tryCommitEnsembleSeatPatch } from './ensembleSeatPatchCommit'

type SeatRequest = Parameters<typeof tryCommitEnsembleSeatPatch>[0]['request']

function shell(): ChatRecord {
  const chat = {
    appChatId: 'chat-a',
    chatKind: 'ensemble',
    summaryOnly: true,
    transcriptPaged: true,
    ensemble: {
      participants: [{ id: 'seat-a', provider: 'codex', model: 'gpt-6-astra' }]
    }
  } as unknown as ChatRecord
  for (const key of ['messages', 'runs']) {
    Object.defineProperty(chat, key, {
      get: () => {
        throw new Error('A seat edit must not read transcript history')
      }
    })
  }
  return chat
}

describe('tryCommitEnsembleSeatPatch', () => {
  it.each([{ model: 'gpt-5.6-sol' }, { reasoningEffort: 'high' }])(
    'submits an idle paged seat edit synchronously without reading history: %j',
    (patch) => {
      const chat = shell()
      const request = vi.fn<SeatRequest>(() => true)
      expect(
        tryCommitEnsembleSeatPatch({
          chat,
          participantId: 'seat-a',
          patch,
          runtimePatch: patch,
          request
        })
      ).toBe(true)
      expect(request).toHaveBeenCalledOnce()
      expect(request.mock.calls[0][0]).toBe(chat)
      expect(request.mock.calls[0].slice(1)).toEqual(['seat-a', patch])
    }
  )

  it('preserves clears on the existing main-authoritative request', () => {
    const chat = shell()
    const patch = { serviceTier: undefined, fastModeEnabled: false }
    const request = vi.fn<SeatRequest>(() => true)
    expect(
      tryCommitEnsembleSeatPatch({
        chat,
        participantId: 'seat-a',
        patch,
        runtimePatch: patch,
        request
      })
    ).toBe(true)
    expect(request.mock.calls[0][2]).toHaveProperty('serviceTier', undefined)
  })

  it('leaves unsupported fields and missing seats on the existing fallback path', () => {
    const chat = shell()
    const request = vi.fn<SeatRequest>(() => true)
    const patch = { model: 'gpt-5.6-sol', agentIdentity: {} } as Partial<EnsembleParticipant>
    expect(
      tryCommitEnsembleSeatPatch({
        chat,
        participantId: 'seat-a',
        patch,
        runtimePatch: { model: patch.model },
        request
      })
    ).toBe(false)
    expect(
      tryCommitEnsembleSeatPatch({
        chat,
        participantId: 'missing',
        patch: { model: 'gpt-5.6-sol' },
        runtimePatch: { model: 'gpt-5.6-sol' },
        request
      })
    ).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
})
