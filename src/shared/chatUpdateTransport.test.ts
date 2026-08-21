import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from '../main/store/types'
import {
  CHAT_UPDATE_PROTOCOL_V1,
  CHAT_UPDATE_PROTOCOL_V2,
  applyChatUpdateDelivery,
  applyChatTranscriptOps,
  buildChatRecordDelta,
  buildChatTranscriptOps,
  buildChatUpdateDelivery,
  buildChatUpdateMessageSplice,
  computeChatSubRevisions,
  composeChatUpdateProducerDeltas,
  estimateChatRecordBytes,
  isChatUpdateDelivery,
  normalizeChatUpdateAck,
  type ChatUpdateProducerDelta
} from './chatUpdateTransport'

function message(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, timestamp: '2026-07-18T00:00:00.000Z' }
}

function chat(
  revision: number,
  messages: ChatMessage[],
  extras: Partial<ChatRecord> = {}
): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Large ensemble',
    provider: 'codex',
    chatKind: 'ensemble',
    archived: false,
    messages,
    runs: [],
    createdAt: 1,
    updatedAt: revision,
    persistenceRevision: revision,
    ...extras
  } as ChatRecord
}

function producerDelta(before: ChatRecord, after: ChatRecord): ChatUpdateProducerDelta {
  const { messages: _beforeMessages, ...beforeRecord } = before
  const { messages: _afterMessages, ...afterRecord } = after
  const record = buildChatRecordDelta(beforeRecord, afterRecord)
  const transcriptOps = buildChatTranscriptOps(before.messages, after.messages)
  const sub = computeChatSubRevisions(after)
  return {
    chatId: after.appChatId,
    basePersistenceRevision: before.persistenceRevision ?? 0,
    persistenceRevision: after.persistenceRevision ?? 0,
    ...record,
    transcriptOps,
    changedMessageCount:
      transcriptOps?.reduce((count, operation) => {
        if (operation.op === 'append') return count + operation.messages.length
        return count + 1
      }, 0) ?? after.messages.length,
    retainedBytes: estimateChatRecordBytes(after),
    ...sub
  }
}

describe('chat update transport', () => {
  it('builds one exact middle splice while retaining an unchanged prefix and suffix', () => {
    const a = message('a', 'A')
    const b = message('b', 'B')
    const c = message('c', 'C')
    const d = message('d', 'D')
    expect(buildChatUpdateMessageSplice([a, b, d], [a, c, d])).toEqual({
      start: 1,
      deleteCount: 1,
      items: [c]
    })
  })

  it('round-trips a revisioned patch to the exact next chat', () => {
    const first = chat(1, [message('a', 'A'), message('b', 'B')])
    const next = {
      ...chat(2, [message('a', 'A'), message('b', 'B grew'), message('c', 'C')]),
      title: 'Updated ensemble'
    }
    const delivery = buildChatUpdateDelivery({
      deliveryId: 'delivery-2',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first }
    })
    expect(delivery.kind).toBe('patch')
    expect(delivery.protocolVersion).toBe(CHAT_UPDATE_PROTOCOL_V1)
    const applied = applyChatUpdateDelivery(delivery, { revision: 1, chat: first })
    expect(applied).toMatchObject({ ok: true, baseline: { revision: 2, chat: next } })
    if (!applied.ok) throw new Error('apply failed')
    expect(applied.baseline.recordHash).toBe(computeChatSubRevisions(next).recordHash)
  })

  it('fingerprints the applied chat instead of echoing the delivery hash', () => {
    const first = chat(1, [message('a', 'A')])
    const next = chat(2, [message('a', 'A'), message('b', 'B')])
    const delivery = buildChatUpdateDelivery({
      deliveryId: 'echo',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first },
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })
    expect(delivery.kind).toBe('patch')
    if (delivery.kind !== 'patch' || delivery.protocolVersion !== CHAT_UPDATE_PROTOCOL_V2) {
      throw new Error('expected v2 patch')
    }
    const lied = { ...delivery, recordHash: 'deadbeef' }
    const applied = applyChatUpdateDelivery(lied, { revision: 1, chat: first })
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error('apply failed')
    expect(applied.baseline.recordHash).toBe(computeChatSubRevisions(next).recordHash)
    expect(applied.baseline.recordHash).not.toBe('deadbeef')
  })

  it('nacks a patch whose transcript integrity chain does not match its accepted base', () => {
    const first = chat(1, [message('a', 'A')])
    const snapshot = buildChatUpdateDelivery({
      deliveryId: 'digest-seed',
      revision: 1,
      chat: first,
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })
    const seeded = applyChatUpdateDelivery(snapshot)
    expect(seeded.ok).toBe(true)
    if (!seeded.ok) throw new Error(seeded.reason)

    const next = chat(2, [message('a', 'A'), message('b', 'B')])
    const patch = buildChatUpdateDelivery({
      deliveryId: 'digest-patch',
      revision: 2,
      chat: next,
      baseline: seeded.baseline,
      producerDelta: producerDelta(first, next),
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })
    expect(patch.kind).toBe('patch')
    if (patch.kind !== 'patch' || patch.protocolVersion !== CHAT_UPDATE_PROTOCOL_V2) {
      throw new Error('expected v2 patch')
    }
    expect(patch.baseTranscriptHash).toBe(seeded.baseline.transcriptHash)
    expect(patch.transcriptHash).toBeTruthy()
    expect(
      applyChatUpdateDelivery({ ...patch, transcriptHash: 'deadbeef' }, seeded.baseline)
    ).toEqual({ ok: false, reason: 'Patch transcript hash does not match its baseline.' })
    expect(applyChatUpdateDelivery(patch, seeded.baseline)).toMatchObject({
      ok: true,
      baseline: { chat: next }
    })
  })

  it.each([CHAT_UPDATE_PROTOCOL_V1, CHAT_UPDATE_PROTOCOL_V2])(
    'carries the transcript chain through a %i snapshot-to-patch recovery path',
    (protocolVersion) => {
      const first = chat(1, [message('a', 'A')])
      const snapshot = buildChatUpdateDelivery({
        deliveryId: `chain-seed-${protocolVersion}`,
        revision: 1,
        chat: first,
        protocolVersion
      })
      const seeded = applyChatUpdateDelivery(snapshot)
      if (!seeded.ok) throw new Error(seeded.reason)

      const next = chat(2, [message('a', 'A'), message('b', 'B')])
      const patch = buildChatUpdateDelivery({
        deliveryId: `chain-patch-${protocolVersion}`,
        revision: 2,
        chat: next,
        baseline: seeded.baseline,
        producerDelta: producerDelta(first, next),
        protocolVersion
      })
      expect(patch.kind).toBe('patch')
      expect(applyChatUpdateDelivery(patch, seeded.baseline)).toMatchObject({
        ok: true,
        baseline: { chat: next }
      })
    }
  )

  it('rejects a patch against the wrong baseline so the sender can resync with a snapshot', () => {
    const first = chat(1, [message('a', 'A')])
    const next = chat(2, [message('a', 'B')])
    const delivery = buildChatUpdateDelivery({
      deliveryId: 'delivery-2',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first }
    })
    expect(applyChatUpdateDelivery(delivery, { revision: 9, chat: first })).toEqual({
      ok: false,
      reason: 'Patch base revision is stale.'
    })
  })

  it('uses a full snapshot when most of the transcript changed', () => {
    const first = chat(
      1,
      Array.from({ length: 60 }, (_, index) => message(`old-${index}`, String(index)))
    )
    const next = chat(
      2,
      Array.from({ length: 60 }, (_, index) => message(`new-${index}`, String(index)))
    )
    expect(
      buildChatUpdateDelivery({
        deliveryId: 'delivery-2',
        revision: 2,
        chat: next,
        baseline: { revision: 1, chat: first }
      }).kind
    ).toBe('snapshot')
  })

  it('keeps an append-sized update small for a multi-megabyte transcript', () => {
    const largeMessages = Array.from({ length: 700 }, (_, index) =>
      message(`message-${index}`, `${index}:${'x'.repeat(2_500)}`)
    )
    const first = chat(1, largeMessages)
    const next = chat(2, [...largeMessages, message('message-700', 'latest result')])
    const delivery = buildChatUpdateDelivery({
      deliveryId: 'delivery-large',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first }
    })

    expect(delivery.kind).toBe('patch')
    expect(JSON.stringify(delivery).length).toBeLessThan(JSON.stringify(next).length * 0.02)
    expect(applyChatUpdateDelivery(delivery, { revision: 1, chat: first })).toMatchObject({
      ok: true,
      baseline: { revision: 2, chat: next }
    })
  })

  it('strictly bounds renderer acknowledgements', () => {
    expect(normalizeChatUpdateAck({ deliveryId: 'delivery-1', applied: true })).toEqual({
      deliveryId: 'delivery-1',
      applied: true
    })
    expect(normalizeChatUpdateAck({ deliveryId: '', applied: true })).toBeNull()
    expect(normalizeChatUpdateAck({ deliveryId: 'delivery-1', applied: 'yes' })).toBeNull()
    expect(
      normalizeChatUpdateAck({
        deliveryId: 'delivery-1',
        applied: true,
        revision: 9,
        recordHash: 'deadbeef',
        transcriptHash: 'feedbeef',
        deliveryEpoch: 4,
        rendererEpoch: 'renderer-epoch',
        phase: 'rendered',
        chatId: 'chat-1'
      })
    ).toEqual({
      deliveryId: 'delivery-1',
      applied: true,
      revision: 9,
      recordHash: 'deadbeef',
      transcriptHash: 'feedbeef',
      deliveryEpoch: 4,
      rendererEpoch: 'renderer-epoch',
      phase: 'rendered',
      chatId: 'chat-1'
    })
  })

  it('dual-reads v1 and v2 patches to the same chat (field-mask + splice/ops)', () => {
    const first = chat(1, [message('a', 'A'), message('b', 'B')], {
      title: 'Before',
      pinnedNotes: 'keep-me'
    })
    const next = chat(2, [message('a', 'A'), message('b', 'B grew'), message('c', 'C')], {
      title: 'After'
    })

    const v1 = buildChatUpdateDelivery({
      deliveryId: 'v1',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first },
      protocolVersion: CHAT_UPDATE_PROTOCOL_V1
    })
    const v2 = buildChatUpdateDelivery({
      deliveryId: 'v2',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first },
      producerDelta: producerDelta(first, next),
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })

    expect(v1.protocolVersion).toBe(CHAT_UPDATE_PROTOCOL_V1)
    expect(v2.protocolVersion).toBe(CHAT_UPDATE_PROTOCOL_V2)
    expect(v1.kind).toBe('patch')
    expect(v2.kind).toBe('patch')
    if (v2.kind !== 'patch' || v2.protocolVersion !== CHAT_UPDATE_PROTOCOL_V2) {
      throw new Error('expected v2 patch')
    }
    expect(v2.recordMask).toEqual(
      expect.arrayContaining(['title', 'updatedAt', 'persistenceRevision', 'pinnedNotes'])
    )
    expect(v2.recordDelta.title).toBe('After')
    expect(v2.recordCleared).toContain('pinnedNotes')
    // Never ship a full non-message record on v2.
    expect('record' in v2).toBe(false)
    expect(Object.keys(v2.recordDelta).length).toBeLessThan(Object.keys(next).length)

    const appliedV1 = applyChatUpdateDelivery(v1, { revision: 1, chat: first })
    const appliedV2 = applyChatUpdateDelivery(v2, { revision: 1, chat: first })
    expect(appliedV1.ok).toBe(true)
    expect(appliedV2.ok).toBe(true)
    if (!appliedV1.ok || !appliedV2.ok) throw new Error('apply failed')
    expect(appliedV1.baseline.chat).toEqual(next)
    expect(appliedV2.baseline.chat).toEqual(next)
    expect(isChatUpdateDelivery(v1)).toBe(true)
    expect(isChatUpdateDelivery(v2)).toBe(true)
  })

  it('emits transcript append/update/delete ops and applies them preferentially on v2', () => {
    const first = chat(1, [message('a', 'A'), message('b', 'B'), message('c', 'C')])
    const next = chat(2, [message('a', 'A'), message('c', 'C rewritten'), message('d', 'D')])
    // delete b, update c, append d — surviving order a,c preserved.
    const ops = buildChatTranscriptOps(first.messages, next.messages)
    expect(ops).toEqual([
      { op: 'delete', id: 'b' },
      { op: 'update', id: 'c', message: message('c', 'C rewritten') },
      { op: 'append', messages: [message('d', 'D')] }
    ])

    const delivery = buildChatUpdateDelivery({
      deliveryId: 'ops',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first },
      producerDelta: producerDelta(first, next),
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })
    expect(delivery.kind).toBe('patch')
    if (delivery.kind !== 'patch' || delivery.protocolVersion !== CHAT_UPDATE_PROTOCOL_V2) {
      throw new Error('expected v2 patch')
    }
    expect(delivery.transcriptOps).toEqual(ops)
    expect(delivery.messages).toBeUndefined()

    const applied = applyChatUpdateDelivery(delivery, { revision: 1, chat: first })
    expect(applied).toMatchObject({
      ok: true,
      baseline: { revision: 2, chat: next }
    })
  })

  it('preserves transcript identity for metadata-only v2 patches', () => {
    const messages = Array.from({ length: 700 }, (_, index) => message(`m-${index}`, `${index}`))
    const first = chat(1, messages)
    const next = chat(2, messages, { title: 'Metadata changed' })
    const delivery = buildChatUpdateDelivery({
      deliveryId: 'metadata-only',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first },
      producerDelta: producerDelta(first, next),
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })

    expect(delivery.kind).toBe('patch')
    if (delivery.kind !== 'patch' || delivery.protocolVersion !== CHAT_UPDATE_PROTOCOL_V2) {
      throw new Error('expected v2 patch')
    }
    expect(delivery.transcriptOps).toEqual([])
    expect(delivery.messages).toBeUndefined()

    const applied = applyChatUpdateDelivery(delivery, { revision: 1, chat: first })
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error('apply failed')
    expect(applied.baseline.chat.messages).toBe(messages)
  })

  it('returns the same transcript array for an empty ops list', () => {
    const messages = [message('a', 'A')]
    expect(applyChatTranscriptOps(messages, [])).toBe(messages)
  })

  it('recovers a reorder by splice, and snapshots only once it outgrows the record', () => {
    const first = chat(1, [message('a', 'A'), message('b', 'B')])
    const next = chat(2, [message('b', 'B'), message('a', 'A')])
    // A reorder still escapes the append/update/delete vocabulary...
    expect(buildChatTranscriptOps(first.messages, next.messages)).toBeNull()

    // ...but it is small, so the baseline diff carries it instead of the record.
    const delivery = buildChatUpdateDelivery({
      deliveryId: 'reorder',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first },
      producerDelta: producerDelta(first, next),
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })
    expect(delivery.kind).toBe('patch')
    expect(applyChatUpdateDelivery(delivery, { revision: 1, chat: first })).toMatchObject({
      ok: true,
      baseline: { revision: 2, chat: next }
    })

    // A reversal rewrites every row: the splice is now worth no less than the
    // whole record, which is the one case a snapshot is still the cheaper wire.
    const history = Array.from({ length: 200 }, (_, index) => message(`m${index}`, `body ${index}`))
    const wide = chat(1, history)
    const reversed = chat(2, [...history].reverse())
    const wideDelivery = buildChatUpdateDelivery({
      deliveryId: 'reorder-wide',
      revision: 2,
      chat: reversed,
      baseline: { revision: 1, chat: wide },
      producerDelta: producerDelta(wide, reversed),
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })
    expect(wideDelivery.kind).toBe('snapshot')
  })

  it('composes consecutive producer deltas without re-reading either transcript', () => {
    const first = chat(1, [message('a', 'A')])
    const second = chat(2, [message('a', 'A'), message('b', 'B')])
    const third = chat(3, [message('a', 'A'), message('b', 'B2'), message('c', 'C')], {
      title: 'Third'
    })
    const composed = composeChatUpdateProducerDeltas(
      producerDelta(first, second),
      producerDelta(second, third)
    )

    expect(composed).not.toBeNull()
    expect(composed?.basePersistenceRevision).toBe(1)
    expect(composed?.persistenceRevision).toBe(3)
    expect(composed?.transcriptOps).toEqual([
      { op: 'append', messages: [message('b', 'B')] },
      { op: 'update', id: 'b', message: message('b', 'B2') },
      { op: 'append', messages: [message('c', 'C')] }
    ])

    const delivery = buildChatUpdateDelivery({
      deliveryId: 'composed',
      revision: 3,
      chat: third,
      baseline: { revision: 1, chat: first },
      producerDelta: composed ?? undefined,
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })
    expect(delivery.kind).toBe('patch')
    expect(applyChatUpdateDelivery(delivery, { revision: 1, chat: first })).toMatchObject({
      ok: true,
      baseline: { chat: third }
    })
  })

  it('owes a snapshot only when there is no baseline to recover the change from', () => {
    const next = chat(2, [message('a', 'B')])

    // No baseline: nothing to diff against, so the whole record is genuinely owed.
    expect(
      buildChatUpdateDelivery({
        deliveryId: 'no-baseline',
        revision: 2,
        chat: next,
        protocolVersion: CHAT_UPDATE_PROTOCOL_V2
      }).kind
    ).toBe('snapshot')

    // A baseline for a DIFFERENT chat is not a baseline for this one.
    expect(
      buildChatUpdateDelivery({
        deliveryId: 'foreign-baseline',
        revision: 2,
        chat: next,
        baseline: { revision: 1, chat: chat(1, [message('a', 'A')], { appChatId: 'chat-2' }) },
        protocolVersion: CHAT_UPDATE_PROTOCOL_V2
      }).kind
    ).toBe('snapshot')
  })

  it('recovers a bounded splice, not the whole transcript, when the producer delta is missing', () => {
    // 2026-08-19 renderer OOM: a producer that yields no delta degraded EVERY
    // delivery to a full-record snapshot. On a 10k-message / 19 MB chat under
    // seven concurrent runs that shipped 531 snapshots and 0 patches in 17
    // minutes, filling V8's 3.76 GB renderer ceiling until SIGTRAP. While the
    // renderer's baseline is still held, the change is recoverable by diffing
    // it — the whole record is only owed when there is no baseline at all.
    const history = Array.from({ length: 5_000 }, (_, index) =>
      message(`m${index}`, `body ${index}`)
    )
    const first = chat(1, history)
    const next = chat(2, [...history, message('tail', 'one more')])

    const delivery = buildChatUpdateDelivery({
      deliveryId: 'no-producer-delta',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first },
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })

    expect(delivery.kind).toBe('patch')
    if (delivery.kind !== 'patch' || delivery.protocolVersion !== CHAT_UPDATE_PROTOCOL_V2) {
      throw new Error('expected a v2 patch')
    }
    // The payload carries the one appended row, never the 5,001-row transcript.
    expect(delivery.messages).toEqual({
      start: 5_000,
      deleteCount: 0,
      items: [message('tail', 'one more')]
    })
    expect(applyChatUpdateDelivery(delivery, { revision: 1, chat: first })).toMatchObject({
      ok: true,
      baseline: { chat: next }
    })
  })

  it('recovers a bounded splice when the producer delta is discontinuous', () => {
    const history = Array.from({ length: 200 }, (_, index) => message(`m${index}`, `body ${index}`))
    const first = chat(1, history)
    const next = chat(2, [...history, message('tail', 'one more')])
    const discontinuous = { ...producerDelta(first, next), basePersistenceRevision: 99 }

    const delivery = buildChatUpdateDelivery({
      deliveryId: 'gap',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first },
      producerDelta: discontinuous,
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })

    expect(delivery.kind).toBe('patch')
    expect(applyChatUpdateDelivery(delivery, { revision: 1, chat: first })).toMatchObject({
      ok: true,
      baseline: { chat: next }
    })
  })

  it('builds a producer-backed patch without iterating either transcript', () => {
    const first = chat(1, [message('a', 'A')])
    const next = chat(2, [message('a', 'A'), message('b', 'B')])
    const delta = producerDelta(first, next)
    const guard = (messages: ChatMessage[]): ChatMessage[] =>
      new Proxy(messages, {
        get(target, property, receiver) {
          if (
            property === Symbol.iterator ||
            (typeof property === 'string' && /^\d+$/.test(property))
          ) {
            throw new Error('transport iterated the transcript')
          }
          return Reflect.get(target, property, receiver)
        }
      })

    const delivery = buildChatUpdateDelivery({
      deliveryId: 'no-transcript-scan',
      revision: 2,
      chat: { ...next, messages: guard(next.messages) },
      baseline: { revision: 1, chat: { ...first, messages: guard(first.messages) } },
      producerState: delta,
      producerDelta: delta,
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })

    expect(delivery.kind).toBe('patch')
  })

  it('builds a top-level field mask without copying unchanged large fields', () => {
    const bulkyRuns = Array.from({ length: 40 }, (_, index) => ({
      id: `run-${index}`,
      status: 'done' as const
    }))
    const first = chat(1, [message('a', 'A')], {
      runs: bulkyRuns as ChatRecord['runs'],
      title: 'Same title'
    })
    const next = chat(2, [message('a', 'A'), message('b', 'B')], {
      runs: bulkyRuns as ChatRecord['runs'],
      title: 'Same title'
    })
    const { messages: _m1, ...prevRecord } = first
    const { messages: _m2, ...nextRecord } = next
    const delta = buildChatRecordDelta(prevRecord, nextRecord)
    expect(delta.recordMask).not.toContain('runs')
    expect(delta.recordDelta.runs).toBeUndefined()
    expect(delta.recordMask).toEqual(expect.arrayContaining(['updatedAt', 'persistenceRevision']))

    const v2 = buildChatUpdateDelivery({
      deliveryId: 'mask',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first },
      producerDelta: producerDelta(first, next),
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })
    expect(v2.kind).toBe('patch')
    if (v2.kind !== 'patch' || v2.protocolVersion !== CHAT_UPDATE_PROTOCOL_V2) {
      throw new Error('expected v2 patch')
    }
    expect(JSON.stringify(v2).length).toBeLessThan(
      JSON.stringify({ ...next, runs: bulkyRuns }).length
    )
    expect(v2.recordDelta.runs).toBeUndefined()
  })

  it('computes stable sub-revisions and record hashes for v2 envelopes', () => {
    const sample = chat(3, [message('a', 'A')], {
      ensemble: { participants: [{ id: 'p1' }] } as ChatRecord['ensemble']
    })
    const again = computeChatSubRevisions(sample)
    expect(computeChatSubRevisions(sample)).toEqual(again)
    expect(again.recordHash).toMatch(/^[0-9a-f]{8}$/)
    expect(Number.isSafeInteger(again.ensembleRevision)).toBe(true)
    expect(Number.isSafeInteger(again.runsRevision)).toBe(true)
  })

  it('rejects unknown protocol versions while accepting both dual-read versions', () => {
    expect(
      isChatUpdateDelivery({
        protocolVersion: 99,
        kind: 'snapshot',
        deliveryId: 'x',
        chatId: 'c',
        revision: 1,
        chat: chat(1, [])
      })
    ).toBe(false)
    expect(
      isChatUpdateDelivery({
        protocolVersion: CHAT_UPDATE_PROTOCOL_V2,
        kind: 'snapshot',
        deliveryId: 'x',
        chatId: 'c',
        revision: 1,
        chat: chat(1, [])
      })
    ).toBe(true)
  })

  it('estimates retained chat bytes without JSON.stringify', () => {
    const small = chat(1, [message('a', 'hi')])
    const large = chat(2, [message('a', 'x'.repeat(10_000))])
    expect(estimateChatRecordBytes(large)).toBeGreaterThan(estimateChatRecordBytes(small))
    expect(estimateChatRecordBytes(large)).toBeGreaterThan(10_000)
  })
})
