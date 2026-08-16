import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ChatMessage,
  ChatRecord,
  WorkspaceBoardCard,
  WorkspaceBoardDefinition
} from '../store/types'
import { MissionFactLedgerRepository } from './MissionFactLedger'
import { MissionFactShadowService } from './MissionFactShadowService'

const CREATED_AT = '2026-08-16T00:00:00.000Z'

function proposedPlanMessage(
  overrides: Partial<ChatMessage> & { status?: 'pending' | 'approved' | 'dismissed' } = {}
): ChatMessage {
  const { status = 'pending', ...messageOverrides } = overrides
  return {
    id: 'plan-message-1',
    role: 'assistant',
    content: 'Plan ready.',
    timestamp: '2026-08-16T00:00:02.000Z',
    runId: 'run-plan',
    metadata: {
      ensembleParticipantId: 'boss',
      ensembleRoundId: 'round-1',
      proposedPlan: {
        title: 'Mission plan',
        body: '1. Build the kernel\n2. Wire shadow writes',
        status
      }
    },
    ...messageOverrides
  }
}

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    chatKind: 'ensemble',
    provider: 'codex',
    title: 'Mission',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: Date.parse(CREATED_AT),
    updatedAt: Date.parse(CREATED_AT),
    archived: false,
    activeGoal: {
      id: 'goal-1',
      objective: 'Ship the mission ledger',
      objectiveSource: 'user',
      status: 'active',
      mode: 'taskwraith_steered',
      provider: 'codex',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT
    },
    messages: [proposedPlanMessage()],
    runs: [
      {
        runId: 'run-plan',
        provider: 'codex',
        startedAt: Date.parse(CREATED_AT),
        status: 'completed',
        ensembleParticipantId: 'boss',
        ensembleRoundId: 'round-1'
      }
    ],
    ...overrides
  } as ChatRecord
}

function board(overrides: Partial<WorkspaceBoardDefinition> = {}): WorkspaceBoardDefinition {
  return {
    id: 'board-1',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    name: 'Mission board',
    columns: [],
    createdAt: CREATED_AT,
    updatedAt: '2026-08-16T00:01:00.000Z',
    activity: [],
    ...overrides
  }
}

function card(overrides: Partial<WorkspaceBoardCard> = {}): WorkspaceBoardCard {
  return {
    id: 'card-1',
    boardId: 'board-1',
    workspaceId: 'workspace-1',
    columnId: 'running',
    title: 'Wire the shadow writer',
    body: 'Keep legacy reads unchanged.',
    sortOrder: 1,
    link: { kind: 'chat', id: 'chat-1' },
    createdAt: '2026-08-16T00:01:00.000Z',
    updatedAt: '2026-08-16T00:01:00.000Z',
    activity: [],
    ...overrides
  }
}

describe('MissionFactShadowService', () => {
  let tempPath: string
  let repository: MissionFactLedgerRepository
  let service: MissionFactShadowService

  beforeEach(() => {
    tempPath = mkdtempSync(join(tmpdir(), 'mission-shadow-service-'))
    repository = new MissionFactLedgerRepository({ rootPath: join(tempPath, 'facts') })
    service = new MissionFactShadowService(repository)
  })

  afterEach(() => {
    rmSync(tempPath, { recursive: true, force: true })
  })

  it('shadows Goal and Plan once with field-specific provenance', () => {
    const first = service.observeChat(chat())

    expect(first).toMatchObject({
      missionId: 'goal-1',
      surface: 'chat',
      appendedKinds: ['mission_defined', 'mission_status_set', 'plan_set'],
      lastSequence: 3
    })
    const replay = repository.read('goal-1')
    expect(replay.projection).toMatchObject({
      objective: 'Ship the mission ledger',
      status: 'active',
      plan: { planId: 'plan-message-1', status: 'pending' }
    })
    expect(replay.records.map((record) => record.provenance.actor)).toEqual([
      'user',
      'system',
      'agent'
    ])
    expect(replay.records[2].provenance).toMatchObject({
      runId: 'run-plan',
      participantId: 'boss',
      roundId: 'round-1',
      provider: 'codex'
    })

    expect(service.observeChat(chat()).appendedKinds).toEqual([])
    expect(repository.read('goal-1').records).toHaveLength(3)
  })

  it('records only later status and plan decisions and attributes a decision to the user', () => {
    const source = chat()
    service.observeChat(source)
    const changed = chat({
      activeGoal: {
        ...source.activeGoal!,
        status: 'blocked',
        blockedReason: 'Waiting for review.',
        updatedAt: '2026-08-16T00:02:00.000Z'
      },
      messages: [proposedPlanMessage({ status: 'approved', timestamp: '2026-08-16T00:02:01.000Z' })]
    })

    const report = service.observeChat(changed)

    expect(report.appendedKinds).toEqual(['mission_status_set', 'plan_set'])
    const replay = repository.read('goal-1')
    expect(replay.projection).toMatchObject({
      status: 'blocked',
      statusReason: 'Waiting for review.',
      plan: { status: 'approved' }
    })
    expect(replay.records.at(-1)?.provenance.actor).toBe('user')
  })

  it('does not attach a proposed plan that predates the current goal identity', () => {
    const source = chat({
      activeGoal: {
        ...chat().activeGoal!,
        createdAt: '2026-08-16T01:00:00.000Z',
        updatedAt: '2026-08-16T01:00:00.000Z'
      }
    })

    expect(service.observeChat(source).appendedKinds).toEqual([
      'mission_defined',
      'mission_status_set'
    ])
    expect(repository.read('goal-1').projection?.plan).toBeUndefined()
  })

  it('closes the prior mission when the legacy active goal is cleared', () => {
    const previous = chat({ messages: [] })
    service.observeChat(previous)
    const next = chat({
      activeGoal: undefined,
      messages: [],
      updatedAt: Date.parse('2026-08-16T00:03:00.000Z')
    })

    const reports = service.observeChatTransition(previous, next)

    expect(reports[0].appendedKinds).toEqual(['mission_status_set'])
    expect(reports[1].skippedReason).toBe('no-active-goal')
    expect(repository.read('goal-1').projection).toMatchObject({
      status: 'cancelled',
      statusReason: 'Legacy active goal was cleared or replaced.'
    })
  })

  it('bootstraps a linked chat, then upserts and tombstones its board card', () => {
    const linkedChat = chat({ messages: [] })
    const resolveChatById = (chatId: string) => (chatId === 'chat-1' ? linkedChat : null)
    const initialCard = card()

    const [created] = service.observeWorkspaceBoard({
      board: board(),
      cards: [initialCard],
      resolveChatById
    })
    expect(created.appendedKinds).toEqual(['work_item_upserted'])
    expect(repository.read('goal-1').projection).toMatchObject({
      lastSequence: 3,
      workItems: [{ workItemId: 'card-1', status: 'running' }]
    })

    const updatedCard = card({
      columnId: 'done',
      updatedAt: '2026-08-16T00:02:00.000Z',
      provenance: {
        actor: 'agent',
        sourceKind: 'thread',
        sourceId: 'chat-1',
        at: '2026-08-16T00:02:00.000Z',
        runId: 'run-board'
      }
    })
    const [updated] = service.observeWorkspaceBoard({
      board: board(),
      cards: [updatedCard],
      resolveChatById
    })
    expect(updated.appendedKinds).toEqual(['work_item_upserted'])
    expect(repository.read('goal-1').records.at(-1)?.provenance).toMatchObject({
      actor: 'agent',
      runId: 'run-board'
    })

    const [removed] = service.observeWorkspaceBoard({
      board: board({ updatedAt: '2026-08-16T00:03:00.000Z' }),
      cards: [],
      removedCards: [updatedCard],
      resolveChatById
    })
    expect(removed.appendedKinds).toEqual(['work_item_removed'])
    expect(repository.read('goal-1').projection?.workItems).toEqual([])
  })

  it('moves board-owned work items when board goal provenance changes', () => {
    const secondChat = chat({
      appChatId: 'chat-2',
      activeGoal: {
        ...chat().activeGoal!,
        id: 'goal-2',
        objective: 'Ship the second mission'
      },
      messages: []
    })
    service.observeChat(chat({ messages: [] }))
    service.observeChat(secondChat)
    const priorBoard = board({
      provenance: {
        actor: 'user',
        sourceKind: 'goal',
        sourceId: 'goal-1',
        at: '2026-08-16T00:01:00.000Z'
      }
    })
    const unlinkedCard = card({ link: undefined })
    service.observeWorkspaceBoard({
      board: priorBoard,
      cards: [unlinkedCard],
      resolveChatById: () => null
    })

    const reports = service.observeWorkspaceBoard({
      board: board({
        updatedAt: '2026-08-16T00:02:00.000Z',
        provenance: {
          actor: 'user',
          sourceKind: 'goal',
          sourceId: 'goal-2',
          at: '2026-08-16T00:02:00.000Z'
        }
      }),
      previousBoard: priorBoard,
      cards: [unlinkedCard],
      resolveChatById: () => null
    })

    expect(reports.map((report) => [report.missionId, report.appendedKinds])).toEqual([
      ['goal-1', ['work_item_removed']],
      ['goal-2', ['work_item_upserted']]
    ])
    expect(repository.read('goal-1').projection?.workItems).toEqual([])
    expect(repository.read('goal-2').projection?.workItems).toMatchObject([
      { workItemId: 'card-1' }
    ])
  })

  it('does not guess a mission for an uncorrelated board card', () => {
    const [report] = service.observeWorkspaceBoard({
      board: board(),
      cards: [card({ link: undefined })],
      resolveChatById: () => null
    })

    expect(report.skippedReason).toBe('uncorrelated-board')
    expect(report.appendedKinds).toEqual([])
  })
})
