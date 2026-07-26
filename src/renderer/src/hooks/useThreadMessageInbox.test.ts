import { describe, expect, it } from 'vitest'
import { shouldRefetchThreadMessageInbox } from './useThreadMessageInbox'

const delivery = (chatId: string) => ({ chatId })

describe('shouldRefetchThreadMessageInbox', () => {
  it('refetches when the watched chat changes', () => {
    expect(shouldRefetchThreadMessageInbox('chat-b', delivery('chat-b'))).toBe(true)
  })

  // Refetching on every chat update would put an IPC round-trip behind every
  // keystroke-driven save in the app, for a panel usually looking at one thread.
  it('ignores updates for other chats', () => {
    expect(shouldRefetchThreadMessageInbox('chat-b', delivery('chat-a'))).toBe(false)
  })

  it.each([
    ['no delivery', undefined],
    ['a null delivery', null],
    ['a delivery with no chat id', { chatId: '' }]
  ])('ignores %s', (_label, value) => {
    expect(shouldRefetchThreadMessageInbox('chat-b', value)).toBe(false)
  })

  // Nothing is being watched, so nothing should be fetched — including on an
  // update that happens to carry an empty id too.
  it.each([
    ['a matching-looking empty id', { chatId: '' }],
    ['a real chat id', { chatId: 'chat-a' }]
  ])('does not refetch when no chat is watched, given %s', (_label, value) => {
    expect(shouldRefetchThreadMessageInbox('', value)).toBe(false)
  })
})
