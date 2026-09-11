import { describe, expect, it } from 'vitest'
import { ChatModeChangeNotices, describeChatModeChangeFailure } from './chatModeChangeNotices'

const GENERIC = 'The chat mode could not be changed. The thread is unchanged.'

describe('describeChatModeChangeFailure', () => {
  // Main's refusal is already written for the user; the only thing between it
  // and the screen is the IPC wrapper.
  it('keeps main sentence and drops the remote-invoke wrapper', () => {
    const error = new Error(
      "Error invoking remote method 'set-chat-kind': Error: The chat mode change could not be " +
        'persisted — the durable record is still a single-provider chat. The thread is unchanged; ' +
        'try the switch again.'
    )
    expect(describeChatModeChangeFailure(error)).toBe(
      'The chat mode change could not be persisted — the durable record is still a ' +
        'single-provider chat. The thread is unchanged; try the switch again.'
    )
  })

  it('drops a bare Error label with no remote wrapper', () => {
    expect(describeChatModeChangeFailure(new Error('Error: Ensemble Mode is disabled.'))).toBe(
      'Ensemble Mode is disabled.'
    )
  })

  it('passes a plain sentence through untouched', () => {
    expect(describeChatModeChangeFailure(new Error('Ensemble Mode is disabled.'))).toBe(
      'Ensemble Mode is disabled.'
    )
  })

  it('reads a thrown string as well as a thrown Error', () => {
    expect(describeChatModeChangeFailure('Ensemble Mode is disabled.')).toBe(
      'Ensemble Mode is disabled.'
    )
  })

  it('falls back when there is nothing to say', () => {
    expect(describeChatModeChangeFailure(new Error(''))).toBe(GENERIC)
    expect(describeChatModeChangeFailure(undefined)).toBe(GENERIC)
    expect(describeChatModeChangeFailure({ code: 500 })).toBe(GENERIC)
  })

  // Machine vocabulary as user copy is a standing taste rule, so a stack frame
  // or an all-caps code gets the fallback rather than being shown verbatim.
  it('falls back rather than showing a stack frame or a bare code', () => {
    expect(describeChatModeChangeFailure(new Error('at Object.invoke (index.js:12:9)'))).toBe(
      GENERIC
    )
    expect(describeChatModeChangeFailure(new Error('EPERM'))).toBe(GENERIC)
  })
})

describe('ChatModeChangeNotices', () => {
  it('holds nothing until something is raised', () => {
    const notices = new ChatModeChangeNotices(() => 10)
    expect(notices.noticeFor('chat-1')).toBeNull()
    notices.raise('chat-1', 'Finish the current turn first to change chat mode.')
    expect(notices.noticeFor('chat-1')).toEqual({
      chatId: 'chat-1',
      message: 'Finish the current turn first to change chat mode.',
      at: 10
    })
  })

  it('keeps a notice raised on one thread off another thread', () => {
    const notices = new ChatModeChangeNotices(() => 0)
    notices.raise('chat-1', 'Ensemble Mode is switched off in Settings.')
    expect(notices.noticeFor('chat-2')).toBeNull()
  })

  // A refusal with no message (already in the requested mode) must not raise an
  // empty notice, or the quiet refusal becomes a blank box on screen.
  it('ignores a raise with no message and no chat', () => {
    const notices = new ChatModeChangeNotices(() => 0)
    const before = notices.snapshot()
    notices.raise('chat-1', null)
    notices.raise(null, 'something')
    notices.raise('chat-1', '')
    expect(notices.noticeFor('chat-1')).toBeNull()
    expect(notices.snapshot()).toBe(before)
  })

  // Multiview: several threads are on screen at once, so the surface asks for
  // the newest among them rather than the focused one alone.
  it('picks the newest notice among the threads on screen', () => {
    let clock = 0
    const notices = new ChatModeChangeNotices(() => clock)
    notices.raise('chat-1', 'older')
    clock = 5
    notices.raise('pane-chat', 'newer')
    expect(notices.newestFor(['chat-1', 'pane-chat'])?.message).toBe('newer')
    expect(notices.newestFor(['pane-chat', 'chat-1'])?.message).toBe('newer')
    expect(notices.newestFor(['chat-1'])?.message).toBe('older')
    expect(notices.newestFor(['chat-9'])).toBeNull()
    expect(notices.newestFor([null, undefined])).toBeNull()
    expect(notices.newestFor([])).toBeNull()
  })

  it('clears a notice and tells subscribers', () => {
    const notices = new ChatModeChangeNotices(() => 0)
    let notified = 0
    const unsubscribe = notices.subscribe(() => {
      notified += 1
    })
    notices.raise('chat-1', 'Finish the current turn first to change chat mode.')
    expect(notified).toBe(1)
    notices.clear('chat-1')
    expect(notified).toBe(2)
    expect(notices.noticeFor('chat-1')).toBeNull()
    unsubscribe()
    notices.raise('chat-1', 'again')
    expect(notified).toBe(2)
  })

  it('does not churn the snapshot clearing a thread that has no notice', () => {
    const notices = new ChatModeChangeNotices(() => 0)
    const before = notices.snapshot()
    notices.clear('chat-1')
    expect(notices.snapshot()).toBe(before)
  })

  it('advances the snapshot on every real change, so a subscriber re-reads', () => {
    const notices = new ChatModeChangeNotices(() => 0)
    const first = notices.snapshot()
    notices.raise('chat-1', 'one')
    const second = notices.snapshot()
    notices.raise('chat-1', 'two')
    expect(second).not.toBe(first)
    expect(notices.snapshot()).not.toBe(second)
  })
})
