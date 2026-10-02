import { describe, expect, it } from 'vitest'
import { ChatPreparationLane } from './ChatPreparationLane'

const request = (chatId: string, purpose: 'maintenance' | 'publication' = 'publication') => ({
  chatId,
  purpose,
  revision: 1,
  generation: 1
})

describe('M5 preparation lane model', () => {
  it('refuses a retry when 128 other tickets are queued without evicting any waiter', () => {
    const lane = new ChatPreparationLane()
    const active = lane.enqueue(request('active'), 0)
    lane.advance(0)
    const waiting = Array.from({ length: 128 }, (_, index) =>
      lane.enqueue(request(`waiting-${index}`), 1)
    )
    expect(lane.complete(active, false, 2)).toEqual([
      { type: 'release', id: active },
      { type: 'refused', id: active, reason: 'saturated' }
    ])
    expect(lane.stats()).toMatchObject({ queued: 128, active: 0, retries: 0, refusals: 1 })
    const started: number[] = []
    for (let now = 2; now < 130; now++) {
      const command = lane.advance(now)[0]
      expect(command.type).toBe('start')
      if (command.type !== 'start') throw new Error('Expected start')
      started.push(command.id)
      lane.complete(command.id, true, now, command.attempt)
    }
    expect(started).toEqual(waiting)
    expect(lane.stats()).toMatchObject({ queued: 0, active: 0 })
  })
  it('does not inspect payload fields and does not renew the deadline when coalescing', () => {
    const lane = new ChatPreparationLane()
    const input = request('chat')
    Object.defineProperty(input, 'record', {
      get: () => {
        throw new Error('Payload walked')
      }
    })
    const id = lane.enqueue(input, 0)
    lane.enqueue({ ...request('chat'), revision: 10 }, 299)
    expect(lane.advance(300)).toEqual([{ type: 'refused', id, reason: 'deadline' }])
  })

  it('ignores a late result from a prior retry attempt', () => {
    const lane = new ChatPreparationLane()
    const id = lane.enqueue(request('chat'), 0)
    lane.advance(0)
    lane.complete(id, false, 10, 1)
    expect(lane.advance(10)[0]).toMatchObject({ type: 'start', attempt: 2 })
    expect(lane.complete(id, true, 20, 1)).toEqual([])
    expect(lane.stats().active).toBe(1)
    expect(lane.complete(id, true, 30, 2)).toEqual([
      { type: 'release', id },
      { type: 'ready', id }
    ])
  })

  it('cancellation cannot release credit twice or publish a late success', () => {
    const lane = new ChatPreparationLane()
    const id = lane.enqueue(request('chat'), 0)
    lane.advance(0)
    lane.advance(300)
    expect(lane.complete(id, true, 300)).toEqual([])
    expect(lane.stats().active).toBe(1)
    expect(lane.finishCancellation(id)).toEqual([{ type: 'release', id }])
    expect(lane.finishCancellation(id)).toEqual([])
  })

  it('stale coalesced revisions do not replace the latest requested source', () => {
    const lane = new ChatPreparationLane()
    const id = lane.enqueue({ ...request('chat'), generation: 3, revision: 4 }, 0)
    lane.enqueue({ ...request('chat'), generation: 2, revision: 99 }, 1)
    lane.enqueue({ ...request('chat'), generation: 3, revision: 2 }, 2)
    expect(lane.advance(2)[0]).toEqual({
      type: 'start',
      id,
      attempt: 1,
      ...request('chat'),
      generation: 3,
      revision: 4
    })
  })

  it('a retry takes a fresh FIFO turn behind another chat', () => {
    const lane = new ChatPreparationLane()
    const heavy = lane.enqueue(request('heavy'), 0)
    lane.advance(0)
    const light = lane.enqueue(request('light'), 1)
    lane.complete(heavy, false, 10)
    expect(lane.advance(10)[0]).toMatchObject({ type: 'start', id: light })
  })

  it('virtual-clock stress keeps one slot and one queued ticket per chat', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const lane = new ChatPreparationLane()
      let active: { id: number; attempt: number } | undefined
      for (let now = 0; now < 1000; now++) {
        const chatId = `chat-${(now * seed) % 17}`
        lane.enqueue({ ...request(chatId), revision: now }, now)
        if (active && now % 7 === 0) {
          lane.complete(active.id, now % 3 !== 0, now, active.attempt)
          active = undefined
        }
        for (const command of lane.advance(now)) {
          if (command.type === 'cancel') {
            lane.finishCancellation(command.id)
            active = undefined
          }
          if (command.type === 'start') active = command
        }
        expect(lane.stats().active).toBeLessThanOrEqual(1)
        expect(lane.stats().queued).toBeLessThanOrEqual(17)
      }
    }
  })
  it('publication waits at most one heavy maintenance hold, capped at 300 ms', () => {
    const lane = new ChatPreparationLane()
    const heavy = lane.enqueue(request('heavy', 'maintenance'), 0)
    expect(lane.advance(0)).toEqual([
      { type: 'start', id: heavy, attempt: 1, ...request('heavy', 'maintenance') }
    ])
    lane.enqueue(request('another-heavy', 'maintenance'), 1)
    const light = lane.enqueue(request('light'), 1)
    const commands = lane.advance(300)
    expect(commands).toContainEqual({ type: 'cancel', id: heavy, reason: 'deadline' })
    expect(commands.some((command) => command.type === 'start')).toBe(false)
    expect(lane.finishCancellation(heavy)).toEqual([{ type: 'release', id: heavy }])
    expect(lane.advance(300)).toContainEqual({
      type: 'start',
      id: light,
      attempt: 1,
      ...request('light')
    })
  })

  it('retains only identity tickets, coalesces a chat and never holds two jobs for it', () => {
    const lane = new ChatPreparationLane()
    const first = lane.enqueue(request('same'), 0)
    lane.advance(0)
    const next = lane.enqueue({ ...request('same'), revision: 2 }, 1)
    expect(lane.enqueue({ ...request('same'), revision: 3 }, 2)).toBe(next)
    expect(lane.stats()).toMatchObject({ queued: 1, active: 1 })
    expect(lane.complete(first, true, 3)).toEqual([
      { type: 'release', id: first },
      { type: 'ready', id: first }
    ])
    expect(lane.advance(3)).toEqual([
      { type: 'start', id: next, attempt: 1, ...request('same'), revision: 3 }
    ])
  })

  it('releases preparation credit before publication and ignores stale completion', () => {
    const lane = new ChatPreparationLane()
    const id = lane.enqueue(request('chat'), 0)
    lane.advance(0)
    expect(lane.complete(id, true, 20)).toEqual([
      { type: 'release', id },
      { type: 'ready', id }
    ])
    expect(lane.stats().active).toBe(0)
    expect(lane.complete(id, true, 30)).toEqual([])
  })

  it('erasure cancels active work, removes waiters and cannot resurrect the chat', () => {
    const lane = new ChatPreparationLane()
    const active = lane.enqueue(request('gone'), 0)
    lane.advance(0)
    lane.enqueue(request('gone'), 1)
    expect(lane.erase('gone')).toEqual([{ type: 'cancel', id: active, reason: 'erased' }])
    expect(lane.stats().active).toBe(1)
    expect(lane.finishCancellation(active)).toEqual([{ type: 'release', id: active }])
    expect(lane.stats()).toMatchObject({ queued: 0, active: 0 })
    expect(lane.complete(active, true, 10)).toEqual([])
    expect(() => lane.enqueue(request('gone'), 10)).toThrow()
  })

  it('bounds retries by the original absolute deadline and maximum attempts', () => {
    const lane = new ChatPreparationLane()
    const id = lane.enqueue(request('chat'), 0)
    lane.advance(0)
    expect(lane.complete(id, false, 100)).toEqual([{ type: 'release', id }])
    lane.advance(100)
    lane.complete(id, false, 200, 2)
    lane.advance(200)
    expect(lane.complete(id, false, 250, 3)).toEqual([
      { type: 'release', id },
      { type: 'refused', id, reason: 'attempts' }
    ])
    expect(lane.stats()).toMatchObject({ retries: 2, refusals: 1, queued: 0, active: 0 })
    const late = lane.enqueue(request('late'), 300)
    lane.advance(300)
    expect(lane.complete(late, false, 600)).toContainEqual({
      type: 'refused',
      id: late,
      reason: 'deadline'
    })
    expect(lane.stats().timeouts).toBe(1)
  })

  it('preserves publication FIFO across distinct chats despite a streaming chat', () => {
    const lane = new ChatPreparationLane()
    const first = lane.enqueue(request('stream'), 0)
    lane.advance(0)
    const light = lane.enqueue(request('light'), 1)
    lane.enqueue(request('stream'), 2)
    lane.complete(first, true, 50)
    expect(lane.advance(50)[0]).toMatchObject({ type: 'start', id: light })
  })

  it('bounds waiting ticket count and fails closed without retaining payload', () => {
    const lane = new ChatPreparationLane()
    for (let i = 0; i < 128; i++) lane.enqueue(request(`chat-${i}`), 0)
    expect(() => lane.enqueue(request('overflow'), 0)).toThrow()
    expect(lane.stats()).toMatchObject({ queued: 128, active: 0, refusals: 1 })
    expect(lane.advance(301).filter((command) => command.type === 'refused')).toHaveLength(128)
  })
})
