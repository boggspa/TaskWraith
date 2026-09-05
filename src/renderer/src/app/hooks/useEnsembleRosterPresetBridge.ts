import { useEffect } from 'react'
import {
  deleteEnsembleRosterPreset,
  importEnsembleRosterPresetsFromJson,
  listEnsembleRosterPresets,
  saveEnsembleRosterPresetFromParticipants,
  subscribeEnsembleRosterPresets
} from '../../lib/ensembleRosterPresets'
import {
  pooledAgentIdentitySnapshot,
  registerParticipantInAgentPool
} from '../../lib/ensembleAgentPool'

export function useEnsembleRosterPresetBridge(isChatPopoutWindow: boolean): void {
  // Push roster presets (renderer localStorage = source of truth) up to main on
  // mount + on every change, so the bridge can project them to paired iOS
  // devices (the Roster page). The same subscription fires when an iOS-driven
  // save/delete round-trips back to the renderer (slice B3).
  useEffect(() => {
    if (isChatPopoutWindow) return
    const push = (): void => {
      try {
        void window.api
          .syncEnsembleRosterPresets?.(listEnsembleRosterPresets())
          .catch(() => undefined)
      } catch {
        // Best-effort: an older preload without the bridge just skips iOS sync.
      }
    }
    push()
    const unsubscribe = subscribeEnsembleRosterPresets(push)
    // iOS-triggered preset writes round-trip here (the renderer owns the store).
    // Persisting fires the subscription above, which re-syncs the list to main.
    const offSave = window.api.onEnsembleRosterPresetSaveRequested?.((payload) => {
      try {
        saveEnsembleRosterPresetFromParticipants(
          payload.name,
          (payload.participants ?? []) as Parameters<
            typeof saveEnsembleRosterPresetFromParticipants
          >[1]
        )
      } catch {
        // ignore malformed payloads
      }
    })
    const offImport = window.api.onEnsembleRosterPresetImportRequested?.((payload) => {
      try {
        const result = importEnsembleRosterPresetsFromJson(payload.json)
        const savedPreset = result.presets[0]
        window.api.sendEnsembleRosterPresetImportResult({
          requestId: payload.requestId,
          ok: true,
          importedCount: result.importedCount,
          presetId: savedPreset.id,
          presetName: savedPreset.name
        })
      } catch (error) {
        window.api.sendEnsembleRosterPresetImportResult({
          requestId: payload.requestId,
          ok: false,
          error: error instanceof Error ? error.message : 'Roster preset import failed.'
        })
      }
    })
    const offPoolRegistration = window.api.onEnsembleAgentPoolRegistrationRequested?.((payload) => {
      try {
        const result = registerParticipantInAgentPool(
          payload.participant as Parameters<typeof registerParticipantInAgentPool>[0]
        )
        window.api.sendEnsembleAgentPoolRegistrationResult({
          requestId: payload.requestId,
          ok: true,
          pooledAgentId: result.agent.agentId,
          pooledAgentIdentity: pooledAgentIdentitySnapshot(result.agent),
          mode: result.mode
        })
      } catch (error) {
        window.api.sendEnsembleAgentPoolRegistrationResult({
          requestId: payload.requestId,
          ok: false,
          error: error instanceof Error ? error.message : 'Agent Pool registration failed.'
        })
      }
    })
    const offDelete = window.api.onEnsembleRosterPresetDeleteRequested?.((presetId) => {
      try {
        deleteEnsembleRosterPreset(presetId)
      } catch {
        // ignore
      }
    })
    return () => {
      unsubscribe()
      offSave?.()
      offImport?.()
      offPoolRegistration?.()
      offDelete?.()
    }
  }, [isChatPopoutWindow])
}
