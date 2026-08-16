#!/usr/bin/env node

const { execFileSync, spawnSync } = require('node:child_process')
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
const DEFAULT_EVIDENCE = join(ROOT, '.local-only', 'channels-p5-live-migration-evidence.json')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertProof(condition, message) {
  if (!condition) throw new Error(`Channels P5 live proof assertion failed: ${message}`)
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

function runMission(workRoot) {
  const workerBundle = join(workRoot, 'channels-p5-live-migration-proof-worker.cjs')
  esbuild.buildSync({
    entryPoints: [join(ROOT, 'scripts', 'channels-p5-live-migration-proof-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    outfile: workerBundle,
    sourcemap: false,
    logLevel: 'warning'
  })
  const result = spawnSync(process.execPath, [workerBundle], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHANNELS_P5_LIVE_PROOF_ROOT: workRoot,
      NODE_PATH: join(ROOT, 'node_modules')
    },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024
  })
  assertProof(!result.error, `mission failed to start: ${result.error?.message}`)
  assertProof(
    result.status === 0,
    `mission failed: ${(result.stderr || result.stdout).slice(0, 4_000)}`
  )
  let mission
  try {
    mission = JSON.parse(result.stdout.trim())
  } catch {
    throw new Error('Channels P5 live proof assertion failed: mission returned invalid JSON')
  }
  assertProof(mission.status === 'passed', 'mission did not pass')
  assertProof(mission.profileKind === 'disposable', 'mission did not use a disposable profile')
  assertProof(mission.relaunchCount >= 3, 'mission did not perform multiple relaunches')
  assertProof(mission.assertionCount === 14, 'E2 assertion count changed')
  assertProof(
    Object.values(mission.assertions).every((value) => value === true),
    'mission contains a failed assertion'
  )
  return {
    workerBundleBytes: statSync(workerBundle).size,
    workerBundleSha256: sha256(readFileSync(workerBundle)),
    mission
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
  const workRoot = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p5-live-proof-'))
  try {
    const productionMission = runMission(workRoot)
    const evidence = {
      schemaVersion: 1,
      proof: 'Channels P5 disposable-profile migration and restart mission',
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

module.exports = { parseArgs, runMission }

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${String(error.stack || error.message || error)}\n`)
    process.exitCode = 1
  })
}
