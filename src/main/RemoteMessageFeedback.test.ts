import { describe, expect, it } from 'vitest'
import type { ChatMessage } from './store/types'
import { applyRemoteMessageFeedback } from './RemoteMessageFeedback'

function assistant(): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: 'Answer',
    timestamp: '2026-08-03T00:00:00.000Z'
  }
}

describe('applyRemoteMessageFeedback', () => {
  it('sets, flips, and clears assistant feedback', () => {
    const initial = assistant()
    const up = applyRemoteMessageFeedback(initial, { vote: 'up' }, 10)
    expect(up?.metadata?.feedback).toEqual({ vote: 'up', at: 10 })

    const down = applyRemoteMessageFeedback(up!, { vote: 'down' }, 20)
    expect(down?.metadata?.feedback).toEqual({ vote: 'down', at: 20 })

    const cleared = applyRemoteMessageFeedback(down!, { vote: 'down' }, 30)
    expect(cleared?.metadata?.feedback).toBeUndefined()
  })

  it('bounds reason and note while preserving a same-vote detail update', () => {
    const current = {
      ...assistant(),
      metadata: { feedback: { vote: 'down' as const, at: 10 } }
    }
    const next = applyRemoteMessageFeedback(
      current,
      { vote: 'down', reason: 'r'.repeat(100), note: 'n'.repeat(1200) },
      20
    )
    expect(next?.metadata?.feedback?.reason).toHaveLength(80)
    expect(next?.metadata?.feedback?.note).toHaveLength(1000)
    expect(next?.metadata?.feedback?.at).toBe(20)
  })

  it('rejects non-assistant and channel-inbound rows', () => {
    expect(
      applyRemoteMessageFeedback(
        { ...assistant(), role: 'user' },
        { vote: 'up' },
        10
      )
    ).toBeNull()
    expect(
      applyRemoteMessageFeedback(
        { ...assistant(), metadata: { kind: 'channelInbound' } },
        { vote: 'up' },
        10
      )
    ).toBeNull()
  })
})
