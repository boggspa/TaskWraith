import { describe, expect, it } from 'vitest'
import {
  composedSeatRole,
  seatFromEnsembleMetadata,
  seatFromSubThreadMetadata
} from './transcriptSeat'

const SNAPSHOT = {
  schemaVersion: 1,
  provider: 'claude',
  model: 'claude-opus-5',
  reasoningEffort: 'xhigh',
  thinkingEnabled: false,
  configuredPermissionPresetId: 'read_only'
}

const metadata = (over: Record<string, unknown> = {}) => ({
  kind: 'ensembleParticipant',
  ensembleLaneId: 'lane-1',
  ensembleProvider: 'claude',
  ensembleModel: 'claude-opus-5',
  ensembleRole: 'Reviewer',
  ensembleOrder: 3,
  ensembleSeatSnapshot: SNAPSHOT,
  ...over
})

describe('seatFromEnsembleMetadata', () => {
  it('reads the whole seat, including the permission preset', () => {
    expect(seatFromEnsembleMetadata(metadata())).toEqual({
      provider: 'claude',
      model: 'claude-opus-5',
      role: 'Reviewer',
      seatNumber: 3,
      reasoningEffort: 'xhigh',
      thinkingEnabled: false,
      permissionPresetId: 'read_only'
    })
  })

  it('CARRIES the permission preset that the flat fields cannot', () => {
    // The whole reason the snapshot is read at all. Without it the chip would
    // fall back to the default tier and claim a lane ran under Accept Edits
    // when it actually ran read-only.
    const withoutSnapshot = seatFromEnsembleMetadata(metadata({ ensembleSeatSnapshot: undefined }))
    expect(withoutSnapshot).not.toHaveProperty('permissionPresetId')
    expect(seatFromEnsembleMetadata(metadata())?.permissionPresetId).toBe('read_only')
  })

  it('KEEPS the seat number — a fan-out lane is in the READER’s own roster', () => {
    // The opposite call from the peer-message card, where the sender sits in a
    // roster the reader is not in and "#3" would be uninterpretable.
    expect(seatFromEnsembleMetadata(metadata())?.seatNumber).toBe(3)
  })

  it('omits a non-positive or missing order rather than rendering #0', () => {
    expect(seatFromEnsembleMetadata(metadata({ ensembleOrder: 0 }))).not.toHaveProperty('seatNumber')
    expect(seatFromEnsembleMetadata(metadata({ ensembleOrder: undefined }))).not.toHaveProperty(
      'seatNumber'
    )
  })

  it('keeps thinkingEnabled false rather than dropping it as falsy', () => {
    expect(seatFromEnsembleMetadata(metadata())?.thinkingEnabled).toBe(false)
    expect(
      seatFromEnsembleMetadata(
        metadata({ ensembleSeatSnapshot: { ...SNAPSHOT, thinkingEnabled: true } })
      )?.thinkingEnabled
    ).toBe(true)
  })

  it('falls back to the flat fields when no snapshot was written', () => {
    // Rows emitted before the snapshot was added still render a seat, just
    // without reasoning or the permission tier.
    expect(seatFromEnsembleMetadata(metadata({ ensembleSeatSnapshot: undefined }))).toEqual({
      provider: 'claude',
      model: 'claude-opus-5',
      role: 'Reviewer',
      seatNumber: 3
    })
  })

  it('is null when no model resolves, rather than a seat with an empty model', () => {
    expect(
      seatFromEnsembleMetadata(metadata({ ensembleModel: '', ensembleSeatSnapshot: undefined }))
    ).toBeNull()
  })

  it('is null for a row with no ensemble metadata at all', () => {
    expect(seatFromEnsembleMetadata(undefined)).toBeNull()
    expect(seatFromEnsembleMetadata({})).toBeNull()
  })

  it('ignores a malformed snapshot instead of trusting it', () => {
    expect(seatFromEnsembleMetadata(metadata({ ensembleSeatSnapshot: 'claude' }))).toEqual({
      provider: 'claude',
      model: 'claude-opus-5',
      role: 'Reviewer',
      seatNumber: 3
    })
  })
})

describe('composedSeatRole', () => {
  it('composes the #N Role the seat element uses internally', () => {
    expect(composedSeatRole({ provider: 'claude', model: 'm', role: 'Lead', seatNumber: 3 })).toBe(
      '#3 Lead'
    )
  })

  it('renders the role alone when there is no seat number', () => {
    expect(composedSeatRole({ provider: 'claude', model: 'm', role: 'Lead' })).toBe('Lead')
  })

  it('is empty when the seat has no role, so a host renders nothing', () => {
    expect(composedSeatRole({ provider: 'claude', model: 'm' })).toBe('')
    expect(composedSeatRole({ provider: 'claude', model: 'm', seatNumber: 2 })).toBe('')
    expect(composedSeatRole(null)).toBe('')
  })
})

describe('seatFromSubThreadMetadata', () => {
  const SEAT = {
    provider: 'claude',
    model: 'claude-sonnet-5',
    role: 'Scout',
    reasoningEffort: 'medium',
    permissionPresetId: 'read_only'
  }

  it('reads the seat captured when the child returned', () => {
    expect(seatFromSubThreadMetadata({ subThreadSeat: SEAT })).toEqual(SEAT)
  })

  it('has NO flat fallback — an uncaptured seat must stay absent', () => {
    // Deliberately unlike the ensemble decoder. Falling back to live config
    // would let a later reconfiguration of the child rewrite what the parent is
    // told about a result it already received; the card shows its provider
    // label instead, which is honest about knowing less.
    expect(seatFromSubThreadMetadata({ subThreadProvider: 'claude' })).toBeNull()
    expect(seatFromSubThreadMetadata({})).toBeNull()
    expect(seatFromSubThreadMetadata(undefined)).toBeNull()
  })

  it('never carries a seat number — a sub-thread is not a roster seat', () => {
    expect(
      seatFromSubThreadMetadata({ subThreadSeat: { ...SEAT, seatNumber: 4 } })
    ).not.toHaveProperty('seatNumber')
  })

  it('refuses a seat with no model rather than rendering an empty one', () => {
    expect(seatFromSubThreadMetadata({ subThreadSeat: { provider: 'claude' } })).toBeNull()
  })

  it('drops a malformed seat instead of trusting persisted JSON', () => {
    expect(seatFromSubThreadMetadata({ subThreadSeat: 'claude' })).toBeNull()
    expect(seatFromSubThreadMetadata({ subThreadSeat: [] })).toBeNull()
  })
})
