import type { ProviderId, UsageRecord } from '../../../main/store/types'

/**
 * CLI homes the background External Activity scanner can inspect. A provider
 * outside this set can never contribute a raw external record, so its
 * TaskWraith-owned usage must be carried into the external presentation to
 * avoid presenting a false zero.
 *
 * Keep this aligned with `ExternalProviderActivity` when a scanner lane is
 * added. Scanned providers stay external-only here because their local CLI
 * history can already contain the TaskWraith run, and adding it again would
 * double count it.
 */
const EXTERNAL_ACTIVITY_SCANNER_PROVIDERS = new Set<ProviderId>([
  'codex',
  'claude',
  'gemini',
  'kimi',
  'grok',
  'cursor'
])

/**
 * Combine raw external activity with TaskWraith usage for providers that have
 * no external scanner lane. This is deliberately a renderer-side projection:
 * it neither changes the external cache nor triggers another external scan,
 * preserving the worker-backed, progressive hydration path.
 */
export function buildExternalActivityPresentationRecords(
  externalRecords: UsageRecord[],
  taskwraithRecords: UsageRecord[]
): UsageRecord[] {
  const taskwraithOnlyRecords = taskwraithRecords.filter(
    (record) => record.provider && !EXTERNAL_ACTIVITY_SCANNER_PROVIDERS.has(record.provider)
  )
  return taskwraithOnlyRecords.length > 0
    ? [...externalRecords, ...taskwraithOnlyRecords]
    : externalRecords
}
