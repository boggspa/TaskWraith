import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  AntigravityGeminiApiSecretMutationResult,
  AntigravityGeminiApiSecretStatus,
  AntigravityGeminiApiSecretStore
} from '../antigravity/AntigravityGeminiApiSecretStore'

export const ANTIGRAVITY_GEMINI_API_SECRET_STATUS_CHANNEL =
  'antigravity-gemini-api:get-secret-status'
export const ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL = 'antigravity-gemini-api:set-secret'
export const ANTIGRAVITY_GEMINI_API_SECRET_CLEAR_CHANNEL = 'antigravity-gemini-api:clear-secret'

export interface AntigravityGeminiApiSecretHandlerDeps {
  secretStore: Pick<AntigravityGeminiApiSecretStore, 'getStatus' | 'setApiKey' | 'clear'>
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  onSecretMutationSuccess?: () => void
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

function projectStatus(value: unknown): AntigravityGeminiApiSecretStatus {
  if (!isRecord(value)) return { configured: false, encryptionAvailable: false }
  const parsedUpdatedAt = typeof value.updatedAt === 'string' ? Date.parse(value.updatedAt) : NaN
  const status: AntigravityGeminiApiSecretStatus = {
    configured: value.configured === true,
    encryptionAvailable: value.encryptionAvailable === true
  }
  if (
    typeof value.updatedAt === 'string' &&
    value.updatedAt.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt) &&
    !Number.isNaN(parsedUpdatedAt) &&
    new Date(parsedUpdatedAt).toISOString() === value.updatedAt
  ) {
    status.updatedAt = value.updatedAt
  }
  return status
}

function projectMutation(value: unknown): AntigravityGeminiApiSecretMutationResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: 'writeFailed',
      status: { configured: false, encryptionAvailable: false }
    }
  }
  const projected: AntigravityGeminiApiSecretMutationResult = {
    ok: value.ok === true,
    status: projectStatus(value.status)
  }
  if (typeof value.error === 'string' && RECOGNIZED_MUTATION_ERRORS.has(value.error)) {
    projected.error = value.error as AntigravityGeminiApiSecretMutationResult['error']
  }
  return projected
}

function assertMainRenderer(
  deps: AntigravityGeminiApiSecretHandlerDeps,
  event: IpcMainInvokeEvent
): void {
  if (!deps.isMainRendererSender(event)) {
    throw new Error('Only the main renderer can manage the Gemini API key.')
  }
}

export function registerAntigravityGeminiApiSecretHandlers(
  deps: AntigravityGeminiApiSecretHandlerDeps
): void {
  ipcMain.handle(
    ANTIGRAVITY_GEMINI_API_SECRET_STATUS_CHANNEL,
    (event): AntigravityGeminiApiSecretStatus => {
      assertMainRenderer(deps, event)
      return projectStatus(deps.secretStore.getStatus())
    }
  )

  ipcMain.handle(
    ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL,
    (event, apiKey: string): AntigravityGeminiApiSecretMutationResult => {
      assertMainRenderer(deps, event)
      const result = projectMutation(deps.secretStore.setApiKey(apiKey))
      if (result.ok) deps.onSecretMutationSuccess?.()
      return result
    }
  )

  ipcMain.handle(
    ANTIGRAVITY_GEMINI_API_SECRET_CLEAR_CHANNEL,
    (event): AntigravityGeminiApiSecretMutationResult => {
      assertMainRenderer(deps, event)
      const result = projectMutation(deps.secretStore.clear())
      if (result.ok) deps.onSecretMutationSuccess?.()
      return result
    }
  )
}
