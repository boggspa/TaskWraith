import { afterEach, describe, expect, it } from 'vitest'
import {
  clearAgentQuestionDraft,
  clearAllAgentQuestionDrafts,
  initialAgentQuestionCardDraft,
  readAgentQuestionDraft,
  writeAgentQuestionDraft
} from './agentQuestionDraftStore'

describe('agentQuestionDraftStore', () => {
  afterEach(() => {
    clearAllAgentQuestionDrafts()
  })

  it('returns empty initial draft when nothing was typed', () => {
    expect(initialAgentQuestionCardDraft('q-new', false)).toEqual({
      freeText: '',
      showFreeText: true
    })
    expect(initialAgentQuestionCardDraft('q-opts', true)).toEqual({
      freeText: '',
      showFreeText: false
    })
  })

  it('preserves free-text across a remount for the same questionId', () => {
    writeAgentQuestionDraft('q-1', { freeText: 'no', showFreeText: true })
    expect(readAgentQuestionDraft('q-1')).toEqual({ freeText: 'no', showFreeText: true })
    expect(initialAgentQuestionCardDraft('q-1', false)).toEqual({
      freeText: 'no',
      showFreeText: true
    })
  })

  it('clears draft when the question is answered or dismissed', () => {
    writeAgentQuestionDraft('q-1', { freeText: 'no', showFreeText: true })
    clearAgentQuestionDraft('q-1')
    expect(readAgentQuestionDraft('q-1')).toBeUndefined()
    expect(initialAgentQuestionCardDraft('q-1', false).freeText).toBe('')
  })
})
