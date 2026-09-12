/**
 * Phase 2 observability — is v2 patching actually HOLDING under load?
 *
 * The chat-updated path is already well mitigated: v2 emits compact field-mask
 * patches against an acknowledged baseline instead of the whole ChatRecord, and
 * the measured win is large (a real 26k-message / 62 MB chat: v1 degraded
 * 6.6 s -> 22.8 s across seven identical saves while v2 held flat at ~3.4 s).
 *
 * But patching only applies WHILE the acknowledged baseline is held. A failed
 * apply nacks, which drops the baseline and forces a full snapshot on the next
 * delivery. Under fan-out — many rapid deliveries, busy renderer, ACK timeouts —
 * that degradation is plausible precisely when it hurts most, and nothing
 * counted it. A frame-cadence triage run could therefore see main-thread cost
 * from full-record sends and have no way to attribute it.
 *
 * These counters are cumulative and deliberately cheap (three integers). They
 * exist so a measurement window can answer one question: of the deliveries in
 * this window, how many were patches, how many degraded to snapshots, and how
 * many times was a baseline dropped?
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from './store/types'
import {
  MAX_WINDOWED_TRANSCRIPT_GROWTH_ROWS,
  attachChatUpdateProducerEnvelope,
  type ChatUpdateBaseline,
  type ChatUpdateDelivery
} from '../shared/chatUpdateTransport'
import { DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES } from '../shared/transcriptPage'
import { deriveChatRecordMutationWithProjection } from './store/ChatRecordMutation'
import { ChatUpdateProjectionTracker } from './store/ChatUpdateProjectionTracker'
import {
  ChatUpdateDeliveryCoordinator,
  type ChatUpdateDeliveryTarget
} from './ChatUpdateDeliveryCoordinator'
import { ackAsRenderer } from './chatUpdateRendererAck.testutil'

function message(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, timestamp: '2026-07-18T00:00:00.000Z' }
}

function chat(updatedAt: number, contents: string[]): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Ensemble',
    provider: 'codex',
    chatKind: 'ensemble',
    archived: false,
    messages: contents.map((content, index) => message(`message-${index}`, content)),
    runs: [],
    createdAt: 1,
    updatedAt,
    persistenceRevision: updatedAt
  } as ChatRecord
}

function projectSequence(...records: ChatRecord[]): ChatRecord[] {
  if (records.length === 0) return records
  const tracker = new ChatUpdateProjectionTracker()
  attachChatUpdateProducerEnvelope(records[0], {
    state: tracker.seed(records[0]),
    delta: null
  })
  for (let index = 1; index < records.length; index += 1) {
    const before = records[index - 1]
    const after = records[index]
    attachChatUpdateProducerEnvelope(
      after,
      tracker.observe(before, after, deriveChatRecordMutationWithProjection(before, after))
    )
  }
  return records
}

function target(id = 11): ChatUpdateDeliveryTarget & { deliveries: ChatUpdateDelivery[] } {
  const deliveries: ChatUpdateDelivery[] = []
  return {
    id,
    deliveries,
    isDestroyed: () => false,
    send: (_channel, payload) => deliveries.push(payload as ChatUpdateDelivery)
  }
}

describe('ChatUpdateDeliveryCoordinator protocol counters', () => {
  it('counts a first delivery as a snapshot and a baseline-backed follow-up as a patch', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    const [first, second] = projectSequence(chat(1, ['one']), chat(2, ['two']))
    coordinator.enqueue(sink, first)
    coordinator.enqueue(sink, second)
    expect(sink.deliveries[0].kind).toBe('snapshot')
    expect(coordinator.protocolCounters()).toMatchObject({ snapshots: 1, patches: 0 })

    // Acknowledging holds the baseline, so the queued update can go as a patch.
    ackAsRenderer(coordinator, sink, sink.deliveries[0])
    expect(sink.deliveries[1].kind).toBe('patch')
    expect(coordinator.protocolCounters()).toMatchObject({ snapshots: 1, patches: 1 })
  })

  it('counts the baseline drop when a renderer nacks, and the snapshot it forces', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    const [first, second, third] = projectSequence(
      chat(1, ['one']),
      chat(2, ['two']),
      chat(3, ['three'])
    )
    coordinator.enqueue(sink, first)
    ackAsRenderer(coordinator, sink, sink.deliveries[0])
    coordinator.enqueue(sink, second)
    expect(sink.deliveries[1].kind).toBe('patch')
    expect(coordinator.protocolCounters()).toMatchObject({ baselineDrops: 0 })

    // The renderer could not apply the patch. That drops the baseline — the
    // degradation this counter exists to make visible.
    coordinator.acknowledge(sink.id, { deliveryId: sink.deliveries[1].deliveryId, applied: false })
    coordinator.enqueue(sink, third)

    const latest = sink.deliveries[sink.deliveries.length - 1]
    expect(latest.kind).toBe('snapshot')
    const counters = coordinator.protocolCounters()
    expect(counters.baselineDrops).toBeGreaterThanOrEqual(1)
    // A measurement window can now see the ratio rather than assuming it.
    expect(counters.snapshots).toBeGreaterThanOrEqual(2)
  })

  it('keeps a broken producer visible even though the delivery now patches', () => {
    // 2026-08-19: a producer that yields no delta used to degrade every
    // delivery to a full-record snapshot, and snapshots-vs-patches was the
    // only signal. Recovering by baseline diff removes the OOM but would also
    // make a broken producer read as HEALTHY on those two counters — the
    // regression would go quiet rather than get fixed. These count the cause.
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    const [first] = projectSequence(chat(1, ['one']))
    coordinator.enqueue(sink, first)
    ackAsRenderer(coordinator, sink, sink.deliveries[0])
    expect(coordinator.protocolCounters()).toMatchObject({ producerDeltaMissing: 0 })

    // Exactly the shipped failure: a save path broadcasts with no producer
    // envelope at all, so there is no delta to chain from.
    coordinator.enqueue(sink, chat(2, ['one', 'two']))

    const latest = sink.deliveries[sink.deliveries.length - 1]
    expect(latest.kind).toBe('patch')
    const counters = coordinator.protocolCounters()
    expect(counters.producerDeltaMissing).toBe(1)
    expect(counters.spliceRecoveries).toBe(1)
  })

  it('keeps counting across targets so a fan-out window sees every delivery', () => {
    const a = target(21)
    const b = target(22)
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    coordinator.enqueue(a, chat(1, ['one']))
    coordinator.enqueue(b, chat(1, ['one']))

    // Per-target stats are a point-in-time retention view; these are cumulative
    // totals for the whole coordinator, which is what a triage window needs.
    expect(coordinator.protocolCounters().snapshots).toBe(2)
  })

  it('counts broadcasts discarded by the enqueue staleness guard', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    // Seed a fresh known revision, then rebroadcast an OLDER one — the exact
    // late-arrival shape the staleness guard exists to reject. The frame is
    // dropped silently; without this counter the transcript just freezes
    // while snapshots/patches stay flat.
    const [fresh] = projectSequence(chat(5, ['five']))
    coordinator.enqueue(sink, fresh)
    expect(coordinator.protocolCounters().staleEnqueueDrops).toBe(0)

    const [stale] = projectSequence(chat(2, ['two']))
    coordinator.enqueue(sink, stale)

    expect(coordinator.protocolCounters()).toMatchObject({ staleEnqueueDrops: 1 })
  })

  it('tallies rejected ACKs by failing validation check', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    const [first] = projectSequence(chat(1, ['one']))
    coordinator.enqueue(sink, first)
    // A nack with no main-side mismatch is a renderer apply failure.
    coordinator.acknowledge(sink.id, { deliveryId: sink.deliveries[0].deliveryId, applied: false })
    expect(coordinator.protocolCounters()).toMatchObject({
      ackRejections: 1,
      ackRejectReasons: { rendererApplyFailure: 1 }
    })

    // A revision mismatch is attributed to its own axis.
    const [, second] = projectSequence(chat(1, ['one']), chat(2, ['two']))
    coordinator.enqueue(sink, second)
    coordinator.acknowledge(sink.id, {
      deliveryId: sink.deliveries[1].deliveryId,
      applied: true,
      revision: sink.deliveries[1].revision + 999
    })
    expect(coordinator.protocolCounters()).toMatchObject({
      ackRejections: 2,
      ackRejectReasons: { rendererApplyFailure: 1, revisionMismatch: 1 }
    })
  })

  it('returns a copy of the reason map so callers cannot mutate internal tallies', () => {
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const snapshot = coordinator.protocolCounters()
    snapshot.ackRejectReasons.rendererApplyFailure = 99
    expect(coordinator.protocolCounters().ackRejectReasons).toEqual({})
  })

  it('keeps serialized-byte diagnostics absent unless explicitly enabled', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    coordinator.enqueue(sink, chat(1, ['one']))

    expect(coordinator.protocolCounters().serializedBytes).toBeUndefined()
  })

  it('records categorized serialized-byte totals only when explicitly enabled', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2,
      measureSerializedBytes: true
    })

    coordinator.enqueue(sink, chat(1, ['one']))

    const totals = coordinator.protocolCounters().serializedBytes
    expect(totals).toMatchObject({
      envelope: expect.any(Number),
      peak: expect.any(Number),
      ensemble: expect.any(Number),
      runs: expect.any(Number),
      nonMessageRecord: expect.any(Number),
      messages: expect.any(Number)
    })
    expect(totals?.envelope).toBeGreaterThan(0)
    expect(totals?.peak).toBe(totals?.envelope)
    expect(totals?.nonMessageRecord).toBeGreaterThan(0)
    expect(totals?.messages).toBeGreaterThan(0)
  })
})

/**
 * An oversized chat delivers a bounded SHELL, and the lane must stay in that
 * mode rather than re-sending the shell on every delivery.
 *
 * `boundChatUpdateSnapshot` replaces the transcript with one tail page and
 * stamps `summaryOnly`, `transcriptPaged`, `messageCount`, `runCount` and
 * `runWallMs`. Every one of those is a NON-message field, so every one of them
 * is inside `computeChatSubRevisions`, which hashes the record without its
 * messages.
 *
 * The coordinator hashed the DELIVERED shell — correct, that is what the
 * renderer ACKs — but retained the CANONICAL record as `baselineChat`. On the
 * next send `retainedBaselineMatchesAcknowledged` recomputed the canonical
 * record's hash and compared it against the shell's. They cannot be equal, so
 * the baseline was dropped and a whole-record snapshot sent, forever: measured
 * live on 2026-09-11, 465 snapshots against 55 patches.
 *
 * The fix is to keep the lane in shell mode: project the record the renderer
 * actually holds, diff shell against shell, hash the shell, and retain the
 * shell. Diffing a shell against the canonical record would have "worked" for
 * the hash and been worse — it ships the whole runs array and clears the paged
 * markers on a renderer that is holding one page.
 */

describe('ChatUpdateDeliveryCoordinator window anchors', () => {
  function growingChat(updatedAt: number, rowCount: number): ChatRecord {
    return chat(
      updatedAt,
      Array.from({ length: rowCount }, (_, index) => `row-${index}`)
    )
  }

  it('never patches from a windowed delivery the renderer refused', () => {
    // The anchor names the window the RENDERER holds, which is why it is
    // adopted next to the baseline record inside `adoptDeliveredRecord` and
    // nowhere else. That pairing is structural rather than observable here: a
    // send already drops the patch baseline, so a refused delivery can never
    // become the base of a patch whatever the anchor says. What IS observable,
    // and what this pins, is the consequence — a refusal costs another
    // snapshot, and patching resumes only once one actually lands.
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    coordinator.enqueue(sink, growingChat(1, 1_600))
    expect(sink.deliveries).toHaveLength(1)
    expect(sink.deliveries[0].kind).toBe('snapshot')

    // The renderer says it did NOT apply it, so the window it described was
    // never held and the retry must be another snapshot.
    coordinator.acknowledge(sink.id, { deliveryId: sink.deliveries[0].deliveryId, applied: false })
    coordinator.enqueue(sink, growingChat(2, 1_610))
    expect(sink.deliveries[1].kind).toBe('snapshot')
    expect(coordinator.protocolCounters()).toMatchObject({ patches: 0, windowReanchors: 0 })

    // Now it lands, and the very next delivery patches the window it named.
    ackAsRenderer(coordinator, sink, sink.deliveries[1])
    coordinator.enqueue(sink, growingChat(3, 1_620))
    expect(sink.deliveries[2].kind).toBe('patch')
    expect(coordinator.protocolCounters()).toMatchObject({ patches: 1, windowReanchors: 0 })
  })

  it('keeps patching across a long append run without re-anchoring', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    coordinator.enqueue(sink, growingChat(1, 1_600))
    let baseline = ackAsRenderer(coordinator, sink, sink.deliveries[0]).baseline
    for (let step = 0; step < 40; step += 1) {
      coordinator.enqueue(sink, growingChat(2 + step, 1_610 + step * 10))
      baseline = ackAsRenderer(coordinator, sink, sink.deliveries.at(-1)!, baseline).baseline
    }
    expect(coordinator.protocolCounters()).toMatchObject({
      snapshots: 1,
      patches: 40,
      baselineDrops: 0,
      windowReanchors: 0
    })
  })

  it('re-anchors exactly once when the window outgrows its ceiling', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    coordinator.enqueue(sink, growingChat(1, 1_600))
    let baseline = ackAsRenderer(coordinator, sink, sink.deliveries[0]).baseline
    // One append inside the ceiling, then one that blows through it.
    coordinator.enqueue(sink, growingChat(2, 1_700))
    baseline = ackAsRenderer(coordinator, sink, sink.deliveries[1], baseline).baseline
    coordinator.enqueue(sink, growingChat(3, 1_600 + MAX_WINDOWED_TRANSCRIPT_GROWTH_ROWS + 50))
    ackAsRenderer(coordinator, sink, sink.deliveries[2], baseline)
    // And the delivery AFTER the re-anchor patches again from the new window,
    // rather than snapshotting forever once it has slipped once.
    coordinator.enqueue(sink, growingChat(4, 1_600 + MAX_WINDOWED_TRANSCRIPT_GROWTH_ROWS + 60))

    expect(sink.deliveries.map((delivery) => delivery.kind)).toEqual([
      'snapshot',
      'patch',
      'snapshot',
      'patch'
    ])
    expect(coordinator.protocolCounters()).toMatchObject({
      snapshots: 2,
      patches: 2,
      windowReanchors: 1
    })
  })

  it('snapshots on a moved window start even when the diff would be SMALL', () => {
    // The transport already falls back to a snapshot when a splice replaces too
    // much, which covers the ordinary re-anchor. It does NOT cover this one: the
    // anchor row is replaced in place, so the window occupies the same indices
    // and the diff is a single row. Left to the size guard alone that ships as a
    // cheap patch whose first row silently redefines the window boundary the
    // renderer is paging against. The anchor moved, so the snapshot is owed.
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    coordinator.enqueue(sink, growingChat(1, 1_600))
    ackAsRenderer(coordinator, sink, sink.deliveries[0])
    const anchored = sink.deliveries[0]
    if (anchored.kind !== 'snapshot') throw new Error('expected a snapshot')
    const anchorId = anchored.chat.messages[0]?.id
    const anchorIndex = 1_600 - anchored.chat.messages.length

    const rekeyed = growingChat(2, 1_600)
    rekeyed.messages[anchorIndex] = {
      ...rekeyed.messages[anchorIndex],
      id: `${anchorId}-rekeyed`
    }
    coordinator.enqueue(sink, rekeyed)

    expect(sink.deliveries[1].kind).toBe('snapshot')
    expect(coordinator.protocolCounters()).toMatchObject({
      snapshots: 2,
      patches: 0,
      windowReanchors: 1
    })
  })

  it('re-anchors when a chat crosses the paging threshold under an ACKed full record', () => {
    // The target holds a WHOLE record. The first windowed delivery cannot be a
    // patch onto it — the window drops every older row — so it must cost one
    // snapshot and be counted as the re-anchor it is.
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    coordinator.enqueue(sink, growingChat(1, 900))
    const baseline = ackAsRenderer(coordinator, sink, sink.deliveries[0]).baseline
    expect(sink.deliveries[0].kind).toBe('snapshot')

    coordinator.enqueue(sink, growingChat(2, 1_000))
    expect(sink.deliveries[1].kind).toBe('patch')
    ackAsRenderer(coordinator, sink, sink.deliveries[1], baseline)

    coordinator.enqueue(sink, growingChat(3, 1_600))
    expect(sink.deliveries[2].kind).toBe('snapshot')
    expect(coordinator.protocolCounters()).toMatchObject({ windowReanchors: 1 })
  })
})

describe('ChatUpdateDeliveryCoordinator bounded-snapshot baselines', () => {
  function oversizedChat(updatedAt: number, tailContent: string): ChatRecord {
    const contents = Array.from({ length: 1_501 }, (_, index) => `row-${index}`)
    contents[contents.length - 1] = tailContent
    return chat(updatedAt, contents)
  }

  it('delivers an oversized chat as a bounded shell, not the canonical record', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    coordinator.enqueue(sink, oversizedChat(1, 'first'))
    const delivery = sink.deliveries[0]
    expect(delivery.kind).toBe('snapshot')
    if (delivery.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect((delivery.chat as { transcriptPaged?: boolean }).transcriptPaged).toBe(true)
    // The page, not the transcript: the bound is DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES.
    expect(delivery.chat.messages).toHaveLength(DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES)
    expect(delivery.chat.messages[0].id).toBe('message-1')
    expect(delivery.chat.messages.at(-1)?.id).toBe('message-1500')
  })

  it('PATCHES after the bounded snapshot is acknowledged', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const [first, second] = projectSequence(oversizedChat(1, 'one'), oversizedChat(2, 'two'))
    coordinator.enqueue(sink, first)
    ackAsRenderer(coordinator, sink, sink.deliveries[0])
    coordinator.enqueue(sink, second)

    expect(sink.deliveries[1].kind).toBe('patch')
    expect(coordinator.protocolCounters()).toMatchObject({
      snapshots: 1,
      patches: 1,
      baselineDrops: 0
    })
  })

  it('keeps patching across many deliveries instead of degrading every time', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const records = projectSequence(
      oversizedChat(1, 'one'),
      oversizedChat(2, 'two'),
      oversizedChat(3, 'three'),
      oversizedChat(4, 'four')
    )
    let baseline: ChatUpdateBaseline | undefined
    for (const record of records) {
      coordinator.enqueue(sink, record)
      const latest = sink.deliveries[sink.deliveries.length - 1]
      baseline = ackAsRenderer(coordinator, sink, latest, baseline).baseline
    }

    const counters = coordinator.protocolCounters()
    expect(counters.snapshots).toBe(1)
    expect(counters.patches).toBe(3)
    expect(counters.baselineDrops).toBe(0)
    expect(sink.deliveries).toHaveLength(4)
    expect(sink.deliveries.slice(1).map((delivery) => delivery.kind)).toEqual([
      'patch',
      'patch',
      'patch'
    ])
  })

  it('keeps the renderer marked as paged — a patch must not claim a full transcript', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const [first, second] = projectSequence(oversizedChat(1, 'one'), oversizedChat(2, 'two'))
    coordinator.enqueue(sink, first)
    const snapshotDelivery = sink.deliveries[0]
    if (snapshotDelivery.kind !== 'snapshot') throw new Error('expected a snapshot')
    ackAsRenderer(coordinator, sink, snapshotDelivery)
    coordinator.enqueue(sink, second)

    const patch = sink.deliveries[1]
    if (patch.kind !== 'patch' || patch.protocolVersion !== 2) {
      throw new Error('expected a v2 patch')
    }
    // Clearing these would tell a renderer holding ONE PAGE that it holds the
    // whole transcript — the failure mode of diffing a shell against canonical.
    expect(patch.recordCleared ?? []).not.toContain('transcriptPaged')
    expect(patch.recordCleared ?? []).not.toContain('summaryOnly')
    expect(patch.recordCleared ?? []).not.toContain('messageCount')
    // And it must not re-ship the whole runs array as "changed chrome".
    expect(Object.keys(patch.recordDelta ?? {})).not.toContain('runs')
  })

  it('round-trips through the renderer apply, so the ACK hash matches', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const [first, second] = projectSequence(oversizedChat(1, 'one'), oversizedChat(2, 'two'))

    coordinator.enqueue(sink, first)
    const snapshotDelivery = sink.deliveries[0]
    const { baseline: seedBaseline, acknowledged: seedAcknowledged } = ackAsRenderer(
      coordinator,
      sink,
      snapshotDelivery
    )
    expect(seedAcknowledged).toBe(true)

    coordinator.enqueue(sink, second)
    const patch = sink.deliveries[1]
    expect(patch.kind).toBe('patch')
    const { baseline: patchedBaseline, acknowledged } = ackAsRenderer(
      coordinator,
      sink,
      patch,
      seedBaseline
    )
    // The renderer still holds a page, still marked paged.
    expect((patchedBaseline.chat as { transcriptPaged?: boolean }).transcriptPaged).toBe(true)
    expect(patchedBaseline.chat.messages).toHaveLength(DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES)
    expect(patchedBaseline.chat.messages.at(-1)?.content).toBe('two')

    // The ACK the renderer would send is accepted, which is the whole contract:
    // main and the renderer agree on the record the renderer is holding.
    expect(acknowledged).toBe(true)
    expect(coordinator.protocolCounters().ackRejections).toBe(0)
  })

  it('patches normally for a chat small enough to deliver whole', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const [first, second] = projectSequence(chat(1, ['one']), chat(2, ['two']))
    coordinator.enqueue(sink, first)
    ackAsRenderer(coordinator, sink, sink.deliveries[0])
    coordinator.enqueue(sink, second)
    expect(sink.deliveries[1].kind).toBe('patch')
    expect(coordinator.protocolCounters()).toMatchObject({ baselineDrops: 0 })
  })
})
