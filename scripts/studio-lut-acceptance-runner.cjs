'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { PNG } = require('pngjs')
const speechFixture = require('./studio-generate-speech-fixture.cjs')

const repoRoot = path.resolve(__dirname, '..')
const acceptanceRoot = path.join(repoRoot, '.local-only', 'taskwraith-studio', 'acceptance')
const requiredProductAncestor = '372b1bd54387f88e1bb417f0fd247a9f077899f9'
const expectedCompanionSha256 = '0e078cf777cd2040f87cd7d1541dfb96748626dd51b7582e089155cb91968309'
const expectedSourceDigest = '061f9a3acbeb300cfb86ba8671268f91a4388663690452fb349b85a4f5d3bf56'
const expectedSourceCount = 71
const expectedOutDigest = 'a887c8e3aa5d5d164db474fe70dc1acbb125acc639cc7c6b3067e0a6dbf958d0'
const expectedOutCount = 38
const expectedValidCubeSha256 = 'cba0938400fb53b07606fb8c8718b20b0c8613f775d8e2b148b4d6c072f8f5c7'
const expectedInvalidCubeSha256 = '984b585b670394bb49a9b0f3688d36d53e76a6627071bf9da78bc0949e1363a7'
const VALID_CUBE_CONTENT =
  'TITLE "Acceptance Red"\n' + 'LUT_3D_SIZE 2\n' + '1.0 0.0 0.0\n'.repeat(8)
const INVALID_CUBE_CONTENT = 'TITLE "Acceptance Invalid"\n' + 'LUT_3D_SIZE 2\n' + '0.0 0.0\n'
const expectedSupportHashes = Object.freeze({
  'scripts/studio-acceptance-harness.cjs':
    'e76a73f4e16f75c7ae8ec97e41c88706eddbf2c64052d384e9e025e46ec759b7',
  'scripts/studio-acceptance-ui-driver.swift':
    'ce92e7858a9e0127b55a3f3cdb05acbaf3ae69fb9b3a4476411cd4f0c5543642',
  'scripts/studio-acceptance-watchdog.cjs':
    'c68429a807ca03465e076e8dd609283ef21937fac1e86aa23177e0972bbd3a8e',
  'scripts/studio-acceptance-window-probe.swift':
    'fb6b385479e33883e2dab7b74c3308459d7aa6e6ba46f861e6b353b3b2963154',
  'scripts/studio-pixel-evidence-verifier.cjs':
    'bb7b2d5161066926f7d5dd457c49096997e246cc841a324b4ad25d1dd5e2244a',
  'scripts/studio-hud-ocr.swift':
    'd3f1a7efc1189357252932518ed7d0b7ba799b19a3c68d9a32f134b076111a52',
  'scripts/studio-input-isolation-snapshot.swift':
    '9b2afd9ff163e7c10e42ebdb1beb41693a025c24894c13c82b23d5bbef61a55a',
  'scripts/studio-generate-speech-fixture.cjs':
    '734c336b46aac7ebe3748144216514dfbd49c1206962055c703f79a063936e4f',
  'scripts/studio-acceptance-session.cjs':
    '9aced4b6f6143cb50802f074fadab62fb0ac9d3336e8169b0b5e27708283f79d',
  'scripts/studio-bounded-diagnostics-runner.cjs':
    '9b1b59898a6708864c5e4ffdf28f9c930a94992303c0537b3dcf22869ab67266',
  'scripts/studio-bounded-lifecycle-runner.cjs':
    'f5c7a7c4c5b59d7f1fbbf93ed2319e92555eb55f84a5fe17af58f4fed77f7d8c',
  'scripts/studio-av-endurance-runner.cjs':
    'bb72914c8750fc27ea984bda21b1a62aedb7e3854e9a64f7e57745e162caa578',
  'scripts/studio-av-endurance-acceptance-runner.cjs':
    'fc18cffa691f5aaa2518db2d307c6800ccc936905fdb8adaeddfc17bb4ec5be7',
  'scripts/studio-av-endurance-live-runner.cjs':
    '015e519ae5f58f4c15c70ea485fc0e0925e4ed6695bdb3934076b5225762d7d1',
  'scripts/perf/cdpWebSocketSession.cjs':
    '8a1842735b17424e71e0edf29908a3be99d8b453814d5c14644a3bc5134b5f01',
  'scripts/perf/electronChildSession.cjs':
    '9d62485e7df55c812d09c61117162fdaa8ce58a26dfad53acc07da773f312d9f'
})
const ocrScriptPath = path.join(repoRoot, 'scripts', 'studio-hud-ocr.swift')
const focusScriptPath = path.join(repoRoot, 'scripts', 'studio-input-isolation-snapshot.swift')
const companionPath = path.join(
  repoRoot,
  'swift',
  'TaskWraithBridge',
  '.build',
  'debug',
  'TaskWraithStudioCompanion'
)
const runnerPath = __filename
// The launch runner plus every pinned support script must be committed;
// unrelated tracked dirt is recorded separately and cannot alter the pinned artifact.
const studioCustodyScriptPaths = Object.freeze([
  // Git reports paths with forward slashes on every platform, and the other
  // entries below are forward-slash literals. path.relative() yields
  // backslashes on Windows, so without normalising, the runner fails to
  // recognise its own file as protected and tracked dirt in it is misclassified
  // as foreign instead of blocking the run.
  path.relative(repoRoot, runnerPath).split(path.sep).join('/'),
  ...Object.keys(expectedSupportHashes).filter((relativePath) =>
    relativePath.startsWith('scripts/studio-')
  )
])
const studioSwiftProductSourcePrefix = 'swift/TaskWraithBridge/Sources/'
const expectedCustodyPins = Object.freeze({
  companionSha256: expectedCompanionSha256,
  sourceDigest: expectedSourceDigest,
  sourceCount: expectedSourceCount,
  outDigest: expectedOutDigest,
  outCount: expectedOutCount
})
const harness = require(path.join(repoRoot, 'scripts', 'studio-acceptance-harness.cjs'))
const { DEFAULT_STUDIO_OVERLAY_EXCLUSION_POINTS, compareWindowCaptureToReference } = require(
  path.join(repoRoot, 'scripts', 'studio-pixel-evidence-verifier.cjs')
)
const { attachMainInspectorSession, attachRendererCdpSession, discoverMainInspectorUrl } = require(
  path.join(repoRoot, 'scripts', 'perf', 'cdpWebSocketSession.cjs')
)
const { assertExactChildOwnsDebugPorts } = require(
  path.join(repoRoot, 'scripts', 'perf', 'electronChildSession.cjs')
)

const JOURNEY_PHASES = Object.freeze([
  'phase-1-neutral-load-invalid-retention',
  'phase-2-restart-replay-clear'
])
const PHASE_PORTS = Object.freeze([
  Object.freeze({ remoteDebuggingPort: 9510, mainInspectorPort: 9910 }),
  Object.freeze({ remoteDebuggingPort: 9511, mainInspectorPort: 9911 })
])
const LUT_PHASE_TIMEOUT_MS = 600_000
const DOM_STATE_EXPRESSION = `(() => {
  const root = document.querySelector('.studio-lut-control');
  if (!root) return null;
  const label = root.querySelector('.studio-lut-label');
  const load = root.querySelector('.studio-lut-load');
  const clear = root.querySelector('.studio-lut-clear');
  const error = root.querySelector('.studio-lut-error');
  return {
    active: root.getAttribute('data-lut-active'),
    label: label?.textContent?.trim() || null,
    loadText: load?.textContent?.trim() || null,
    clearText: clear?.textContent?.trim() || null,
    loadDisabled: Boolean(load?.disabled),
    clearDisabled: Boolean(clear?.disabled),
    error: error?.textContent?.trim() || null
  };
})()`

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath))
}

function jsonDigest(value) {
  return sha256Bytes(JSON.stringify(value))
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function runExact(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
    maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
    env: options.env || process.env
  })
  if (result.error || result.status !== 0) {
    throw (
      result.error ||
      new Error(
        `${command} exited ${String(result.status)}: ${String(result.stderr || result.stdout)}`
      )
    )
  }
  return {
    command: [command, ...args],
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  }
}

function resolveMediaTool(name) {
  const candidates = [
    path.join('/opt', 'homebrew', 'bin', name),
    path.join('/usr', 'local', 'bin', name),
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, name))
  ]
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // Candidate absent; keep the search bounded to this explicit list.
    }
  }
  throw new Error(`Studio LUT acceptance could not resolve ${name}`)
}

async function materializePortableInputs(artifactRoot, adapters = {}) {
  const inputRoot = path.join(artifactRoot, 'inputs')
  await fsPromises.mkdir(inputRoot, { recursive: false, mode: 0o700 })
  const speechPath = path.join(inputRoot, 'acceptance-speech.aiff')
  const fixturePath = path.join(inputRoot, 'acceptance-speech-600s.mp4')
  const manifestPath = path.join(inputRoot, 'speech-fixture-manifest.json')
  const validCubePath = path.join(inputRoot, 'Acceptance-Red.cube')
  const invalidCubePath = path.join(inputRoot, 'Acceptance-Invalid.cube')
  const fixturePlan = speechFixture.describeFixturePlan()
  const sayCommand = speechFixture.buildSayCommand({ outputPath: speechPath })
  const muxPlan = speechFixture.buildMuxCommand({
    speechPath,
    outputPath: fixturePath,
    durationSeconds: fixturePlan.durationSeconds
  })
  const resolveTool = adapters.resolveMediaTool || resolveMediaTool
  const run = adapters.runExact || runExact
  const muxCommand = [resolveTool('ffmpeg'), ...muxPlan.slice(1)]

  run(sayCommand[0], sayCommand.slice(1), { timeout: 120_000 })
  run(muxCommand[0], muxCommand.slice(1), {
    timeout: 20 * 60 * 1_000,
    maxBuffer: 64 * 1024 * 1024
  })
  await fsPromises.writeFile(validCubePath, VALID_CUBE_CONTENT, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })
  await fsPromises.writeFile(invalidCubePath, INVALID_CUBE_CONTENT, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })

  for (const filePath of [speechPath, fixturePath, validCubePath, invalidCubePath]) {
    const stats = await fsPromises.lstat(filePath)
    invariant(
      stats.isFile() && !stats.isSymbolicLink() && stats.size > 0,
      'generated LUT input is not a safe regular file'
    )
    await fsPromises.chmod(filePath, 0o600)
  }

  const manifest = {
    schemaVersion: 1,
    kind: 'taskwraith-studio-generated-speech-fixture',
    durationSeconds: fixturePlan.durationSeconds,
    frameRate: fixturePlan.frameRate,
    expectedFrameCount: fixturePlan.expectedFrameCount,
    size: fixturePlan.size,
    speechText: fixturePlan.speechText,
    expectedPhrases: fixturePlan.expectedPhrases,
    provenanceNote: fixturePlan.provenanceNote,
    speechPath,
    outputPath: fixturePath,
    manifestPath,
    mimeType: 'video/mp4',
    speechSha256: sha256File(speechPath),
    outputSha256: sha256File(fixturePath),
    speechByteLength: fs.statSync(speechPath).size,
    outputByteLength: fs.statSync(fixturePath).size,
    sayCommand,
    muxCommand,
    sayExitCode: 0,
    muxExitCode: 0
  }
  const verification = speechFixture.verifyFixtureManifest(manifest)
  invariant(
    verification.ok,
    `generated LUT fixture manifest is invalid: ${verification.failures.join('; ')}`
  )
  await writeJson(manifestPath, manifest)

  const inputs = {
    fixturePath,
    fixtureSha256: manifest.outputSha256,
    fixtureAssetId: Buffer.from(manifest.outputSha256, 'hex').toString('base64url'),
    fixtureManifest: manifest,
    fixtureManifestPath: manifestPath,
    fixtureManifestSha256: sha256File(manifestPath),
    validCubePath,
    validCubeSha256: sha256File(validCubePath),
    invalidCubePath,
    invalidCubeSha256: sha256File(invalidCubePath)
  }
  invariant(
    inputs.validCubeSha256 === expectedValidCubeSha256 &&
      inputs.invalidCubeSha256 === expectedInvalidCubeSha256,
    'generated LUT fixture bytes changed'
  )
  return inputs
}

function parseCli(argv) {
  const parsed = {
    artifactRoot: null,
    launch: false,
    preflightOnly: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--artifact-root') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('--artifact-root requires one path')
      }
      parsed.artifactRoot = value
      index += 1
    } else if (argument === '--launch') {
      parsed.launch = true
    } else if (argument === '--preflight-only') {
      parsed.preflightOnly = true
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  if (!parsed.artifactRoot) {
    throw new Error('--artifact-root is required')
  }
  if (parsed.launch && parsed.preflightOnly) {
    throw new Error('--launch and --preflight-only are mutually exclusive')
  }
  return parsed
}

function resolveArtifactRoot(candidate, baseRoot = acceptanceRoot) {
  const resolvedBase = path.resolve(baseRoot)
  const resolvedCandidate = path.resolve(candidate)
  const relative = path.relative(resolvedBase, resolvedCandidate)
  if (!relative || relative === '.') {
    throw new Error('artifact root must be a proper child of the Studio acceptance root')
  }
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('artifact root must remain inside the Studio acceptance root')
  }
  if (fs.existsSync(resolvedCandidate)) {
    throw new Error('artifact root must not already exist')
  }
  const realBase = fs.realpathSync(resolvedBase)
  const realParent = fs.realpathSync(path.dirname(resolvedCandidate))
  const realRelative = path.relative(realBase, realParent)
  invariant(
    !realRelative || (!realRelative.startsWith('..' + path.sep) && !path.isAbsolute(realRelative)),
    'artifact root parent resolves outside the Studio acceptance root'
  )
  return resolvedCandidate
}

function buildObservationRequest(name) {
  invariant(
    typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name),
    'screenshot name is invalid'
  )
  return {
    inputDelivery: 'background-observation-only',
    allowForegroundInput: false,
    actions: [{ type: 'screenshot', name }]
  }
}

function assertObservationOnlyRequest(request) {
  const valid =
    request?.inputDelivery === 'background-observation-only' &&
    request?.allowForegroundInput === false &&
    Array.isArray(request?.actions) &&
    request.actions.length === 1 &&
    request.actions[0]?.type === 'screenshot' &&
    typeof request.actions[0]?.name === 'string'
  if (!valid) {
    throw new Error('native driver request must be one background-observation-only screenshot')
  }
  return request
}

const DRIVER_EVIDENCE_PATH_MAX_CHARACTERS = 4096
const DRIVER_FAILURE_STAGE = /^[a-z][a-z0-9-]{0,63}$/

let latestTransportMutationBracket = null
let latestCustody = null

function boundedAbsoluteEvidencePath(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DRIVER_EVIDENCE_PATH_MAX_CHARACTERS &&
    path.isAbsolute(value)
    ? value
    : null
}

function studioUiDriverEvidenceDescriptor(value, fallbackFailureStage = null) {
  const source =
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.studioUiDriverEvidence &&
    typeof value.studioUiDriverEvidence === 'object' &&
    !Array.isArray(value.studioUiDriverEvidence)
      ? value.studioUiDriverEvidence
      : value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {}
  const rawStdoutByteLength =
    Number.isSafeInteger(source.rawStdoutByteLength) && source.rawStdoutByteLength >= 0
      ? source.rawStdoutByteLength
      : null
  const rawStdoutSha256 =
    typeof source.rawStdoutSha256 === 'string' && /^[a-f0-9]{64}$/.test(source.rawStdoutSha256)
      ? source.rawStdoutSha256
      : null
  const suppliedFailureStage =
    typeof source.failureStage === 'string' && DRIVER_FAILURE_STAGE.test(source.failureStage)
      ? source.failureStage
      : null
  const boundedFallbackStage =
    typeof fallbackFailureStage === 'string' && DRIVER_FAILURE_STAGE.test(fallbackFailureStage)
      ? fallbackFailureStage
      : null
  return {
    requestPath: boundedAbsoluteEvidencePath(source.requestPath),
    rawReceiptPath: boundedAbsoluteEvidencePath(source.rawReceiptPath),
    rawStdoutSha256,
    rawStdoutByteLength,
    validatedReceiptPath: boundedAbsoluteEvidencePath(
      source.validatedReceiptPath ?? source.receiptPath
    ),
    failureStage: suppliedFailureStage ?? boundedFallbackStage
  }
}

function normalizeTransportMutationReceipt(receipt) {
  const action = Array.isArray(receipt?.actions) ? receipt.actions[0] : null
  const evidence = studioUiDriverEvidenceDescriptor(receipt)
  const valid =
    receipt?.inputDelivery === 'background-observation-only' &&
    receipt?.allowForegroundInput !== true &&
    Array.isArray(receipt?.actions) &&
    receipt.actions.length === 1 &&
    action?.index === 0 &&
    action?.type === 'read-transport-mutation' &&
    action?.accessibilityLabel === 'Transport mutation detail' &&
    action?.accessibilityRole === 'AXStaticText' &&
    action?.accessibilityMatchCount === 1 &&
    typeof action?.accessibilityValue === 'string' &&
    evidence.requestPath !== null &&
    evidence.rawReceiptPath !== null &&
    evidence.rawStdoutSha256 !== null &&
    evidence.rawStdoutByteLength !== null &&
    evidence.validatedReceiptPath !== null &&
    evidence.failureStage === null
  invariant(valid, 'native transport-mutation receipt is missing or mismatched')
  const parsedValue = harness.parseStudioTransportMutationText(action.accessibilityValue)
  return {
    requestPath: evidence.requestPath,
    rawReceiptPath: evidence.rawReceiptPath,
    rawStdoutSha256: evidence.rawStdoutSha256,
    rawStdoutByteLength: evidence.rawStdoutByteLength,
    receiptPath: evidence.validatedReceiptPath,
    rawValue: action.accessibilityValue,
    parsedValue
  }
}

function validateTransportMutationBracket(beforeReceipt, afterReceipt, name = 'native-sample') {
  invariant(typeof name === 'string' && name.length > 0, 'tm1 bracket name is invalid')
  const before = normalizeTransportMutationReceipt(beforeReceipt)
  const after = normalizeTransportMutationReceipt(afterReceipt)
  invariant(
    before.rawValue === after.rawValue &&
      JSON.stringify(before.parsedValue) === JSON.stringify(after.parsedValue),
    `${name} tm1 changed during native screenshot`
  )
  return {
    ok: true,
    name,
    stage: 'complete',
    rawValueSha256: sha256Bytes(before.rawValue),
    before,
    after,
    failure: null
  }
}

async function readTransportMutation(plan, target, runStudioUiDriver = harness.runStudioUiDriver) {
  return runStudioUiDriver(plan, target, [{ type: 'read-transport-mutation' }])
}

function collectRegularFiles(directory) {
  const pending = [directory]
  const files = []
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(entryPath)
      else if (entry.isFile()) files.push(entryPath)
      // Skip non-regular entries (sockets, fifos, symlinks) rather than
      // crashing artifact collection; custody directories are regular-only.
    }
  }
  return files.sort()
}

function treeDigest(directory, options = {}) {
  const entries = collectRegularFiles(directory)
    .filter((filePath) => path.basename(filePath) !== '.DS_Store')
    .filter((filePath) => {
      if (options.excludeTui !== true) return true
      return !path.relative(directory, filePath).split(path.sep).join('/').startsWith('tui/')
    })
    .map((filePath) => ({
      path: path.relative(repoRoot, filePath),
      sha256: sha256File(filePath)
    }))
  return {
    fileCount: entries.length,
    digest: jsonDigest(entries)
  }
}

function assertPortFree(port) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
    timeout: 5_000
  })
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw result.error || new Error(`port preflight failed: ${String(port)}`)
  }
  if (result.status === 0 && result.stdout.trim()) {
    throw new Error(`acceptance port is already owned: ${String(port)}`)
  }
}

function consoleSessionState() {
  const result = runExact('/usr/sbin/ioreg', ['-n', 'Root', '-d', '1', '-l'], {
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const screenLocked = /"CGSSessionScreenIsLocked"=Yes/.test(result.stdout)
  const onConsole = /"kCGSSessionOnConsoleKey"=Yes/.test(result.stdout)
  const loginDone = /"kCGSessionLoginDoneKey"=Yes/.test(result.stdout)
  return {
    recordedAt: new Date().toISOString(),
    screenLocked,
    onConsole,
    loginDone,
    windowServerEvidenceAvailable: onConsole && loginDone && !screenLocked,
    receipt: {
      command: result.command,
      stdoutSha256: sha256Bytes(result.stdout),
      exitCode: result.exitCode
    }
  }
}

function assertUnlocked(label, state = consoleSessionState()) {
  if (!state.windowServerEvidenceAvailable) {
    throw new Error(`WindowServer unavailable at ${label}: ${JSON.stringify(state)}`)
  }
  return state
}

function parseTrackedStatus(trackedStatus) {
  invariant(typeof trackedStatus === 'string', 'tracked Git status receipt is invalid')
  if (trackedStatus.length > 0) {
    invariant(trackedStatus.endsWith('\0'), 'tracked Git status receipt is not NUL terminated')
  }
  const fields = trackedStatus.split('\0')
  fields.pop()
  const entries = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    invariant(
      field.length >= 4 && field[2] === ' ',
      'tracked Git status receipt has an invalid entry'
    )
    const status = field.slice(0, 2)
    const relativePath = field.slice(3)
    invariant(relativePath.length > 0, 'tracked Git status receipt has an empty path')
    let originalPath = null
    if (/[RC]/.test(status)) {
      index += 1
      invariant(index < fields.length && fields[index].length > 0, 'tracked rename is incomplete')
      originalPath = fields[index]
    }
    entries.push({ status, path: relativePath, originalPath })
  }
  return entries
}

function trackedPathSha256(relativePath) {
  const absolutePath = path.resolve(repoRoot, relativePath)
  invariant(
    absolutePath.startsWith(repoRoot + path.sep),
    'tracked dirty path escaped the workspace'
  )
  let stats
  try {
    stats = fs.lstatSync(absolutePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (stats.isSymbolicLink()) {
    return sha256Bytes(fs.readlinkSync(absolutePath))
  }
  invariant(stats.isFile(), 'tracked dirty path is not a regular file')
  return sha256File(absolutePath)
}

function isStudioCustodyPath(relativePath) {
  return (
    studioCustodyScriptPaths.includes(relativePath) ||
    relativePath.startsWith(studioSwiftProductSourcePrefix)
  )
}

function classifyTrackedDirt(trackedStatus, digestPath = trackedPathSha256) {
  const entries = parseTrackedStatus(trackedStatus).map((entry) => {
    const worktreeSha256 = digestPath(entry.path)
    invariant(
      worktreeSha256 === null || /^[a-f0-9]{64}$/.test(worktreeSha256),
      'tracked dirty path hash is invalid'
    )
    return { ...entry, worktreeSha256 }
  })
  const studioTrackedDirt = []
  const foreignTrackedDirt = []
  for (const entry of entries) {
    const studioPath =
      isStudioCustodyPath(entry.path) ||
      (entry.originalPath !== null && isStudioCustodyPath(entry.originalPath))
    if (studioPath) {
      studioTrackedDirt.push(entry)
    } else {
      foreignTrackedDirt.push(entry)
    }
  }
  return {
    wholeTrackedTreeClean: entries.length === 0,
    studioPathsClean: studioTrackedDirt.length === 0,
    studioTrackedDirt,
    foreignTrackedDirt
  }
}

function custodyMatches(actual, expected = expectedCustodyPins) {
  const inputFields = ['fixtureSha256', 'validCubeSha256', 'invalidCubeSha256']
  return (
    actual.productAncestorPresent &&
    actual.studioPathsClean &&
    actual.companionSha256 === expected.companionSha256 &&
    actual.sourceDigest === expected.sourceDigest &&
    actual.sourceCount === expected.sourceCount &&
    actual.outDigest === expected.outDigest &&
    actual.outCount === expected.outCount &&
    inputFields.every(
      (field) => expected[field] === undefined || actual[field] === expected[field]
    ) &&
    actual.supportMatches
  )
}

function assertCustody(inputs = null) {
  const head = runExact('git', ['rev-parse', 'HEAD']).stdout.trim()
  const ancestor = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', requiredProductAncestor, head],
    { cwd: repoRoot, encoding: 'utf8', timeout: 5_000 }
  )
  const trackedStatus = runExact('git', [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=no'
  ]).stdout
  const trackedDirt = classifyTrackedDirt(trackedStatus)
  const sources = treeDigest(path.join(repoRoot, 'swift', 'TaskWraithBridge', 'Sources'))
  const out = treeDigest(path.join(repoRoot, 'out'), { excludeTui: true })
  const support = Object.fromEntries(
    Object.entries(expectedSupportHashes).map(([relativePath]) => [
      relativePath,
      sha256File(path.join(repoRoot, relativePath))
    ])
  )
  const supportMatches = Object.entries(expectedSupportHashes).every(
    ([relativePath, expected]) => support[relativePath] === expected
  )
  const actual = {
    head,
    requiredProductAncestor,
    productAncestorPresent: ancestor.status === 0,
    studioPathScope: {
      scriptPaths: studioCustodyScriptPaths,
      swiftProductSourcePrefix: studioSwiftProductSourcePrefix
    },
    ...trackedDirt,
    companionSha256: sha256File(companionPath),
    sourceDigest: sources.digest,
    sourceCount: sources.fileCount,
    outDigest: out.digest,
    outCount: out.fileCount,
    fixturePath: inputs?.fixturePath || null,
    fixtureSha256: inputs ? sha256File(inputs.fixturePath) : null,
    validCubePath: inputs?.validCubePath || null,
    validCubeSha256: inputs ? sha256File(inputs.validCubePath) : null,
    invalidCubePath: inputs?.invalidCubePath || null,
    invalidCubeSha256: inputs ? sha256File(inputs.invalidCubePath) : null,
    support,
    supportMatches,
    runnerPath: path.relative(repoRoot, runnerPath),
    runnerSha256: sha256File(runnerPath)
  }
  const expected = inputs
    ? {
        ...expectedCustodyPins,
        fixtureSha256: inputs.fixtureSha256,
        validCubeSha256: inputs.validCubeSha256,
        invalidCubeSha256: inputs.invalidCubeSha256
      }
    : expectedCustodyPins
  invariant(
    custodyMatches(actual, expected),
    `LUT acceptance custody mismatch: ${JSON.stringify(actual)}`
  )
  for (const ports of PHASE_PORTS) {
    assertPortFree(ports.remoteDebuggingPort)
    assertPortFree(ports.mainInspectorPort)
  }
  latestCustody = actual
  return actual
}

function createSyntheticRedReference({ destination, width, height }) {
  invariant(
    Number.isInteger(width) &&
      Number.isInteger(height) &&
      width > 0 &&
      height > 0 &&
      Math.abs(width / height - 16 / 9) < 0.001,
    'synthetic red reference must have a positive 16:9 shape'
  )
  const image = new PNG({ width, height })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const phase = (x * 17 + y * 31) % 4
      image.data[offset] = 252 + phase
      image.data[offset + 1] = phase % 2
      image.data[offset + 2] = Math.floor(phase / 2)
      image.data[offset + 3] = 255
    }
  }
  fs.mkdirSync(path.dirname(destination), {
    recursive: true,
    mode: 0o700
  })
  fs.writeFileSync(destination, PNG.sync.write(image), { mode: 0o600 })
  return {
    path: destination,
    width,
    height,
    byteLength: fs.statSync(destination).size,
    sha256: sha256File(destination),
    purpose:
      'near-pure-red variance carrier for the registered comparator; absolute color is gated separately'
  }
}

function absoluteRedMetrics(capturePath, registration) {
  const capture = PNG.sync.read(fs.readFileSync(capturePath))
  const { captureX, captureY, videoWidth, comparisonHeight, materialPixelCount } = registration
  let redSum = 0
  let greenSum = 0
  let blueSum = 0
  let redDominantPixels = 0
  let maximumGreen = 0
  let maximumBlue = 0
  for (let y = 0; y < comparisonHeight; y += 1) {
    for (let x = 0; x < videoWidth; x += 1) {
      const offset = ((captureY + y) * capture.width + captureX + x) * 4
      const red = capture.data[offset]
      const green = capture.data[offset + 1]
      const blue = capture.data[offset + 2]
      redSum += red
      greenSum += green
      blueSum += blue
      maximumGreen = Math.max(maximumGreen, green)
      maximumBlue = Math.max(maximumBlue, blue)
      if (red >= 220 && green <= 35 && blue <= 35) {
        redDominantPixels += 1
      }
    }
  }
  const measuredPixelCount = videoWidth * comparisonHeight
  invariant(
    measuredPixelCount === materialPixelCount || materialPixelCount === undefined,
    'registered material pixel count disagrees with its dimensions'
  )
  const metrics = {
    materialPixelCount: measuredPixelCount,
    meanRed: redSum / measuredPixelCount,
    meanGreen: greenSum / measuredPixelCount,
    meanBlue: blueSum / measuredPixelCount,
    maximumGreen,
    maximumBlue,
    redDominantFraction: redDominantPixels / measuredPixelCount,
    thresholds: {
      minimumMeanRed: 240,
      maximumMeanGreen: 15,
      maximumMeanBlue: 15,
      minimumRedDominantFraction: 0.97
    }
  }
  return {
    ...metrics,
    clean:
      metrics.meanRed >= metrics.thresholds.minimumMeanRed &&
      metrics.meanGreen <= metrics.thresholds.maximumMeanGreen &&
      metrics.meanBlue <= metrics.thresholds.maximumMeanBlue &&
      metrics.redDominantFraction >= metrics.thresholds.minimumRedDominantFraction
  }
}

function evaluatePureRedCapture({
  capturePath,
  referencePath,
  windowBounds,
  hudOverlayHeight = DEFAULT_STUDIO_OVERLAY_EXCLUSION_POINTS,
  sourceHostFrame,
  compareWindowCaptureToReference: comparatorFn = compareWindowCaptureToReference
}) {
  const comparator = comparatorFn(capturePath, referencePath, windowBounds, {
    hudOverlayHeight,
    sourceHostFrame
  })
  const absolute = absoluteRedMetrics(capturePath, comparator.registration)
  return {
    clean: comparator.clean && absolute.clean,
    comparator,
    absolute
  }
}

function requiredSampleSourceHostFrame(sample, label) {
  invariant(
    sample?.workspaceObservation?.sourceHostFrame,
    `${label} sample is missing its exact Source host frame`
  )
  return sample.workspaceObservation.sourceHostFrame
}

function compareDecodedSample(sample, referencePath, windowBounds, label, comparator = compareWindowCaptureToReference) {
  const sourceHostFrame = requiredSampleSourceHostFrame(sample, label)
  return comparator(
    sample.capture.path,
    referencePath,
    windowBounds,
    { sourceHostFrame }
  )
}

function evaluatePureRedSample(
  sample,
  referencePath,
  windowBounds,
  label,
  options = {}
) {
  const sourceHostFrame = requiredSampleSourceHostFrame(sample, label)
  return evaluatePureRedCapture({
    capturePath: sample.capture.path,
    referencePath,
    windowBounds,
    sourceHostFrame,
    compareWindowCaptureToReference: options.compareWindowCaptureToReference
  })
}

function validateInvalidReplacement({
  activeState,
  stateAfterInvalid,
  journalBefore,
  journalAfter,
  rejectedDom
}) {
  const journalUnchanged = jsonDigest(journalBefore) === jsonDigest(journalAfter)
  invariant(
    stateAfterInvalid?.active === true &&
      stateAfterInvalid?.displayName === activeState?.displayName &&
      stateAfterInvalid?.effectId === activeState?.effectId,
    'invalid replacement changed active state'
  )
  invariant(journalUnchanged, 'invalid replacement changed effect-preview journal history')
  invariant(
    rejectedDom?.active === 'true' && /malformed|invalid/i.test(rejectedDom?.error || ''),
    'invalid replacement did not expose a visible refusal'
  )
  return { ok: true, journalUnchanged }
}

function validateReplayState(state, dom, expectedEffectId) {
  invariant(
    state?.active === true &&
      state?.displayName === 'Acceptance-Red.cube' &&
      state?.effectId === expectedEffectId &&
      dom?.active === 'true' &&
      dom?.label === 'LUT: Acceptance-Red.cube',
    `restart replay state mismatch: ${JSON.stringify({ state, dom })}`
  )
  return { ok: true, expectedEffectId }
}

function validateClearedState(state, operation, dom) {
  invariant(
    state?.active === false &&
      state?.displayName === null &&
      state?.effectId === null &&
      dom?.active === 'false' &&
      dom?.label === 'LUT: None',
    `clear state mismatch: ${JSON.stringify({ state, dom })}`
  )
  invariant(
    operation?.op?.type === 'set_effect_preview' && operation.op.effectPreview === null,
    'clear operation did not persist durable JSON null'
  )
  return { ok: true }
}

function validateTerminalReceipt(terminal) {
  const survivors = terminal?.survivors || []
  const detached = terminal?.detachedProcessGroups || []
  const protectedGroups = terminal?.protectedInstalledGroups || []
  invariant(
    terminal?.groupExitVerified === true &&
      terminal?.detachedGroupExitVerified === true &&
      survivors.length === 0 &&
      detached.length === 0 &&
      protectedGroups.length === 0,
    `terminal receipt is not clean: ${JSON.stringify(terminal)}`
  )
  return terminal
}

async function writeJson(filePath, value) {
  const temporary = `${filePath}.tmp-${String(process.pid)}`
  await fsPromises.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: 0o700
  })
  await fsPromises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  await fsPromises.rename(temporary, filePath)
}

async function waitFor(label, probe, timeoutMs = 30_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() <= deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(
    `${label} timed out${
      lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''
    }`
  )
}

async function evaluateMain(inspector, expression) {
  const response = await inspector.post('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (response?.exceptionDetails) {
    throw new Error(
      `main evaluation failed: ${JSON.stringify(response.exceptionDetails).slice(0, 1_000)}`
    )
  }
  return response?.result?.value
}

function mediaPaneExpression(asset) {
  const mediaRef = {
    id: 'studio-lut-acceptance-video',
    kind: 'video',
    name: 'Studio LUT acceptance source.mp4',
    sha256: asset.sha256,
    mimeType: asset.mimeType,
    byteLength: asset.byteLength
  }
  return `(() => {
    const mediaRef = ${JSON.stringify(mediaRef)};
    const roots = [];
    for (const element of document.querySelectorAll('*')) {
      const key = Object.keys(element).find(
        (candidate) =>
          candidate.startsWith('__reactFiber$') ||
          candidate.startsWith('__reactContainer$')
      );
      if (key && element[key]) {
        roots.push(element[key].current || element[key]);
      }
    }
    const seen = new Set();
    const stack = [...roots];
    let visited = 0;
    while (stack.length && visited < 200000) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      visited += 1;
      const props = fiber.memoizedProps;
      if (props && typeof props.openMediaPane === 'function') {
        props.openMediaPane(mediaRef);
        return {
          ok: true,
          visited,
          component:
            fiber.type?.displayName ||
            fiber.type?.name ||
            fiber.elementType?.name ||
            'anonymous'
        };
      }
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    return { ok: false, visited };
  })()`
}

async function openMediaPane(renderer, asset) {
  const setup = await waitFor(
    'production openMediaPane callback',
    async () => {
      const result = await harness.evaluateByValue(renderer, mediaPaneExpression(asset))
      return result?.ok ? result : null
    },
    30_000,
    100
  )
  const state = await waitFor('visible packaged LUT toolbar', async () => {
    const next = await harness.evaluateByValue(renderer, DOM_STATE_EXPRESSION)
    return next?.loadText === 'Load .cube…' && next?.clearText === 'Clear LUT' ? next : null
  })
  return { setup, state }
}

async function clickToolbarButton(renderer, selector) {
  const result = await harness.evaluateByValue(
    renderer,
    `(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!(button instanceof HTMLButtonElement)) {
        return { ok: false, reason: 'missing' };
      }
      if (button.disabled) {
        return {
          ok: false,
          reason: 'disabled',
          text: button.textContent?.trim()
        };
      }
      button.click();
      return { ok: true, text: button.textContent?.trim() };
    })()`
  )
  invariant(result?.ok === true, `toolbar CDP click refused: ${JSON.stringify(result)}`)
  return result
}

async function setDialogSelection(mainInspector, selectedPath) {
  const result = await evaluateMain(
    mainInspector,
    `(() => {
      const createRequire =
        process.getBuiltinModule('module').createRequire;
      const electron = createRequire(
        process.cwd() + '/taskwraith-inspector.cjs'
      )('electron');
      const selectedPath = ${JSON.stringify(selectedPath)};
      electron.dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedPath]
      });
      return Promise.resolve(
        electron.dialog.showOpenDialog({
          title: 'TaskWraith inspector dialog self-test'
        })
      ).then((selection) => ({
        pid: process.pid,
        selectedPath,
        home: process.env.HOME,
        override:
          process.env.TASKWRAITH_GROK_USAGE_BINARY_OVERRIDE,
        userData: electron.app.getPath('userData'),
        selection
      }));
    })()`
  )
  invariant(
    result?.selectedPath === selectedPath &&
      result?.selection?.canceled === false &&
      result?.selection?.filePaths?.[0] === selectedPath,
    `main dialog adapter returned the wrong path: ${JSON.stringify(result)}`
  )
  return result
}

async function invokeStudioOpen(renderer, asset) {
  return waitFor(
    'direct production Studio open result',
    async () => {
      const result = await harness.evaluateByValue(
        renderer,
        `window.api.openMediaAssetInStudio(
          ${JSON.stringify(asset.sha256)},
          ${JSON.stringify(asset.mimeType)}
        )`
      )
      if (result?.ok === true) return result
      const error = typeof result?.error === 'string' ? result.error : ''
      if (/unavailable|hydration|not completed/i.test(error)) {
        return null
      }
      throw new Error(`direct Studio open failed: ${error || JSON.stringify(result)}`)
    },
    45_000,
    250
  )
}

async function waitForSourceWindow(companion) {
  return waitFor(
    'exact visible Studio workspace window',
    async () => {
      const result = await harness.probeNativeWindow(companion.pid)
      const matches = result.windows.filter((entry) => entry.title === 'TaskWraith Studio')
      return matches.length === 1 ? result : null
    },
    30_000,
    250
  )
}

function acceptanceHomeRows(home) {
  const result = runExact('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,command='], {
    timeout: 2_000,
    maxBuffer: 2 * 1024 * 1024
  })
  return harness.parseProcessTable(result.stdout).filter((row) => row.command.includes(home))
}

function exactCompanionProcess(companion, electronPgid) {
  const result = runExact('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,command='], {
    timeout: 2_000,
    maxBuffer: 2 * 1024 * 1024
  })
  const matches = harness
    .parseProcessTable(result.stdout)
    .filter((row) => row.pid === companion.pid)
  const expectedExecutable = path.resolve(companionPath)
  invariant(
    matches.length === 1 &&
      matches[0].ppid > 0 &&
      matches[0].pgid === electronPgid &&
      matches[0].pgid === companion.pgid &&
      matches[0].command === companion.command &&
      (matches[0].command === expectedExecutable ||
        matches[0].command.startsWith(expectedExecutable + ' ')) &&
      !matches[0].command.includes('/Applications/TaskWraith.app/'),
    `exact Companion identity mismatch: ${JSON.stringify(matches)}`
  )
  return { ...matches[0], expectedExecutable }
}

function focusSnapshot(targetPid) {
  const result = runExact('/usr/bin/swift', [focusScriptPath, String(targetPid)], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const receipt = JSON.parse(result.stdout)
  invariant(
    Number.isSafeInteger(receipt?.frontmostPid) &&
      receipt.frontmostPid > 0 &&
      receipt.targetPid === targetPid &&
      typeof receipt.targetIsActive === 'boolean' &&
      Number.isFinite(receipt.cursorX) &&
      Number.isFinite(receipt.cursorY),
    `focus helper returned invalid data: ${result.stdout}`
  )
  return {
    ...receipt,
    command: result.command,
    stdoutSha256: sha256Bytes(result.stdout)
  }
}

function assertFocusIsolation(before, after, targetPid, label) {
  const stable =
    before.frontmostPid === after.frontmostPid &&
    before.frontmostPid !== targetPid &&
    before.frontmostBundleIdentifier !== 'com.apple.loginwindow' &&
    after.frontmostBundleIdentifier !== 'com.apple.loginwindow' &&
    before.targetIsActive === false &&
    after.targetIsActive === false &&
    before.cursorX === after.cursorX &&
    before.cursorY === after.cursorY
  invariant(
    stable,
    `${label} changed focus, activation, or cursor: ${JSON.stringify({
      before,
      after,
      targetPid
    })}`
  )
  return {
    ok: true,
    label,
    targetPid,
    foregroundPid: before.frontmostPid,
    companionInactive: true,
    cursorUnchanged: true,
    before,
    after
  }
}

async function captureNative(plan, target, name, adapters = {}) {
  const runStudioUiDriver = adapters.runStudioUiDriver || harness.runStudioUiDriver
  latestTransportMutationBracket = {
    ok: false,
    name,
    stage: 'before-read',
    before: null,
    after: null,
    failure: null
  }

  let beforeMutationReceipt
  try {
    beforeMutationReceipt = await readTransportMutation(plan, target, runStudioUiDriver)
  } catch (error) {
    latestTransportMutationBracket.failure = studioUiDriverEvidenceDescriptor(error, 'before-read')
    throw error
  }

  latestTransportMutationBracket.stage = 'before-normalization'
  latestTransportMutationBracket.failure = studioUiDriverEvidenceDescriptor(
    beforeMutationReceipt,
    'before-normalization'
  )
  const beforeMutation = normalizeTransportMutationReceipt(beforeMutationReceipt)

  latestTransportMutationBracket = {
    ok: false,
    name,
    stage: 'screenshot',
    before: beforeMutation,
    after: null,
    failure: null
  }
  const request = assertObservationOnlyRequest(buildObservationRequest(name))
  let receipt
  try {
    receipt = await runStudioUiDriver(plan, target, request.actions)
  } catch (error) {
    latestTransportMutationBracket.failure = studioUiDriverEvidenceDescriptor(error, 'screenshot')
    throw error
  }
  latestTransportMutationBracket.failure = studioUiDriverEvidenceDescriptor(
    receipt,
    'screenshot-validation'
  )
  invariant(
    receipt?.inputDelivery === 'background-observation-only' &&
      receipt?.allowForegroundInput !== true,
    'native screenshot receipt changed input policy'
  )
  const action = receipt.actions.find((candidate) => candidate.type === 'screenshot')
  invariant(
    action?.screenshotPath && action.byteLength > 0 && receipt.actions.length === 1,
    `native screenshot receipt is invalid: ${JSON.stringify(receipt).slice(0, 1000)}`
  )

  latestTransportMutationBracket = {
    ok: false,
    name,
    stage: 'after-read',
    before: beforeMutation,
    after: null,
    failure: null
  }
  let afterMutationReceipt
  try {
    afterMutationReceipt = await readTransportMutation(plan, target, runStudioUiDriver)
  } catch (error) {
    latestTransportMutationBracket.failure = studioUiDriverEvidenceDescriptor(error, 'after-read')
    throw error
  }

  latestTransportMutationBracket.stage = 'after-normalization'
  latestTransportMutationBracket.failure = studioUiDriverEvidenceDescriptor(
    afterMutationReceipt,
    'after-normalization'
  )
  const afterMutation = normalizeTransportMutationReceipt(afterMutationReceipt)

  latestTransportMutationBracket = {
    ok: false,
    name,
    stage: 'comparison',
    before: beforeMutation,
    after: afterMutation,
    failure: null
  }
  const transportMutationBracket = validateTransportMutationBracket(
    beforeMutationReceipt,
    afterMutationReceipt,
    name
  )
  latestTransportMutationBracket = transportMutationBracket
  return {
    request,
    receipt,
    path: action.screenshotPath,
    byteLength: action.byteLength,
    sha256: sha256File(action.screenshotPath),
    transportMutationBracket
  }
}

async function captureGuarded(plan, target, name) {
  const beforeLock = assertUnlocked(`${name}:before`)
  const beforeIdentity = exactCompanionProcess(target.companion, target.electronPgid)
  const beforeFocus = focusSnapshot(target.companion.pid)
  const capture = await captureNative(plan, target, name)
  const afterLock = assertUnlocked(`${name}:after`)
  const afterIdentity = exactCompanionProcess(target.companion, target.electronPgid)
  const afterFocus = focusSnapshot(target.companion.pid)
  const isolation = assertFocusIsolation(beforeFocus, afterFocus, target.companion.pid, name)
  return {
    ...capture,
    custody: {
      beforeLock,
      afterLock,
      beforeIdentity,
      afterIdentity,
      isolation
    }
  }
}

function parseHudObservations(observations) {
  invariant(Array.isArray(observations), 'HUD OCR observations must be an array')
  const texts = observations.map((entry) => entry?.text)
  const joined = texts.filter((text) => typeof text === 'string').join(' | ')
  const frameTimecode = joined.match(/\b(\d{2}):(\d{2}):(\d{2}):(\d{2})\b/)
  const decimalTimecode = joined.match(/\b(\d{2}):(\d{2}):(\d{2})\.(\d{3})\b/)
  let contentPtsSeconds = null
  if (frameTimecode) {
    const frameDuration = 1 / speechFixture.FIXTURE_FRAME_RATE
    contentPtsSeconds =
      Number(frameTimecode[1]) * 3_600 +
      Number(frameTimecode[2]) * 60 +
      Number(frameTimecode[3]) +
      Number(frameTimecode[4]) * frameDuration
  } else if (decimalTimecode) {
    contentPtsSeconds =
      Number(decimalTimecode[1]) * 3_600 +
      Number(decimalTimecode[2]) * 60 +
      Number(decimalTimecode[3]) +
      Number(decimalTimecode[4]) / 1_000
  }
  const stateTokens = texts
    .filter((text) => typeof text === 'string')
    .map((text) => text.trim())
    .filter((text) => text === 'PLAY' || text === 'PAUSE')
  return {
    texts,
    parsed: {
      contentPtsSeconds,
      state: stateTokens.length === 1 ? stateTokens[0] : null
    }
  }
}

function ocrScreenshot(screenshotPath) {
  const result = runExact('/usr/bin/swift', [ocrScriptPath, screenshotPath], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const observations = JSON.parse(result.stdout)
  invariant(Array.isArray(observations), 'HUD OCR helper did not return an array')
  const parsed = parseHudObservations(observations)
  return {
    command: result.command,
    stdoutSha256: sha256Bytes(result.stdout),
    observations,
    texts: parsed.texts,
    parsed: parsed.parsed
  }
}

const HUD_ASSET_ID_LENGTH = 43
const HUD_ASSET_TOKEN_LENGTH = 64
const HUD_ASSET_TOKEN_ALPHABET = '2349ACDEFHKMNPXT'
// A fuzzy 64-character full-hash token is not an asset identity. Earlier runs
// accepted up to twelve edits, which let unrelated same-length text qualify as
// the content-addressed SHA-256 subject. Vision may still emit fuzzy candidates
// as diagnostics, but only one exact normalized digest binds evidence to media.
const HUD_ASSET_EDIT_DISTANCE_THRESHOLD = 0
const HUD_ASSET_MAX_OBSERVATIONS = 128
const HUD_ASSET_MAX_OBSERVATION_LENGTH = 1_024

function normalizeHudAssetCandidate(value) {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
}

function hudAssetIdentityToken(assetId) {
  invariant(
    typeof assetId === 'string' &&
      assetId.length === HUD_ASSET_ID_LENGTH &&
      /^[A-Za-z0-9_-]+$/.test(assetId),
    'expected HUD asset identity must be one 43-character Base64URL SHA-256 value'
  )
  const bytes = Buffer.from(assetId, 'base64url')
  invariant(bytes.length === 32, 'expected HUD asset identity did not decode to 32 bytes')
  let token = ''
  for (const byte of bytes) {
    token += HUD_ASSET_TOKEN_ALPHABET[byte >> 4]
    token += HUD_ASSET_TOKEN_ALPHABET[byte & 0x0f]
  }
  return token
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[right.length]
}

function matchHudAssetIdentity(hud, assetId) {
  invariant(
    typeof assetId === 'string' &&
      assetId.length === HUD_ASSET_ID_LENGTH &&
      /^[A-Za-z0-9_-]+$/.test(assetId),
    'expected HUD asset identity must be one 43-character Base64URL SHA-256 value'
  )
  invariant(Array.isArray(hud?.observations), 'HUD asset matching requires OCR observations')
  invariant(
    hud.observations.length <= HUD_ASSET_MAX_OBSERVATIONS,
    `HUD asset matching exceeded ${HUD_ASSET_MAX_OBSERVATIONS} observations`
  )

  const expected = normalizeHudAssetCandidate(hudAssetIdentityToken(assetId))
  let bestFullWindow = null
  let bestShortFragment = null
  const consider = (candidate, observationIndex, fullWindow) => {
    const distance = editDistance(expected, candidate)
    const current = fullWindow ? bestFullWindow : bestShortFragment
    if (
      current === null ||
      distance < current.distance ||
      (distance === current.distance && candidate.length > current.observedCandidate.length)
    ) {
      const evidence = {
        observedCandidate: candidate,
        observationIndex,
        comparedLength: candidate.length,
        distance
      }
      if (fullWindow) {
        bestFullWindow = evidence
      } else {
        bestShortFragment = evidence
      }
    }
  }

  for (const [observationIndex, observation] of hud.observations.entries()) {
    if (typeof observation?.text !== 'string') {
      continue
    }
    const observed = normalizeHudAssetCandidate(observation.text)
    invariant(
      observed.length <= HUD_ASSET_MAX_OBSERVATION_LENGTH,
      `HUD asset observation ${observationIndex} exceeded ${HUD_ASSET_MAX_OBSERVATION_LENGTH} normalized characters`
    )
    if (observed.length < HUD_ASSET_TOKEN_LENGTH) {
      consider(observed, observationIndex, false)
      continue
    }
    for (let offset = 0; offset + HUD_ASSET_TOKEN_LENGTH <= observed.length; offset += 1) {
      consider(observed.slice(offset, offset + HUD_ASSET_TOKEN_LENGTH), observationIndex, true)
    }
  }

  const winning = bestFullWindow ??
    bestShortFragment ?? {
      observedCandidate: null,
      observationIndex: null,
      comparedLength: 0,
      distance: HUD_ASSET_TOKEN_LENGTH
    }
  return {
    matched:
      winning.comparedLength === HUD_ASSET_TOKEN_LENGTH &&
      winning.distance <= HUD_ASSET_EDIT_DISTANCE_THRESHOLD,
    expected,
    ...winning,
    threshold: HUD_ASSET_EDIT_DISTANCE_THRESHOLD
  }
}

async function readSourceWorkspaceObservation(plan, target, runDriver = harness.runStudioUiDriver) {
  const bounds = windowBounds(target.window)
  const receipt = await runDriver(plan, target, [{ type: 'read-workspace' }])
  const actions = Array.isArray(receipt?.actions)
    ? receipt.actions.filter((action) => action?.type === 'read-workspace')
    : []
  invariant(
    receipt?.inputDelivery === 'background-observation-only' && actions.length === 1,
    'LUT workspace read did not return one exact background action'
  )
  const workspace = harness.validateStudioWorkspaceObservation(actions[0].workspace, bounds)
  invariant(
    workspace.sourceRoute?.value === 'selected' &&
      workspace.sourceHost?.visible === true &&
      workspace.sourceHost?.frame,
    'LUT checkpoint requires Source selected and visibly presented'
  )
  return { receipt, workspace, sourceHostFrame: workspace.sourceHost.frame }
}

async function pressPlaybackTransition(plan, target, before, after, runDriver = harness.runStudioUiDriver) {
  invariant(
    (before === 'paused' && after === 'playing') ||
      (before === 'playing' && after === 'paused'),
    'LUT Playback transition is not exact'
  )
  const receipt = await runDriver(
    plan,
    target,
    [{ type: 'press-playback', playbackValueBefore: before, playbackValueAfter: after }]
  )
  const action = Array.isArray(receipt?.actions) ? receipt.actions[0] : null
  const expectedKeys = [
    'accessibilityAction',
    'accessibilityLabel',
    'index',
    'playbackValueAfter',
    'playbackValueBefore',
    'type'
  ]
  invariant(
    receipt?.inputDelivery === 'background-observation-only' &&
      receipt.actions.length === 1 &&
      JSON.stringify(Object.keys(action || {}).sort()) === JSON.stringify(expectedKeys) &&
      action.index === 0 &&
      action.type === 'press-playback' &&
      action.accessibilityLabel === 'Playback' &&
      action.accessibilityAction === 'AXPress' &&
      action.playbackValueBefore === before &&
      action.playbackValueAfter === after,
    'LUT Playback receipt is forged or malformed'
  )
  return receipt
}

async function waitForPausedMediaReadiness(
  plan,
  target,
  prefix,
  runDriver = harness.runStudioUiDriver,
  adapters = {}
) {
  const attempts = []
  for (let index = 0; index < 60; index += 1) {
    const workspaceObservation = await readSourceWorkspaceObservation(plan, target, runDriver)
    const capture = await (adapters.captureGuarded || captureGuarded)(
      plan,
      target,
      `${prefix}-readiness-${String(index).padStart(2, '0')}`
    )
    invariant(
      capture.transportMutationBracket?.ok === true,
      'LUT readiness transport-mutation bracket is not complete'
    )
    const hud = (adapters.ocrScreenshot || ocrScreenshot)(capture.path)
    const assetMatch = (adapters.matchHudAssetIdentity || matchHudAssetIdentity)(
      hud,
      target.asset.sha256
    )
    const durationTicks = capture.transportMutationBracket.after?.parsedValue?.afterDurationTicks
    const reasons = []
    if (hud.parsed.state !== 'PAUSE') reasons.push('transport-not-paused')
    if (!Number.isFinite(hud.parsed.contentPtsSeconds)) reasons.push('playhead-unreadable')
    if (!assetMatch.matched || assetMatch.distance !== 0) reasons.push('asset-identity-mismatch')
    if (typeof durationTicks !== 'string' || !/^[1-9]\d*$/.test(durationTicks)) {
      reasons.push('transport-duration-unreadable-or-zero')
    }
    attempts.push({
      index,
      reasons,
      parsed: hud.parsed,
      assetMatch,
      durationTicks,
      capturePath: capture.path,
      sourceHostFrame: workspaceObservation.sourceHostFrame
    })
    if (reasons.length === 0) {
      return { attempts, workspaceObservation, capture, hud, assetMatch }
    }
    await sleep(500)
  }
  throw new Error('LUT paused media readiness timed out: ' + JSON.stringify(attempts))
}

async function capturePlayable(plan, target, name, workspaceObservation) {
  const capture = await captureGuarded(plan, target, name)
  const hud = ocrScreenshot(capture.path)
  const assetMatch = matchHudAssetIdentity(hud, target.asset.sha256)
  invariant(
    hud.parsed.state === 'PLAY' &&
      Number.isFinite(hud.parsed.contentPtsSeconds) &&
      assetMatch.matched,
    `${name} was not exact playable media: ${JSON.stringify({
      parsed: hud.parsed,
      assetMatch
    })}`
  )
  return { capture, hud, assetMatch, workspaceObservation }
}

async function waitForStablePlayable(plan, target, prefix) {
  const attempts = []
  let consecutive = []
  for (let index = 0; index < 8; index += 1) {
    try {
      const workspaceObservation = await readSourceWorkspaceObservation(plan, target)
      const sample = await capturePlayable(
        plan,
        target,
        `${prefix}-${String(index).padStart(2, '0')}`,
        workspaceObservation
      )
      attempts.push({ index, sample })
      const prior = consecutive.at(-1)?.hud?.parsed?.contentPtsSeconds
      const current = sample.hud.parsed.contentPtsSeconds
      consecutive =
        prior === undefined || current > prior ? [...consecutive, sample].slice(-2) : [sample]
      if (consecutive.length === 2) {
        return {
          attempts,
          accepted: consecutive,
          acceptedContentPtsSeconds: consecutive.map((entry) => entry.hud.parsed.contentPtsSeconds),
          final: consecutive.at(-1)
        }
      }
    } catch (error) {
      attempts.push({
        index,
        error: error instanceof Error ? error.message : String(error)
      })
      consecutive = []
    }
    await sleep(500)
  }
  throw new Error(`stable playable media not observed: ${JSON.stringify(attempts)}`)
}

let cachedSourcePts = null

function sourceFramePts(fixturePath) {
  if (cachedSourcePts?.fixturePath === fixturePath) return cachedSourcePts
  const result = runExact(
    resolveMediaTool('ffprobe'),
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'frame=best_effort_timestamp_time',
      '-of',
      'csv=p=0',
      fixturePath
    ],
    { timeout: 180_000, maxBuffer: 32 * 1024 * 1024 }
  )
  const values = result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .map((value) => Number(value.replace(/,$/, '')))
    .filter(Number.isFinite)
  const expectedFrameCount =
    speechFixture.DEFAULT_FIXTURE_DURATION_SECONDS * speechFixture.FIXTURE_FRAME_RATE
  invariant(
    values.length === expectedFrameCount,
    `fixture PTS census changed: ${String(values.length)}`
  )
  cachedSourcePts = {
    fixturePath,
    values,
    count: values.length,
    digest: jsonDigest(values),
    command: result.command
  }
  return cachedSourcePts
}

function generateDecodedReference(decodedPtsSeconds, destination, fixturePath) {
  const census = sourceFramePts(fixturePath)
  const matches = census.values.filter(
    (candidate) => Math.abs(candidate - decodedPtsSeconds) <= 0.000_501
  )
  invariant(
    matches.length === 1,
    `decoded PTS did not resolve one source frame: ${JSON.stringify({
      decodedPtsSeconds,
      matches
    })}`
  )
  const exactPtsSeconds = matches[0]
  const selectFilter =
    'select=between(t\\,' +
    (exactPtsSeconds - 0.000_001).toFixed(6) +
    '\\,' +
    (exactPtsSeconds + 0.000_001).toFixed(6) +
    ')'
  const result = runExact(
    resolveMediaTool('ffmpeg'),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      fixturePath,
      '-vf',
      selectFilter,
      '-fps_mode',
      'passthrough',
      '-frames:v',
      '1',
      '-y',
      destination
    ],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
  )
  return {
    path: destination,
    sha256: sha256File(destination),
    exactPtsSeconds,
    command: result.command,
    exitCode: result.exitCode,
    census: {
      count: census.count,
      digest: census.digest,
      command: census.command
    }
  }
}

function windowBounds(windowReceipt) {
  const match = windowReceipt.windows.find((entry) => entry.title === 'TaskWraith Studio')
  invariant(match?.bounds, 'exact Studio workspace bounds are missing')
  return match.bounds
}

function effectPreviewJournal(entries) {
  return entries.filter((entry) => entry.op?.type === 'set_effect_preview')
}

async function prepareFreshRuntime(artifactRoot, inputs) {
  const instanceId = path.basename(artifactRoot)
  invariant(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(instanceId),
    'artifact root basename is not a safe instance id'
  )
  const home = path.join(artifactRoot, 'home')
  const basePlan = harness.buildStudioAcceptancePlan({
    instanceId,
    artifactRoot,
    home,
    remoteDebuggingPort: PHASE_PORTS[0].remoteDebuggingPort,
    mainInspectorPort: PHASE_PORTS[0].mainInspectorPort,
    transcriptTimeoutMs: 180_000
  })
  invariant(
    path.resolve(basePlan.artifactRoot) === path.resolve(artifactRoot) &&
      path.resolve(basePlan.home) === path.resolve(home),
    'acceptance plan escaped its disposable roots'
  )
  await fsPromises.mkdir(home, { recursive: true, mode: 0o700 })
  const providerGuard = await harness.materializeIsolatedProviderGuards({ home })
  basePlan.spawnPlan.env.TASKWRAITH_GROK_USAGE_BINARY_OVERRIDE = providerGuard.grokBinaryPath
  const asset = await harness.materializeOwnedMedia({
    mediaPath: inputs.fixturePath,
    mimeType: 'video/mp4',
    userDataPath: basePlan.profile.userDataPath
  })
  invariant(
    asset.sha256 === inputs.fixtureAssetId &&
      sha256File(asset.assetPath) === inputs.fixtureSha256 &&
      path
        .resolve(asset.assetPath)
        .startsWith(path.resolve(basePlan.profile.userDataPath) + path.sep),
    `fresh media materialization mismatch: ${JSON.stringify(asset)}`
  )
  return {
    instanceId,
    artifactRoot,
    home,
    profile: basePlan.profile,
    providerGuard: {
      grokBinaryPath: providerGuard.grokBinaryPath,
      sha256: sha256File(providerGuard.grokBinaryPath)
    },
    inputs,
    asset
  }
}

async function withIsolatedSession(runtime, options, operation) {
  const phase = String(options.phase || '')
  const ports = {
    remoteDebuggingPort: options.remoteDebuggingPort,
    mainInspectorPort: options.mainInspectorPort
  }
  invariant(
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(phase) &&
      Number.isSafeInteger(ports.remoteDebuggingPort) &&
      Number.isSafeInteger(ports.mainInspectorPort),
    'isolated Studio session requires a bounded phase and exact ports'
  )
  const plan = harness.buildStudioAcceptancePlan({
    instanceId: runtime.instanceId,
    artifactRoot: runtime.artifactRoot,
    home: runtime.home,
    remoteDebuggingPort: ports.remoteDebuggingPort,
    mainInspectorPort: ports.mainInspectorPort,
    transcriptTimeoutMs: 180_000
  })
  invariant(
    path.resolve(plan.profile.userDataPath) === path.resolve(runtime.profile.userDataPath),
    'phase plan changed the disposable profile'
  )
  plan.spawnPlan.env.TASKWRAITH_GROK_USAGE_BINARY_OVERRIDE = runtime.providerGuard.grokBinaryPath
  const priorOrphanScan = await harness.assertNoPriorStudioOrphans(plan)
  const spec = {
    kind: 'electron',
    command: plan.spawnPlan.electronBinary,
    args: plan.spawnPlan.argv,
    cwd: plan.repoRoot,
    env: plan.spawnPlan.env,
    timeoutMs: options.timeoutMs || 180_000,
    forceAfterMs: 4_000,
    receiptPath: options.receiptPath || path.join(runtime.artifactRoot, `${phase}-watchdog.json`),
    remoteDebuggingPort: ports.remoteDebuggingPort,
    mainInspectorPort: ports.mainInspectorPort
  }
  const session = await harness.launchUnderWatchdog(spec)
  let renderer = null
  let mainInspector = null
  let value = null
  let primaryError = null
  try {
    const portOwnership = await assertExactChildOwnsDebugPorts(session)
    renderer = await attachRendererCdpSession({
      port: ports.remoteDebuggingPort
    })
    const inspectorUrl = await discoverMainInspectorUrl({
      port: ports.mainInspectorPort
    })
    mainInspector = await attachMainInspectorSession({
      webSocketDebuggerUrl: inspectorUrl
    })
    const mainIdentity = await evaluateMain(
      mainInspector,
      `(() => {
        const createRequire =
          process.getBuiltinModule('module').createRequire;
        const electron = createRequire(
          process.cwd() + '/taskwraith-inspector.cjs'
        )('electron');
        return {
          pid: process.pid,
          home: process.env.HOME,
          override:
            process.env.TASKWRAITH_GROK_USAGE_BINARY_OVERRIDE,
          userData: electron.app.getPath('userData')
        };
      })()`
    )
    invariant(
      mainIdentity?.pid === session.pid &&
        path.resolve(mainIdentity.home || '') === path.resolve(plan.home) &&
        path.resolve(mainIdentity.userData || '') === path.resolve(plan.profile.userDataPath) &&
        path.resolve(mainIdentity.override || '') ===
          path.resolve(runtime.providerGuard.grokBinaryPath),
      `isolated main identity mismatch: ${JSON.stringify(mainIdentity)}`
    )
    const companion = await harness.findStudioCompanion(session.pid)
    const companionIdentity = exactCompanionProcess(companion, session.pgid)
    value = await operation({
      plan,
      session,
      renderer,
      mainInspector,
      companion,
      companionIdentity,
      portOwnership,
      mainIdentity
    })
  } catch (error) {
    primaryError = error
  }

  const closeErrors = []
  try {
    renderer?.close()
  } catch (error) {
    closeErrors.push(error)
  }
  try {
    mainInspector?.close()
  } catch (error) {
    closeErrors.push(error)
  }
  let terminal = null
  let cleanupError = null
  try {
    terminal = harness.assertCleanWatchdogTerminal(await session.stop())
  } catch (error) {
    cleanupError = error
  }
  const survivors = acceptanceHomeRows(runtime.home)
  if (terminal) terminal = { ...terminal, survivors }
  try {
    if (terminal) validateTerminalReceipt(terminal)
  } catch (error) {
    cleanupError = cleanupError || error
  }
  if (primaryError || closeErrors.length > 0 || cleanupError || !value) {
    throw new AggregateError(
      [primaryError, ...closeErrors, cleanupError].filter(Boolean),
      JSON.stringify({
        phase,
        primaryError: primaryError instanceof Error ? primaryError.message : primaryError,
        closeErrors: closeErrors.map((error) =>
          error instanceof Error ? error.message : String(error)
        ),
        cleanupError: cleanupError instanceof Error ? cleanupError.message : cleanupError,
        terminal,
        survivors
      })
    )
  }
  return {
    ...value,
    phase,
    electron: {
      pid: session.pid,
      pgid: session.pgid,
      ...ports
    },
    providerGuard: runtime.providerGuard,
    priorOrphanScan,
    portOwnership: value.portOwnership,
    mainIdentity: value.mainIdentity,
    watchdogTerminal: terminal,
    processDisappearance: {
      verified: true,
      artifactHomeSurvivors: []
    }
  }
}

async function withSession(runtime, phaseIndex, operation) {
  return withIsolatedSession(runtime, phaseSessionOptions(phaseIndex), operation)
}

function phaseSessionOptions(phaseIndex) {
  const phase = JOURNEY_PHASES[phaseIndex]
  const ports = PHASE_PORTS[phaseIndex]
  invariant(
    typeof phase === 'string' && ports,
    'LUT journey phase index is outside the fixed two-phase plan'
  )
  return {
    phase,
    ...ports,
    timeoutMs: LUT_PHASE_TIMEOUT_MS
  }
}

async function phaseOne(runtime, syntheticRedReference) {
  return withSession(runtime, 0, async (context) => {
    const focusBefore = focusSnapshot(context.companion.pid)
    const pane = await openMediaPane(context.renderer, runtime.asset)
    const initialDom = await harness.evaluateByValue(context.renderer, DOM_STATE_EXPRESSION)
    invariant(
      initialDom?.active === 'false' && initialDom?.label === 'LUT: None',
      `fresh LUT toolbar was not inactive: ${JSON.stringify(initialDom)}`
    )
    const openResult = await invokeStudioOpen(context.renderer, runtime.asset)
    const sourceWindow = await waitForSourceWindow(context.companion)
    const target = {
      companion: context.companion,
      electronPgid: context.session.pgid,
      window: sourceWindow,
      expectedWindowTitle: 'TaskWraith Studio',
      asset: runtime.asset
    }
    const readiness = await waitForPausedMediaReadiness(
      context.plan,
      target,
      'phase1',
      harness.runStudioUiDriver
    )
    const focusBeforePlaybackStart = focusSnapshot(context.companion.pid)
    const playbackStart = await pressPlaybackTransition(
      context.plan,
      target,
      'paused',
      'playing'
    )
    const playbackStartFocus = focusSnapshot(context.companion.pid)
    const playbackStartIsolation = assertFocusIsolation(
      focusBeforePlaybackStart,
      playbackStartFocus,
      context.companion.pid,
      'phase1-playback-start'
    )
    const neutral = await waitForStablePlayable(context.plan, target, 'phase1-neutral')
    const neutralReference = generateDecodedReference(
      neutral.final.hud.parsed.contentPtsSeconds,
      path.join(runtime.artifactRoot, 'phase1-neutral-reference.png'),
      runtime.inputs.fixturePath
    )
    const neutralPixels = compareDecodedSample(
      neutral.final,
      neutralReference.path,
      windowBounds(sourceWindow),
      'neutral'
    )
    invariant(
      neutralPixels.clean,
      `neutral exact-frame comparison failed: ${JSON.stringify(neutralPixels.metrics)}`
    )

    const journalBeforeLoad = await harness.readStudioJournalOperations(context.plan)
    const beforeLoadRevision = journalBeforeLoad.at(-1)?.revision || 0
    const validDialog = await setDialogSelection(
      context.mainInspector,
      runtime.inputs.validCubePath
    )
    const loadClick = await clickToolbarButton(context.renderer, '.studio-lut-load')
    const activeDom = await waitFor(
      'visible active LUT filename',
      async () => {
        const state = await harness.evaluateByValue(context.renderer, DOM_STATE_EXPRESSION)
        return state?.active === 'true' && state?.label === 'LUT: Acceptance-Red.cube'
          ? state
          : null
      },
      15_000
    )
    const activeState = await harness.evaluateByValue(
      context.renderer,
      'window.api.getStudioEffectPreviewState()'
    )
    invariant(
      activeState?.active === true &&
        activeState?.displayName === 'Acceptance-Red.cube' &&
        activeState?.effectId === runtime.inputs.validCubeSha256,
      `active LUT state mismatch: ${JSON.stringify(activeState)}`
    )
    const loadOperation = await harness.waitForStudioJournalOperation(
      context.plan,
      { type: 'set_effect_preview' },
      {
        afterRevision: beforeLoadRevision,
        timeoutMs: 30_000
      }
    )
    invariant(
      loadOperation.op.effectPreview?.effectId === runtime.inputs.validCubeSha256,
      'load operation did not persist the exact LUT'
    )
    await sleep(500)
    const activeIdentitySeries = await waitForStablePlayable(context.plan, target, 'phase1-active')
    const active = activeIdentitySeries.final
    const activePixels = evaluatePureRedSample(
      active,
      syntheticRedReference.path,
      windowBounds(sourceWindow),
      'active'
    )
    invariant(
      activePixels.clean,
      `active LUT frame was not pure red: ${JSON.stringify({
        comparator: activePixels.comparator.metrics,
        absolute: activePixels.absolute
      })}`
    )

    const effectJournalBeforeInvalid = effectPreviewJournal(
      await harness.readStudioJournalOperations(context.plan)
    )
    const invalidDialog = await setDialogSelection(
      context.mainInspector,
      runtime.inputs.invalidCubePath
    )
    const invalidClick = await clickToolbarButton(context.renderer, '.studio-lut-load')
    const rejectedDom = await waitFor(
      'visible invalid LUT refusal',
      async () => {
        const state = await harness.evaluateByValue(context.renderer, DOM_STATE_EXPRESSION)
        return state?.active === 'true' && /malformed|invalid/i.test(state?.error || '')
          ? state
          : null
      },
      15_000
    )
    const stateAfterInvalid = await harness.evaluateByValue(
      context.renderer,
      'window.api.getStudioEffectPreviewState()'
    )
    await sleep(500)
    const effectJournalAfterInvalid = effectPreviewJournal(
      await harness.readStudioJournalOperations(context.plan)
    )
    const invalidRetention = validateInvalidReplacement({
      activeState,
      stateAfterInvalid,
      journalBefore: effectJournalBeforeInvalid,
      journalAfter: effectJournalAfterInvalid,
      rejectedDom
    })
    const invalidActiveIdentitySeries = await waitForStablePlayable(
      context.plan,
      target,
      'phase1-invalid-retained'
    )
    const invalidActive = invalidActiveIdentitySeries.final
    const invalidPixels = evaluatePureRedSample(
      invalidActive,
      syntheticRedReference.path,
      windowBounds(sourceWindow),
      'invalid-retained'
    )
    invariant(invalidPixels.clean, 'invalid replacement changed the red video plane')
    const focusBeforePlaybackStop = focusSnapshot(context.companion.pid)
    const playbackStop = await pressPlaybackTransition(
      context.plan,
      target,
      'playing',
      'paused'
    )
    const playbackStopFocus = focusSnapshot(context.companion.pid)
    const playbackStopIsolation = assertFocusIsolation(
      focusBeforePlaybackStop,
      playbackStopFocus,
      context.companion.pid,
      'phase1-playback-stop'
    )
    const focusAfter = focusSnapshot(context.companion.pid)
    const phaseIsolation = assertFocusIsolation(
      focusBefore,
      focusAfter,
      context.companion.pid,
      JOURNEY_PHASES[0]
    )
    return {
      pane,
      initialDom,
      openResult,
      sourceWindow,
      neutral,
      neutralReference,
      neutralPixels,
      validDialog,
      loadClick,
      activeDom,
      activeState,
      loadOperation,
      activeIdentitySeries,
      active,
      activePixels,
      invalidDialog,
      invalidClick,
      rejectedDom,
      stateAfterInvalid,
      invalidRetention,
      invalidActiveIdentitySeries,
      invalidActive,
      invalidPixels,
      readiness,
      playback: {
        start: playbackStart,
        stop: playbackStop,
        focusIsolation: { start: playbackStartIsolation, stop: playbackStopIsolation }
      },
      phaseIsolation,
      companionIdentity: context.companionIdentity,
      portOwnership: context.portOwnership,
      mainIdentity: context.mainIdentity
    }
  })
}

async function phaseTwo(runtime, syntheticRedReference, expectedEffectId) {
  return withSession(runtime, 1, async (context) => {
    const focusBefore = focusSnapshot(context.companion.pid)
    const replayState = await waitFor(
      'restart-hydrated LUT state',
      async () => {
        const state = await harness.evaluateByValue(
          context.renderer,
          'window.api.getStudioEffectPreviewState()'
        )
        return state?.active === true && state?.effectId === expectedEffectId ? state : null
      },
      30_000
    )
    const pane = await openMediaPane(context.renderer, runtime.asset)
    const replayDom = await waitFor('restart-visible active LUT filename', async () => {
      const state = await harness.evaluateByValue(context.renderer, DOM_STATE_EXPRESSION)
      return state?.active === 'true' && state?.label === 'LUT: Acceptance-Red.cube' ? state : null
    })
    const replayValidation = validateReplayState(replayState, replayDom, expectedEffectId)
    const openResult = await invokeStudioOpen(context.renderer, runtime.asset)
    const sourceWindow = await waitForSourceWindow(context.companion)
    const target = {
      companion: context.companion,
      electronPgid: context.session.pgid,
      window: sourceWindow,
      expectedWindowTitle: 'TaskWraith Studio',
      asset: runtime.asset
    }
    const readiness = await waitForPausedMediaReadiness(
      context.plan,
      target,
      'phase2',
      harness.runStudioUiDriver
    )
    const focusBeforePlaybackStart = focusSnapshot(context.companion.pid)
    const playbackStart = await pressPlaybackTransition(
      context.plan,
      target,
      'paused',
      'playing'
    )
    const playbackStartFocus = focusSnapshot(context.companion.pid)
    const playbackStartIsolation = assertFocusIsolation(
      focusBeforePlaybackStart,
      playbackStartFocus,
      context.companion.pid,
      'phase2-playback-start'
    )
    const replayActiveIdentitySeries = await waitForStablePlayable(
      context.plan,
      target,
      'phase2-replay-active'
    )
    const replayActive = replayActiveIdentitySeries.final
    const replayPixels = evaluatePureRedSample(
      replayActive,
      syntheticRedReference.path,
      windowBounds(sourceWindow),
      'replay-active'
    )
    invariant(replayPixels.clean, 'restart replay did not preserve the pure-red video plane')

    const journalBeforeClear = await harness.readStudioJournalOperations(context.plan)
    const beforeClearRevision = journalBeforeClear.at(-1)?.revision || 0
    const clearClick = await clickToolbarButton(context.renderer, '.studio-lut-clear')
    const clearedDom = await waitFor('visible cleared LUT state', async () => {
      const state = await harness.evaluateByValue(context.renderer, DOM_STATE_EXPRESSION)
      return state?.active === 'false' && state?.label === 'LUT: None' ? state : null
    })
    const clearedState = await harness.evaluateByValue(
      context.renderer,
      'window.api.getStudioEffectPreviewState()'
    )
    const clearOperation = await harness.waitForStudioJournalOperation(
      context.plan,
      { type: 'set_effect_preview' },
      {
        afterRevision: beforeClearRevision,
        timeoutMs: 30_000
      }
    )
    const clearValidation = validateClearedState(clearedState, clearOperation, clearedDom)
    const cleared = await waitForStablePlayable(context.plan, target, 'phase2-cleared')
    const clearedReference = generateDecodedReference(
      cleared.final.hud.parsed.contentPtsSeconds,
      path.join(runtime.artifactRoot, 'phase2-cleared-reference.png'),
      runtime.inputs.fixturePath
    )
    const clearedPixels = compareDecodedSample(
      cleared.final,
      clearedReference.path,
      windowBounds(sourceWindow),
      'cleared'
    )
    invariant(
      clearedPixels.clean,
      `cleared exact-frame comparison failed: ${JSON.stringify(clearedPixels.metrics)}`
    )
    const focusBeforePlaybackStop = focusSnapshot(context.companion.pid)
    const playbackStop = await pressPlaybackTransition(
      context.plan,
      target,
      'playing',
      'paused'
    )
    const playbackStopFocus = focusSnapshot(context.companion.pid)
    const playbackStopIsolation = assertFocusIsolation(
      focusBeforePlaybackStop,
      playbackStopFocus,
      context.companion.pid,
      'phase2-playback-stop'
    )
    const focusAfter = focusSnapshot(context.companion.pid)
    const phaseIsolation = assertFocusIsolation(
      focusBefore,
      focusAfter,
      context.companion.pid,
      JOURNEY_PHASES[1]
    )
    return {
      replayState,
      pane,
      replayDom,
      replayValidation,
      openResult,
      sourceWindow,
      replayActiveIdentitySeries,
      replayActive,
      replayPixels,
      clearClick,
      clearedDom,
      clearedState,
      clearOperation,
      clearValidation,
      cleared,
      clearedReference,
      clearedPixels,
      readiness,
      playback: {
        start: playbackStart,
        stop: playbackStop,
        focusIsolation: { start: playbackStartIsolation, stop: playbackStopIsolation }
      },
      phaseIsolation,
      companionIdentity: context.companionIdentity,
      portOwnership: context.portOwnership,
      mainIdentity: context.mainIdentity
    }
  })
}

function buildArtifactManifest(artifactRoot) {
  const files = collectRegularFiles(artifactRoot)
    .filter((filePath) => !filePath.startsWith(path.join(artifactRoot, 'home') + path.sep))
    .filter((filePath) => path.basename(filePath) !== 'hash-manifest.json')
    .filter((filePath) => path.basename(filePath) !== '.DS_Store')
    .map((filePath) => ({
      path: path.relative(artifactRoot, filePath),
      byteLength: fs.statSync(filePath).size,
      sha256: sha256File(filePath)
    }))
  return {
    schemaVersion: 1,
    kind: 'taskwraith-studio-lut-acceptance-artifact-manifest',
    recordedAt: new Date().toISOString(),
    files
  }
}

async function runAcceptance(artifactRoot) {
  latestTransportMutationBracket = null
  latestCustody = null
  const startedAt = new Date().toISOString()
  const staticCustody = assertCustody()
  const launchConsole = assertUnlocked('launch-preflight')
  await fsPromises.mkdir(artifactRoot, {
    recursive: false,
    mode: 0o700
  })
  const inputs = await materializePortableInputs(artifactRoot)
  const custody = assertCustody(inputs)
  const runtime = await prepareFreshRuntime(artifactRoot, inputs)
  const syntheticRedReference = createSyntheticRedReference({
    destination: path.join(artifactRoot, 'synthetic-pure-red-reference.png'),
    width: 960,
    height: 540
  })
  const first = await phaseOne(runtime, syntheticRedReference)
  const second = await phaseTwo(runtime, syntheticRedReference, first.activeState.effectId)
  invariant(
    first.electron.pid !== second.electron.pid &&
      first.companionIdentity.pid !== second.companionIdentity.pid,
    'phase two did not use fresh Electron and Companion identities'
  )
  const finalJournal = await harness.readStudioJournalOperations(
    harness.buildStudioAcceptancePlan({
      instanceId: runtime.instanceId,
      artifactRoot,
      home: runtime.home
    })
  )
  const finalEffectEntries = effectPreviewJournal(finalJournal)
  invariant(
    finalEffectEntries.length >= 2 && finalEffectEntries.at(-1).op.effectPreview === null,
    'final durable effect-preview history is incomplete'
  )
  const custodyAfter = assertCustody(inputs)
  invariant(
    custodyAfter.companionSha256 === custody.companionSha256 &&
      custodyAfter.sourceDigest === custody.sourceDigest &&
      custodyAfter.outDigest === custody.outDigest,
    'build or source custody changed during the journey'
  )
  const evidence = {
    schemaVersion: 1,
    kind: 'taskwraith-studio-lut-only-packaged-acceptance',
    ok: true,
    startedAt,
    recordedAt: new Date().toISOString(),
    journeyPhases: JOURNEY_PHASES,
    staticCustody,
    custodyBefore: custody,
    custodyAfter,
    launchConsole,
    runtime: {
      instanceId: runtime.instanceId,
      artifactRoot,
      home: runtime.home,
      profile: runtime.profile,
      providerGuard: runtime.providerGuard,
      asset: runtime.asset
    },
    inputs: {
      fixturePath: inputs.fixturePath,
      fixtureSha256: inputs.fixtureSha256,
      fixtureAssetId: inputs.fixtureAssetId,
      fixtureManifestPath: inputs.fixtureManifestPath,
      fixtureManifestSha256: inputs.fixtureManifestSha256,
      validCubePath: inputs.validCubePath,
      validCubeSha256: inputs.validCubeSha256,
      invalidCubePath: inputs.invalidCubePath,
      invalidCubeSha256: inputs.invalidCubeSha256,
      syntheticRedReference
    },
    phaseOne: first,
    phaseTwo: second,
    finalJournal: {
      path: path.join(
        runtime.profile.userDataPath,
        'studio-companion',
        'studio-project.journal.jsonl'
      ),
      count: finalJournal.length,
      digest: jsonDigest(finalJournal),
      effectPreviewEntries: finalEffectEntries
    },
    safety: {
      nativeDriverMode: 'background-observation-only',
      nativeDriverActionTypes: ['read-transport-mutation', 'screenshot'],
      foregroundInputUsed: false,
      keyboardInputUsed: false,
      mouseInputUsed: false,
      rendererCdpUsedForToolbarControls: true,
      mainInspectorUsedForDialogSelection: true
    },
    outcomePromotionAuthorized: false,
    retryPerformed: false
  }
  const evidencePath = path.join(artifactRoot, 'evidence.json')
  await writeJson(evidencePath, evidence)
  const auditPath = path.join(artifactRoot, 'evidence-audit.json')
  await writeJson(auditPath, {
    schemaVersion: 1,
    kind: 'taskwraith-studio-lut-acceptance-interpretation-audit',
    recordedAt: new Date().toISOString(),
    evidencePath,
    evidenceSha256: sha256File(evidencePath),
    verdict:
      'native LUT load, invalid retention, restart replay, and clear proven through exact material-pixel and durable-state gates',
    pureRedProof:
      'real registered comparator plus absolute R-high/G-and-B-collapsed material-region gate',
    inputPolicy:
      'background native screenshot observation only; toolbar control by renderer CDP; dialog selection by main inspector',
    noOutcomePromotion: true
  })
  const manifestPath = path.join(artifactRoot, 'hash-manifest.json')
  await writeJson(manifestPath, buildArtifactManifest(artifactRoot))
  return {
    evidencePath,
    evidenceSha256: sha256File(evidencePath),
    auditPath,
    auditSha256: sha256File(auditPath),
    manifestPath,
    manifestSha256: sha256File(manifestPath),
    phaseOneElectronPid: first.electron.pid,
    phaseOneCompanionPid: first.companionIdentity.pid,
    phaseTwoElectronPid: second.electron.pid,
    phaseTwoCompanionPid: second.companionIdentity.pid,
    activeRedMetrics: first.activePixels.absolute,
    replayRedMetrics: second.replayPixels.absolute,
    neutralMetrics: first.neutralPixels.metrics,
    clearedMetrics: second.clearedPixels.metrics
  }
}

async function writeFailureArtifacts(
  artifactRoot,
  error,
  transportMutationBracket = latestTransportMutationBracket,
  custody = latestCustody
) {
  if (!artifactRoot || !fs.existsSync(artifactRoot)) return
  const evidencePath = path.join(artifactRoot, 'evidence.json')
  const failure = {
    schemaVersion: 1,
    kind: 'taskwraith-studio-lut-only-packaged-acceptance',
    ok: false,
    recordedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
    custody,
    latestTransportMutationBracket: transportMutationBracket,
    outcomePromotionAuthorized: false,
    retryPerformed: false
  }
  try {
    await writeJson(evidencePath, failure)
    const auditPath = path.join(artifactRoot, 'evidence-audit.json')
    await writeJson(auditPath, {
      schemaVersion: 1,
      kind: 'taskwraith-studio-lut-acceptance-interpretation-audit',
      recordedAt: new Date().toISOString(),
      evidencePath,
      evidenceSha256: sha256File(evidencePath),
      verdict: 'failed',
      noOutcomePromotion: true
    })
    await writeJson(
      path.join(artifactRoot, 'hash-manifest.json'),
      buildArtifactManifest(artifactRoot)
    )
  } catch (sealError) {
    process.stderr.write(
      `failed to seal LUT failure evidence: ${
        sealError instanceof Error ? sealError.message : String(sealError)
      }\n`
    )
  }
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv)
  const artifactRoot = resolveArtifactRoot(cli.artifactRoot)
  const custody = assertCustody()
  const consoleState = consoleSessionState()
  const plan = {
    ok: true,
    mode: cli.launch ? 'launch' : cli.preflightOnly ? 'preflight-only' : 'plan-only',
    artifactRoot,
    requiredProductAncestor,
    custody,
    console: consoleState,
    journeyPhases: JOURNEY_PHASES,
    phasePorts: PHASE_PORTS,
    inputPolicy: {
      nativeDriverMode: 'background-observation-only',
      nativeDriverActions: ['read-transport-mutation', 'screenshot'],
      rendererCdpToolbarClicks: true,
      mainInspectorDialogSelection: true,
      foregroundInputAllowed: false
    }
  }
  if (!cli.launch) {
    if (cli.preflightOnly) {
      assertUnlocked('preflight-only', consoleState)
    }
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    return plan
  }
  assertUnlocked('launch', consoleState)
  try {
    const result = await runAcceptance(artifactRoot)
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
    return result
  } catch (error) {
    await writeFailureArtifacts(artifactRoot, error)
    throw error
  }
}

module.exports = {
  JOURNEY_PHASES,
  LUT_PHASE_TIMEOUT_MS,
  PHASE_PORTS,
  assertFocusIsolation,
  assertObservationOnlyRequest,
  assertUnlocked,
  assertCustody,
  buildArtifactManifest,
  buildObservationRequest,
  captureNative,
  classifyTrackedDirt,
  consoleSessionState,
  createSyntheticRedReference,
  custodyMatches,
  evaluatePureRedCapture,
  evaluatePureRedSample,
  exactCompanionProcess,
  focusSnapshot,
  hudAssetIdentityToken,
  invokeStudioOpen,
  materializePortableInputs,
  matchHudAssetIdentity,
  compareDecodedSample,
  requiredSampleSourceHostFrame,
  ocrScreenshot,
  parseHudObservations,
  phaseSessionOptions,
  pressPlaybackTransition,
  readSourceWorkspaceObservation,
  waitForPausedMediaReadiness,
  openMediaPane,
  parseCli,
  resolveArtifactRoot,
  resolveMediaTool,
  runExact,
  runAcceptance,
  prepareFreshRuntime,
  sha256File,
  treeDigest,
  validateClearedState,
  validateInvalidReplacement,
  validateReplayState,
  validateTransportMutationBracket,
  waitForSourceWindow,
  windowBounds,
  withIsolatedSession,
  writeJson,
  writeFailureArtifacts,
  validateTerminalReceipt
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      '[studio-lut-acceptance-runner] FAIL — ' +
        (error instanceof Error ? error.message : String(error))
    )
    process.exitCode = 1
  })
}
