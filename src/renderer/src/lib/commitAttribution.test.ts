import { describe, expect, it } from 'vitest'
import type { ChatRecord, ChatMessage } from '../../../main/store/types'
import type { SeatChangeLink } from '../../../shared/seatChange'
import {
  collectTaskWraithCommitAttributions,
  loadWorkspaceTaskWraithCommitAttributions,
  resolveTaskWraithCommitAttribution
} from './commitAttribution'
import { projectChatForCommitAttribution } from '../../../shared/commitAttributionProjection'

const seatLink: SeatChangeLink = {
  participantId: 'seat-1',
  before: {
    provider: 'codex',
    model: 'gpt-5.6',
    role: 'Work1',
    seatNumber: 4
  },
  after: {
    provider: 'codex',
    model: 'gpt-5.6',
    role: 'Work1',
    seatNumber: 4
  }
}

function chat(
  messages: ChatMessage[],
  options: { id?: string; workspaceId?: string } = {}
): ChatRecord {
  const id = options.id || 'chat-1'
  return {
    id,
    appChatId: id,
    workspaceId: options.workspaceId || 'workspace-1',
    providerMetadata: {},
    messages
  } as unknown as ChatRecord
}

describe('commitAttribution', () => {
  it('collects durable TaskWraith seat evidence and ignores generic commits', () => {
    const attributions = collectTaskWraithCommitAttributions([
      chat([
        {
          id: 'closeout',
          role: 'assistant',
          content: 'Task complete',
          timestamp: new Date().toISOString(),
          metadata: {
            closeoutCommits: [
              { hash: 'abc1234', seatLink, participantId: 'seat-1' },
              { hash: 'def5678' }
            ]
          }
        } as ChatMessage
      ])
    ])

    expect(Array.from(attributions)).toEqual([
      [
        'abc1234',
        {
          hash: 'abc1234',
          seatLink,
          participantId: 'seat-1'
        }
      ]
    ])
  })

  it('resolves abbreviated receipts against a full commit hash', () => {
    const attributions = new Map([
      ['abc1234', { hash: 'abc1234', seatLink }],
      ['abc123456', { hash: 'abc123456', seatLink }]
    ])

    expect(
      resolveTaskWraithCommitAttribution(attributions, 'abc1234567890abcdef1234567890abcdef12345')
        ?.hash
    ).toBe('abc123456')
    expect(
      resolveTaskWraithCommitAttribution(attributions, 'ffffffffffffffffffffffffffffffffffffffff')
    ).toBeNull()
  })

  it('loads seat evidence from inactive threads in the same workspace', async () => {
    const inactiveThread = chat(
      [
        {
          id: 'inactive-closeout',
          role: 'assistant',
          content: 'Task complete',
          timestamp: new Date().toISOString(),
          metadata: {
            closeoutCommits: [{ hash: 'fedcba987', seatLink, participantId: 'seat-1' }]
          }
        } as ChatMessage
      ],
      { id: 'chat-inactive', workspaceId: 'workspace-1' }
    )
    const unrelatedThread = chat(
      [
        {
          id: 'unrelated-closeout',
          role: 'assistant',
          content: 'Task complete',
          timestamp: new Date().toISOString(),
          metadata: {
            closeoutCommits: [{ hash: '012345678', seatLink, participantId: 'seat-1' }]
          }
        } as ChatMessage
      ],
      { id: 'chat-unrelated', workspaceId: 'workspace-2' }
    )
    const inactiveSummary = {
      ...inactiveThread,
      messages: [],
      summaryOnly: true
    } as unknown as ChatRecord

    const attributions = await loadWorkspaceTaskWraithCommitAttributions({
      chats: [chat([], { id: 'chat-active', workspaceId: 'workspace-1' }), inactiveSummary],
      workspaceId: 'workspace-1',
      loadWorkspaceChats: async (workspaceId) => {
        expect(workspaceId).toBe('workspace-1')
        return [inactiveThread, unrelatedThread]
      }
    })

    expect(
      resolveTaskWraithCommitAttribution(attributions, 'fedcba9876543210fedcba9876543210fedcba98')
    ).toEqual({ hash: 'fedcba987', seatLink, participantId: 'seat-1' })
    expect(
      resolveTaskWraithCommitAttribution(attributions, '0123456789abcdef0123456789abcdef01234567')
    ).toBeNull()
  })

  it('attributes a seat identically from a transcript-reduced projection', () => {
    // The Commits inspector no longer receives whole transcripts: main sends
    // the same record with every non-commit message and tool activity removed.
    // The seat a human reads in the Attribution column must not change.
    const committed = {
      id: 'committed',
      role: 'assistant',
      content: 'Committed the composer change',
      timestamp: new Date().toISOString(),
      runId: 'run-1',
      metadata: { ensembleParticipantId: 'seat-1' },
      toolActivities: [
        {
          id: 'read-activity',
          toolName: 'Read',
          displayName: 'Read',
          category: 'read',
          status: 'success',
          resultSummary: 'a'.repeat(5000)
        },
        {
          id: 'commit-activity',
          toolName: 'git_commit',
          displayName: 'git_commit',
          category: 'task',
          status: 'success',
          resultSummary: '[master 1ebbc82fc] feat(composer): pick a branch\n 4 files changed'
        }
      ]
    } as unknown as ChatMessage
    const chatter = {
      id: 'chatter',
      role: 'assistant',
      content: 'b'.repeat(20000),
      timestamp: new Date().toISOString()
    } as ChatMessage
    const source = {
      ...chat([chatter, committed]),
      workspacePath: '/repo',
      runs: [{ runId: 'run-1', effectiveWorkspacePath: '/repo' }],
      ensemble: {
        participants: [{ id: 'seat-1', provider: 'codex', model: 'gpt-5.6', role: 'Work1' }]
      }
    } as unknown as ChatRecord

    const fromSource = collectTaskWraithCommitAttributions([source])
    const projection = projectChatForCommitAttribution(source)
    const fromProjection = collectTaskWraithCommitAttributions([projection as ChatRecord])

    // Not vacuous: the seat really is resolved from the receipt.
    expect(fromSource.get('1ebbc82fc')?.seatLink?.participantId).toBe('seat-1')
    expect(Array.from(fromProjection)).toEqual(Array.from(fromSource))
  })
})
