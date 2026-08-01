/**
 * Re-export barrel — the canonical module lives at src/shared/providerChangeQueue.ts
 * so both main and renderer can import the pure, node-free contract without a
 * cross-process runtime edge.
 */
export {
  PENDING_PROVIDER_CHANGE_KEY,
  applyPendingProviderChangeOnFinalize,
  applyProviderChange,
  clearPendingProviderChange,
  hasPendingProviderChange,
  queueProviderChange,
  readPendingProviderChange
} from '../shared/providerChangeQueue'

export type { PendingProviderChange } from '../shared/providerChangeQueue'
