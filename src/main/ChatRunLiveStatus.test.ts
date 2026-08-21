import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChatRecord, ChatRun } from './store/types'
import { withLiveChatRunStatus } from './ChatRunLiveStatus'

function run(overrides: Partial<ChatRun> = {}): ChatRun {
  return {
    runId: 'run-1',
    startedAt: '2026-08-21T12:46:00.000Z',
    status: 'starting',
    ...overrides
  }
}

function chat(runs: ChatRun[]): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'T',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages: [],
    runs
  }
}

describe('withLiveChatRunStatus', () => {
  it('promotes starting to running', () => {
    const next = withLiveChatRunStatus(chat([run()]), 'run-1', 'running')
    expect(next?.runs[0]?.status).toBe('running')
    expect(next?.updatedAt).toBeGreaterThan(2)
  })

  it('is a no-op when the row is already running', () => {
    const current = chat([run({ status: 'running' })])
    expect(withLiveChatRunStatus(current, 'run-1', 'running')).toBeNull()
  })

  it.each([
    'failed',
    'success',
    'success_with_warnings',
    'cancelled',
    'completed',
    'sleeping',
    'unknown-legacy-status'
  ])('does not revive a non-active %s row', (status) => {
    expect(withLiveChatRunStatus(chat([run({ status })]), 'run-1', 'running')).toBeNull()
  })

  it('ignores non-running session statuses and missing runs', () => {
    expect(withLiveChatRunStatus(chat([run()]), 'run-1', 'starting')).toBeNull()
    expect(withLiveChatRunStatus(chat([run()]), 'run-other', 'running')).toBeNull()
    expect(withLiveChatRunStatus(chat([]), 'run-1', 'running')).toBeNull()
  })
})

describe('main wiring', () => {
  it('projects running onto ChatRun from the RunManager listener', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(source).toContain('persistChatRunRunningFromSession(event.session)')
    expect(source).toContain('withLiveChatRunStatus(chat, session.runId, session.status)')
  })
})
