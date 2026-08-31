import { describe, expect, it, vi } from 'vitest'
import { createComposerDraftState } from './composerDraftState'
import {
  beginComposerDraftSubmission,
  isAcceptedEnsembleSteerResult
} from './composerDraftSubmission'

function begin(initialDraft: string, submittedDraft = initialDraft) {
  const state = createComposerDraftState({ chat: initialDraft })
  const unsubscribe = vi.fn()
  const receipt = beginComposerDraftSubmission({
    chatId: 'chat',
    submittedDraft,
    getDraft: state.getDraft,
    setDraft: state.setDraft,
    subscribeToDraft: (chatId, listener) => {
      const stop = state.subscribeToChat(chatId, listener)
      return () => {
        unsubscribe()
        stop()
      }
    }
  })
  return { state, receipt, unsubscribe }
}

describe('beginComposerDraftSubmission', () => {
  it('clears the exact submitted draft immediately and commits it once', () => {
    const { state, receipt, unsubscribe } = begin('@Scouts take another look')

    expect(receipt).not.toBeNull()
    expect(state.getDraft('chat')).toBe('')
    receipt?.commit()
    receipt?.commit()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(state.getDraft('chat')).toBe('')
  })

  it('does not consume a draft that changed before dispatch', () => {
    const { state, receipt, unsubscribe } = begin('newer text', 'stale submission')

    expect(receipt).toBeNull()
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(state.getDraft('chat')).toBe('newer text')
  })

  it('restores a rejected submission when the cleared draft stayed untouched', () => {
    const { state, receipt } = begin('please steer this')

    expect(receipt?.restoreIfUntouched()).toBe(true)
    expect(receipt?.restoreIfUntouched()).toBe(false)
    expect(state.getDraft('chat')).toBe('please steer this')
  })

  it('never overwrites or resurrects draft text edited after the optimistic clear', () => {
    const first = begin('first steer')
    first.state.setDraft('chat', 'next message')
    expect(first.receipt?.restoreIfUntouched()).toBe(false)
    expect(first.state.getDraft('chat')).toBe('next message')

    const second = begin('second steer')
    second.state.setDraft('chat', 'temporary edit')
    second.state.setDraft('chat', '')
    expect(second.receipt?.restoreIfUntouched()).toBe(false)
    expect(second.state.getDraft('chat')).toBe('')
  })
})

describe('isAcceptedEnsembleSteerResult', () => {
  it.each(['steered', 'started', 'queued'])('accepts the retained %s handoff', (status) => {
    expect(isAcceptedEnsembleSteerResult({ status })).toBe(true)
  })

  it.each(['ignored', 'busy', '', undefined])('rejects the unretained %s result', (status) => {
    expect(isAcceptedEnsembleSteerResult(status === undefined ? undefined : { status })).toBe(false)
  })
})
