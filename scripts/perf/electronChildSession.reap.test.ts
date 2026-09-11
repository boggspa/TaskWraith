import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { terminateExactChild, spawnExactElectronChild } = require('./electronChildSession.cjs')

describe('terminateExactChild stray reap', () => {
  it('SIGKILLs leftover listeners on the owned CDP ports after the child exits', async () => {
    const kills: Array<{ pid: number; sig: string }> = []
    const fake = new EventEmitter()
    Object.assign(fake, {
      pid: 77,
      remoteDebuggingPort: 9656,
      mainInspectorPort: 10056,
      kill(sig: string) {
        if (sig === 'SIGTERM') fake.emit('exit', 0, sig)
        return true
      }
    })
    const result = await terminateExactChild(fake, {
      waitMs: 20,
      sleep: async () => undefined,
      killPid: (pid: number, sig: string) => {
        kills.push({ pid, sig })
      },
      listListeningPidsForPort: async (port: number) => (port === 9656 ? [32051] : []),
      listPidsMatchingCommandNeedle: async () => [12560],
      userDataPath: '/private/tmp/tw-evidence-v1/8ec2ed74d/perf-homes/ev1'
    })
    expect(result.strayKills).toEqual([
      { pid: 32051, reason: 'listen:9656' },
      { pid: 12560, reason: 'userData-command' }
    ])
    expect(kills).toEqual([
      { pid: 32051, sig: 'SIGKILL' },
      { pid: 12560, sig: 'SIGKILL' }
    ])
  })
})

describe('terminateExactChild on a child that has already exited', () => {
  function deadChild(extra: Record<string, unknown> = {}) {
    const kills: string[] = []
    const fake = new EventEmitter()
    Object.assign(fake, {
      pid: 77,
      // A ChildProcess emits 'exit' once. This one is already past it, so the
      // second terminate — the cleanup block's, after an abort handler ran the
      // first — is waiting for an event that can never arrive.
      kill(sig: string) {
        kills.push(sig)
        return true
      },
      ...extra
    })
    return { fake, kills }
  }
  // Records the requested delays without spending them, so the two lanes are
  // told apart by wall clock rather than by a counter.
  function slowSleep(seen: number[]) {
    return (ms: number) => {
      seen.push(ms)
      return new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const noStrays = {
    listListeningPidsForPort: async () => [],
    listPidsMatchingCommandNeedle: async () => []
  }

  it('returns at once and claims no force when the session tracks its exit', async () => {
    const { fake, kills } = deadChild({ exited: true })
    const seen: number[] = []
    const startedAt = Date.now()
    const result = await terminateExactChild(fake, {
      waitMs: 8000,
      sleep: slowSleep(seen),
      ...noStrays
    })
    expect(Date.now() - startedAt).toBeLessThan(40)
    expect(kills).toEqual(['SIGTERM'])
    expect(result.usedForce).toBe(false)
    expect(result.strayKills).toEqual([])
  })

  it('still waits and forces for a session that does not track its exit', async () => {
    const { fake, kills } = deadChild()
    const seen: number[] = []
    const result = await terminateExactChild(fake, {
      waitMs: 8000,
      sleep: slowSleep(seen),
      ...noStrays
    })
    expect(seen).toEqual([8000, 500])
    expect(kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(result.usedForce).toBe(true)
  })

  it('flips the flag on the session object the caller holds, not the pre-spread copy', () => {
    const child = new EventEmitter()
    Object.assign(child, { pid: 4242, kill: () => true })
    const session = spawnExactElectronChild({
      spawnPlan: {
        env: {},
        argv: [],
        repoRoot: '/tmp',
        electronBinary: '/fake/Electron',
        remoteDebuggingPort: 9656,
        mainInspectorPort: 10056,
        instanceId: 'test'
      },
      adapters: { spawn: () => child }
    })
    expect(session.exited).toBe(false)
    child.emit('exit', 0, null)
    expect(session.exited).toBe(true)
  })
})
