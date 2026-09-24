import { randomUUID } from 'crypto'
import { ipcMain, type IpcMainEvent } from 'electron'
import type { EnsembleRosterPresetImportAcknowledgement } from '../../shared/EnsembleRosterPresetContract'
import { optionalString } from '../settings/MainSanitizers'
import type { EnsembleParticipant, PooledAgentIdentitySnapshot } from '../store/types'

export const ENSEMBLE_ROSTER_PRESETS_IMPORT_RESULT_CHANNEL = 'ensemble-roster-presets:import-result'
export const ENSEMBLE_AGENT_POOL_REGISTRATION_RESULT_CHANNEL =
  'ensemble-agent-pool:registration-result'
export const ENSEMBLE_ROSTER_PRESETS_IMPORT_REQUESTED_CHANNEL =
  'ensemble-roster-presets:import-requested'
export const ENSEMBLE_AGENT_POOL_REGISTRATION_REQUESTED_CHANNEL =
  'ensemble-agent-pool:registration-requested'

/** Structural slice of BrowserWindow used by the roster/pool request round-trips. */
export interface EnsembleRosterAckWindow {
  isDestroyed: () => boolean
  webContents: Electron.WebContents
}

export interface EnsembleRosterPresetAckHandlerDeps {
  /**
   * Late-bound getter: mainWindow is a nullable `let` in index.ts bootstrap
   * scope, so it must be read at invocation time, never captured at registration.
   */
  getMainWindow: () => EnsembleRosterAckWindow | null
  /** index.ts safeSendToSender: false when the sender is gone or send throws. */
  sendToSender: (
    sender: Electron.WebContents | null | undefined,
    channel: string,
    payload: unknown
  ) => boolean
}

export interface ConfirmedRendererRosterPresetImport {
  importedCount: number
  presetId: string
  presetName: string
}

interface PendingRendererRosterPresetImport {
  webContentsId: number
  timer: NodeJS.Timeout
  resolve: (result: ConfirmedRendererRosterPresetImport) => void
  reject: (error: Error) => void
}

const RENDERER_ROSTER_PRESET_IMPORT_TIMEOUT_MS = 10_000
const pendingRendererRosterPresetImports = new Map<string, PendingRendererRosterPresetImport>()

export interface ConfirmedRendererAgentPoolRegistration {
  pooledAgentId: string
  pooledAgentIdentity: PooledAgentIdentitySnapshot
  mode: 'created' | 'coalesced' | 'updated'
}

interface PendingRendererAgentPoolRegistration {
  webContentsId: number
  timer: NodeJS.Timeout
  resolve: (result: ConfirmedRendererAgentPoolRegistration) => void
  reject: (error: Error) => void
}

const RENDERER_AGENT_POOL_REGISTRATION_TIMEOUT_MS = 10_000
const pendingRendererAgentPoolRegistrations = new Map<
  string,
  PendingRendererAgentPoolRegistration
>()

function rendererAgentPoolRegistrationReceipt(
  rawPayload: unknown
): ConfirmedRendererAgentPoolRegistration | null {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return null
  const payload = rawPayload as Record<string, unknown>
  const pooledAgentId = optionalString(payload.pooledAgentId)
  const identity = payload.pooledAgentIdentity
  const mode = payload.mode
  if (
    !pooledAgentId ||
    !pooledAgentId.startsWith('pooled-agent-') ||
    !identity ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    (mode !== 'created' && mode !== 'coalesced' && mode !== 'updated')
  ) {
    return null
  }
  const snapshot = identity as PooledAgentIdentitySnapshot
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.agentId !== pooledAgentId ||
    typeof snapshot.nickname !== 'string' ||
    !snapshot.nickname.trim() ||
    (snapshot.iconKind !== 'named' &&
      snapshot.iconKind !== 'seed' &&
      snapshot.iconKind !== 'asset') ||
    typeof snapshot.hue !== 'number' ||
    !Number.isFinite(snapshot.hue)
  ) {
    return null
  }
  return { pooledAgentId, pooledAgentIdentity: snapshot, mode }
}

function acknowledgeRendererAgentPoolRegistration(
  sender: Electron.WebContents,
  rawPayload: unknown
): void {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return
  const payload = rawPayload as Record<string, unknown>
  const requestId = optionalString(payload.requestId)
  if (!requestId) return
  const pending = pendingRendererAgentPoolRegistrations.get(requestId)
  if (!pending || sender.id !== pending.webContentsId) return
  pendingRendererAgentPoolRegistrations.delete(requestId)
  clearTimeout(pending.timer)
  if (payload.ok !== true) {
    pending.reject(
      new Error(
        optionalString(payload.error) || 'The renderer could not register the Agent Pool entry.'
      )
    )
    return
  }
  const receipt = rendererAgentPoolRegistrationReceipt(payload)
  if (!receipt) {
    pending.reject(new Error('The renderer returned an invalid Agent Pool registration receipt.'))
    return
  }
  pending.resolve(receipt)
}

export function requestRendererAgentPoolRegistration(
  participant: EnsembleParticipant,
  deps: EnsembleRosterPresetAckHandlerDeps
): Promise<ConfirmedRendererAgentPoolRegistration> {
  const target = deps.getMainWindow()
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) {
    return Promise.reject(
      new Error('No active TaskWraith window can register the Agent Pool entry.')
    )
  }
  const requestId = randomUUID()
  const webContentsId = target.webContents.id
  return new Promise((resolveRegistration, rejectRegistration) => {
    const timer = setTimeout(() => {
      if (!pendingRendererAgentPoolRegistrations.delete(requestId)) return
      rejectRegistration(new Error('Timed out waiting for Agent Pool registration.'))
    }, RENDERER_AGENT_POOL_REGISTRATION_TIMEOUT_MS)
    pendingRendererAgentPoolRegistrations.set(requestId, {
      webContentsId,
      timer,
      resolve: resolveRegistration,
      reject: rejectRegistration
    })
    const sent = deps.sendToSender(
      target.webContents,
      ENSEMBLE_AGENT_POOL_REGISTRATION_REQUESTED_CHANNEL,
      {
        requestId,
        participant
      }
    )
    if (sent) return
    pendingRendererAgentPoolRegistrations.delete(requestId)
    clearTimeout(timer)
    rejectRegistration(
      new Error('The TaskWraith window closed before Agent Pool registration completed.')
    )
  })
}

function acknowledgeRendererRosterPresetImport(
  sender: Electron.WebContents,
  rawPayload: unknown
): void {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return
  const payload = rawPayload as EnsembleRosterPresetImportAcknowledgement
  const requestId = optionalString(payload.requestId)
  if (!requestId) return
  const pending = pendingRendererRosterPresetImports.get(requestId)
  if (!pending || sender.id !== pending.webContentsId) return
  pendingRendererRosterPresetImports.delete(requestId)
  clearTimeout(pending.timer)
  if (payload.ok !== true) {
    pending.reject(
      new Error(optionalString(payload.error) || 'The renderer could not save the roster preset.')
    )
    return
  }
  const presetId = optionalString(payload.presetId)
  const presetName = optionalString(payload.presetName)
  if (!presetId || !presetName || payload.importedCount !== 1) {
    pending.reject(new Error('The renderer returned an invalid roster preset save receipt.'))
    return
  }
  pending.resolve({
    importedCount: payload.importedCount,
    presetId,
    presetName
  })
}

export function requestRendererRosterPresetImport(
  json: string,
  deps: EnsembleRosterPresetAckHandlerDeps
): Promise<ConfirmedRendererRosterPresetImport> {
  const target = deps.getMainWindow()
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) {
    return Promise.reject(new Error('No active TaskWraith window can save the roster preset.'))
  }
  const requestId = randomUUID()
  const webContentsId = target.webContents.id
  return new Promise((resolveImport, rejectImport) => {
    const timer = setTimeout(() => {
      if (!pendingRendererRosterPresetImports.delete(requestId)) return
      rejectImport(new Error('Timed out waiting for the roster preset to be saved.'))
    }, RENDERER_ROSTER_PRESET_IMPORT_TIMEOUT_MS)
    pendingRendererRosterPresetImports.set(requestId, {
      webContentsId,
      timer,
      resolve: resolveImport,
      reject: rejectImport
    })
    const sent = deps.sendToSender(
      target.webContents,
      ENSEMBLE_ROSTER_PRESETS_IMPORT_REQUESTED_CHANNEL,
      {
        requestId,
        json,
        source: 'agent'
      }
    )
    if (sent) return
    pendingRendererRosterPresetImports.delete(requestId)
    clearTimeout(timer)
    rejectImport(new Error('The TaskWraith window closed before the roster preset could be saved.'))
  })
}
const onRosterPresetImportResult = (event: IpcMainEvent, payload: unknown): void => {
  acknowledgeRendererRosterPresetImport(event.sender, payload)
}

const onAgentPoolRegistrationResult = (event: IpcMainEvent, payload: unknown): void => {
  acknowledgeRendererAgentPoolRegistration(event.sender, payload)
}

export function registerEnsembleRosterPresetAckHandlers(): void {
  ipcMain.on(ENSEMBLE_ROSTER_PRESETS_IMPORT_RESULT_CHANNEL, onRosterPresetImportResult)
  ipcMain.on(ENSEMBLE_AGENT_POOL_REGISTRATION_RESULT_CHANNEL, onAgentPoolRegistrationResult)
}

export function unregisterEnsembleRosterPresetAckHandlers(): void {
  ipcMain.removeListener(ENSEMBLE_ROSTER_PRESETS_IMPORT_RESULT_CHANNEL, onRosterPresetImportResult)
  ipcMain.removeListener(
    ENSEMBLE_AGENT_POOL_REGISTRATION_RESULT_CHANNEL,
    onAgentPoolRegistrationResult
  )
}
