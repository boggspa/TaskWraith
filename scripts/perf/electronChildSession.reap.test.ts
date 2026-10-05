import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  terminateExactChild,
  spawnExactElectronChild,
  reapOwnedStrays
} = require('./electronChildSession.cjs')

describe('terminateExactChild stray reap', () => {
  it('SIGKILLs leftover listeners on the owned CDP ports after the child exits', async () => {
    const kills: Array<{ pid: number; sig: string }> = []
    const fake = new EventEmitter()
    Object.assign(fake, {
      pid: 77,
      pgid: 77,
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
      killProcessGroup: (_pgid: number, sig: string) => fake.emit('exit', 0, sig),
      killPid: (pid: number, sig: string) => {
        kills.push({ pid, sig })
      },
      listListeningPidsForPort: async (port: number) => (port === 9656 ? [32051] : []),
      portAdapters: {
        getProcessIdentity: async (pid: number) =>
          pid === 32051 ? { pid, ppid: 1, pgid: 77 } : null
      },
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

  it.each(['EPERM', 'EACCES', 'ESRCH'])(
    'records a failed owned-listener signal unless the process is already gone (%s)',
    async (code) => {
      const session = {
        pid: 77,
        pgid: 77,
        exited: true,
        remoteDebuggingPort: 9656
      }
      const result = await terminateExactChild(session, {
        platform: 'darwin',
        sleep: async () => undefined,
        listListeningPidsForPort: async () => [32051],
        listPidsMatchingCommandNeedle: async () => [],
        portAdapters: {
          getProcessIdentity: async (pid: number) =>
            pid === 32051 ? { pid, ppid: 1, pgid: 77 } : null
        },
        killPid: () => {
          throw Object.assign(new Error(`signal denied: ${code}`), { code })
        }
      })
      expect(result.strayKills).toEqual([])
      expect(result.straySkips).toEqual(
        code === 'ESRCH'
          ? []
          : [{ pid: 32051, reason: 'listen:9656', error: expect.stringContaining(code) }]
      )
    }
  )

  it.each([
    { label: 'exited child PID reused as a new group leader', pid: 77, pgid: 77, exited: true },
    { label: 'recorded child PID now in a foreign group', pid: 77, pgid: 9000, exited: false },
    { label: 'explicitly recorded helper PID reused', pid: 32051, pgid: 9000, exited: false }
  ])('skips a stale $label', async ({ pid, pgid, exited }) => {
    const signals: number[] = []
    const probes: number[] = []
    const result = await reapOwnedStrays(
      { pid: 77, pgid: 77, ownedPids: [77, 32051], remoteDebuggingPort: 9656, exited },
      {
        platform: 'darwin',
        killPid: (target: number) => signals.push(target),
        listListeningPidsForPort: async () => [pid],
        portAdapters: {
          getProcessIdentity: async (target: number) => {
            probes.push(target)
            return target === pid ? { pid, ppid: 1, pgid } : null
          }
        }
      }
    )
    expect(probes).toContain(pid)
    expect(signals).toEqual([])
    expect(result.killed).toEqual([])
    expect(result.skipped).toEqual([{ pid, reason: 'listen:9656', error: expect.any(String) }])
  })

  it('does not use a cached ancestor or an exited group leader as ownership proof', async () => {
    for (const exited of [false, true]) {
      const signals: number[] = []
      const result = await reapOwnedStrays(
        { pid: 77, pgid: 77, ownedPids: [77, 32051], remoteDebuggingPort: 9656, exited },
        {
          platform: 'darwin',
          killPid: (pid: number) => signals.push(pid),
          listListeningPidsForPort: async () => [32052],
          portAdapters: {
            getProcessIdentity: async (pid: number) => {
              if (exited) return { pid, ppid: 1, pgid: 77 }
              if (pid === 32052) return { pid, ppid: 32051, pgid: 9000 }
              if (pid === 32051) return { pid, ppid: 1, pgid: 9000 }
              return null
            }
          }
        }
      )
      expect(signals).toEqual([])
      expect(result.skipped).toEqual([
        { pid: 32052, reason: 'listen:9656', error: expect.any(String) }
      ])
    }
  })

  it.each(['unchanged', 'reused', 'missing', 'failed', 'wrong-pid'])(
    'rechecks a recorded listener immediately before signalling when its identity is %s',
    async (failure) => {
      const signals: number[] = []
      const events: string[] = []
      let recordedPidProbes = 0
      const result = await reapOwnedStrays(
        { pid: 77, pgid: 77, ownedPids: [77], remoteDebuggingPort: 9656 },
        {
          platform: 'darwin',
          killPid: (pid: number) => {
            events.push(`kill:${pid}`)
            signals.push(pid)
          },
          listListeningPidsForPort: async () => [77, 32051],
          portAdapters: {
            getProcessIdentity: async (pid: number) => {
              events.push(`identity:${pid}`)
              if (pid === 32051) return { pid, ppid: 1, pgid: 77 }
              recordedPidProbes += 1
              if (recordedPidProbes === 1 || failure === 'unchanged') {
                return { pid, ppid: 1, pgid: 77 }
              }
              if (failure === 'missing') return null
              if (failure === 'failed') throw new Error('identity read failed')
              if (failure === 'wrong-pid') return { pid: 8888, ppid: 1, pgid: 77 }
              return { pid, ppid: 1, pgid: 9000 }
            }
          }
        }
      )
      expect(recordedPidProbes).toBeGreaterThanOrEqual(2)
      expect(signals).toEqual(failure === 'unchanged' ? [77, 32051] : [32051])
      expect(events.at(-2)).toBe('identity:32051')
      expect(events.at(-1)).toBe('kill:32051')
      expect(result.skipped).toEqual(
        failure === 'unchanged'
          ? []
          : [{ pid: 77, reason: 'listen:9656', error: expect.any(String) }]
      )
    }
  )
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
    expect(kills).toEqual([])
    expect(result.usedForce).toBe(false)
    expect(result.strayKills).toEqual([])
  })

  it('never signals a reused process group after the original child exits', async () => {
    const { fake, kills } = deadChild({ exited: true, pgid: 77, remoteDebuggingPort: 9656 })
    const groupSignals: number[] = []
    const pidSignals: number[] = []
    const result = await terminateExactChild(fake, {
      platform: 'darwin',
      sleep: async () => undefined,
      killProcessGroup: (pgid: number) => groupSignals.push(pgid),
      killPid: (pid: number) => pidSignals.push(pid),
      listListeningPidsForPort: async () => [77, 32051],
      listPidsMatchingCommandNeedle: async () => [],
      portAdapters: {
        getProcessIdentity: async (pid: number) => ({ pid, ppid: 1, pgid: 77 })
      }
    })
    expect(groupSignals).toEqual([])
    expect(pidSignals).toEqual([])
    expect(kills).toEqual([])
    expect(result.killedProcessGroup).toBe(false)
    expect(result.usedForce).toBe(false)
    expect(result.straySkips.map((skip: { pid: number }) => skip.pid)).toEqual([77, 32051])
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
    expect(result.launchForced).toBe(true)
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
    const result = await terminateExactChild(Object.assign(session(), { pgid: 77 }), {
      platform: 'darwin',
      userDataPath,
      killProcessGroup: () => undefined,
      listListeningPidsForPort: async (port: number) => {
        probes += 1
        return port === 9656 ? [32051] : []
      },
      portAdapters: {
        getProcessIdentity: async (pid: number) =>
          pid === 32051 ? { pid, ppid: 1, pgid: 77 } : null
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

describe('whether the launch itself needed the kill, apart from the strays', () => {
  const userDataPath = '/private/tmp/tw-evidence-v1/8ec2ed74d/perf-homes/ev1'
  // A launch that exits on the signals in `exitsOn`, and a reap whose
  // command-path sweep finds `strays`. Every signal is recorded, none sent.
  async function terminate(exitsOn: string[], strays: number[]) {
    const groupSignals: string[] = []
    const strayKills: number[] = []
    const fake = new EventEmitter()
    Object.assign(fake, { pid: 77, pgid: 77, kill: () => true })
    const result = await terminateExactChild(fake, {
      platform: 'darwin',
      waitMs: 20,
      sleep: async () => undefined,
      killProcessGroup: (_pgid: number, sig: string) => {
        groupSignals.push(sig)
        if (exitsOn.includes(sig)) fake.emit('exit', null, sig)
      },
      killPid: (pid: number) => {
        strayKills.push(pid)
      },
      listListeningPidsForPort: async () => [],
      listPidsMatchingCommandNeedle: async () => strays,
      userDataPath
    })
    return { result, groupSignals, strayKills }
  }

  it('says the launch needed the kill when it outlived its SIGTERM', async () => {
    const { result, groupSignals } = await terminate(['SIGKILL'], [])
    expect(groupSignals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(result).toMatchObject({ launchForced: true, usedForce: true, strayKills: [] })
  })

  it('says the launch did not need it when only a stray was killed, and names the stray', async () => {
    const { result, groupSignals, strayKills } = await terminate(['SIGTERM'], [12560])
    expect(groupSignals).toEqual(['SIGTERM'])
    expect(strayKills).toEqual([12560])
    expect(result).toMatchObject({
      launchForced: false,
      usedForce: true,
      strayKills: [{ pid: 12560, reason: 'userData-command' }]
    })
  })

  it('says both when the launch outlived its SIGTERM and a stray was left', async () => {
    const { result } = await terminate(['SIGKILL'], [12560])
    expect(result).toMatchObject({
      launchForced: true,
      usedForce: true,
      strayKills: [{ pid: 12560, reason: 'userData-command' }]
    })
  })

  it('says neither when the launch exited on SIGTERM and nothing was left', async () => {
    const { result, groupSignals } = await terminate(['SIGTERM'], [])
    expect(groupSignals).toEqual(['SIGTERM'])
    expect(result).toMatchObject({ launchForced: false, usedForce: false, strayKills: [] })
  })

  it('claims no kill of a launch that had already exited', async () => {
    const fake = new EventEmitter()
    Object.assign(fake, { pid: 77, pgid: 77, exited: true, kill: () => true })
    const result = await terminateExactChild(fake, {
      platform: 'darwin',
      sleep: async () => undefined,
      killProcessGroup: () => {
        throw new Error('an exited launch is never signalled')
      },
      killPid: () => {},
      listListeningPidsForPort: async () => [],
      listPidsMatchingCommandNeedle: async () => []
    })
    expect(result).toMatchObject({ launchForced: false, usedForce: false })
  })
})
