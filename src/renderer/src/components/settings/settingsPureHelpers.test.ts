import { describe, expect, it } from 'vitest'
import type { ModelUsageAggregate } from '../../lib/usageAggregateTypes'
import type { ProviderAuthSummary } from '../../lib/providerAuthSummary'
import {
  AUDIT_RETENTION_SURFACES,
  applyOutOfUsage,
  auditBundleCheckLabel,
  auditBundleSignatureLabel,
  auditBundleTamperEvidenceLabel,
  formatFxRate,
  formatFxUpdatedAt,
  fromPauseDateTimeLocal,
  fxConfidenceLabel,
  isProviderPauseStillActive,
  shortAuditHash,
  toPauseDateTimeLocal,
  worstProviderUsage
} from './settingsPureHelpers'

describe('audit bundle labels', () => {
  it('maps check booleans to pass/fail', () => {
    expect(auditBundleCheckLabel(true)).toBe('pass')
    expect(auditBundleCheckLabel(false)).toBe('fail')
    expect(auditBundleCheckLabel(undefined)).toBe('fail')
  })

  it('maps verification state to a signature label', () => {
    expect(auditBundleSignatureLabel(undefined)).toBe('not checked')
    expect(auditBundleSignatureLabel({ signaturePresent: false } as never)).toBe('not present')
    expect(
      auditBundleSignatureLabel({ signaturePresent: true, signatureValid: true } as never)
    ).toBe('valid')
    expect(
      auditBundleSignatureLabel({ signaturePresent: true, signatureValid: false } as never)
    ).toBe('invalid')
  })

  it('maps tamper-evidence kinds to labels', () => {
    expect(auditBundleTamperEvidenceLabel('local_hashes_signed')).toBe('signed local hashes')
    expect(auditBundleTamperEvidenceLabel('local_hashes_unsigned')).toBe('unsigned local hashes')
    expect(auditBundleTamperEvidenceLabel('anything-else')).toBe('unknown evidence')
    expect(auditBundleTamperEvidenceLabel(undefined)).toBe('unknown evidence')
  })

  it('truncates hashes to 12 chars and handles absence', () => {
    expect(shortAuditHash('abcdef0123456789')).toBe('abcdef012345')
    expect(shortAuditHash(undefined)).toBe('unavailable')
  })

  it('keeps the audit retention surface list complete and labelled', () => {
    expect(AUDIT_RETENTION_SURFACES.map((s) => s.key)).toEqual([
      'approvalLedger',
      'runEvents',
      'workspaceChanges',
      'auditRuns',
      'messageFeedback',
      'externalPublish',
      'productCrashes'
    ])
    for (const surface of AUDIT_RETENTION_SURFACES) {
      expect(surface.label.length).toBeGreaterThan(0)
    }
  })
})

describe('provider pause helpers', () => {
  it('treats an unpaused or missing state as inactive', () => {
    expect(isProviderPauseStillActive(undefined)).toBe(false)
    expect(isProviderPauseStillActive({ paused: false })).toBe(false)
  })

  it('treats a pause with no expiry as active, and expiry decides otherwise', () => {
    expect(isProviderPauseStillActive({ paused: true })).toBe(true)
    expect(
      isProviderPauseStillActive({
        paused: true,
        until: new Date(Date.now() + 60_000).toISOString()
      })
    ).toBe(true)
    expect(
      isProviderPauseStillActive({
        paused: true,
        until: new Date(Date.now() - 60_000).toISOString()
      })
    ).toBe(false)
    expect(isProviderPauseStillActive({ paused: true, until: 'not-a-date' })).toBe(false)
  })

  it('round-trips an ISO timestamp through the datetime-local form', () => {
    const iso = '2026-09-04T15:30:00.000Z'
    const local = toPauseDateTimeLocal(iso)
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(fromPauseDateTimeLocal(local)).toBe(iso)
  })

  it('returns empty/undefined for empty or invalid input', () => {
    expect(toPauseDateTimeLocal(undefined)).toBe('')
    expect(toPauseDateTimeLocal('garbage')).toBe('')
    expect(fromPauseDateTimeLocal('')).toBeUndefined()
    expect(fromPauseDateTimeLocal('garbage')).toBeUndefined()
  })
})

describe('fx rate helpers', () => {
  it('maps confidence sources to labels', () => {
    expect(fxConfidenceLabel('live' as never)).toBe('Live')
    expect(fxConfidenceLabel('cached' as never)).toBe('Cached')
    expect(fxConfidenceLabel('fallback' as never)).toBe('Fallback')
    expect(fxConfidenceLabel(undefined)).toBe('Unknown')
  })

  it('formats rates to four decimals or n/a', () => {
    const snapshot = { fetchedAt: '2026-09-04T10:00:00.000Z', rates: { GBP: 0.79, EUR: 0.92 } }
    expect(formatFxRate(snapshot as never, 'GBP')).toBe('0.7900')
    expect(formatFxRate(snapshot as never, 'EUR')).toBe('0.9200')
    expect(formatFxRate(null, 'GBP')).toBe('n/a')
  })

  it('formats update timestamps honestly', () => {
    expect(formatFxUpdatedAt(null)).toBe('Not loaded yet')
    expect(formatFxUpdatedAt({ fetchedAt: 'not-a-date' } as never)).toBe('Unknown')
    expect(formatFxUpdatedAt({ fetchedAt: '2026-09-04T10:00:00.000Z' } as never)).not.toBe(
      'Unknown'
    )
  })
})

describe('out-of-usage helpers', () => {
  const usageEntry = (usedPercent: number): ModelUsageAggregate => ({
    provider: 'codex',
    model: 'usage limits',
    runs: 1,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    windows: [
      {
        id: 'w1',
        label: 'Weekly',
        runs: 1,
        totalTokens: 0,
        limitLabel: 'limit',
        usedPercent
      }
    ]
  })

  const signedIn: ProviderAuthSummary = {
    variant: 'signed-in',
    statusText: 'Signed in',
    hint: 'Ready'
  }

  it('finds the worst quota window or null when there is no quota data', () => {
    expect(worstProviderUsage(undefined, 'codex')).toBeNull()
    expect(worstProviderUsage([], 'codex')).toBeNull()
    expect(worstProviderUsage([usageEntry(40)], 'kimi')).toBeNull()
    expect(worstProviderUsage([usageEntry(40)], 'codex')?.fraction).toBe(0.4)
  })

  it('flips a maxed-out signed-in provider to out-of-usage', () => {
    const result = applyOutOfUsage('codex', signedIn, [usageEntry(100)])
    expect(result.variant).toBe('out-of-usage')
    expect(result.statusText).toContain('100% used')
  })

  it('leaves other variants and sub-threshold usage unchanged', () => {
    expect(applyOutOfUsage('codex', signedIn, [usageEntry(50)])).toBe(signedIn)
    const notSignedIn: ProviderAuthSummary = {
      variant: 'not-signed-in',
      statusText: 'Signed out',
      hint: 'Log in'
    }
    expect(applyOutOfUsage('codex', notSignedIn, [usageEntry(100)])).toBe(notSignedIn)
    expect(applyOutOfUsage('codex', signedIn, undefined)).toBe(signedIn)
  })
})
