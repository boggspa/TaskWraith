import { describe, expect, it } from 'vitest'
import {
  buildCloseoutReceipt,
  closeoutNarrativeHasAuthoredNumeral,
  closeoutReceiptSentence,
  mergeCloseoutReceipts
} from './closeoutReceipt'

describe('closeoutReceipt', () => {
  it('deduplicates receipt-backed commits and changed files', () => {
    const receipt = buildCloseoutReceipt({
      targetId: 'run-1',
      scope: 'run',
      status: 'success',
      durationMs: 12_400,
      totalTokens: 8_123,
      commits: [{ hash: 'abc123' }, { hash: 'abc123' }, { hash: 'def456' }],
      fileChanges: [{ path: 'src/a.ts' }, { path: 'src/a.ts' }, { path: 'src/b.ts' }],
      validations: { passed: ['tests', 'typecheck'], failed: ['lint'] }
    })

    expect(receipt).toMatchObject({
      version: 1,
      observedCommitCount: 2,
      observedChangedFileCount: 2,
      totalTokens: 8_123,
      validations: { passed: ['tests', 'typecheck'], failed: ['lint'] }
    })
    expect(closeoutReceiptSentence(receipt)).toBe('Receipt recorded 2 commits and 2 changed files.')
  })

  it('renders participant outcomes from structured status rows', () => {
    const receipt = buildCloseoutReceipt({
      targetId: 'round-1',
      scope: 'ensembleRound',
      status: 'failed',
      participants: [{ status: 'answered' }, { status: 'answered' }, { status: 'failed' }]
    })

    expect(receipt.participants).toEqual({
      total: 3,
      outcomes: [
        { status: 'answered', count: 2 },
        { status: 'failed', count: 1 }
      ]
    })
    expect(closeoutReceiptSentence(receipt)).toBe(
      'Receipt recorded 3 participants (2 answered and 1 failed).'
    )
  })

  it('rejects digits and common written numerals in authored narrative', () => {
    expect(closeoutNarrativeHasAuthoredNumeral('Changed 91 files.')).toBe(true)
    expect(closeoutNarrativeHasAuthoredNumeral('Changed ninety files.')).toBe(true)
    expect(closeoutNarrativeHasAuthoredNumeral('The two approaches converged.')).toBe(true)
    expect(closeoutNarrativeHasAuthoredNumeral('The approaches converged cleanly.')).toBe(false)
  })

  it('keeps stronger tombstoned evidence across a thinner rebuild', () => {
    const previous = buildCloseoutReceipt({
      targetId: 'run-1',
      scope: 'run',
      status: 'success',
      commits: [{ hash: 'abc123' }],
      fileChanges: [{ path: 'src/a.ts' }],
      validations: { passed: ['tests'] }
    })
    const next = buildCloseoutReceipt({
      targetId: 'run-1',
      scope: 'run',
      status: 'success'
    })

    expect(mergeCloseoutReceipts(previous, next)).toMatchObject({
      observedCommitCount: 1,
      observedChangedFileCount: 1,
      validations: { passed: ['tests'], failed: [] }
    })
  })

  it('lets a newer validation receipt replace an older outcome for the same check', () => {
    const previous = buildCloseoutReceipt({
      targetId: 'round-1',
      scope: 'ensembleRound',
      validations: { passed: ['tests'] }
    })
    const next = buildCloseoutReceipt({
      targetId: 'round-1',
      scope: 'ensembleRound',
      validations: { failed: ['tests'] }
    })

    expect(mergeCloseoutReceipts(previous, next).validations).toEqual({
      passed: [],
      failed: ['tests']
    })
  })
})
