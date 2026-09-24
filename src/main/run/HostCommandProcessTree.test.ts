import { spawn } from 'node:child_process'

import { describe, expect, it, vi } from 'vitest'

import {
  createHostCommandProcessTreeJoin,
  HostCommandProcessTreeJoin
} from './HostCommandProcessTree'

describe('HostCommandProcessTreeJoin', () => {
  it.skipIf(process.platform === 'win32')(
    'reaps a real detached descendant after its shell leader exits',
    async () => {
      const child = spawn('/bin/sh', ['-c', 'trap "" HUP; sleep 60 & exit 0'], {
        detached: true,
        stdio: 'ignore'
      })
      const pid = child.pid
      expect(pid).toBeTypeOf('number')
      const processGroupAlive = (): boolean => {
        try {
          process.kill(-pid!, 0)
          return true
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'EPERM'
        }
      }

      try {
        const join = createHostCommandProcessTreeJoin(pid!, {
          killGraceMs: 10,
          pollMs: 5
        })
        expect(join).not.toBeNull()
        await new Promise<void>((resolve, reject) => {
          child.once('close', () => resolve())
          child.once('error', reject)
        })
        expect(processGroupAlive()).toBe(true)

        await join!.joinAfterRootClose()

        expect(processGroupAlive()).toBe(false)
      } finally {
        try {
          process.kill(-pid!, 'SIGKILL')
        } catch {
          // The expected path already reaped the group.
        }
      }
    }
  )

  it('terminates descendants after the root closes and settles only after the tree is gone', async () => {
    vi.useFakeTimers()
    try {
      let alive = true
      const signal = vi.fn()
      const join = new HostCommandProcessTreeJoin({
        signal,
        isAlive: () => alive,
        now: () => Date.now(),
        killGraceMs: 25,
        pollMs: 5
      })
      const first = join.joinAfterRootClose()
      expect(join.joinAfterRootClose()).toBe(first)
      let settled = false
      void first.then(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(24)
      expect(signal).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(signal).toHaveBeenNthCalledWith(2, 'SIGKILL')
      await vi.advanceTimersByTimeAsync(20)
      expect(signal).toHaveBeenCalledTimes(2)
      expect(settled).toBe(false)

      alive = false
      await vi.advanceTimersByTimeAsync(5)
      await first
      expect(settled).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts already-dead tree evidence without sending a signal', async () => {
    const signal = vi.fn()
    const join = new HostCommandProcessTreeJoin({
      signal,
      isAlive: () => false,
      wait: vi.fn(async () => {})
    })

    await join.joinAfterRootClose()

    expect(signal).not.toHaveBeenCalled()
  })

  it('settles promptly when descendants exit during the termination grace period', async () => {
    vi.useFakeTimers()
    try {
      let alive = true
      const signal = vi.fn((next: 'SIGTERM' | 'SIGKILL') => {
        if (next === 'SIGTERM') setTimeout(() => (alive = false), 10)
      })
      const join = new HostCommandProcessTreeJoin({
        signal,
        isAlive: () => alive,
        now: () => Date.now()
      })
      let settled = false
      const result = join.joinAfterRootClose().then(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(50)

      expect(settled).toBe(true)
      expect(signal).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(vi.getTimerCount()).toBe(0)
      await result
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the grace deadline when an event-loop delay postpones the next observation', async () => {
    let elapsed = 0
    let alive = true
    const signal = vi.fn((next: 'SIGTERM' | 'SIGKILL') => {
      if (next === 'SIGKILL') alive = false
    })
    const wait = vi.fn(async () => {
      elapsed += 100
    })
    const join = new HostCommandProcessTreeJoin({
      signal,
      isAlive: () => alive,
      now: () => elapsed,
      wait,
      killGraceMs: 25,
      pollMs: 5
    })

    await join.joinAfterRootClose()

    expect(wait).toHaveBeenCalledExactlyOnceWith(5)
    expect(signal.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
  })

  it('does not mistake a failed signal for process-tree death', async () => {
    let alive = true
    let observations = 0
    const join = new HostCommandProcessTreeJoin({
      signal: vi.fn(() => {
        throw new Error('signal denied')
      }),
      isAlive: () => {
        observations += 1
        if (observations >= 4) alive = false
        return alive
      },
      wait: vi.fn(async () => {}),
      killGraceMs: 1,
      pollMs: 1
    })

    await join.joinAfterRootClose()

    expect(observations).toBeGreaterThanOrEqual(4)
  })

  it('does not claim post-close Windows tree evidence from a root PID alone', () => {
    expect(createHostCommandProcessTreeJoin(759, { platform: 'win32' })).toBeNull()
  })
})
