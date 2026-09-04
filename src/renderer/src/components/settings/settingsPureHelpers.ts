/**
 * Pure label/format/validation helpers for the Settings panel — extracted
 * from `../SettingsPanel.tsx` (behavior-preserving move). Type-only imports
 * from `main/` are erased at emit; no renderer→main runtime edge is added.
 */
import type {
  AuditRetentionSurface,
  ProductAuditBundleVerificationResult,
  ProviderId,
  ProviderRunPauseState
} from '../../../../main/store/types'
import type { ModelUsageAggregate } from '../../lib/usageAggregateTypes'
import type { ProviderAuthSummary } from '../../lib/providerAuthSummary'
import { formatResetShort } from '../../lib/UsageFormat'

export type FxRateSnapshot = Awaited<ReturnType<typeof window.api.getFxRates>>

export function auditBundleCheckLabel(value: boolean | undefined): string {
  return value ? 'pass' : 'fail'
}

export function auditBundleSignatureLabel(
  verification: ProductAuditBundleVerificationResult['verification']
): string {
  if (!verification) return 'not checked'
  if (!verification.signaturePresent) return 'not present'
  return verification.signatureValid ? 'valid' : 'invalid'
}

export function auditBundleTamperEvidenceLabel(value: string | undefined): string {
  if (value === 'local_hashes_signed') return 'signed local hashes'
  if (value === 'local_hashes_unsigned') return 'unsigned local hashes'
  return 'unknown evidence'
}

export function shortAuditHash(value: string | undefined): string {
  return value ? value.slice(0, 12) : 'unavailable'
}

export const AUDIT_RETENTION_SURFACES: Array<{ key: AuditRetentionSurface; label: string }> = [
  { key: 'approvalLedger', label: 'Approvals' },
  { key: 'runEvents', label: 'Run events' },
  { key: 'workspaceChanges', label: 'Workspace changes' },
  { key: 'auditRuns', label: 'Audit runs' },
  { key: 'messageFeedback', label: 'Feedback receipts' },
  { key: 'externalPublish', label: 'Publish receipts' },
  { key: 'productCrashes', label: 'Crash diagnostics' }
]

export function isProviderPauseStillActive(state?: ProviderRunPauseState): boolean {
  if (!state?.paused) return false
  if (!state.until) return true
  const until = Date.parse(state.until)
  return Number.isFinite(until) && until > Date.now()
}

export function toPauseDateTimeLocal(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function fromPauseDateTimeLocal(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

export function fxConfidenceLabel(source?: FxRateSnapshot['source']): string {
  if (source === 'live') return 'Live'
  if (source === 'cached') return 'Cached'
  if (source === 'fallback') return 'Fallback'
  return 'Unknown'
}

export function formatFxUpdatedAt(snapshot: FxRateSnapshot | null): string {
  if (!snapshot) return 'Not loaded yet'
  const time = Date.parse(snapshot.fetchedAt)
  if (!Number.isFinite(time)) return 'Unknown'
  return new Date(time).toLocaleString()
}

export function formatFxRate(snapshot: FxRateSnapshot | null, currency: 'GBP' | 'EUR'): string {
  const rate = snapshot?.rates?.[currency]
  return typeof rate === 'number' && Number.isFinite(rate) ? rate.toFixed(4) : 'n/a'
}

/** A provider's worst quota window is at ~100% (0.999 absorbs float
 * noise from `usedPercent / 100`) so its card must read "out of usage"
 * instead of a bare "signed in". Mirrors FirstLaunchSheet. */
export const OUT_OF_USAGE_FRACTION = 0.999

/**
 * Worst (most-consumed) quota window for a provider, derived from the
 * same `usageSummary` the Model Usage tab reads. Prefers the honest
 * `usedPercent`, falls back to `1 - remainingPercent`. Returns null when
 * the provider has no quota data (Cursor/Grok never do; the others only
 * after a usage probe). Replicates FirstLaunchSheet's `worstProviderUsage`
 * locally — the duplication is a few lines and avoids a cross-component
 * import.
 */
export function worstProviderUsage(
  usageSummary: ModelUsageAggregate[] | undefined,
  providerId: ProviderId
): { fraction: number; resetAt?: string } | null {
  if (!usageSummary || usageSummary.length === 0) return null
  const entry = usageSummary.find(
    (e) => e.provider === providerId && e.model === 'usage limits' && (e.windows?.length || 0) > 0
  )
  if (!entry?.windows) return null
  let worst: { fraction: number; resetAt?: string } | null = null
  for (const w of entry.windows) {
    const used = Number.isFinite(w.usedPercent)
      ? Math.max(0, Math.min(1, (w.usedPercent as number) / 100))
      : Number.isFinite(w.remainingPercent)
        ? Math.max(0, Math.min(1, 1 - (w.remainingPercent as number) / 100))
        : 0
    if (!worst || used > worst.fraction) worst = { fraction: used, resetAt: w.resetAt }
  }
  return worst
}

/**
 * Flip a signed-in provider summary to the "out of usage" state when its
 * worst quota window is at ~100%. No-op for every other variant (you
 * can't be "out of usage" if you were never signed in) and when there's
 * no quota data — so hosts/tests that omit `usageSummary` are unchanged.
 */
export function applyOutOfUsage(
  provider: ProviderId,
  summary: ProviderAuthSummary,
  usageSummary: ModelUsageAggregate[] | undefined
): ProviderAuthSummary {
  if (summary.variant !== 'signed-in') return summary
  const worst = worstProviderUsage(usageSummary, provider)
  if (!worst || worst.fraction < OUT_OF_USAGE_FRACTION) return summary
  const reset = formatResetShort({ resetAt: worst.resetAt })
  return {
    variant: 'out-of-usage',
    statusText: reset ? `100% used · resets ${reset}` : '100% used',
    hint: 'Signed in, but rate-limited right now — wait for the reset, switch provider, or switch model. This is a quota wall, not a bug.'
  }
}
