/**
 * Re-export shim for Electron-main importers that still resolve the historical
 * `src/main/kimi/KimiModelContext` path. The Host-safe implementation lives in
 * `src/host-shared/kimi/KimiModelContext.ts`.
 */
export { effectiveKimiModelContextWindow } from '../../host-shared/kimi/KimiModelContext'
