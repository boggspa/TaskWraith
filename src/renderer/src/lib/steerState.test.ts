import { describe, expect, it } from 'vitest'

import {
  DEFAULT_STEER_CANCEL_TIMEOUT_MS,
  beginSteer,
  decideSteerWait,
  getSteerIndicatorMessage,
  IDLE_STEER_STATE,
  isActiveRunCleared,
  isSteerInFlight,
  resolveSteerCancelTargetRunId,
  markSteerFailed,
  resetSteer,
  transitionToDispatching,
  transitionToInjecting
} from './steerState'

describe('steerState', () => {
  describe('beginSteer', () => {
    it('produces a cancelling state pinned to the chat id', () => {
      const state = beginSteer({ chatId: 'chat-A', cancelTargetRunId: 'run-1', now: 100 })
      expect(state).toEqual({
        phase: 'cancelling',
        chatId: 'chat-A',
        startedAt: 100,
        cancelTargetRunId: 'run-1'
      })
    })

    it('falls back to Date.now() when `now` is omitted', () => {
      const before = Date.now()
      const state = beginSteer({ chatId: 'chat-A' })
      const after = Date.now()
      expect(state.phase).toBe('cancelling')
      expect(state.startedAt).toBeGreaterThanOrEqual(before)
      expect(state.startedAt).toBeLessThanOrEqual(after)
    })
  })

  describe('resolveSteerCancelTargetRunId', () => {
    it('uses the active context runId first', () => {
      const result = resolveSteerCancelTargetRunId({
        chatId: 'chat-1',
        activeContext: { chatId: 'chat-1', runId: 'active-context' } as any,
        activeRunId: 'active-run-id',
        activeRunChatId: 'chat-1',
        runQueueJobs: [
          {
            id: 'queued-1',
            runId: 'queued-run',
            provider: 'codex',
            status: 'active',
            chatId: 'chat-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          } as any
        ],
        targetChat: {
          appChatId: 'chat-1',
          runs: [{ runId: 'persisted-run', status: 'running' }]
        } as any
      })
      expect(result).toBe('active-context')
    })

    it('falls back to activeRunIdRef when the chat matches and no active context exists', () => {
      const result = resolveSteerCancelTargetRunId({
        chatId: 'chat-1',
        activeContext: null,
        activeRunId: 'active-run-id',
        activeRunChatId: 'chat-1',
        targetChat: {
          appChatId: 'chat-1',
          runs: []
        } as any
      })
      expect(result).toBe('active-run-id')
    })

    it('falls back to a non-terminal queue job for the same chat', () => {
      const result = resolveSteerCancelTargetRunId({
        chatId: 'chat-1',
        activeContext: null,
        activeRunId: null,
        activeRunChatId: null,
        runQueueJobs: [
          {
            id: 'queued-1',
            runId: 'queued-active-run',
            provider: 'codex',
            status: 'queued',
            chatId: 'chat-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          } as any,
          {
            id: 'queued-2',
            runId: 'queued-starting-run',
            provider: 'codex',
            status: 'starting',
            chatId: 'chat-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          } as any
        ],
        targetChat: {
          appChatId: 'chat-1',
          runs: [{ runId: 'persisted-run', status: 'running' }]
        } as any
      })
      expect(result).toBe('queued-starting-run')
    })

    it('falls back to the most recent unfinished persisted run when needed', () => {
      const result = resolveSteerCancelTargetRunId({
        chatId: 'chat-1',
        activeContext: null,
        activeRunId: null,
        activeRunChatId: null,
        runQueueJobs: [],
        targetChat: {
          appChatId: 'chat-1',
          runs: [
            { runId: 'completed-run', status: 'completed', endedAt: '2026-01-01T00:00:00.000Z' },
            { runId: 'running-run', status: 'running' }
          ]
        } as any
      })
      expect(result).toBe('running-run')
    })
  })

  describe('transitionToDispatching', () => {
    it('preserves the startedAt + cancelTargetRunId when moving from cancelling', () => {
      const prev = beginSteer({ chatId: 'chat-A', cancelTargetRunId: 'run-1', now: 500 })
      const next = transitionToDispatching({ prev, chatId: 'chat-A', now: 700 })
      expect(next).toEqual({
        phase: 'dispatching',
        chatId: 'chat-A',
        startedAt: 500,
        cancelTargetRunId: 'run-1'
      })
    })

    it('coerces to a fresh dispatching state when called against an idle prev', () => {
      const next = transitionToDispatching({
        prev: IDLE_STEER_STATE,
        chatId: 'chat-A',
        now: 900
      })
      expect(next.phase).toBe('dispatching')
      expect(next.chatId).toBe('chat-A')
      expect(next.startedAt).toBe(900)
      expect(next.cancelTargetRunId).toBeUndefined()
    })

    it('coerces to a fresh dispatching state when the chat id changed mid-flight', () => {
      // Defensive: a user navigates away from chat A to chat B between
      // cancel + dispatch. The transition should still produce a
      // useable dispatching state — App.tsx is the source of truth for
      // whether to actually dispatch — but it should NOT silently keep
      // chat A's startedAt.
      const prev = beginSteer({ chatId: 'chat-A', now: 100 })
      const next = transitionToDispatching({ prev, chatId: 'chat-B', now: 250 })
      expect(next).toEqual({
        phase: 'dispatching',
        chatId: 'chat-B',
        startedAt: 250,
        cancelTargetRunId: undefined
      })
    })
  })

  describe('markSteerFailed', () => {
    it('captures the reason + a human-facing message', () => {
      const state = markSteerFailed({
        chatId: 'chat-A',
        reason: 'timeout',
        message: 'Cancel did not land in 5s.'
      })
      expect(state).toEqual({
        phase: 'failed',
        chatId: 'chat-A',
        reason: 'timeout',
        message: 'Cancel did not land in 5s.'
      })
    })
  })

  describe('resetSteer', () => {
    it('returns the singleton idle state', () => {
      expect(resetSteer()).toBe(IDLE_STEER_STATE)
    })
  })

  describe('isActiveRunCleared', () => {
    it('returns true when the chat has no active run', () => {
      expect(
        isActiveRunCleared({
          chatId: 'chat-A',
          hasRunForChat: () => false
        })
      ).toBe(true)
    })

    it('returns false while the chat still has a run', () => {
      expect(
        isActiveRunCleared({
          chatId: 'chat-A',
          hasRunForChat: (id) => id === 'chat-A'
        })
      ).toBe(false)
    })
  })

  describe('decideSteerWait', () => {
    it('returns cancel-landed when the active-run map cleared', () => {
      const result = decideSteerWait({
        chatId: 'chat-A',
        startedAt: 0,
        now: 100,
        hasRunForChat: () => false
      })
      expect(result).toEqual({ kind: 'cancel-landed' })
    })

    it('returns continue-waiting while inside the timeout window', () => {
      const result = decideSteerWait({
        chatId: 'chat-A',
        startedAt: 0,
        now: 1000,
        hasRunForChat: () => true
      })
      expect(result).toEqual({ kind: 'continue-waiting' })
    })

    it('returns timeout once the deadline elapses', () => {
      const result = decideSteerWait({
        chatId: 'chat-A',
        startedAt: 0,
        now: DEFAULT_STEER_CANCEL_TIMEOUT_MS + 1,
        hasRunForChat: () => true
      })
      expect(result).toEqual({ kind: 'timeout' })
    })

    it('honours an explicit shorter timeout', () => {
      const result = decideSteerWait({
        chatId: 'chat-A',
        startedAt: 0,
        now: 250,
        timeoutMs: 200,
        hasRunForChat: () => true
      })
      expect(result).toEqual({ kind: 'timeout' })
    })

    it('prefers cancel-landed over timeout when both fire on the same tick', () => {
      // Defensive: the active-run clear can race with the deadline.
      // The cancel-landed branch wins so we still try to dispatch
      // instead of falling back to queueing.
      const result = decideSteerWait({
        chatId: 'chat-A',
        startedAt: 0,
        now: DEFAULT_STEER_CANCEL_TIMEOUT_MS + 1,
        hasRunForChat: () => false
      })
      expect(result).toEqual({ kind: 'cancel-landed' })
    })
  })

  describe('getSteerIndicatorMessage', () => {
    it('returns null while idle', () => {
      expect(
        getSteerIndicatorMessage({
          state: IDLE_STEER_STATE,
          chatId: 'chat-A',
          providerLabel: 'Codex'
        })
      ).toBeNull()
    })

    it('returns the cancelling copy for the matching chat', () => {
      expect(
        getSteerIndicatorMessage({
          state: beginSteer({ chatId: 'chat-A', now: 0 }),
          chatId: 'chat-A',
          providerLabel: 'Codex'
        })
      ).toBe('Steering — interrupting current Codex turn…')
    })

    it('returns the dispatching copy once the cancel landed', () => {
      const cancelling = beginSteer({ chatId: 'chat-A', now: 0 })
      const dispatching = transitionToDispatching({ prev: cancelling, chatId: 'chat-A', now: 5 })
      expect(
        getSteerIndicatorMessage({
          state: dispatching,
          chatId: 'chat-A',
          providerLabel: 'Codex'
        })
      ).toBe('Steering — dispatching new Codex turn…')
    })

    it('can describe ensemble steering without leaking the seed provider', () => {
      expect(
        getSteerIndicatorMessage({
          state: beginSteer({ chatId: 'chat-A', now: 0 }),
          chatId: 'chat-A',
          providerLabel: 'Grok',
          turnLabel: 'ensemble round'
        })
      ).toBe('Steering — interrupting current ensemble round…')
    })

    it('suppresses the indicator when the chat id does not match', () => {
      expect(
        getSteerIndicatorMessage({
          state: beginSteer({ chatId: 'chat-A', now: 0 }),
          chatId: 'chat-B',
          providerLabel: 'Codex'
        })
      ).toBeNull()
    })

    it('suppresses the indicator for the failed phase (surfaced elsewhere)', () => {
      expect(
        getSteerIndicatorMessage({
          state: markSteerFailed({
            chatId: 'chat-A',
            reason: 'timeout',
            message: 'Cancel did not land.'
          }),
          chatId: 'chat-A',
          providerLabel: 'Codex'
        })
      ).toBeNull()
    })

    it('returns null when no chat id is provided', () => {
      expect(
        getSteerIndicatorMessage({
          state: beginSteer({ chatId: 'chat-A', now: 0 }),
          chatId: null,
          providerLabel: 'Codex'
        })
      ).toBeNull()
    })
  })

  describe('isSteerInFlight', () => {
    it('returns true while cancelling for the matching chat', () => {
      expect(
        isSteerInFlight({
          state: beginSteer({ chatId: 'chat-A', now: 0 }),
          chatId: 'chat-A'
        })
      ).toBe(true)
    })

    it('returns true while dispatching for the matching chat', () => {
      const cancelling = beginSteer({ chatId: 'chat-A', now: 0 })
      const dispatching = transitionToDispatching({ prev: cancelling, chatId: 'chat-A', now: 5 })
      expect(
        isSteerInFlight({
          state: dispatching,
          chatId: 'chat-A'
        })
      ).toBe(true)
    })

    it('returns false for a different chat', () => {
      expect(
        isSteerInFlight({
          state: beginSteer({ chatId: 'chat-A', now: 0 }),
          chatId: 'chat-B'
        })
      ).toBe(false)
    })

    it('returns false while idle', () => {
      expect(
        isSteerInFlight({
          state: IDLE_STEER_STATE,
          chatId: 'chat-A'
        })
      ).toBe(false)
    })

    it('returns false in the failed phase', () => {
      expect(
        isSteerInFlight({
          state: markSteerFailed({
            chatId: 'chat-A',
            reason: 'timeout',
            message: 'Cancel did not land.'
          }),
          chatId: 'chat-A'
        })
      ).toBe(false)
    })

    it('returns true in the injecting phase for the matching chat', () => {
      expect(
        isSteerInFlight({
          state: transitionToInjecting({
            prev: IDLE_STEER_STATE,
            chatId: 'chat-A',
            runId: 'run-1',
            strategy: 'acp-interrupt',
            now: 100
          }),
          chatId: 'chat-A'
        })
      ).toBe(true)
    })
  })

  describe('transitionToInjecting', () => {
    it('produces an injecting state pinned to the chat, run, and strategy', () => {
      const state = transitionToInjecting({
        prev: IDLE_STEER_STATE,
        chatId: 'chat-A',
        runId: 'run-1',
        strategy: 'acp-interrupt',
        now: 500
      })
      expect(state).toEqual({
        phase: 'injecting',
        chatId: 'chat-A',
        startedAt: 500,
        runId: 'run-1',
        strategy: 'acp-interrupt',
        message: undefined
      })
    })

    it('preserves startedAt when moving from cancelling of the same chat', () => {
      const prev = beginSteer({ chatId: 'chat-A', now: 300 })
      const state = transitionToInjecting({
        prev,
        chatId: 'chat-A',
        runId: 'run-9',
        strategy: 'broker-injection',
        now: 900
      })
      expect(state.startedAt).toBe(300)
    })

    it('shows the injecting indicator copy for the matching chat', () => {
      const state = transitionToInjecting({
        prev: IDLE_STEER_STATE,
        chatId: 'chat-A',
        runId: 'run-1',
        strategy: 'acp-interrupt',
        now: 0
      })
      expect(
        getSteerIndicatorMessage({
          state,
          chatId: 'chat-A',
          providerLabel: 'Kimi'
        })
      ).toBe('Steering — delivering into current Kimi turn…')
    })

    it('suppresses the injecting indicator when the chat id does not match', () => {
      const state = transitionToInjecting({
        prev: IDLE_STEER_STATE,
        chatId: 'chat-A',
        runId: 'run-1',
        strategy: 'acp-interrupt',
        now: 0
      })
      expect(
        getSteerIndicatorMessage({
          state,
          chatId: 'chat-B',
          providerLabel: 'Kimi'
        })
      ).toBeNull()
    })
  })
})
