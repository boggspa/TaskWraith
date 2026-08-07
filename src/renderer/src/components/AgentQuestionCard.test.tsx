import { describe, expect, it, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentQuestionCard, type AgentQuestionState } from './AgentQuestionCard'
import {
  clearAllAgentQuestionDrafts,
  writeAgentQuestionDraft
} from '../lib/agentQuestionDraftStore'

function question(overrides: Partial<AgentQuestionState> = {}): AgentQuestionState {
  return {
    questionId: 'q-draft-survive',
    appRunId: 'run-1',
    messageId: 'agent-question-q-draft-survive',
    provider: 'ollama',
    question: 'Can you point out which files are bad code?',
    askedAt: 1,
    ...overrides
  }
}

describe('AgentQuestionCard draft survival', () => {
  afterEach(() => {
    clearAllAgentQuestionDrafts()
  })

  it('keeps a typed free-text draft after remount (transcript re-anchor)', () => {
    // Simulate the user typing, then the card remounting because the pending
    // marker's rowKey index shifted. The draft must come back from the store —
    // local useState alone re-inits to ''.
    writeAgentQuestionDraft('q-draft-survive', {
      freeText: 'no-please-keep-this-draft',
      showFreeText: true
    })

    const html = renderToStaticMarkup(
      <AgentQuestionCard state={question()} onAnswer={() => {}} onDismiss={() => {}} />
    )

    expect(html).toContain('no-please-keep-this-draft')
  })
})
