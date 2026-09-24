/**
 * Re-export shim for Electron-main importers that still resolve the historical
 * `src/main/kimi/KimiAcpUsage` path. The Host-safe implementation lives in
 * `src/host-shared/KimiAcpUsage.ts`.
 */
export {
  estimateKimiAcpTokenUsage,
  kimiAcpVisiblePayloadChars,
  kimiCostRateModel,
  KIMI_ACP_TOKEN_ESTIMATE_SOURCE
} from '../../host-shared/KimiAcpUsage'
export type {
  KimiAcpTokenEstimateInput,
  KimiAcpTokenEstimateStats
} from '../../host-shared/KimiAcpUsage'
