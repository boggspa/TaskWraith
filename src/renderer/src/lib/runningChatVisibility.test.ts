import { describe, expect, it } from 'vitest'

import {
  hasKnownInactiveEnsembleRound,
  hasTerminalLastRun,
  visibleRunningChatIds
} from './runningChatVisibility'

describe('visibleRunningChatIds', () => {
  it('returns the original list when no approvals are pending', () => {
    const ids = ['chat-1', 'chat-2']
    expect(visibleRunningChatIds(ids, {})).toEqual(['chat-1', 'chat-2'])
  })

  it('hides a Kimi chat that is parked on a pending approval', () => {
    expect(
      visibleRunningChatIds(['chat-1', 'chat-2'], {
        'chat-1': { provider: 'kimi' }
      })
    ).toEqual(['chat-2'])
  })

  it('leaves Codex/Gemini/Claude chats visible while awaiting approval', () => {
    expect(
      visibleRunningChatIds(['gemini-chat', 'codex-chat', 'claude-chat'], {
        'gemini-chat': { provider: 'gemini' },
        'codex-chat': { provider: 'codex' },
        'claude-chat': { provider: 'claude' }
      })
    ).toEqual(['gemini-chat', 'codex-chat', 'claude-chat'])
  })

  it('treats a cleared approval entry as no approval', () => {
    expect(visibleRunningChatIds(['chat-1'], { 'chat-1': null })).toEqual(['chat-1'])
  })

  it('accepts a Set as input', () => {
    const set = new Set(['chat-1', 'chat-2'])
    expect(visibleRunningChatIds(set, { 'chat-2': { provider: 'kimi' } })).toEqual(['chat-1'])
  })

  it('only filters the chat whose pending approval is Kimi-owned', () => {
    expect(
      visibleRunningChatIds(['chat-1', 'chat-2', 'chat-3'], {
        'chat-1': { provider: 'kimi' },
        'chat-3': { provider: 'codex' }
      })
    ).toEqual(['chat-2', 'chat-3'])
  })

  it('drops a chat whose last run already has a terminal endedAt', () => {
    // Defensive filter: covers the in-session case where
    // `runningChatIds` was added to but never cleared (e.g.
    // `handleProviderExit` early-returned because the active context
    // had already been evicted, or `cancelAgentRun` killed the child
    // without an `agent-exit` IPC).
    expect(
      visibleRunningChatIds(
        ['chat-stuck'],
        {},
        {
          'chat-stuck': {
            appChatId: 'chat-stuck',
            provider: 'kimi',
            runs: [{ endedAt: '2026-05-16T12:00:00.000Z', status: 'failed' }]
          }
        }
      )
    ).toEqual([])
  })

  it('drops a chat whose last run status is terminal even without endedAt', () => {
    expect(
      visibleRunningChatIds(
        ['chat-stuck'],
        {},
        {
          'chat-stuck': {
            appChatId: 'chat-stuck',
            provider: 'codex',
            runs: [{ status: 'failed' }]
          }
        }
      )
    ).toEqual([])
  })

  it('keeps a chat whose last run is genuinely still running', () => {
    expect(
      visibleRunningChatIds(
        ['chat-live'],
        {},
        {
          'chat-live': {
            appChatId: 'chat-live',
            provider: 'gemini',
            // No endedAt and no terminal status -> still running.
            runs: [{}]
          }
        }
      )
    ).toEqual(['chat-live'])
  })

  it('keeps a chat with no runs (newly-started, persisted snapshot not yet flushed)', () => {
    expect(
      visibleRunningChatIds(
        ['chat-new'],
        {},
        {
          'chat-new': { appChatId: 'chat-new', provider: 'kimi', runs: [] }
        }
      )
    ).toEqual(['chat-new'])
  })

  it('ignores a missing chat record (running chat id without a snapshot)', () => {
    expect(visibleRunningChatIds(['chat-orphan'], {}, {})).toEqual(['chat-orphan'])
  })

  it('combines the pending-approval filter with the terminal-run filter', () => {
    expect(
      visibleRunningChatIds(
        ['kimi-pending', 'finished-chat', 'live-chat'],
        { 'kimi-pending': { provider: 'kimi' } },
        {
          'finished-chat': {
            appChatId: 'finished-chat',
            runs: [{ endedAt: 'now' }]
          },
          'live-chat': {
            appChatId: 'live-chat',
            runs: [{ status: undefined } as { status?: string }]
          }
        }
      )
    ).toEqual(['live-chat'])
  })

  it('drops an ensemble chat whose active round is already terminal', () => {
    expect(
      visibleRunningChatIds(
        ['ensemble-chat'],
        {},
        {
          'ensemble-chat': {
            appChatId: 'ensemble-chat',
            runs: [{}],
            ensemble: {
              activeRound: {
                roundId: 'round-1',
                status: 'completed',
                prompt: 'done',
                startedAt: '2026-07-01T20:00:00.000Z',
                endedAt: '2026-07-01T20:01:00.000Z',
                participants: []
              }
            }
          }
        }
      )
    ).toEqual([])
  })

  it('drops a stale running ensemble snapshot with no live dispatch evidence', () => {
    expect(
      visibleRunningChatIds(
        ['ensemble-chat'],
        {},
        {
          'ensemble-chat': {
            appChatId: 'ensemble-chat',
            runs: [{}],
            ensemble: {
              activeRound: {
                roundId: 'round-1',
                status: 'running',
                prompt: 'done',
                startedAt: '2026-07-01T20:00:00.000Z',
                participants: [
                  {
                    participantId: 'p1',
                    provider: 'codex',
                    role: 'Worker',
                    order: 0,
                    status: 'answered',
                    endedAt: '2026-07-01T20:01:00.000Z'
                  }
                ]
              }
            }
          }
        }
      )
    ).toEqual([])
  })
})

describe('hasTerminalLastRun', () => {
  it('returns false for a chat with no runs', () => {
    expect(hasTerminalLastRun({ appChatId: 'c', runs: [] })).toBe(false)
    expect(hasTerminalLastRun({ appChatId: 'c' })).toBe(false)
  })

  it('returns true when the last run has an endedAt', () => {
    expect(hasTerminalLastRun({ appChatId: 'c', runs: [{ endedAt: 'now' }] })).toBe(true)
  })

  it('returns true for terminal status strings without endedAt', () => {
    for (const status of ['failed', 'cancelled', 'success', 'success_with_warnings']) {
      expect(hasTerminalLastRun({ appChatId: 'c', runs: [{ status }] })).toBe(true)
    }
  })

  it('returns false for a non-terminal status without endedAt', () => {
    expect(hasTerminalLastRun({ appChatId: 'c', runs: [{ status: 'running' }] })).toBe(false)
    expect(hasTerminalLastRun({ appChatId: 'c', runs: [{}] })).toBe(false)
  })

  it('looks at the LAST run when the chat has prior completed runs', () => {
    expect(
      hasTerminalLastRun({
        appChatId: 'c',
        runs: [
          { endedAt: 'a', status: 'success' },
          {} // currently running
        ]
      })
    ).toBe(false)
  })
})

describe('hasKnownInactiveEnsembleRound', () => {
  it('returns true for a terminal ensemble active round', () => {
    expect(
      hasKnownInactiveEnsembleRound({
        appChatId: 'ensemble-chat',
        ensemble: {
          activeRound: {
            roundId: 'round-1',
            status: 'completed',
            prompt: 'done',
            startedAt: '2026-07-01T20:00:00.000Z',
            participants: []
          }
        }
      })
    ).toBe(true)
  })

  it('returns false when the ensemble active round still has a running participant', () => {
    expect(
      hasKnownInactiveEnsembleRound({
        appChatId: 'ensemble-chat',
        ensemble: {
          activeRound: {
            roundId: 'round-1',
            status: 'running',
            prompt: 'go',
            startedAt: '2026-07-01T20:00:00.000Z',
            activeParticipantId: 'p1',
            participants: [
              {
                participantId: 'p1',
                provider: 'codex',
                role: 'Worker',
                order: 0,
                status: 'running'
              }
            ]
          }
        }
      })
    ).toBe(false)
  })
})
