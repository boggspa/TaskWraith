import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../store/types'
vi.mock('../store', () => ({ AppStore: { getChat: vi.fn() } }))
import { AppStore } from '../store'
import {
  createThreadContinuityHostTools,
  resolveContinuityCaller
} from './ThreadContinuityHostAdapter'
import { planPromptContinuity } from './ContinuityPrompt'
import { updateSeatCheckpoint } from '../../shared/threadContinuity'

const chat = {
  appChatId: 'chat',
  provider: 'codex',
  chatKind: 'single',
  archived: false,
  runs: [{ runId: 'run', provider: 'codex', status: 'running', startedAt: '2026-09-05T12:00:00Z' }]
} as unknown as ChatRecord
const context = { appChatId: 'chat', appRunId: 'run' }

describe('continuity caller admission', () => {
  it('binds a selected cold fallback to its actual session and invalidates a later unmatched retry', () => {
    let current: ChatRecord = {
      ...chat,
      messages: [],
      runs: [{ ...chat.runs[0], providerThreadId: 'new-session' }]
    }
    current = {
      ...current,
      continuityCheckpoints: updateSeatCheckpoint(current, {
        seatId: '__solo__',
        text: 'The exact fallback checkpoint.',
        expectedRevision: 0,
        author: { provider: 'codex', runId: 'old-author', providerSessionId: 'old-session' },
        now: '2026-09-05T11:00:00Z'
      })
    }
    vi.mocked(AppStore.getChat).mockImplementation(() => current)
    const tools = createThreadContinuityHostTools({
      isIsolatedRun: () => false,
      saveCheckpoint: (value) => {
        current = value
      }
    })
    const cold = planPromptContinuity({ chat: current, provider: 'codex' })
    if (cold.action !== 'deliver') throw new Error('Expected cold recovery')
    const selected = {
      appChatId: 'chat',
      appRunId: 'run',
      provider: 'codex' as const,
      providerSessionId: 'new-session',
      transport: 'codex-app-server',
      part: 'user',
      text: cold.block
    }
    tools.recordSelectedPrompt(selected)
    expect(current.runs[0].continuityCheckpointDelivery).toMatchObject({
      providerSessionId: 'new-session',
      sourceId: expect.any(String)
    })
    const originalReceipt = current.runs[0].continuityCheckpointDelivery
    tools.recordSelectedPrompt({
      ...selected,
      text: 'A new steering instruction.',
      promptKind: 'steer'
    })
    expect(current.runs[0].continuityCheckpointDelivery).toEqual(originalReceipt)
    current.runs[0] = { ...current.runs[0], status: 'success', endedAt: '2026-09-05T12:01:00Z' }
    expect(
      planPromptContinuity({ chat: current, provider: 'codex', providerSessionId: 'new-session' })
        .action
    ).toBe('omit')
    tools.recordSelectedPrompt({
      ...selected,
      text: 'Different selected prompt without the checkpoint.'
    })
    expect(current.runs[0].continuityCheckpointDelivery).toBeUndefined()
    expect(
      planPromptContinuity({ chat: current, provider: 'codex', providerSessionId: 'new-session' })
        .action
    ).toBe('deliver')
  })
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
