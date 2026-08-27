import type { ChatRecord } from '../../../main/store/types'
import type { ChatPopoutPresentation } from '../../../shared/chatPopoutPresentation'

export interface SidebarChatPopoutAction {
  id: 'open-chat-popout' | 'open-compact-companion'
  label: 'Open in Pop-Out' | 'Open Compact Companion'
  group: 'primary'
  onSelect: () => void
}

export type SidebarChatPopoutHandler = (
  chat: ChatRecord,
  presentation: ChatPopoutPresentation
) => void

/** Build the shared context-menu action used by every sidebar thread surface. */
export function createSidebarChatPopoutAction(
  chat: ChatRecord,
  onOpenChatPopout: SidebarChatPopoutHandler
): SidebarChatPopoutAction {
  return {
    id: 'open-chat-popout',
    label: 'Open in Pop-Out',
    group: 'primary',
    onSelect: () => onOpenChatPopout(chat, 'full')
  }
}

export function createSidebarCompactCompanionAction(
  chat: ChatRecord,
  onOpenChatPopout: SidebarChatPopoutHandler
): SidebarChatPopoutAction {
  return {
    id: 'open-compact-companion',
    label: 'Open Compact Companion',
    group: 'primary',
    onSelect: () => onOpenChatPopout(chat, 'compact')
  }
}

export function createSidebarChatPopoutActions(
  chat: ChatRecord,
  onOpenChatPopout: SidebarChatPopoutHandler
): SidebarChatPopoutAction[] {
  return [
    createSidebarChatPopoutAction(chat, onOpenChatPopout),
    createSidebarCompactCompanionAction(chat, onOpenChatPopout)
  ]
}
