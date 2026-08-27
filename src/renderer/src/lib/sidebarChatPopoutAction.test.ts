import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { createSidebarChatPopoutAction } from './sidebarChatPopoutAction'

describe('createSidebarChatPopoutAction', () => {
  it('opens the exact thread represented by the menu row', () => {
    const chat = { appChatId: 'chat-1', title: 'Release thread' } as ChatRecord
    const onOpenChatPopout = vi.fn()

    const action = createSidebarChatPopoutAction(chat, onOpenChatPopout)

    expect(action).toMatchObject({
      id: 'open-chat-popout',
      label: 'Open in Pop-Out',
      group: 'primary'
    })
    action.onSelect()
    expect(onOpenChatPopout).toHaveBeenCalledOnce()
    expect(onOpenChatPopout).toHaveBeenCalledWith(chat)
  })
})
