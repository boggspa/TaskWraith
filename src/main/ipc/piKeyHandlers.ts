import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { PI_ALLOWED_UPSTREAMS, isPiUpstreamAllowed } from '../pi/PiModelPolicy'
import type { PiKeyMutationResult, PiKeyStore, PiKeyStoreStatus } from '../pi/PiKeyStore'

export const PI_KEY_STATUS_CHANNEL = 'pi:get-key-status'
export const PI_KEY_SET_CHANNEL = 'pi:set-upstream-key'
export const PI_KEY_CLEAR_CHANNEL = 'pi:clear-upstream-key'
export const PI_KEY_CLEAR_ALL_CHANNEL = 'pi:clear-all-keys'

export interface PiKeyHandlerDeps {
  keyStore: Pick<PiKeyStore, 'getStatus' | 'setKey' | 'clearKey' | 'clearAll'>
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  /** Fired after any successful mutation so discovery/pickers can refresh. */
  onKeyMutationSuccess?: () => void
}

const RECOGNIZED_MUTATION_ERRORS = new Set([
  'invalidUpstream',
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
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) return null
  return value
}

/** Renderer-safe projection: upstream ids and booleans only, never keys. */
function projectStatus(value: unknown): PiKeyStoreStatus {
  if (!isRecord(value)) {
    return { encryptionAvailable: false, configuredUpstreams: [], recordUnreadable: false }
  }
  const configured = Array.isArray(value.configuredUpstreams)
    ? value.configuredUpstreams.filter(
        (upstream): upstream is (typeof PI_ALLOWED_UPSTREAMS)[number] =>
          typeof upstream === 'string' && isPiUpstreamAllowed(upstream)
      )
    : []
  const status: PiKeyStoreStatus = {
    encryptionAvailable: value.encryptionAvailable === true,
    configuredUpstreams: configured,
    recordUnreadable: value.recordUnreadable === true
  }
  const updatedAt = canonicalIsoTimestamp(value.updatedAt)
  if (updatedAt) status.updatedAt = updatedAt
  return status
}

function projectMutation(value: unknown): PiKeyMutationResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: 'writeFailed',
      status: { encryptionAvailable: false, configuredUpstreams: [], recordUnreadable: false }
    }
  }
  const projected: PiKeyMutationResult = {
    ok: value.ok === true,
    status: projectStatus(value.status)
  }
  if (typeof value.error === 'string' && RECOGNIZED_MUTATION_ERRORS.has(value.error)) {
    projected.error = value.error as PiKeyMutationResult['error']
  }
  return projected
}

function assertMainRenderer(deps: PiKeyHandlerDeps, event: IpcMainInvokeEvent): void {
  if (!deps.isMainRendererSender(event)) {
    throw new Error('Only the main renderer can manage Pi upstream keys.')
  }
}

export function registerPiKeyHandlers(deps: PiKeyHandlerDeps): void {
  ipcMain.handle(PI_KEY_STATUS_CHANNEL, (event): PiKeyStoreStatus => {
    assertMainRenderer(deps, event)
    return projectStatus(deps.keyStore.getStatus())
  })

  ipcMain.handle(
    PI_KEY_SET_CHANNEL,
    (event, upstream: string, apiKey: string): PiKeyMutationResult => {
      assertMainRenderer(deps, event)
      const result = projectMutation(deps.keyStore.setKey(upstream, apiKey))
      if (result.ok) deps.onKeyMutationSuccess?.()
      return result
    }
  )

  ipcMain.handle(PI_KEY_CLEAR_CHANNEL, (event, upstream: string): PiKeyMutationResult => {
    assertMainRenderer(deps, event)
    const result = projectMutation(deps.keyStore.clearKey(upstream))
    if (result.ok) deps.onKeyMutationSuccess?.()
    return result
  })

  ipcMain.handle(PI_KEY_CLEAR_ALL_CHANNEL, (event): PiKeyMutationResult => {
    assertMainRenderer(deps, event)
    const result = projectMutation(deps.keyStore.clearAll())
    if (result.ok) deps.onKeyMutationSuccess?.()
    return result
  })
}
