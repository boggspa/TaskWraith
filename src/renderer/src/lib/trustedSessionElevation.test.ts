import { describe, expect, it } from 'vitest'
import {
  planElevatesASeat,
  planTrustedSessionElevation,
  type TrustedSessionElevationInput
} from './trustedSessionElevation'

const input = (over: Partial<TrustedSessionElevationInput> = {}): TrustedSessionElevationInput => ({
  chatId: 'chat-1',
  isEnsembleChat: false,
  ...over
})

/**
 * THE regression. On builds before `cf22ca118` the confirm sheet granted the
 * trusted session and stopped — the seat kept its prompting preset and the
 * approval stayed pending, so the button looked inert and the prompts kept
 * coming. A grant that does not also elevate is the defect, so it must not be
 * expressible here.
 */
describe('a confirmed Full Access always elevates a seat', () => {
  it('elevates for a solo chat opened from the picker', () => {
    const plan = planTrustedSessionElevation(input())
    expect(plan).toEqual({
      kind: 'elevate',
      target: { scope: 'solo' },
      grantParticipantId: null,
      acceptApprovalId: null
    })
  })

  it('elevates for every shape that is not blocked or targetless', () => {
    const shapes: Array<Partial<TrustedSessionElevationInput>> = [
      {},
      { approvalId: 'ap-1' },
      { isEnsembleChat: true, participantIds: ['p-1'], selectedParticipantId: 'p-1' },
      { approvalId: 'ap-1', approvalParticipantId: 'p-1', participantIds: ['p-1'] },
      // A stale participant id still elevates — as the solo lane, never nothing.
      { approvalId: 'ap-1', approvalParticipantId: 'p-gone', participantIds: ['p-1'] }
    ]
    for (const shape of shapes) {
      expect(planElevatesASeat(planTrustedSessionElevation(input(shape)))).toBe(true)
    }
  })
})

describe('which seat receives it', () => {
  it("prefers the approval's own participant over the composer selection", () => {
    // Accepting a prompt raised by seat B while seat A is selected must raise
    // B: elevating A would leave B prompting AND silently raise a seat the user
    // never agreed to raise.
    const plan = planTrustedSessionElevation(
      input({
        isEnsembleChat: true,
        approvalId: 'ap-1',
        approvalParticipantId: 'p-b',
        selectedParticipantId: 'p-a',
        participantIds: ['p-a', 'p-b']
      })
    )
    expect(plan).toMatchObject({
      target: { scope: 'participant', participantId: 'p-b', via: 'approval' },
      grantParticipantId: 'p-b'
    })
  })

  it('falls back to the selected participant when the sheet came from the picker', () => {
    expect(
      planTrustedSessionElevation(
        input({
          isEnsembleChat: true,
          selectedParticipantId: 'p-a',
          participantIds: ['p-a', 'p-b']
        })
      )
    ).toMatchObject({ target: { scope: 'participant', participantId: 'p-a', via: 'selection' } })
  })

  it('ignores a participant that has left the roster rather than elevating a ghost', () => {
    expect(
      planTrustedSessionElevation(
        input({
          isEnsembleChat: true,
          approvalId: 'ap-1',
          approvalParticipantId: 'p-removed',
          participantIds: ['p-a']
        })
      )
    ).toMatchObject({ target: { scope: 'solo' }, grantParticipantId: null })
  })

  it('never targets a participant in a solo chat, even if one is selected', () => {
    expect(
      planTrustedSessionElevation(
        input({ isEnsembleChat: false, selectedParticipantId: 'p-a', participantIds: ['p-a'] })
      )
    ).toMatchObject({ target: { scope: 'solo' } })
  })
})

describe('the prompt that opened the sheet is resolved', () => {
  it('carries the approval id through so it can be accepted after elevating', () => {
    expect(planTrustedSessionElevation(input({ approvalId: 'ap-7' }))).toMatchObject({
      acceptApprovalId: 'ap-7'
    })
  })

  it('carries none when opened from the picker', () => {
    expect(planTrustedSessionElevation(input())).toMatchObject({ acceptApprovalId: null })
  })

  it('treats a blank approval id as none', () => {
    expect(planTrustedSessionElevation(input({ approvalId: '   ' }))).toMatchObject({
      acceptApprovalId: null
    })
  })
})

describe('the write path is preserved, not collapsed', () => {
  // The composer writes an approval-named seat via patchEnsembleParticipantById
  // and its own selection via updateSelectedParticipant, which also rebinds the
  // picker. `via` is what keeps the handler routing to the right one.
  it('marks an approval-named seat and a selected seat differently', () => {
    const viaApproval = planTrustedSessionElevation(
      input({
        isEnsembleChat: true,
        approvalId: 'ap-1',
        approvalParticipantId: 'p-a',
        selectedParticipantId: 'p-a',
        participantIds: ['p-a']
      })
    )
    const viaSelection = planTrustedSessionElevation(
      input({ isEnsembleChat: true, selectedParticipantId: 'p-a', participantIds: ['p-a'] })
    )
    expect(viaApproval).toMatchObject({ target: { via: 'approval' } })
    expect(viaSelection).toMatchObject({ target: { via: 'selection' } })
  })
})

describe('refusals', () => {
  it('is blocked when lane mutation is disabled, and grants nothing', () => {
    const plan = planTrustedSessionElevation(input({ disabledReason: 'Chat is popped out.' }))
    expect(plan).toEqual({ kind: 'blocked', reason: 'Chat is popped out.' })
    expect(planElevatesASeat(plan)).toBe(false)
  })

  it('has no target without a chat', () => {
    const plan = planTrustedSessionElevation(input({ chatId: '' }))
    expect(plan).toEqual({ kind: 'no-target' })
    expect(planElevatesASeat(plan)).toBe(false)
  })

  it('refuses before considering the approval, so a prompt cannot force a grant', () => {
    expect(
      planTrustedSessionElevation(
        input({ disabledReason: 'Chat is popped out.', approvalId: 'ap-1' })
      )
    ).toMatchObject({ kind: 'blocked' })
  })
})
