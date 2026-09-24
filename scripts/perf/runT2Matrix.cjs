'use strict'

/**
 * Dry-only T2 interference-matrix orchestration.
 *
 * This module maps every canonical matrix cell to the already-landed driver
 * capabilities and emits diagnostic evidence-v1 PLAN descriptors. It never
 * calls a driver, launches Electron, contacts a provider, opens credentials,
 * or chooses userData. A future live runner must be a separate, explicit
 * isolated-worktree contract; --live is refused here.
 */

const { createHash } = require('node:crypto')
const {
  MATRIX_SAMPLING,
  RUN_EVIDENCE_VERSION,
  CONTROL_ACTIONS,
  PROVIDER_MIX_DESCRIPTIONS,
  enumerateMatrixCells,
  validateMatrixCell,
  cellName,
  lightAloneCellFor,
  validateRunEvidence
} = require('./interferenceMatrix.cjs')
const { buildT2RunEvidence } = require('./t2RunEvidence.cjs')
const { PROPOSED_CROSS_THREAD_BOUNDS } = require('./perfGateThresholds.cjs')

const PLAN_SCHEMA_VERSION = 1
const PLAN_KIND = 'taskwraith-t2-interference-matrix-plan'
const PLAN_MODE = 'dry-plan'
const PLAN_SEED = 42
const PLAN_BUILD_ID = 'dry-plan-not-a-build'

const BASE_CAPABILITIES = Object.freeze([
  'concurrent_per_chat_replay_lanes',
  'deterministic_replay_provider',
  'control_action_replay_events'
])

const SATURATION_CAPABILITY = Object.freeze({
  none: null,
  ensemble_pool_30_join: 'ensemble_pool_saturation_driver',
  host_queue_16_active_1_queued: 'host_native_saturation_driver'
})

const DEFAULT_DRIVER_REGISTRY = Object.freeze({
  concurrent_per_chat_replay_lanes: Object.freeze({
    module: './concurrentReplayLanes.cjs',
    runExport: 'runConcurrentReplayLanes',
    dryRunExport: 'runDryRun'
  }),
  deterministic_replay_provider: Object.freeze({
    module: './deterministicReplayProvider.cjs',
    runExport: 'runProviderTurnReplay',
    dryRunExport: 'runDryRun'
  }),
  control_action_replay_events: Object.freeze({
    module: './controlActionReplay.cjs',
    runExport: 'runControlActionReplay',
    dryRunExport: 'runDryRun'
  }),
  ensemble_pool_saturation_driver: Object.freeze({
    module: './ensemblePoolSaturation.cjs',
    runExport: 'runEnsemblePoolSaturation',
    dryRunExport: 'runDryRun'
  }),
  host_native_saturation_driver: Object.freeze({
    module: './hostNativeSaturation.cjs',
    runExport: 'runHostNativeSaturation',
    dryRunExport: 'runDryRun'
  })
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function jsonCopy(value) {
  return JSON.parse(JSON.stringify(value))
}

function arraysEqual(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function providerFamilyForMix(mix) {
  if (mix.startsWith('codex_')) return 'codex'
  if (mix.startsWith('cursor_')) return 'cursor'
  if (mix.startsWith('ollama_')) return 'ollama'
  if (mix.startsWith('claude_')) return 'claude'
  if (mix.startsWith('kimi_')) return 'kimi'
  throw new Error('unmapped provider mix: ' + String(mix))
}

function requiredCapabilities(cell) {
  const check = validateMatrixCell(cell)
  if (!check.ok) throw new Error('invalid matrix cell: ' + check.errors.join('; '))
  const saturation = SATURATION_CAPABILITY[check.cell.saturation]
  if (saturation === undefined) {
    throw new Error('unmapped saturation mode: ' + check.cell.saturation)
  }
  return [...BASE_CAPABILITIES, ...(saturation === null ? [] : [saturation])]
}

function validateCompleteCellSet(cells) {
  if (!Array.isArray(cells)) throw new Error('matrix cells must be an array')
  const canonical = enumerateMatrixCells()
  const canonicalNames = canonical.map((cell) => cell.name).sort()
  const normalized = cells.map((cell) => {
    const check = validateMatrixCell(cell)
    if (!check.ok) throw new Error('invalid matrix cell: ' + check.errors.join('; '))
    const name = cellName(check.cell)
    if (cell.name !== undefined && cell.name !== name) {
      throw new Error('matrix cell name does not match its axes: ' + String(cell.name))
    }
    return { ...check.cell, name }
  })
  const names = normalized.map((cell) => cell.name).sort()
  if (new Set(names).size !== names.length || !arraysEqual(names, canonicalNames)) {
    throw new Error('matrix cell set is incomplete, duplicated, or unmapped')
  }
  return normalized
}

function resolveDriverRegistry(registry, loadDriver) {
  if (!isPlainObject(registry)) throw new Error('driver registry must be an object')
  const required = new Set()
  for (const cell of enumerateMatrixCells()) {
    for (const capability of requiredCapabilities(cell)) required.add(capability)
  }
  const resolved = {}
  for (const capability of [...required].sort()) {
    const descriptor = registry[capability]
    if (
      !isPlainObject(descriptor) ||
      typeof descriptor.module !== 'string' ||
      !descriptor.module.startsWith('./') ||
      typeof descriptor.runExport !== 'string' ||
      typeof descriptor.dryRunExport !== 'string'
    ) {
      throw new Error('missing or invalid driver capability: ' + capability)
    }
    const driver = loadDriver(descriptor.module)
    if (
      !driver ||
      typeof driver[descriptor.runExport] !== 'function' ||
      typeof driver[descriptor.dryRunExport] !== 'function'
    ) {
      throw new Error(
        'driver capability export mismatch: ' + capability + ' (' + descriptor.module + ')'
      )
    }
    resolved[capability] = {
      capability,
      module: descriptor.module,
      runExport: descriptor.runExport,
      dryRunExport: descriptor.dryRunExport,
      driver
    }
  }
  return resolved
}

function driverConfiguration(capability, cell, resolved) {
  if (capability === 'concurrent_per_chat_replay_lanes') {
    return {
      history: cell.history,
      chats: cell.chats,
      path: cell.path,
      windowMs: MATRIX_SAMPLING.windowMs,
      repetitions: MATRIX_SAMPLING.repetitions
    }
  }
  if (capability === 'deterministic_replay_provider') {
    return {
      providerFamily: providerFamilyForMix(cell.mix),
      mix: cell.mix,
      mixDescription: PROVIDER_MIX_DESCRIPTIONS[cell.mix],
      seed: PLAN_SEED,
      diagnosticOnly: true
    }
  }
  if (capability === 'control_action_replay_events') {
    const commands = resolved.driver.CONTROL_ACTION_HOST_COMMANDS
    if (!isPlainObject(commands)) {
      throw new Error('control action driver does not export its Host-command map')
    }
    return {
      actions: CONTROL_ACTIONS.map((action) => ({
        action,
        command: commands[action]
      }))
    }
  }
  if (capability === 'ensemble_pool_saturation_driver') {
    if (!Number.isSafeInteger(resolved.driver.DEFAULT_POOL_TARGET)) {
      throw new Error('ensemble saturation driver lacks a valid pool target')
    }
    return {
      mode: cell.saturation,
      poolTarget: resolved.driver.DEFAULT_POOL_TARGET,
      arrivalCount: 1,
      diagnosticOnly: true
    }
  }
  if (capability === 'host_native_saturation_driver') {
    if (
      !Number.isSafeInteger(resolved.driver.DEFAULT_ACTIVE_TARGET) ||
      !Number.isSafeInteger(resolved.driver.DEFAULT_QUEUED_TARGET)
    ) {
      throw new Error('host saturation driver lacks valid occupancy targets')
    }
    return {
      mode: cell.saturation,
      activeTarget: resolved.driver.DEFAULT_ACTIVE_TARGET,
      queuedTarget: resolved.driver.DEFAULT_QUEUED_TARGET,
      requiresPersistProbe: true,
      diagnosticOnly: true
    }
  }
  throw new Error('unmapped driver capability: ' + capability)
}

function plannedRole(cell) {
  return cell.chats === 1 ? 'light-alone' : 'light-beside'
}

function plannedChatIds(cell) {
  return Array.from(
    { length: cell.chats },
    (_value, index) => 'plan:' + cell.name + ':chat-' + String(index + 1)
  )
}

function planFingerprint(cell, role) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: PLAN_SCHEMA_VERSION,
        cellName: cell.name,
        role,
        seed: PLAN_SEED
      })
    )
    .digest('hex')
}

function buildEvidencePlan(cell, role) {
  const fixtureChatIds = plannedChatIds(cell)
  const built = buildT2RunEvidence({
    cell: cell.name,
    role,
    workload: 'interference_matrix',
    seed: PLAN_SEED,
    fixtureFingerprint: planFingerprint(cell, role),
    fixtureChatIds,
    buildId: PLAN_BUILD_ID,
    launched: false,
    windows: []
  })
  return {
    descriptor: built.run,
    evidenceEligible: built.evidenceEligible,
    evidenceErrors: [...built.evidenceErrors],
    fixtureFingerprintKind: 'deterministic-plan-placeholder'
  }
}

function buildCellPlan(cell, resolvedDrivers, boundReferences) {
  const role = plannedRole(cell)
  const capabilities = requiredCapabilities(cell)
  const evidenceV1 = buildEvidencePlan(cell, role)
  const drivers = capabilities.map((capability) => {
    const resolved = resolvedDrivers[capability]
    if (!resolved) throw new Error('missing resolved driver capability: ' + capability)
    return {
      capability,
      module: resolved.module,
      runExport: resolved.runExport,
      dryRunExport: resolved.dryRunExport,
      configuration: driverConfiguration(capability, cell, resolved)
    }
  })
  return {
    cell: { ...cell },
    runName: cell.name + '::' + role,
    role,
    pairing: {
      lightAloneCellName: role === 'light-alone' ? cell.name : lightAloneCellFor(cell).name,
      comparisonRole: 'light-alone'
    },
    capabilities,
    drivers,
    attribution: {
      lightChatId: evidenceV1.descriptor.evidence.lightChatId,
      populations: jsonCopy(evidenceV1.descriptor.evidence.populations)
    },
    plannedWindows: Array.from({ length: MATRIX_SAMPLING.repetitions }, (_value, repetition) => ({
      repetition,
      durationMs: MATRIX_SAMPLING.windowMs,
      percentiles: [...MATRIX_SAMPLING.percentiles],
      requiresCpuProfile: MATRIX_SAMPLING.requiresCpuProfile,
      requiresHeapSnapshot: MATRIX_SAMPLING.requiresHeapSnapshot,
      executed: false
    })),
    proposedBoundReferences: [...boundReferences],
    evidenceV1
  }
}

function validateT2MatrixPlan(plan) {
  const errors = []
  if (!isPlainObject(plan)) return ['plan must be an object']
  if (
    plan.schemaVersion !== PLAN_SCHEMA_VERSION ||
    plan.kind !== PLAN_KIND ||
    plan.mode !== PLAN_MODE
  ) {
    errors.push('matrix plan schema/kind/mode mismatch')
  }
  if (
    plan.diagnosticOnly !== true ||
    plan.doesNotLaunchElectron !== true ||
    plan.executesDrivers !== false ||
    plan.measuredEvidence !== false ||
    plan.liveExecutionContract !== null
  ) {
    errors.push('matrix plan must be dry-only and non-measurement')
  }
  if (
    !isPlainObject(plan.thresholds) ||
    plan.thresholds.status !== 'proposed-unratified' ||
    plan.thresholds.ratified !== false ||
    !isPlainObject(plan.thresholds.values)
  ) {
    errors.push('matrix plan thresholds must remain proposed and unratified')
  }
  const boundReferences = Object.keys(PROPOSED_CROSS_THREAD_BOUNDS)
  if (
    !arraysEqual(plan.thresholds?.references, boundReferences) ||
    JSON.stringify(plan.thresholds?.values) !== JSON.stringify(PROPOSED_CROSS_THREAD_BOUNDS)
  ) {
    errors.push('matrix plan threshold references mismatch')
  }
  if (
    !isPlainObject(plan.sampling) ||
    JSON.stringify(plan.sampling) !== JSON.stringify(MATRIX_SAMPLING)
  ) {
    errors.push('matrix sampling contract mismatch')
  }
  const canonicalNames = enumerateMatrixCells()
    .map((cell) => cell.name)
    .sort()
  const blocks = Array.isArray(plan.cells) ? plan.cells : []
  const blockNames = blocks.map((block) => block?.cell?.name).sort()
  if (!arraysEqual(blockNames, canonicalNames) || new Set(blockNames).size !== blockNames.length) {
    errors.push('matrix plan does not cover every canonical cell exactly once')
  }
  for (const block of blocks) {
    if (!isPlainObject(block) || !isPlainObject(block.cell)) {
      errors.push('invalid matrix plan block')
      continue
    }
    const check = validateMatrixCell(block.cell)
    if (!check.ok || block.cell.name !== cellName(check.ok ? check.cell : block.cell)) {
      errors.push('invalid canonical cell in plan block')
      continue
    }
    const role = plannedRole(block.cell)
    if (block.role !== role || block.runName !== block.cell.name + '::' + role) {
      errors.push('matrix plan role/run identity mismatch for ' + block.cell.name)
    }
    const capabilities = requiredCapabilities(block.cell)
    if (!arraysEqual(block.capabilities, capabilities)) {
      errors.push('matrix plan capability mismatch for ' + block.cell.name)
    }
    if (
      !Array.isArray(block.drivers) ||
      !arraysEqual(
        block.drivers.map((driver) => driver?.capability),
        capabilities
      )
    ) {
      errors.push('matrix plan driver mapping mismatch for ' + block.cell.name)
    }
    if (
      !Array.isArray(block.plannedWindows) ||
      block.plannedWindows.length !== MATRIX_SAMPLING.repetitions ||
      block.plannedWindows.some(
        (window, repetition) =>
          window?.repetition !== repetition ||
          window?.durationMs !== MATRIX_SAMPLING.windowMs ||
          window?.executed !== false ||
          !arraysEqual(window?.percentiles, MATRIX_SAMPLING.percentiles)
      )
    ) {
      errors.push('matrix plan window contract mismatch for ' + block.cell.name)
    }
    if (!arraysEqual(block.proposedBoundReferences, boundReferences)) {
      errors.push('matrix plan bound references mismatch for ' + block.cell.name)
    }
    const evidence = block.evidenceV1
    const descriptor = evidence?.descriptor
    const populations = descriptor?.evidence?.populations
    if (
      !isPlainObject(evidence) ||
      evidence.evidenceEligible !== false ||
      evidence.fixtureFingerprintKind !== 'deterministic-plan-placeholder' ||
      !isPlainObject(descriptor) ||
      descriptor.evidence?.schemaVersion !== RUN_EVIDENCE_VERSION ||
      descriptor.evidence?.diagnosticOnly !== true ||
      descriptor.diagnosticOnly !== true ||
      descriptor.evidence?.windows?.length !== 0 ||
      !Array.isArray(populations) ||
      populations.length !== block.cell.chats ||
      populations[0]?.role !== 'light' ||
      populations.slice(1).some((population) => population?.role !== 'heavy') ||
      descriptor.evidence.lightChatId !== populations[0]?.chatId ||
      validateRunEvidence(descriptor).length === 0
    ) {
      errors.push('matrix plan evidence-v1 attribution is not diagnostic for ' + block.cell.name)
    }
  }
  return errors
}

function buildT2MatrixPlan(options = {}) {
  if (!isPlainObject(options)) throw new Error('matrix plan options must be an object')
  const cells = validateCompleteCellSet(options.cells || enumerateMatrixCells())
  const driverRegistry = options.driverRegistry || DEFAULT_DRIVER_REGISTRY
  const loadDriver = options.loadDriver || require
  if (typeof loadDriver !== 'function') throw new Error('loadDriver must be a function')
  const resolvedDrivers = resolveDriverRegistry(driverRegistry, loadDriver)
  const thresholdReferences = Object.keys(PROPOSED_CROSS_THREAD_BOUNDS)
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    kind: PLAN_KIND,
    mode: PLAN_MODE,
    diagnosticOnly: true,
    doesNotLaunchElectron: true,
    executesDrivers: false,
    measuredEvidence: false,
    liveExecutionContract: null,
    thresholds: {
      status: 'proposed-unratified',
      ratified: false,
      references: thresholdReferences,
      values: jsonCopy(PROPOSED_CROSS_THREAD_BOUNDS)
    },
    sampling: jsonCopy(MATRIX_SAMPLING),
    driverCapabilities: Object.values(resolvedDrivers).map((driver) => ({
      capability: driver.capability,
      module: driver.module,
      runExport: driver.runExport,
      dryRunExport: driver.dryRunExport
    })),
    cells: cells.map((cell) => buildCellPlan(cell, resolvedDrivers, thresholdReferences))
  }
  const errors = validateT2MatrixPlan(plan)
  if (errors.length > 0) {
    throw new Error('invalid T2 matrix dry plan: ' + errors.join('; '))
  }
  return plan
}

function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('argv must be an array')
  const args = new Set(argv)
  if (args.has('--live') || args.has('--launch') || args.has('--i-accept-isolated-launch')) {
    throw new Error(
      'Live T2 matrix execution is unavailable: a future isolated runner contract is required'
    )
  }
  for (const arg of args) {
    if (!['--dry-run', '--help'].includes(arg)) {
      throw new Error('unknown T2 matrix option: ' + arg)
    }
  }
  return { dryRun: args.has('--dry-run'), help: args.has('--help') }
}

function runT2MatrixCli(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    return {
      ok: true,
      helped: true,
      usage: 'node scripts/perf/runT2Matrix.cjs --dry-run'
    }
  }
  if (!args.dryRun) {
    throw new Error('T2 matrix runner requires --dry-run; live execution is not implemented')
  }
  return { ok: true, plan: buildT2MatrixPlan(options) }
}

if (require.main === module) {
  try {
    const result = runT2MatrixCli()
    process.stdout.write(JSON.stringify(result.plan || result, null, 2) + '\n')
  } catch (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error) + '\n')
    process.exitCode = 1
  }
}

module.exports = {
  PLAN_SCHEMA_VERSION,
  PLAN_KIND,
  PLAN_MODE,
  BASE_CAPABILITIES,
  SATURATION_CAPABILITY,
  DEFAULT_DRIVER_REGISTRY,
  requiredCapabilities,
  validateCompleteCellSet,
  validateT2MatrixPlan,
  buildT2MatrixPlan,
  runT2MatrixCli
}
