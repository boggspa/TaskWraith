import { describe, expect, it } from 'vitest'
import { ComposerSubmitLedger } from './composerSubmitLedger'

describe('ComposerSubmitLedger', () => {
  it('takes a submit the first time its revision is offered', () => {
    const ledger = new ComposerSubmitLedger()
    expect(ledger.accept('chat-1', 4)).toBe(true)
    expect(ledger.lastAccepted('chat-1')).toBe(4)
  })

  // The reported failure: the box never cleared because the app was
  // unresponsive, so every further press re-read the same unedited draft.
  it('drops every repeat of an unedited draft, however many there are', () => {
    const ledger = new ComposerSubmitLedger()
    expect(ledger.accept('chat-1', 7)).toBe(true)
    const repeats = [7, 7, 7, 7, 7, 7, 7, 7]
    expect(repeats.map((revision) => ledger.accept('chat-1', revision))).toEqual(
      repeats.map(() => false)
    )
  })

  // Anything typed in between is a new message — including the same words
  // retyped after the box cleared, which is two edits and so two revisions.
  it('takes the next submit once the draft has been edited', () => {
    const ledger = new ComposerSubmitLedger()
    ledger.accept('chat-1', 7)
    expect(ledger.accept('chat-1', 8)).toBe(true)
    expect(ledger.accept('chat-1', 9)).toBe(true)
  })

  // A submit built before an edit and delivered after it must not reopen a
  // message already sent.
  it('refuses a revision older than the one it already took', () => {
    const ledger = new ComposerSubmitLedger()
    ledger.accept('chat-1', 9)
    expect(ledger.accept('chat-1', 8)).toBe(false)
    expect(ledger.lastAccepted('chat-1')).toBe(9)
  })

  // A never-edited draft — text restored from localStorage at module load —
  // submits at revision 0 and must go exactly once.
  it('takes a never-edited draft once and no more', () => {
    const ledger = new ComposerSubmitLedger()
    expect(ledger.accept('chat-1', 0)).toBe(true)
    expect(ledger.accept('chat-1', 0)).toBe(false)
  })

  it('keeps chats independent', () => {
    const ledger = new ComposerSubmitLedger()
    ledger.accept('chat-1', 3)
    expect(ledger.accept('chat-2', 3)).toBe(true)
    expect(ledger.accept('chat-1', 3)).toBe(false)
  })

  // Revisions restart at zero when a chat's draft store is reset, so a retained
  // ceiling would refuse the next real message.
  it('forgets a chat so its revisions can restart', () => {
    const ledger = new ComposerSubmitLedger()
    ledger.accept('chat-1', 5)
    ledger.forget('chat-1')
    expect(ledger.lastAccepted('chat-1')).toBeUndefined()
    expect(ledger.accept('chat-1', 0)).toBe(true)
  })

  // Fail open: refusing a real message is worse than admitting a duplicate.
  it('never refuses a submit it cannot identify', () => {
    const ledger = new ComposerSubmitLedger()
    ledger.accept('chat-1', 5)
    expect(ledger.accept(null, 5)).toBe(true)
    expect(ledger.accept('chat-1', undefined)).toBe(true)
    expect(ledger.accept('chat-1', Number.NaN)).toBe(true)
    expect(ledger.lastAccepted('chat-1')).toBe(5)
  })
})
