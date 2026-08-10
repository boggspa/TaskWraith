#!/usr/bin/env node

const { execFileSync, spawnSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, dirname, join, relative, resolve } = require('node:path')

const asar = require('@electron/asar')
const esbuild = require('esbuild')

const ROOT = resolve(__dirname, '..')
const DEFAULT_EVIDENCE = join(ROOT, '.local-only', 'channels-p3-enabled-proof-evidence.json')
const REVIEW_ID = 'channels-p3-agent-participation-v1'
const ACCEPTED_CANDIDATE = 'b0f4d84e1fd84e2312f8375dcf7e6fc2d4ee63e4'
const ACCEPTANCE_COMMIT = '92ad1e98259a95377b78c689b586e5e9f8d120d0'
const ENABLE_COMMIT = '191e5e37d6602f8a60e5cf280d416dc342b96492'
const PACKAGE_PROVENANCE_COMMIT = 'e0d7d1be4e4e5af1ad0ab8e91ffe65cf26338828'
const FLEET_WORKTREE_SOURCE_COMMIT = '7a2561c47519036e529308b93fbc425303b3c12a'

const PACKAGED_REQUIRED_MARKERS = {
  main: [
    REVIEW_ID,
    ACCEPTED_CANDIDATE,
    ACCEPTANCE_COMMIT,
    'docs/channels-p3-adversarial-review.md',
    'TaskWraith Channel agent turn envelope v',
    'Channel history is intentionally absent',
    'channels:agent:grant'
  ],
  preload: ['channels:agent:overview', 'channels:agent:grant', 'channels:agent:rotate'],
  renderer: [
    'Human posts stay manual.',
    'named in an active signed grant can mention that agent to start a bounded run',
    'only its named humans start this agent by mention'
  ]
}

const PACKAGED_FORBIDDEN_MARKERS = {
  all: [
    'blocked_pending_adversarial_review',
    'channels:agent:enable',
    'channels:agent:set-review',
    'TASKWRAITH_CHANNEL_AGENT_REVIEW',
    'channelAgentReviewOverride'
  ],
  preload: [
    'privateKeyDerB64',
    'ownerSignatureB64',
    'agentSignatureB64',
    'workspaceIdentityHash',
    'permissionPostureHash',
    'participationEnabled'
  ],
  renderer: [
    'privateKeyDerB64',
    'ownerSignatureB64',
    'agentSignatureB64',
    'workspaceIdentityHash',
    'permissionPostureHash',
    'participationEnabled',
    'Automatic mention dispatch remains source-disabled',
    'mention dispatch remains disabled pending security review'
  ]
}

const ENABLE_TRANSITION_FILES = [
  'scripts/channels-p2-proof.cjs',
  'scripts/channels-p2-proof.test.ts',
  'scripts/channels-p3-review.test.ts',
  'src/main/collaboration/ChannelAgentMentionAdmission.test.ts',
  'src/main/collaboration/ChannelAgentMentionAdmission.ts',
  'src/main/collaboration/ChannelAgentProductionComposition.enabled.test.ts',
  'src/main/collaboration/ChannelAgentProductionComposition.test.ts',
  'src/main/collaboration/ChannelAgentProductionService.enabled.test.ts',
  'src/main/collaboration/ChannelAgentProductionService.test.ts',
  'src/main/collaboration/ChannelAgentProductionService.ts',
  'src/main/collaboration/ChannelProductionService.agentExecution.test.ts',
  'src/main/collaboration/ChannelProductionService.test.ts',
  'src/renderer/src/components/ChannelAgentManagement.test.tsx',
  'src/renderer/src/components/ChannelAgentManagement.tsx',
  'src/renderer/src/components/ChannelHostPanel.test.tsx',
  'src/renderer/src/components/ChannelHostPanel.tsx',
  'src/renderer/src/components/ChannelMemberPanel.test.tsx',
  'src/renderer/src/components/ChannelMemberPanel.tsx',
  'src/shared/collaboration/ChannelAgentReviewGate.test.ts',
  'src/shared/collaboration/ChannelAgentReviewGate.ts'
]

const POST_ACCEPTANCE_PROTECTED_PINS = new Map([
  ['src/shared/collaboration/ChannelAgentReviewGate.test.ts', PACKAGE_PROVENANCE_COMMIT],
  ['src/shared/collaboration/ChannelAgentReviewGate.ts', PACKAGE_PROVENANCE_COMMIT],
  ['src/main/run/AgentRunTypes.ts', FLEET_WORKTREE_SOURCE_COMMIT]
])

const PROTECTED_BLOB_PINS = new Map([
  ...ENABLE_TRANSITION_FILES.map((file) => [file, ENABLE_COMMIT]),
  ...POST_ACCEPTANCE_PROTECTED_PINS
])

const ALLOWED_PROTECTED_CHANGES = new Set([
  ...PROTECTED_BLOB_PINS.keys(),
  'docs/channels-p3-adversarial-review.md',
  'docs/channels-p3-security-design.md',
  'scripts/channels-p3-enabled-proof.cjs',
  'scripts/channels-p3-enabled-proof-worker.ts',
  'scripts/channels-p3-enabled-proof.test.ts'
])

const COMPOSITION_ROOTS = [
  'src/main/index.ts',
  'src/renderer/src/App.tsx',
  'src/main/services/EnsembleOrchestrator.ts'
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertProof(condition, message) {
  if (!condition) throw new Error(`P3 enabled proof assertion failed: ${message}`)
}

function parseArgs(argv) {
  let evidencePath = DEFAULT_EVIDENCE
  let packageInput = ''
  let candidateInput = ''
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--evidence') evidencePath = resolve(argv[++index])
    else if (argv[index] === '--package') packageInput = resolve(argv[++index])
    else if (argv[index] === '--candidate') candidateInput = argv[++index] || ''
    else throw new Error(`unknown argument ${argv[index]}`)
  }
  if (!packageInput) throw new Error('--package must name the packaged app, app.asar, or root')
  if (!/^[a-f0-9]{40}$/i.test(candidateInput)) {
    throw new Error('--candidate must be one full 40-character Git commit')
  }
  return { evidencePath, packageInput, candidateInput }
}

function exactCandidate(input) {
  const candidateCommit = execFileSync('git', ['rev-parse', `${input}^{commit}`], {
    cwd: ROOT,
    encoding: 'utf8'
  }).trim()
  const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8'
  }).trim()
  assertProof(candidateCommit === headCommit, 'enabled candidate must be exact current HEAD')
  for (const args of [
    ['diff', '--quiet'],
    ['diff', '--cached', '--quiet']
  ]) {
    const clean = spawnSync('git', args, { cwd: ROOT })
    assertProof(clean.status === 0, 'enabled candidate has tracked working-tree or index changes')
  }
  const tree = execFileSync('git', ['rev-parse', `${candidateCommit}^{tree}`], {
    cwd: ROOT,
    encoding: 'utf8'
  }).trim()
  const committedAtSeconds = Number(
    execFileSync('git', ['show', '-s', '--format=%ct', candidateCommit], {
      cwd: ROOT,
      encoding: 'utf8'
    }).trim()
  )
  assertProof(Number.isSafeInteger(committedAtSeconds), 'candidate commit time is invalid')
  return { candidateCommit, tree, committedAtSeconds }
}

function isProtectedBoundaryPath(file) {
  return (
    /^src\/shared\/collaboration\/ChannelAgent/.test(file) ||
    /^src\/main\/collaboration\/ChannelAgent/.test(file) ||
    /^src\/main\/collaboration\/ChannelProduction/.test(file) ||
    /^src\/main\/ipc\/channelAgentHandlers/.test(file) ||
    /^src\/preload\/channelAgentIpcBridge/.test(file) ||
    /^src\/renderer\/src\/lib\/channelAgentManagementModel/.test(file) ||
    /^src\/renderer\/src\/components\/Channel(?:Agent|Host|Member)/.test(file) ||
    /^scripts\/channels-p[23]-/.test(file) ||
    /^docs\/channels-p3-/.test(file) ||
    file === 'src/main/services/ComposerService.ts' ||
    file === 'src/main/RunEventBus.ts' ||
    file === 'src/main/RunManager.ts' ||
    file === 'src/main/run/AgentRunTypes.ts'
  )
}

function changedCodeLines(diff) {
  return diff
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('+++') &&
        !line.startsWith('---')
    )
}

function verifyProtectedChanges(changedFiles, rootDiffs = {}) {
  const unexpected = changedFiles
    .filter(isProtectedBoundaryPath)
    .filter((file) => !ALLOWED_PROTECTED_CHANGES.has(file))
    .sort()
  assertProof(
    unexpected.length === 0,
    `protected review boundary changed outside the enable transition: ${unexpected.join(', ')}`
  )
  const rootChannelLines = []
  for (const [file, diff] of Object.entries(rootDiffs)) {
    for (const line of changedCodeLines(diff)) {
      if (/channel/i.test(line)) rootChannelLines.push(`${file}:${line}`)
    }
  }
  assertProof(
    rootChannelLines.length === 0,
    `composition-root Channel wiring changed after review: ${rootChannelLines.join(' | ')}`
  )
  const protectedChanges = changedFiles.filter(isProtectedBoundaryPath).sort()
  return {
    protectedChangeCount: protectedChanges.length,
    protectedChangesSha256: sha256(protectedChanges.join('\n')),
    rootDiffCount: Object.keys(rootDiffs).length,
    rootDiffSha256: sha256(
      Object.entries(rootDiffs)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([file, diff]) => `${file}\0${sha256(diff)}`)
        .join('\n')
    )
  }
}

function blobId(commit, file) {
  return execFileSync('git', ['rev-parse', `${commit}:${file}`], {
    cwd: ROOT,
    encoding: 'utf8'
  }).trim()
}

function verifyProtectedBoundary(candidateCommit) {
  const changedFiles = execFileSync(
    'git',
    ['diff', '--name-only', ACCEPTED_CANDIDATE, candidateCommit],
    { cwd: ROOT, encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean)
  const rootDiffs = Object.fromEntries(
    COMPOSITION_ROOTS.map((file) => [
      file,
      execFileSync(
        'git',
        ['diff', '--unified=0', ACCEPTED_CANDIDATE, candidateCommit, '--', file],
        { cwd: ROOT, encoding: 'utf8' }
      )
    ])
  )
  const summary = verifyProtectedChanges(changedFiles, rootDiffs)
  for (const [file, expectedCommit] of PROTECTED_BLOB_PINS) {
    assertProof(
      blobId(candidateCommit, file) === blobId(expectedCommit, file),
      `protected boundary file changed after ${expectedCommit}: ${file}`
    )
  }
  for (const file of [
    'docs/channels-p3-adversarial-review.md',
    'docs/channels-p3-security-design.md'
  ]) {
    assertProof(
      blobId(candidateCommit, file) === blobId(ACCEPTANCE_COMMIT, file),
      `accepted review record changed after ${ACCEPTANCE_COMMIT}: ${file}`
    )
  }
  return {
    ...summary,
    reviewedFrom: ACCEPTED_CANDIDATE,
    acceptanceCommit: ACCEPTANCE_COMMIT,
    enableCommit: ENABLE_COMMIT,
    packageProvenanceCommit: PACKAGE_PROVENANCE_COMMIT,
    fleetWorktreeSourceCommit: FLEET_WORKTREE_SOURCE_COMMIT,
    changedFileCount: changedFiles.length,
    changedFilesSha256: sha256(changedFiles.sort().join('\n')),
    pinnedEnableFileCount: ENABLE_TRANSITION_FILES.length,
    pinnedPostAcceptanceFileCount: POST_ACCEPTANCE_PROTECTED_PINS.size,
    pinnedProtectedFileCount: PROTECTED_BLOB_PINS.size
  }
}

function verifyPackagedGroups(groups) {
  const summary = {}
  for (const group of Object.keys(PACKAGED_REQUIRED_MARKERS)) {
    const files = groups[group]
    assertProof(Array.isArray(files) && files.length > 0, `packaged ${group} bundle is missing`)
    const combined = files
      .map((file) =>
        Buffer.isBuffer(file.contents) ? file.contents.toString('utf8') : String(file.contents)
      )
      .join('\n')
    const required = PACKAGED_REQUIRED_MARKERS[group]
    const missing = required.filter((marker) => !combined.includes(marker))
    assertProof(missing.length === 0, `packaged ${group} is stale: ${missing.join(', ')}`)
    const forbiddenMarkers = [
      ...PACKAGED_FORBIDDEN_MARKERS.all,
      ...(PACKAGED_FORBIDDEN_MARKERS[group] || [])
    ]
    const forbidden = forbiddenMarkers.filter((marker) => combined.includes(marker))
    assertProof(
      forbidden.length === 0,
      `packaged ${group} exposes forbidden markers: ${forbidden.join(', ')}`
    )
    const entries = files
      .map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.contents),
        sha256: sha256(file.contents)
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
    summary[group] = {
      fileCount: entries.length,
      bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      digest: sha256(entries.map((entry) => `${entry.path}:${entry.sha256}`).join('\n')),
      requiredMarkerCount: required.length,
      requiredMarkersSha256: sha256(required.join('\n')),
      forbiddenMarkerCount: forbiddenMarkers.length,
      forbiddenMarkersSha256: sha256(forbiddenMarkers.join('\n'))
    }
  }
  return summary
}

function findAppAsars(root, found = []) {
  const stat = lstatSync(root)
  if (stat.isSymbolicLink()) return found
  if (stat.isFile()) {
    if (basename(root) === 'app.asar') found.push(root)
    return found
  }
  if (!stat.isDirectory()) return found
  for (const entry of readdirSync(root)) findAppAsars(join(root, entry), found)
  return found
}

function resolveAppAsar(packageInput) {
  assertProof(existsSync(packageInput), `package path does not exist: ${packageInput}`)
  if (statSync(packageInput).isFile()) {
    assertProof(basename(packageInput) === 'app.asar', 'package file must be app.asar')
    return packageInput
  }
  const direct = packageInput.endsWith('.app')
    ? join(packageInput, 'Contents', 'Resources', 'app.asar')
    : join(packageInput, 'resources', 'app.asar')
  if (existsSync(direct)) return direct
  const candidates = findAppAsars(packageInput)
  assertProof(
    candidates.length === 1,
    `expected one app.asar below package path, found ${candidates.length}`
  )
  return candidates[0]
}

function scanPackagedGate(packageInput, candidateCommitSeconds) {
  const appAsarPath = resolveAppAsar(packageInput)
  const archive = readFileSync(appAsarPath)
  const archiveStat = statSync(appAsarPath)
  assertProof(
    archiveStat.mtimeMs >= candidateCommitSeconds * 1_000,
    'packaged app predates the enabled candidate commit'
  )
  const paths = asar.listPackage(appAsarPath)
  const readGroup = (prefix) =>
    paths
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.js'))
      .map((entry) => ({
        path: entry.slice(1),
        contents: asar.extractFile(appAsarPath, entry.slice(1))
      }))
  return {
    artifact: relative(ROOT, appAsarPath) || basename(appAsarPath),
    builtAt: new Date(archiveStat.mtimeMs).toISOString(),
    bytes: archive.length,
    sha256: sha256(archive),
    groups: verifyPackagedGroups({
      main: readGroup('/out/main/'),
      preload: readGroup('/out/preload/'),
      renderer: readGroup('/out/renderer/assets/')
    })
  }
}

function runMission(workRoot) {
  const workerBundle = join(workRoot, 'channels-p3-enabled-proof-worker.cjs')
  esbuild.buildSync({
    entryPoints: [join(ROOT, 'scripts', 'channels-p3-enabled-proof-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    outfile: workerBundle,
    sourcemap: false,
    logLevel: 'warning'
  })
  const profile = join(workRoot, 'profile')
  mkdirSync(profile, { recursive: true })
  const result = spawnSync(process.execPath, [workerBundle], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHANNELS_P3_ENABLED_PROOF_PROFILE: profile,
      NODE_PATH: join(ROOT, 'node_modules')
    },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024
  })
  assertProof(!result.error, `enabled mission failed to start: ${result.error?.message}`)
  assertProof(
    result.status === 0,
    `enabled mission failed: ${(result.stderr || result.stdout).slice(0, 4_000)}`
  )
  let mission
  try {
    mission = JSON.parse(result.stdout.trim())
  } catch {
    throw new Error(`P3 enabled proof assertion failed: mission returned invalid JSON`)
  }
  assertProof(mission.status === 'passed', 'enabled mission did not pass')
  assertProof(mission.reviewId === REVIEW_ID, 'enabled mission changed review identity')
  assertProof(
    mission.acceptedCandidate === ACCEPTED_CANDIDATE,
    'mission changed accepted candidate'
  )
  assertProof(mission.acceptanceCommit === ACCEPTANCE_COMMIT, 'mission changed acceptance commit')
  assertProof(mission.provider === 'muse', 'enabled mission did not preserve the Muse route')
  assertProof(mission.dispatchCount === 1, 'mission did not dispatch exactly once')
  assertProof(mission.finalHighWaterSequence === 2, 'mission did not persist exactly two records')
  assertProof(mission.assertionCount === 14, 'mission assertion count changed')
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
  for (const forbidden of [
    '/Users/',
    '/private/var/',
    'CHANNELS_P3_ENABLED_SIGNED_REPLY_OK',
    'privateKeyDerB64',
    'run the enabled P3 proof'
  ]) {
    assertProof(
      !serialized.includes(forbidden),
      `evidence contains forbidden material ${forbidden}`
    )
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${serialized}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
  assertProof((statSync(path).mode & 0o777) === 0o600, 'enabled evidence is not mode 0600')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const candidate = exactCandidate(options.candidateInput)
  const boundaryAudit = verifyProtectedBoundary(candidate.candidateCommit)
  const packageSurface = scanPackagedGate(options.packageInput, candidate.committedAtSeconds)
  const workRoot = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p3-enabled-proof-'))
  try {
    const productionMission = runMission(workRoot)
    const evidence = {
      schemaVersion: 1,
      proof: 'Channels P3 enabled exact-package production dispatch and signed-post mission',
      status: 'passed',
      generatedAt: new Date().toISOString(),
      platform: { platform: process.platform, arch: process.arch, node: process.version },
      candidate: {
        commit: candidate.candidateCommit,
        tree: candidate.tree,
        reviewedFrom: ACCEPTED_CANDIDATE,
        acceptanceCommit: ACCEPTANCE_COMMIT,
        enableCommit: ENABLE_COMMIT,
        packageProvenanceCommit: PACKAGE_PROVENANCE_COMMIT,
        fleetWorktreeSourceCommit: FLEET_WORKTREE_SOURCE_COMMIT
      },
      boundaryAudit,
      packageSurface,
      productionMission
    }
    writePrivateEvidence(options.evidencePath, evidence)
    process.stdout.write(
      `${JSON.stringify(
        {
          status: evidence.status,
          candidate: candidate.candidateCommit,
          packageSha256: packageSurface.sha256,
          dispatchCount: productionMission.mission.dispatchCount,
          signedProofVerified: productionMission.mission.assertions.publicMessageProofVerified,
          restartVerified: productionMission.mission.assertions.signedPostSurvivedRestart,
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
  ACCEPTANCE_COMMIT,
  ACCEPTED_CANDIDATE,
  ENABLE_COMMIT,
  FLEET_WORKTREE_SOURCE_COMMIT,
  PACKAGED_FORBIDDEN_MARKERS,
  PACKAGED_REQUIRED_MARKERS,
  PACKAGE_PROVENANCE_COMMIT,
  parseArgs,
  runMission,
  verifyPackagedGroups,
  verifyProtectedChanges
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${String(error.stack || error.message || error)}\n`)
    process.exitCode = 1
  })
}
