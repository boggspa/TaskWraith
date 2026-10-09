import { describe, expect, it } from 'vitest'
import { recoverEnsembleRoundFromRuns } from './EnsembleRoundRunRecovery'
import { chatHasReconcilableRun, reconcileStaleChatRuns } from './ChatRunReconciler'
import { collectThreadCatalogueRecovery } from './store/ThreadCatalogueRecovery'
import { projectThreadCatalogueRecord } from './store/ThreadCatalogueFromRecord'
import type { ChatRecord } from './store/types'

const AT = '2026-10-09T12:59:21.940Z'

function fixture(): ChatRecord {
  return {
    appChatId: 'review',
    title: 'Release review',
    chatKind: 'ensemble',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    messages: [],
    runs: [
      { runId: 'claude-1', provider: 'claude', status: 'failed', startedAt: AT, endedAt: AT },
      { runId: 'codex-1', provider: 'codex', status: 'failed', startedAt: AT, endedAt: AT },
      { runId: 'pi-1', provider: 'pi', status: 'failed', startedAt: AT, endedAt: AT }
    ],
    ensemble: {
      enabled: true,
      maxParticipants: 3,
      participants: [],
      activeRound: {
        roundId: 'round-1',
        status: 'running',
        prompt: 'Review',
        startedAt: AT,
        queuedPrompts: ['keep this work'],
        participants: [
          {
            participantId: 'claude',
            provider: 'claude',
            role: 'Boss',
            order: 0,
            status: 'running',
            runId: 'claude-1'
          },
          {
            participantId: 'codex',
            provider: 'codex',
            role: 'Captain',
            order: 1,
            status: 'running',
            runId: 'codex-1'
          },
          {
            participantId: 'pi',
            provider: 'pi',
            role: 'Reader',
            order: 2,
            status: 'failed',
            runId: 'pi-1'
          }
        ],
        lanes: {
          one: {
            laneId: 'one',
            participantId: 'claude',
            provider: 'claude',
            runId: 'claude-1',
            status: 'running',
            intent: 'read',
            startedAt: AT,
            approvalsQueued: 1
          },
          two: {
            laneId: 'two',
            participantId: 'codex',
            provider: 'codex',
            runId: 'codex-1',
            status: 'running',
            intent: 'read',
            startedAt: AT,
            approvalsQueued: 0
          }
        },
        turnTransition: {
          phase: 'settling-provider',
          sourceParticipantId: 'pi',
          sourceRunId: 'pi-1',
          runtimeInstanceId: 'dead-process',
          startedAt: AT
        }
      }
    }
  }
}

describe('durable Ensemble restart recovery', () => {
  it('repairs the lanes even when their provider runs were already marked failed', () => {
    const chat = fixture()
    expect(chatHasReconcilableRun(chat)).toBe(true)
    expect(projectThreadCatalogueRecord(chat).recovery.unsettledRuns).toBe(3)
    expect(collectThreadCatalogueRecovery(chat).filter((r) => r.kind === 'run')).toHaveLength(3)
    const result = reconcileStaleChatRuns([chat], () => false, AT)
    expect(result.chats).toHaveLength(1)
    expect(result.settlements).toHaveLength(0)
    const repaired = result.chats[0]
    expect(repaired.messages).toBe(chat.messages)
    expect(repaired.ensemble?.activeRound).toMatchObject({
      status: 'failed',
      turnTransition: undefined,
      queuedPrompts: ['keep this work']
    })
    expect(
      Object.values(repaired.ensemble!.activeRound!.lanes!).every(
        (lane) => lane.status === 'failed' && lane.approvalsQueued === 0
      )
    ).toBe(true)
    expect(projectThreadCatalogueRecord(repaired).recovery.unsettledRuns).toBe(0)
    expect(reconcileStaleChatRuns([repaired], () => false, AT).chats).toHaveLength(0)
  })

  it('retains a lane still owned by a live run or finalizer', () => {
    const chat = fixture()
    const result = recoverEnsembleRoundFromRuns(chat, (id) => id === 'codex-1', AT)
    expect(result.ensemble?.activeRound?.status).toBe('running')
    expect(result.ensemble?.activeRound?.lanes?.two.status).toBe('running')
    expect(result.ensemble?.activeRound?.lanes?.one.status).toBe('failed')
  })

  it('does not turn a missing newer attempt into an old attempt failure', () => {
    const chat = fixture()
    chat.ensemble!.activeRound!.participants[1].runId = 'codex-new'
    chat.ensemble!.activeRound!.lanes!.two.runId = 'codex-new'
    const result = recoverEnsembleRoundFromRuns(chat, () => false, AT)
    expect(result.ensemble?.activeRound?.status).toBe('running')
    expect(result.ensemble?.activeRound?.lanes?.two.status).toBe('running')
  })

  it('preserves an independent pending wakeup', () => {
    const chat = fixture()
    chat.ensemble!.activeRound!.pendingWakeupIds = ['wake-1']
    const result = recoverEnsembleRoundFromRuns(chat, () => false, AT)
    expect(result.ensemble?.activeRound?.status).toBe('running')
    expect(result.ensemble?.activeRound?.pendingWakeupIds).toEqual(['wake-1'])
  })

  it('does not turn a successfully sleeping provider seat into an answered seat', () => {
    const chat = fixture()
    chat.ensemble!.activeRound!.participants[1].status = 'sleeping'
    chat.runs![1].status = 'success'
    chat.runs![1].ensembleParticipantStatus = 'sleeping'
    const result = recoverEnsembleRoundFromRuns(chat, () => false, AT)
    expect(result.ensemble?.activeRound?.participants[1].status).toBe('sleeping')
    expect(result.ensemble?.activeRound?.status).toBe('running')
  })
})
