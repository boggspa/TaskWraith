import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  CONFIGURATIONS,
  buildMultiProfileConfiguration,
  runMultiProfileConfiguration
} = require('./multiProfileCoordinator.cjs')

function options(configuration: string) {
  return {
    configuration,
    home: '/synthetic/repo/perf-homes/shared',
    repoRoot: '/synthetic/repo',
    realHomedir: '/real/home',
    platform: 'linux',
    instances: CONFIGURATIONS[configuration].map((_: string, index: number) => ({
      instanceId: `gh-${index}`,
      remoteDebuggingPort: 9400 + index,
      mainInspectorPort: 9800 + index
    }))
  }
}

function adapters() {
  const events: string[] = []
  const boots = new Map<string, number>()
  return {
    events,
    start: async (instance: any) => {
      events.push(`start:${instance.launch.instanceId}`)
      boots.set(instance.userDataPath, (boots.get(instance.userDataPath) || 0) + 1)
      return { id: instance.launch.instanceId }
    },
    stop: async (handle: any) => {
      events.push(`stop:${handle.id}`)
    },
    measure: async ({ phase, handles }: any) => {
      events.push(`measure:${phase}:${handles.size}`)
    },
    collectIdentity: async ({ userDataPath }: any) => ({
      ok: true,
      evidence: {
        profileHash: userDataPath,
        hostId: userDataPath,
        hostPid: userDataPath.charCodeAt(userDataPath.length - 1),
        bootEpoch: String(boots.get(userDataPath)),
        socketNamespace: userDataPath
      }
    })
  }
}

describe('G-H named multi-profile coordination', () => {
  it.each(Object.keys(CONFIGURATIONS))(
    'builds %s with one HOME and exact roles',
    (configuration) => {
      const plan = buildMultiProfileConfiguration(options(configuration))
      expect(plan.instances.map((instance: any) => instance.role)).toEqual(
        CONFIGURATIONS[configuration]
      )
      expect(new Set(plan.instances.map((instance: any) => instance.userDataPath)).size).toBe(
        plan.instances.length
      )
      expect(plan.instances.every((instance: any) => instance.launch.home === plan.home)).toBe(true)
    }
  )

  it('rejects malformed scenario before invoking adapters', async () => {
    expect(() =>
      buildMultiProfileConfiguration({ ...options('idle1'), configuration: 'other' })
    ).toThrow()
    expect(() => buildMultiProfileConfiguration({ ...options('idle1'), instances: [] })).toThrow()
    await expect(runMultiProfileConfiguration(options('idle1'))).rejects.toThrow(
      'adapters required'
    )
  })

  it('runs coexistence then stops only acquired handles in reverse order', async () => {
    const input = adapters()
    const result = await runMultiProfileConfiguration(options('idle3'), input)
    expect(result.ok).toBe(true)
    expect(result.acceptance).toBe('unmeasured')
    expect(input.events).toEqual([
      'start:gh-0',
      'start:gh-1',
      'start:gh-2',
      'start:gh-3',
      'measure:coexistence:4',
      'stop:gh-3',
      'stop:gh-2',
      'stop:gh-1',
      'stop:gh-0'
    ])
  })

  it('keeps active peer handle alive through one peer restart', async () => {
    const input = adapters()
    const result = await runMultiProfileConfiguration(options('one-restart'), input)
    expect(result.ok).toBe(true)
    expect(input.events).toEqual([
      'start:gh-0',
      'start:gh-1',
      'measure:coexistence:2',
      'stop:gh-1',
      'measure:peer-stopped:1',
      'start:gh-1',
      'measure:peer-restarted:2',
      'stop:gh-1',
      'stop:gh-0'
    ])
    expect(result.identities).toHaveLength(3)
  })

  it('cleans acquired profiles after start, identity or measurement failure', async () => {
    for (const mode of ['start', 'identity', 'measurement']) {
      const input = adapters()
      if (mode === 'start')
        input.start = async (instance: any) => {
          if (instance.launch.instanceId === 'gh-1') throw new Error('secret')
          input.events.push('start:gh-0')
          return { id: 'gh-0' }
        }
      if (mode === 'identity') input.collectIdentity = async () => ({ ok: false }) as any
      if (mode === 'measurement')
        input.measure = async () => {
          throw new Error('secret')
        }
      const result = await runMultiProfileConfiguration(options('idle1'), input)
      expect(result.ok).toBe(false)
      expect(input.events).toContain('stop:gh-0')
      expect(JSON.stringify(result)).not.toContain('secret')
    }
  })

  it('reports cleanup failures and never elevates them to acceptance', async () => {
    const input = adapters()
    input.stop = async () => {
      throw new Error('secret')
    }
    const result = await runMultiProfileConfiguration(options('idle1'), input)
    expect(result.failures).toEqual([
      'owned_instance_cleanup_failed',
      'owned_instance_cleanup_failed'
    ])
    expect(result.ok).toBe(false)
  })

  it('rejects shared Host identity and cleans both profiles', async () => {
    const input = adapters()
    const collect = input.collectIdentity
    input.collectIdentity = async (options: any) => {
      const result = await collect(options)
      result.evidence.hostId = 'shared-host'
      return result
    }
    const result = await runMultiProfileConfiguration(options('idle1'), input)
    expect(result.ok).toBe(false)
    expect(input.events).toEqual(['start:gh-0', 'start:gh-1', 'stop:gh-1', 'stop:gh-0'])
  })

  it('rejects unchanged incarnation on restart and cleans the replacement', async () => {
    const input = adapters()
    const collect = input.collectIdentity
    input.collectIdentity = async (options: any) => {
      const result = await collect(options)
      result.evidence.bootEpoch = 'unchanged'
      return result
    }
    const result = await runMultiProfileConfiguration(options('one-restart'), input)
    expect(result.ok).toBe(false)
    expect(result.phases).toEqual(['coexistence', 'peer-stopped'])
    expect(input.events.slice(-2)).toEqual(['stop:gh-1', 'stop:gh-0'])
  })

  it('copies only identity fields into report rows', async () => {
    const input = adapters()
    const collect = input.collectIdentity
    input.collectIdentity = async (options: any) => {
      const result = await collect(options)
      return { ...result, evidence: { ...result.evidence, token: 'secret-token' } }
    }
    const result = await runMultiProfileConfiguration(options('idle1'), input)
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })
})
