import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import {
  buildTranscriptMessageContextMenuItems,
  TranscriptMessageContextMenu,
  type TranscriptMessageContextMenuSelection
} from './TranscriptMessageContextMenu'

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    content: 'Transcript body',
    timestamp: '2026-06-16T12:00:00.000Z',
    ...overrides
  }
}

function selection(
  overrides: Partial<TranscriptMessageContextMenuSelection> = {}
): TranscriptMessageContextMenuSelection {
  const baseMessage = message()
  return {
    anchor: { x: 24, y: 48 },
    message: baseMessage,
    copyContent: baseMessage.content,
    label: 'assistant message',
    pinned: false,
    ...overrides
  }
}

describe('TranscriptMessageContextMenu', () => {
  it('renders the same message actions as the hover action pill', () => {
    const html = renderToStaticMarkup(
      <TranscriptMessageContextMenu
        selection={selection({ pinned: true })}
        onCopyMessage={() => {}}
        onTogglePinMessage={() => {}}
        onOpenSideChatFromMessage={() => {}}
        onDeleteMessage={() => {}}
        onClose={() => {}}
      />
    )

    expect(html).toContain('Actions for assistant message')
    expect(html).toContain('Copy message')
    expect(html).toContain('Unpin message')
    expect(html).toContain('Open side chat')
    expect(html).toContain('Delete message')
    expect(html).toContain('is-danger')
  })

  it('routes selected actions through transcript callbacks', () => {
    const selectedMessage = message()
    const onCopyMessage = vi.fn()
    const onTogglePinMessage = vi.fn()
    const onOpenSideChatFromMessage = vi.fn()
    const onDeleteMessage = vi.fn()
    const items = buildTranscriptMessageContextMenuItems({
      selection: selection({ message: selectedMessage, copyContent: 'copy body' }),
      onCopyMessage,
      onTogglePinMessage,
      onOpenSideChatFromMessage,
      onDeleteMessage
    })

    items.find((item) => item.id === 'copy')?.onSelect()
    items.find((item) => item.id === 'pin')?.onSelect()
    items.find((item) => item.id === 'side-chat')?.onSelect()
    items.find((item) => item.id === 'delete')?.onSelect()

    expect(onCopyMessage).toHaveBeenCalledWith('message-1', 'copy body')
    expect(onTogglePinMessage).toHaveBeenCalledWith('message-1')
    expect(onOpenSideChatFromMessage).toHaveBeenCalledWith(selectedMessage)
    expect(onDeleteMessage).toHaveBeenCalledWith('message-1')
  })

  it('offers closed-set poor-rating reasons and passes the selected code', () => {
    const onMessageFeedback = vi.fn()
    const items = buildTranscriptMessageContextMenuItems({
      selection: selection(),
      onCopyMessage: () => {},
      onMessageFeedback
    })

    expect(items.map((item) => item.id)).toContain('thumbs-down:wrong-model-for-role')

    items.find((item) => item.id === 'thumbs-down:wrong-model-for-role')?.onSelect()

    expect(onMessageFeedback).toHaveBeenCalledWith('message-1', 'down', {
      reason: 'wrong-model-for-role'
    })
  })

  it('omits side-chat actions for retired external-channel inbound rows', () => {
    const items = buildTranscriptMessageContextMenuItems({
      selection: selection({
        message: message({ role: 'user', metadata: { kind: 'channelInbound' } })
      }),
      onCopyMessage: () => {},
      onOpenSideChatFromMessage: () => {}
    })

    expect(items.map((item) => item.id)).toEqual(['copy'])
  })

  it('omits actions whose callbacks are not available', () => {
    const items = buildTranscriptMessageContextMenuItems({
      selection: selection(),
      onCopyMessage: () => {}
    })

    expect(items.map((item) => item.id)).toEqual(['copy'])
  })

  it('supports copy-only surfaces such as provider failure cards', () => {
    const items = buildTranscriptMessageContextMenuItems({
      selection: selection({ label: 'provider failure', copyOnly: true }),
      onCopyMessage: () => {},
      onTogglePinMessage: () => {},
      onOpenSideChatFromMessage: () => {},
      onDeleteMessage: () => {}
    })

    expect(items.map((item) => item.id)).toEqual(['copy'])
  })
})
