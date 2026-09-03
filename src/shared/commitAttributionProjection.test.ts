import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord, ToolActivity } from '../main/store/types'
import {
  commitAttributionActivityKind,
  projectChatForCommitAttribution
} from './commitAttributionProjection'

function activity(partial: Partial<ToolActivity>): ToolActivity {
  return {
    id: partial.id || 'activity-1',
    toolName: partial.toolName || 'Read',
    displayName: partial.displayName || 'Read',
    category: partial.category || 'read',
    status: partial.status || 'success',
    ...partial
  } as ToolActivity
}

function message(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: partial.id || 'message-1',
    role: partial.role || 'assistant',
    content: partial.content ?? '',
    timestamp: '2026-09-03T00:00:00.000Z',
    ...partial
  } as ChatMessage
}

function chat(messages: ChatMessage[], partial: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id: 'chat-1',
    appChatId: 'chat-1',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    updatedAt: 1,
    providerMetadata: {},
    messages,
    ...partial
  } as unknown as ChatRecord
}

const commitReceipt = activity({
  id: 'commit-activity',
  toolName: 'git_commit',
  displayName: 'git_commit',
  category: 'task',
  resultSummary: '[master 1ebbc82fc] feat(composer): pick a branch\n 4 files changed'
})

describe('commitAttributionActivityKind', () => {
  it('claims dedicated git commit tools, shell tools, and nothing else', () => {
    expect(commitAttributionActivityKind(commitReceipt)).toBe('dedicated')
    expect(commitAttributionActivityKind(activity({ category: 'shell' }))).toBe('shell')
    expect(commitAttributionActivityKind(activity({ toolName: 'run_shell_command' }))).toBe('shell')
    expect(commitAttributionActivityKind(activity({ toolName: 'Read' }))).toBeNull()
  })
})

describe('projectChatForCommitAttribution', () => {
  it('drops a chat that carries no commit evidence at all', () => {
    const transcript = chat([
      message({ id: 'chatter', content: 'no commits here' }),
      message({ id: 'read', toolActivities: [activity({ toolName: 'Read' })] })
    ])

    expect(projectChatForCommitAttribution(transcript)).toBeNull()
  })

  it('keeps only the messages carrying a commit receipt', () => {
    const projected = projectChatForCommitAttribution(
      chat([
        message({ id: 'chatter', content: 'a'.repeat(5000) }),
        message({ id: 'committed', toolActivities: [commitReceipt] }),
        message({
          id: 'closeout',
          metadata: { closeoutCommits: [{ hash: 'abc1234' }] }
        } as Partial<ChatMessage>)
      ])
    )

    expect(projected?.messages.map((entry) => entry.id)).toEqual(['committed', 'closeout'])
  })

  it('strips the non-commit tool activities from a message it keeps', () => {
    const projected = projectChatForCommitAttribution(
      chat([
        message({
          id: 'committed',
          toolActivities: [
            activity({ id: 'read', toolName: 'Read' }),
            commitReceipt,
            activity({ id: 'search', toolName: 'Grep', category: 'search' })
          ]
        })
      ])
    )

    expect(projected?.messages[0]?.toolActivities?.map((entry) => entry.id)).toEqual([
      'commit-activity'
    ])
  })

  it('preserves the fields a seat is resolved from', () => {
    const source = chat([message({ id: 'committed', toolActivities: [commitReceipt] })], {
      ensemble: { participants: [{ id: 'seat-1', provider: 'codex', model: 'gpt-5.6' }] },
      runs: [{ runId: 'run-1', effectiveWorkspacePath: '/repo/worktree' }],
      threadWorktreeBinding: { effectiveWorkspacePath: '/repo/bound' }
    } as unknown as Partial<ChatRecord>)

    const projected = projectChatForCommitAttribution(source)

    expect(projected?.ensemble).toEqual(source.ensemble)
    expect(projected?.runs).toEqual(source.runs)
    expect(projected?.threadWorktreeBinding).toEqual(source.threadWorktreeBinding)
    expect(projected?.workspacePath).toBe('/repo')
  })
})
