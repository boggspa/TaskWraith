import { describe, expect, it } from 'vitest'
import {
  HUMAN_COLLABORATION_PRESENCE_GRACE_MS,
  HumanCollaborationPresence,
  MAX_RETAINED_EXPIRED_PRESENCE_SESSIONS,
  membershipForPresence,
  type HumanCollaborationPresenceSessionRef
} from './HumanCollaborationPresence'

/*
 * Pins the tri-state presence model that replaces the two broken notions of
 * "present" in HumanCollaborationRuntime: a graceful leave that deleted the
 * session instantly (a tab reload read as a departure) and an ungraceful drop
 * that was never noticed at all (a phantom live session until revoke).
 *
 * Every test drives an injected clock explicitly — the module owns no timers,
 * so there is nothing to fake.
 */

const GRACE = 1_000

function makeClock(start = 10_000): { now: () => number; set: (value: number) => void } {
  let value = start
  return {
    now: () => value,
    set: (next: number) => {
      value = next
    }
  }
}

function ref(
  overrides: Partial<HumanCollaborationPresenceSessionRef> = {}
): HumanCollaborationPresenceSessionRef {
  return {
    sessionId: 'sess-1',
    chatId: 'chat-1',
    shareId: 'share-1',
    collaboratorId: 'collab-1',
    displayName: 'Dana',
    ...overrides
  }
}

function makePresence(now: () => number): HumanCollaborationPresence {
  return new HumanCollaborationPresence({ now, graceMs: GRACE })
}

describe('HumanCollaborationPresence', () => {
  describe('the grace window constant', () => {
    it('is long enough to survive relay heartbeat detection plus one capped retry', () => {
      // 2 x 30s relay heartbeat to NOTICE the drop + a 30s capped reconnect
      // backoff. Shortening this below 90s expires people mid-reconnect.
      expect(HUMAN_COLLABORATION_PRESENCE_GRACE_MS).toBe(90_000)
    })

    it('treats grace as still present so a reload emits no thread event', () => {
      expect(membershipForPresence('live')).toBe('present')
      expect(membershipForPresence('grace')).toBe('present')
      expect(membershipForPresence('expired')).toBe('absent')
      expect(membershipForPresence('unknown')).toBe('absent')
    })

    it('falls back to the default window when handed a nonsense override', () => {
      const clock = makeClock()
      const presence = new HumanCollaborationPresence({ now: clock.now, graceMs: -5 })
      expect(presence.graceWindowMs()).toBe(HUMAN_COLLABORATION_PRESENCE_GRACE_MS)
    })
  })

  describe('activity -> live', () => {
    it('admits a first-seen session as live and reports a thread-visible join', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)

      const transition = presence.observeActivity(ref())

      expect(transition).not.toBeNull()
      expect(transition?.from).toBe('unknown')
      expect(transition?.to).toBe('live')
      expect(transition?.reason).toBe('activity')
      expect(transition?.membershipFrom).toBe('absent')
      expect(transition?.membershipTo).toBe('present')
      expect(transition?.silent).toBe(false)
      expect(presence.sessionState('sess-1')).toBe('live')
      expect(presence.collaboratorState('collab-1')).toBe('live')
      expect(presence.chatState('chat-1')).toBe('live')
      expect(presence.shareState('share-1')).toBe('live')
      expect(presence.liveChatIds()).toEqual(['chat-1'])
    })

    it('is idempotent under a burst of activity — no repeated join events', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())

      clock.set(10_100)
      const again = presence.observeActivity(ref())
      clock.set(10_200)
      const andAgain = presence.observeActivity(ref())

      expect(again).toBeNull()
      expect(andAgain).toBeNull()
      expect(presence.snapshot()[0].lastSeenAt).toBe(10_200)
    })

    it('accepts a rename but refuses an identity swap on a known session', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())

      expect(presence.observeActivity(ref({ displayName: 'Dana R.' }))).toBeNull()
      expect(presence.snapshot()[0].displayName).toBe('Dana R.')

      // A ref that re-points a live sessionId at another chat is a bug or an
      // attack; the record must not be rewritten.
      expect(presence.observeActivity(ref({ chatId: 'chat-999' }))).toBeNull()
      expect(presence.snapshot()[0].chatId).toBe('chat-1')
      expect(presence.chatState('chat-999')).toBe('unknown')
    })
  })

  describe('leave -> grace (never instant removal)', () => {
    it('greys a graceful leave instead of deleting it, and stays silent to the thread', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())

      clock.set(10_500)
      const transition = presence.noteGracefulLeave('sess-1')

      expect(transition?.from).toBe('live')
      expect(transition?.to).toBe('grace')
      expect(transition?.reason).toBe('gracefulLeave')
      expect(transition?.graceUntil).toBe(10_500 + GRACE)
      // The whole point: a tab reload must not read as a departure.
      expect(transition?.membershipFrom).toBe('present')
      expect(transition?.membershipTo).toBe('present')
      expect(transition?.silent).toBe(true)
      expect(presence.sessionState('sess-1')).toBe('grace')
      expect(presence.liveChatIds()).toEqual([])
      expect(presence.presentChatIds()).toEqual(['chat-1'])
    })

    it('greys an ungraceful transport close the same way', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())

      const transition = presence.noteTransportClose('sess-1')

      expect(transition?.to).toBe('grace')
      expect(transition?.reason).toBe('transportClose')
      expect(presence.collaboratorState('collab-1')).toBe('grace')
    })

    it('anchors the deadline to the FIRST grace entry so a flapping socket cannot extend it', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())

      clock.set(10_500)
      presence.noteTransportClose('sess-1')
      clock.set(10_900)
      expect(presence.noteTransportClose('sess-1')).toBeNull()
      expect(presence.noteGracefulLeave('sess-1')).toBeNull()

      expect(presence.nextExpiryAt()).toBe(10_500 + GRACE)
    })

    it('ignores a leave for a session it has never seen', () => {
      const presence = makePresence(makeClock().now)
      expect(presence.noteGracefulLeave('nope')).toBeNull()
      expect(presence.noteTransportClose('nope')).toBeNull()
    })
  })

  describe('reconnect inside the window', () => {
    it('restores the same session to live with no join/leave churn', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())
      clock.set(10_500)
      presence.noteTransportClose('sess-1')

      clock.set(11_000)
      const back = presence.observeActivity(ref())

      expect(back?.from).toBe('grace')
      expect(back?.to).toBe('live')
      expect(back?.reason).toBe('reconnected')
      expect(back?.silent).toBe(true)
      expect(presence.nextExpiryAt()).toBeNull()
      // Nothing left to reap: the window closed by returning, not by expiring.
      expect(presence.sweep(99_999)).toEqual([])
    })

    it('treats a BRAND NEW session for a greyed collaborator as the same human returning', () => {
      // The real runtime mints a fresh sessionId on every reconnect, so the
      // returning collaborator never re-uses the greyed session id.
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())
      clock.set(10_500)
      presence.noteTransportClose('sess-1')

      clock.set(10_800)
      const fresh = presence.observeActivity(ref({ sessionId: 'sess-2' }))

      expect(fresh?.from).toBe('unknown')
      expect(fresh?.to).toBe('live')
      expect(fresh?.reason).toBe('reconnected')
      expect(fresh?.collaboratorFrom).toBe('grace')
      expect(fresh?.collaboratorTo).toBe('live')
      expect(fresh?.silent).toBe(true)

      // Reaping the stale twin later is also silent — they are still here.
      const reaped = presence.sweep(10_500 + GRACE)
      expect(reaped).toHaveLength(1)
      expect(reaped[0].sessionId).toBe('sess-1')
      expect(reaped[0].to).toBe('expired')
      expect(reaped[0].silent).toBe(true)
      expect(presence.collaboratorState('collab-1')).toBe('live')
    })
  })

  describe('security: withdrawn trust never gets a reconnect window', () => {
    it('revoke expires a live collaborator IMMEDIATELY, bypassing grace entirely', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())

      const [transition, ...rest] = presence.expireCollaborator('collab-1', 'revoked')

      expect(rest).toEqual([])
      expect(transition.from).toBe('live')
      expect(transition.to).toBe('expired')
      expect(transition.reason).toBe('revoked')
      expect(transition.graceUntil).toBeUndefined()
      expect(transition.membershipTo).toBe('absent')
      expect(transition.silent).toBe(false)
      expect(presence.sessionState('sess-1')).toBe('expired')
      expect(presence.nextExpiryAt()).toBeNull()
      expect(presence.presentChatIds()).toEqual([])
    })

    it('a kicked collaborator cannot buy back a live seat with a late frame', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())
      presence.expireCollaborator('collab-1', 'kicked')

      clock.set(10_050)
      const replay = presence.observeActivity(ref())

      expect(replay).toBeNull()
      expect(presence.sessionState('sess-1')).toBe('expired')
      expect(presence.collaboratorState('collab-1')).toBe('expired')
    })

    it('an expired grace window is equally terminal for that session id', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())
      presence.noteGracefulLeave('sess-1', 10_000)
      presence.sweep(10_000 + GRACE)

      expect(presence.observeActivity(ref(), 10_000 + GRACE + 1)).toBeNull()
      expect(presence.sessionState('sess-1')).toBe('expired')
    })

    it('revoking a whole share expires every session on it at once', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())
      presence.observeActivity(
        ref({ sessionId: 'sess-2', collaboratorId: 'collab-2', displayName: 'Sam' })
      )

      const transitions = presence.expireShare('share-1', 'shareDisabled')

      expect(transitions).toHaveLength(2)
      expect(transitions.every((entry) => entry.to === 'expired')).toBe(true)
      // Two different humans left, so both events are thread-visible.
      expect(transitions.filter((entry) => !entry.silent)).toHaveLength(2)
      expect(presence.shareState('share-1')).toBe('expired')
    })

    it('emits exactly one thread-visible leave when a revoked collaborator held two sessions', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())
      presence.observeActivity(ref({ sessionId: 'sess-2' }))

      const transitions = presence.expireCollaborator('collab-1', 'revoked')

      expect(transitions).toHaveLength(2)
      expect(transitions.filter((entry) => !entry.silent)).toHaveLength(1)
      expect(transitions[transitions.length - 1].membershipTo).toBe('absent')
    })

    it('ignores a repeated revoke', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())

      expect(presence.expireCollaborator('collab-1', 'revoked')).toHaveLength(1)
      expect(presence.expireCollaborator('collab-1', 'revoked')).toEqual([])
      expect(presence.expireSession('sess-1', 'revoked')).toBeNull()
      expect(presence.expireSession('never-existed', 'revoked')).toBeNull()
    })
  })

  describe('sweep', () => {
    it('does nothing before the window elapses', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())
      presence.noteGracefulLeave('sess-1', 10_000)

      expect(presence.sweep(10_000 + GRACE - 1)).toEqual([])
      expect(presence.sessionState('sess-1')).toBe('grace')
    })

    it('promotes grace -> expired exactly at the deadline and reports one leave', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())
      presence.noteGracefulLeave('sess-1', 10_000)

      const transitions = presence.sweep(10_000 + GRACE)

      expect(transitions).toHaveLength(1)
      expect(transitions[0].from).toBe('grace')
      expect(transitions[0].to).toBe('expired')
      expect(transitions[0].reason).toBe('graceExpired')
      expect(transitions[0].membershipFrom).toBe('present')
      expect(transitions[0].membershipTo).toBe('absent')
      expect(transitions[0].silent).toBe(false)
    })

    it('is idempotent — a second sweep produces nothing to emit', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())
      presence.noteGracefulLeave('sess-1', 10_000)

      expect(presence.sweep(10_000 + GRACE)).toHaveLength(1)
      expect(presence.sweep(10_000 + GRACE)).toEqual([])
      expect(presence.sweep(10_000 + GRACE + 5_000)).toEqual([])
    })

    it('reports the earliest deadline so the caller can arm one timer', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())
      presence.observeActivity(
        ref({ sessionId: 'sess-2', collaboratorId: 'collab-2', displayName: 'Sam' })
      )

      expect(presence.nextExpiryAt()).toBeNull()
      presence.noteGracefulLeave('sess-2', 10_400)
      presence.noteTransportClose('sess-1', 10_100)

      expect(presence.nextExpiryAt()).toBe(10_100 + GRACE)
    })
  })

  describe('multi-session resolution (best wins)', () => {
    it('keeps a collaborator live while ANY of their sessions is live', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())
      const second = presence.observeActivity(ref({ sessionId: 'sess-2' }))

      // A second concurrent session for someone already here is not a join.
      expect(second?.silent).toBe(true)

      presence.noteTransportClose('sess-1', 10_100)
      expect(presence.sessionState('sess-1')).toBe('grace')
      expect(presence.sessionState('sess-2')).toBe('live')
      expect(presence.collaboratorState('collab-1')).toBe('live')
      expect(presence.chatState('chat-1')).toBe('live')
    })

    it('falls to grace only when every session is grace, and expired when all are expired', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref())
      presence.observeActivity(ref({ sessionId: 'sess-2' }))

      presence.noteTransportClose('sess-1', 10_100)
      presence.noteGracefulLeave('sess-2', 10_200)
      expect(presence.collaboratorState('collab-1')).toBe('grace')

      const reaped = presence.sweep(10_200 + GRACE)
      expect(reaped).toHaveLength(2)
      expect(reaped.filter((entry) => !entry.silent)).toHaveLength(1)
      expect(presence.collaboratorState('collab-1')).toBe('expired')
    })

    it('rolls sessions up per collaborator for the host presence strip', () => {
      const clock = makeClock()
      const presence = makePresence(clock.now)
      presence.observeActivity(ref(), 10_000)
      presence.observeActivity(ref({ sessionId: 'sess-2' }), 10_300)
      presence.observeActivity(
        ref({ sessionId: 'sess-3', collaboratorId: 'collab-2', displayName: 'Sam' }),
        10_400
      )
      presence.noteTransportClose('sess-2', 10_500)

      const rows = presence.collaboratorsForChat('chat-1')
      expect(rows).toHaveLength(2)

      const dana = rows.find((row) => row.collaboratorId === 'collab-1')
      expect(dana?.state).toBe('live')
      expect(dana?.membership).toBe('present')
      expect(dana?.sessionIds).toEqual(['sess-2', 'sess-1'])
      expect(dana?.graceUntil).toBeUndefined()

      presence.noteTransportClose('sess-1', 10_600)
      const greyed = presence
        .collaboratorsForChat('chat-1')
        .find((row) => row.collaboratorId === 'collab-1')
      expect(greyed?.state).toBe('grace')
      expect(greyed?.graceUntil).toBe(10_600 + GRACE)

      expect(presence.collaboratorsForChat('chat-other')).toEqual([])
    })
  })

  describe('hostile clocks (never assume monotonic)', () => {
    it('never expires while the clock stands still', () => {
      const presence = makePresence(makeClock().now)
      presence.observeActivity(ref(), 10_000)
      presence.noteGracefulLeave('sess-1', 10_000)

      for (let i = 0; i < 5; i++) expect(presence.sweep(10_000)).toEqual([])
      expect(presence.sessionState('sess-1')).toBe('grace')
    })

    it('re-anchors instead of expiring when the clock jumps backwards', () => {
      const presence = makePresence(makeClock().now)
      presence.observeActivity(ref(), 10_000)
      presence.noteGracefulLeave('sess-1', 10_000)

      // NTP correction / wake-from-sleep: a negative age is never evidence of a
      // departure, so the window re-arms from the new "now".
      expect(presence.sweep(5_000)).toEqual([])
      expect(presence.sessionState('sess-1')).toBe('grace')
      expect(presence.nextExpiryAt()).toBe(5_000 + GRACE)

      expect(presence.sweep(5_000 + GRACE - 1)).toEqual([])
      expect(presence.sweep(5_000 + GRACE)).toHaveLength(1)
      expect(presence.sessionState('sess-1')).toBe('expired')
    })

    it('keeps lastSeenAt monotone so a stale stamp cannot rewind liveness', () => {
      const presence = makePresence(makeClock().now)
      presence.observeActivity(ref(), 10_000)
      presence.observeActivity(ref(), 9_000)

      expect(presence.snapshot()[0].lastSeenAt).toBe(10_000)
      expect(presence.sessionState('sess-1')).toBe('live')
    })

    it('survives a large forward jump by expiring on the very next sweep', () => {
      const presence = makePresence(makeClock().now)
      presence.observeActivity(ref(), 10_000)
      presence.noteGracefulLeave('sess-1', 10_000)

      expect(presence.sweep(Number.MAX_SAFE_INTEGER)).toHaveLength(1)
      expect(presence.sessionState('sess-1')).toBe('expired')
    })
  })

  describe('bookkeeping', () => {
    it('bounds retained expired tombstones', () => {
      const presence = makePresence(makeClock().now)
      const total = MAX_RETAINED_EXPIRED_PRESENCE_SESSIONS + 40
      for (let i = 0; i < total; i++) {
        presence.observeActivity(
          ref({ sessionId: `sess-${i}`, collaboratorId: `collab-${i}` }),
          10_000
        )
      }
      presence.expireShare('share-1', 'shareDisabled', 10_000)

      expect(presence.snapshot()).toHaveLength(MAX_RETAINED_EXPIRED_PRESENCE_SESSIONS)
    })

    it('forgets sessions and chats on request', () => {
      const presence = makePresence(makeClock().now)
      presence.observeActivity(ref(), 10_000)
      presence.observeActivity(ref({ sessionId: 'sess-2', chatId: 'chat-2' }), 10_000)

      expect(presence.forget('sess-1')).toBe(true)
      expect(presence.forget('sess-1')).toBe(false)
      expect(presence.sessionState('sess-1')).toBe('unknown')

      expect(presence.forgetChat('chat-2')).toBe(1)
      expect(presence.snapshot()).toEqual([])

      presence.observeActivity(ref(), 10_000)
      presence.reset()
      expect(presence.snapshot()).toEqual([])
      expect(presence.nextExpiryAt()).toBeNull()
    })

    it('defaults its clock to Date.now when none is injected', () => {
      const presence = new HumanCollaborationPresence({ graceMs: GRACE })
      const before = Date.now()
      presence.observeActivity(ref())
      const entry = presence.snapshot()[0]

      expect(entry.state).toBe('live')
      expect(entry.lastSeenAt).toBeGreaterThanOrEqual(before)
    })
  })
})
