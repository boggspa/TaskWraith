import { describe, expect, it } from 'vitest'
import { deriveChatRecordMutation, type ChatRecordMutationBatch } from './ChatRecordMutation'
import type { ChatRecord } from './types'
import { captureJournalSource, replayJournalSource } from './JournalSourceCapture'

const inode = (ino: number) => ({ dev: '1', ino: String(ino), openGeneration: 1 })
const base: ChatRecord = {
  appChatId: 'capture',
  title: 'Baseline',
  createdAt: 1,
  updatedAt: 1,
  archived: false,
  persistenceRevision: 0,
  messages: [{ id: 'm', role: 'assistant', content: '', timestamp: '2026-10-02' }],
  runs: []
}

function fixture() {
  return {
    chatId: 'capture',
    generation: 4,
    revision: 0,
    headRevision: 0,
    baselineVerified: true,
    durabilityFallback: false,
    conflictRebased: false,
    erased: false,
    maxSourceBytes: 128,
    checkpoint: { inode: inode(1), bytes: 16, version: 'checkpoint-1', revision: 0 },
    sealed: null,
    active: { inode: inode(2), bytes: 0 }
  }
}

describe('M5 journal source capture model', () => {
  it('captures O(1) references and refuses each admission exception', () => {
    const input = fixture()
    expect(captureJournalSource(input).kind).toBe('captured')
    for (const [change, reason] of [
      [{ erased: true }, 'erased'],
      [{ durabilityFallback: true }, 'durability-fallback'],
      [{ conflictRebased: true }, 'conflict-rebased'],
      [{ baselineVerified: false }, 'baseline-unverified'],
      [{ headRevision: 1 }, 'revision-mismatch'],
      [{ checkpoint: null }, 'no-journal'],
      [{ maxSourceBytes: 8 }, 'oversize']
    ] as const) {
      expect(captureJournalSource({ ...input, ...change })).toEqual({ kind: 'fallback', reason })
    }
    expect(captureJournalSource({ ...input, revision: NaN })).toEqual({
      kind: 'fallback',
      reason: 'invalid-source'
    })
  })

  it('refuses generation changes, inode reuse, truncation, and immutable replacement', () => {
    const input = fixture()
    const result = captureJournalSource(input)
    if (result.kind !== 'captured') throw new Error('Not captured')
    const source = {
      chatId: 'capture',
      generation: 4,
      erased: false,
      checkpoint: { ...input.checkpoint, record: base },
      segments: [{ inode: inode(2), bytes: 0, batches: [] }]
    }
    expect(replayJournalSource(result.capture, source)).toEqual(base)
    for (const change of [
      { generation: 5 },
      { erased: true },
      { chatId: 'other' },
      { checkpoint: { ...source.checkpoint, version: 'replacement' } },
      { segments: [{ inode: { ...inode(2), openGeneration: 2 }, bytes: 0, batches: [] }] }
    ])
      expect(() => replayJournalSource(result.capture, { ...source, ...change })).toThrow()
  })

  it('JSON-round-trip parity at every R despite later appends and inode-preserving rotation', () => {
    for (let seed = 1; seed <= 12; seed++) {
      let record = structuredClone(base)
      const records = [record]
      const batches: Array<{ endOffset: number; batch: ChatRecordMutationBatch }> = []
      for (let revision = 1; revision <= 16; revision++) {
        const next = structuredClone(record)
        next.persistenceRevision = revision
        next.updatedAt = revision + 1
        next.messages[0].content += String.fromCodePoint(0x1f600 + ((seed + revision) % 10))
        next.title = `seed-${seed}-revision-${revision}`
        if (revision % 3 === 0)
          next.messages[0].metadata = { evidence: { revision, rows: [seed, null] } }
        batches.push({ endOffset: revision * 4, batch: deriveChatRecordMutation(record, next) })
        records.push(next)
        record = next
      }
      for (let revision = 0; revision <= 16; revision++) {
        const input = {
          ...fixture(),
          revision,
          headRevision: revision,
          active: { inode: inode(2), bytes: revision * 4 }
        }
        const result = captureJournalSource(input)
        if (result.kind !== 'captured') throw new Error('Not captured')
        // The original active inode now appears as a sealed segment. Its suffix
        // and a new active inode must not advance the captured revision.
        const source = {
          chatId: 'capture',
          generation: 4,
          erased: false,
          checkpoint: { ...input.checkpoint, record: base },
          segments: [
            { inode: inode(2), bytes: 64, batches },
            { inode: inode(3), bytes: 0, batches: [] }
          ]
        }
        expect(JSON.parse(JSON.stringify(replayJournalSource(result.capture, source)))).toEqual(
          records[revision]
        )
        if (revision > 0)
          expect(() =>
            replayJournalSource(result.capture, {
              ...source,
              segments: [{ inode: inode(2), bytes: revision * 4 - 1, batches }]
            })
          ).toThrow()
      }
    }
  })

  it('refuses a revision gap and a prefix not ending on a complete batch', () => {
    const next = { ...structuredClone(base), persistenceRevision: 1, title: 'next' }
    const batch = deriveChatRecordMutation(base, next)
    const input = {
      ...fixture(),
      revision: 1,
      headRevision: 1,
      active: { inode: inode(2), bytes: 4 }
    }
    const result = captureJournalSource(input)
    if (result.kind !== 'captured') throw new Error('Not captured')
    const source = {
      chatId: 'capture',
      generation: 4,
      erased: false,
      checkpoint: { ...input.checkpoint, record: base },
      segments: [{ inode: inode(2), bytes: 8, batches: [{ endOffset: 4, batch }] }]
    }
    expect(() =>
      replayJournalSource(result.capture, {
        ...source,
        segments: [
          {
            inode: inode(2),
            bytes: 8,
            batches: [{ endOffset: 4, batch: { ...batch, baseRevision: 2, revision: 3 } }]
          }
        ]
      })
    ).toThrow()
    expect(() =>
      replayJournalSource(result.capture, {
        ...source,
        segments: [{ inode: inode(2), bytes: 8, batches: [{ endOffset: 5, batch }] }]
      })
    ).toThrow()
  })

  it('replays sealed then active while skipping batches covered by the checkpoint', () => {
    const one = { ...structuredClone(base), persistenceRevision: 1, title: 'one' }
    const two = { ...structuredClone(one), persistenceRevision: 2, title: 'two' }
    const three = { ...structuredClone(two), persistenceRevision: 3, title: 'three' }
    const input = {
      ...fixture(),
      revision: 3,
      headRevision: 3,
      checkpoint: { ...fixture().checkpoint, revision: 1 },
      sealed: { inode: inode(3), bytes: 8, version: 'sealed-1' },
      active: { inode: inode(2), bytes: 4 }
    }
    const result = captureJournalSource(input)
    if (result.kind !== 'captured') throw new Error('Not captured')
    const source = {
      chatId: 'capture',
      generation: 4,
      erased: false,
      checkpoint: { ...input.checkpoint, record: one },
      segments: [
        {
          ...input.sealed,
          batches: [
            { endOffset: 4, batch: deriveChatRecordMutation(base, one) },
            { endOffset: 8, batch: deriveChatRecordMutation(one, two) }
          ]
        },
        {
          ...input.active,
          batches: [{ endOffset: 4, batch: deriveChatRecordMutation(two, three) }]
        }
      ]
    }
    expect(replayJournalSource(result.capture, source)).toEqual(three)
    expect(() =>
      replayJournalSource(result.capture, {
        ...source,
        segments: [{ ...source.segments[0], version: 'changed' }, source.segments[1]]
      })
    ).toThrow()
    expect(() =>
      replayJournalSource(result.capture, {
        ...source,
        segments: [source.segments[0], source.segments[1], source.segments[1]]
      })
    ).toThrow()
    expect(result.capture.active).not.toBe(input.active)
    input.active.bytes = 99
    expect(result.capture.active!.bytes).toBe(4)
    expect(Object.isFrozen(result.capture.active!.inode)).toBe(true)
  })

  it('refuses a torn suffix even when the complete batches already reach R', () => {
    const next = { ...structuredClone(base), persistenceRevision: 1, title: 'next' }
    const result = captureJournalSource({
      ...fixture(),
      revision: 1,
      headRevision: 1,
      active: { inode: inode(2), bytes: 5 }
    })
    if (result.kind !== 'captured') throw new Error('Not captured')
    expect(() =>
      replayJournalSource(result.capture, {
        chatId: 'capture',
        generation: 4,
        erased: false,
        checkpoint: { ...fixture().checkpoint, record: base },
        segments: [
          {
            inode: inode(2),
            bytes: 5,
            batches: [{ endOffset: 4, batch: deriveChatRecordMutation(base, next) }]
          }
        ]
      })
    ).toThrow('Torn captured prefix')
  })

  it('classifies all combinations of the seven fallback conditions deterministically', () => {
    const reasons = [
      'erased',
      'durability-fallback',
      'conflict-rebased',
      'baseline-unverified',
      'revision-mismatch',
      'no-journal',
      'oversize'
    ]
    for (let mask = 0; mask < 128; mask++) {
      const input = {
        ...fixture(),
        erased: !!(mask & 1),
        durabilityFallback: !!(mask & 2),
        conflictRebased: !!(mask & 4),
        baselineVerified: !(mask & 8),
        headRevision: mask & 16 ? 1 : 0,
        checkpoint: mask & 32 ? null : fixture().checkpoint,
        maxSourceBytes: mask & 64 ? 8 : 128
      }
      const first = reasons.findIndex((_reason, index) => mask & (1 << index))
      expect(captureJournalSource(input)).toMatchObject(
        first < 0 ? { kind: 'captured' } : { kind: 'fallback', reason: reasons[first] }
      )
    }
  })
})
