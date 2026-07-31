import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXTERNAL_CONTRIBUTION_TTL_MS,
  ExternalContributionQueueStore,
  MAX_CONTRIBUTION_BYTES,
  MAX_CONTRIBUTION_CHARS,
  MAX_DEDUPE_TOMBSTONES,
  MAX_DENIED_BODIES_RETAINED,
  MAX_QUEUED_PER_COLLABORATOR,
  MAX_QUEUE_ENTRIES,
  MAX_SEQUENCE,
  RESOLVED_RETENTION_MS
} from './ExternalContributionQueueStore'
import type {
  ExternalContributionEnqueueResult,
  ExternalContributionEntry
} from './ExternalContributionQueueStore'

const tempDirs: string[] = []

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-external-queue-'))
  tempDirs.push(dir)
  return join(dir, 'external-contribution-queue.json')
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** A fixed, obviously-synthetic clock so every deadline in the suite is exact. */
const T0 = 1_000_000
const BODY = 'hello from outside'
const OLLY = 'ed25519:olly'
const BEA = 'ed25519:bea'
const CHURN = 'ed25519:churn'

/**
 * A NUL built with `String.fromCharCode`, never typed as a literal control
 * byte. A raw NUL in a source file makes grep classify the whole file as
 * binary and silently report NOTHING for every search against it, which is a
 * miserable thing to debug. The repo already uses this idiom in
 * HumanCollaborationContactsStore.test.ts.
 */
const NUL = String.fromCharCode(0)
/** ("a\0b", "c") and ("a", "b\0c") collide under a NUL-delimited key. */
const NUL_COLLABORATOR = `a${NUL}b`
const NUL_CLIENT_ID = `b${NUL}c`

/**
 * EVERY store in this suite gets an injected clock. `load()` now compacts, and
 * compaction measures `resolvedAt` against the store's own clock — so a
 * file-backed store left on the real `Date.now` would evict every
 * synthetically dated entry the instant it reopened, 55 years past its
 * retention window.
 */
function openStore(
  path?: string,
  log?: (line: string) => void,
  at: number = T0
): ExternalContributionQueueStore {
  return new ExternalContributionQueueStore(path, log, () => at)
}

type EnqueueArgs = Parameters<ExternalContributionQueueStore['enqueue']>[0]

function enqueue(
  store: ExternalContributionQueueStore,
  overrides: Partial<EnqueueArgs> = {}
): ExternalContributionEnqueueResult {
  return store.enqueue({
    chatId: 'chat-1',
    shareId: 'share-1',
    collaboratorId: OLLY,
    displayName: 'Olly',
    clientMessageId: 'cm-1',
    sequence: 1,
    body: BODY,
    now: T0,
    ...overrides
  })
}

/** Enqueue and narrow, so the tests never need `!` on a result that must succeed. */
function mustEnqueue(
  store: ExternalContributionQueueStore,
  overrides: Partial<EnqueueArgs> = {}
): ExternalContributionEntry {
  const result = enqueue(store, overrides)
  if (!result.entry) {
    throw new Error(`expected enqueue to succeed, got denial=${String(result.denial)}`)
  }
  return result.entry
}

function mustGet(
  store: ExternalContributionQueueStore,
  entryId: string
): ExternalContributionEntry {
  const entry = store.get(entryId)
  if (!entry) throw new Error(`expected an entry for ${entryId}`)
  return entry
}

/**
 * `'body' in entry`, not `entry.body === undefined`. The distinction is the
 * point of the retention rules: an entry that still carries a `body` key set to
 * `undefined` would round-trip through JSON as a re-serialised field and would
 * satisfy `toBeUndefined()` while the key was still there.
 */
function hasBody(entry: ExternalContributionEntry | null | undefined): boolean {
  if (!entry) throw new Error('expected an entry, got null/undefined')
  return 'body' in entry
}

function ids(entries: readonly ExternalContributionEntry[]): string[] {
  return entries.map((entry) => entry.clientMessageId)
}

/**
 * Enqueue-then-deny `count` times for one collaborator. Never leaves more than
 * one entry queued at a time, so this manufactures terminal entries without
 * touching the per-collaborator quota.
 */
function churnTerminals(
  store: ExternalContributionQueueStore,
  collaboratorId: string,
  count: number,
  clock: number
): void {
  for (let i = 0; i < count; i += 1) {
    const entry = mustEnqueue(store, {
      collaboratorId,
      displayName: 'Churn',
      clientMessageId: `churn-${i}`,
      sequence: i,
      body: `churned body ${i}`,
      now: clock + i
    })
    store.deny(entry.entryId, undefined, clock + i)
  }
}

/**
 * Mirrors the store's own key composition. Length-prefixed on BOTH the chatId
 * and the collaboratorId, which is what makes `purgeChats` able to find a
 * chat's bindings by prefix without a shorter chat id ever matching a longer
 * one.
 */
function tombstoneKey(chatId: string, collaboratorId: string, clientMessageId: string): string {
  return `${chatId.length}:${chatId}:${collaboratorId.length}:${collaboratorId}:${clientMessageId}`
}

/** A persisted record with every required field, for hand-edited-file cases. */
function fileEntry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    entryId: 'e-1',
    chatId: 'chat-1',
    shareId: 'share-1',
    collaboratorId: OLLY,
    displayName: 'Olly',
    clientMessageId: 'cm-1',
    sequence: 1,
    enqueuedAt: T0,
    expiresAt: T0 + 1000,
    bodyBytes: 0,
    state: 'queued',
    ...overrides
  }
}

function writeQueueFile(path: string, entries: unknown[]): void {
  writeFileSync(path, JSON.stringify({ version: 1, entries }))
}

describe('ExternalContributionQueueStore', () => {
  // ------------------------------------------------------------ the clock --

  it('routes every default `now` through the INJECTED clock, so nothing in the store measures against the wall clock', () => {
    const FAKE = 5_000_000
    const store = openStore(undefined, undefined, FAKE)
    const base = {
      chatId: 'chat-1',
      shareId: 'share-1',
      collaboratorId: OLLY,
      displayName: 'Olly',
      sequence: 1,
      body: BODY
    }

    const enqueued = store.enqueue({ ...base, clientMessageId: 'cm-approve' }).entry
    const toDeny = store.enqueue({ ...base, clientMessageId: 'cm-deny' }).entry
    const toLapse = store.enqueue({ ...base, clientMessageId: 'cm-lapse' }).entry
    if (!enqueued || !toDeny || !toLapse) throw new Error('expected three entries')

    expect(enqueued.enqueuedAt).toBe(FAKE)
    expect(enqueued.expiresAt).toBe(FAKE + EXTERNAL_CONTRIBUTION_TTL_MS)
    expect(store.approve(enqueued.entryId, 'msg-1')?.resolvedAt).toBe(FAKE)
    expect(store.deny(toDeny.entryId, 'no')?.resolvedAt).toBe(FAKE)
    expect(store.lapseAll({ chatIds: ['chat-1'] }, 'chatGone')[0]).toMatchObject({
      entryId: toLapse.entryId,
      resolvedAt: FAKE
    })

    const stale = mustEnqueue(store, { clientMessageId: 'cm-sweep', now: FAKE - 10, ttlMs: 1 })
    expect(store.sweep()[0]).toMatchObject({ entryId: stale.entryId, resolvedAt: FAKE })
  })

  it('compacts on LOAD as well as on write — the read path is the OTHER door into the same array', () => {
    const path = tempStorePath()
    const OVER = MAX_QUEUE_ENTRIES + 88
    const rows: unknown[] = []
    for (let i = 0; i < OVER; i += 1) {
      rows.push(
        fileEntry({
          entryId: `t-${i}`,
          collaboratorId: CHURN,
          clientMessageId: `t-${i}`,
          enqueuedAt: T0 + i,
          expiresAt: T0 + i + 1000,
          resolvedAt: T0 + i,
          state: 'denied'
        })
      )
    }
    // A queued contribution somebody is still waiting on, oldest of the lot.
    rows.push(fileEntry({ entryId: 'still-queued', clientMessageId: 'q', body: BODY }))
    writeQueueFile(path, rows)

    // A file this size cannot have been WRITTEN by this store — it takes a hand
    // edit or a bad merge. Loading it must still honour the cap.
    const store = openStore(path)
    expect(store.listForCollaborator(CHURN).length + store.listQueued().length).toBe(
      MAX_QUEUE_ENTRIES
    )
    // ...and a queued entry is never the one evicted, on the read path either.
    expect(store.get('still-queued')?.state).toBe('queued')
    expect(ids(store.listForCollaborator(CHURN))[0]).toBe(`t-${OVER - MAX_QUEUE_ENTRIES + 1}`)

    // Retention on load is measured against the INJECTED clock. Reopening the
    // same file a week and a bit later drops every receipt and keeps the work.
    const later = openStore(path, undefined, T0 + RESOLVED_RETENTION_MS + 1000)
    expect(later.listForCollaborator(CHURN)).toEqual([])
    expect(later.get('still-queued')?.state).toBe('queued')
  })

  // ---------------------------------------------------------------- dedupe --

  it('dedupes a retry on (collaboratorId, clientMessageId), creates nothing, and never lets the retry body overwrite the stored one', () => {
    const store = openStore()
    const first = mustEnqueue(store, { clientMessageId: 'cm-a', body: 'the original' })

    const retry = enqueue(store, { clientMessageId: 'cm-a', body: 'a DIFFERENT body' })
    expect(retry.ok).toBe(false)
    expect(retry.denial).toBe('duplicate')
    expect(retry.entry).toBeUndefined()
    expect(retry.existing?.entryId).toBe(first.entryId)
    // The retry is not an edit door: the stored body is untouched.
    expect(retry.existing?.body).toBe('the original')
    expect(store.listQueued()).toHaveLength(1)
    expect(store.listForCollaborator(OLLY)).toHaveLength(1)
  })

  it('holds the dedupe binding after the entry goes TERMINAL: a retry of an approved, denied or lapsed clientMessageId is still `duplicate`', () => {
    const store = openStore()

    const approved = mustEnqueue(store, { clientMessageId: 'cm-approved', sequence: 1 })
    store.approve(approved.entryId, 'msg-1', T0 + 1)
    const denied = mustEnqueue(store, { clientMessageId: 'cm-denied', sequence: 2 })
    store.deny(denied.entryId, 'no thanks', T0 + 1)
    mustEnqueue(store, { clientMessageId: 'cm-lapsed', sequence: 3, ttlMs: 1 })
    expect(store.sweep(T0 + 10)).toHaveLength(1)

    // A terminal entry is still the answer to its own clientMessageId. If the
    // binding only covered queued entries, a client retrying after a reconnect
    // would re-enqueue an already-approved message and double-post it.
    for (const [clientMessageId, state] of [
      ['cm-approved', 'approved'],
      ['cm-denied', 'denied'],
      ['cm-lapsed', 'lapsed']
    ] as const) {
      const retry = enqueue(store, { clientMessageId, body: 'retry after resolution' })
      expect(retry.ok).toBe(false)
      expect(retry.denial).toBe('duplicate')
      expect(retry.existing?.state).toBe(state)
    }
    expect(store.listForCollaborator(OLLY)).toHaveLength(3)
  })

  it('RETAINS the dedupe binding once compaction EVICTS the entry: a retry of an evicted APPROVED clientMessageId must never re-enqueue', () => {
    const store = openStore()
    // Already approved, already materialised — this message is in the transcript.
    const transcribed = mustEnqueue(store, {
      collaboratorId: CHURN,
      displayName: 'Churn',
      clientMessageId: 'already-in-the-transcript',
      sequence: 0,
      now: T0
    })
    store.approve(transcribed.entryId, 'msg-0', T0)
    store.markMaterialised(transcribed.entryId)
    churnTerminals(store, CHURN, MAX_QUEUE_ENTRIES + 1, T0 + 1)

    // The entry itself aged out of the store.
    expect(store.get(transcribed.entryId)).toBeNull()
    expect(ids(store.listForCollaborator(CHURN))).not.toContain('already-in-the-transcript')

    // The BINDING outlived it. Re-enqueueing would ask the host to approve
    // something already in the transcript, and approving would double-post it —
    // the one direction this file calls unrecoverable.
    const retry = enqueue(store, {
      collaboratorId: CHURN,
      displayName: 'Churn',
      clientMessageId: 'already-in-the-transcript',
      body: 'a retry after the entry aged out',
      now: T0 + 900_000
    })
    expect(retry.ok).toBe(false)
    expect(retry.denial).toBe('duplicate')
    // Nothing to hand back — only the binding survived, not the record.
    expect(retry.existing).toBeUndefined()
    expect(retry.entry).toBeUndefined()

    // The oldest churned receipt was evicted too, and is equally bound.
    expect(
      enqueue(store, {
        collaboratorId: CHURN,
        displayName: 'Churn',
        clientMessageId: 'churn-0',
        now: T0 + 900_001
      }).denial
    ).toBe('duplicate')

    // Tombstones are scoped exactly like the live binding: a DIFFERENT
    // collaborator's identical clientMessageId is still free.
    expect(
      enqueue(store, {
        collaboratorId: BEA,
        displayName: 'Bea',
        clientMessageId: 'already-in-the-transcript',
        now: T0 + 900_002
      }).ok
    ).toBe(true)
  })

  it('composes the tombstone key by LENGTH PREFIX, so no delimiter — printable or not — can be forged to collide with another binding', () => {
    const path = tempStorePath()
    // Three victims, oldest-resolved, so a three-over-cap file evicts exactly
    // these. Each is one half of a pair that collides under one delimiter.
    const rows: unknown[] = [
      fileEntry({
        entryId: 'victim-space',
        collaboratorId: 'a',
        clientMessageId: 'b c',
        state: 'denied',
        resolvedAt: T0
      }),
      fileEntry({
        entryId: 'victim-nul',
        collaboratorId: NUL_COLLABORATOR,
        clientMessageId: 'c',
        state: 'denied',
        enqueuedAt: T0 + 1,
        resolvedAt: T0 + 1
      }),
      fileEntry({
        entryId: 'victim-colon',
        collaboratorId: 'a:b',
        clientMessageId: 'c',
        state: 'denied',
        enqueuedAt: T0 + 2,
        resolvedAt: T0 + 2
      }),
      // Same collaborator, same clientMessageId, different CHAT.
      fileEntry({
        entryId: 'victim-chat',
        chatId: 'chat-A',
        clientMessageId: 'shared',
        state: 'denied',
        enqueuedAt: T0 + 3,
        resolvedAt: T0 + 3
      })
    ]
    for (let i = 1; i <= MAX_QUEUE_ENTRIES; i += 1) {
      rows.push(
        fileEntry({
          entryId: `e-${i}`,
          collaboratorId: CHURN,
          clientMessageId: `m-${i}`,
          enqueuedAt: T0 + 10 + i,
          expiresAt: T0 + 10 + i + 1000,
          resolvedAt: T0 + 10 + i,
          state: 'denied'
        })
      )
    }
    writeQueueFile(path, rows)

    const store = openStore(path)
    expect(store.get('victim-space')).toBeNull()
    expect(store.get('victim-nul')).toBeNull()
    expect(store.get('victim-colon')).toBeNull()
    expect(store.get('victim-chat')).toBeNull()

    // Each victim's OWN key is bound.
    expect(
      enqueue(store, { collaboratorId: 'a', clientMessageId: 'b c', now: T0 + 900_000 }).denial
    ).toBe('duplicate')
    expect(
      enqueue(store, { collaboratorId: NUL_COLLABORATOR, clientMessageId: 'c', now: T0 + 900_001 })
        .denial
    ).toBe('duplicate')
    expect(
      enqueue(store, { collaboratorId: 'a:b', clientMessageId: 'c', now: T0 + 900_002 }).denial
    ).toBe('duplicate')

    // For ANY delimiter D, ("a", "b" + D + "c") and ("a" + D + "b", "c") flatten
    // onto the same joined key. `clientMessageId` is supplied by the external
    // and validated for nothing but non-emptiness, so whichever D is chosen the
    // client can forge one half and get somebody else's contribution refused as
    // a duplicate of its own. A length prefix makes all of these impossible.

    // D = space.
    expect(
      enqueue(store, { collaboratorId: 'a b', clientMessageId: 'c', now: T0 + 900_003 }).ok
    ).toBe(true)
    // D = NUL — unprintable is no safer, and it makes grep treat the source as
    // binary into the bargain.
    expect(
      enqueue(store, { collaboratorId: 'a', clientMessageId: NUL_CLIENT_ID, now: T0 + 900_004 }).ok
    ).toBe(true)
    // D = ':', the character this key actually contains. The length prefix is
    // what makes reusing it as a separator safe; joining on it alone would not be.
    expect(
      enqueue(store, { collaboratorId: 'a', clientMessageId: 'b:c', now: T0 + 900_005 }).ok
    ).toBe(true)

    // The chatId is scoped too. The same person retrying the same
    // clientMessageId in a DIFFERENT chat is a different contribution, and a
    // key that omitted the chat would refuse it as a duplicate of the first.
    expect(
      enqueue(store, { chatId: 'chat-A', clientMessageId: 'shared', now: T0 + 900_006 }).denial
    ).toBe('duplicate')
    expect(
      enqueue(store, { chatId: 'chat-B', clientMessageId: 'shared', now: T0 + 900_007 }).ok
    ).toBe(true)
  })

  it('PERSISTS the tombstones, so the long-delayed retry they exist to refuse is still refused after a restart', () => {
    const path = tempStorePath()
    const rows: unknown[] = []
    // One over the cap, so loading evicts exactly the oldest-resolved entry.
    for (let i = 0; i <= MAX_QUEUE_ENTRIES; i += 1) {
      rows.push(
        fileEntry({
          entryId: `e-${i}`,
          collaboratorId: CHURN,
          clientMessageId: `m-${i}`,
          enqueuedAt: T0 + i,
          expiresAt: T0 + i + 1000,
          resolvedAt: T0 + i,
          state: 'approved',
          messageId: `msg-${i}`,
          materialised: true
        })
      )
    }
    writeQueueFile(path, rows)

    const first = openStore(path)
    expect(first.get('e-0')).toBeNull()
    expect(
      enqueue(first, {
        collaboratorId: CHURN,
        displayName: 'Churn',
        clientMessageId: 'm-0',
        now: T0 + 900_000
      }).denial
    ).toBe('duplicate')

    // The binding is in the SNAPSHOT, not just in memory — and load() wrote the
    // trim back on its own, without waiting for some unrelated verb to fire.
    const snapshot = JSON.parse(readFileSync(path, 'utf8'))
    expect(snapshot.entries).toHaveLength(MAX_QUEUE_ENTRIES)
    expect(snapshot.tombstones).toHaveLength(1)

    // A restart is exactly when this matters: `e-0` is long gone from the file,
    // so nothing on the read path could re-derive the binding from the entries.
    const reopened = openStore(path)
    const retry = enqueue(reopened, {
      collaboratorId: CHURN,
      displayName: 'Churn',
      clientMessageId: 'm-0',
      now: T0 + 900_001
    })
    expect(retry.ok).toBe(false)
    expect(retry.denial).toBe('duplicate')
    expect(retry.existing).toBeUndefined()

    // A different id from the same collaborator is still free, so the reloaded
    // set is the bindings themselves and not a blanket refusal.
    expect(
      enqueue(reopened, {
        collaboratorId: CHURN,
        displayName: 'Churn',
        clientMessageId: 'never-seen-before',
        now: T0 + 900_002
      }).ok
    ).toBe(true)
  })

  it('caps a persisted tombstone list on LOAD to the newest MAX_DEDUPE_TOMBSTONES, and survives junk in the array', () => {
    const path = tempStorePath()
    const JUNK: unknown[] = [null, 42, '', { key: 'x' }]
    const OVER = MAX_DEDUPE_TOMBSTONES + 200
    const tombstones: unknown[] = [...JUNK]
    for (let i = 0; i < OVER; i += 1) tombstones.push(tombstoneKey('chat-1', OLLY, `t-${i}`))
    writeFileSync(path, JSON.stringify({ version: 1, entries: [], tombstones }))

    const store = openStore(path)
    // The tail survives the slice...
    expect(enqueue(store, { clientMessageId: `t-${OVER - 1}`, now: T0 }).denial).toBe('duplicate')
    // ...and the head is what goes. The junk occupies slice positions too, so
    // the boundary is computed from the whole array, not just the real keys.
    const firstSurviving = tombstones.length - MAX_DEDUPE_TOMBSTONES - JUNK.length
    expect(enqueue(store, { clientMessageId: `t-${firstSurviving}`, now: T0 + 1 }).denial).toBe(
      'duplicate'
    )
    expect(enqueue(store, { clientMessageId: `t-${firstSurviving - 1}`, now: T0 + 2 }).ok).toBe(
      true
    )
    expect(enqueue(store, { clientMessageId: 't-0', now: T0 + 3 }).ok).toBe(true)
  })

  it('bounds the tombstone set and retires the OLDEST bindings first', () => {
    const path = tempStorePath()
    const TOMBSTONED = MAX_DEDUPE_TOMBSTONES + 400
    const rows: unknown[] = []
    for (let i = 0; i < TOMBSTONED; i += 1) {
      rows.push(
        fileEntry({
          entryId: `e-${i}`,
          clientMessageId: `m-${i}`,
          state: 'denied',
          resolvedAt: T0 + i
        })
      )
    }
    writeQueueFile(path, rows)

    // Reopened past the retention window: every record expires at once, so
    // every binding retires at once and the set overflows in a single pass.
    const store = openStore(path, undefined, T0 + RESOLVED_RETENTION_MS + TOMBSTONED)
    expect(store.listForCollaborator(OLLY)).toEqual([])

    const now = T0 + RESOLVED_RETENTION_MS + TOMBSTONED + 1
    const dropped = TOMBSTONED - MAX_DEDUPE_TOMBSTONES
    // The newest bindings are the ones kept...
    expect(enqueue(store, { clientMessageId: `m-${TOMBSTONED - 1}`, now }).denial).toBe('duplicate')
    expect(enqueue(store, { clientMessageId: `m-${dropped}`, now }).denial).toBe('duplicate')
    // ...and the oldest are the ones that go.
    expect(enqueue(store, { clientMessageId: 'm-0', now }).ok).toBe(true)
    expect(enqueue(store, { clientMessageId: `m-${dropped - 1}`, now }).ok).toBe(true)
  })

  it('treats the SAME clientMessageId from a DIFFERENT collaborator as a separate entry, never a duplicate', () => {
    const store = openStore()
    const olly = mustEnqueue(store, { collaboratorId: OLLY, clientMessageId: 'shared-id' })
    const bea = enqueue(store, {
      collaboratorId: BEA,
      displayName: 'Bea',
      clientMessageId: 'shared-id',
      body: 'bea speaking'
    })

    expect(bea.ok).toBe(true)
    expect(bea.denial).toBeUndefined()
    expect(bea.entry?.entryId).not.toBe(olly.entryId)
    expect(store.listQueued()).toHaveLength(2)
    expect(store.listForCollaborator(OLLY)).toHaveLength(1)
    expect(store.listForCollaborator(BEA)).toHaveLength(1)
    // Neither collaborator's entry is reachable through the other's list.
    expect(store.listForCollaborator(BEA)[0].body).toBe('bea speaking')
  })

  it('treats the SAME clientMessageId from the SAME collaborator in a DIFFERENT chat as a separate entry', () => {
    const store = openStore()
    const inChatOne = mustEnqueue(store, { chatId: 'chat-1', clientMessageId: 'shared-id' })
    const inChatTwo = enqueue(store, {
      chatId: 'chat-2',
      clientMessageId: 'shared-id',
      body: 'a different conversation'
    })

    // The scan must agree with the tombstone key and `findByClientMessageId`,
    // both of which are chat-scoped. A two-field scan silently refuses a
    // legitimate contribution the moment someone reuses a clientMessageId —
    // which a client that numbers its own messages per session will do.
    expect(inChatTwo.ok).toBe(true)
    expect(inChatTwo.denial).toBeUndefined()
    expect(inChatTwo.entry?.entryId).not.toBe(inChatOne.entryId)
    expect(store.listQueued('chat-1')).toHaveLength(1)
    expect(store.listQueued('chat-2')).toHaveLength(1)
    expect(store.findByClientMessageId('chat-1', OLLY, 'shared-id')?.entryId).toBe(
      inChatOne.entryId
    )
    expect(store.findByClientMessageId('chat-2', OLLY, 'shared-id')?.entryId).toBe(
      inChatTwo.entry?.entryId
    )
    // A real retry — same chat, same id — is still refused.
    const retry = enqueue(store, { chatId: 'chat-1', clientMessageId: 'shared-id' })
    expect(retry.denial).toBe('duplicate')
    expect(retry.existing?.entryId).toBe(inChatOne.entryId)
    expect(store.listForCollaborator(OLLY)).toHaveLength(2)
  })

  // ------------------------------------------------------------- size gate --

  it('rejects an over-size body as `too_large` and stores NOTHING — enqueue is the first durable write', () => {
    const store = openStore()
    const oversize = enqueue(store, { body: 'x'.repeat(MAX_CONTRIBUTION_CHARS + 1) })

    expect(oversize.ok).toBe(false)
    expect(oversize.denial).toBe('too_large')
    expect(oversize.entry).toBeUndefined()
    // Not stored in any state — a rejected body must leave no durable trace at
    // all, or the store becomes unbounded and attacker-controlled.
    expect(store.listQueued()).toEqual([])
    expect(store.listForCollaborator(OLLY)).toEqual([])
    expect(store.chatIdsWithQueued()).toEqual([])

    // The rejection did not consume the clientMessageId or leave a tombstone.
    const atLimit = enqueue(store, { body: 'x'.repeat(MAX_CONTRIBUTION_CHARS) })
    expect(atLimit.ok).toBe(true)
    expect(atLimit.entry?.bodyBytes).toBe(MAX_CONTRIBUTION_CHARS)
  })

  it('gates on BYTES as well as chars: CJK is under the char cap and still refused, and both caps stay reachable', () => {
    const store = openStore()
    // 4001 CJK characters is 4001 UTF-16 units — comfortably under the CHAR cap —
    // and 12 003 UTF-8 bytes, which is over the byte cap. A char gate alone
    // admits it, and the durable store ends up ~3x the size the constant implies.
    const overBytes = '一'.repeat(MAX_CONTRIBUTION_BYTES / 3 + 1)
    expect(overBytes.length).toBeLessThan(MAX_CONTRIBUTION_CHARS)
    expect(Buffer.byteLength(overBytes, 'utf8')).toBeGreaterThan(MAX_CONTRIBUTION_BYTES)
    expect(enqueue(store, { clientMessageId: 'cjk-over', body: overBytes }).denial).toBe(
      'too_large'
    )
    expect(store.listQueued()).toEqual([])

    // Exactly on the byte cap is admitted.
    const atBytes = '一'.repeat(MAX_CONTRIBUTION_BYTES / 3)
    const accepted = enqueue(store, { clientMessageId: 'cjk-at', body: atBytes })
    expect(accepted.ok).toBe(true)
    expect(accepted.entry?.bodyBytes).toBe(MAX_CONTRIBUTION_BYTES)

    // The CHAR cap is still load-bearing: ASCII trips it well before the byte cap.
    const overChars = 'x'.repeat(MAX_CONTRIBUTION_CHARS + 1)
    expect(Buffer.byteLength(overChars, 'utf8')).toBeLessThan(MAX_CONTRIBUTION_BYTES)
    expect(enqueue(store, { clientMessageId: 'ascii-over', body: overChars }).denial).toBe(
      'too_large'
    )
  })

  it('TRIMS the body before storing, measuring and gating it', () => {
    const store = openStore()
    const padded = mustEnqueue(store, { clientMessageId: 'padded', body: '  \n padded \t ' })
    expect(padded.body).toBe('padded')
    expect(padded.bodyBytes).toBe(6)
    expect(store.get(padded.entryId)?.body).toBe('padded')

    // The trim happens BEFORE the gate, so whitespace cannot push a legal body
    // over the cap — and cannot be used to pad the durable store either.
    const wrapped = ' '.repeat(500) + 'x'.repeat(MAX_CONTRIBUTION_CHARS) + ' '.repeat(500)
    expect(wrapped.length).toBeGreaterThan(MAX_CONTRIBUTION_CHARS)
    const accepted = enqueue(store, { clientMessageId: 'wrapped', body: wrapped })
    expect(accepted.ok).toBe(true)
    expect(accepted.entry?.body).toHaveLength(MAX_CONTRIBUTION_CHARS)
    expect(accepted.entry?.bodyBytes).toBe(MAX_CONTRIBUTION_CHARS)

    // Whitespace-only is still `invalid`, not an empty stored body.
    expect(enqueue(store, { clientMessageId: 'blank', body: '  \n\t ' }).denial).toBe('invalid')
  })

  it('rejects structurally invalid enqueues as `invalid` and stores nothing', () => {
    const store = openStore()
    const cases: Array<Partial<EnqueueArgs>> = [
      { chatId: '' },
      { shareId: '' },
      { collaboratorId: '' },
      { clientMessageId: '' },
      { body: '' },
      { body: '   \n\t  ' },
      { body: 42 as unknown as string }
    ]
    for (const overrides of cases) {
      const result = enqueue(store, overrides)
      expect(result.ok).toBe(false)
      expect(result.denial).toBe('invalid')
    }
    expect(store.listQueued()).toEqual([])
  })

  // ----------------------------------------------------------------- quota --

  it('bounds the queue PER COLLABORATOR: one external filling its slots must never starve the other', () => {
    const store = openStore()
    for (let i = 0; i < MAX_QUEUED_PER_COLLABORATOR; i += 1) {
      expect(
        enqueue(store, { collaboratorId: OLLY, clientMessageId: `olly-${i}`, now: T0 + i }).ok
      ).toBe(true)
    }

    const over = enqueue(store, {
      collaboratorId: OLLY,
      clientMessageId: 'olly-over',
      now: T0 + 99
    })
    expect(over.ok).toBe(false)
    expect(over.denial).toBe('quota_exceeded')
    expect(over.entry).toBeUndefined()
    expect(store.listForCollaborator(OLLY)).toHaveLength(MAX_QUEUED_PER_COLLABORATOR)

    // THE POINT: the other collaborator on the same share is unaffected. A
    // global cap here would let either external silently deny the other.
    for (let i = 0; i < MAX_QUEUED_PER_COLLABORATOR; i += 1) {
      const bea = enqueue(store, {
        collaboratorId: BEA,
        displayName: 'Bea',
        clientMessageId: `bea-${i}`,
        now: T0 + 100 + i
      })
      expect(bea.ok).toBe(true)
      expect(bea.denial).toBeUndefined()
    }
    expect(store.listForCollaborator(BEA)).toHaveLength(MAX_QUEUED_PER_COLLABORATOR)
    expect(store.listQueued()).toHaveLength(MAX_QUEUED_PER_COLLABORATOR * 2)
  })

  it('frees a quota slot when an entry is resolved — approve, deny and lapse all count', () => {
    const store = openStore()
    const entries: ExternalContributionEntry[] = []
    for (let i = 0; i < MAX_QUEUED_PER_COLLABORATOR; i += 1) {
      entries.push(mustEnqueue(store, { clientMessageId: `olly-${i}`, now: T0 + i }))
    }
    expect(enqueue(store, { clientMessageId: 'blocked-1' }).denial).toBe('quota_exceeded')

    store.deny(entries[0].entryId, 'no', T0 + 500)
    expect(enqueue(store, { clientMessageId: 'after-deny', now: T0 + 501 }).ok).toBe(true)
    expect(enqueue(store, { clientMessageId: 'blocked-2' }).denial).toBe('quota_exceeded')

    store.approve(entries[1].entryId, 'msg-1', T0 + 502)
    expect(enqueue(store, { clientMessageId: 'after-approve', now: T0 + 503 }).ok).toBe(true)
    expect(enqueue(store, { clientMessageId: 'blocked-3' }).denial).toBe('quota_exceeded')

    store.lapseAll({ chatIds: ['chat-1'] }, 'chatGone', T0 + 504)
    expect(store.listQueued()).toEqual([])
    expect(enqueue(store, { clientMessageId: 'after-lapse', now: T0 + 505 }).ok).toBe(true)
  })

  it('queuedCountForCollaborator counts only QUEUED entries, for that collaborator, in that chat', () => {
    const store = openStore()
    // Exists so a caller can refuse BEFORE allocating a sequence number, which
    // is only safe if the count agrees with what enqueue would have decided.
    expect(store.queuedCountForCollaborator('chat-1', OLLY)).toBe(0)

    mustEnqueue(store, { chatId: 'chat-1', clientMessageId: 'a', now: T0 })
    mustEnqueue(store, { chatId: 'chat-1', clientMessageId: 'b', now: T0 + 1 })
    expect(store.queuedCountForCollaborator('chat-1', OLLY)).toBe(2)

    // Another chat, another collaborator: neither is this collaborator's
    // pending load in this chat.
    mustEnqueue(store, { chatId: 'chat-2', clientMessageId: 'c', now: T0 + 2 })
    mustEnqueue(store, {
      chatId: 'chat-1',
      collaboratorId: BEA,
      displayName: 'Bea',
      clientMessageId: 'd',
      now: T0 + 3
    })
    expect(store.queuedCountForCollaborator('chat-1', OLLY)).toBe(2)
    expect(store.queuedCountForCollaborator('chat-2', OLLY)).toBe(1)
    expect(store.queuedCountForCollaborator('chat-1', BEA)).toBe(1)

    // Resolution frees the slot, exactly as the quota does: a denied, approved
    // or lapsed entry is a receipt, not pending work.
    const denied = mustEnqueue(store, { chatId: 'chat-1', clientMessageId: 'e', now: T0 + 4 })
    expect(store.queuedCountForCollaborator('chat-1', OLLY)).toBe(3)
    store.deny(denied.entryId, 'no', T0 + 5)
    expect(store.queuedCountForCollaborator('chat-1', OLLY)).toBe(2)
    store.lapseAll({ chatIds: ['chat-1'], collaboratorId: OLLY }, 'chatGone', T0 + 6)
    expect(store.queuedCountForCollaborator('chat-1', OLLY)).toBe(0)
    expect(store.queuedCountForCollaborator('chat-2', OLLY)).toBe(1)
  })

  // ------------------------------------------------------------ compaction --

  it('NEVER evicts a queued entry to make room: overflow takes the oldest RESOLVED terminal entries only', () => {
    const store = openStore()
    const PENDING = 5
    const CHURN_COUNT = 600

    // Five contributions somebody is actually waiting on, enqueued FIRST so
    // they are also the oldest entries in the store by every ordering.
    const pending: ExternalContributionEntry[] = []
    for (let i = 0; i < PENDING; i += 1) {
      pending.push(
        mustEnqueue(store, {
          collaboratorId: 'ed25519:pending',
          displayName: 'Pending',
          clientMessageId: `pending-${i}`,
          sequence: i,
          body: `waiting on review ${i}`,
          now: T0 + i
        })
      )
    }
    churnTerminals(store, CHURN, CHURN_COUNT, T0 + 1000)

    // Every queued entry survived, body and all.
    const queued = store.listQueued()
    expect(queued).toHaveLength(PENDING)
    expect(ids(queued)).toEqual(pending.map((entry) => entry.clientMessageId))
    for (let i = 0; i < PENDING; i += 1) {
      expect(queued[i].body).toBe(`waiting on review ${i}`)
      expect(store.get(pending[i].entryId)?.state).toBe('queued')
    }

    // The cap held, and it held by dropping terminal receipts oldest-resolved
    // first — never the pending work.
    const terminal = store.listForCollaborator(CHURN)
    expect(terminal).toHaveLength(MAX_QUEUE_ENTRIES - PENDING)
    expect(queued.length + terminal.length).toBe(MAX_QUEUE_ENTRIES)
    expect(terminal.every((entry) => entry.state === 'denied')).toBe(true)
    const firstSurvivor = CHURN_COUNT - (MAX_QUEUE_ENTRIES - PENDING)
    expect(terminal[0].clientMessageId).toBe(`churn-${firstSurvivor}`)
    expect(terminal[terminal.length - 1].clientMessageId).toBe(`churn-${CHURN_COUNT - 1}`)
    expect(ids(terminal)).not.toContain(`churn-${firstSurvivor - 1}`)
    expect(ids(terminal)).not.toContain('churn-0')
  })

  it('bounds how many DENIED bodies are retained: older denials keep the RECORD and lose the expensive part', () => {
    const store = openStore()
    const denied: ExternalContributionEntry[] = []
    for (let i = 0; i < MAX_DENIED_BODIES_RETAINED + 5; i += 1) {
      const entry = mustEnqueue(store, {
        clientMessageId: `d-${i}`,
        sequence: i,
        body: `denied body ${i}`,
        now: T0 + i
      })
      store.deny(entry.entryId, `reason ${i}`, T0 + i)
      denied.push(entry)
    }
    // A queued contribution and an approved-but-unmaterialised one, which this
    // bound must not touch: the second is the only copy of a message that has
    // not reached the transcript yet.
    const stillQueued = mustEnqueue(store, {
      collaboratorId: BEA,
      displayName: 'Bea',
      clientMessageId: 'queued',
      body: 'waiting on review',
      now: T0 + 900
    })
    const awaiting = mustEnqueue(store, {
      collaboratorId: BEA,
      displayName: 'Bea',
      clientMessageId: 'awaiting',
      body: 'approved but not yet written',
      now: T0 + 901
    })
    store.approve(awaiting.entryId, 'msg-1', T0 + 902)

    // `deny` does not compact; the next enqueue or sweep is what trims.
    store.sweep(T0 + 1000)

    const rows = store.listForCollaborator(OLLY)
    expect(rows).toHaveLength(MAX_DENIED_BODIES_RETAINED + 5)
    // Every RECORD survives, so the person can still be told what happened.
    expect(rows.every((row) => row.state === 'denied')).toBe(true)
    expect(rows.every((row) => typeof row.hostReason === 'string')).toBe(true)
    expect(rows.every((row) => row.bodyBytes > 0)).toBe(true)

    // Only the most recently resolved keep the body for edit-and-requeue.
    const withBody = rows.filter((row) => 'body' in row)
    expect(withBody).toHaveLength(MAX_DENIED_BODIES_RETAINED)
    expect(ids(withBody)).toEqual(denied.slice(5).map((entry) => entry.clientMessageId))
    expect(hasBody(store.get(denied[0].entryId))).toBe(false)
    expect(hasBody(store.get(denied[4].entryId))).toBe(false)
    expect(store.get(denied[5].entryId)?.body).toBe('denied body 5')

    // Queued and approved-unmaterialised bodies are out of scope for this bound.
    expect(store.get(stillQueued.entryId)?.body).toBe('waiting on review')
    expect(store.listAwaitingMaterialisation()[0].body).toBe('approved but not yet written')
  })

  // -------------------------------------------------------- body retention --

  it('retains the body while `queued` and after a `denied` — a denial is editable and requeueable', () => {
    const store = openStore()
    const entry = mustEnqueue(store, { body: 'the contribution' })
    expect(hasBody(store.get(entry.entryId))).toBe(true)
    expect(store.get(entry.entryId)?.body).toBe('the contribution')

    const denied = store.deny(entry.entryId, 'not now', T0 + 5)
    expect(denied?.state).toBe('denied')
    // The collaborator's own draft is ephemeral React state a reload destroys,
    // so this copy is the only one left. Dropping it here would make a denied
    // message unrecoverable.
    expect(hasBody(denied)).toBe(true)
    expect(denied?.body).toBe('the contribution')
    expect(store.get(entry.entryId)?.body).toBe('the contribution')
    expect(store.listForCollaborator(OLLY)[0].body).toBe('the contribution')
  })

  it('DROPS the body key on `lapsed` and on markMaterialised — the key is absent, not present-and-undefined', () => {
    const store = openStore()
    const multibyte = 'contribution \u{1F4A5}'
    const expectedBytes = Buffer.byteLength(multibyte, 'utf8')

    const sweptAway = mustEnqueue(store, {
      clientMessageId: 'cm-sweep',
      body: multibyte,
      ttlMs: 1
    })
    const revoked = mustEnqueue(store, { clientMessageId: 'cm-revoke', body: multibyte })
    const materialised = mustEnqueue(store, { clientMessageId: 'cm-material', body: multibyte })

    const lapsedBySweep = store.sweep(T0 + 10)
    expect(hasBody(lapsedBySweep[0])).toBe(false)
    expect(hasBody(store.get(sweptAway.entryId))).toBe(false)

    const lapsedByRevoke = store.lapseAll({ collaboratorId: OLLY }, 'revoked', T0 + 11)
    expect(ids(lapsedByRevoke)).toEqual(['cm-revoke', 'cm-material'])
    expect(lapsedByRevoke.every((entry) => !('body' in entry))).toBe(true)
    expect(hasBody(store.get(revoked.entryId))).toBe(false)

    // markMaterialised needs a fresh entry: the one above is lapsed now.
    const fresh = mustEnqueue(store, { clientMessageId: 'cm-material-2', body: multibyte })
    store.approve(fresh.entryId, 'msg-9', T0 + 12)
    const done = store.markMaterialised(fresh.entryId)
    expect(hasBody(done)).toBe(false)
    expect(hasBody(store.get(fresh.entryId))).toBe(false)
    expect(hasBody(store.get(materialised.entryId))).toBe(false)

    // bodyBytes outlives the body so an audit can still answer "how big was it",
    // and it counts UTF-8 bytes, not JS chars.
    expect(expectedBytes).toBeGreaterThan(multibyte.length)
    for (const entryId of [sweptAway.entryId, revoked.entryId, fresh.entryId]) {
      expect(store.get(entryId)?.bodyBytes).toBe(expectedBytes)
    }
  })

  // --------------------------------------------- approve / materialisation --

  it('approve() keeps the body and only markMaterialised() drops it — the two writes cannot be made atomic', () => {
    const store = openStore()
    const entry = mustEnqueue(store, { body: 'the contribution' })

    const approved = store.approve(entry.entryId, 'msg-77', T0 + 5)
    expect(approved).toMatchObject({
      state: 'approved',
      messageId: 'msg-77',
      resolvedAt: T0 + 5,
      materialised: false
    })
    // The caller still has to write the transcript row; the body must survive
    // long enough for it to do so.
    expect(approved?.body).toBe('the contribution')
    expect(store.get(entry.entryId)?.body).toBe('the contribution')
    expect(store.listAwaitingMaterialisation().map((row) => row.entryId)).toEqual([entry.entryId])

    const done = store.markMaterialised(entry.entryId)
    expect(done?.materialised).toBe(true)
    expect(hasBody(done)).toBe(false)
    expect(store.listAwaitingMaterialisation()).toEqual([])

    // Idempotent, and never a door out of any other state.
    expect(store.markMaterialised(entry.entryId)?.materialised).toBe(true)
    expect(store.listAwaitingMaterialisation()).toEqual([])
    const stillQueued = mustEnqueue(store, { clientMessageId: 'cm-2' })
    expect(store.markMaterialised(stillQueued.entryId)).toBeNull()
    expect(store.markMaterialised('no-such-entry')).toBeNull()
  })

  it('recovers a crash landed BETWEEN approve and materialise: after a restart the entry is still awaiting materialisation with its body intact', () => {
    const path = tempStorePath()
    let store: ExternalContributionQueueStore | null = openStore(path)
    const entry = mustEnqueue(store, { body: 'survives the crash' })
    const approved = store.approve(entry.entryId, 'msg-88', T0 + 5)
    expect(approved?.materialised).toBe(false)

    // The process dies here. The transcript row was never written.
    store = null
    expect(store).toBeNull()

    const recovered = openStore(path, undefined, T0 + 6)
    const awaiting = recovered.listAwaitingMaterialisation()
    expect(awaiting).toHaveLength(1)
    expect(awaiting[0]).toMatchObject({
      entryId: entry.entryId,
      state: 'approved',
      messageId: 'msg-88',
      materialised: false,
      // Without this the reconciler has an approved entry and nothing to
      // re-append — the whole reason the field exists.
      body: 'survives the crash'
    })

    recovered.markMaterialised(entry.entryId)
    expect(recovered.listAwaitingMaterialisation()).toEqual([])
    expect(openStore(path, undefined, T0 + 7).listAwaitingMaterialisation()).toEqual([])
    // The dropped body did not come back through the file either.
    expect(hasBody(openStore(path, undefined, T0 + 7).get(entry.entryId))).toBe(false)
  })

  // ----------------------------------------------------------- transitions --

  it('makes approve and deny one-way and queued-only: a double-approve returns null and never re-resolves the entry', () => {
    const store = openStore()

    const approved = mustEnqueue(store, { clientMessageId: 'cm-approved' })
    expect(store.approve(approved.entryId, 'msg-1', T0 + 1)).not.toBeNull()
    expect(store.approve(approved.entryId, 'msg-2', T0 + 2)).toBeNull()
    expect(store.get(approved.entryId)).toMatchObject({
      state: 'approved',
      messageId: 'msg-1',
      resolvedAt: T0 + 1
    })
    // Deny is NOT queued-only any more, and deliberately so: approval releases
    // a message, it does not deliver it, and a muted seat holds an approved
    // contribution indefinitely. The host is offered Decline on exactly those
    // rows, so requiring 'queued' made that button a silent no-op.
    expect(store.deny(approved.entryId, 'changed my mind', T0 + 3)).toMatchObject({
      state: 'denied',
      hostReason: 'changed my mind'
    })
    expect(store.get(approved.entryId)?.materialised).toBeUndefined()

    // Once DELIVERED, it is genuinely one-way — the row is in the transcript
    // and quoted into prompts, and this store cannot unsay it.
    const delivered = mustEnqueue(store, { clientMessageId: 'cm-delivered' })
    store.approve(delivered.entryId, 'msg-d', T0 + 1)
    store.markMaterialised(delivered.entryId)
    expect(store.deny(delivered.entryId, 'too late', T0 + 2)).toBeNull()
    expect(store.get(delivered.entryId)?.state).toBe('approved')

    const denied = mustEnqueue(store, { clientMessageId: 'cm-denied' })
    expect(store.deny(denied.entryId, '  spammy  ', T0 + 1)).toMatchObject({
      state: 'denied',
      hostReason: 'spammy',
      resolvedAt: T0 + 1
    })
    expect(store.deny(denied.entryId, 'again', T0 + 2)).toBeNull()
    expect(store.approve(denied.entryId, 'msg-3', T0 + 2)).toBeNull()
    expect(store.get(denied.entryId)?.hostReason).toBe('spammy')

    const lapsed = mustEnqueue(store, { clientMessageId: 'cm-lapsed' })
    store.lapseAll({ collaboratorId: OLLY }, 'shareEnded', T0 + 3)
    expect(store.get(lapsed.entryId)?.state).toBe('lapsed')
    expect(store.approve(lapsed.entryId, 'msg-4', T0 + 4)).toBeNull()
    expect(store.deny(lapsed.entryId, 'x', T0 + 4)).toBeNull()

    // An approve with no messageId is a no-op, not a half-resolved entry.
    const spare = mustEnqueue(store, { clientMessageId: 'cm-spare' })
    expect(store.approve(spare.entryId, '', T0 + 5)).toBeNull()
    expect(store.get(spare.entryId)?.state).toBe('queued')
    expect(store.get(spare.entryId)?.resolvedAt).toBeUndefined()
    expect(store.approve('no-such-entry', 'msg', T0 + 5)).toBeNull()
    expect(store.deny('no-such-entry', 'x', T0 + 5)).toBeNull()

    // A blank host reason is not stored, and a long one is bounded.
    expect(store.deny(spare.entryId, '    ', T0 + 6)?.state).toBe('denied')
    expect(store.get(spare.entryId)?.hostReason).toBeUndefined()
    const verbose = mustEnqueue(store, { clientMessageId: 'cm-verbose' })
    expect(store.deny(verbose.entryId, 'x'.repeat(900), T0 + 7)?.hostReason).toHaveLength(500)
  })

  // ----------------------------------------------------------------- sweep --

  it('sweep() RE-ANCHORS on a clock that moved BACKWARD instead of expiring — a wake-from-sleep or an NTP correction must never lapse the whole queue at once', () => {
    const store = openStore()
    const first = mustEnqueue(store, { clientMessageId: 'cm-a', now: T0, sequence: 1 })
    const second = mustEnqueue(store, { clientMessageId: 'cm-b', now: T0, sequence: 2 })
    expect(first.expiresAt).toBe(T0 + EXTERNAL_CONTRIBUTION_TTL_MS)

    // The wall clock jumps back to 1000. A NEGATIVE elapsed time is not
    // evidence that a deadline passed.
    expect(store.sweep(1000)).toEqual([])

    const queued = store.listQueued()
    expect(queued).toHaveLength(2)
    for (const entry of queued) {
      expect(entry.state).toBe('queued')
      expect(entry.lapseReason).toBeUndefined()
      expect(entry.body).toBe(BODY)
      // Re-anchored, not merely skipped: the deadline MOVED so the remaining
      // TTL is preserved exactly.
      expect(entry.enqueuedAt).toBe(1000)
      expect(entry.expiresAt).toBe(1000 + EXTERNAL_CONTRIBUTION_TTL_MS)
      expect(entry.expiresAt - entry.enqueuedAt).toBe(EXTERNAL_CONTRIBUTION_TTL_MS)
    }
    expect(store.get(second.entryId)?.state).toBe('queued')

    // The re-anchored deadline is a real deadline, not an amnesty.
    expect(store.sweep(1000 + EXTERNAL_CONTRIBUTION_TTL_MS - 1)).toEqual([])
    expect(ids(store.sweep(1000 + EXTERNAL_CONTRIBUTION_TTL_MS)).sort()).toEqual(['cm-a', 'cm-b'])
  })

  it('PERSISTS a backward-clock re-anchor, so the correction survives a restart instead of reaching disk by accident', () => {
    const path = tempStorePath()
    const store = openStore(path)
    const entry = mustEnqueue(store, { now: T0 })
    expect(store.sweep(1000)).toEqual([])

    // Nothing lapsed, so an `if (lapsed.length)` persist would leave the
    // correction in memory only — and whether it survived a restart would
    // depend on whether somebody happened to approve something afterwards.
    const reopened = openStore(path, undefined, 1000)
    const reloaded = mustGet(reopened, entry.entryId)
    expect(reloaded.enqueuedAt).toBe(1000)
    expect(reloaded.expiresAt).toBe(1000 + EXTERNAL_CONTRIBUTION_TTL_MS)
    // The load-time clamp does not undo it: the re-anchored deadline is exactly
    // one TTL out from the re-anchored arrival, which is the clamp ceiling.
    expect(reopened.sweep(1000 + EXTERNAL_CONTRIBUTION_TTL_MS)).toHaveLength(1)
  })

  it('sweep() lapses only past-deadline QUEUED entries, returns them, and is idempotent', () => {
    const store = openStore()
    const soon = mustEnqueue(store, { clientMessageId: 'cm-soon', ttlMs: 100, sequence: 1 })
    const later = mustEnqueue(store, { clientMessageId: 'cm-later', ttlMs: 100_000, sequence: 2 })
    const denied = mustEnqueue(store, { clientMessageId: 'cm-denied', ttlMs: 1, sequence: 3 })
    store.deny(denied.entryId, 'no thanks', T0)

    // Exactly ON the deadline expires: `now < expiresAt` is the survival test.
    const lapsed = store.sweep(T0 + 100)
    expect(ids(lapsed)).toEqual(['cm-soon'])
    expect(lapsed[0]).toMatchObject({
      state: 'lapsed',
      lapseReason: 'expired',
      resolvedAt: T0 + 100
    })
    expect(hasBody(lapsed[0])).toBe(false)
    expect(store.get(soon.entryId)?.state).toBe('lapsed')
    expect(store.get(later.entryId)?.state).toBe('queued')
    expect(store.get(later.entryId)?.body).toBe(BODY)

    // A terminal entry long past its deadline is never re-resolved, and its
    // denied body is not collateral damage.
    expect(store.get(denied.entryId)).toMatchObject({
      state: 'denied',
      hostReason: 'no thanks',
      resolvedAt: T0,
      body: BODY
    })

    expect(store.sweep(T0 + 100)).toEqual([])
    expect(store.sweep(T0 + 101)).toEqual([])
    expect(store.get(soon.entryId)?.resolvedAt).toBe(T0 + 100)
    expect(ids(store.sweep(T0 + 100_000))).toEqual(['cm-later'])
  })

  // -------------------------------------------------------------- lapseAll --

  it('lapseAll by shareId, by collaboratorId and by chatIds each touches only its own filter and only QUEUED entries', () => {
    const store = openStore()
    const place = (shareId: string, chatId: string, collaboratorId: string, id: string): void => {
      mustEnqueue(store, { shareId, chatId, collaboratorId, clientMessageId: id })
    }
    place('share-1', 'chat-1', OLLY, 'a')
    place('share-1', 'chat-2', BEA, 'b')
    place('share-2', 'chat-3', OLLY, 'c')
    place('share-2', 'chat-3', BEA, 'd')
    const alreadyDenied = mustEnqueue(store, {
      shareId: 'share-1',
      chatId: 'chat-1',
      collaboratorId: OLLY,
      clientMessageId: 'already-denied'
    })
    store.deny(alreadyDenied.entryId, 'no', T0)

    const byShare = store.lapseAll({ shareId: 'share-1' }, 'shareEnded', T0 + 1)
    expect(ids(byShare).sort()).toEqual(['a', 'b'])
    expect(byShare.every((entry) => entry.lapseReason === 'shareEnded')).toBe(true)
    expect(byShare.every((entry) => entry.resolvedAt === T0 + 1)).toBe(true)
    expect(byShare.every((entry) => !('body' in entry))).toBe(true)
    // Already terminal: untouched, reason and body preserved.
    expect(store.get(alreadyDenied.entryId)).toMatchObject({
      state: 'denied',
      hostReason: 'no',
      body: BODY
    })
    expect(ids(store.listQueued()).sort()).toEqual(['c', 'd'])

    const byCollaborator = store.lapseAll({ collaboratorId: OLLY }, 'revoked', T0 + 2)
    expect(ids(byCollaborator)).toEqual(['c'])
    expect(byCollaborator[0].lapseReason).toBe('revoked')
    expect(ids(store.listQueued())).toEqual(['d'])

    const byChat = store.lapseAll({ chatIds: ['chat-3', 'chat-nowhere'] }, 'chatGone', T0 + 3)
    expect(ids(byChat)).toEqual(['d'])
    expect(byChat[0].lapseReason).toBe('chatGone')
    expect(store.listQueued()).toEqual([])

    // Filters compose: a share/collaborator pair that matches nothing lapses nothing.
    const survivor = mustEnqueue(store, { chatId: 'chat-9', clientMessageId: 'survivor' })
    expect(store.lapseAll({ shareId: 'share-1', collaboratorId: BEA }, 'revoked', T0 + 5)).toEqual(
      []
    )
    expect(store.get(survivor.entryId)?.state).toBe('queued')
  })

  it('REFUSES a lapseAll filter with no effective predicate — `lapseAll({ shareId: share?.id })` must never wipe the whole queue', () => {
    const lines: string[] = []
    const store = openStore(undefined, (line) => lines.push(line))
    mustEnqueue(store, { shareId: 'share-1', chatId: 'chat-1', clientMessageId: 'a' })
    mustEnqueue(store, {
      shareId: 'share-2',
      chatId: 'chat-2',
      collaboratorId: BEA,
      displayName: 'Bea',
      clientMessageId: 'b'
    })

    // Every field is optional, so an undefined share id is the most natural way
    // anyone will call this — and it used to mean "everything, everywhere".
    const noPredicate = [
      {},
      { shareId: undefined },
      { collaboratorId: undefined },
      { shareId: '' },
      { collaboratorId: '' },
      { chatIds: [] },
      { shareId: undefined, collaboratorId: undefined, chatIds: [] }
    ]
    for (const filter of noPredicate) {
      expect(store.lapseAll(filter, 'shareEnded', T0 + 1)).toEqual([])
    }
    expect(ids(store.listQueued()).sort()).toEqual(['a', 'b'])
    expect(store.listQueued().every((entry) => entry.state === 'queued')).toBe(true)
    expect(lines.filter((line) => line.includes('lapseAll refused'))).toHaveLength(
      noPredicate.length
    )

    // A real predicate still works, and purgeAll is the deliberate wide door.
    expect(ids(store.lapseAll({ shareId: 'share-1' }, 'shareEnded', T0 + 2))).toEqual(['a'])
    store.purgeAll()
    expect(store.listQueued()).toEqual([])
  })

  // ---------------------------------------------------------------- purges --

  it('purges by chat and wholesale, and persists both', () => {
    const path = tempStorePath()
    const store = openStore(path)
    const doomedQueued = mustEnqueue(store, { chatId: 'chat-1', clientMessageId: 'q1' })
    const doomedDenied = mustEnqueue(store, { chatId: 'chat-1', clientMessageId: 'd1' })
    store.deny(doomedDenied.entryId, 'no', T0 + 1)
    mustEnqueue(store, { chatId: 'chat-2', clientMessageId: 'q2' })

    expect(store.purgeChats(['chat-nowhere'])).toBe(0)
    expect(store.purgeChats([])).toBe(0)
    // Chat-scoped erasure takes every state, not just the queued ones — the
    // rows the queue belongs to are gone.
    expect(store.purgeChats(['chat-1'])).toBe(2)
    expect(store.get(doomedQueued.entryId)).toBeNull()
    expect(store.get(doomedDenied.entryId)).toBeNull()
    expect(ids(store.listQueued())).toEqual(['q2'])
    expect(openStore(path).chatIdsWithQueued()).toEqual(['chat-2'])

    // An erased clientMessageId is enqueueable again: the anti-duplication
    // reason for a binding is moot once the message itself is gone.
    expect(enqueue(store, { chatId: 'chat-3', clientMessageId: 'q1', now: T0 + 10 }).ok).toBe(true)
    expect(enqueue(store, { chatId: 'chat-3', clientMessageId: 'd1', now: T0 + 11 }).ok).toBe(true)

    store.purgeAll()
    expect(store.listQueued()).toEqual([])
    expect(store.chatIdsWithQueued()).toEqual([])
    expect(openStore(path).listQueued()).toEqual([])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      entries: [],
      tombstones: []
    })
  })

  it('purgeAll clears the tombstones too, so erasure leaves no binding behind', () => {
    const path = tempStorePath()
    const rows: unknown[] = []
    // One over the cap, so loading evicts the oldest and retires its binding.
    for (let i = 0; i <= MAX_QUEUE_ENTRIES; i += 1) {
      rows.push(
        fileEntry({
          entryId: `e-${i}`,
          clientMessageId: `m-${i}`,
          enqueuedAt: T0 + i,
          expiresAt: T0 + i + 1000,
          resolvedAt: T0 + i,
          state: 'denied'
        })
      )
    }
    writeQueueFile(path, rows)

    const store = openStore(path)
    expect(JSON.parse(readFileSync(path, 'utf8')).tombstones).toHaveLength(1)
    expect(enqueue(store, { clientMessageId: 'm-0', now: T0 + 900_000 }).denial).toBe('duplicate')

    store.purgeAll()
    // A tombstone carries a collaboratorId and a clientMessageId, so retaining
    // one across a wholesale erasure would leave a trace of what was erased.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      entries: [],
      tombstones: []
    })
    expect(enqueue(store, { clientMessageId: 'm-0', now: T0 + 900_001 }).ok).toBe(true)
    expect(openStore(path).listQueued()).toHaveLength(1)

    // ...and it fires when a BINDING is all that is left. An early return on
    // "no entries" would leave the one identifier-bearing artefact behind in
    // exactly the state where it is the only thing there is to erase.
    const bindingsOnly = tempStorePath()
    writeFileSync(
      bindingsOnly,
      JSON.stringify({
        version: 1,
        entries: [],
        tombstones: [tombstoneKey('chat-1', OLLY, 'orphan')]
      })
    )
    const orphan = openStore(bindingsOnly)
    expect(enqueue(orphan, { clientMessageId: 'orphan', now: T0 }).denial).toBe('duplicate')
    orphan.purgeAll()
    expect(JSON.parse(readFileSync(bindingsOnly, 'utf8')).tombstones).toEqual([])
    expect(enqueue(orphan, { clientMessageId: 'orphan', now: T0 + 1 }).ok).toBe(true)
  })

  it("purgeChats erases a chat's BINDINGS by prefix, including the ones whose entry is already gone — which is all of them", () => {
    const path = tempStorePath()
    const rows: unknown[] = []
    // Every entry lives in the doomed chat, one over the cap. Loading evicts
    // the oldest and retires its binding, so by the time the purge runs that
    // binding is the only thing left of the message — and a binding only ever
    // exists for an entry that is already gone, so walking live entries to find
    // one could never work.
    for (let i = 0; i <= MAX_QUEUE_ENTRIES; i += 1) {
      rows.push(
        fileEntry({
          entryId: `e-${i}`,
          chatId: 'doomed-chat',
          clientMessageId: `m-${i}`,
          enqueuedAt: T0 + i,
          expiresAt: T0 + i + 1000,
          resolvedAt: T0 + i,
          state: 'denied'
        })
      )
    }
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: rows,
        // A binding belonging to a different chat, which erasure must not touch.
        tombstones: [tombstoneKey('other-chat', OLLY, 'keep-me')]
      })
    )

    const store = openStore(path)
    const afterLoad = JSON.parse(readFileSync(path, 'utf8')).tombstones
    expect(afterLoad).toContain(tombstoneKey('doomed-chat', OLLY, 'm-0'))
    expect(afterLoad).toContain(tombstoneKey('other-chat', OLLY, 'keep-me'))

    expect(store.purgeChats(['doomed-chat'])).toBe(MAX_QUEUE_ENTRIES)
    // The evicted entry's binding is gone from DISK, not just from memory...
    expect(JSON.parse(readFileSync(path, 'utf8')).tombstones).toEqual([
      tombstoneKey('other-chat', OLLY, 'keep-me')
    ])

    // ...so a restart agrees: the erased id is free again and the other chat's
    // binding is untouched.
    const reopened = openStore(path)
    expect(
      enqueue(reopened, { chatId: 'doomed-chat', clientMessageId: 'm-0', now: T0 + 900_000 }).ok
    ).toBe(true)
    expect(
      enqueue(reopened, { chatId: 'other-chat', clientMessageId: 'keep-me', now: T0 + 900_001 })
        .denial
    ).toBe('duplicate')
  })

  it('scopes the erasure prefix by LENGTH, so erasing chat "a" cannot touch chat "ab"', () => {
    const path = tempStorePath()
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: [],
        // Raw string prefixes overlap; the length prefix is what separates them.
        tombstones: [tombstoneKey('a', OLLY, 'x'), tombstoneKey('ab', OLLY, 'x')]
      })
    )

    const store = openStore(path)
    store.purgeChats(['a'])
    expect(enqueue(store, { chatId: 'a', clientMessageId: 'x', now: T0 }).ok).toBe(true)
    expect(enqueue(store, { chatId: 'ab', clientMessageId: 'x', now: T0 + 1 }).denial).toBe(
      'duplicate'
    )
  })

  it('chatIdsWithQueued reports ONLY chats with a queued entry — the guard that stops the abandoned-chat reaper deleting a chat awaiting review', () => {
    const store = openStore()
    const stillQueued = mustEnqueue(store, { chatId: 'chat-queued', clientMessageId: 'q1' })
    const alsoQueued = mustEnqueue(store, { chatId: 'chat-queued', clientMessageId: 'q2' })
    const approved = mustEnqueue(store, { chatId: 'chat-approved', clientMessageId: 'ap' })
    store.approve(approved.entryId, 'msg-1', T0 + 1)
    const denied = mustEnqueue(store, { chatId: 'chat-denied', clientMessageId: 'dn' })
    store.deny(denied.entryId, undefined, T0 + 1)
    mustEnqueue(store, { chatId: 'chat-lapsed', clientMessageId: 'lp' })
    store.lapseAll({ chatIds: ['chat-lapsed'] }, 'chatGone', T0 + 1)

    // Deduped, and terminal-only chats are absent: a chat whose contribution
    // was already resolved is not protected from the reaper.
    expect(store.chatIdsWithQueued()).toEqual(['chat-queued'])

    store.approve(stillQueued.entryId, 'msg-2', T0 + 2)
    expect(store.chatIdsWithQueued()).toEqual(['chat-queued'])
    store.deny(alsoQueued.entryId, undefined, T0 + 3)
    expect(store.chatIdsWithQueued()).toEqual([])
  })

  // ------------------------------------------------------- read/list shape --

  it('lists queued oldest-first, scoped by chat, and hands back defensive copies', () => {
    const store = openStore()
    const third = mustEnqueue(store, { chatId: 'chat-a', clientMessageId: 'third', now: T0 + 30 })
    const first = mustEnqueue(store, { chatId: 'chat-b', clientMessageId: 'first', now: T0 + 10 })
    const second = mustEnqueue(store, { chatId: 'chat-a', clientMessageId: 'second', now: T0 + 20 })

    expect(ids(store.listQueued())).toEqual(['first', 'second', 'third'])
    expect(ids(store.listQueued('chat-a'))).toEqual(['second', 'third'])
    expect(store.listQueued('chat-nowhere')).toEqual([])
    expect(ids(store.listForCollaborator(OLLY))).toEqual(['first', 'second', 'third'])
    expect(store.listForCollaborator('nobody')).toEqual([])
    expect(store.get('no-such-entry')).toBeNull()

    // Every read hands back a copy. A live reference would let a caller flip an
    // entry to `approved` — the one state that means "this reached the
    // transcript" — without going through approve() at all.
    const readers: Array<[string, ExternalContributionEntry]> = [
      ['listQueued', store.listQueued()[0]],
      ['listQueued(chatId)', store.listQueued('chat-a')[0]],
      ['listForCollaborator', store.listForCollaborator(OLLY)[1]],
      ['enqueue result', first]
    ]
    const owners: Record<string, string> = {
      listQueued: first.entryId,
      'listQueued(chatId)': second.entryId,
      listForCollaborator: second.entryId,
      'enqueue result': first.entryId
    }
    for (const [label, row] of readers) {
      expect(row.entryId).toBe(owners[label])
      row.body = `MUTATED via ${label}`
      row.state = 'approved'
      row.hostReason = 'INJECTED'
      row.messageId = 'forged-message-id'
      expect(store.get(owners[label])).toMatchObject({ state: 'queued', body: BODY })
      expect(store.get(owners[label])?.hostReason).toBeUndefined()
      expect(store.get(owners[label])?.messageId).toBeUndefined()
    }
    // And the store as a whole is unchanged: nothing left the queue.
    expect(ids(store.listQueued())).toEqual(['first', 'second', 'third'])
    const mutatedGet = mustGet(store, third.entryId)
    mutatedGet.state = 'lapsed'
    expect(store.get(third.entryId)?.state).toBe('queued')
  })

  it('orders listQueued TOTALLY — (enqueuedAt, sequence, entryId) — so a re-anchor cannot collapse review order into one tie', () => {
    const store = openStore()
    // Insertion order deliberately differs from arrival order, so a sort with no
    // tiebreaker would fall back to array position once the clock collapses.
    mustEnqueue(store, { clientMessageId: 'seq-3', sequence: 3, now: T0 + 30 })
    mustEnqueue(store, { clientMessageId: 'seq-1', sequence: 1, now: T0 + 10 })
    mustEnqueue(store, { clientMessageId: 'seq-2', sequence: 2, now: T0 + 20 })
    expect(ids(store.listQueued())).toEqual(['seq-1', 'seq-2', 'seq-3'])

    // A backward clock re-anchors every queued entry to the SAME instant.
    expect(store.sweep(1000)).toEqual([])
    expect(store.listQueued().every((entry) => entry.enqueuedAt === 1000)).toBe(true)
    // Review order is still arrival order, now carried by `sequence`.
    expect(ids(store.listQueued())).toEqual(['seq-1', 'seq-2', 'seq-3'])

    // Built from files below, so entryIds are deterministic instead of random
    // UUIDs and each tiebreaker can be isolated.

    // `sequence` outranks entryId: ids are deliberately in the OPPOSITE order.
    const bySequence = tempStorePath()
    writeQueueFile(bySequence, [
      fileEntry({ entryId: 'zzz', collaboratorId: OLLY, clientMessageId: 'first', sequence: 1 }),
      fileEntry({ entryId: 'aaa', collaboratorId: BEA, clientMessageId: 'second', sequence: 2 })
    ])
    expect(ids(openStore(bySequence).listQueued())).toEqual(['first', 'second'])

    // Two collaborators can legitimately send the SAME sequence, so entryId is
    // the final tiebreaker — and file order is the opposite of id order, so
    // array position cannot be what produced the answer.
    const byEntryId = tempStorePath()
    writeQueueFile(byEntryId, [
      fileEntry({ entryId: 'zzz', collaboratorId: OLLY, clientMessageId: 'z', sequence: 7 }),
      fileEntry({ entryId: 'aaa', collaboratorId: BEA, clientMessageId: 'a', sequence: 7 })
    ])
    expect(
      openStore(byEntryId)
        .listQueued()
        .map((entry) => entry.entryId)
    ).toEqual(['aaa', 'zzz'])
  })

  it('hands back a copy from every WRITE door too — including the `existing` entry on a duplicate denial', () => {
    const store = openStore()
    const alpha = mustEnqueue(store, { chatId: 'chat-a', clientMessageId: 'alpha', now: T0 })
    const beta = mustEnqueue(store, { chatId: 'chat-b', clientMessageId: 'beta', now: T0 + 1 })
    const gamma = mustEnqueue(store, { chatId: 'chat-c', clientMessageId: 'gamma', now: T0 + 2 })
    const delta = mustEnqueue(store, {
      chatId: 'chat-d',
      clientMessageId: 'delta',
      now: T0 + 3,
      ttlMs: 5
    })

    // A duplicate denial travels straight back out to the collaborator that
    // sent the retry; a live handle here would let the wire layer edit the
    // entry the host is still reviewing.
    const dupe = enqueue(store, { chatId: 'chat-a', clientMessageId: 'alpha', now: T0 + 4 })
    if (!dupe.existing) throw new Error('expected the duplicate to carry `existing`')
    dupe.existing.body = 'MUTATED'
    dupe.existing.state = 'approved'
    dupe.existing.messageId = 'forged'
    expect(store.get(alpha.entryId)).toMatchObject({ state: 'queued', body: BODY })
    expect(store.get(alpha.entryId)?.messageId).toBeUndefined()

    const approved = store.approve(alpha.entryId, 'msg-1', T0 + 5)
    if (!approved) throw new Error('expected approve to succeed')
    approved.body = 'MUTATED'
    approved.messageId = 'forged'
    approved.materialised = true
    expect(store.get(alpha.entryId)).toMatchObject({
      messageId: 'msg-1',
      materialised: false,
      body: BODY
    })

    const [awaiting] = store.listAwaitingMaterialisation()
    awaiting.materialised = true
    expect(store.listAwaitingMaterialisation()).toHaveLength(1)

    const finished = store.markMaterialised(alpha.entryId)
    if (!finished) throw new Error('expected markMaterialised to succeed')
    finished.materialised = false
    expect(store.get(alpha.entryId)?.materialised).toBe(true)

    const deniedRow = store.deny(beta.entryId, 'no thanks', T0 + 6)
    if (!deniedRow) throw new Error('expected deny to succeed')
    deniedRow.hostReason = 'FORGED'
    deniedRow.state = 'approved'
    expect(store.get(beta.entryId)).toMatchObject({ state: 'denied', hostReason: 'no thanks' })

    const [lapsedRow] = store.lapseAll({ chatIds: ['chat-c'] }, 'chatGone', T0 + 7)
    lapsedRow.lapseReason = 'revoked'
    lapsedRow.state = 'queued'
    expect(store.get(gamma.entryId)).toMatchObject({ state: 'lapsed', lapseReason: 'chatGone' })

    const [sweptRow] = store.sweep(T0 + 100)
    sweptRow.lapseReason = 'revoked'
    sweptRow.resolvedAt = 0
    expect(store.get(delta.entryId)).toMatchObject({
      state: 'lapsed',
      lapseReason: 'expired',
      resolvedAt: T0 + 100
    })
  })

  // ------------------------------------------------------------ wire shape --

  it('toCollaboratorView is a WHITELIST: body, collaboratorId, chatId, shareId, messageId, sequence and bodyBytes never cross', () => {
    const path = tempStorePath()
    writeQueueFile(path, [
      fileEntry({
        chatId: 'chat-private-id',
        shareId: 'share-private-id',
        collaboratorId: 'ed25519:private-key-id',
        sequence: 42,
        body: 'the unapproved contribution',
        bodyBytes: 27,
        state: 'denied',
        resolvedAt: T0 + 5,
        hostReason: 'off topic',
        lapseReason: 'revoked',
        messageId: 'msg-private-id',
        materialised: true
      })
    ])
    const entry = mustGet(openStore(path), 'e-1')
    const view = ExternalContributionQueueStore.toCollaboratorView(entry)

    const ALLOWED = [
      'clientMessageId',
      'enqueuedAt',
      'entryId',
      'expiresAt',
      'hostReason',
      'lapseReason',
      'resolvedAt',
      'state'
    ]
    expect(Object.keys(view).sort()).toEqual(ALLOWED)
    for (const secret of [
      'body',
      'bodyBytes',
      'chatId',
      'collaboratorId',
      'displayName',
      'materialised',
      'messageId',
      'sequence'
    ]) {
      expect(secret in view).toBe(false)
    }
    const serialised = JSON.stringify(view)
    for (const value of [
      'chat-private-id',
      'share-private-id',
      'ed25519:private-key-id',
      'the unapproved contribution',
      'msg-private-id'
    ]) {
      expect(serialised).not.toContain(value)
    }
    // hostReason IS included by design — a denial may carry a reason and the
    // person is meant to see it.
    expect(view.hostReason).toBe('off topic')
    // Whatever the entry grows next is private by default: nothing outside the
    // whitelist can appear, which a spread would break.
    expect(Object.keys(view).filter((key) => !ALLOWED.includes(key))).toEqual([])

    // Absent optionals are absent, not present-and-undefined.
    const plain = ExternalContributionQueueStore.toCollaboratorView(mustEnqueue(openStore()))
    expect(Object.keys(plain).sort()).toEqual([
      'clientMessageId',
      'enqueuedAt',
      'entryId',
      'expiresAt',
      'state'
    ])
  })

  // ----------------------------------------------------------- durability ---

  it('round-trips a mixed-state queue through the sibling JSON file', () => {
    const path = tempStorePath()
    const first = openStore(path)
    const queued = mustEnqueue(first, { clientMessageId: 'q', body: 'still waiting' })
    const denied = mustEnqueue(first, { clientMessageId: 'd', body: 'rejected but editable' })
    first.deny(denied.entryId, 'not this one', T0 + 1)
    const lapsed = mustEnqueue(first, { clientMessageId: 'l' })
    first.lapseAll({ chatIds: ['chat-1'], collaboratorId: OLLY }, 'revoked', T0 + 2)

    const reloaded = openStore(path, undefined, T0 + 3)
    // `q` and `l` were both queued, so lapseAll took both.
    expect(reloaded.listQueued()).toEqual([])
    expect(reloaded.get(queued.entryId)).toMatchObject({ state: 'lapsed', lapseReason: 'revoked' })
    expect(hasBody(reloaded.get(lapsed.entryId))).toBe(false)
    expect(reloaded.get(denied.entryId)).toMatchObject({
      state: 'denied',
      hostReason: 'not this one',
      body: 'rejected but editable'
    })
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1)
  })

  it('degrades to an EMPTY queue when the file is corrupt, and keeps accepting writes', () => {
    const path = tempStorePath()
    writeFileSync(path, '{ this is not json at all')

    const lines: string[] = []
    const open = (): ExternalContributionQueueStore => openStore(path, (line) => lines.push(line))
    // Losing pending contributions is bad; taking the collaboration subsystem
    // down with the file is worse.
    expect(open).not.toThrow()

    const store = open()
    expect(store.listQueued()).toEqual([])
    expect(lines.join('\n')).toContain('unreadable queue file')

    expect(enqueue(store).ok).toBe(true)
    expect(openStore(path).listQueued()).toHaveLength(1)
  })

  it('degrades to an empty queue for a structurally wrong snapshot', () => {
    const wrong = [
      'null',
      '123',
      '"entries"',
      '["entries", 12]',
      '{"version":1}',
      '{"version":1,"entries":"nope"}'
    ]
    for (const contents of wrong) {
      const path = tempStorePath()
      writeFileSync(path, contents)
      expect(openStore(path).listQueued()).toEqual([])
    }
  })

  it('drops junk records on load and DROPS a non-string body rather than resurrecting it through String()', () => {
    const path = tempStorePath()
    writeQueueFile(path, [
      null,
      'not-an-object',
      42,
      { chatId: 'c', shareId: 's', collaboratorId: 'x', clientMessageId: 'm', enqueuedAt: 1 },
      { entryId: 'e2', shareId: 's', collaboratorId: 'x', clientMessageId: 'm', enqueuedAt: 1 },
      { entryId: 'e3', chatId: 'c', shareId: 's', clientMessageId: 'm', enqueuedAt: 1 },
      { entryId: 'e4', chatId: 'c', shareId: 's', collaboratorId: 'x', enqueuedAt: 1 },
      {
        entryId: 'e5',
        chatId: 'c',
        shareId: 's',
        collaboratorId: 'x',
        clientMessageId: 'm',
        enqueuedAt: 'the day before yesterday'
      },
      fileEntry({
        entryId: 'object-body',
        clientMessageId: 'cm-object',
        expiresAt: undefined,
        // A hand-edited file. `String(obj)` here would resurrect junk as
        // content and hand it to the host as something to approve.
        body: { smuggled: 'RESURRECTED-JUNK' },
        state: 'nonsense-state',
        sequence: 'seven',
        bodyBytes: 'lots',
        displayName: 99
      }),
      fileEntry({
        entryId: 'numeric-body',
        clientMessageId: 'cm-number',
        enqueuedAt: T0 + 1,
        expiresAt: undefined,
        body: 8675309
      })
    ])

    const store = openStore(path)
    const entries = store.listQueued()
    expect(ids(entries)).toEqual(['cm-object', 'cm-number'])

    for (const entry of entries) {
      expect(hasBody(entry)).toBe(false)
      expect(entry.bodyBytes).toBe(0)
    }
    // Neither a String() coercion nor a raw passthrough left anything behind.
    expect(JSON.stringify(entries)).not.toContain('RESURRECTED-JUNK')
    expect(JSON.stringify(entries)).not.toContain('[object Object]')
    expect(JSON.stringify(entries)).not.toContain('8675309')

    const [objectBody] = entries
    // An unknown state falls back to `queued`, never to a terminal state: a
    // corrupt record must not be able to mark itself approved.
    expect(objectBody.state).toBe('queued')
    expect(objectBody.sequence).toBe(0)
    expect(objectBody.displayName).toBe('External')
    expect(objectBody.expiresAt).toBe(T0 + EXTERNAL_CONTRIBUTION_TTL_MS)

    // The degraded queue is still a working queue.
    expect(enqueue(store, { clientMessageId: 'cm-fresh', now: T0 + 2 }).ok).toBe(true)
    expect(openStore(path).listQueued()).toHaveLength(3)
  })

  it('CLAMPS a hand-edited expiresAt into [enqueuedAt, enqueuedAt + TTL] so sweep can still reap it', () => {
    const path = tempStorePath()
    writeQueueFile(path, [
      // Immortal: survives every sweep forever, and because queued entries are
      // never evicted and chatIdsWithQueued reports their chat, this one line
      // would also make the chat permanently un-reapable.
      fileEntry({ entryId: 'immortal', clientMessageId: 'far-future', expiresAt: 1e18 }),
      // Before its own arrival — clamped up, not left dangling in the past.
      fileEntry({
        entryId: 'backwards',
        collaboratorId: BEA,
        clientMessageId: 'backwards',
        expiresAt: T0 - 999_999
      }),
      // Legitimately in range: preserved exactly.
      fileEntry({
        entryId: 'in-range',
        collaboratorId: CHURN,
        clientMessageId: 'in-range',
        expiresAt: T0 + 5000
      }),
      fileEntry({
        entryId: 'not-a-number',
        collaboratorId: 'ed25519:d',
        clientMessageId: 'nan',
        expiresAt: 'whenever'
      })
    ])

    const store = openStore(path)
    expect(mustGet(store, 'immortal').expiresAt).toBe(T0 + EXTERNAL_CONTRIBUTION_TTL_MS)
    expect(mustGet(store, 'backwards').expiresAt).toBe(T0)
    expect(mustGet(store, 'in-range').expiresAt).toBe(T0 + 5000)
    expect(mustGet(store, 'not-a-number').expiresAt).toBe(T0 + EXTERNAL_CONTRIBUTION_TTL_MS)

    // The clamp is what makes the immortal entry reapable at all.
    expect(ids(store.sweep(T0 + EXTERNAL_CONTRIBUTION_TTL_MS)).sort()).toEqual([
      'backwards',
      'far-future',
      'in-range',
      'nan'
    ])
    expect(store.chatIdsWithQueued()).toEqual([])
  })

  it('narrows lapseReason against its union and caps hostReason on load', () => {
    const path = tempStorePath()
    writeQueueFile(path, [
      fileEntry({
        entryId: 'junk-reason',
        clientMessageId: 'junk',
        state: 'lapsed',
        resolvedAt: T0,
        // A typed field's name wearing arbitrary content, destined for a
        // human-facing surface.
        lapseReason: { evil: '<img src=x onerror=alert(1)>' },
        hostReason: 'y'.repeat(9000)
      }),
      fileEntry({
        entryId: 'unknown-reason',
        collaboratorId: BEA,
        clientMessageId: 'unknown',
        state: 'lapsed',
        resolvedAt: T0,
        lapseReason: 'somethingElse'
      }),
      fileEntry({
        entryId: 'good-reason',
        collaboratorId: CHURN,
        clientMessageId: 'good',
        state: 'lapsed',
        resolvedAt: T0,
        lapseReason: 'revoked',
        hostReason: 123
      })
    ])

    const store = openStore(path)
    const junk = mustGet(store, 'junk-reason')
    expect('lapseReason' in junk).toBe(false)
    expect(JSON.stringify(junk)).not.toContain('onerror')
    expect(junk.hostReason).toHaveLength(500)

    expect('lapseReason' in mustGet(store, 'unknown-reason')).toBe(false)
    expect(mustGet(store, 'good-reason').lapseReason).toBe('revoked')
    // A non-string hostReason is dropped, not coerced.
    expect('hostReason' in mustGet(store, 'good-reason')).toBe(false)
  })

  it('never throws when the storage path cannot be written', () => {
    // A path whose parent is a FILE cannot be mkdir'd. The failure must be
    // logged and swallowed so a broken disk cannot fail the share around it.
    const path = tempStorePath()
    writeFileSync(path, '{"version":1,"entries":[]}')
    const unwritable = join(path, 'nested', 'queue.json')

    const lines: string[] = []
    const store = openStore(unwritable, (line) => lines.push(line))
    expect(() => enqueue(store)).not.toThrow()
    expect(store.listQueued()).toHaveLength(1)
    expect(lines.join('\n')).toContain('persist failed')
  })

  it('drops an OVER-SIZE body on load while keeping the record — a hand-edited body enqueue would have refused must not load at full size', () => {
    const path = tempStorePath()
    writeQueueFile(path, [
      fileEntry({
        entryId: 'huge',
        clientMessageId: 'huge',
        body: 'x'.repeat(MAX_CONTRIBUTION_BYTES + 1),
        bodyBytes: MAX_CONTRIBUTION_BYTES + 1
      }),
      fileEntry({
        entryId: 'at-cap',
        collaboratorId: BEA,
        clientMessageId: 'at-cap',
        body: 'x'.repeat(MAX_CONTRIBUTION_BYTES),
        bodyBytes: MAX_CONTRIBUTION_BYTES
      }),
      fileEntry({
        entryId: 'cjk',
        collaboratorId: CHURN,
        clientMessageId: 'cjk',
        // Under the CHAR cap, over the BYTE cap — the read path measures bytes
        // like the write path, not UTF-16 units.
        body: '一'.repeat(MAX_CONTRIBUTION_BYTES / 3 + 1)
      })
    ])

    const store = openStore(path)
    // The RECORD survives, so the person can still be told what happened...
    expect(mustGet(store, 'huge').state).toBe('queued')
    expect(mustGet(store, 'huge').bodyBytes).toBe(MAX_CONTRIBUTION_BYTES + 1)
    // ...but the expensive part does not.
    expect(hasBody(mustGet(store, 'huge'))).toBe(false)
    expect(hasBody(mustGet(store, 'cjk'))).toBe(false)
    // Exactly at the cap is kept: the gate is `>`, not `>=`.
    expect(mustGet(store, 'at-cap').body).toHaveLength(MAX_CONTRIBUTION_BYTES)
  })

  it('CLAMPS `sequence` on both the enqueue and the load path — an advisory ordering hint must not be a review-order lever', () => {
    const store = openStore()
    const seqOf = (clientMessageId: string, sequence: unknown): number =>
      mustEnqueue(store, { clientMessageId, sequence: sequence as number }).sequence

    expect(seqOf('neg', -1)).toBe(0)
    expect(seqOf('very-neg', -1e12)).toBe(0)
    expect(seqOf('frac', 3.7)).toBe(3)
    expect(seqOf('nan', Number.NaN)).toBe(0)
    expect(seqOf('inf', Number.POSITIVE_INFINITY)).toBe(0)
    expect(seqOf('neg-inf', Number.NEGATIVE_INFINITY)).toBe(0)
    expect(seqOf('huge', 1e18)).toBe(MAX_SEQUENCE)
    expect(seqOf('normal', 7)).toBe(7)

    // Same clamp on the read path, and the ordering consequence it exists for:
    // `sequence` breaks ties in the host's review order, so an unclamped
    // negative would let a collaborator sort itself to the front of the queue.
    // Built from a file so the entryId tiebreaker is deterministic and file
    // order is the opposite of id order.
    const path = tempStorePath()
    writeQueueFile(path, [
      fileEntry({
        entryId: 'zzz',
        collaboratorId: OLLY,
        clientMessageId: 'greedy',
        sequence: -999
      }),
      fileEntry({ entryId: 'aaa', collaboratorId: BEA, clientMessageId: 'honest', sequence: 0 })
    ])
    const loaded = openStore(path)
    expect(mustGet(loaded, 'zzz').sequence).toBe(0)
    expect(mustGet(loaded, 'aaa').sequence).toBe(0)
    // Clamped to the floor, the greedy entry can only TIE — and the tie breaks
    // on entryId, not on how negative it asked to be.
    expect(ids(loaded.listQueued())).toEqual(['honest', 'greedy'])
  })

  it('EXEMPTS an approved-but-unmaterialised entry from reaping: a restart a week later still finds the message and its body', () => {
    const path = tempStorePath()
    writeQueueFile(path, [
      fileEntry({
        entryId: 'crashed-mid-materialise',
        clientMessageId: 'cm-crashed',
        state: 'approved',
        messageId: 'msg-1',
        materialised: false,
        resolvedAt: T0,
        body: 'never reached the transcript',
        bodyBytes: 28
      }),
      // A genuine receipt of the same age IS reaped, so the exemption is about
      // the unfinished state and not about the retention window being inert.
      fileEntry({
        entryId: 'finished',
        collaboratorId: BEA,
        clientMessageId: 'cm-finished',
        state: 'approved',
        messageId: 'msg-2',
        materialised: true,
        resolvedAt: T0
      })
    ])

    // The machine comes back more than a retention window after the crash.
    const store = openStore(path, undefined, T0 + RESOLVED_RETENTION_MS + 1)

    // Unfinished work, not a receipt: the reconciler still has something to
    // re-append, which is the only thing that makes "mark first, materialise
    // second" a recoverable ordering.
    const awaiting = store.listAwaitingMaterialisation()
    expect(awaiting).toHaveLength(1)
    expect(awaiting[0]).toMatchObject({
      entryId: 'crashed-mid-materialise',
      state: 'approved',
      messageId: 'msg-1',
      materialised: false,
      body: 'never reached the transcript'
    })
    // The finished receipt of identical age went, as it should.
    expect(store.get('finished')).toBeNull()

    // And the retry resolves to the surviving entry rather than to a bare
    // tombstone, so the collaborator can be told exactly what happened to it.
    const retry = enqueue(store, {
      clientMessageId: 'cm-crashed',
      body: 'let me try again',
      now: T0 + RESOLVED_RETENTION_MS + 2
    })
    expect(retry.denial).toBe('duplicate')
    expect(retry.existing).toMatchObject({
      entryId: 'crashed-mid-materialise',
      state: 'approved',
      messageId: 'msg-1'
    })

    // It also survives OVERFLOW eviction, not just the retention window.
    const overflowPath = tempStorePath()
    const rows: unknown[] = [
      fileEntry({
        entryId: 'oldest-unmaterialised',
        clientMessageId: 'cm-oldest',
        state: 'approved',
        messageId: 'msg-0',
        materialised: false,
        resolvedAt: T0,
        body: 'still unfinished'
      })
    ]
    for (let i = 1; i <= MAX_QUEUE_ENTRIES; i += 1) {
      rows.push(
        fileEntry({
          entryId: `e-${i}`,
          collaboratorId: CHURN,
          clientMessageId: `m-${i}`,
          enqueuedAt: T0 + i,
          expiresAt: T0 + i + 1000,
          resolvedAt: T0 + i,
          state: 'denied'
        })
      )
    }
    writeQueueFile(overflowPath, rows)
    const overflowed = openStore(overflowPath)
    // It is the oldest-resolved entry in the file, so an unexempted rule would
    // have taken it first.
    expect(overflowed.get('oldest-unmaterialised')?.body).toBe('still unfinished')
    expect(overflowed.get('e-1')).toBeNull()
  })

  it('WRITES BACK a load-time trim that leaves the entry count unchanged — the denied-body shape', () => {
    const path = tempStorePath()
    const rows: unknown[] = []
    for (let i = 0; i < MAX_DENIED_BODIES_RETAINED + 10; i += 1) {
      rows.push(
        fileEntry({
          entryId: `d-${i}`,
          clientMessageId: `d-${i}`,
          state: 'denied',
          resolvedAt: T0 + i,
          body: `denied body ${i}`,
          bodyBytes: 6
        })
      )
    }
    writeQueueFile(path, rows)

    const store = openStore(path)
    expect(store.listForCollaborator(OLLY).filter((row) => 'body' in row)).toHaveLength(
      MAX_DENIED_BODIES_RETAINED
    )

    // A count comparison would report "nothing happened" here: the trim sheds
    // bodies without shedding entries. Driving the write-back off a flag is
    // what gets the bytes the trim exists to shed off the disk, in a session
    // that never writes anything else.
    const snapshot = JSON.parse(readFileSync(path, 'utf8'))
    expect(snapshot.entries).toHaveLength(MAX_DENIED_BODIES_RETAINED + 10)
    expect(snapshot.entries.filter((row: { body?: string }) => 'body' in row)).toHaveLength(
      MAX_DENIED_BODIES_RETAINED
    )
  })

  it('writes back an eviction whose binding was ALREADY tombstoned — every compactChanged setter is load-bearing, not just the denied-body one', () => {
    // `retire` adds a key that is already in the set, so the tombstone COUNT is
    // unchanged and the size fallback in load() sees nothing. Only the flag can
    // tell that entries went. Both reaping paths are covered.
    const key = tombstoneKey('chat-1', OLLY, 'cm-1')

    // RETENTION path.
    const retentionPath = tempStorePath()
    writeFileSync(
      retentionPath,
      JSON.stringify({
        version: 1,
        entries: [
          fileEntry({ entryId: 'stale', clientMessageId: 'cm-1', state: 'denied', resolvedAt: T0 })
        ],
        tombstones: [key]
      })
    )
    const reaped = openStore(retentionPath, undefined, T0 + RESOLVED_RETENTION_MS + 1)
    expect(reaped.get('stale')).toBeNull()
    const afterRetention = JSON.parse(readFileSync(retentionPath, 'utf8'))
    expect(afterRetention.entries).toEqual([])
    expect(afterRetention.tombstones).toEqual([key])

    // OVERFLOW path: one over the cap, and the doomed entry's binding is
    // already on file.
    const overflowPath = tempStorePath()
    const rows: unknown[] = []
    for (let i = 0; i <= MAX_QUEUE_ENTRIES; i += 1) {
      rows.push(
        fileEntry({
          entryId: `e-${i}`,
          clientMessageId: `m-${i}`,
          enqueuedAt: T0 + i,
          expiresAt: T0 + i + 1000,
          resolvedAt: T0 + i,
          state: 'denied'
        })
      )
    }
    const oldestKey = tombstoneKey('chat-1', OLLY, 'm-0')
    writeFileSync(
      overflowPath,
      JSON.stringify({ version: 1, entries: rows, tombstones: [oldestKey] })
    )
    const trimmed = openStore(overflowPath)
    expect(trimmed.get('e-0')).toBeNull()
    const afterOverflow = JSON.parse(readFileSync(overflowPath, 'utf8'))
    expect(afterOverflow.entries).toHaveLength(MAX_QUEUE_ENTRIES)
    expect(afterOverflow.tombstones).toEqual([oldestKey])
  })

  // ------------------------------------------------------------ known gaps ---
  // Pinned so they cannot change silently. Each documents CURRENT behaviour
  // that is weaker than the surrounding design intends; invert the assertion
  // when it is fixed. See the review notes.

  it('writes the load-time tombstone tail-cap straight back to disk', () => {
    const path = tempStorePath()
    const OVER = MAX_DEDUPE_TOMBSTONES + 200
    const tombstones: string[] = []
    for (let i = 0; i < OVER; i += 1) tombstones.push(tombstoneKey('chat-1', OLLY, `t-${i}`))
    writeFileSync(path, JSON.stringify({ version: 1, entries: [], tombstones }))

    const store = openStore(path)

    // Asserted BEFORE any other write — ANY write heals the file, so a check
    // placed after one passes whether or not load persisted the trim. The bug
    // this pins was that `compact()` clears `compactChanged` as its first
    // statement, wiping the flag the tail-cap had set before it ran, so the
    // file was re-trimmed on every single start and never reconciled.
    expect(JSON.parse(readFileSync(path, 'utf8')).tombstones).toHaveLength(MAX_DEDUPE_TOMBSTONES)

    // The cap kept the NEWEST bindings: the head was dropped, the tail refused.
    expect(enqueue(store, { clientMessageId: 't-0', now: T0 }).ok).toBe(true)
    expect(enqueue(store, { clientMessageId: `t-${OVER - 1}`, now: T0 + 1 }).denial).toBe(
      'duplicate'
    )
  })

  it('persists an erasure that removed only BINDINGS, so a restart cannot bring them back', () => {
    const path = tempStorePath()
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: [],
        tombstones: [tombstoneKey('gone-chat', OLLY, 'm-0')]
      })
    )

    const store = openStore(path)
    // Nothing live is left in the chat — which is precisely the state the
    // chat-prefixed key was introduced to handle, since a binding only ever
    // outlives its entry. So this erasure removes ZERO entries and one binding.
    expect(store.purgeChats(['gone-chat'])).toBe(0)

    // Asserted on DISK, and before any other write. The persist used to be
    // guarded on the count of ENTRIES removed, so a binding-only erasure never
    // reached the file — and an erasure that looks like it worked and silently
    // reverts on restart is worse than one that visibly does nothing.
    // Deliberately NOT asserted via a follow-up enqueue: that would create an
    // entry, and the entry alone makes a later retry read as `duplicate`
    // whether or not the binding survived.
    expect(JSON.parse(readFileSync(path, 'utf8')).tombstones).toEqual([])

    const reopened = openStore(path)
    expect(enqueue(reopened, { chatId: 'gone-chat', clientMessageId: 'm-0', now: T0 + 1 }).ok).toBe(
      true
    )
  })

  // ------------------------------------------------------ accepted posture ---

  it('ACCEPTED: load-time compaction does not re-apply the per-collaborator quota, and lapses the excess on the first sweep instead', () => {
    const path = tempStorePath()
    const rows: unknown[] = []
    for (let i = 0; i < MAX_QUEUED_PER_COLLABORATOR + 5; i += 1) {
      rows.push(fileEntry({ entryId: `over-${i}`, clientMessageId: `over-${i}`, body: BODY }))
    }
    writeQueueFile(path, rows)

    // DELIBERATE, not an oversight. Re-applying the quota on load would mean
    // silently destroying somebody's pending contribution at startup; briefly
    // showing the host 25 items instead of 20 is the lesser harm, and it
    // resolves itself within one TTL. Documented rather than fixed.
    const store = openStore(path)
    expect(store.listForCollaborator(OLLY).length).toBe(MAX_QUEUED_PER_COLLABORATOR + 5)
    expect(store.listForCollaborator(OLLY).every((row) => row.body === BODY)).toBe(true)

    expect(store.sweep(T0 + EXTERNAL_CONTRIBUTION_TTL_MS).length).toBe(
      MAX_QUEUED_PER_COLLABORATOR + 5
    )
    expect(store.listQueued()).toEqual([])
  })
})
