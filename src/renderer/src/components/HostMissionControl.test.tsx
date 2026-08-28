import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  HOST_PROJECTION_VERSION,
  HOST_PROTOCOL_VERSION,
  type HostSnapshot
} from '../../../shared/hostProtocol'
import type { HostProjectionState } from '../lib/host/HostProjectionStore'
import { HostCommandController } from '../lib/host/HostCommandController'
import type { HostCommandRunOutcome } from '../lib/host/HostCommandClient'
import { projectHostSnapshot } from '../lib/host/hostSnapshotProjection'
import {
  formatHostMissionControlSummary,
  HOST_MISSION_CONTROL_ROSTER_PREVIEW_LIMIT,
  HostMissionControl,
  projectHostMissionControl
} from './HostMissionControl'

function snapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    generatedAt: '2026-08-09T20:00:00.000Z',
    generation: 4,
    cursor: 12,
    freshness: 'live',
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    },
    workspaces: [],
    threads: [],
    runs: [],
    missions: [],
    rounds: [],
    participants: [],
    providers: [],
    questions: [],
    approvals: [],
    schedules: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings: [],
    recovery: { reopenStatus: 'clean' },
    ...overrides
  }
}

function stateFromSnapshot(source: HostSnapshot): HostProjectionState {
  return {
    status: 'live',
    projection: projectHostSnapshot(source, 'live'),
    liveBaselineContinuity: true,
    lastGeneration: source.generation,
    lastCursor: source.cursor
  }
}

function missionFixture(): HostSnapshot {
  return snapshot({
    threads: [
      {
        id: 'thread-z',
        workspaceId: null,
        title: 'Zeta thread',
        chatKind: 'ensemble',
        archived: false,
        pinned: false,
        updatedAt: 100,
        messageCount: 1
      },
      {
        id: 'thread-a',
        workspaceId: null,
        title: 'Alpha thread',
        chatKind: 'ensemble',
        archived: false,
        pinned: false,
        updatedAt: 200,
        messageCount: 1
      }
    ],
    missions: [
      {
        missionId: 'mission-old',
        title: 'Old mission',
        status: 'completed',
        updatedAt: 100
      },
      {
        missionId: 'mission-active',
        title: 'Active mission',
        status: 'active',
        updatedAt: 50
      },
      {
        missionId: 'mission-new',
        title: 'New mission',
        status: 'failed',
        updatedAt: 300
      }
    ],
    runs: [
      {
        runId: 'run-success',
        threadId: 'thread-a',
        providerId: 'codex',
        providerOutcome: 'completed'
      }
    ],
    rounds: [
      {
        roundId: 'round-complete',
        threadId: 'thread-z',
        status: 'completed',
        endedAt: 500,
        routing: {
          mode: 'turn_bound',
          fanout: 'serial',
          bossParticipantId: 'participant-0',
          captainParticipantId: 'participant-1'
        },
        participantIds: [],
        providerRunIds: []
      },
      {
        roundId: 'round-running',
        threadId: 'thread-a',
        status: 'running',
        startedAt: 100,
        routing: {
          mode: 'continuous',
          fanout: 'parallel',
          bossParticipantId: 'participant-15',
          captainParticipantId: 'participant-16'
        },
        participantIds: ['participant-15'],
        providerRunIds: ['run-success']
      }
    ],
    participants: Array.from({ length: 30 }, (_, index) => {
      const firstGroup = index < 15
      return {
        id: `participant-${index}`,
        threadId: firstGroup ? 'thread-z' : 'thread-a',
        providerId: index % 2 === 0 ? 'codex' : 'claude',
        role: `Seat ${index}`,
        modelId: index % 2 === 0 ? 'gpt-5.6-sol' : 'claude-opus-5',
        reasoningEffort: index % 2 === 0 ? 'xhigh' : 'high',
        permissionPresetId: index % 2 === 0 ? 'workspace_write' : 'full_access',
        stage:
          index === 2
            ? ('any' as const)
            : index % 3 === 0
              ? ('reviewer' as const)
              : ('worker' as const),
        order: firstGroup ? index : index - 15,
        enabled: index !== 29,
        status: index === 0 ? 'working' : 'idle',
        active: index === 0
      }
    })
  })
}

describe('projectHostMissionControl', () => {
  it('matches iOS ordering and keeps all 30 participants visible by thread', () => {
    const model = projectHostMissionControl(stateFromSnapshot(missionFixture()))

    expect(model.missions.map((mission) => mission.missionId)).toEqual([
      'mission-active',
      'mission-new',
      'mission-old'
    ])
    expect(model.rounds.map((round) => round.roundId)).toEqual(['round-running', 'round-complete'])
    expect(model.activeMissionCount).toBe(1)
    expect(model.participantCount).toBe(30)
    expect(model.participantGroups.map((group) => group.title)).toEqual([
      'Alpha thread',
      'Zeta thread'
    ])
    expect(model.participantGroups.every((group) => group.participants.length === 15)).toBe(true)
    expect(
      model.participantGroups[0]?.participants.map((participant) => participant.order)
    ).toEqual(Array.from({ length: 15 }, (_, index) => index))
  })

  it('distinguishes offline cache, unavailable, and pre-fetch states', () => {
    const projection = projectHostSnapshot(missionFixture(), 'cached')
    expect(projectHostMissionControl({ status: 'unavailable', projection }).phase).toBe(
      'Offline cache'
    )
    expect(projectHostMissionControl({ status: 'unavailable' }).phase).toBe('Unavailable')
    expect(projectHostMissionControl({ status: 'loading' }).phase).toBe('Checking')
    expect(projectHostMissionControl({ status: 'idle' }).phase).toBe('Not checked')
  })

  it('keeps the newest ten resolved question receipts and excludes open questions', () => {
    const source = missionFixture()
    source.questions = [
      {
        questionId: 'question-open',
        threadId: 'thread-a',
        status: 'open',
        promptPreview: 'Still waiting?',
        askedAt: 1,
        receiptId: 'receipt-should-not-render'
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        questionId: `question-${index}`,
        threadId: 'thread-a',
        status: index % 2 === 0 ? ('answered' as const) : ('dismissed' as const),
        promptPreview: `Question ${index}?`,
        askedAt: index,
        answeredAt: index,
        receiptId: `receipt-${index}`
      }))
    ]

    const model = projectHostMissionControl(stateFromSnapshot(source))
    expect(model.questionReceipts).toHaveLength(10)
    expect(model.questionReceipts.map((question) => question.questionId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `question-${11 - index}`)
    )
  })
})

describe('HostMissionControl', () => {
  it('renders the current control layout as an always-open Thread Home pane', () => {
    const state = stateFromSnapshot(missionFixture())
    const model = projectHostMissionControl(state)
    const markup = renderToStaticMarkup(
      <HostMissionControl
        state={state}
        presentation="pane"
        lifecycleControl={{
          note: 'Runs only while TaskWraith is open',
          stateLabel: 'Running in this app',
          action: 'stop',
          actionLabel: 'Stop Host',
          disabled: false
        }}
        providers={{ known: true, available: 9, total: 9, label: '9 of 9 configured' }}
        onLifecycleAction={vi.fn()}
      />
    )

    expect(formatHostMissionControlSummary(model)).toBe('1 active · 30 participants')
    expect(markup).toContain('host-mission-control--pane')
    expect(markup).toContain('aria-label="Mission Control, 1 active · 30 participants"')
    expect(markup).toContain('aria-label="Mission Control overview"')
    expect(markup).not.toContain('<span class="host-mission-control-cursor">')
    expect(markup).toContain('aria-label="TaskWraith Host control"')
    expect(markup).toContain('Running in this app')
    expect(markup).toContain('Stop Host')
    expect(markup).toContain('<strong>9 of 9</strong>')
    expect(markup).toContain('Providers configured')
    expect(markup).not.toContain('Host approvals')
    expect(markup).toContain('<span>Active missions</span>')
    expect(markup).toContain('<span>Running rounds</span>')
    expect(markup).toContain('<span>Active seats</span>')
    expect(markup).toContain('Mission timeline')
    expect(markup).toContain('id="host-rosters-title">Rosters</h3>')
    expect(markup).toContain('2 threads · 30 seats')
    expect(markup).toContain('aria-label="Alpha thread roster, 15 seats, 0 active"')
    expect(markup).toContain('aria-label="Zeta thread roster, 15 seats, 1 active"')
    expect(markup).toContain('State &amp; control')
    expect(markup).toContain('Extra High')
    expect(markup).toContain('Full WS Access')
    expect(markup).toContain('Full Access')
    expect(markup).toContain('title="Boss"')
    expect(markup).toContain('title="Captain"')
    expect(markup).toContain('title="Reviewer"')
    expect(markup).toContain('title="Seat 2"><strong>#3 Seat 2</strong>')
    expect(markup).toContain('open=""><summary aria-label="Zeta thread roster, 15 seats, 1 active"')
    expect(markup).not.toContain(
      'open=""><summary aria-label="Alpha thread roster, 15 seats, 0 active"'
    )
    expect(markup).toContain('<section class="host-mission-control host-mission-control--pane"')
    expect(markup).not.toContain(
      '<summary aria-label="Mission Control, 1 active · 30 participants"'
    )
  })

  it('shows recent rosters first and bounds the initial fleet inventory', () => {
    const rosterCount = HOST_MISSION_CONTROL_ROSTER_PREVIEW_LIMIT + 2
    const source = snapshot({
      threads: Array.from({ length: rosterCount }, (_, index) => ({
        id: `thread-${index}`,
        workspaceId: null,
        title: `Roster ${index}`,
        chatKind: 'ensemble' as const,
        archived: false,
        pinned: false,
        updatedAt: index,
        messageCount: 1
      })),
      participants: Array.from({ length: rosterCount }, (_, index) => ({
        id: `participant-${index}`,
        threadId: `thread-${index}`,
        providerId: 'codex',
        role: `Seat ${index}`,
        order: 0,
        enabled: true,
        active: false
      }))
    })

    const markup = renderToStaticMarkup(
      <HostMissionControl state={stateFromSnapshot(source)} presentation="pane" />
    )

    expect(HOST_MISSION_CONTROL_ROSTER_PREVIEW_LIMIT).toBe(12)
    expect(markup).toContain('Show 2 more rosters')
    expect(markup).toContain(`Roster ${rosterCount - 1}`)
    expect(markup).not.toContain('aria-label="Roster 0 roster')
  })

  it('renders generation/cursor, mission and round timelines, outcomes, and every seat', () => {
    const markup = renderToStaticMarkup(
      <HostMissionControl state={stateFromSnapshot(missionFixture())} />
    )

    expect(markup).toContain('Mission Control')
    expect(markup).toContain('Generation 4 · Cursor 12')
    expect(markup).toContain('Active mission')
    expect(markup).toContain('Round timeline')
    expect(markup).toContain('continuous · parallel')
    expect(markup).toContain('codex: completed')
    for (let index = 0; index < 30; index += 1) {
      expect(markup).toContain(`Seat ${index}`)
    }
    expect(markup).toContain('Seat 29, claude, idle, disabled')
  })

  it('keeps provider, round, mission, and connection outcomes visibly distinct', () => {
    const source = missionFixture()
    source.missions = [
      {
        missionId: 'mission-distinct',
        title: 'Outcome layers',
        status: 'blocked',
        updatedAt: 1
      }
    ]
    source.rounds = [
      {
        roundId: 'round-distinct',
        threadId: 'thread-a',
        status: 'cancelled',
        participantIds: [],
        providerRunIds: ['run-success']
      }
    ]
    const state = stateFromSnapshot(source)
    const markup = renderToStaticMarkup(<HostMissionControl state={state} />)

    expect(markup).toContain('Live')
    expect(markup).toContain('blocked')
    expect(markup).toContain('cancelled · 0 seats')
    expect(markup).toContain('codex: completed')
  })

  it('shows the exact resolved-question receipt without exposing an answer body', () => {
    const source = missionFixture()
    source.questions = [
      {
        questionId: 'question-receipt',
        threadId: 'thread-a',
        status: 'answered',
        promptPreview: 'Which route?',
        askedAt: 100,
        answeredAt: 200,
        receiptId: '11111111-1111-4111-8111-111111111111',
        answer: 'PRIVATE ANSWER BODY'
      } as never
    ]

    const markup = renderToStaticMarkup(<HostMissionControl state={stateFromSnapshot(source)} />)

    expect(markup).toContain('Recent question receipts')
    expect(markup).toContain('Which route?')
    expect(markup).toContain('Receipt 11111111-1111-4111-8111-111111111111')
    expect(markup).not.toContain('PRIVATE ANSWER BODY')
  })

  it('renders an honest unavailable state without fabricating an empty mission world', () => {
    const markup = renderToStaticMarkup(<HostMissionControl state={{ status: 'unavailable' }} />)

    expect(markup).toContain('Unavailable')
    expect(markup).toContain('No coherent Host projection is available.')
    expect(markup).not.toContain('No Host missions yet.')
  })

  it('renders governed cancel and seat controls from the live Host projection', () => {
    const source = missionFixture()
    source.runs = [
      {
        runId: 'run-active',
        threadId: 'thread-a',
        providerId: 'codex',
        providerOutcome: 'running'
      }
    ]
    const terminal: HostCommandRunOutcome = {
      kind: 'terminal',
      receipt: {} as never,
      description: { text: 'Host accepted run.cancel', tone: 'good' }
    }
    const commands = new HostCommandController({
      client: {
        submitAndResolve: vi.fn(async () => terminal),
        decideApproval: vi.fn(async () => terminal)
      }
    })

    const markup = renderToStaticMarkup(
      <HostMissionControl state={stateFromSnapshot(source)} commands={commands} />
    )

    expect(markup).toContain('Governed actions')
    expect(markup).toContain('Cancel run')
    expect(markup).toContain('Disable')
    expect(markup).toContain('Enable')
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Cancel run<\/button>/)
  })

  it('renders compact Channel lifecycle and governed owner controls', () => {
    const source = missionFixture()
    source.channels = [
      {
        channelId: 'channel-a',
        threadId: 'thread-a',
        ownerMemberId: 'owner-a',
        title: 'Shared work',
        status: 'active',
        availability: 'ready',
        membershipRevision: 2,
        memberCount: 2,
        messageCount: 3,
        updatedAt: 4,
        members: [
          { memberId: 'owner-a', kind: 'human', displayName: 'Owner', status: 'active' },
          { memberId: 'member-a', kind: 'human', displayName: 'Alex', status: 'active' },
          { memberId: 'agent-a', kind: 'agent', displayName: 'Worker', status: 'active' }
        ]
      }
    ]
    const commands = new HostCommandController({
      client: { submitAndResolve: vi.fn(), decideApproval: vi.fn() }
    })

    const state = stateFromSnapshot(source)
    expect(projectHostMissionControl(state).channels).toHaveLength(1)
    const markup = renderToStaticMarkup(<HostMissionControl state={state} commands={commands} />)
    expect(markup).toContain('Channels')
    expect(markup).toContain('Shared work')
    expect(markup).toContain('2 members · 3 messages')
    expect(markup).toContain('Revoke Alex')
    expect(markup).toContain('Close Channel')
    expect(markup).not.toContain('Revoke Worker')
  })

  it('disables governed mutations when the projection is cached', () => {
    const source = missionFixture()
    source.runs = [
      {
        runId: 'run-active',
        threadId: 'thread-a',
        providerId: 'codex',
        providerOutcome: 'running'
      }
    ]
    const commands = new HostCommandController({
      client: {
        submitAndResolve: vi.fn(),
        decideApproval: vi.fn()
      }
    })
    const projection = projectHostSnapshot(source, 'cached')

    const markup = renderToStaticMarkup(
      <HostMissionControl state={{ status: 'unavailable', projection }} commands={commands} />
    )

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Cancel run<\/button>/)
  })
})
