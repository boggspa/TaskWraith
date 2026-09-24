import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import type { ChatRecord } from '../../../main/store/types'
import type { WorkingIndicatorPresentation } from '../lib/workingIndicatorPresentation'
import {
  formatWorkingSeatLabel,
  workingAccentStyle,
  workingIndicatorKey,
  workingIndicatorLabel,
  WorkingIndicatorTelemetryReadout,
  workingSeatNumber,
  workingStatusLabel
} from './TranscriptWorkingIndicator'

function presentation(
  overrides: Partial<WorkingIndicatorPresentation> = {}
): WorkingIndicatorPresentation {
  return {
    participantId: 'p1',
    runId: 'run-1',
    startedAt: '2026-09-05T10:00:00.000Z',
    modelId: 'model-1',
    providerLabel: 'Claude',
    provider: 'claude',
    providerClass: 'claude',
    roleLabel: 'Worker',
    modelBadge: 'Opus',
    activity: 'working',
    ...overrides
  }
}

function chatWith(ensemble: unknown): ChatRecord {
  return { ensemble } as unknown as ChatRecord
}

describe('workingStatusLabel', () => {
  it('prefers an explicit round-level status label over derived copy', () => {
    expect(workingStatusLabel(presentation({ statusLabel: 'Waiting on approval' }))).toBe(
      'Waiting on approval'
    )
  })

  it('names the seat role and provider while working', () => {
    expect(workingStatusLabel(presentation())).toBe('Worker (Claude) working')
  })

  it('drops the role clause when no role owns the interval', () => {
    expect(workingStatusLabel(presentation({ roleLabel: null }))).toBe('Claude working')
  })

  it('reports context compaction as its own activity', () => {
    expect(workingStatusLabel(presentation({ activity: 'compacting' }))).toBe(
      'Worker (Claude) compacting context'
    )
  })

  it('falls back to Agent when the provider label is empty', () => {
    expect(workingStatusLabel(presentation({ providerLabel: '', roleLabel: null }))).toBe(
      'Agent working'
    )
  })
})

describe('workingIndicatorLabel', () => {
  it('prefers the explicit status label', () => {
    expect(workingIndicatorLabel(presentation({ statusLabel: 'Queued' }))).toBe('Queued')
  })

  it('uses the compact activity words otherwise', () => {
    expect(workingIndicatorLabel(presentation())).toBe('Working')
    expect(workingIndicatorLabel(presentation({ activity: 'compacting' }))).toBe('Compacting')
  })
})

describe('workingIndicatorKey', () => {
  it('joins seat identity, run identity and index into a stable key', () => {
    expect(workingIndicatorKey(presentation(), 2)).toBe(
      'p1:run-1:2026-09-05T10:00:00.000Z:claude:Worker:Opus::2'
    )
  })

  it('separates two seats that differ only by run id', () => {
    const a = workingIndicatorKey(presentation({ runId: 'run-a' }), 0)
    const b = workingIndicatorKey(presentation({ runId: 'run-b' }), 0)
    expect(a).not.toBe(b)
  })

  it('falls back to the provider then to agent when no provider class exists', () => {
    expect(workingIndicatorKey(presentation({ providerClass: null }), 0)).toContain(':claude:')
    expect(workingIndicatorKey(presentation({ providerClass: null, provider: null }), 0)).toContain(
      ':agent:'
    )
  })
})

describe('workingAccentStyle', () => {
  it('derives a provider-scoped accent variable with an accent fallback', () => {
    expect(workingAccentStyle(presentation())).toEqual({
      '--message-working-accent': 'var(--provider-claude-color, var(--accent))'
    })
  })

  it('strips characters that would break the custom property name', () => {
    const style = workingAccentStyle(presentation({ providerClass: 'op/en ai!' }))
    expect(style).toEqual({
      '--message-working-accent': 'var(--provider-openai-color, var(--accent))'
    })
  })

  it('returns undefined rather than an unresolvable variable when nothing identifies the provider', () => {
    expect(
      workingAccentStyle(presentation({ providerClass: null, provider: null }))
    ).toBeUndefined()
    expect(
      workingAccentStyle(presentation({ providerClass: '///', provider: null }))
    ).toBeUndefined()
  })
})

describe('workingSeatNumber', () => {
  it('returns null without a participant id', () => {
    expect(workingSeatNumber(chatWith({ participants: [{ id: 'p1', order: 3 }] }), null)).toBeNull()
  })

  it('uses the roster order when the seat is only on the roster', () => {
    expect(workingSeatNumber(chatWith({ participants: [{ id: 'p1', order: 4 }] }), 'p1')).toBe(4)
  })

  it('falls back to roster position when the roster order is not a positive number', () => {
    const chat = chatWith({ participants: [{ id: 'p0', order: 7 }, { id: 'p1' }] })
    expect(workingSeatNumber(chat, 'p1')).toBe(2)
  })

  it('prefers the round order for a seat in the active round', () => {
    const chat = chatWith({
      participants: [{ id: 'p1', order: 4 }],
      activeRound: { participants: [{ participantId: 'p1', order: 9 }] }
    })
    expect(workingSeatNumber(chat, 'p1')).toBe(9)
  })

  it('honours a legacy zero-based roster by using roster position instead of round order', () => {
    const chat = chatWith({
      participants: [
        { id: 'p0', order: 0 },
        { id: 'p1', order: 1 }
      ],
      activeRound: { participants: [{ participantId: 'p1', order: 9 }] }
    })
    expect(workingSeatNumber(chat, 'p1')).toBe(2)
  })

  it('uses round position when the seat is only in the round', () => {
    const chat = chatWith({
      participants: [],
      activeRound: { participants: [{ participantId: 'x' }, { participantId: 'p1' }] }
    })
    expect(workingSeatNumber(chat, 'p1')).toBe(2)
  })

  it('returns null for a seat that is in neither collection', () => {
    expect(workingSeatNumber(chatWith({ participants: [] }), 'ghost')).toBeNull()
    expect(workingSeatNumber(null, 'p1')).toBeNull()
  })
})

describe('formatWorkingSeatLabel', () => {
  it('prefixes the seat number when the seat is numbered', () => {
    expect(
      formatWorkingSeatLabel({ seatNumber: 3, roleLabel: 'Worker', providerLabel: 'Claude' })
    ).toBe('#3 Worker')
  })

  it('omits the prefix for a solo or unnumbered seat', () => {
    expect(
      formatWorkingSeatLabel({ seatNumber: null, roleLabel: 'Worker', providerLabel: 'Claude' })
    ).toBe('Worker')
    expect(
      formatWorkingSeatLabel({ seatNumber: 0, roleLabel: 'Worker', providerLabel: 'Claude' })
    ).toBe('Worker')
  })

  it('falls back to the provider label and then to Agent when the role is blank', () => {
    expect(
      formatWorkingSeatLabel({ seatNumber: 2, roleLabel: '   ', providerLabel: 'Claude' })
    ).toBe('#2 Claude')
    expect(formatWorkingSeatLabel({ seatNumber: 2, roleLabel: null, providerLabel: '  ' })).toBe(
      '#2 Agent'
    )
  })
})

describe('WorkingIndicatorTelemetryReadout', () => {
  it('renders nothing while a turn is transitioning between seats', () => {
    expect(
      WorkingIndicatorTelemetryReadout({
        presentation: presentation({ activity: 'transitioning' }),
        tokenTarget: undefined,
        index: 0
      })
    ).toBeNull()
  })

  it('forwards the run anchors and the supplied token target', () => {
    const element = WorkingIndicatorTelemetryReadout({
      presentation: presentation(),
      tokenTarget: {
        tokenEpochKey: 'epoch-1',
        tokenEpochObservedAt: 42,
        contextBaselineTokens: 10,
        contextBaselineAvailable: true,
        contextState: 'ready',
        targetTokens: 100,
        estimatedCurrentTurnTokens: 5,
        estimatedToolResultTokens: 7
      } as never,
      index: 0
    }) as ReactElement<Record<string, unknown>>

    expect(element).not.toBeNull()
    expect(element.props.runId).toBe('run-1')
    expect(element.props.startedAt).toBe('2026-09-05T10:00:00.000Z')
    expect(element.props.tokenEpochKey).toBe('epoch-1')
    expect(element.props.contextBaselineAvailable).toBe(true)
    expect(element.props.fallbackTargetTokens).toBe(100)
  })

  it('synthesises a seat-scoped token epoch key when no token target exists', () => {
    const element = WorkingIndicatorTelemetryReadout({
      presentation: presentation(),
      tokenTarget: undefined,
      index: 0
    }) as ReactElement<Record<string, unknown>>

    expect(element.props.tokenEpochKey).toBe(JSON.stringify(['p1', 'claude', 'model-1']))
    expect(element.props.tokenEpochObservedAt).toBeNull()
    expect(element.props.contextState).toBe('unavailable')
    expect(element.props.fallbackTargetTokens).toBe(0)
  })

  it('labels a solo seat with unknown provider and model in the fallback epoch key', () => {
    const element = WorkingIndicatorTelemetryReadout({
      presentation: presentation({ participantId: null, provider: null, modelId: null }),
      tokenTarget: undefined,
      index: 0
    }) as ReactElement<Record<string, unknown>>

    expect(element.props.tokenEpochKey).toBe(
      JSON.stringify(['solo', 'unknown-provider', 'unknown-model'])
    )
  })
})
