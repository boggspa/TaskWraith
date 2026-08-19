import { describe, expect, it } from 'vitest'
import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  ToolActivity,
  ToolActivityDetailRef
} from '../../../main/store/types'
import { TASKWRAITH_CLOSEOUT_KIND } from '../../../shared/taskWraithCloseout'
import {
  findCloseoutCommitRepairTargets,
  repairCloseoutCommitTombstones
} from './closeoutCommitRepair'

const ROUND_ID = 'ensemble-1787089683377-36ykn4vtft3'
const RUN_ID = 'claude-1787092447124'

function detailRef(activityId: string): ToolActivityDetailRef {
  return {
    schemaVersion: 1,
    storage: 'run_event_artifact',
    runId: RUN_ID,
    activityId,
    offset: 0,
    byteLength: 2048,
    sha256: 'c'.repeat(64)
  }
}

function strippedCommitActivity(id: string): ToolActivity {
  return {
    id,
    toolName: 'mcp__TaskWraith__git_commit',
    displayName: 'git_commit',
    category: 'write',
    status: 'success',
    endedAt: '2026-08-18T22:44:35.000Z',
    detailRef: detailRef(id)
  }
}

function chipTownChat(): ChatRecord {
  const run: ChatRun = {
    runId: RUN_ID,
    provider: 'claude',
    startedAt: '2026-08-18T22:40:00.000Z',
    endedAt: '2026-08-18T22:45:00.000Z',
    status: 'success',
    ensembleRoundId: ROUND_ID
  }
  const toolMessage: ChatMessage = {
    id: 'tool-message',
    role: 'tool',
    content: '',
    timestamp: '2026-08-18T22:44:35.000Z',
    runId: RUN_ID,
    metadata: { ensembleRoundId: ROUND_ID, ensembleParticipantId: 'participant-7' },
    toolActivities: [strippedCommitActivity('commit-activity')]
  }
  const closeout: ChatMessage = {
    id: `taskwraith-closeout-round-${ROUND_ID}`,
    role: 'system',
    content: 'Worked for 1 hour 41 minutes',
    timestamp: '2026-08-18T23:29:21.409Z',
    metadata: {
      kind: TASKWRAITH_CLOSEOUT_KIND,
      closeoutScope: 'ensembleRound',
      closeoutRoundId: ROUND_ID,
      closeoutStatus: 'cancelled',
      closeoutReceipt: {
        version: 1,
        targetId: ROUND_ID,
        scope: 'ensembleRound',
        status: 'cancelled',
        observedCommitCount: 0,
        observedChangedFileCount: 9
      }
    }
  }
  return {
    appChatId: 'chiptown',
    title: 'ChipTown',
    provider: 'claude',
    scope: 'workspace',
    chatKind: 'ensemble',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 2,
    messages: [toolMessage, closeout],
    runs: [run],
    ensemble: {
      participants: [
        { id: 'participant-7', provider: 'claude', model: 'claude-opus-5', role: 'Work4', order: 9 }
      ]
    }
  } as unknown as ChatRecord
}

describe('findCloseoutCommitRepairTargets', () => {
  it('targets commit-less close-outs whose scope holds stripped git_commit activities', () => {
    const targets = findCloseoutCommitRepairTargets(chipTownChat())
    expect(targets).toEqual([
      {
        closeoutMessageId: `taskwraith-closeout-round-${ROUND_ID}`,
        refs: [detailRef('commit-activity')]
      }
    ])
  })

  it('skips close-outs that already carry commit tombstones', () => {
    const chat = chipTownChat()
    chat.messages[1].metadata!.closeoutCommits = [{ hash: 'a048ce5' }]
    expect(findCloseoutCommitRepairTargets(chat)).toEqual([])
  })

  it('skips stripped shell activities with no surviving git-commit hint', () => {
    const chat = chipTownChat()
    chat.messages[0].toolActivities = [
      {
        id: 'shell-noise',
        toolName: 'run_shell_command',
        displayName: 'Ran command',
        category: 'shell',
        status: 'success',
        detailRef: detailRef('shell-noise')
      }
    ]
    expect(findCloseoutCommitRepairTargets(chat)).toEqual([])
  })
})

describe('repairCloseoutCommitTombstones', () => {
  it('rebuilds commit tombstones from hydrated archive detail', () => {
    const chat = chipTownChat()
    const repaired = repairCloseoutCommitTombstones(chat, [
      {
        ref: detailRef('commit-activity'),
        activity: {
          ...strippedCommitActivity('commit-activity'),
          detailRef: undefined,
          outputPreview:
            '[main a048ce5] feat: ChipTown interiors (lab + mart)\n 2 files changed, 212 insertions(+), 157 deletions(-)'
        } as ToolActivity
      }
    ])

    expect(repaired).not.toBeNull()
    const closeout = repaired!.messages.find((message) =>
      message.id.startsWith('taskwraith-closeout-round-')
    )
    expect(closeout?.metadata?.closeoutCommits).toMatchObject([
      {
        hash: 'a048ce5',
        subject: 'feat: ChipTown interiors (lab + mart)',
        stats: '2 files, +212 −157',
        participantId: 'participant-7'
      }
    ])
    expect(closeout?.metadata?.closeoutCommits?.[0].seatLink).toMatchObject({
      participantId: 'participant-7'
    })
    expect(closeout?.metadata?.closeoutReceipt).toMatchObject({ observedCommitCount: 1 })
    // The transcript record itself stays stripped — repair only writes tombstones.
    const toolMessage = repaired!.messages.find((message) => message.id === 'tool-message')
    expect(toolMessage?.toolActivities?.[0].outputPreview).toBeUndefined()
    // Input chat untouched.
    expect(chat.messages[1].metadata?.closeoutCommits).toBeUndefined()
  })

  it('returns null when hydration surfaces no commits', () => {
    const chat = chipTownChat()
    const repaired = repairCloseoutCommitTombstones(chat, [
      {
        ref: detailRef('commit-activity'),
        activity: {
          ...strippedCommitActivity('commit-activity'),
          detailRef: undefined,
          outputPreview: 'nothing to commit, working tree clean'
        } as ToolActivity
      }
    ])
    expect(repaired).toBeNull()
  })
})
