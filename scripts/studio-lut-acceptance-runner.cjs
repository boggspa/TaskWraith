'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { PNG } = require('pngjs')

const repoRoot = path.resolve(__dirname, '..')
const acceptanceRoot = path.join(repoRoot, '.local-only', 'taskwraith-studio', 'acceptance')
const requiredProductAncestor = '8e94b83e0f3ad8e3a8cf2a3164717f84991a6c35'
const expectedCompanionSha256 = '9925f2f283860ca190d2c165b1f81d3a860ff02f24bea20695cd757b2672c533'
const expectedSourceDigest = '8ec45c2800447e4d36f250da61448895a1a17f44274f23802598a055d8cb9acb'
const expectedSourceCount = 67
const expectedOutDigest = 'c3d86d74966a13b60dc186bf1197184f6991fcc09d3fa35cce89d82835f5619b'
const expectedOutCount = 99
const expectedFixtureSha256 = 'add40cd910994004545620b11e9cc127d4d012a6dd15f0e1087c6ce5434c6535'
const expectedFixtureAssetId = Buffer.from(expectedFixtureSha256, 'hex').toString('base64url')
const expectedValidCubeSha256 = 'cba0938400fb53b07606fb8c8718b20b0c8613f775d8e2b148b4d6c072f8f5c7'
const expectedInvalidCubeSha256 = '984b585b670394bb49a9b0f3688d36d53e76a6627071bf9da78bc0949e1363a7'
const expectedSupportHashes = Object.freeze({
  'scripts/studio-acceptance-harness.cjs':
    '04b6903a93ddacfcbec94b648b4e43237becb0b0732864043072592391393d21',
  'scripts/studio-acceptance-ui-driver.swift':
    'ed7751da09a2468e2628b68f0273913ac7c287626a7c65662e1a7f8b9966902a',
  'scripts/studio-acceptance-watchdog.cjs':
    'c12daaf4e2068090f5db0fc178e4cf46f044e844041778f3a8d0a68358a6b69f',
  'scripts/studio-acceptance-window-probe.swift':
    'fb6b385479e33883e2dab7b74c3308459d7aa6e6ba46f861e6b353b3b2963154',
  'scripts/studio-pixel-evidence-verifier.cjs':
    '63ef25eaeaf01105ccf2492062b627f0ba95989b261190c47426efe25f6826bc',
  '.local-only/taskwraith-studio/acceptance/w1acc10e/studio-hud-ocr.swift':
    '504e17abc6f6781e936babe5288100178e3c12d5400d91c31816b2f3f0f8b7f2',
  '.local-only/taskwraith-studio/acceptance/w1acc10e/input-isolation-snapshot.swift':
    '4af200aaa2add67569ab2ea81aeed768233eee2f742457c7d6d877758f901c53'
})
const fixturePath = path.join(acceptanceRoot, 'w1acc0824', 'fixtures', 'test-clip-10m-speech.mp4')
const validCubePath = path.join(acceptanceRoot, 'w1acc10e', 'Acceptance-Red.cube')
const invalidCubePath = path.join(acceptanceRoot, 'w1acc10e', 'Acceptance-Invalid.cube')
const ocrScriptPath = path.join(acceptanceRoot, 'w1acc10e', 'studio-hud-ocr.swift')
const focusScriptPath = path.join(acceptanceRoot, 'w1acc10e', 'input-isolation-snapshot.swift')
const companionPath = path.join(
  repoRoot,
  'swift',
  'TaskWraithBridge',
  '.build',
  'debug',
  'TaskWraithStudioCompanion'
)
const runnerPath = __filename
const harness = require(path.join(repoRoot, 'scripts', 'studio-acceptance-harness.cjs'))
const { compareWindowCaptureToReference } = require(
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

function treeDigest(directory) {
  const entries = collectRegularFiles(directory).map((filePath) => ({
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

function assertCustody() {
  const head = runExact('git', ['rev-parse', 'HEAD']).stdout.trim()
  const ancestor = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', requiredProductAncestor, head],
    { cwd: repoRoot, encoding: 'utf8', timeout: 5_000 }
  )
  const trackedStatus = runExact('git', ['status', '--porcelain=v1', '--untracked-files=no']).stdout
  const sources = treeDigest(path.join(repoRoot, 'swift', 'TaskWraithBridge', 'Sources'))
  const out = treeDigest(path.join(repoRoot, 'out'))
  const support = Object.fromEntries(
    Object.entries(expectedSupportHashes).map(([relativePath]) => [
      relativePath,
      sha256File(path.join(repoRoot, relativePath))
    ])
  )
  const actual = {
    head,
    requiredProductAncestor,
    productAncestorPresent: ancestor.status === 0,
    trackedTreeClean: trackedStatus.trim() === '',
    companionSha256: sha256File(companionPath),
    sourceDigest: sources.digest,
    sourceCount: sources.fileCount,
    outDigest: out.digest,
    outCount: out.fileCount,
    fixtureSha256: sha256File(fixturePath),
    validCubeSha256: sha256File(validCubePath),
    invalidCubeSha256: sha256File(invalidCubePath),
    support,
    runnerPath: path.relative(repoRoot, runnerPath),
    runnerSha256: sha256File(runnerPath)
  }
  const supportMatches = Object.entries(expectedSupportHashes).every(
    ([relativePath, expected]) => actual.support[relativePath] === expected
  )
  invariant(
    actual.productAncestorPresent &&
      actual.trackedTreeClean &&
      actual.companionSha256 === expectedCompanionSha256 &&
      actual.sourceDigest === expectedSourceDigest &&
      actual.sourceCount === expectedSourceCount &&
      actual.outDigest === expectedOutDigest &&
      actual.outCount === expectedOutCount &&
      actual.fixtureSha256 === expectedFixtureSha256 &&
      actual.validCubeSha256 === expectedValidCubeSha256 &&
      actual.invalidCubeSha256 === expectedInvalidCubeSha256 &&
      supportMatches,
    `LUT acceptance custody mismatch: ${JSON.stringify(actual)}`
  )
  for (const ports of PHASE_PORTS) {
    assertPortFree(ports.remoteDebuggingPort)
    assertPortFree(ports.mainInspectorPort)
  }
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
  hudOverlayHeight = 92
}) {
  const comparator = compareWindowCaptureToReference(capturePath, referencePath, windowBounds, {
    hudOverlayHeight
  })
  const absolute = absoluteRedMetrics(capturePath, comparator.registration)
  return {
    clean: comparator.clean && absolute.clean,
    comparator,
    absolute
  }
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
    'exact visible Studio Source window',
    async () => {
      const result = await harness.probeNativeWindow(companion.pid)
      const matches = result.windows.filter((entry) => entry.title === 'TaskWraith Studio — Source')
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

function ocrScreenshot(screenshotPath) {
  const result = runExact('/usr/bin/swift', [ocrScriptPath, screenshotPath], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const observations = JSON.parse(result.stdout)
  invariant(Array.isArray(observations), 'HUD OCR helper did not return an array')
  const texts = observations.map((entry) => entry.text)
  const joined = texts.join(' | ')
  // Prefer the frame-based HUD timecode HH:MM:SS:FF; the decimal form
  // HH:MM:SS.mmm is a legacy fallback. The naive HH:MM:SS-only pattern
  // misreads "00:00:19:20" as 00:19:20 (1160 s), so require the fourth
  // component explicitly when it is present.
  const frameTimecode = joined.match(/\b(\d{2}):(\d{2}):(\d{2}):(\d{2})\b/)
  const decimalTimecode = joined.match(/\b(\d{2}):(\d{2}):(\d{2})\.(\d{3})\b/)
  let contentPtsSeconds = null
  if (frameTimecode) {
    const frameDuration = sourceFramePts().values[1] - sourceFramePts().values[0]
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
  const state = joined.match(/\b(PLAY|PAUSE)\b/i)
  return {
    command: result.command,
    stdoutSha256: sha256Bytes(result.stdout),
    observations,
    texts,
    parsed: {
      contentPtsSeconds,
      state: state?.[1]?.toUpperCase() || null
    }
  }
}

function normalizeHud(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
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

function hudContainsAsset(hud, assetId) {
  const expected = normalizeHud(assetId).slice(0, 24)
  const observed = normalizeHud(hud.texts.join(' '))
  if (observed.includes(expected)) {
    return { matched: true, expected, distance: 0 }
  }
  let bestDistance = expected.length
  for (let index = 0; index + expected.length <= observed.length; index += 1) {
    bestDistance = Math.min(
      bestDistance,
      editDistance(expected, observed.slice(index, index + expected.length))
    )
  }
  return {
    matched: bestDistance <= 4,
    expected,
    distance: bestDistance
  }
}

async function capturePlayable(plan, target, name) {
  const capture = await captureGuarded(plan, target, name)
  const hud = ocrScreenshot(capture.path)
  const assetMatch = hudContainsAsset(hud, target.asset.sha256)
  invariant(
    hud.parsed.state === 'PLAY' &&
      Number.isFinite(hud.parsed.contentPtsSeconds) &&
      assetMatch.matched,
    `${name} was not exact playable media: ${JSON.stringify({
      parsed: hud.parsed,
      assetMatch
    })}`
  )
  return { capture, hud, assetMatch }
}

async function waitForStablePlayable(plan, target, prefix) {
  const attempts = []
  let consecutive = []
  for (let index = 0; index < 8; index += 1) {
    try {
      const sample = await capturePlayable(
        plan,
        target,
        `${prefix}-${String(index).padStart(2, '0')}`
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

function sourceFramePts() {
  if (cachedSourcePts) return cachedSourcePts
  const result = runExact(
    '/opt/homebrew/bin/ffprobe',
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
  invariant(values.length === 18_000, `fixture PTS census changed: ${String(values.length)}`)
  cachedSourcePts = {
    values,
    count: values.length,
    digest: jsonDigest(values),
    command: result.command
  }
  return cachedSourcePts
}

function generateDecodedReference(decodedPtsSeconds, destination) {
  const census = sourceFramePts()
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
    '/opt/homebrew/bin/ffmpeg',
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
  const match = windowReceipt.windows.find((entry) => entry.title === 'TaskWraith Studio — Source')
  invariant(match?.bounds, 'exact Source bounds are missing')
  return match.bounds
}

function effectPreviewJournal(entries) {
  return entries.filter((entry) => entry.op?.type === 'set_effect_preview')
}

async function prepareFreshRuntime(artifactRoot) {
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
    mediaPath: fixturePath,
    mimeType: 'video/mp4',
    userDataPath: basePlan.profile.userDataPath
  })
  invariant(
    asset.sha256 === expectedFixtureAssetId &&
      sha256File(asset.assetPath) === expectedFixtureSha256 &&
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
    asset
  }
}

async function withSession(runtime, phaseIndex, operation) {
  const ports = PHASE_PORTS[phaseIndex]
  const phase = JOURNEY_PHASES[phaseIndex]
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
    timeoutMs: 180_000,
    forceAfterMs: 4_000,
    receiptPath: path.join(runtime.artifactRoot, `${phase}-watchdog.json`),
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
      expectedWindowTitle: 'TaskWraith Studio — Source',
      asset: runtime.asset
    }
    const neutral = await waitForStablePlayable(context.plan, target, 'phase1-neutral')
    const neutralReference = generateDecodedReference(
      neutral.final.hud.parsed.contentPtsSeconds,
      path.join(runtime.artifactRoot, 'phase1-neutral-reference.png')
    )
    const neutralPixels = compareWindowCaptureToReference(
      neutral.final.capture.path,
      neutralReference.path,
      windowBounds(sourceWindow)
    )
    invariant(
      neutralPixels.clean,
      `neutral exact-frame comparison failed: ${JSON.stringify(neutralPixels.metrics)}`
    )

    const journalBeforeLoad = await harness.readStudioJournalOperations(context.plan)
    const beforeLoadRevision = journalBeforeLoad.at(-1)?.revision || 0
    const validDialog = await setDialogSelection(context.mainInspector, validCubePath)
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
        activeState?.effectId === expectedValidCubeSha256,
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
      loadOperation.op.effectPreview?.effectId === expectedValidCubeSha256,
      'load operation did not persist the exact LUT'
    )
    await sleep(500)
    const active = await capturePlayable(context.plan, target, 'phase1-active')
    const activePixels = evaluatePureRedCapture({
      capturePath: active.capture.path,
      referencePath: syntheticRedReference.path,
      windowBounds: windowBounds(sourceWindow)
    })
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
    const invalidDialog = await setDialogSelection(context.mainInspector, invalidCubePath)
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
    const invalidActive = await capturePlayable(context.plan, target, 'phase1-invalid-retained')
    const invalidPixels = evaluatePureRedCapture({
      capturePath: invalidActive.capture.path,
      referencePath: syntheticRedReference.path,
      windowBounds: windowBounds(sourceWindow)
    })
    invariant(invalidPixels.clean, 'invalid replacement changed the red video plane')
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
      active,
      activePixels,
      invalidDialog,
      invalidClick,
      rejectedDom,
      stateAfterInvalid,
      invalidRetention,
      invalidActive,
      invalidPixels,
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
      expectedWindowTitle: 'TaskWraith Studio — Source',
      asset: runtime.asset
    }
    const replayActive = await capturePlayable(context.plan, target, 'phase2-replay-active')
    const replayPixels = evaluatePureRedCapture({
      capturePath: replayActive.capture.path,
      referencePath: syntheticRedReference.path,
      windowBounds: windowBounds(sourceWindow)
    })
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
      path.join(runtime.artifactRoot, 'phase2-cleared-reference.png')
    )
    const clearedPixels = compareWindowCaptureToReference(
      cleared.final.capture.path,
      clearedReference.path,
      windowBounds(sourceWindow)
    )
    invariant(
      clearedPixels.clean,
      `cleared exact-frame comparison failed: ${JSON.stringify(clearedPixels.metrics)}`
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
  const startedAt = new Date().toISOString()
  const custody = assertCustody()
  const launchConsole = assertUnlocked('launch-preflight')
  await fsPromises.mkdir(artifactRoot, {
    recursive: false,
    mode: 0o700
  })
  const runtime = await prepareFreshRuntime(artifactRoot)
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
  const custodyAfter = assertCustody()
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
      fixturePath,
      fixtureSha256: expectedFixtureSha256,
      validCubePath,
      validCubeSha256: expectedValidCubeSha256,
      invalidCubePath,
      invalidCubeSha256: expectedInvalidCubeSha256,
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
  transportMutationBracket = latestTransportMutationBracket
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
  PHASE_PORTS,
  assertObservationOnlyRequest,
  buildArtifactManifest,
  buildObservationRequest,
  captureNative,
  createSyntheticRedReference,
  evaluatePureRedCapture,
  parseCli,
  resolveArtifactRoot,
  runAcceptance,
  validateClearedState,
  validateInvalidReplacement,
  validateReplayState,
  validateTransportMutationBracket,
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
