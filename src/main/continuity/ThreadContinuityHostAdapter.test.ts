import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../store/types'
vi.mock('../store', () => ({ AppStore: {} }))
import { resolveContinuityCaller } from './ThreadContinuityHostAdapter'

const chat = {
  appChatId: 'chat',
  provider: 'codex',
  chatKind: 'single',
  archived: false,
  runs: [{ runId: 'run', provider: 'codex', status: 'running', startedAt: '2026-09-05T12:00:00Z' }]
} as unknown as ChatRecord
const context = { appChatId: 'chat', appRunId: 'run' }

describe('continuity caller admission', () => {
  it('admits only the active recorded task and provider', () => {
    expect(resolveContinuityCaller(chat, context, 'codex', false)).toMatchObject({
      chatId: 'chat',
      seatId: '__solo__'
    })
    expect(
      resolveContinuityCaller(chat, { ...context, appChatId: 'foreign' }, 'codex', false)
    ).toBeNull()
    expect(
      resolveContinuityCaller(chat, { ...context, appRunId: 'foreign' }, 'codex', false)
    ).toBeNull()
    expect(resolveContinuityCaller(chat, context, 'claude', false)).toBeNull()
    expect(resolveContinuityCaller(chat, context, 'codex', true)).toBeNull()
    expect(
      resolveContinuityCaller(
        { ...chat, runs: [{ ...chat.runs[0], endedAt: '2026-09-05T12:01:00Z' }] },
        context,
        'codex',
        false
      )
    ).toBeNull()
  })
  it('never treats an unidentified Ensemble run as a private solo seat', () => {
    expect(
      resolveContinuityCaller({ ...chat, chatKind: 'ensemble' }, context, 'codex', false)
    ).toBeNull()
  })
})
