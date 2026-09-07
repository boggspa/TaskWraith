import { describe, expect, it, vi } from 'vitest'
import type { ContextCompactionSignal } from '../../shared/contextCompaction'
import { deliverMuseContextCompactionCard } from './MuseContextCompactionChatCard'

const signal: ContextCompactionSignal = {
  kind: 'completed',
  telemetry: {
    provider: 'muse',
    eventUuid: 'cmp-1',
    trigger: 'auto',
    preTokens: 900_000,
    postTokens: 12_000
  }
}

describe('deliverMuseContextCompactionCard', () => {
  it('delivers a Muse compaction signal to the chat-card append and progress sinks', () => {
    const append = vi.fn()
    const broadcast = vi.fn()
    deliverMuseContextCompactionCard(
      {
        chatId: 'chat-1',
        signal,
        appRunId: 'run-1',
        participantId: 'worker'
      },
      { append, broadcast }
    )
    expect(append).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith('chat-1', signal, 'muse-run-1-cmp-1', {
      ensembleParticipantId: 'worker'
    })
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith({
      chatId: 'chat-1',
      provider: 'muse',
      signal,
      cardMetadata: { ensembleParticipantId: 'worker' }
    })
  })

  it('omits ensemble card metadata on a solo turn', () => {
    const append = vi.fn()
    const broadcast = vi.fn()
    deliverMuseContextCompactionCard(
      { chatId: 'chat-1', signal, appRunId: 'run-1' },
      { append, broadcast }
    )
    expect(append).toHaveBeenCalledWith('chat-1', signal, 'muse-run-1-cmp-1', undefined)
    expect(broadcast).toHaveBeenCalledWith({
      chatId: 'chat-1',
      provider: 'muse',
      signal
    })
  })

  it('falls back to a compaction id when the signal has no eventUuid', () => {
    const append = vi.fn()
    const broadcast = vi.fn()
    const bare: ContextCompactionSignal = {
      kind: 'started',
      telemetry: { provider: 'muse' }
    }
    deliverMuseContextCompactionCard(
      { chatId: 'chat-1', signal: bare, appRunId: 'run-9' },
      { append, broadcast }
    )
    expect(append).toHaveBeenCalledWith('chat-1', bare, 'muse-run-9-compaction', undefined)
    expect(broadcast).toHaveBeenCalledWith({
      chatId: 'chat-1',
      provider: 'muse',
      signal: bare
    })
  })
})
