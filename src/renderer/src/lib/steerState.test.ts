import { describe, expect, it } from 'vitest'

import {
  DEFAULT_STEER_CANCEL_TIMEOUT_MS,
  beginSteer,
  decideSteerWait,
  getSteerIndicatorMessage,
  IDLE_STEER_STATE,
  isActiveRunCleared,
  isSteerInFlight,
  markSteerFailed,
  resetSteer,
  transitionToDispatching
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
  })
})
