'use strict'

const { buildMultiInstancePlan } = require('./multiInstancePlan.cjs')
const { buildIsolatedLaunchPlan } = require('./isolatedLaunch.cjs')
const { assertAuthoritativeIsolatedHome } = require('./isolatedHome.cjs')
const { resolveUnpackagedDevUserDataPath } = require('./devUserDataPath.cjs')
const { collectServerInstanceEvidence } = require('./serverInstanceEvidence.cjs')

const CONFIGURATIONS = Object.freeze({
  'active-alone': ['active'],
  idle1: ['active', 'idle'],
  idle3: ['active', 'idle', 'idle', 'idle'],
  twoactive: ['active', 'active'],
  'one-restart': ['active', 'active']
})

function buildMultiProfileConfiguration(options = {}) {
  const roles = CONFIGURATIONS[options.configuration]
  if (!roles) throw new Error('Unknown G-H configuration')
  if (!Array.isArray(options.instances) || options.instances.length !== roles.length) {
    throw new Error('Configuration instance count mismatch')
  }
  const instances = options.instances.map((instance, index) => ({
    ...instance,
    role: roles[index]
  }))
  let plan
  if (instances.length > 1) {
    plan = buildMultiInstancePlan({ ...options, instances })
  } else {
    const { home, repoRoot } = assertAuthoritativeIsolatedHome(options)
    const launch = buildIsolatedLaunchPlan({ ...options, ...instances[0], home, repoRoot })
    const { userDataPath } = resolveUnpackagedDevUserDataPath({
      instanceId: launch.instanceId,
      home,
      platform: options.platform,
      env: launch.env
    })
    plan = { home, repoRoot, instances: [{ role: 'active', userDataPath, launch }] }
  }
  return {
    schemaVersion: 1,
    configuration: options.configuration,
    home: plan.home,
    repoRoot: plan.repoRoot,
    instances: plan.instances,
    acceptance: 'unmeasured'
  }
}

/**
 * Lifecycle orchestration only. start must materialize/verify isolation and return
 * an owned handle; stop must reap that exact Electron tree and matching Host.
 * measure owns the unchanged M1 windows. No default process launch is provided.
 */
async function runMultiProfileConfiguration(options = {}, adapters = {}) {
  const plan = buildMultiProfileConfiguration(options)
  for (const name of ['start', 'stop', 'measure']) {
    if (typeof adapters[name] !== 'function') throw new Error('Lifecycle adapters required')
  }
  const live = new Map()
  const identityRows = []
  const failures = []
  const phases = []
  const collect = adapters.collectIdentity || collectServerInstanceEvidence
  async function start(index) {
    const instance = plan.instances[index]
    const handle = await adapters.start(instance)
    live.set(index, handle)
    const result = await collect({
      userDataPath: instance.userDataPath,
      platform: options.platform
    })
    if (!result || !result.ok) throw new Error('identity unavailable')
    const evidence = Object.fromEntries(
      [
        'schemaVersion',
        'source',
        'profileHash',
        'hostId',
        'hostPid',
        'bootEpoch',
        'generation',
        'socketNamespace'
      ].map((key) => [key, result.evidence[key]])
    )
    for (const row of identityRows.filter((row) => live.has(row.index) && row.index !== index)) {
      if (
        ['hostPid', 'hostId', 'socketNamespace', 'profileHash'].some(
          (key) => row.evidence[key] === evidence[key]
        )
      ) {
        throw new Error('identity collision')
      }
    }
    identityRows.push({ index, role: instance.role, evidence })
    return evidence
  }
  async function stop(index) {
    await adapters.stop(live.get(index), plan.instances[index])
    live.delete(index)
  }
  try {
    for (let index = 0; index < plan.instances.length; index++) await start(index)
    await adapters.measure({ phase: 'coexistence', plan, handles: new Map(live) })
    phases.push('coexistence')
    if (plan.configuration === 'one-restart') {
      const before = identityRows.find((row) => row.index === 1).evidence
      await stop(1)
      await adapters.measure({ phase: 'peer-stopped', plan, handles: new Map(live) })
      phases.push('peer-stopped')
      const after = await start(1)
      if (after.hostId !== before.hostId || after.bootEpoch === before.bootEpoch) {
        throw new Error('restart incarnation mismatch')
      }
      await adapters.measure({ phase: 'peer-restarted', plan, handles: new Map(live) })
      phases.push('peer-restarted')
    }
  } catch {
    failures.push('configuration_failed')
  } finally {
    for (const index of [...live.keys()].reverse()) {
      try {
        await stop(index)
      } catch {
        failures.push('owned_instance_cleanup_failed')
      }
    }
  }
  return {
    schemaVersion: 1,
    configuration: plan.configuration,
    ok: failures.length === 0,
    acceptance: 'unmeasured',
    identities: identityRows,
    phases,
    failures
  }
}

module.exports = { CONFIGURATIONS, buildMultiProfileConfiguration, runMultiProfileConfiguration }
