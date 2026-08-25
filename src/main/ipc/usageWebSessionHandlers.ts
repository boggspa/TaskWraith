import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  isUsageWebSessionProviderId,
  type UsageWebSessionImportOutcome,
  type UsageWebSessionProviderId,
  type UsageWebSessionStatus
} from '../../shared/usageWebSession'
import type { CapturedWebSession } from '../providers/WebSessionBrowser'
import { importUsageWebSession } from '../providers/WebSessionBrowser'
import type { UsageWebSessionReading } from '../../shared/usageWebSession'
import type { UsageWebSessionStore } from '../providers/UsageWebSessionStore'
import { usageWebSessionStore } from '../providers/UsageWebSessionStore'

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

function unavailableStatus(): UsageWebSessionStatus {
  return { configured: false, encryptionAvailable: false }
}

function resolveProvider(value: unknown): UsageWebSessionProviderId | null {
  return isUsageWebSessionProviderId(value) ? value : null
}

function safelyNotify(
  callback: UsageWebSessionHandlersDependencies['onSessionChanged'],
  provider: UsageWebSessionProviderId
): void {
  try {
    callback?.(provider)
  } catch {
    // A refresh notification must never turn a completed credential write into an IPC failure.
  }
}

export function registerUsageWebSessionHandlers(
  dependencies: UsageWebSessionHandlersDependencies
): void {
  const getStore = dependencies.store ?? usageWebSessionStore

  dependencies.ipcMain.handle(
    'usage-web-session:get-status',
    async (event, rawProvider: unknown): Promise<UsageWebSessionStatus> => {
      const provider = resolveProvider(rawProvider)
      if (!provider || !dependencies.isMainRendererSender(event)) return unavailableStatus()
      try {
        return getStore(provider)?.getStatus() ?? unavailableStatus()
      } catch {
        return unavailableStatus()
      }
    }
  )

  dependencies.ipcMain.handle(
    'usage-web-session:import',
    async (event, rawProvider: unknown): Promise<UsageWebSessionImportOutcome> => {
      const provider = resolveProvider(rawProvider)
      if (!provider || !dependencies.isMainRendererSender(event)) {
        return { ok: false, reason: 'unavailable' }
      }
      const store = getStore(provider)
      if (!store) return { ok: false, reason: 'unavailable' }
      let captured: CapturedWebSession<UsageWebSessionReading> | null
      try {
        captured = await (dependencies.importSession ?? importUsageWebSession)(provider)
      } catch {
        return { ok: false, reason: 'unavailable', status: store.getStatus() }
      }
      if (!captured) return { ok: false, reason: 'cancelled', status: store.getStatus() }
      const result = store.setSession({
        cookieHeader: captured.cookieHeader,
        reading: captured.summary
      })
      if (!result.ok) return { ok: false, reason: 'storeFailed', status: result.status }
      safelyNotify(dependencies.onSessionChanged, provider)
      return { ok: true, status: result.status }
    }
  )

  dependencies.ipcMain.handle('usage-web-session:clear', async (event, rawProvider: unknown) => {
    const provider = resolveProvider(rawProvider)
    if (!provider || !dependencies.isMainRendererSender(event)) {
      return { ok: false, status: unavailableStatus(), error: 'clearFailed' as const }
    }
    const store = getStore(provider)
    if (!store) {
      return { ok: false, status: unavailableStatus(), error: 'clearFailed' as const }
    }
    const result = store.clear()
    if (result.ok) safelyNotify(dependencies.onSessionChanged, provider)
    return result
  })
}
