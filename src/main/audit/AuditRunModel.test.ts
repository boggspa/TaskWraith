import { describe, expect, it } from 'vitest'
import {
  applyVerdictStates,
  budgetExhausted,
  computeCoverage,
  dedupeFindings,
  makeBudget,
  markTruncated,
  recordSpend,
  skepticCountForSeverity,
  survivingFindings
} from './AuditRunModel'
import type { AuditFinding, AuditVerdict } from '../store/types'

function finding(id: string, over: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id,
    dimension: 'code health',
    polarity: 'weakness',
    claim: 'claim',
    severity: 'medium',
    confidence: 0.5,
    evidenceRefs: [{ path: 'src/x.ts', line: 1 }],
    authorProvider: 'claude',
    dedupKey: `key-${id}`,
    verdictState: 'pending',
    createdAt: '2026-06-13T00:00:00.000Z',
    ...over
  }
}

function verdict(findingId: string, over: Partial<AuditVerdict> = {}): AuditVerdict {
  return {
    id: `v-${findingId}-${over.skepticProvider ?? 'x'}`,
    findingId,
    skepticProvider: 'codex',
    decision: 'accept',
    createdAt: '2026-06-13T00:00:00.000Z',
    ...over
  }
}

describe('dedupeFindings', () => {
  it('merges same-dedupKey findings: max severity, union evidence, mergedFrom + dimensions', () => {
    const a = finding('a', {
      dedupKey: 'K',
      dimension: 'code health',
      severity: 'medium',
      confidence: 0.4,
      evidenceRefs: [{ path: 'src/x.ts', line: 1 }]
    })
    const b = finding('b', {
      dedupKey: 'K',
      dimension: 'test depth',
      severity: 'high',
      confidence: 0.9,
      evidenceRefs: [{ path: 'src/x.ts', line: 1 }, { path: 'src/y.ts', line: 2 }]
    })
    const [merged, ...rest] = dedupeFindings([a, b])
    expect(rest).toHaveLength(0)
    expect(merged.id).toBe('a') // canonical = first seen
    expect(merged.severity).toBe('high')
    expect(merged.confidence).toBe(0.9)
    expect(merged.evidenceRefs).toHaveLength(2)
    expect(merged.mergedFrom).toEqual(['b'])
    expect(merged.dimension).toBe('code health, test depth')
  })

  it('leaves distinct findings untouched and preserves order', () => {
    const out = dedupeFindings([finding('a'), finding('b'), finding('c')])
    expect(out.map((f) => f.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('applyVerdictStates + survivingFindings', () => {
  it('stamps states and drops only evidence-anchored refutations', () => {
    const findings = [finding('keep'), finding('flag'), finding('kill')]
    const verdicts = [
      verdict('keep', { decision: 'accept' }),
      verdict('flag', { decision: 'refute' }), // no counter-evidence → unverified
      verdict('kill', { decision: 'refute', counterEvidence: [{ path: 'z', line: 9 }] })
    ]
    const stamped = applyVerdictStates(findings, verdicts)
    const byId = Object.fromEntries(stamped.map((f) => [f.id, f.verdictState]))
    expect(byId).toEqual({ keep: 'confirmed', flag: 'unverified', kill: 'refuted' })

    const survivors = survivingFindings(stamped).map((f) => f.id)
    expect(survivors).toEqual(['keep', 'flag']) // unverified survives, refuted dropped
  })
})

describe('skepticCountForSeverity', () => {
  it('high/critical get 2, others get 1', () => {
    expect(skepticCountForSeverity('critical')).toBe(2)
    expect(skepticCountForSeverity('high')).toBe(2)
    expect(skepticCountForSeverity('medium')).toBe(1)
    expect(skepticCountForSeverity('low')).toBe(1)
  })
})

describe('budget', () => {
  it('exhausts on agent ceiling and token ceiling', () => {
    let b = makeBudget(2, 1000)
    expect(budgetExhausted(b)).toBe(false)
    b = recordSpend(b, { agents: 2, tokens: 100 })
    expect(budgetExhausted(b)).toBe(true) // agents hit
    const t = recordSpend(makeBudget(10, 500), { agents: 1, tokens: 500 })
    expect(budgetExhausted(t)).toBe(true) // tokens hit
  })

  it('markTruncated is idempotent', () => {
    const b = markTruncated(makeBudget(5))
    expect(b.truncated).toBe(true)
    expect(markTruncated(b)).toBe(b)
  })
})

describe('computeCoverage', () => {
  it('counts cross- vs single-provider verification + emits honest notes', () => {
    const findings = [finding('a'), finding('b'), finding('c')]
    const verdicts = [
      verdict('a', { skepticProvider: 'codex' }),
      verdict('a', { skepticProvider: 'grok' }), // a: 2 providers → cross
      verdict('b', { skepticProvider: 'codex' }) // b: 1 provider → single
      // c: unverified
    ]
    const coverage = computeCoverage({
      dimensionsPlanned: 4,
      dimensionsCompleted: 3,
      findings,
      verdicts,
      substitutions: 1,
      budgetTruncated: true
    })
    expect(coverage.crossProviderVerifiedCount).toBe(1)
    expect(coverage.singleProviderVerifiedCount).toBe(1)
    expect(coverage.notes?.some((n) => n.includes('3/4 dimensions'))).toBe(true)
    expect(coverage.notes?.some((n) => n.includes('substitution'))).toBe(true)
    expect(coverage.notes?.some((n) => n.includes('Budget ceiling'))).toBe(true)
  })

  it('flags single-provider-only verification', () => {
    const coverage = computeCoverage({
      dimensionsPlanned: 2,
      dimensionsCompleted: 2,
      findings: [finding('a')],
      verdicts: [verdict('a', { skepticProvider: 'claude' })],
      substitutions: 0,
      budgetTruncated: false
    })
    expect(coverage.notes?.some((n) => n.includes('single-provider'))).toBe(true)
  })
})
