import { describe, expect, it, vi } from 'vitest'

import type { HostWriteDecision } from '../host-shared/thread-log/ThreadOwnership'
import { HostThreadWriteGate } from './HostThreadWriteGate'

const WRITE: HostWriteDecision = { kind: 'write' }
const BUSY: HostWriteDecision = { kind: 'busy', reason: 'thread_busy_in_desktop' }
const FOLD: HostWriteDecision = { kind: 'fold_first', revision: 9 }
const ASK: HostWriteDecision = {
  kind: 'ask_release',
  writerId: 'desk-1',
  created: true,
  request: {
    threadId: 'thread-1',
    epoch: { host: 'e'.repeat(64), grant: 1 },
    requestId: 1,
    deadline: 10_000
  }
}

function gateAnswering(...decisions: Array<HostWriteDecision | Error>) {
  const decide = vi.fn(async (_threadId: string): Promise<HostWriteDecision> => {
    const next = decisions.shift()
    if (!next) throw new Error('asked once too often')
    if (next instanceof Error) throw next
    return next
  })
  return { gate: new HostThreadWriteGate({ decide }), decide }
}

describe('HostThreadWriteGate', () => {
  it('lets a write through only when the registry says write, and holds the thread until it is released', async () => {
    const { gate, decide } = gateAnswering(WRITE)
    expect(gate.writing('thread-1')).toBe(false)
    const write = await gate.admit('thread-1', 'composer.send')
    expect(decide).toHaveBeenCalledWith('thread-1')
    expect(write.kind).toBe('write')
    expect(gate.writing('thread-1')).toBe(true)
    expect(gate.writing('thread-2')).toBe(false)
    expect(gate.snapshot()).toMatchObject({ asked: 1, written: 1, live: 1 })
    if (write.kind !== 'write') throw new Error('not let through')
    write.release()
    expect(gate.writing('thread-1')).toBe(false)
    write.release()
    expect(gate.snapshot()).toMatchObject({ live: 0 })
  })

  it('holds a thread while any of its writes is live', async () => {
    const { gate } = gateAnswering(WRITE, WRITE, WRITE)
    const first = await gate.admit('thread-1', 'composer.send')
    const second = await gate.admit('thread-1', 'thread.configure')
    const other = await gate.admit('thread-2', 'thread.archive')
    if (first.kind !== 'write' || second.kind !== 'write' || other.kind !== 'write') {
      throw new Error('not let through')
    }
    first.release()
    first.release()
    expect(gate.writing('thread-1')).toBe(true)
    second.release()
    expect(gate.writing('thread-1')).toBe(false)
    expect(gate.writing('thread-2')).toBe(true)
    expect(gate.snapshot().live).toBe(1)
  })

  it('refuses a thread a desktop writer holds as busy, and counts it by path', async () => {
    const { gate } = gateAnswering(BUSY, ASK)
    const busy = await gate.admit('thread-1', 'thread.configure')
    const asked = await gate.admit('thread-1', 'composer.send')
    for (const refused of [busy, asked]) {
      expect(refused).toEqual({
        kind: 'refused',
        errorCode: 'thread_busy_in_desktop',
        errorMessage: expect.stringContaining('desktop app')
      })
    }
    expect(gate.writing('thread-1')).toBe(false)
    expect(gate.snapshot()).toEqual({
      asked: 2,
      written: 0,
      refused: { busy: 1, foldFirst: 0, askRelease: 1, failed: 0 },
      paths: {
        'thread.configure': { asked: 1, refused: 1 },
        'composer.send': { asked: 1, refused: 1 }
      },
      live: 0,
      lastFailure: null
    })
  })

  it('refuses a thread whose ended writer left work above the full copy until it is folded', async () => {
    const { gate } = gateAnswering(FOLD)
    expect(await gate.admit('thread-1', 'catalogue.recovery')).toEqual({
      kind: 'refused',
      errorCode: 'thread_fold_first',
      errorMessage: expect.stringContaining('desktop app')
    })
    expect(gate.writing('thread-1')).toBe(false)
    expect(gate.snapshot()).toMatchObject({
      refused: { busy: 0, foldFirst: 1, askRelease: 0, failed: 0 },
      paths: { 'catalogue.recovery': { asked: 1, refused: 1 } }
    })
  })

  it('refuses as busy when the registry cannot decide, and says why in its snapshot', async () => {
    const { gate } = gateAnswering(new Error('Thread log head is unreadable: torn'))
    expect(await gate.admit('thread-1', 'ensemble.seat.toggle')).toEqual({
      kind: 'refused',
      errorCode: 'thread_busy_in_desktop',
      errorMessage: expect.stringContaining('desktop app')
    })
    expect(gate.writing('thread-1')).toBe(false)
    expect(gate.snapshot()).toMatchObject({
      refused: { busy: 0, foldFirst: 0, askRelease: 0, failed: 1 },
      lastFailure: 'Thread log head is unreadable: torn'
    })
  })

  it('holds the thread from the moment its caller is answered', async () => {
    let answer!: (decision: HostWriteDecision) => void
    const gate = new HostThreadWriteGate({
      decide: () =>
        new Promise<HostWriteDecision>((resolve) => {
          answer = resolve
        })
    })
    const admitted = gate.admit('thread-1', 'composer.send')
    await Promise.resolve()
    expect(gate.writing('thread-1')).toBe(false)
    answer(WRITE)
    let heldWhenAnswered: boolean | undefined
    const write = await admitted.then((result) => {
      heldWhenAnswered = gate.writing('thread-1')
      return result
    })
    expect(heldWhenAnswered).toBe(true)
    expect(write.kind).toBe('write')
  })
})
