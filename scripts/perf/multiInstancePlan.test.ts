import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { buildMultiInstancePlan } = require('./multiInstancePlan.cjs')

function options() {
  return {
    repoRoot: resolve('/synthetic/repo'),
    home: resolve('/synthetic/repo/perf-homes/shared'),
    realHomedir: resolve('/real/home'),
    platform: 'linux',
    instances: [
      {
        instanceId: 'gh-active',
        role: 'active',
        remoteDebuggingPort: 9401,
        mainInspectorPort: 9801
      },
      { instanceId: 'gh-idle', role: 'idle', remoteDebuggingPort: 9402, mainInspectorPort: 9802 }
    ]
  }
}

describe('G-H multi-instance launch plan', () => {
  it.each(['darwin', 'win32'])('rejects case-insensitive profile aliases on %s', (platform) => {
    const input = { ...options(), platform }
    input.instances[0].instanceId = 'gh-A'
    input.instances[1].instanceId = 'gh-a'
    expect(() => buildMultiInstancePlan(input)).toThrow('profile collision')
  })

  it.each(['linux', 'darwin', 'win32'])(
    'shares synthetic HOME with distinct profiles on %s',
    (platform) => {
      const input = { ...options(), platform }
      const plan = buildMultiInstancePlan(input)
      expect(plan.instances.map((entry: any) => entry.launch.env.HOME)).toEqual([
        input.home,
        input.home
      ])
      expect(new Set(plan.instances.map((entry: any) => entry.userDataPath)).size).toBe(2)
      expect(plan.instances.every((entry: any) => entry.launch.env.IOS_REMOTE_TRUE === '0')).toBe(
        true
      )
      expect(plan.acceptance).toBe('unmeasured')
      expect(plan.requiresFilesystemContainment).toBe(true)
    }
  )

  it('catches production sanitization collisions including truncation', () => {
    for (const ids of [
      ['gh.a', 'gha'],
      ['abcdefghijklmnop-a', 'abcdefghijklmnop-b']
    ]) {
      const input = options()
      input.instances.forEach((entry, index) => {
        entry.instanceId = ids[index]
      })
      expect(() => buildMultiInstancePlan(input)).toThrow('profile collision')
    }
  })

  it('catches collisions across CDP and inspector roles', () => {
    const input = options()
    input.instances[1].mainInspectorPort = input.instances[0].remoteDebuggingPort
    expect(() => buildMultiInstancePlan(input)).toThrow('port collision')
  })

  it('refuses real or out-of-bound HOME and reserved profiles', () => {
    for (const home of ['/real/home', '/tmp/elsewhere', 'relative']) {
      expect(() => buildMultiInstancePlan({ ...options(), home })).toThrow()
    }
    const input = options()
    input.instances[1].instanceId = 'verify'
    expect(() => buildMultiInstancePlan(input)).toThrow()
  })

  it('requires coexistence and an active profile; allows two active profiles', () => {
    const input = options()
    expect(() => buildMultiInstancePlan({ ...input, instances: [input.instances[0]] })).toThrow()
    input.instances.forEach((entry) => {
      entry.role = 'idle'
    })
    expect(() => buildMultiInstancePlan(input)).toThrow('active instance')
    input.instances.forEach((entry) => {
      entry.role = 'active'
    })
    expect(buildMultiInstancePlan(input).instances).toHaveLength(2)
  })
})
