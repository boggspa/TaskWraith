import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import {
  CHANNEL_HUMAN_REVIEW_RESOLVED_RETENTION_MS,
  ChannelHumanReviewError,
  ChannelHumanReviewStore,
  MAX_QUEUED_CHANNEL_HUMAN_REVIEWS_PER_MEMBER,
  channelHumanReviewPath
} from './ChannelHumanReviewStore'

const roots = new Set<string>()

function temporaryStore(): { root: string; path: string; store: ChannelHumanReviewStore } {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-channel-human-review-'))
  roots.add(root)
  const path = channelHumanReviewPath(root)
  return { root, path, store: new ChannelHumanReviewStore(path) }
}

function request(
  overrides: Partial<Parameters<ChannelHumanReviewStore['enqueue']>[0]> = {}
): Parameters<ChannelHumanReviewStore['enqueue']>[0] {
  return {
    channelId: 'channel_one',
    memberId: 'member_one',
    identityPublicKeyB64: 'identity_one',
    roomId: 'room_one',
    clientMessageId: 'client_one',
    content: 'Please review this contribution',
    now: 1_000,
    ...overrides
  }
}

function expectCode(action: () => unknown, code: ChannelHumanReviewError['code']): void {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(ChannelHumanReviewError)
    expect((error as ChannelHumanReviewError).code).toBe(code)
    return
  }
  throw new Error(`expected ChannelHumanReviewError ${code}`)
}

describe('ChannelHumanReviewStore', () => {
  it('persists queued work atomically and binds idempotency to exact member content', () => {
    const { root, path, store } = temporaryStore()
    try {
      const queued = store.enqueue(request())
      expect(queued).toMatchObject({
        outcome: 'queued',
        entry: {
          channelId: 'channel_one',
          memberId: 'member_one',
          clientMessageId: 'client_one',
          contentBytes: 31,
          state: 'queued',
          resolvedAt: null
        }
      })
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(new ChannelHumanReviewStore(path).list()).toEqual([queued.entry])

      const before = readFileSync(path)
      expect(store.enqueue(request())).toEqual({ outcome: 'duplicate', entry: queued.entry })
      expect(readFileSync(path)).toEqual(before)
      expectCode(
        () => store.enqueue(request({ content: 'different bytes' })),
        'idempotency_conflict'
      )
      expectCode(
        () => store.enqueue(request({ identityPublicKeyB64: 'different_identity' })),
        'idempotency_conflict'
      )
      expect(readFileSync(path)).toEqual(before)

      expect(
        store.enqueue(
          request({
            memberId: 'member:two',
            clientMessageId: 'same:delimiter',
            identityPublicKeyB64: 'identity_two',
            roomId: 'room_two'
          })
        ).outcome
      ).toBe('queued')
    } finally {
      rmSync(root, { recursive: true, force: true })
      roots.delete(root)
    }
  })

  it('makes approval durable before materialization and reruns both transitions exactly', () => {
    const { root, path, store } = temporaryStore()
    try {
      const queued = store.enqueue(request())
      if (!queued.entry) throw new Error('review entry missing')
      const approved = store.approve(queued.entry.reviewId, 2_000)
      expect(approved).toMatchObject({ state: 'approved', resolvedAt: 2_000 })
      expect(new ChannelHumanReviewStore(path).listAwaitingMaterialization()).toEqual([approved])

      const approvedBytes = readFileSync(path)
      expect(store.approve(queued.entry.reviewId, 3_000)).toEqual(approved)
      expect(readFileSync(path)).toEqual(approvedBytes)

      const materialized = store.markMaterialized(
        queued.entry.reviewId,
        { sequence: 7, messageId: 'message_seven' },
        4_000
      )
      expect(materialized).toMatchObject({
        state: 'materialized',
        materializedSequence: 7,
        materializedMessageId: 'message_seven'
      })
      expect(store.listAwaitingMaterialization()).toEqual([])
      const materializedBytes = readFileSync(path)
      expect(
        store.markMaterialized(
          queued.entry.reviewId,
          { sequence: 7, messageId: 'message_seven' },
          5_000
        )
      ).toEqual(materialized)
      expect(readFileSync(path)).toEqual(materializedBytes)
      expectCode(
        () =>
          store.markMaterialized(
            queued.entry.reviewId,
            { sequence: 8, messageId: 'message_eight' },
            5_000
          ),
        'idempotency_conflict'
      )
      expectCode(() => store.deny(queued.entry.reviewId, 'too late', 5_000), 'invalid_state')
      expect(new ChannelHumanReviewStore(path).get(queued.entry.reviewId)).toEqual(materialized)

      const expiring = store.enqueue(
        request({
          memberId: 'member_two',
          identityPublicKeyB64: 'identity_two',
          roomId: 'room_two',
          clientMessageId: 'client_two',
          now: 6_000,
          ttlMs: 100
        })
      )
      if (!expiring.entry) throw new Error('review entry missing')
      expectCode(() => store.approve(expiring.entry.reviewId, 6_100), 'invalid_state')
      expect(store.get(expiring.entry.reviewId)).toMatchObject({
        state: 'lapsed',
        resolutionReason: 'expired'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
      roots.delete(root)
    }
  })

  it('bounds each member queue without letting another member starve it', () => {
    const { root, store } = temporaryStore()
    try {
      for (let index = 0; index < MAX_QUEUED_CHANNEL_HUMAN_REVIEWS_PER_MEMBER; index += 1) {
        expect(
          store.enqueue(request({ clientMessageId: `member-one-${index}`, now: 1_000 + index }))
            .outcome
        ).toBe('queued')
      }
      expectCode(
        () => store.enqueue(request({ clientMessageId: 'member-one-overflow', now: 2_000 })),
        'quota_exceeded'
      )
      expect(
        store.enqueue(
          request({
            memberId: 'member_two',
            identityPublicKeyB64: 'identity_two',
            roomId: 'room_two',
            clientMessageId: 'member-two-one',
            now: 2_000
          })
        ).outcome
      ).toBe('queued')
    } finally {
      rmSync(root, { recursive: true, force: true })
      roots.delete(root)
    }
  })

  it('lapses only scoped unfinished work and never expires an approved recovery item', () => {
    const { root, path, store } = temporaryStore()
    try {
      const first = store.enqueue(request({ ttlMs: 1_000 }))
      const second = store.enqueue(
        request({
          memberId: 'member_two',
          identityPublicKeyB64: 'identity_two',
          roomId: 'room_two',
          clientMessageId: 'client_two',
          ttlMs: 1_000
        })
      )
      const otherChannel = store.enqueue(
        request({
          channelId: 'channel_two',
          memberId: 'member_three',
          identityPublicKeyB64: 'identity_three',
          roomId: 'room_three',
          clientMessageId: 'client_three',
          ttlMs: 1_000
        })
      )
      if (!first.entry || !second.entry || !otherChannel.entry) throw new Error('entry missing')
      store.approve(first.entry.reviewId, 1_500)

      expect(store.sweep(500)).toEqual([])
      expect(store.get(second.entry.reviewId)).toMatchObject({
        enqueuedAt: 500,
        expiresAt: 1_500
      })
      expect(
        store
          .sweep(1_500)
          .map((entry) => entry.reviewId)
          .sort()
      ).toEqual([second.entry.reviewId, otherChannel.entry.reviewId].sort())
      expect(store.get(first.entry.reviewId)?.state).toBe('approved')

      const fourth = store.enqueue(
        request({
          memberId: 'member_four',
          identityPublicKeyB64: 'identity_four',
          roomId: 'room_four',
          clientMessageId: 'client_four',
          now: 2_000
        })
      )
      if (!fourth.entry) throw new Error('entry missing')
      expect(
        store.lapse({ channelId: 'channel_one', memberId: 'member_four' }, 'member_revoked', 2_100)
      ).toEqual([expect.objectContaining({ reviewId: fourth.entry.reviewId, state: 'lapsed' })])
      expect(new ChannelHumanReviewStore(path).get(first.entry.reviewId)?.state).toBe('approved')
    } finally {
      rmSync(root, { recursive: true, force: true })
      roots.delete(root)
    }
  })

  it('retires resolved idempotency keys and erases both entries and tombstones by Channel', () => {
    const { root, store } = temporaryStore()
    try {
      const queued = store.enqueue(request())
      if (!queued.entry) throw new Error('entry missing')
      store.deny(queued.entry.reviewId, 'not accepted', 2_000)
      store.sweep(2_000 + CHANNEL_HUMAN_REVIEW_RESOLVED_RETENTION_MS + 1)
      expect(store.get(queued.entry.reviewId)).toBeNull()
      expect(store.findByClientMessageId('channel_one', 'member_one', 'client_one')).toBe('retired')
      expect(store.enqueue(request({ now: 99_000 })).outcome).toBe('duplicate_terminal')

      expect(store.purgeChannels(['channel_one'])).toBe(0)
      expect(store.findByClientMessageId('channel_one', 'member_one', 'client_one')).toBeNull()
      expect(store.enqueue(request({ now: 100_000 })).outcome).toBe('queued')
    } finally {
      rmSync(root, { recursive: true, force: true })
      roots.delete(root)
    }
  })

  it('fails corrupt or tampered state closed until explicit global erasure', () => {
    const { root, path, store } = temporaryStore()
    try {
      store.enqueue(request())
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        entries: Array<{ content: string }>
      }
      parsed.entries[0].content = 'tampered without updating the digest'
      writeFileSync(path, JSON.stringify(parsed), 'utf8')
      const corruptBytes = readFileSync(path)
      const corrupt = new ChannelHumanReviewStore(path)
      expectCode(() => corrupt.list(), 'recovery_blocked')
      expectCode(() => corrupt.enqueue(request()), 'recovery_blocked')
      expect(readFileSync(path)).toEqual(corruptBytes)

      corrupt.purgeAll()
      expect(existsSync(path)).toBe(false)
      expect(corrupt.list()).toEqual([])
      expect(corrupt.enqueue(request()).outcome).toBe('queued')
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
      roots.delete(root)
    }
  })

  it('rejects malformed inputs before writing any state', () => {
    const { root, path, store } = temporaryStore()
    try {
      expectCode(() => store.enqueue(request({ content: ' '.repeat(10) })), 'invalid')
      expectCode(() => store.enqueue(request({ clientMessageId: 'x'.repeat(201) })), 'invalid')
      expectCode(() => store.enqueue(request({ ttlMs: 0 })), 'invalid')
      expectCode(() => store.approve('missing-review', 1_000), 'not_found')
      expect(existsSync(path)).toBe(false)
      expect(() => channelHumanReviewPath(' relative ')).toThrow(ChannelHumanReviewError)
    } finally {
      rmSync(root, { recursive: true, force: true })
      roots.delete(root)
    }
  })
})
