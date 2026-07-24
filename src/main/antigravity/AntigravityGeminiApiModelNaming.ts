/**
 * Re-export shim. The derivation moved to `src/shared` so the renderer's
 * chip/dashboard formatters (`composerChipFormat.ts`, `modelDisplayName.ts`)
 * reproduce the exact catalog labels from a bare persisted model id — shared is
 * the established cross-boundary home (see `shared/retiredProviders.ts`), and
 * two copies of the derivation would drift.
 */
export {
  antigravityGeminiApiModelLabel,
  antigravityGeminiApiModelDisplayLabel,
  curateAntigravityGeminiApiModels,
  isCuratedAntigravityGeminiApiModelId
} from '../../shared/antigravityGeminiApiModelNaming'
