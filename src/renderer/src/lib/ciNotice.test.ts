import { describe, expect, it } from 'vitest'
import { buildCiNotice } from './ciNotice'
import type { GitCiStatusSummary, GitPrSummary } from '../../../main/services/GitService'

describe('buildCiNotice', () => {
  it('returns null when there is no PR', () => {
    expect(buildCiNotice(null, null)).toBeNull()
    expect(buildCiNotice({ state: 'OPEN' } as GitPrSummary, null)).toBeNull()
  })

  it('does not offer when CI is passing and the PR is not blocked', () => {
    const pr = {
      number: 75,
      state: 'OPEN',
      checks: [{ name: 'build', status: 'completed', conclusion: 'success' }]
    } as GitPrSummary
    const notice = buildCiNotice(pr, null)
    expect(notice?.shouldOffer).toBe(false)
  })

  it('offers a failing-CI notice with the failing check names + idempotency key', () => {
    const pr = {
      number: 75,
      state: 'OPEN',
      url: 'https://gh/pr/75',
      headRefOid: 'sha123',
      headRefName: 'feat/x',
      baseRefName: 'main',
      checks: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'unit-tests', status: 'completed', conclusion: 'failure' }
      ]
    } as GitPrSummary
    const notice = buildCiNotice(pr, null, 'acme/app')
    expect(notice?.shouldOffer).toBe(true)
    expect(notice?.summary).toContain('CI is failing on acme/app PR #75')
    expect(notice?.detail).toContain('unit-tests')
    expect(notice?.detail).toContain('external, unverified')
    expect(notice?.suggestedPrompt).toContain('PR #75')
    expect(notice?.key).toBe('ci-status:75:sha123:failed')
  })

  it('prefers the live ciStatus failed classification', () => {
    const pr = {
      number: 9,
      state: 'OPEN',
      headRefOid: 'abc',
      checks: [{ name: 'lint', status: 'completed', conclusion: 'success' }]
    } as GitPrSummary
    const ci = {
      status: 'failed',
      checks: [],
      runs: [{ id: 1 }],
      failedLogs: []
    } as unknown as GitCiStatusSummary
    const notice = buildCiNotice(pr, ci)
    expect(notice?.shouldOffer).toBe(true)
    expect(notice?.key).toBe('ci-status:9:abc:failed')
  })

  it('offers a merge-blocked notice when the PR is blocked', () => {
    const pr = {
      number: 12,
      state: 'OPEN',
      mergeStateStatus: 'BLOCKED',
      checks: [{ name: 'build', status: 'completed', conclusion: 'success' }]
    } as GitPrSummary
    const notice = buildCiNotice(pr, null)
    expect(notice?.shouldOffer).toBe(true)
    expect(notice?.summary).toContain('blocked from merging')
  })
})
