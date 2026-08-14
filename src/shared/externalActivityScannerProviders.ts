/**
 * CLI homes the background External Activity scanner can inspect.
 *
 * A provider outside this set can never produce a raw external record, so its
 * TaskWraith-owned usage has to be carried into any external-flavoured surface
 * or that surface presents a false zero for it. Providers inside the set stay
 * external-only, because their local CLI history already contains the
 * TaskWraith run and adding it again double-counts.
 *
 * WHY THIS LIVES IN `shared/`. The same fact was already written out by hand in
 * two renderer modules (`externalActivityPresentation.ts`,
 * `modelUsageTable.ts`), and drift between them is a known defect class: when
 * the Settings model-usage tables fell out of step, Pi/Mistral/AntiGravity rows
 * silently vanished for anyone with External Usage on. Main needed the same set
 * for the daily rollup fold, so it is defined once here rather than mirrored a
 * third time. `externalActivityScannerProviders.test.ts` pins the renderer
 * copies against this one so a new scanner lane cannot update only some of them.
 *
 * Adding a scanner lane to `ExternalProviderActivity.ts` means adding the
 * provider here.
 */

import type { ProviderId } from '../main/store/types'

export const EXTERNAL_ACTIVITY_SCANNER_PROVIDER_IDS = [
  'codex',
  'claude',
  'gemini',
  'kimi',
  'grok',
  'cursor'
] as const satisfies readonly ProviderId[]

export const EXTERNAL_ACTIVITY_SCANNER_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(
  EXTERNAL_ACTIVITY_SCANNER_PROVIDER_IDS
)

/** True when a provider's usage is only ever visible through TaskWraith's own
 * records, because no scanner lane can see it. */
export function isTaskWraithOnlyProvider(provider: string | undefined): boolean {
  return !provider || !EXTERNAL_ACTIVITY_SCANNER_PROVIDERS.has(provider as ProviderId)
}
