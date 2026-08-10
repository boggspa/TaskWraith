import { basename } from 'path'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import type { KeyPair } from '../../shared/e2ee/keys'
import type { ChannelIpcChangeEvent } from '../../shared/collaboration/ChannelIpc'
import type { TransportSocketFactory } from '../remote/RemoteTransportClient'
import { resolveChatPrimaryWorkspace } from '../ExternalPathGrantBinding'
import type { ChatRecord, WorkspaceRecord } from '../store/types'
import {
  registerChannelAgentHandlers,
  type ChannelAgentHandlersRegistration
} from '../ipc/channelAgentHandlers'
import {
  registerChannelHandlers,
  type ChannelHandlersRegistration,
  type ChannelIpcSenderScope
} from '../ipc/channelHandlers'
import {
  ChannelAgentManagementController,
  type ChannelAgentManagementControllerDependencies,
  type ChannelAgentWorkspaceResolution
} from './ChannelAgentManagementController'
import {
  createChannelProductionService,
  type ChannelProductionAgentExecutionOptions,
  type ChannelProductionRelayPort,
  type ChannelProductionService,
  type ChannelProductionServiceOptions,
  type ChannelProductionStatus
} from './ChannelProductionService'
import type { ChannelAgentIdentitySafeStorage } from './ChannelAgentIdentityStore'

export interface ChannelProductionRelaySources {
  getEmbeddedRelayPort: () => number | null | undefined
  getAdvertisedRelayUrls: () => readonly string[]
}

export interface ChannelProductionAgentManagementOptions extends Omit<
  ChannelAgentManagementControllerDependencies,
  'service' | 'getChat' | 'resolveWorkspace'
> {
  getWorkspaces: () => readonly WorkspaceRecord[]
  canonicalizePath: (value: string) => string
  getOwnerWindow: (event: IpcMainInvokeEvent) => BrowserWindow | null
}

export type ChannelProductionAgentRuntimeOptions = Omit<
  ChannelProductionAgentExecutionOptions,
  'getChat' | 'resolveWorkspacePrincipal' | 'getSettings' | 'providerAllowed'
>

export interface ChannelProductionBootstrapOptions {
  userDataPath: string
  loadIdentity: () => KeyPair
  safeStorage: ChannelAgentIdentitySafeStorage
  relay: ChannelProductionRelayPort
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  getChat: (chatId: string) => ChatRecord | null
  isMainSender: (event: IpcMainInvokeEvent) => boolean
  getOwnedChatId: (senderId: number) => string | null | undefined
  publishToMain: (event: ChannelIpcChangeEvent) => void
  publishToChat: (chatId: string, event: ChannelIpcChangeEvent) => void
  agentManagement: ChannelProductionAgentManagementOptions
  agentExecution: ChannelProductionAgentRuntimeOptions
  socketFactory?: TransportSocketFactory
  logger?: (line: string) => void
  createService?: (options: ChannelProductionServiceOptions) => ChannelProductionService
}

export interface ChannelProductionBootstrap {
  readonly service: ChannelProductionService
  start(): ChannelProductionStatus
  startAgentExecution(): void
  refreshRelayRooms(): number
  stop(): Promise<void>
}

function advertisedRelayUrls(sources: ChannelProductionRelaySources): string[] {
  try {
    const urls = sources.getAdvertisedRelayUrls()
    if (!Array.isArray(urls)) return []
    return [
      ...new Set(
        urls
          .filter((url): url is string => typeof url === 'string')
          .map((url) => url.trim())
          .filter(Boolean)
      )
    ]
  } catch {
    return []
  }
}

function resolveAgentWorkspace(
  chat: ChatRecord,
  options: ChannelProductionAgentManagementOptions
): ChannelAgentWorkspaceResolution | null {
  if (chat.scope === 'global') {
    return {
      principal: { kind: 'global', chatId: chat.appChatId },
      label: 'Global chat'
    }
  }
  if (!chat.workspaceId) return null
  let workspace: WorkspaceRecord | null
  try {
    workspace = resolveChatPrimaryWorkspace(chat, options.getWorkspaces(), options.canonicalizePath)
  } catch {
    return null
  }
  if (!workspace || workspace.id !== chat.workspaceId) return null
  return {
    principal: { kind: 'workspace', workspaceId: workspace.id },
    label: workspace.displayName.trim() || basename(workspace.path) || 'Workspace'
  }
}

/**
 * Adapts the existing remote relay runtime without giving Channels ownership
 * of it. The host always prefers loopback for an embedded relay; invitees get
 * every advertised door plus that host fallback.
 */
export function createChannelProductionRelayPort(
  sources: ChannelProductionRelaySources
): ChannelProductionRelayPort {
  if (
    !sources ||
    typeof sources.getEmbeddedRelayPort !== 'function' ||
    typeof sources.getAdvertisedRelayUrls !== 'function'
  ) {
    throw new Error('Channel production relay sources are required')
  }

  const hostRelayUrl = (): string => {
    try {
      const port = sources.getEmbeddedRelayPort()
      if (Number.isSafeInteger(port) && Number(port) > 0 && Number(port) <= 65_535) {
        return `ws://127.0.0.1:${port}`
      }
    } catch {
      // Fall through to the advertised relay.
    }
    return advertisedRelayUrls(sources)[0] ?? ''
  }

  return {
    hostRelayUrl,
    inviteRelayUrls: () =>
      [...new Set([...advertisedRelayUrls(sources), hostRelayUrl()])].filter(Boolean)
  }
}

export function createChannelProductionBootstrap(
  options: ChannelProductionBootstrapOptions
): ChannelProductionBootstrap {
  if (!options || typeof options !== 'object') {
    throw new Error('ChannelProductionBootstrap requires an options object')
  }
  if (typeof options.userDataPath !== 'string' || !options.userDataPath.trim()) {
    throw new Error('ChannelProductionBootstrap requires an injected userDataPath')
  }
  if (typeof options.loadIdentity !== 'function') {
    throw new Error('ChannelProductionBootstrap requires an identity loader')
  }
  if (!options.safeStorage || typeof options.safeStorage !== 'object') {
    throw new Error('ChannelProductionBootstrap requires injected safeStorage')
  }
  if (!options.relay || typeof options.relay !== 'object') {
    throw new Error('ChannelProductionBootstrap requires a relay port')
  }
  if (!options.ipc || typeof options.ipc.handle !== 'function') {
    throw new Error('ChannelProductionBootstrap requires an IPC registrar')
  }
  if (
    typeof options.getChat !== 'function' ||
    typeof options.isMainSender !== 'function' ||
    typeof options.getOwnedChatId !== 'function'
  ) {
    throw new Error('ChannelProductionBootstrap requires renderer authority ports')
  }
  if (typeof options.publishToMain !== 'function' || typeof options.publishToChat !== 'function') {
    throw new Error('ChannelProductionBootstrap requires renderer publication ports')
  }
  if (
    !options.agentManagement ||
    typeof options.agentManagement.getSettings !== 'function' ||
    typeof options.agentManagement.providerAllowed !== 'function' ||
    typeof options.agentManagement.getWorkspaces !== 'function' ||
    typeof options.agentManagement.canonicalizePath !== 'function' ||
    typeof options.agentManagement.getOwnerWindow !== 'function' ||
    (options.agentManagement.confirm !== undefined &&
      typeof options.agentManagement.confirm !== 'function')
  ) {
    throw new Error('ChannelProductionBootstrap agent management requires main-owned authority')
  }
  if (
    !options.agentExecution ||
    typeof options.agentExecution.composeMainOwnedChannelAgentRun !== 'function' ||
    typeof options.agentExecution.dispatch !== 'function' ||
    typeof options.agentExecution.subscribeRunEvents !== 'function' ||
    typeof options.agentExecution.subscribeRunSessions !== 'function' ||
    typeof options.agentExecution.claimRunAudience !== 'function' ||
    typeof options.agentExecution.reconcileRun !== 'function'
  ) {
    throw new Error('ChannelProductionBootstrap agent execution requires main-owned runtime ports')
  }
  if (options.createService !== undefined && typeof options.createService !== 'function') {
    throw new Error('ChannelProductionBootstrap createService must be a function')
  }

  let stopped = false
  let registration: ChannelHandlersRegistration | null = null
  let agentRegistration: ChannelAgentHandlersRegistration | null = null
  let stopPromise: Promise<void> | null = null

  const publishChange = (event: {
    channelId: string
    chatId: string
    reason: ChannelIpcChangeEvent['reason']
  }): void => {
    if (stopped) return
    const projected: ChannelIpcChangeEvent = {
      channelId: event.channelId,
      reason: event.reason
    }
    try {
      options.publishToMain(projected)
    } catch {
      options.logger?.('[channels] main renderer change publication failed')
    }
    try {
      options.publishToChat(event.chatId, projected)
    } catch {
      options.logger?.('[channels] chat renderer change publication failed')
    }
  }

  const serviceFactory = options.createService ?? createChannelProductionService
  const service = serviceFactory({
    userDataPath: options.userDataPath,
    loadIdentity: options.loadIdentity,
    safeStorage: options.safeStorage,
    relay: options.relay,
    agentExecution: {
      ...options.agentExecution,
      getChat: options.getChat,
      resolveWorkspacePrincipal: (chat) =>
        resolveAgentWorkspace(chat, options.agentManagement)?.principal ?? null,
      getSettings: options.agentManagement.getSettings,
      providerAllowed: (provider) =>
        options.agentManagement.providerAllowed(provider, options.agentManagement.getSettings())
    },
    ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    onChange: publishChange
  })
  const agentController = new ChannelAgentManagementController({
    service,
    getChat: options.getChat,
    getSettings: options.agentManagement.getSettings,
    providerAllowed: options.agentManagement.providerAllowed,
    resolveWorkspace: (chat) => resolveAgentWorkspace(chat, options.agentManagement),
    ...(options.agentManagement.confirm ? { confirm: options.agentManagement.confirm } : {})
  })

  const resolveSenderScope = (event: IpcMainInvokeEvent): ChannelIpcSenderScope => {
    if (options.isMainSender(event)) return { kind: 'main' }
    const chatId = options.getOwnedChatId(event.sender.id)
    if (typeof chatId === 'string' && chatId.length > 0) return { kind: 'chat', chatId }
    throw new Error('Renderer has no main-owned Channels scope')
  }

  return {
    service,
    start: () => {
      if (stopped) throw new Error('ChannelProductionBootstrap has stopped')
      if (registration) return service.start()
      try {
        registration = registerChannelHandlers(options.ipc, {
          service,
          getChat: options.getChat,
          resolveSenderScope
        })
        agentRegistration = registerChannelAgentHandlers(options.ipc, {
          controller: agentController,
          isMainSender: options.isMainSender,
          getOwnerWindow: options.agentManagement.getOwnerWindow
        })
        return service.start()
      } catch (error) {
        agentRegistration?.dispose()
        agentRegistration = null
        registration?.dispose()
        registration = null
        void service.stop().catch(() => undefined)
        throw error
      }
    },
    startAgentExecution: () => {
      if (stopped) throw new Error('ChannelProductionBootstrap has stopped')
      if (!registration) throw new Error('ChannelProductionBootstrap has not started')
      service.startAgentExecution()
    },
    refreshRelayRooms: () => service.refreshRelayRooms(),
    stop: () => {
      if (stopPromise) return stopPromise
      stopped = true
      agentRegistration?.dispose()
      agentRegistration = null
      registration?.dispose()
      registration = null
      stopPromise = service.stop()
      return stopPromise
    }
  }
}
