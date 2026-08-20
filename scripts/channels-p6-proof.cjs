#!/usr/bin/env node

const { spawn, spawnSync, execFileSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')

const esbuild = require('esbuild')

const ROOT = resolve(__dirname, '..')
const DEFAULT_EVIDENCE = join(ROOT, '.local-only', 'channels-p6-crash-recovery-evidence.json')
const WRITE_BOUNDARIES = [
  { name: 'migration_execution_publish', operation: 'link' },
  { name: 'finalization_execution_publish', operation: 'rename' }
]
const MEMBERED_START_STAGE_ORDER = [
  'execution_durable',
  'recovery_prepared',
  'channels_applied',
  'cutover_applied',
  'write_gate_quiesced',
  'finalization_execution_durable',
  'recovery_fenced',
  'logs_durable',
  'policies_durable',
  'admission:terminal_escrow_durable',
  'admission:terminal_metadata_durable',
  'admission:superseded_invitations_retired',
  'admissions_durable',
  'legacy_retired',
  'receipt_durable'
]
const EMPTY_START_STAGE_ORDER = [
  'execution_durable',
  'recovery_prepared',
  'channels_applied',
  'cutover_applied',
  'write_gate_quiesced',
  'finalization_execution_durable',
  'recovery_fenced',
  'logs_durable',
  'policies_durable',
  'admissions_durable',
  'receipt_durable'
]
const INTERRUPTED_START_STAGE_ORDERS = {
  membered: MEMBERED_START_STAGE_ORDER,
  empty: EMPTY_START_STAGE_ORDER
}
const INTERRUPTED_START_PERMUTATIONS = Object.fromEntries(
  Object.entries(INTERRUPTED_START_STAGE_ORDERS).map(([profileKind, stages]) => [
    profileKind,
    stages.slice(0, -1).map((stage, index) => [stage, stages[index + 1]])
  ])
)
const MATRIX_PROFILE_KINDS = ['membered', 'empty']

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertProof(condition, message) {
  if (!condition) throw new Error(`Channels P6 proof assertion failed: ${message}`)
}

function parseArgs(argv) {
  let evidencePath = DEFAULT_EVIDENCE
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--evidence') evidencePath = resolve(argv[++index])
    else throw new Error(`unknown argument ${argv[index]}`)
  }
  return { evidencePath }
}

function exactCandidate() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD^{commit}'], {
    cwd: ROOT,
    encoding: 'utf8'
  }).trim()
  for (const args of [
    ['diff', '--quiet'],
    ['diff', '--cached', '--quiet']
  ]) {
    const clean = spawnSync('git', args, { cwd: ROOT })
    assertProof(clean.status === 0, 'candidate has tracked working-tree or index changes')
  }
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: ROOT,
    encoding: 'utf8'
  }).trim()
  return { commit, tree }
}

function bundleWorker(workRoot) {
  const workerBundle = join(workRoot, 'channels-p6-proof-worker.cjs')
  esbuild.buildSync({
    entryPoints: [join(ROOT, 'scripts', 'channels-p6-proof-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    outfile: workerBundle,
    sourcemap: false,
    logLevel: 'warning'
  })
  return workerBundle
}

function workerEnv(workRoot, launchIndex, extra = {}) {
  return {
    ...process.env,
    CHANNELS_P6_PROOF_ROOT: workRoot,
    CHANNELS_P6_LAUNCH_INDEX: String(launchIndex),
    NODE_PATH: join(ROOT, 'node_modules'),
    ...extra
  }
}

function parseWorkerJson(stdout, command) {
  const lines = stdout.trim().split('\n').filter(Boolean)
  assertProof(lines.length > 0, `${command} worker returned no JSON`)
  try {
    return JSON.parse(lines.at(-1))
  } catch {
    throw new Error(`Channels P6 proof assertion failed: ${command} worker returned invalid JSON`)
  }
}

function runWorker(workerBundle, workRoot, command, launchIndex, extraEnv = {}) {
  const result = spawnSync(process.execPath, [workerBundle, command], {
    cwd: ROOT,
    env: workerEnv(workRoot, launchIndex, extraEnv),
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024
  })
  assertProof(!result.error, `${command} worker failed to start: ${result.error?.message}`)
  assertProof(
    result.status === 0,
    `${command} worker failed: ${(result.stderr || result.stdout).slice(0, 4_000)}`
  )
  return parseWorkerJson(result.stdout, command)
}

function killAtWriteWindow(workerBundle, workRoot, boundary, launchIndex) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [workerBundle, 'crash'], {
      cwd: ROOT,
      env: workerEnv(workRoot, launchIndex, { CHANNELS_P6_WRITE_BOUNDARY: boundary.name }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let receipt = null
    let killRequested = false
    let settled = false

    const timeout = setTimeout(() => {
      if (!killRequested) child.kill('SIGKILL')
      finish(new Error(`timed out waiting for ${boundary.name}: ${stderr || stdout}`))
    }, 30_000)

    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) rejectPromise(error)
      else resolvePromise(value)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      for (const line of stdout.split('\n').filter(Boolean)) {
        let candidate
        try {
          candidate = JSON.parse(line)
        } catch {
          continue
        }
        if (candidate.status !== 'write_window' || receipt) continue
        receipt = candidate
        try {
          assertProof(candidate.boundary === boundary.name, `${boundary.name} receipt drifted`)
          assertProof(
            candidate.operation === boundary.operation,
            `${boundary.name} primitive drifted`
          )
          assertProof(candidate.temporaryFileBytes > 0, `${boundary.name} temp file was empty`)
          assertProof(
            candidate.destinationExistsBeforePublish === false,
            `${boundary.name} did not stop before first publication`
          )
          killRequested = child.kill('SIGKILL')
          assertProof(killRequested, `${boundary.name} SIGKILL was not accepted`)
        } catch (error) {
          child.kill('SIGKILL')
          finish(error)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code, signal) => {
      if (settled) return
      try {
        assertProof(receipt, `${boundary.name} exited before reaching the write window: ${stderr}`)
        assertProof(killRequested, `${boundary.name} was not killed by the parent`)
        assertProof(code !== 0 || signal === 'SIGKILL', `${boundary.name} exited cleanly`)
        finish(null, { ...receipt, terminationSignal: signal || 'forced', exitCode: code })
      } catch (error) {
        finish(error)
      }
    })
  })
}

function killAtStartupStage(workerBundle, workRoot, stage, profileKind, launchIndex) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [workerBundle, 'interrupt'], {
      cwd: ROOT,
      env: workerEnv(workRoot, launchIndex, {
        CHANNELS_P6_PROFILE_KIND: profileKind,
        CHANNELS_P6_START_STAGE: stage
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let receipt = null
    let killRequested = false
    let settled = false

    const timeout = setTimeout(() => {
      if (!killRequested) child.kill('SIGKILL')
      finish(
        new Error(`timed out waiting for interrupted-start stage ${stage}: ${stderr || stdout}`)
      )
    }, 30_000)

    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) rejectPromise(error)
      else resolvePromise(value)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      for (const line of stdout.split('\n').filter(Boolean)) {
        let candidate
        try {
          candidate = JSON.parse(line)
        } catch {
          continue
        }
        if (candidate.status !== 'startup_gate' || receipt) continue
        receipt = candidate
        try {
          assertProof(candidate.stage === stage, `interrupted-start stage ${stage} drifted`)
          killRequested = child.kill('SIGKILL')
          assertProof(killRequested, `interrupted-start stage ${stage} SIGKILL was not accepted`)
        } catch (error) {
          child.kill('SIGKILL')
          finish(error)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code, signal) => {
      if (settled) return
      try {
        assertProof(receipt, `worker exited before interrupted-start stage ${stage}: ${stderr}`)
        assertProof(killRequested, `interrupted-start stage ${stage} was not killed by the parent`)
        assertProof(code !== 0 || signal === 'SIGKILL', `${stage} exited cleanly`)
        finish(null, { stage, terminationSignal: signal || 'forced', exitCode: code })
      } catch (error) {
        finish(error)
      }
    })
  })
}

async function runCrashRecoveryMission(workRoot) {
  const workerBundle = bundleWorker(workRoot)
  const seeded = runWorker(workerBundle, workRoot, 'seed', 0)
  assertProof(seeded.status === 'seeded', 'profile seed did not complete')
  assertProof(seeded.profileKind === 'membered', 'worker did not seed the membered profile')
  assertProof(seeded.disposable === true, 'worker did not own a disposable profile')
  assertProof(seeded.awaitingMaterialisation === 1, 'profile did not seed a real queue entry')

  const boundaries = []
  for (let index = 0; index < WRITE_BOUNDARIES.length; index += 1) {
    boundaries.push(
      await killAtWriteWindow(workerBundle, workRoot, WRITE_BOUNDARIES[index], index + 1)
    )
  }

  const recovered = runWorker(workerBundle, workRoot, 'recover', 3)
  const verified = runWorker(workerBundle, workRoot, 'verify', 4)
  assertProof(recovered.status === 'recovered', 'post-crash launch did not recover')
  assertProof(verified.status === 'verified', 'verification relaunch did not pass')
  assertProof(
    recovered.terminalPlanId === verified.terminalPlanId,
    'terminal migration authority changed on relaunch'
  )
  assertProof(
    Object.values(recovered.assertions).every((value) => value === true),
    'recovery launch contains a failed assertion'
  )
  assertProof(
    Object.values(verified.assertions).every((value) => value === true),
    'verification relaunch contains a failed assertion'
  )

  const assertions = {
    workerOwnedDisposableProfile: true,
    realQueueSeededBeforeCrashes: true,
    immutableExecutionKilledBeforeLinkPublish: true,
    terminalExecutionKilledBeforeRenamePublish: true,
    parentIssuedTwoRealProcessKills: true,
    migrationConvergedAfterRelaunch: recovered.assertions.migrationCommitted,
    realMembershipConverged: recovered.assertions.realMembershipRecovered,
    noQueueLoss: recovered.assertions.queueSurvivedBothProcessDeaths,
    deliveryExactlyOnce: recovered.assertions.contributionDeliveredExactlyOnce,
    settlementSurvivedFinalRelaunch: verified.assertions.queueSettlementSurvivedRelaunch,
    exactlyOnceSurvivedFinalRelaunch: verified.assertions.deliveredRowStillExactlyOnce
  }
  assertProof(Object.values(assertions).every(Boolean), 'mission did not satisfy every assertion')
  return {
    workerBundleBytes: statSync(workerBundle).size,
    workerBundleSha256: sha256(readFileSync(workerBundle)),
    mission: {
      status: 'passed',
      profileKind: 'disposable',
      crashCount: boundaries.length,
      relaunchCount: 4,
      boundaryCount: boundaries.length,
      boundaries,
      assertionCount: Object.keys(assertions).length,
      assertions
    }
  }
}

async function runInterruptedStartMatrix(workRoot) {
  const workerBundle = bundleWorker(workRoot)
  const cases = []
  let processKillCount = 0
  let lastEmptyCaseRoot = null

  for (const profileKind of MATRIX_PROFILE_KINDS) {
    const permutations = INTERRUPTED_START_PERMUTATIONS[profileKind]
    for (let index = 0; index < permutations.length; index += 1) {
      const stages = permutations[index]
      const caseRoot = join(workRoot, `matrix-${profileKind}-${String(index + 1).padStart(2, '0')}`)
      mkdirSync(caseRoot, { recursive: true })
      const profileEnv = { CHANNELS_P6_PROFILE_KIND: profileKind }
      const seeded = runWorker(workerBundle, caseRoot, 'seed', 0, profileEnv)
      assertProof(seeded.status === 'seeded', `${profileKind} matrix profile did not seed`)
      assertProof(seeded.disposable === true, `${profileKind} matrix profile was not disposable`)
      assertProof(
        seeded.awaitingMaterialisation === (profileKind === 'membered' ? 1 : 0),
        `${profileKind} matrix seed shape drifted`
      )

      const kills = []
      for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
        kills.push(
          await killAtStartupStage(
            workerBundle,
            caseRoot,
            stages[stageIndex],
            profileKind,
            stageIndex + 1
          )
        )
        processKillCount += 1
      }

      let observed
      let verified
      try {
        observed = runWorker(workerBundle, caseRoot, 'matrix-observe', 3, profileEnv)
        verified = runWorker(workerBundle, caseRoot, 'matrix-observe', 4, profileEnv)
      } catch (error) {
        throw new Error(
          `Channels P6 ${profileKind} matrix case ${stages.join(' -> ')} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
      const expectedSeatIds = profileKind === 'membered' ? ['collaborator-channels-p6-proof'] : []
      const expectedMemberCount = profileKind === 'membered' ? 2 : 1
      assertProof(observed.status === 'observed', `${profileKind} recovery did not observe`)
      assertProof(verified.status === 'observed', `${profileKind} verification did not observe`)
      assertProof(
        JSON.stringify(observed.externalSeatIds) === JSON.stringify(expectedSeatIds),
        `${profileKind} recovered to the wrong external-seat state after ${stages.join(' -> ')}`
      )
      assertProof(
        observed.memberCount === expectedMemberCount,
        `${profileKind} recovered to inconsistent membership after ${stages.join(' -> ')}`
      )
      assertProof(
        JSON.stringify(verified.externalSeatIds) === JSON.stringify(observed.externalSeatIds) &&
          verified.memberCount === observed.memberCount &&
          verified.terminalPlanId === observed.terminalPlanId,
        `${profileKind} changed on the verification relaunch after ${stages.join(' -> ')}`
      )
      assertProof(
        Object.values(observed.assertions).every((value) => value === true) &&
          Object.values(verified.assertions).every((value) => value === true),
        `${profileKind} case contains a failed strict assertion`
      )
      cases.push({ profileKind, stages, kills, observed, verified })
      if (profileKind === 'empty') lastEmptyCaseRoot = caseRoot
    }
  }

  assertProof(lastEmptyCaseRoot, 'matrix did not produce a completed empty profile')
  const blocked = runWorker(workerBundle, lastEmptyCaseRoot, 'blocked-observe', 5, {
    CHANNELS_P6_PROFILE_KIND: 'empty'
  })
  assertProof(blocked.status === 'blocked', 'blocked observation did not reach degraded startup')
  assertProof(
    blocked.blockedErrorCode === 'recovery_blocked',
    'blocked observation accepted an unrelated startup failure'
  )
  const knownEmpty = cases.find((entry) => entry.profileKind === 'empty')?.observed
  assertProof(Array.isArray(knownEmpty?.externalSeatIds), 'known-empty state was not enumerable')
  assertProof(knownEmpty.externalSeatIds.length === 0, 'known-empty state was not empty')
  assertProof(blocked.externalSeatIds === null, 'blocked state collapsed to known empty')

  const memberedCases = cases.filter((entry) => entry.profileKind === 'membered')
  const emptyCases = cases.filter((entry) => entry.profileKind === 'empty')
  const assertions = {
    workerOwnedEveryDisposableProfile: cases.every(
      (entry) => entry.observed.profileKind === entry.profileKind
    ),
    matrixCoveredBothProfileKinds:
      memberedCases.length === INTERRUPTED_START_PERMUTATIONS.membered.length &&
      emptyCases.length === INTERRUPTED_START_PERMUTATIONS.empty.length,
    everyTransitionRepeated: cases.every((entry) => entry.kills.length === 2),
    parentKilledEveryInterruptedStart:
      processKillCount === cases.length * 2 &&
      cases.every((entry) => entry.kills.every((kill) => kill.terminationSignal)),
    memberedMembershipExact: memberedCases.every(
      (entry) =>
        entry.observed.memberCount === 2 &&
        JSON.stringify(entry.observed.externalSeatIds) ===
          JSON.stringify(['collaborator-channels-p6-proof'])
    ),
    emptyMembershipExact: emptyCases.every(
      (entry) => entry.observed.memberCount === 1 && entry.observed.externalSeatIds.length === 0
    ),
    knownEmptyRemainedAnArray: Array.isArray(knownEmpty.externalSeatIds),
    cannotEnumerateRemainedNull: blocked.externalSeatIds === null,
    blockedStartupConstructedNoAuthority:
      blocked.bootstrapConstructed === false &&
      blocked.legacyWritesQuiesced === true &&
      blocked.blockedErrorCode === 'recovery_blocked',
    terminalAuthorityStableAcrossRelaunch: cases.every(
      (entry) => entry.observed.terminalPlanId === entry.verified.terminalPlanId
    ),
    noInconsistentStateServed: cases.every(
      (entry) =>
        entry.observed.assertions.recoveryHealthy && entry.verified.assertions.recoveryHealthy
    )
  }
  assertProof(Object.values(assertions).every(Boolean), 'interrupted-start matrix did not converge')
  return {
    workerBundleBytes: statSync(workerBundle).size,
    workerBundleSha256: sha256(readFileSync(workerBundle)),
    mission: {
      status: 'passed',
      profileKinds: MATRIX_PROFILE_KINDS,
      stageCounts: Object.fromEntries(
        Object.entries(INTERRUPTED_START_STAGE_ORDERS).map(([profileKind, stages]) => [
          profileKind,
          stages.length
        ])
      ),
      permutationCounts: Object.fromEntries(
        Object.entries(INTERRUPTED_START_PERMUTATIONS).map(([profileKind, permutations]) => [
          profileKind,
          permutations.length
        ])
      ),
      permutationCount: cases.length,
      caseCount: cases.length,
      processKillCount,
      cases,
      knownEmpty: knownEmpty.externalSeatIds,
      cannotEnumerate: blocked.externalSeatIds,
      assertionCount: Object.keys(assertions).length,
      assertions
    }
  }
}

function writePrivateEvidence(path, evidence) {
  const serialized = JSON.stringify(evidence, null, 2)
  for (const forbidden of ['/Users/', '/private/var/', 'human-collaboration.json']) {
    assertProof(
      !serialized.includes(forbidden),
      `evidence contains forbidden material ${forbidden}`
    )
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${serialized}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
  assertProof((statSync(path).mode & 0o777) === 0o600, 'evidence is not mode 0600')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const candidate = exactCandidate()
  const workRoot = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p6-proof-'))
  try {
    const productionMission = await runCrashRecoveryMission(workRoot)
    const evidence = {
      schemaVersion: 1,
      proof: 'Channels P6 real-process durable-write crash recovery mission',
      status: 'passed',
      generatedAt: new Date().toISOString(),
      platform: { platform: process.platform, arch: process.arch, node: process.version },
      candidate,
      productionMission
    }
    writePrivateEvidence(options.evidencePath, evidence)
    process.stdout.write(
      `${JSON.stringify(
        {
          status: evidence.status,
          candidate: candidate.commit,
          crashCount: productionMission.mission.crashCount,
          relaunchCount: productionMission.mission.relaunchCount,
          assertionCount: productionMission.mission.assertionCount,
          evidenceSha256: sha256(readFileSync(options.evidencePath))
        },
        null,
        2
      )}\n`
    )
  } finally {
    rmSync(workRoot, { recursive: true, force: true })
  }
}

module.exports = {
  INTERRUPTED_START_PERMUTATIONS,
  INTERRUPTED_START_STAGE_ORDERS,
  WRITE_BOUNDARIES,
  bundleWorker,
  parseArgs,
  runCrashRecoveryMission,
  runInterruptedStartMatrix,
  runWorker
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${String(error.stack || error.message || error)}\n`)
    process.exitCode = 1
  })
}
