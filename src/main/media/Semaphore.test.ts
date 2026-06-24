import { describe, expect, it } from 'vitest'
import { createSemaphore } from './Semaphore'

describe('createSemaphore', () => {
  it('never runs more than maxConcurrent tasks at once', async () => {
    const sem = createSemaphore(2)
    let active = 0
    let peak = 0
    const task = (): Promise<void> =>
      sem.run(async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        active -= 1
      })
    await Promise.all(Array.from({ length: 6 }, task))
    expect(peak).toBe(2)
    expect(sem.active).toBe(0)
  })

  it('propagates task results and releases the slot on throw', async () => {
    const sem = createSemaphore(1)
    await expect(sem.run(async () => 42)).resolves.toBe(42)
    await expect(sem.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // Slot was released despite the throw — the next task runs.
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok')
    expect(sem.active).toBe(0)
  })

  it('treats a non-positive / non-finite max as 1', async () => {
    const sem = createSemaphore(0)
    let peak = 0
    let active = 0
    const task = (): Promise<void> =>
      sem.run(async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        active -= 1
      })
    await Promise.all(Array.from({ length: 3 }, task))
    expect(peak).toBe(1)
  })
})
