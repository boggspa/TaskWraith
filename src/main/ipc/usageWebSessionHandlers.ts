import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type {
  UsageWebSessionProviderId,
  UsageWebSessionReading
} from '../../shared/usageWebSession'
import type { CapturedWebSession } from '../providers/WebSessionBrowser'
import { importUsageWebSession } from '../providers/WebSessionBrowser'
import type { UsageWebSessionStore } from '../providers/UsageWebSessionStore'
import { usageWebSessionStore } from '../providers/UsageWebSessionStore'
import { createUsageWebSessionHandlers } from './providerSecretHandlerFactory'

type SessionStore = Pick<UsageWebSessionStore, 'getStatus' | 'setSession' | 'clear'>

export interface UsageWebSessionHandlersDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  store?: (provider: UsageWebSessionProviderId) => SessionStore | null
  importSession?: (
    provider: UsageWebSessionProviderId
  ) => Promise<CapturedWebSession<UsageWebSessionReading> | null>
  onSessionChanged?: (provider: UsageWebSessionProviderId) => void
}

export function registerUsageWebSessionHandlers(
  dependencies: UsageWebSessionHandlersDependencies
): void {
  const handlers = createUsageWebSessionHandlers({
    isMainRendererSender: dependencies.isMainRendererSender,
    store: dependencies.store ?? usageWebSessionStore,
    importSession: dependencies.importSession ?? importUsageWebSession,
    onSessionChanged: dependencies.onSessionChanged
  })

  dependencies.ipcMain.handle('usage-web-session:get-status', handlers.getStatus)
  dependencies.ipcMain.handle('usage-web-session:import', handlers.importSession)
  dependencies.ipcMain.handle('usage-web-session:clear', handlers.clear)
}
