import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'
import {
  ComposerEnsembleRosterPopover,
  ensemblePopoverSeatState
} from './ComposerEnsembleRosterPopover'

function participant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'builder',
    provider: 'codex',
    enabled: true,
    role: 'Builder',
    instructions: 'Implement the selected slice and verify it.',
    order: 1,
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    permissionPresetId: 'plan',
    ...overrides
  }
}

function chat(participants: EnsembleParticipant[]): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'codex',
    title: 'Ensemble mock',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 4,
      participants,
      bossmanParticipantId: 'builder',
      captainParticipantIds: ['reviewer']
    }
  }
}

describe('ComposerEnsembleRosterPopover', () => {
  it('adapts a live seat to the shared transcript seat presentation', () => {
    const state = ensemblePopoverSeatState(chat([participant()]), participant(), 0)

    expect(state).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      role: 'Builder',
      seatNumber: 1,
      reasoningEffort: 'high',
      permissionPresetId: 'plan',
      authority: 'boss'
    })
  })

  it('shows the shared seat strip with orchestration controls and a two-line brief editor', () => {
    const roster = chat([
      participant(),
      participant({
        id: 'reviewer',
        role: 'Reviewer',
        order: 2,
        provider: 'claude',
        model: 'claude-sonnet-5',
        instructions: 'Check the implementation against the requested experience.'
      })
    ])

    const html = renderToStaticMarkup(
      <ComposerEnsembleRosterPopover chat={roster} selectedParticipantId="reviewer" />
    )

    expect(html).toContain('Current roster')
    expect(html).toContain('#1 Builder')
    expect(html).toContain('#2 Reviewer')
    expect(html).toContain('Implement the selected slice and verify it.')
    expect(html).toContain('Check the implementation against the requested experience.')
    expect(html).toContain('composer-ensemble-roster-seat-picker-cluster')
    expect(html).toContain('data-composer-control="model"')
    expect(html).toContain('data-composer-control="permission"')
    expect(html).toContain('>Enabled</button>')
    expect(html).toContain('>Auto</button>')
    expect(html).toContain('>Stage</span>')
    expect(html).toContain('Goal / brief for #1 Builder')
    expect(html).toContain('Role for seat 1')
    expect(html).toContain('rows="4"')
    expect(html).toContain('composer-ensemble-roster-seat is-selected')
    expect(html).not.toContain('⠿')
  })
})
