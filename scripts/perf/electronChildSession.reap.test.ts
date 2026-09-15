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
      // The reap is the POSIX (lsof/ps) lane; the harness reports it
      // unsupported on win32 by design (see the 'probes cannot run' block
      // below), so pin the lane under test rather than the runner's OS.
      platform: 'darwin',
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

describe('stray reap where the probes cannot run', () => {
  function session() {
    const fake = new EventEmitter()
    Object.assign(fake, {
      pid: 77,
      remoteDebuggingPort: 9656,
      mainInspectorPort: 10056,
      exited: true,
      kill: () => true
    })
    return fake
  }
  const userDataPath = '/private/tmp/tw-evidence-v1/8ec2ed74d/perf-homes/ev1'

  it('reports the reap unsupported on win32 rather than an empty all-clear', async () => {
    let probes = 0
    const result = await terminateExactChild(session(), {
      platform: 'win32',
      userDataPath,
      listListeningPidsForPort: async () => {
        probes += 1
        return [32051]
      },
      listPidsMatchingCommandNeedle: async () => {
        probes += 1
        return [12560]
      },
      killPid: () => {
        throw new Error('nothing may be killed on a platform that cannot probe')
      }
    })
    expect(result.strayReapSupported).toBe(false)
    expect(result.strayKills).toEqual([])
    // The whole point: an empty strayKills is only meaningful if a search ran.
    expect(probes).toBe(0)
  })

  it('reports the reap supported where the probes do run', async () => {
    let probes = 0
    const killed: number[] = []
    const result = await terminateExactChild(session(), {
      platform: 'darwin',
      userDataPath,
      listListeningPidsForPort: async (port: number) => {
        probes += 1
        return port === 9656 ? [32051] : []
      },
      listPidsMatchingCommandNeedle: async () => {
        probes += 1
        return [12560]
      },
      killPid: (pid: number) => {
        killed.push(pid)
      }
    })
    expect(result.strayReapSupported).toBe(true)
    expect(result.strayKills).toHaveLength(2)
    expect(killed).toEqual([32051, 12560])
    expect(probes).toBe(3)
  })
})
