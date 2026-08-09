import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { ChannelMemberIpcChangeEvent } from '../../shared/collaboration/ChannelMemberIpc'
import type { TransportSocketFactory } from '../remote/RemoteTransportClient'
import {
  registerChannelMemberHandlers,
  type ChannelMemberHandlersRegistration
} from '../ipc/channelMemberHandlers'
import type { HumanCollaborationSafeStorage } from './HumanCollaborationIdentityStore'
import {
  createChannelMemberProductionService,
  type ChannelMemberProductionService,
  type ChannelMemberProductionServiceOptions,
  type ChannelMemberProductionSnapshot
} from './ChannelMemberProductionService'

export interface ChannelMemberProductionBootstrapOptions {
  userDataPath: string
  safeStorage: HumanCollaborationSafeStorage
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  assertMainRendererSender: (event: IpcMainInvokeEvent) => void
  publishToMain: (event: ChannelMemberIpcChangeEvent) => void
  socketFactory?: TransportSocketFactory
  logger?: (line: string) => void
  createService?: (options: ChannelMemberProductionServiceOptions) => ChannelMemberProductionService
}

export interface ChannelMemberProductionBootstrap {
  readonly service: ChannelMemberProductionService
  start(): ChannelMemberProductionSnapshot
  stop(): Promise<void>
}

function projectChange(snapshot: ChannelMemberProductionSnapshot): ChannelMemberIpcChangeEvent {
  const channelId = snapshot.channel?.channelId
  return {
    reason: 'snapshot',
    ...(typeof channelId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(channelId)
      ? { channelId }
      : {})
  }
}

export function createChannelMemberProductionBootstrap(
  options: ChannelMemberProductionBootstrapOptions
): ChannelMemberProductionBootstrap {
  if (!options || typeof options !== 'object') {
    throw new Error('ChannelMemberProductionBootstrap requires an options object')
  }
  if (typeof options.userDataPath !== 'string' || !options.userDataPath.trim()) {
    throw new Error('ChannelMemberProductionBootstrap requires an injected userDataPath')
  }
  if (!options.safeStorage || typeof options.safeStorage !== 'object') {
    throw new Error('ChannelMemberProductionBootstrap requires safeStorage')
  }
  if (!options.ipc || typeof options.ipc.handle !== 'function') {
    throw new Error('ChannelMemberProductionBootstrap requires an IPC registrar')
  }
  if (
    typeof options.assertMainRendererSender !== 'function' ||
    typeof options.publishToMain !== 'function'
  ) {
    throw new Error('ChannelMemberProductionBootstrap requires main-renderer authority ports')
  }
  if (options.socketFactory !== undefined && typeof options.socketFactory !== 'function') {
    throw new Error('ChannelMemberProductionBootstrap socketFactory must be a function')
  }
  if (options.createService !== undefined && typeof options.createService !== 'function') {
    throw new Error('ChannelMemberProductionBootstrap createService must be a function')
  }

  let started = false
  let stopped = false
  let registration: ChannelMemberHandlersRegistration | null = null
  let stopPromise: Promise<void> | null = null

  const publishChange = (snapshot: ChannelMemberProductionSnapshot): void => {
    if (!started || stopped) return
    try {
      options.publishToMain(projectChange(snapshot))
    } catch {
      options.logger?.('[channels] member projection publication failed')
    }
  }

  const serviceFactory = options.createService ?? createChannelMemberProductionService
  const service = serviceFactory({
    userDataPath: options.userDataPath,
    safeStorage: options.safeStorage,
    ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    onChange: publishChange
  })

  return {
    service,
    start: () => {
      if (stopped) throw new Error('ChannelMemberProductionBootstrap has stopped')
      if (started) return service.snapshot()
      try {
        registration = registerChannelMemberHandlers(options.ipc, {
          service,
          assertMainRendererSender: options.assertMainRendererSender
        })
      } catch (error) {
        stopped = true
        service.dispose()
        throw error
      }
      started = true
      const initial = service.snapshot()
      if (initial.phase === 'disconnected' && initial.channel?.status === 'active') {
        void service.reconnect().catch(() => {
          if (!stopped) options.logger?.('[channels] member startup reconnect failed')
        })
      }
      return initial
    },
    stop: () => {
      if (stopPromise) return stopPromise
      stopped = true
      registration?.dispose()
      registration = null
      service.dispose()
      stopPromise = Promise.resolve()
      return stopPromise
    }
  }
}
