'use strict'

/**
 * Scale-down T2 smoke plan — describes steps without launching Electron.
 */

const { sanitizeDevInstanceId } = require('./devUserDataPath.cjs')

/**
 * @param {object} options
 * @param {string} [options.workload='dual_run']
 * @param {number} [options.seed=42]
 * @param {number} [options.scaleDown=40]
 * @param {string} [options.instanceId]
 * @returns {object}
 */
function buildT2SmokePlan(options = {}) {
  const workload = options.workload || 'dual_run'
  const seed = options.seed == null ? 42 : options.seed
  const scaleDown = options.scaleDown == null ? 40 : options.scaleDown
  const instanceId = options.instanceId || `perf-smoke-${workload}-${seed}`.slice(0, 48)
  const sanitized = sanitizeDevInstanceId(instanceId)

  return {
    schemaVersion: 1,
    kind: 'taskwraith-perf-t2-smoke-plan',
    doesNotLaunchElectron: true,
    workload,
    seed,
    scaleDown,
    instanceId,
    sanitizedInstanceId: sanitized,
    steps: [
      {
        id: 'provenance',
        action: 'collectRepoProvenance',
        requireCleanIsolatedWorktreeForAuthoritative: true
      },
      {
        id: 'derive-userdata',
        action: 'resolveUnpackagedDevUserDataPath',
        refuseProduction: true,
        refuseSharedDev: true
      },
      {
        id: 'ports',
        action: 'assertLaunchPortsFree',
        ports: ['remoteDebuggingPort', 'mainInspectorPort']
      },
      {
        id: 'materialize',
        action: 'materializePerfUserData',
        mode: 'legacy_v1',
        lean: true,
        scaleDown,
        note: 'Write chats/ before launch so migrateLegacyUserDataSync skips legacy seeding'
      },
      {
        id: 'build',
        action: 'npx electron-vite build',
        skippedInUnitSmoke: true
      },
      {
        id: 'launch',
        action: 'spawnExactElectronChild',
        requireFlags: ['--launch', '--i-accept-isolated-launch'],
        skippedInUnitSmoke: true
      },
      {
        id: 'attach',
        action: 'attachRendererCdpSession + attachMainInspectorSession',
        exactChildOnly: true,
        skippedInUnitSmoke: true
      },
      {
        id: 'profiles',
        action: 'collect renderer+main CPU/heap + OS samples',
        skippedInUnitSmoke: true
      },
      {
        id: 'replay',
        action: 'runDeterministicReplay',
        maxEvents: 24,
        note: 'Bounded prefix/tail saveChat batches; no provider spawns'
      },
      {
        id: 'report',
        action: 'createPerfReport + evaluatePerfGates',
        metricsCollected: false,
        explicitUnsupported: true
      },
      {
        id: 'terminate',
        action: 'terminateExactChild',
        neverAutoDeleteArtifacts: true,
        skippedInUnitSmoke: true
      }
    ]
  }
}

/**
 * Summarize plan for CLI / tests.
 * @param {object} plan
 */
function summarizeT2SmokePlan(plan) {
  const runnable = plan.steps.filter((s) => !s.skippedInUnitSmoke)
  const skipped = plan.steps.filter((s) => s.skippedInUnitSmoke)
  return {
    kind: plan.kind,
    doesNotLaunchElectron: plan.doesNotLaunchElectron,
    workload: plan.workload,
    scaleDown: plan.scaleDown,
    runnableStepIds: runnable.map((s) => s.id),
    electronSkippedStepIds: skipped.map((s) => s.id),
    requireLaunchFlags: ['--launch', '--i-accept-isolated-launch']
  }
}

module.exports = {
  buildT2SmokePlan,
  summarizeT2SmokePlan
}
