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

function runWorker(workerBundle, workRoot, command, launchIndex) {
  const result = spawnSync(process.execPath, [workerBundle, command], {
    cwd: ROOT,
    env: workerEnv(workRoot, launchIndex),
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

async function runCrashRecoveryMission(workRoot) {
  const workerBundle = bundleWorker(workRoot)
  const seeded = runWorker(workerBundle, workRoot, 'seed', 0)
  assertProof(seeded.status === 'seeded', 'profile seed did not complete')
  assertProof(seeded.profileKind === 'disposable', 'worker did not own a disposable profile')
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
  WRITE_BOUNDARIES,
  bundleWorker,
  parseArgs,
  runCrashRecoveryMission,
  runWorker
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${String(error.stack || error.message || error)}\n`)
    process.exitCode = 1
  })
}
