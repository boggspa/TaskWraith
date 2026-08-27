import type { ChatRecord } from '../../../main/store/types'

export interface SidebarChatPopoutAction {
  id: 'open-chat-popout'
  label: 'Open in Pop-Out'
  group: 'primary'
  onSelect: () => void
}

/** Build the shared context-menu action used by every sidebar thread surface. */
export function createSidebarChatPopoutAction(
  chat: ChatRecord,
  onOpenChatPopout: (chat: ChatRecord) => void
): SidebarChatPopoutAction {
  return {
    id: 'open-chat-popout',
    label: 'Open in Pop-Out',
    group: 'primary',
    onSelect: () => onOpenChatPopout(chat)
  }
}
