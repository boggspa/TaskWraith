import { describe, expect, it } from 'vitest'
import {
  THREAD_MESSAGE_REMAINING_WARN_CHARS,
  threadMessageSendFormState,
  threadMessageSendOutcomeText,
  type ThreadMessageSendFormInput,
  type ThreadMessageSendTarget
} from './ThreadMessageSendFormModel'
import { MAX_THREAD_MESSAGE_CHARS } from '../../../shared/threadMessage'

const NEAR: ThreadMessageSendTarget = {
  chatId: 'chat-b',
  title: 'Byte pin fix',
  workspaceId: 'ws-1',
  crossWorkspace: false
}

const FAR: ThreadMessageSendTarget = {
  chatId: 'chat-far',
  title: 'Other workspace',
  workspaceId: 'ws-2',
  crossWorkspace: true
}

function state(over: Partial<ThreadMessageSendFormInput> = {}) {
  return threadMessageSendFormState({
    targets: [NEAR, FAR],
    selectedChatId: 'chat-b',
    message: 'The byte pin is red on master.',
    wake: false,
    sending: false,
    ...over
  })
}

describe('threadMessageSendFormState — when send is available', () => {
  it('allows a complete form', () => {
    const s = state()
    expect(s.canSend).toBe(true)
    expect(s.blockedReason).toBe('')
    expect(s.selectedTitle).toBe('Byte pin fix')
  })

  it.each([
    ['no targets exist', { targets: [] }, /no other thread/i],
    ['no target chosen', { selectedChatId: '' }, /choose a thread/i],
    ['the message is blank', { message: '   ' }, /write a message/i],
    ['a send is in flight', { sending: true }, /sending/i]
  ])('blocks when %s', (_label, over, pattern) => {
    const s = state(over)
    expect(s.canSend).toBe(false)
    expect(s.blockedReason).toMatch(pattern)
  })

  // A double-click must not be able to send twice; the button is the first guard
  // and the idempotency key is the second.
  it('blocks while sending even with a valid form', () => {
    expect(state({ sending: true }).canSend).toBe(false)
  })

  it('blocks a selection that is not in the target list', () => {
    expect(state({ selectedChatId: 'chat-nope' }).canSend).toBe(false)
  })
})

describe('threadMessageSendFormState — the character budget', () => {
  it('reports remaining characters', () => {
    const s = state({ message: 'x'.repeat(100) })
    expect(s.remainingChars).toBe(MAX_THREAD_MESSAGE_CHARS - 100)
    expect(s.overBudget).toBe(false)
  })

  // Surfaced while there is still room to shorten, not only once it is too late.
  it('hides the counter until the message approaches the cap', () => {
    expect(state({ message: 'short' }).showCounter).toBe(false)
    expect(
      state({
        message: 'x'.repeat(MAX_THREAD_MESSAGE_CHARS - THREAD_MESSAGE_REMAINING_WARN_CHARS)
      }).showCounter
    ).toBe(true)
  })

  it('blocks an over-budget message and says by how much', () => {
    const s = state({ message: 'x'.repeat(MAX_THREAD_MESSAGE_CHARS + 12) })
    expect(s.canSend).toBe(false)
    expect(s.overBudget).toBe(true)
    expect(s.blockedReason).toContain('12 characters over')
  })
})

describe('threadMessageSendFormState — warnings before the send', () => {
  // The whole reason thread-message:targets reports crossWorkspace per candidate:
  // discovering it from an approval prompt after hitting send teaches people to
  // click through prompts.
  it('warns that a cross-workspace send needs approval', () => {
    const s = state({ selectedChatId: 'chat-far' })
    expect(s.crossWorkspaceWarning).toContain('another workspace')
    expect(s.crossWorkspaceWarning).toContain('needs your approval')
    // Still sendable — it is a warning, not a block.
    expect(s.canSend).toBe(true)
  })

  it('does not warn for a same-workspace send', () => {
    expect(state().crossWorkspaceWarning).toBe('')
  })

  // Described by its effect on the other thread, not as a vague "urgent" flag.
  it('describes what wake does to the target thread', () => {
    const s = state({ wake: true })
    expect(s.wakeWarning).toContain('Byte pin fix')
    expect(s.wakeWarning).toContain('start a turn')
    expect(s.wakeWarning).toContain('instead of waiting')
  })

  it('is silent about wake when it is off', () => {
    expect(state().wakeWarning).toBe('')
  })

  it('still describes wake before a target is chosen', () => {
    const s = state({ wake: true, selectedChatId: '' })
    expect(s.wakeWarning).toContain('start a turn')
  })

  it('shows both warnings together for a cross-workspace wake', () => {
    const s = state({ selectedChatId: 'chat-far', wake: true })
    expect(s.crossWorkspaceWarning).not.toBe('')
    expect(s.wakeWarning).not.toBe('')
  })
})

describe('threadMessageSendOutcomeText', () => {
  it('confirms a successful send and says when it lands', () => {
    const result = threadMessageSendOutcomeText({ ok: true })
    expect(result.tone).toBe('ok')
    expect(result.text).toMatch(/next turn/i)
  })

  // A user who cannot tell "the queue is full" from "that thread is gone" retries
  // the wrong thing.
  it.each([
    ['duplicate', 'warn', /already queued/i],
    ['already-delivered', 'warn', /already delivered/i],
    ['inbox-full', 'warn', /inbox is full/i],
    ['unknown-target', 'error', /no longer exists/i]
  ] as const)('distinguishes the %s outcome', (outcome, tone, pattern) => {
    const result = threadMessageSendOutcomeText({ ok: false, outcome })
    expect(result.tone).toBe(tone)
    expect(result.text).toMatch(pattern)
  })

  it('surfaces a gate refusal verbatim rather than inventing a reason', () => {
    const result = threadMessageSendOutcomeText({
      ok: false,
      error: 'Thread messages are disabled for this run.'
    })
    expect(result.tone).toBe('error')
    expect(result.text).toBe('Thread messages are disabled for this run.')
  })

  it('falls back to a plain failure when nothing explains it', () => {
    expect(threadMessageSendOutcomeText({ ok: false }).text).toMatch(/could not be sent/i)
  })
})
