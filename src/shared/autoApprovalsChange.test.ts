import { describe, expect, it } from 'vitest'
import {
  AUTO_APPROVALS_CHANGE_KIND,
  AUTO_APPROVALS_CHANGE_REVEAL_DELAY_MS,
  isAutoApprovalsChangePayload
} from './autoApprovalsChange'

describe('Auto Approvals change transcript payload', () => {
  it('accepts enabled and disabled state transitions', () => {
    expect(
      isAutoApprovalsChangePayload({
        before: false,
        after: true,
        changedAt: '2026-08-27T12:00:00.000Z'
      })
    ).toBe(true)
    expect(
      isAutoApprovalsChangePayload({
        before: true,
        after: false,
        changedAt: '2026-08-27T12:01:00.000Z'
      })
    ).toBe(true)
  })

  it('rejects malformed and no-op persisted values', () => {
    expect(isAutoApprovalsChangePayload(null)).toBe(false)
    expect(
      isAutoApprovalsChangePayload({
        before: false,
        after: false,
        changedAt: '2026-08-27T12:00:00.000Z'
      })
    ).toBe(false)
    expect(
      isAutoApprovalsChangePayload({
        before: 'off',
        after: true,
        changedAt: 'not-a-date'
      })
    ).toBe(false)
  })

  it('pins the persisted kind and seat-parity reveal delay', () => {
    expect(AUTO_APPROVALS_CHANGE_KIND).toBe('ensembleAutoApprovalsChange')
    expect(AUTO_APPROVALS_CHANGE_REVEAL_DELAY_MS).toBe(2_000)
  })
})
