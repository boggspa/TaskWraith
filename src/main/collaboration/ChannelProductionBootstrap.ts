import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { KeyPair } from '../../shared/e2ee/keys'
import type { ChannelIpcChangeEvent } from '../../shared/collaboration/ChannelIpc'
import type { TransportSocketFactory } from '../remote/RemoteTransportClient'
import {
  registerChannelHandlers,
  type ChannelHandlersDeps,
  type ChannelHandlersRegistration,
  type ChannelIpcSenderScope
} from '../ipc/channelHandlers'
import {
  createChannelProductionService,
  type ChannelProductionRelayPort,
  type ChannelProductionService,
  type ChannelProductionServiceOptions,
  type ChannelProductionStatus
} from './ChannelProductionService'

export interface ChannelProductionRelaySources {
  getEmbeddedRelayPort: () => number | null | undefined
  getAdvertisedRelayUrls: () => readonly string[]
}

export interface ChannelProductionBootstrapOptions {
  userDataPath: string
  loadIdentity: () => KeyPair
  relay: ChannelProductionRelayPort
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  getChat: ChannelHandlersDeps['getChat']
  isMainSender: (event: IpcMainInvokeEvent) => boolean
  getOwnedChatId: (senderId: number) => string | null | undefined
  publishToMain: (event: ChannelIpcChangeEvent) => void
  publishToChat: (chatId: string, event: ChannelIpcChangeEvent) => void
  socketFactory?: TransportSocketFactory
  logger?: (line: string) => void
  createService?: (options: ChannelProductionServiceOptions) => ChannelProductionService
}

export interface ChannelProductionBootstrap {
  readonly service: ChannelProductionService
  start(): ChannelProductionStatus
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
  if (options.createService !== undefined && typeof options.createService !== 'function') {
    throw new Error('ChannelProductionBootstrap createService must be a function')
  }

  let stopped = false
  let registration: ChannelHandlersRegistration | null = null
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
    relay: options.relay,
    ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    onChange: publishChange
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
      registration = registerChannelHandlers(options.ipc, {
        service,
        getChat: options.getChat,
        resolveSenderScope
      })
      try {
        return service.start()
      } catch (error) {
        registration.dispose()
        registration = null
        void service.stop().catch(() => undefined)
        throw error
      }
    },
    refreshRelayRooms: () => service.refreshRelayRooms(),
    stop: () => {
      if (stopPromise) return stopPromise
      stopped = true
      registration?.dispose()
      registration = null
      stopPromise = service.stop()
      return stopPromise
    }
  }
}
