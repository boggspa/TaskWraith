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
    let alive = true
    let releaseForceKill!: () => void
    const forceKill = new Promise<void>((resolve) => {
      releaseForceKill = resolve
    })
    const signal = vi.fn((next: 'SIGTERM' | 'SIGKILL') => {
      if (next === 'SIGKILL') {
        void forceKill.then(() => {
          alive = false
        })
      }
    })
    const join = new HostCommandProcessTreeJoin({
      signal,
      isAlive: () => alive,
      wait: async () => {
        await Promise.resolve()
      },
      killGraceMs: 25,
      pollMs: 5
    })

    const first = join.joinAfterRootClose()
    const second = join.joinAfterRootClose()
    expect(second).toBe(first)
    await Promise.resolve()
    expect(signal).toHaveBeenNthCalledWith(1, 'SIGTERM')
    await Promise.resolve()
    expect(signal).toHaveBeenNthCalledWith(2, 'SIGKILL')

    let settled = false
    void first.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseForceKill()
    await first
    expect(settled).toBe(true)
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
