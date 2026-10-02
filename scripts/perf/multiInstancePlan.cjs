'use strict'

const { buildIsolatedLaunchPlan } = require('./isolatedLaunch.cjs')
const { assertAuthoritativeIsolatedHome } = require('./isolatedHome.cjs')
const { resolveUnpackagedDevUserDataPath } = require('./devUserDataPath.cjs')

/** Pure G-H plan. Filesystem containment and exact-child checks remain launch prerequisites. */
function buildMultiInstancePlan(options = {}) {
  const { home, repoRoot } = assertAuthoritativeIsolatedHome(options)
  if (!Array.isArray(options.instances) || options.instances.length < 2) {
    throw new Error('At least two instances required')
  }
  const profiles = new Set()
  const ports = new Set()
  const instances = options.instances.map((instance) => {
    if (!instance || !['active', 'idle'].includes(instance.role)) {
      throw new Error('Each instance requires an active or idle role')
    }
    const launch = buildIsolatedLaunchPlan({
      instanceId: instance.instanceId,
      remoteDebuggingPort: instance.remoteDebuggingPort,
      mainInspectorPort: instance.mainInspectorPort,
      workload: options.workload,
      fxPosture: options.fxPosture,
      electronEntry: options.electronEntry,
      platform: options.platform,
      home,
      repoRoot
    })
    const profile = resolveUnpackagedDevUserDataPath({
      instanceId: launch.instanceId,
      platform: options.platform,
      home,
      env: launch.env
    })
    const platform = options.platform || process.platform
    const profileKey =
      platform === 'darwin' || platform === 'win32'
        ? profile.userDataPath.toLowerCase()
        : profile.userDataPath
    if (profiles.has(profileKey)) throw new Error('Instance profile collision')
    profiles.add(profileKey)
    for (const port of [launch.remoteDebuggingPort, launch.mainInspectorPort]) {
      if (ports.has(port)) throw new Error('Instance port collision')
      ports.add(port)
    }
    return { role: instance.role, userDataPath: profile.userDataPath, launch }
  })
  if (!instances.some((instance) => instance.role === 'active')) {
    throw new Error('At least one active instance required')
  }
  return {
    schemaVersion: 1,
    kind: 'taskwraith-perf-multi-instance-plan',
    home,
    repoRoot,
    instances,
    acceptance: 'unmeasured',
    requiresFilesystemContainment: true
  }
}

module.exports = { buildMultiInstancePlan }
