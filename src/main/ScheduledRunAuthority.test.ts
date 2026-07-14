import { describe, expect, it } from 'vitest'
import type { ChatRecord, ScheduledTask } from './store/types'
import {
  assertRunAgentScheduledAuthority,
  assertScheduledRunAuthority
} from './ScheduledRunAuthority'

const canonicalizePath = (value: string): string => value.replace(/\/$/, '')
const nowMs = Date.parse('2026-07-13T00:00:00.000Z')

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-test-1',
    workspaceId: 'workspace-test-1',
    workspacePath: '/Test 1/',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: 'Test 1',
    messages: [],
    runs: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as ChatRecord
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'scheduled-test-1',
    workspaceId: 'workspace-test-1',
    workspacePath: '/Test 1',
    chatId: 'chat-test-1',
    provider: 'codex',
    prompt: 'Run scheduled work.',
    selectedModelType: 'gpt-5.6-terra',
    customModel: '',
    approvalMode: 'plan',
    sessionTrust: false,
    imageAttachments: [],
    runAt: '2026-07-13T00:00:00.000Z',
    timezone: 'Europe/London',
    status: 'running',
    createdAt: '2026-07-12T23:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    firedAt: '2026-07-13T00:00:00.000Z',
    runningSince: '2026-07-13T00:00:01.000Z',
    runId: 'run-test-1',
    ...overrides
  } as ScheduledTask
}

describe('assertScheduledRunAuthority', () => {
  it('accepts the exact running solo occurrence', () => {
    const scheduled = task()
    expect(
      assertScheduledRunAuthority({
        task: scheduled,
        chat: chat(),
        expectedKind: 'single',
        appRunId: 'run-test-1',
        nowMs,
        canonicalizePath
      })
    ).toBe(scheduled)
  })

  it('accepts an exact running Ensemble occurrence without renderer run routing', () => {
    const scheduled = task({
      kind: 'ensemble',
      ensembleSnapshot: {
        orchestrationMode: 'turn_bound',
        participants: [],
        capturedAt: '2026-07-12T23:00:00.000Z'
      }
    })
    expect(
      assertScheduledRunAuthority({
        task: scheduled,
        chat: chat({ chatKind: 'ensemble', ensemble: { participants: [] } as never }),
        expectedKind: 'ensemble',
        nowMs,
        canonicalizePath
      })
    ).toBe(scheduled)
  })

  it.each([
    ['pending occurrence', task({ status: 'due' })],
    ['terminal occurrence', task({ status: 'completed' })],
    ['missing run receipt', task({ runId: undefined })],
    ['another chat', task({ chatId: 'chat-test-3' })],
    ['another workspace id', task({ workspaceId: 'workspace-test-3' })],
    ['another workspace path', task({ workspacePath: '/Test 3' })]
  ])('rejects %s', (_label, scheduled) => {
    expect(() =>
      assertScheduledRunAuthority({
        task: scheduled,
        chat: chat(),
        expectedKind: 'single',
        appRunId: 'run-test-1',
        canonicalizePath
      })
    ).toThrow('Scheduled occurrence does not match')
  })

  it('rejects another occurrence run id and dispatch kind', () => {
    expect(() =>
      assertScheduledRunAuthority({
        task: task(),
        chat: chat(),
        expectedKind: 'single',
        appRunId: 'run-replayed',
        canonicalizePath
      })
    ).toThrow('Scheduled occurrence does not match')

    expect(() =>
      assertScheduledRunAuthority({
        task: task({ kind: 'ensemble' }),
        chat: chat(),
        expectedKind: 'single',
        appRunId: 'run-test-1',
        canonicalizePath
      })
    ).toThrow('Scheduled occurrence does not match')
  })

  it('rejects running occurrences before a finite run time has arrived', () => {
    expect(
      assertScheduledRunAuthority({
        task: task({ runAt: new Date(nowMs).toISOString() }),
        chat: chat(),
        expectedKind: 'single',
        appRunId: 'run-test-1',
        nowMs,
        canonicalizePath
      })
    ).toMatchObject({ id: 'scheduled-test-1' })

    for (const runAt of [
      new Date(nowMs + 1).toISOString(),
      'not-a-date',
      null as unknown as string,
      false as unknown as string
    ]) {
      expect(() =>
        assertScheduledRunAuthority({
          task: task({ runAt }),
          chat: chat(),
          expectedKind: 'single',
          appRunId: 'run-test-1',
          nowMs,
          canonicalizePath
        })
      ).toThrow('Scheduled occurrence does not match')
    }
  })

  it('rejects global chat authority', () => {
    expect(() =>
      assertScheduledRunAuthority({
        task: task(),
        chat: chat({ scope: 'global', workspaceId: undefined, workspacePath: undefined }),
        expectedKind: 'single',
        appRunId: 'run-test-1',
        canonicalizePath
      })
    ).toThrow('Scheduled occurrence does not match')
  })
})

describe('assertRunAgentScheduledAuthority', () => {
  it('accepts the exact main-renderer solo occurrence', () => {
    const scheduled = task()
    expect(
      assertRunAgentScheduledAuthority({
        scheduledTaskId: scheduled.id,
        isMainRenderer: true,
        task: scheduled,
        chat: chat(),
        appRunId: 'run-test-1',
        nowMs,
        canonicalizePath
      })
    ).toBe(scheduled)
  })

  it('rejects any scheduled id from a secondary renderer', () => {
    expect(() =>
      assertRunAgentScheduledAuthority({
        scheduledTaskId: 'scheduled-test-1',
        isMainRenderer: false,
        task: task(),
        chat: chat(),
        appRunId: 'run-test-1',
        canonicalizePath
      })
    ).toThrow('Scheduled occurrence does not match')
  })

  it.each([
    ['another chat', task({ chatId: 'chat-test-3' }), chat(), 'run-test-1'],
    ['another workspace', task({ workspacePath: '/Test 3' }), chat(), 'run-test-1'],
    ['another run', task(), chat(), 'run-replayed'],
    ['ensemble kind', task({ kind: 'ensemble' }), chat(), 'run-test-1'],
    ['non-running status', task({ status: 'due' }), chat(), 'run-test-1']
  ])('rejects main renderer with %s', (_label, scheduled, durableChat, appRunId) => {
    expect(() =>
      assertRunAgentScheduledAuthority({
        scheduledTaskId: scheduled.id,
        isMainRenderer: true,
        task: scheduled,
        chat: durableChat,
        appRunId,
        canonicalizePath
      })
    ).toThrow('Scheduled occurrence does not match')
  })

  it('rejects an occurrence already bound to dispatch', () => {
    expect(() =>
      assertRunAgentScheduledAuthority({
        scheduledTaskId: 'scheduled-test-1',
        isMainRenderer: true,
        alreadyBound: true,
        task: task(),
        chat: chat(),
        appRunId: 'run-test-1',
        canonicalizePath
      })
    ).toThrow('Scheduled occurrence does not match')
  })
})
