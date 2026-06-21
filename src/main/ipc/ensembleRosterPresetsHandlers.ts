// Ensemble roster presets — host-side bridge IPC.
//
// The renderer (localStorage source of truth) pushes its preset list up via
// `ensemble-roster-presets:sync` whenever it changes; we cache a
// projection-shaped copy (EnsembleRosterPresetsCache) so the bridge can
// broadcast it to paired iOS devices (the Roster page). Writes from iOS
// (save/delete) round-trip BACK to the renderer (slice B3) which re-syncs.

import { ipcMain } from 'electron'
import { setRemoteEnsemblePresetsFromRaw } from '../remote/EnsembleRosterPresetsCache'

export interface EnsembleRosterPresetsHandlerDeps {
  /** Called after the cache changes so the bridge can re-project to iOS. */
  onChanged: () => void
}

export function registerEnsembleRosterPresetsHandlers(
  deps: EnsembleRosterPresetsHandlerDeps
): void {
  ipcMain.handle('ensemble-roster-presets:sync', (_event, raw: unknown) => {
    setRemoteEnsemblePresetsFromRaw(raw)
    deps.onChanged()
  })
}
