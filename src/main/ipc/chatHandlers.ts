import { ipcMain } from 'electron'
import type { ChatService } from '../services/ChatService'
import type { AppSettings, ChatRecord, ProviderId } from '../store/types'

export interface ChatHandlerDeps {
  chatService: Pick<
    ChatService,
    | 'getChats'
    | 'getChatList'
    | 'getPinnedMessages'
    | 'getChat'
    | 'createChat'
    | 'createGlobalChat'
    | 'createEnsembleChat'
    | 'createSubThread'
    | 'getSubThreads'
    | 'createSideChat'
    | 'getSideChats'
    | 'setGuestParticipant'
    | 'removeGuestParticipant'
  >
  getSettings: () => AppSettings
  detectConfiguredProviders: (settings: AppSettings) => Promise<Set<ProviderId>>
  broadcastThreadUpdate: (chatId: string | undefined) => void
  broadcastChatPopoutUpdate: (chat: ChatRecord) => void
}

export function registerChatHandlers(deps: ChatHandlerDeps): void {
  ipcMain.handle('get-chats', (_event, workspaceId?: string) =>
    deps.chatService.getChats(workspaceId)
  )
  ipcMain.handle('get-chat-list', (_event, workspaceId?: string) =>
    deps.chatService.getChatList(workspaceId)
  )
  ipcMain.handle('get-pinned-messages', (_event, workspaceId?: string) =>
    deps.chatService.getPinnedMessages(workspaceId)
  )
  ipcMain.handle('get-chat', (_event, chatId: string) => deps.chatService.getChat(chatId))
  ipcMain.handle('create-chat', (_event, workspaceId: string, workspacePath: string) => {
    const chat = deps.chatService.createChat(workspaceId, workspacePath)
    deps.broadcastThreadUpdate(chat?.appChatId)
    return chat
  })
  ipcMain.handle('create-global-chat', () => {
    const chat = deps.chatService.createGlobalChat()
    deps.broadcastThreadUpdate(chat?.appChatId)
    return chat
  })
  ipcMain.handle(
    'create-ensemble-chat',
    async (_event, args?: { workspaceId?: string; workspacePath?: string }) => {
      if (deps.getSettings().ensembleModeEnabled === false) {
        throw new Error('Ensemble Mode is disabled.')
      }
      const configuredProviders = await deps.detectConfiguredProviders(deps.getSettings())
      const chat = deps.chatService.createEnsembleChat(args, configuredProviders)
      deps.broadcastThreadUpdate(chat?.appChatId)
      return chat
    }
  )
  ipcMain.handle(
    'create-sub-thread',
    (
      _event,
      args: {
        parentChatId: string
        provider: ProviderId
        delegationPrompt: string
        returnResultToParent: boolean
        workspaceId?: string
        workspacePath?: string
      }
    ) => {
      const chat = deps.chatService.createSubThread(args)
      deps.broadcastThreadUpdate(chat?.appChatId)
      return chat
    }
  )
  ipcMain.handle('get-sub-threads', (_event, parentChatId: string) =>
    deps.chatService.getSubThreads(parentChatId)
  )
  ipcMain.handle(
    'create-side-chat',
    (
      _event,
      args: {
        parentChatId: string
        chatKind?: ChatRecord['chatKind']
        provider?: ProviderId
        title?: string
        originMessageId?: string
        originRunId?: string
        sideChatMode?: 'ensembleClone' | 'singleProvider' | 'fanOut' | 'guestParticipant'
      }
    ) => {
      const chat = deps.chatService.createSideChat(args)
      deps.broadcastThreadUpdate(chat?.appChatId)
      return chat
    }
  )
  ipcMain.handle('get-side-chats', (_event, parentChatId: string) =>
    deps.chatService.getSideChats(parentChatId)
  )
  ipcMain.handle(
    'set-guest-participant',
    (
      _event,
      args: {
        parentChatId: string
        provider: ProviderId
        selectedModelType?: string
        customModel?: string
        codexReasoningEffort?: string | null
        codexServiceTier?: string | null
        claudeReasoningEffort?: string | null
        claudeFastMode?: boolean | null
        kimiThinkingEnabled?: boolean
      }
    ) => {
      const result = deps.chatService.setGuestParticipant(args)
      deps.broadcastChatPopoutUpdate(result.parent)
      deps.broadcastChatPopoutUpdate(result.guest)
      deps.broadcastThreadUpdate(result.parent.appChatId)
      deps.broadcastThreadUpdate(result.guest.appChatId)
      return result
    }
  )
  ipcMain.handle('remove-guest-participant', (_event, parentChatId: string) => {
    const result = deps.chatService.removeGuestParticipant(parentChatId)
    deps.broadcastChatPopoutUpdate(result.parent)
    if (result.guest) deps.broadcastChatPopoutUpdate(result.guest)
    deps.broadcastThreadUpdate(result.parent.appChatId)
    if (result.guest) deps.broadcastThreadUpdate(result.guest.appChatId)
    return result
  })
}
