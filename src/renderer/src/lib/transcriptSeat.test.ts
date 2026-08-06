import { describe, expect, it } from 'vitest'
import type { ChatRun } from '../../../main/store/types'
import {
  composedSeatRole,
  seatFromChatRun,
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

describe('stage role reaches the glyph', () => {
  it('carries a valid ensemble stage role', () => {
    expect(seatFromEnsembleMetadata(metadata({ ensembleStageRole: 'scout' }))?.stageRole).toBe(
      'scout'
    )
  })

  it('drops an unknown stage role rather than passing it to the icon resolver', () => {
    // Comes off persisted metadata, so an unrecognised value must not reach a
    // component that switches on a closed union.
    expect(
      seatFromEnsembleMetadata(metadata({ ensembleStageRole: 'overlord' }))
    ).not.toHaveProperty('stageRole')
    expect(seatFromEnsembleMetadata(metadata({ ensembleStageRole: 42 }))).not.toHaveProperty(
      'stageRole'
    )
  })

  it('has no stage role when the row never carried one', () => {
    expect(seatFromEnsembleMetadata(metadata())).not.toHaveProperty('stageRole')
  })
})

describe('lane authority reaches the glyph', () => {
  it('carries Boss and Captain from the lane row', () => {
    expect(seatFromEnsembleMetadata(metadata({ ensembleSeatAuthority: 'boss' }))?.authority).toBe(
      'boss'
    )
    expect(
      seatFromEnsembleMetadata(metadata({ ensembleSeatAuthority: 'captain' }))?.authority
    ).toBe('captain')
  })

  it('drops an unknown authority rather than passing it to the icon resolver', () => {
    expect(
      seatFromEnsembleMetadata(metadata({ ensembleSeatAuthority: 'king' }))
    ).not.toHaveProperty('authority')
  })

  it('has none for an ordinary lane', () => {
    expect(seatFromEnsembleMetadata(metadata())).not.toHaveProperty('authority')
  })
})

describe('seatFromChatRun', () => {
  const run = (over: Partial<ChatRun> = {}): ChatRun =>
    ({
      runId: 'run-1',
      startedAt: '2026-08-06T10:00:00.000Z',
      ensembleRole: 'SolBoss',
      ensembleOrder: 1,
      ensembleParticipantId: 'p-1',
      ensembleSeatSnapshot: {
        schemaVersion: 1,
        provider: 'claude',
        model: 'claude-fable-5',
        reasoningEffort: 'max',
        configuredPermissionPresetId: 'workspace_write'
      },
      ...over
    }) as ChatRun

  it('reads the whole seat off the run that asked', () => {
    expect(seatFromChatRun(run())).toEqual({
      provider: 'claude',
      model: 'claude-fable-5',
      role: 'SolBoss',
      seatNumber: 1,
      reasoningEffort: 'max',
      permissionPresetId: 'workspace_write'
    })
  })

  it('refuses a run that never sat in a seat', () => {
    // Solo turns and chat-level runs have no participant behind them. MEASURED
    // on the real chat store: 11 of 15 question markers resolve to exactly this
    // shape, and every one of them must keep the plain provider label.
    expect(seatFromChatRun(run({ ensembleSeatSnapshot: undefined }))).toBeNull()
    expect(seatFromChatRun(null)).toBeNull()
    expect(seatFromChatRun(undefined)).toBeNull()
  })

  it('refuses a snapshot with no model rather than rendering an empty chip', () => {
    expect(
      seatFromChatRun(
        run({
          ensembleSeatSnapshot: {
            schemaVersion: 1,
            provider: 'claude',
            configuredPermissionPresetId: 'read_only'
          }
        })
      )
    ).toBeNull()
  })

  it('carries the stage role and drops an unknown one', () => {
    expect(seatFromChatRun(run({ ensembleStageRole: 'reviewer' }))?.stageRole).toBe('reviewer')
    expect(seatFromChatRun(run({ ensembleStageRole: 'overlord' as never }))).not.toHaveProperty(
      'stageRole'
    )
  })

  it('carries the thinking flag, including when it is false', () => {
    const seat = seatFromChatRun(
      run({
        ensembleSeatSnapshot: {
          schemaVersion: 1,
          provider: 'kimi',
          model: 'kimi-k2.7-code',
          thinkingEnabled: false,
          configuredPermissionPresetId: 'read_only'
        }
      })
    )
    expect(seat?.thinkingEnabled).toBe(false)
  })

  it('omits a seat number for a run with no order', () => {
    expect(seatFromChatRun(run({ ensembleOrder: undefined }))).not.toHaveProperty('seatNumber')
  })

  it('makes no authority claim — a run does not record one', () => {
    expect(seatFromChatRun(run())).not.toHaveProperty('authority')
  })
})
