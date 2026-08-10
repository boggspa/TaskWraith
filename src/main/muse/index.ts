/**
 * Muse seat modules (opaque `muse exec --json`).
 *
 * Registry wiring lives in composition-root `src/main/index.ts` via
 * `runMuseProviderFromIpc` + MuseIpcBridge deps.
 */

export * from './MuseTypes'
export * from './MuseOrchestrationContracts'
export * from './MuseProbe'
export * from './MuseProviderAdapter'
export * from './MuseRun'
// MuseIpcBridge is imported directly by composition-root; avoid duplicate
// re-export of runMuseProviderFromIpc (also re-exported from MuseRun).
