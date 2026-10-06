import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../main/store/types'
import {
  MAX_SUPERSEDED_INTENT_HANDLES,
  PerChatSaveIntentQueue,
  persistIdempotencyKeyFor,
  type ChatSaveIntent
} from './chatSaveIntentQueue'

function record(chatId: string, revision: number): ChatRecord {
  return { appChatId: chatId, title: 't', persistenceRevision: revision, messages: [] } as never
}

function intent(chatId: string, revision: number, commandId = `cmd-${revision}`): ChatSaveIntent {
  return {
    chatId,
    record: record(chatId, revision),
    authoredAt: 1_000 + revision,
    commandId,
    idempotencyKey: persistIdempotencyKeyFor(commandId)
  }
}

describe('PerChatSaveIntentQueue', () => {
  it('pins the replay record to the actual normalized save without losing exact handles', () => {
    const queue = new PerChatSaveIntentQueue()
    queue.enqueue(intent('a', 4))
    queue.enqueue(intent('a', 5))
    const saved = record('a', 6)
    expect(queue.pinAdmittedRevision('a', 'cmd-5', 6, saved)).toBe(true)
    expect(queue.peek('a')[0].record).toBe(saved)
    expect(queue.peek('a')[0].supersedes?.map((handle) => handle.commandId)).toEqual(['cmd-4'])
    expect(queue.confirmPublication('a', 'cmd-5', 'host-command', 6)).toBe(true)
    expect(queue.publicationFor('cmd-5')).toEqual({
      intentCommandId: 'cmd-5',
      hostCommandId: 'host-command',
      revision: 6
    })
    queue.reset('a')
    expect(queue.publicationFor('cmd-5')).toBeNull()
  })

  it('coalesces earlier intents into the latest and keeps every command handle', () => {
    const queue = new PerChatSaveIntentQueue()
    queue.enqueue(intent('a', 1))
    queue.enqueue(intent('a', 2))
    queue.enqueue(intent('a', 3))

    const [latest, ...rest] = queue.peek('a')
    expect(rest).toEqual([])
    expect(latest.commandId).toBe('cmd-3')
    expect(latest.record.persistenceRevision).toBe(3)
    expect(latest.supersedes?.map((handle) => handle.commandId)).toEqual(['cmd-1', 'cmd-2'])
    expect(latest.supersedes?.[0].idempotencyKey).toBe('thread:record-persist:cmd-1')
  })

  it('keeps chats independent', () => {
    const queue = new PerChatSaveIntentQueue()
    queue.enqueue(intent('a', 1))
    queue.enqueue(intent('b', 7))
    expect(queue.peek('a')[0].record.persistenceRevision).toBe(1)
    expect(queue.peek('b')[0].record.persistenceRevision).toBe(7)
  })

  it('rejects an intent that is not for its chat or has no exact handle', () => {
    const queue = new PerChatSaveIntentQueue()
    expect(() => queue.enqueue({ ...intent('a', 1), chatId: 'b' })).toThrow(/does not belong/)
    expect(() => queue.enqueue({ ...intent('a', 1), commandId: '' })).toThrow(/command handle/)
    expect(() => queue.enqueue({ ...intent('a', 1), idempotencyKey: '' })).toThrow(/command handle/)
    expect(queue.peek('a')).toEqual([])
  })

  it('peek does not remove and drain does', () => {
    const queue = new PerChatSaveIntentQueue()
    queue.enqueue(intent('a', 1))
    expect(queue.peek('a')).toHaveLength(1)
    expect(queue.peek('a')).toHaveLength(1)
    expect(queue.drain('a').map((item) => item.commandId)).toEqual(['cmd-1'])
    expect(queue.drain('a')).toEqual([])
    expect(queue.admittedHead('a')).toEqual({ revision: 1, commandId: 'cmd-1' })
  })

  it('pauses flushes while frozen and resumes on unfreeze', () => {
    const queue = new PerChatSaveIntentQueue()
    queue.enqueue(intent('a', 4))
    queue.freezeHead('a', 4)
    expect(queue.isFrozen('a')).toBe(true)
    expect(queue.frozenHead('a')).toEqual({ revision: 4, commandId: 'cmd-4' })
    expect(queue.drain('a')).toEqual([])
    expect(queue.peek('a')).toHaveLength(1)

    queue.enqueue(intent('a', 5))
    expect(queue.frozenHead('a')?.revision).toBe(4)
    queue.unfreeze('a')
    expect(queue.isFrozen('a')).toBe(false)
    const drained = queue.drain('a')
    expect(drained).toHaveLength(1)
    expect(drained[0].commandId).toBe('cmd-5')
  })

  it('only freezes the admitted head, and only one head at a time', () => {
    const queue = new PerChatSaveIntentQueue()
    expect(() => queue.freezeHead('a', 1)).toThrow(/No admitted head/)
    queue.enqueue(intent('a', 2))
    expect(() => queue.freezeHead('a', 1)).toThrow(/not the admitted head/)
    expect(() => queue.freezeHead('a', -1)).toThrow(/non-negative/)
    queue.freezeHead('a', 2)
    queue.freezeHead('a', 2)
    queue.enqueue(intent('a', 3))
    expect(() => queue.freezeHead('a', 3)).toThrow(/different head/)
  })

  it('settles a covered intent and only sheds a confirmed handle from a newer one', () => {
    const queue = new PerChatSaveIntentQueue()
    queue.enqueue(intent('a', 1))
    queue.enqueue(intent('a', 2))
    expect(queue.settle('a', 'cmd-1')).toBe(true)
    const [pending] = queue.peek('a')
    expect(pending.commandId).toBe('cmd-2')
    expect(pending.supersedes ?? []).toEqual([])
    expect(queue.settle('a', 'nope')).toBe(false)
    expect(queue.settle('a', 'cmd-2')).toBe(true)
    expect(queue.peek('a')).toEqual([])
    expect(queue.settle('a', 'cmd-2')).toBe(false)
  })

  it('settleThrough releases only intents authored at or before the confirmed revision', () => {
    const queue = new PerChatSaveIntentQueue()
    queue.enqueue(intent('a', 5))
    expect(queue.settleThrough('a', 4)).toBe(false)
    expect(queue.peek('a')).toHaveLength(1)
    expect(queue.settleThrough('a', 5)).toBe(true)
    expect(queue.peek('a')).toEqual([])
    expect(queue.admittedHead('a')?.revision).toBe(5)
  })

  it('reset drops pending intents and the freeze but remembers the admitted head', () => {
    const queue = new PerChatSaveIntentQueue()
    queue.enqueue(intent('a', 1))
    queue.freezeHead('a', 1)
    queue.reset('a')
    expect(queue.peek('a')).toEqual([])
    expect(queue.isFrozen('a')).toBe(false)
    expect(queue.admittedHead('a')).toEqual({ revision: 1, commandId: 'cmd-1' })
  })

  it('forget removes a chat entirely', () => {
    const queue = new PerChatSaveIntentQueue()
    queue.enqueue(intent('a', 1))
    queue.enqueue(intent('b', 1))
    expect(queue.forget('a')).toBe(true)
    expect(queue.admittedHead('a')).toBeNull()
    expect(queue.peek('b')).toHaveLength(1)
    queue.forgetAll()
    expect(queue.stats().chats).toBe(0)
  })

  it('requeues an older intent beneath a newer pending one', () => {
    const queue = new PerChatSaveIntentQueue()
    queue.enqueue(intent('a', 1))
    const [older] = queue.drain('a')
    queue.requeue(older)
    expect(queue.peek('a')[0].commandId).toBe('cmd-1')

    const [again] = queue.drain('a')
    queue.enqueue(intent('a', 2))
    queue.requeue(again)
    const [pending] = queue.peek('a')
    expect(pending.commandId).toBe('cmd-2')
    expect(pending.supersedes?.map((handle) => handle.commandId)).toEqual(['cmd-1'])
    expect(queue.admittedHead('a')?.commandId).toBe('cmd-2')
  })

  it('locates the admitted head and the pending intent by handle', () => {
    const queue = new PerChatSaveIntentQueue()
    queue.enqueue(intent('a', 3))
    expect(queue.locate('cmd-3')).toEqual({ chatId: 'a', revision: 3 })
    expect(queue.locate('unknown')).toBeNull()
  })

  it('bounds retained superseded handles and counts what it drops', () => {
    const queue = new PerChatSaveIntentQueue()
    for (let n = 0; n < MAX_SUPERSEDED_INTENT_HANDLES + 5; n += 1) queue.enqueue(intent('a', n))
    const [latest] = queue.peek('a')
    expect(latest.supersedes).toHaveLength(MAX_SUPERSEDED_INTENT_HANDLES)
    expect(queue.stats().droppedHandles).toBe(4)
    expect(latest.supersedes?.at(-1)?.commandId).toBe(`cmd-${MAX_SUPERSEDED_INTENT_HANDLES + 3}`)
  })

  it('pinAdmittedRevision updates the admitted head to the post-save revision', () => {
    // The intent is admitted before the save runs, so the recorded revision
    // is the pre-save value. The save then advances the revision by one;
    // activation looks up the receipt by commandId and matches the
    // receipt's revision against the admitted head — without a pin, every
    // save that advances the revision can never confirm.
    const queue = new PerChatSaveIntentQueue()
    queue.enqueue(intent('a', 5))
    expect(queue.admittedHead('a')?.revision).toBe(5)
    expect(queue.pinAdmittedRevision('a', 'cmd-5', 6)).toBe(true)
    expect(queue.admittedHead('a')?.revision).toBe(6)
  })

  it('pinAdmittedRevision refuses to overwrite a head that no longer matches', () => {
    // A newer intent took over the slot; pinning the older one's revision
    // would mis-state the head for activation.
    const queue = new PerChatSaveIntentQueue()
    queue.enqueue(intent('a', 5))
    queue.enqueue(intent('a', 6))
    expect(queue.pinAdmittedRevision('a', 'cmd-5', 5)).toBe(false)
    expect(queue.admittedHead('a')?.revision).toBe(6)
  })

  it('pinAdmittedRevision refuses unknown handle, unknown chat, and bad revisions', () => {
    const queue = new PerChatSaveIntentQueue()
    expect(queue.pinAdmittedRevision('a', 'cmd-missing', 1)).toBe(false)
    queue.enqueue(intent('a', 1))
    expect(queue.pinAdmittedRevision('missing', 'cmd-1', 2)).toBe(false)
    expect(queue.pinAdmittedRevision('a', 'cmd-other', 99)).toBe(false)
    expect(queue.pinAdmittedRevision('a', 'cmd-1', -1)).toBe(false)
    expect(queue.pinAdmittedRevision('a', 'cmd-1', 1.5)).toBe(false)
    expect(queue.pinAdmittedRevision('a', 'cmd-1', Number.POSITIVE_INFINITY)).toBe(false)
    expect(queue.admittedHead('a')?.revision).toBe(1)
  })
})
