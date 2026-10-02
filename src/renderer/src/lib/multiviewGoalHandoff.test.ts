import { describe, expect, it, vi } from 'vitest'
import { createMultiviewGoalHandoff } from './multiviewGoalHandoff'

const panes = [
  { id: 'a', chatId: 'chat-a' },
  { id: 'b', chatId: 'chat-b' }
]

describe('Multiview goal handoff', () => {
  it('waits for exact focus and projection then opens once', () => {
    const controller = createMultiviewGoalHandoff()
    const open = vi.fn()
    controller.request({ paneId: 'b', chatId: 'chat-b' })
    controller.reconcile({ panes, focusedPaneId: 'a', projectedChatId: 'chat-a', open })
    controller.observeFocus('b')
    controller.reconcile({ panes, focusedPaneId: 'b', projectedChatId: 'chat-a', open })
    expect(open).not.toHaveBeenCalled()
    controller.reconcile({ panes, focusedPaneId: 'b', projectedChatId: 'chat-b', open })
    controller.reconcile({ panes, focusedPaneId: 'b', projectedChatId: 'chat-b', open })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it.each(['changed', 'removed', 'superseded'] as const)('cancels a %s target', (mode) => {
    const controller = createMultiviewGoalHandoff()
    const open = vi.fn()
    controller.request({ paneId: 'b', chatId: 'chat-b' })
    if (mode === 'superseded') controller.observeFocus('a')
    controller.reconcile({
      panes:
        mode === 'removed'
          ? panes.slice(0, 1)
          : mode === 'changed'
            ? [{ id: 'b', chatId: 'other' }]
            : panes,
      focusedPaneId: 'b',
      projectedChatId: 'chat-b',
      open
    })
    controller.reconcile({ panes, focusedPaneId: 'b', projectedChatId: 'chat-b', open })
    expect(open).not.toHaveBeenCalled()
  })

  it('distinguishes duplicate-chat panes and supports already projected focus', () => {
    const controller = createMultiviewGoalHandoff()
    const open = vi.fn()
    const duplicates = [
      { id: 'a', chatId: 'same' },
      { id: 'b', chatId: 'same' }
    ]
    controller.request({ paneId: 'b', chatId: 'same' })
    controller.reconcile({ panes: duplicates, focusedPaneId: 'a', projectedChatId: 'same', open })
    expect(open).not.toHaveBeenCalled()
    controller.reconcile({ panes: duplicates, focusedPaneId: 'b', projectedChatId: 'same', open })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('replaces prior requests without opening the old target', () => {
    const controller = createMultiviewGoalHandoff()
    const open = vi.fn()
    controller.request({ paneId: 'b', chatId: 'chat-b' })
    controller.request({ paneId: 'a', chatId: 'chat-a' })
    controller.reconcile({ panes, focusedPaneId: 'b', projectedChatId: 'chat-b', open })
    controller.reconcile({ panes, focusedPaneId: 'a', projectedChatId: 'chat-a', open })
    expect(open).toHaveBeenCalledTimes(1)
  })
})
