/**
 * Re-export shim for Electron-main importers that still resolve the historical
 * `src/main/kimi/KimiModelCatalog` path. The Host-safe implementation lives in
 * `src/host-shared/kimi/KimiManagedModelCatalog.ts`.
 */
export {
  discoverKimiManagedModelRows,
  parseKimiManagedModelAliases,
  projectKimiManagedModelRows
} from '../../host-shared/kimi/KimiManagedModelCatalog'
export type { KimiManagedModelRow } from '../../host-shared/kimi/KimiManagedModelCatalog'
