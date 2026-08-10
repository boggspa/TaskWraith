// Prompt-composition behaviour for the Muse opaque CLI seat.
//
// Muse opens a fresh isolated home + UUID session each turn, so cross-turn
// memory must be TaskWraith-injected transcript context — same class of silent
// gap Mistral hit when ProviderId gained a seat without PromptComposition
// branches.

import { describe, expect, it } from 'vitest'
import { composeRunPrompt } from './PromptComposition'
import type { ChatMessage } from './store/types'

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: overrides.id || 'm',
    role: overrides.role || 'user',
    content: overrides.content || '',
    timestamp: overrides.timestamp || '2026-07-26T12:00:00Z',
    ...overrides
  } as ChatMessage
}

const priorTurns: ChatMessage[] = [
  message({ id: 'm1', role: 'user', content: 'hey happy easter man.' }),
  message({ id: 'm2', role: 'assistant', content: 'Happy Easter — what should we work on?' })
]

function composeMuse(overrides: Record<string, unknown> = {}) {
  return composeRunPrompt({
    provider: 'muse',
    finalPrompt: 'Now summarize the greeting.',
    messages: priorTurns,
    chatContextTurns: 6,
    codexHandoffsApplied: [],
    isGlobalRun: false,
    approvalMode: 'default',
    providerLabel: 'Muse',
    taskWraithMcpAdvertised: false,
    ...overrides
  })
}

describe('composeRunPrompt — Muse cross-turn context', () => {
  it('re-injects the transcript because Muse opens a fresh opaque exec each turn', () => {
    const result = composeMuse()
    expect(result.contextualPrompt).toContain('Conversation context')
    expect(result.contextualPrompt).toContain('hey happy easter man.')
    expect(result.applicationLog).toMatch(/Muse: appending compact conversation context/i)
    expect(result.applicationLog).not.toMatch(/provider\/session history is authoritative/i)
    expect(result.applicationLog).not.toMatch(/Gemini/i)
    expect(result.applicationLog).not.toMatch(/Sub-thread/i)
  })

  it('names Muse in provider display fallthrough for subthread return copy', () => {
    // providerDisplayName used to fall through to "Sub-thread" for muse,
    // which made Inspect read like a Gemini-era generic seat.
    const result = composeMuse({
      messages: [
        ...priorTurns,
        message({
          id: 'm3',
          role: 'tool',
          content: '↩ Result from Muse sub-thread',
          metadata: {
            kind: 'subThreadReturn',
            subThreadProvider: 'muse',
            subThreadTitle: 'greeting'
          }
        })
      ]
    })
    expect(result.applicationLog).toMatch(/Muse/i)
  })
})
