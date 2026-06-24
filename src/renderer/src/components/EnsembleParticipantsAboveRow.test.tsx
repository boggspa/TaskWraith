import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EnsembleParticipantsAboveRow } from './EnsembleParticipantsAboveRow'
import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'

function makeParticipant(overrides: Partial<EnsembleParticipant>): EnsembleParticipant {
  return {
    id: 'ensemble-claude',
    provider: 'claude',
    enabled: true,
    role: 'Explorer',
    instructions: '',
    order: 1,
    model: 'claude-opus-4-7',
    permissionPresetId: 'read_only',
    ...overrides
  }
}

function makeChat(participants: EnsembleParticipant[]): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: 'New Ensemble',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 6,
      participants
    }
  }
}

describe('EnsembleParticipantsAboveRow', () => {
  it('returns null for non-ensemble chats', () => {
    const chat: ChatRecord = {
      appChatId: 'solo-chat',
      chatKind: 'single',
      scope: 'workspace',
      provider: 'claude',
      title: 'Solo',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: []
    }
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toBe('')
  })

  it('renders a chip per participant with role + idle status by default', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toContain('Explorer')
    expect(html).toContain('Worker')
    expect(html).toContain('aria-haspopup="dialog"')
    // Two `status-idle` pills should appear (one per participant when no
    // active round).
    const idleHits = html.match(/status-idle/g) || []
    expect(idleHits.length).toBeGreaterThanOrEqual(2)
  })

  it('marks the active participant as speaking + others by their round status', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    chat.ensemble!.activeRound = {
      roundId: 'round-1',
      status: 'running',
      prompt: 'Plan and implement.',
      startedAt: '2026-05-25T15:00:00.000Z',
      activeParticipantId: 'ensemble-codex',
      participants: [
        {
          participantId: 'ensemble-claude',
          provider: 'claude',
          role: 'Explorer',
          order: 1,
          status: 'answered'
        },
        {
          participantId: 'ensemble-codex',
          provider: 'codex',
          role: 'Worker',
          order: 2,
          status: 'running'
        }
      ]
    }
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toContain('status-speaking')
    expect(html).toContain('status-answered')
  })

  it('renders sleeping participant chips for scheduled wakeups', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    chat.ensemble!.activeRound = {
      roundId: 'round-1',
      status: 'running',
      prompt: 'Wait for external input.',
      startedAt: '2026-05-25T15:00:00.000Z',
      sleepingParticipantIds: ['ensemble-claude'],
      pendingWakeupIds: ['wakeup-1'],
      participants: [
        {
          participantId: 'ensemble-claude',
          provider: 'claude',
          role: 'Explorer',
          order: 1,
          status: 'sleeping',
          reason: '[wakeup:wakeup-1 until 2026-05-25T15:05:00.000Z]'
        },
        {
          participantId: 'ensemble-codex',
          provider: 'codex',
          role: 'Worker',
          order: 2,
          status: 'answered'
        }
      ]
    }
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toContain('status-sleeping')
    expect(html).toContain('sleeping — [wakeup:wakeup-1')
  })

  it('dims disabled participants but still renders them', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', enabled: true, role: 'Explorer' }),
      makeParticipant({
        id: 'ensemble-gemini',
        provider: 'gemini',
        enabled: false,
        role: 'Researcher',
        order: 2
      })
    ])
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toContain('Researcher')
    expect(html).toContain('is-dimmed')
  })

  // Slice F v2 (1.0.3) — clicking a chip selects it; the parent
  // (App.tsx) passes selectedParticipantId in and the component
  // applies an `.is-selected` class for the visual treatment.
  it('marks the selected participant chip with is-selected', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId="ensemble-codex"
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toContain('is-selected')
    // Only one chip is selected. Count the class hits in chip class
    // strings (the substring also appears inside aria attributes etc.,
    // so this is a heuristic check).
    const selectedHits = html.match(/class="ensemble-above-chip[^"]*is-selected/g) || []
    expect(selectedHits.length).toBe(1)
  })

  it('leaves orchestration controls out of the participant row', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    chat.ensemble!.orchestrationMode = 'continuous'
    chat.ensemble!.maxContinuationHops = 6
    chat.ensemble!.activeRound = {
      roundId: 'round-1',
      status: 'running',
      prompt: 'Keep going.',
      startedAt: '2026-05-25T15:00:00.000Z',
      orchestrationMode: 'continuous',
      continuationHops: 2,
      maxContinuationHops: 6,
      participants: [
        {
          participantId: 'ensemble-claude',
          provider: 'claude',
          role: 'Explorer',
          order: 1,
          status: 'answered'
        },
        {
          participantId: 'ensemble-codex',
          provider: 'codex',
          role: 'Worker',
          order: 2,
          status: 'running'
        }
      ]
    }

    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId="ensemble-codex"
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )

    expect(html).not.toContain('Continuous')
    expect(html).not.toContain('2/6 hops')
    expect(html).not.toContain('ensemble-above-mode-button')
  })

  it('renders the add-participant affordance until the six participant cap', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])

    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId="ensemble-codex"
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )

    expect(html).toContain('ensemble-above-add-participant')
    expect(html).toContain('Add Ensemble participant')
  })

  // Bossman — a gold crown renders before the assigned participant's role,
  // and "Bossman" is woven into the chip's accessible name/title. The crown
  // glyph itself is decorative (aria-hidden).
  it('renders a Bossman crown on the assigned participant only', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    chat.ensemble!.bossmanParticipantId = 'ensemble-claude'
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    // Exactly one crown, on the Bossman chip.
    const crownHits = html.match(/ensemble-above-chip-crown/g) || []
    expect(crownHits.length).toBe(1)
    // "Bossman" appears in the accessible name (aria-label) of the chip.
    expect(html).toContain('aria-label="Bossman Explorer"')
    // The crown glyph is decorative.
    expect(html).toContain('aria-hidden="true"')
  })

  it('renders no crown when no Bossman is assigned', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).not.toContain('ensemble-above-chip-crown')
    expect(html).not.toContain('Bossman')
  })
})
