import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  MistralApiKeyMutationResult,
  MistralApiKeyStatus,
  MistralApiKeyStore
} from '../mistral/MistralApiKeyStore'

export const MISTRAL_API_KEY_STATUS_CHANNEL = 'mistral-api-key:get-status'
export const MISTRAL_API_KEY_SET_CHANNEL = 'mistral-api-key:set'
export const MISTRAL_API_KEY_CLEAR_CHANNEL = 'mistral-api-key:clear'

export interface MistralApiKeyHandlerDeps {
  keyStore: Pick<MistralApiKeyStore, 'getStatus' | 'setApiKey' | 'clear'>
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  onKeyMutationSuccess?: () => void
}

const RECOGNIZED_MUTATION_ERRORS = new Set([
  'invalidApiKey',
  'encryptionUnavailable',
  'encryptFailed',
  'existingRecordUnreadable',
  'writeFailed',
  'clearFailed'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function canonicalIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return null
  return value
}

function projectStatus(value: unknown): MistralApiKeyStatus {
  if (!isRecord(value)) return { configured: false, encryptionAvailable: false }
  const status: MistralApiKeyStatus = {
    configured: value.configured === true,
    encryptionAvailable: value.encryptionAvailable === true
  }
  const updatedAt = canonicalIsoTimestamp(value.updatedAt)
  if (updatedAt) status.updatedAt = updatedAt
  return status
}

function projectMutation(value: unknown): MistralApiKeyMutationResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      status: { configured: false, encryptionAvailable: false },
      error: 'writeFailed'
    }
  }
  const ok = value.ok === true
  const status = projectStatus(value.status)
  if (ok) return { ok: true, status }
  const error =
    typeof value.error === 'string' && RECOGNIZED_MUTATION_ERRORS.has(value.error)
      ? (value.error as MistralApiKeyMutationResult['error'])
      : 'writeFailed'
  return { ok: false, status, error }
}

export function registerMistralApiKeyHandlers(deps: MistralApiKeyHandlerDeps): void {
  ipcMain.handle(MISTRAL_API_KEY_STATUS_CHANNEL, (event): MistralApiKeyStatus => {
    if (!deps.isMainRendererSender(event)) {
      return { configured: false, encryptionAvailable: false }
    }
    return projectStatus(deps.keyStore.getStatus())
  })

  ipcMain.handle(
    MISTRAL_API_KEY_SET_CHANNEL,
    (_event, apiKey: unknown): MistralApiKeyMutationResult => {
      if (!deps.isMainRendererSender(_event)) {
        return {
          ok: false,
          status: { configured: false, encryptionAvailable: false },
          error: 'writeFailed'
        }
      }
      if (typeof apiKey !== 'string' || !apiKey.trim()) {
        return {
          ok: false,
          status: projectStatus(deps.keyStore.getStatus()),
          error: 'invalidApiKey'
        }
      }
      const result = projectMutation(deps.keyStore.setApiKey(apiKey))
      if (result.ok) {
        try {
          deps.onKeyMutationSuccess?.()
        } catch {
          // ignore
        }
      }
      return result
    }
  )

  ipcMain.handle(MISTRAL_API_KEY_CLEAR_CHANNEL, (event): MistralApiKeyMutationResult => {
    if (!deps.isMainRendererSender(event)) {
      return {
        ok: false,
        status: { configured: false, encryptionAvailable: false },
        error: 'clearFailed'
      }
    }
    const result = projectMutation(deps.keyStore.clear())
    if (result.ok) {
      try {
        deps.onKeyMutationSuccess?.()
      } catch {
        // ignore
      }
    }
    return result
  })

  ipcMain.handle('import-mistral-web-session', async (event) => {
    if (!deps.isMainRendererSender(event)) return null
    return await importMistralWebSession()
  })
}

import { importMistralWebSession } from '../providers/WebSessionBrowser'

export function unregisterMistralApiKeyHandlers(): void {
  ipcMain.removeHandler(MISTRAL_API_KEY_STATUS_CHANNEL)
  ipcMain.removeHandler(MISTRAL_API_KEY_SET_CHANNEL)
  ipcMain.removeHandler(MISTRAL_API_KEY_CLEAR_CHANNEL)
  ipcMain.removeHandler('import-mistral-web-session')
}
