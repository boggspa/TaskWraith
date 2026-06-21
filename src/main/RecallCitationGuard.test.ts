import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetRecallCitationLedger,
  annotateRecallCitations,
  createRecallCitationLedger,
  extractRecallCitations,
  formatRecallCitation,
  recordRecallCitation,
  verifyRecallCitations
} from './RecallCitationGuard'

describe('formatRecallCitation / extractRecallCitations', () => {
  it('round-trips a token through the canonical form', () => {
    const cite = formatRecallCitation('read:r1')
    expect(cite).toBe('⟦recall:read:r1⟧')
    expect(extractRecallCitations(`The run ${cite} ended failed.`)).toEqual(['read:r1'])
  })

  it('dedupes and ignores already-annotated markers', () => {
    const text = '⟦recall:a⟧ then ⟦recall:a⟧ and ⟦recall:b — unverified⟧'
    expect(extractRecallCitations(text)).toEqual(['a'])
  })

  it('returns nothing when there are no citations', () => {
    expect(extractRecallCitations('plain answer, no tokens')).toEqual([])
  })
})

describe('createRecallCitationLedger', () => {
  it('records issued tokens and returns their canonical form', () => {
    const ledger = createRecallCitationLedger()
    expect(ledger.issue('read:r1')).toBe('⟦recall:read:r1⟧')
    ledger.issue('read:r2')
    expect([...ledger.issued].sort()).toEqual(['read:r1', 'read:r2'])
  })
})

describe('verifyRecallCitations', () => {
  it('leaves served citations untouched', () => {
    const served = new Set(['read:r1'])
    const text = 'Ollama got 4/7 done. ⟦recall:read:r1⟧'
    const result = verifyRecallCitations(text, served)
    expect(result.unservedTokens).toEqual([])
    expect(result.hadServedCitation).toBe(true)
    expect(result.annotatedText).toBe(text)
  })

  it('annotates a fabricated/stale citation visibly instead of stripping it', () => {
    const served = new Set(['read:r1'])
    const text = 'It finished cleanly. ⟦recall:read:ghost⟧'
    const result = verifyRecallCitations(text, served)
    expect(result.unservedTokens).toEqual(['read:ghost'])
    expect(result.hadServedCitation).toBe(false)
    expect(result.annotatedText).toContain('⟦recall:read:ghost — unverified⟧')
    expect(result.annotatedText).not.toContain('⟦recall:read:ghost⟧')
  })

  it('handles a mix of served and unserved citations', () => {
    const served = new Set(['read:r1'])
    const text = 'A ⟦recall:read:r1⟧ and B ⟦recall:read:r2⟧'
    const result = verifyRecallCitations(text, served)
    expect(result.citedTokens.sort()).toEqual(['read:r1', 'read:r2'])
    expect(result.unservedTokens).toEqual(['read:r2'])
    expect(result.hadServedCitation).toBe(true)
    expect(result.annotatedText).toContain('⟦recall:read:r1⟧')
    expect(result.annotatedText).toContain('⟦recall:read:r2 — unverified⟧')
  })
})

describe('per-run citation ledger', () => {
  afterEach(() => __resetRecallCitationLedger())

  it('annotates only the tokens the run did not actually serve', () => {
    recordRecallCitation('run-1', 'read:r1')
    const text = 'A ⟦recall:read:r1⟧ and ghost ⟦recall:read:ghost⟧'
    const out = annotateRecallCitations('run-1', text)
    expect(out).toContain('⟦recall:read:r1⟧')
    expect(out).toContain('⟦recall:read:ghost — unverified⟧')
  })

  it('flags every citation when the run served nothing', () => {
    const out = annotateRecallCitations('run-x', 'It finished cleanly ⟦recall:read:r1⟧')
    expect(out).toContain('⟦recall:read:r1 — unverified⟧')
  })

  it('is a fast no-op for text without any citation', () => {
    recordRecallCitation('run-1', 'read:r1')
    expect(annotateRecallCitations('run-1', 'plain answer')).toBe('plain answer')
    expect(annotateRecallCitations(null, 'plain answer')).toBe('plain answer')
  })
})
