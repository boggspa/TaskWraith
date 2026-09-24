import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import {
  createSidebarChatPopoutAction,
  createSidebarChatPopoutActions
} from './sidebarChatPopoutAction'

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
    expect(onOpenChatPopout).toHaveBeenCalledWith(chat, 'full')
  })

  it('adds the compact companion alongside the existing full popout', () => {
    const chat = { appChatId: 'chat-1', title: 'Release thread' } as ChatRecord
    const onOpenChatPopout = vi.fn()

    const actions = createSidebarChatPopoutActions(chat, onOpenChatPopout)

    expect(actions.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'open-chat-popout', label: 'Open in Pop-Out' },
      { id: 'open-compact-companion', label: 'Open Compact Companion' }
    ])
    actions[1].onSelect()
    expect(onOpenChatPopout).toHaveBeenCalledWith(chat, 'compact')
  })
})
