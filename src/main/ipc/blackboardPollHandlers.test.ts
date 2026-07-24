import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { BlackboardEntry, ChatRecord } from '../store/types'
import { registerBlackboardPollHandlers } from './blackboardPollHandlers'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

const mockedHandle = vi.mocked(ipcMain.handle)
const NOW = new Date('2026-07-24T13:00:00.000Z')

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, payload?: Record<string, unknown>) => unknown

function registeredHandler(): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([name]) => name === 'answer-ensemble-poll')?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error('answer-ensemble-poll was not registered')
  return handler
}

function pollEntry(): BlackboardEntry {
  return {
    id: 'blackboard-poll-1',
    chatId: 'chat-1',
    roundId: 'round-1',
    participantId: 'p1',
    key: 'release-vote',
    value: 'Ship?',
    category: 'decision',
    scope: 'session',
    createdAt: '2026-07-24T12:00:00.000Z',
    seenBy: ['p1'],
    poll: {
      status: 'open',
      options: ['Ship', 'Keep working'],
      votes: [],
      eligibleParticipantIds: ['p1', 'p2'],
      includeUser: true,
      updatedAt: '2026-07-24T12:00:00.000Z'
    }
  }
}

function chat(entries: BlackboardEntry[]): ChatRecord {
  return {
    appChatId: 'chat-1',
    updatedAt: 1,
    ensemble: {
      participants: [],
      activeRound: { roundId: 'round-1', status: 'running' },
      blackboard: entries
    }
  } as unknown as ChatRecord
}

function createDeps(target = chat([pollEntry()]), mainRenderer = false) {
  return {
    isMainRendererSender: vi.fn(() => mainRenderer),
    assertSenderChatScope: vi.fn(),
    getChat: vi.fn(() => target),
    saveAndBroadcastChat: vi.fn(),
    userPollResponseForChat: vi.fn(() => ({ ok: true, message: 'legacy poll accepted' })),
    now: vi.fn(() => NOW)
  }
}

describe('registerBlackboardPollHandlers', () => {
  it('records the human vote in the scoped chat before considering legacy polls', () => {
    const deps = createDeps()
    registerBlackboardPollHandlers(deps)

    expect(
      registeredHandler()(
        { sender: { id: 2 } },
        { appChatId: 'chat-1', pollId: 'blackboard-poll-1', choice: 'Ship' }
      )
    ).toEqual({ ok: true })
    expect(deps.assertSenderChatScope).toHaveBeenCalledWith({ sender: { id: 2 } }, 'chat-1')
    expect(deps.saveAndBroadcastChat).toHaveBeenCalledOnce()
    const saved = deps.saveAndBroadcastChat.mock.calls[0][0]
    expect(saved.ensemble?.blackboard?.[0]?.poll?.votes).toEqual([
      {
        voterId: 'user',
        choice: 'Ship',
        votedAt: NOW.toISOString()
      }
    ])
    expect(deps.userPollResponseForChat).not.toHaveBeenCalled()
  })

  it('claims a matching Blackboard poll rejection without falling through', () => {
    const deps = createDeps()
    registerBlackboardPollHandlers(deps)

    expect(
      registeredHandler()(
        { sender: { id: 2 } },
        { appChatId: 'chat-1', pollId: 'blackboard-poll-1', choice: 'Abstain' }
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('choice must be one of') })
    expect(deps.saveAndBroadcastChat).not.toHaveBeenCalled()
    expect(deps.userPollResponseForChat).not.toHaveBeenCalled()
  })

  it('falls through to the existing Boss/Captain poll route when no Blackboard poll matches', () => {
    const deps = createDeps(chat([]))
    registerBlackboardPollHandlers(deps)

    expect(
      registeredHandler()(
        { sender: { id: 2 } },
        { appChatId: 'chat-1', pollId: 'boss-poll-1', choice: 'Ship' }
      )
    ).toEqual({ ok: true })
    expect(deps.userPollResponseForChat).toHaveBeenCalledWith('chat-1', {
      pollId: 'boss-poll-1',
      choice: 'Ship'
    })
  })

  it('requires secondary renderers to supply and own the target chat', () => {
    const deps = createDeps(chat([]))
    registerBlackboardPollHandlers(deps)

    expect(() =>
      registeredHandler()({ sender: { id: 2 } }, { pollId: 'boss-poll-1', choice: 'Ship' })
    ).toThrow('Renderer cannot resolve Ensemble poll chat authority.')
    expect(deps.userPollResponseForChat).not.toHaveBeenCalled()
  })
})
