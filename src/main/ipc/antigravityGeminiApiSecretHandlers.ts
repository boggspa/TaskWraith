import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_STATUSES,
  MAX_ANTIGRAVITY_GEMINI_API_OUTCOME_MODEL_COUNT,
  type AntigravityGeminiApiDiscoveryOutcome,
  type AntigravityGeminiApiDiscoveryOutcomeStatus
} from '../antigravity/AntigravityGeminiApiDiscoveryOutcome'
import type {
  AntigravityGeminiApiSecretMutationResult,
  AntigravityGeminiApiSecretStatus,
  AntigravityGeminiApiSecretStore
} from '../antigravity/AntigravityGeminiApiSecretStore'

export const ANTIGRAVITY_GEMINI_API_SECRET_STATUS_CHANNEL =
  'antigravity-gemini-api:get-secret-status'
export const ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL = 'antigravity-gemini-api:set-secret'
export const ANTIGRAVITY_GEMINI_API_SECRET_CLEAR_CHANNEL = 'antigravity-gemini-api:clear-secret'
export const ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_CHANNEL =
  'antigravity-gemini-api:get-discovery-outcome'

export interface AntigravityGeminiApiSecretHandlerDeps {
  secretStore: Pick<AntigravityGeminiApiSecretStore, 'getStatus' | 'setApiKey' | 'clear'>
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  onSecretMutationSuccess?: () => void
  /**
   * Optional so an installation without a discovery recorder simply reports
   * "not checked yet" rather than failing the channel.
   */
  getDiscoveryOutcome?: () => AntigravityGeminiApiDiscoveryOutcome | null
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

/** Accepts only a canonical, round-trippable UTC instant. */
function canonicalIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) return null
  return value
}

function projectStatus(value: unknown): AntigravityGeminiApiSecretStatus {
  if (!isRecord(value)) return { configured: false, encryptionAvailable: false }
  const status: AntigravityGeminiApiSecretStatus = {
    configured: value.configured === true,
    encryptionAvailable: value.encryptionAvailable === true
  }
  const updatedAt = canonicalIsoTimestamp(value.updatedAt)
  if (updatedAt) status.updatedAt = updatedAt
  return status
}

/**
 * A separate strict projection rather than a widening of the secret status.
 * The two shapes answer different questions ("is a key stored" vs "what did
 * Google say last time we asked") and must not be able to leak into each other.
 * Only a closed status enum, a bounded integer, and a canonical timestamp
 * survive; anything unrecognised collapses to null so the card falls back to
 * saying nothing rather than to guessing.
 */
function projectDiscoveryOutcome(value: unknown): AntigravityGeminiApiDiscoveryOutcome | null {
  if (!isRecord(value)) return null
  if (
    typeof value.status !== 'string' ||
    !ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_STATUSES.has(value.status)
  ) {
    return null
  }
  const checkedAt = canonicalIsoTimestamp(value.checkedAt)
  if (!checkedAt) return null
  const status = value.status as AntigravityGeminiApiDiscoveryOutcomeStatus
  return {
    status,
    modelCount: status === 'ok' ? boundedModelCount(value.modelCount) : 0,
    checkedAt
  }
}

function boundedModelCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return 0
  return Math.min(value, MAX_ANTIGRAVITY_GEMINI_API_OUTCOME_MODEL_COUNT)
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
    ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_CHANNEL,
    (event): AntigravityGeminiApiDiscoveryOutcome | null => {
      assertMainRenderer(deps, event)
      try {
        return projectDiscoveryOutcome(deps.getDiscoveryOutcome?.())
      } catch {
        return null
      }
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
