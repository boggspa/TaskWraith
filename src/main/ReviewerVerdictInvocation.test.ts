import { describe, it, expect } from 'vitest'
import { isExactReviewerVerdictInvocation } from './ReviewerVerdictInvocation'

const TOOL = 'ensemble_bossman_control'

describe('isExactReviewerVerdictInvocation — C2-v4 exact-invocation classifier', () => {
  it('V1: the exact invocation (passed | failed) ⇒ TRUE', () => {
    expect(isExactReviewerVerdictInvocation(TOOL, { action: 'submit_review_verdict', gateId: 'g1', verdict: 'passed' })).toBe(true)
    expect(isExactReviewerVerdictInvocation(TOOL, { action: 'submit_review_verdict', gateId: 'g1', verdict: 'failed' })).toBe(true)
  })

  it('V2: wrong toolName with the same args ⇒ FALSE', () => {
    expect(isExactReviewerVerdictInvocation('ensemble_roster_edit', { action: 'submit_review_verdict', gateId: 'g1', verdict: 'passed' })).toBe(false)
    expect(isExactReviewerVerdictInvocation('ensemble_bossman_control ', { action: 'submit_review_verdict', gateId: 'g1', verdict: 'passed' })).toBe(false)
  })

  it('V3: ANY extra key ⇒ FALSE (strict no-extra-key; hard reject, not drop)', () => {
    for (const extra of ['reviewer', 'scope', 'criteria', 'waive', 'owner', 'reason', 'reviewStatus', 'targetParticipantId']) {
      expect(
        isExactReviewerVerdictInvocation(TOOL, { action: 'submit_review_verdict', gateId: 'g1', verdict: 'passed', [extra]: 'x' })
      ).toBe(false)
    }
  })

  it('V4: a missing key ⇒ FALSE', () => {
    expect(isExactReviewerVerdictInvocation(TOOL, { action: 'submit_review_verdict', gateId: 'g1' })).toBe(false) // no verdict
    expect(isExactReviewerVerdictInvocation(TOOL, { action: 'submit_review_verdict', verdict: 'passed' })).toBe(false) // no gateId
    expect(isExactReviewerVerdictInvocation(TOOL, { gateId: 'g1', verdict: 'passed' })).toBe(false) // no action
  })

  it('V5: wrong action ⇒ FALSE', () => {
    for (const action of ['set_goal', 'quarantine_participant', 'set_review_gate', 'update_goal']) {
      expect(isExactReviewerVerdictInvocation(TOOL, { action, gateId: 'g1', verdict: 'passed' })).toBe(false)
    }
  })

  it('V6: empty / whitespace / non-string gateId ⇒ FALSE', () => {
    expect(isExactReviewerVerdictInvocation(TOOL, { action: 'submit_review_verdict', gateId: '', verdict: 'passed' })).toBe(false)
    expect(isExactReviewerVerdictInvocation(TOOL, { action: 'submit_review_verdict', gateId: '   ', verdict: 'passed' })).toBe(false)
    expect(isExactReviewerVerdictInvocation(TOOL, { action: 'submit_review_verdict', gateId: 123, verdict: 'passed' })).toBe(false)
  })

  it('V7: verdict not in the enum ⇒ FALSE', () => {
    for (const verdict of ['waived', 'required', 'pass', 'PASSED', true, null]) {
      expect(isExactReviewerVerdictInvocation(TOOL, { action: 'submit_review_verdict', gateId: 'g1', verdict })).toBe(false)
    }
  })

  it('V8: FAIL-CLOSED on unavailable / non-object args ⇒ FALSE', () => {
    for (const args of [undefined, null, 'string', 42, ['a'], true]) {
      expect(isExactReviewerVerdictInvocation(TOOL, args)).toBe(false)
    }
  })
})
