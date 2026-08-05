import { describe, expect, it } from 'vitest'
import {
  resolveThreadMessageSenderSeat,
  seatFromParticipant,
  seatFromSoloChat
} from './ThreadMessageSeatCapture'

const PARTICIPANT = {
  id: 'p-2',
  provider: 'claude',
  model: 'claude-opus-5',
  role: 'Reviewer',
  reasoningEffort: 'xhigh',
  thinkingEnabled: false,
  permissionPresetId: 'full_access',
  order: 3,
  grantsCount: 4
}

describe('seatFromParticipant', () => {
  it('captures the fields the strip renders', () => {
    expect(seatFromParticipant(PARTICIPANT)).toEqual({
      provider: 'claude',
      model: 'claude-opus-5',
      role: 'Reviewer',
      reasoningEffort: 'xhigh',
      thinkingEnabled: false,
      permissionPresetId: 'full_access'
    })
  })

  it('NEVER captures the seat number — it is roster-local, so a peer reader cannot read it', () => {
    const seat = seatFromParticipant(PARTICIPANT)
    expect(seat).not.toHaveProperty('seatNumber')
    expect(seat).not.toHaveProperty('order')
  })

  it('never captures the grants count — it describes the workspace, not the sender', () => {
    expect(seatFromParticipant(PARTICIPANT)).not.toHaveProperty('grantsCount')
  })

  it('keeps thinkingEnabled false rather than dropping it as falsy', () => {
    // A Kimi/Mistral seat renders its suffix from this, separately from
    // reasoningEffort; treating it as truthiness loses the "off" state.
    expect(seatFromParticipant(PARTICIPANT)?.thinkingEnabled).toBe(false)
    expect(seatFromParticipant({ ...PARTICIPANT, thinkingEnabled: true })?.thinkingEnabled).toBe(
      true
    )
    expect(
      seatFromParticipant({ ...PARTICIPANT, thinkingEnabled: undefined })
    ).not.toHaveProperty('thinkingEnabled')
  })

  it('refuses a participant with no model rather than emitting an empty one', () => {
    expect(seatFromParticipant({ ...PARTICIPANT, model: '  ' })).toBeNull()
  })

  it('refuses a participant with no provider', () => {
    expect(seatFromParticipant({ ...PARTICIPANT, provider: '' })).toBeNull()
  })

  it('is null for a missing participant', () => {
    expect(seatFromParticipant(null)).toBeNull()
    expect(seatFromParticipant(undefined)).toBeNull()
  })
})

describe('seatFromSoloChat', () => {
  it('prefers what actually ran over what was merely selected', () => {
    expect(
      seatFromSoloChat({
        provider: 'codex',
        requestedModel: 'gpt-5.6',
        lastActualModel: 'gpt-5.6-codex'
      })
    ).toEqual({ provider: 'codex', model: 'gpt-5.6-codex' })
  })

  it('falls back to the requested model when nothing has run yet', () => {
    expect(seatFromSoloChat({ provider: 'codex', requestedModel: 'gpt-5.6' })).toEqual({
      provider: 'codex',
      model: 'gpt-5.6'
    })
  })

  it('omits the permission preset rather than inventing one', () => {
    // Accurate, not lossy: the strip resolves an absent preset to 'default',
    // which is what the dispatch layer resolves for a seat naming none.
    expect(seatFromSoloChat({ provider: 'codex', requestedModel: 'gpt-5.6' })).not.toHaveProperty(
      'permissionPresetId'
    )
  })

  it('is null when the chat has never resolved a model', () => {
    expect(seatFromSoloChat({ provider: 'codex' })).toBeNull()
  })

  it('is null when the chat has no provider', () => {
    expect(seatFromSoloChat({ requestedModel: 'gpt-5.6' })).toBeNull()
  })
})

describe('resolveThreadMessageSenderSeat', () => {
  const CHAT = {
    provider: 'codex',
    requestedModel: 'gpt-5.6',
    ensemble: { participants: [PARTICIPANT, { ...PARTICIPANT, id: 'p-9', role: 'Implementer' }] }
  }

  it('prefers the named roster seat over the chat', () => {
    expect(resolveThreadMessageSenderSeat(CHAT, 'p-9')?.role).toBe('Implementer')
  })

  it('falls back to the chat when no participant is named', () => {
    expect(resolveThreadMessageSenderSeat(CHAT)).toEqual({
      provider: 'codex',
      model: 'gpt-5.6'
    })
  })

  it('falls back rather than naming SOME OTHER seat when the id does not resolve', () => {
    // Naming the wrong sender is the single failure this capture exists to
    // avoid — a stale id must not silently resolve to a neighbouring seat.
    expect(resolveThreadMessageSenderSeat(CHAT, 'p-gone')).toEqual({
      provider: 'codex',
      model: 'gpt-5.6'
    })
  })

  it('is null for a solo chat that has resolved nothing', () => {
    expect(resolveThreadMessageSenderSeat({ provider: 'codex' }, 'p-2')).toBeNull()
  })

  it('is null for a missing chat', () => {
    expect(resolveThreadMessageSenderSeat(null)).toBeNull()
  })
})
