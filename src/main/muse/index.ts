/**
 * Muse seat modules (opaque `muse exec --json`).
 *
 * Registry wiring lives in composition-root `src/main/index.ts`.
 * Node-host runtime imports stay within the pure Muse closure, while IPC
 * bridge composition remains a direct desktop-only import.
 */

export * from './MuseTypes'
export * from './MuseOrchestrationContracts'
export * from './MuseProbe'
export * from './MuseProviderAdapter'
export * from './MuseRun'
// MuseIpcBridge is imported directly by the desktop composition root and is
// intentionally not re-exported through this Node-host-visible module.
