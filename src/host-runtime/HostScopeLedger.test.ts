import { describe, expect, it } from 'vitest'

import {
  HOST_SCOPE_EPOCH_STALE_ERROR_CODE,
  HOST_SCOPE_EPOCH_STALE_MESSAGE,
  HOST_WINDOW_SCOPE,
  createHostScopeLedger,
  hostThreadScope,
  sameHostScopeEpoch,
  type HostScopeAcquireResult,
  type HostScopeId,
  type HostScopeLaneEvent,
  type HostScopeSlot
} from './HostScopeLedger'

const INCARNATION = 'a'.repeat(64)
const OTHER_INCARNATION = 'b'.repeat(64)

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function granted(result: HostScopeAcquireResult | null): HostScopeSlot {
  if (result === null) throw new Error('the acquire has not settled')
  if (!result.ok) throw new Error(`expected a grant, got ${result.reason}`)
  return result.slot
}

/** Record, in `log`, when an acquire settles and how. */
function track(
  promise: Promise<HostScopeAcquireResult>,
  log: string[],
  name: string
): { result: HostScopeAcquireResult | null } {
  const box: { result: HostScopeAcquireResult | null } = { result: null }
  void promise.then((result) => {
    box.result = result
    log.push(`${name}:${result.ok ? 'granted' : result.reason}`)
  })
  return box
}

describe('HostScopeLedger lanes', () => {
  it('serves one thread’s writers strictly in arrival order', async () => {
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    const scope = hostThreadScope('chat-1')
    const log: string[] = []
    const a = track(ledger.acquire(scope, { owner: 'persist-a' }), log, 'a')
    const b = track(ledger.acquire(scope, { owner: 'append-b' }), log, 'b')
    const c = track(ledger.acquire(scope, { owner: 'persist-c' }), log, 'c')

    await settle()
    expect(log).toEqual(['a:granted'])
    expect(ledger.view(scope)).toMatchObject({ owner: 'persist-a', waiting: 2 })

    granted(a.result).release()
    await settle()
    expect(log).toEqual(['a:granted', 'b:granted'])
    expect(ledger.view(scope)).toMatchObject({ owner: 'append-b', waiting: 1 })

    granted(b.result).release()
    await settle()
    expect(log).toEqual(['a:granted', 'b:granted', 'c:granted'])
    granted(c.result).release()
    expect(ledger.view(scope)).toMatchObject({ owner: null, waiting: 0 })
  })

  it('lets different threads, and the window, be written at once', async () => {
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    const chatA = hostThreadScope('chat-a')
    const chatB = hostThreadScope('chat-b')
    const a1 = granted(await ledger.acquire(chatA, { owner: 'a1' }))
    const b1 = granted(await ledger.acquire(chatB, { owner: 'b1' }))
    const refill = granted(await ledger.acquire(HOST_WINDOW_SCOPE, { owner: 'refill' }))
    // A thread whose id is "window" is a thread, not the window.
    const named = granted(await ledger.acquire(hostThreadScope('window'), { owner: 'named' }))
    expect([chatA, chatB, HOST_WINDOW_SCOPE].map((scope) => ledger.view(scope).owner)).toEqual([
      'a1',
      'b1',
      'refill'
    ])

    // A second writer of chat-a waits for chat-a alone.
    const log: string[] = []
    track(ledger.acquire(chatA, { owner: 'a2' }), log, 'a2')
    b1.release()
    refill.release()
    named.release()
    await settle()
    expect(log).toEqual([])
    a1.release()
    await settle()
    expect(log).toEqual(['a2:granted'])
  })

  it('keeps each thread’s order and one holder under any interleaving of threads', async () => {
    // A seeded walk: writers arrive on three threads and holders release in
    // random order across threads.
    let seed = 7
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    const threads = ['t1', 't2', 't3']
    const arrived: Record<string, string[]> = { t1: [], t2: [], t3: [] }
    const grants: Record<string, string[]> = { t1: [], t2: [], t3: [] }
    const holders = new Map<string, HostScopeSlot>()
    const violations: string[] = []
    let writers = 0
    for (let step = 0; step < 300; step += 1) {
      if (random() < 0.55 || holders.size === 0) {
        const thread = threads[Math.floor(random() * threads.length)]
        const owner = `${thread}-w${(writers += 1)}`
        arrived[thread].push(owner)
        void ledger.acquire(hostThreadScope(thread), { owner }).then((result) => {
          if (!result.ok) violations.push(`${owner} refused ${result.reason}`)
          else if (holders.has(thread)) violations.push(`${owner} granted beside a holder`)
          else holders.set(thread, result.slot)
          grants[thread].push(owner)
        })
      } else {
        const held = [...holders.keys()]
        const thread = held[Math.floor(random() * held.length)]
        const slot = holders.get(thread) as HostScopeSlot
        holders.delete(thread)
        slot.release()
      }
      await settle()
      expect(violations).toEqual([])
      for (const thread of threads) {
        expect(grants[thread]).toEqual(arrived[thread].slice(0, grants[thread].length))
        const view = ledger.view(hostThreadScope(thread))
        expect(view.owner).toBe(holders.get(thread)?.owner ?? null)
        expect(view.waiting).toBe(arrived[thread].length - grants[thread].length)
        // A free lane has nobody waiting for it.
        if (!holders.has(thread)) expect(view.waiting).toBe(0)
      }
    }
    expect(Object.values(grants).flat().length).toBeGreaterThan(50)
  })
})

describe('HostScopeLedger epochs', () => {
  it('refuses a write admitted before a delete, grants the ones that did not ask, and admits a recreate', async () => {
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    const scope = hostThreadScope('chat-1')
    const admitted = ledger.view(scope).epoch
    expect(admitted).toEqual({ hostIncarnation: INCARNATION, deleteCounter: 0 })

    const deleting = granted(await ledger.acquire(scope, { owner: 'delete', epoch: admitted }))
    deleting.commit(4)
    const log: string[] = []
    const persist = track(
      ledger.acquire(scope, { owner: 'persist-old', epoch: admitted }),
      log,
      'persist-old'
    )
    const append = track(ledger.acquire(scope, { owner: 'append' }), log, 'append')
    const bumped = deleting.deleted()
    expect(bumped).toEqual({ hostIncarnation: INCARNATION, deleteCounter: 1 })
    expect(deleting.epoch).toEqual(bumped)
    expect(deleting.version).toBeNull()
    // The persist admitted before the delete is refused as the delete is
    // recorded, while the delete still holds the lane; the writer that did
    // not ask for an epoch keeps its place.
    await settle()
    expect(log).toEqual(['persist-old:epoch_stale'])
    expect(persist.result).toEqual({ ok: false, reason: 'epoch_stale', epoch: bumped })
    expect(ledger.view(scope)).toMatchObject({ owner: 'delete', waiting: 1 })
    deleting.release()
    await settle()
    expect(log).toEqual(['persist-old:epoch_stale', 'append:granted'])
    granted(append.result).release()

    const recreate = granted(
      await ledger.acquire(scope, { owner: 'create', epoch: ledger.view(scope).epoch })
    )
    recreate.commit(0)
    recreate.release()
    expect(ledger.view(scope)).toMatchObject({ epoch: bumped, version: 0 })
  })

  it('refuses a writer already behind a delete at once, without waiting its turn', async () => {
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    const scope = hostThreadScope('chat-1')
    const admitted = ledger.view(scope).epoch
    const deleting = granted(await ledger.acquire(scope, { owner: 'delete' }))
    deleting.deleted()
    deleting.release()
    const holder = granted(await ledger.acquire(scope, { owner: 'holder' }))

    await expect(ledger.acquire(scope, { owner: 'persist-old', epoch: admitted })).resolves.toEqual(
      {
        ok: false,
        reason: 'epoch_stale',
        epoch: { hostIncarnation: INCARNATION, deleteCounter: 1 }
      }
    )
    expect(ledger.view(scope)).toMatchObject({ owner: 'holder', waiting: 0 })
    holder.release()
  })

  it('treats an epoch from another incarnation as stale', async () => {
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    const scope = hostThreadScope('chat-1')
    const foreign = { hostIncarnation: OTHER_INCARNATION, deleteCounter: 0 }
    await expect(
      ledger.acquire(scope, { owner: 'persist', epoch: foreign })
    ).resolves.toMatchObject({ ok: false, reason: 'epoch_stale' })
    expect(sameHostScopeEpoch(foreign, ledger.view(scope).epoch)).toBe(false)
    expect(
      sameHostScopeEpoch(
        { hostIncarnation: INCARNATION, deleteCounter: 0 },
        ledger.view(scope).epoch
      )
    ).toBe(true)
    expect(
      sameHostScopeEpoch(
        { hostIncarnation: INCARNATION, deleteCounter: 1 },
        ledger.view(scope).epoch
      )
    ).toBe(false)
  })

  it('keeps a delete’s epoch while the thread is idle', async () => {
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    const scope = hostThreadScope('chat-1')
    const admitted = ledger.view(scope).epoch
    const deleting = granted(await ledger.acquire(scope, { owner: 'delete' }))
    deleting.deleted()
    deleting.release()
    // Many other threads come and go; chat-1's epoch stays moved.
    for (let index = 0; index < 50; index += 1) {
      granted(await ledger.acquire(hostThreadScope(`other-${index}`), { owner: 'w' })).release()
    }
    await expect(
      ledger.acquire(scope, { owner: 'persist-old', epoch: admitted })
    ).resolves.toMatchObject({ ok: false, reason: 'epoch_stale' })
  })

  it('names the stale-epoch failure so that no client retries it as a conflict', () => {
    expect(HOST_SCOPE_EPOCH_STALE_ERROR_CODE).toBe('thread_record_epoch_stale')
    // `thread_record_deleted` is the delete's own success summary.
    expect(HOST_SCOPE_EPOCH_STALE_ERROR_CODE).not.toBe('thread_record_deleted')
    for (const text of [HOST_SCOPE_EPOCH_STALE_ERROR_CODE, HOST_SCOPE_EPOCH_STALE_MESSAGE]) {
      expect(text.toLowerCase()).not.toContain('revision')
      expect(text.toLowerCase()).not.toContain('conflict')
    }
  })
})

describe('HostScopeLedger slot state', () => {
  it('records commits and publications in order, and only while the lane is held', async () => {
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    const scope = hostThreadScope('chat-1')
    const slot = granted(await ledger.acquire(scope, { owner: 'persist' }))
    expect(slot).toMatchObject({ scope, owner: 'persist', version: null, publishedCursor: null })

    slot.commit(3)
    expect(slot.version).toBe(3)
    expect(ledger.view(scope).version).toBe(3)
    expect(() => slot.commit(3)).toThrow(/does not follow 3/)
    expect(() => slot.commit(2)).toThrow(/does not follow 3/)
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => slot.commit(bad)).toThrow(TypeError)
    }

    slot.published({ generation: 1, cursor: 10 })
    slot.published({ generation: 1, cursor: 10 })
    expect(() => slot.published({ generation: 1, cursor: 9 })).toThrow(/behind/)
    // A new generation starts its cursor again.
    slot.published({ generation: 2, cursor: 0 })
    for (const bad of [
      { generation: 2, cursor: -1 },
      { generation: 1.5, cursor: 0 },
      { generation: 2 },
      null
    ]) {
      expect(() => slot.published(bad as never)).toThrow(TypeError)
    }
    expect(ledger.view(scope).publishedCursor).toEqual({ generation: 2, cursor: 0 })

    slot.release()
    slot.release()
    expect(slot.released).toBe(true)
    expect(() => slot.commit(4)).toThrow(/after the lane was released/)
    expect(() => slot.published({ generation: 2, cursor: 1 })).toThrow(/released/)
    expect(() => slot.deleted()).toThrow(/released/)

    const next = granted(await ledger.acquire(scope, { owner: 'next' }))
    expect(next).toMatchObject({ version: 3, publishedCursor: { generation: 2, cursor: 0 } })
    next.release()
  })

  it('ignores a second release, which never frees the next holder’s lane', async () => {
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    const scope = hostThreadScope('chat-1')
    const first = granted(await ledger.acquire(scope, { owner: 'first' }))
    const log: string[] = []
    const second = track(ledger.acquire(scope, { owner: 'second' }), log, 'second')
    const third = track(ledger.acquire(scope, { owner: 'third' }), log, 'third')
    first.release()
    await settle()
    first.release()
    await settle()
    expect(log).toEqual(['second:granted'])
    expect(ledger.view(scope)).toMatchObject({ owner: 'second', waiting: 1 })
    granted(second.result).release()
    await settle()
    expect(log).toEqual(['second:granted', 'third:granted'])
    granted(third.result).release()
  })

  it('keeps a copy of a published position', async () => {
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    const scope = hostThreadScope('chat-1')
    const slot = granted(await ledger.acquire(scope, { owner: 'persist' }))
    const position = { generation: 1, cursor: 5 }
    slot.published(position)
    position.cursor = 1
    expect(ledger.view(scope).publishedCursor).toEqual({ generation: 1, cursor: 5 })
    slot.release()
  })

  it('refuses a delete of the window, which is no record', async () => {
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    const slot = granted(await ledger.acquire(HOST_WINDOW_SCOPE, { owner: 'refill' }))
    expect(() => slot.deleted()).toThrow(/window scope is not a record/)
    slot.commit(1)
    slot.release()
    expect(ledger.view(HOST_WINDOW_SCOPE)).toMatchObject({
      version: 1,
      epoch: { hostIncarnation: INCARNATION, deleteCounter: 0 }
    })
  })
})

describe('HostScopeLedger leaving and closing', () => {
  it('lets a waiter leave the queue without disturbing its order', async () => {
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    const scope = hostThreadScope('chat-1')
    const holder = granted(await ledger.acquire(scope, { owner: 'holder' }))
    const controller = new AbortController()
    const log: string[] = []
    track(ledger.acquire(scope, { owner: 'w1', signal: controller.signal }), log, 'w1')
    const w2 = track(ledger.acquire(scope, { owner: 'w2' }), log, 'w2')
    const w3 = track(ledger.acquire(scope, { owner: 'w3' }), log, 'w3')
    controller.abort()
    await settle()
    expect(log).toEqual(['w1:aborted'])
    expect(ledger.view(scope).waiting).toBe(2)

    holder.release()
    await settle()
    expect(log).toEqual(['w1:aborted', 'w2:granted'])
    granted(w2.result).release()
    await settle()
    expect(log).toEqual(['w1:aborted', 'w2:granted', 'w3:granted'])
    granted(w3.result).release()

    // Already aborted: refused at once and never queued.
    const done = new AbortController()
    done.abort()
    await expect(ledger.acquire(scope, { owner: 'late', signal: done.signal })).resolves.toEqual({
      ok: false,
      reason: 'aborted'
    })
    expect(ledger.view(scope)).toMatchObject({ owner: null, waiting: 0 })
  })

  it('stops listening to a waiter’s signal once it is granted', async () => {
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    const scope = hostThreadScope('chat-1')
    const listeners = new Set<unknown>()
    const signal = {
      aborted: false,
      addEventListener: (_type: string, listener: unknown) => listeners.add(listener),
      removeEventListener: (_type: string, listener: unknown) => listeners.delete(listener)
    } as unknown as AbortSignal
    const holder = granted(await ledger.acquire(scope, { owner: 'holder' }))
    const waiting = ledger.acquire(scope, { owner: 'waiter', signal })
    expect(listeners.size).toBe(1)
    holder.release()
    const slot = granted(await waiting)
    expect(listeners.size).toBe(0)
    slot.release()
  })

  it('refuses queued and new writers once closed, and lets holders finish', async () => {
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    const scope = hostThreadScope('chat-1')
    const holder = granted(await ledger.acquire(scope, { owner: 'holder' }))
    const log: string[] = []
    track(ledger.acquire(scope, { owner: 'queued' }), log, 'queued')
    ledger.close()
    await settle()
    expect(log).toEqual(['queued:closed'])
    expect(ledger.closed).toBe(true)
    await expect(ledger.acquire(hostThreadScope('other'), { owner: 'new' })).resolves.toEqual({
      ok: false,
      reason: 'closed'
    })
    holder.commit(1)
    holder.release()
    expect(ledger.view(scope)).toMatchObject({ owner: null, waiting: 0, version: 1 })
    ledger.close()
    expect(ledger.closed).toBe(true)
  })
})

describe('HostScopeLedger inputs', () => {
  it('validates its scopes, labels and epochs', async () => {
    for (const bad of ['', undefined, 42, 'x'.repeat(257), `bad${String.fromCharCode(0)}`]) {
      expect(() => createHostScopeLedger({ hostIncarnation: bad as string })).toThrow(TypeError)
    }
    expect(() => createHostScopeLedger(undefined as never)).toThrow(TypeError)
    const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    expect(ledger.hostIncarnation).toBe(INCARNATION)

    for (const bad of [
      '',
      'x'.repeat(513),
      `a${String.fromCharCode(0)}`,
      `a${String.fromCharCode(0x1f)}`,
      `a${String.fromCharCode(0x7f)}`,
      7
    ]) {
      expect(() => hostThreadScope(bad as string)).toThrow(TypeError)
    }
    expect(hostThreadScope('x'.repeat(512))).toBe(`thread:${'x'.repeat(512)}`)

    // Only a scope made by the module is accepted.
    for (const bad of ['chat-1', 'thread:', 'Window', null]) {
      await expect(async () =>
        ledger.acquire(bad as unknown as HostScopeId, { owner: 'w' })
      ).rejects.toThrow(TypeError)
      expect(() => ledger.view(bad as unknown as HostScopeId)).toThrow(TypeError)
    }
    const scope = hostThreadScope('chat-1')
    for (const owner of ['', undefined, `o${String.fromCharCode(10)}`, 'o'.repeat(257)]) {
      await expect(async () => ledger.acquire(scope, { owner: owner as string })).rejects.toThrow(
        TypeError
      )
    }
    for (const epoch of [
      null,
      { hostIncarnation: '', deleteCounter: 0 },
      { hostIncarnation: INCARNATION, deleteCounter: -1 },
      { hostIncarnation: INCARNATION, deleteCounter: 1.5 },
      { hostIncarnation: INCARNATION }
    ]) {
      await expect(async () =>
        ledger.acquire(scope, { owner: 'w', epoch: epoch as never })
      ).rejects.toThrow(TypeError)
    }
    // Nothing above queued or granted anything.
    expect(ledger.view(scope)).toEqual({
      scope,
      epoch: { hostIncarnation: INCARNATION, deleteCounter: 0 },
      version: null,
      publishedCursor: null,
      owner: null,
      waiting: 0
    })
  })
})

describe('HostScopeLedger events', () => {
  it('reports grants, releases and refusals with their waits and holds', async () => {
    const events: HostScopeLaneEvent[] = []
    let clock = 100
    const ledger = createHostScopeLedger({
      hostIncarnation: INCARNATION,
      observer: (event) => events.push(event),
      now: () => clock
    })
    const scope = hostThreadScope('chat-1')
    const admitted = ledger.view(scope).epoch
    const first = granted(await ledger.acquire(scope, { owner: 'a' }))
    const second = ledger.acquire(scope, { owner: 'b' })
    const stale = ledger.acquire(scope, { owner: 'c', epoch: admitted })
    clock = 130
    first.deleted()
    first.release()
    const slot = granted(await second)
    await stale
    clock = 145
    slot.release()
    const controller = new AbortController()
    controller.abort()
    await ledger.acquire(scope, { owner: 'd', signal: controller.signal })
    ledger.close()
    await ledger.acquire(scope, { owner: 'e' })

    expect(events).toEqual([
      { kind: 'granted', scope, owner: 'a', waitMs: 0 },
      { kind: 'refused', scope, owner: 'c', reason: 'epoch_stale' },
      { kind: 'released', scope, owner: 'a', holdMs: 30 },
      { kind: 'granted', scope, owner: 'b', waitMs: 30 },
      { kind: 'released', scope, owner: 'b', holdMs: 15 },
      { kind: 'refused', scope, owner: 'd', reason: 'aborted' },
      { kind: 'refused', scope, owner: 'e', reason: 'closed' }
    ])
  })

  it('never lets a broken observer or clock disturb a lane, and reads no clock without an observer', async () => {
    const scope = hostThreadScope('chat-1')
    const throwing = createHostScopeLedger({
      hostIncarnation: INCARNATION,
      observer: () => {
        throw new Error('sink down')
      },
      now: () => {
        throw new Error('clock down')
      }
    })
    const held = granted(await throwing.acquire(scope, { owner: 'a' }))
    const next = throwing.acquire(scope, { owner: 'b' })
    held.release()
    granted(await next).release()

    const events: HostScopeLaneEvent[] = []
    const nan = createHostScopeLedger({
      hostIncarnation: INCARNATION,
      observer: (event) => events.push(event),
      now: () => Number.NaN
    })
    granted(await nan.acquire(scope, { owner: 'a' })).release()
    expect(events).toEqual([
      { kind: 'granted', scope, owner: 'a', waitMs: null },
      { kind: 'released', scope, owner: 'a', holdMs: null }
    ])

    let reads = 0
    const quiet = createHostScopeLedger({
      hostIncarnation: INCARNATION,
      now: () => {
        reads += 1
        return 0
      }
    })
    const slot = granted(await quiet.acquire(scope, { owner: 'a' }))
    const waiting = quiet.acquire(scope, { owner: 'b' })
    slot.release()
    granted(await waiting).release()
    expect(reads).toBe(0)
  })
})
