'use strict'

/**
 * Isolated, owner-gated Studio acceptance runner.
 *
 * Default invocation is plan-only. A real Electron run requires three explicit
 * flags and a caller-supplied media file:
 *
 *   node scripts/studio-acceptance-harness.cjs \
 *     --launch --i-accept-studio-isolated-launch \
 *     --owner-confirms-existing-orphans-cleared \
 *     --media=/absolute/path/to/clip.mov --mime=video/quicktime
 *
 * The harness uses TaskWraith's sanctioned TASKWRAITH_INSTANCE_ID profile lane,
 * a disposable macOS mock keychain, exact CDP/inspector port ownership, and an
 * independent watchdog which owns/reaps the Electron process group. It never
 * targets the live/shared profile and never deletes acceptance artifacts.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFile, fork } = require('node:child_process')
const {
  buildElectronSpawnPlan,
  assertExactChildOwnsDebugPorts
} = require('./perf/electronChildSession.cjs')
const {
  resolveUnpackagedDevUserDataPath,
  sanitizeDevInstanceId
} = require('./perf/devUserDataPath.cjs')
const { assertLaunchPortsFree } = require('./perf/portGuard.cjs')
const { attachRendererCdpSession } = require('./perf/cdpWebSocketSession.cjs')

const WATCHDOG_PATH = path.join(__dirname, 'studio-acceptance-watchdog.cjs')
const WINDOW_PROBE_PATH = path.join(__dirname, 'studio-acceptance-window-probe.swift')
const TRANSCRIPT_MEDIA_DIR = 'transcript-media'
const STUDIO_STATE_DIR = 'studio-companion'
const STUDIO_JOURNAL_FILE = 'studio-project.journal.jsonl'
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_WAIT_MS = 45_000
const ACCEPTANCE_SCHEMA_VERSION = 1

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseArgs(argv) {
  const parsed = {
    launch: false,
    acceptLaunch: false,
    ownerConfirmsOrphansCleared: false,
    pretty: false,
    help: false,
    instanceId: null,
    mediaPath: null,
    mimeType: null,
    remoteDebuggingPort: null,
    mainInspectorPort: null,
    timeoutMs: DEFAULT_TIMEOUT_MS
  }
  for (const argument of argv) {
    if (argument === '--launch') parsed.launch = true
    else if (argument === '--i-accept-studio-isolated-launch') parsed.acceptLaunch = true
    else if (argument === '--owner-confirms-existing-orphans-cleared') {
      parsed.ownerConfirmsOrphansCleared = true
    } else if (argument === '--pretty') parsed.pretty = true
    else if (argument === '--help' || argument === '-h') parsed.help = true
    else if (argument.startsWith('--instance-id=')) parsed.instanceId = argument.slice(14)
    else if (argument.startsWith('--media=')) parsed.mediaPath = argument.slice(8)
    else if (argument.startsWith('--mime=')) parsed.mimeType = argument.slice(7)
    else if (argument.startsWith('--remote-debugging-port=')) {
      parsed.remoteDebuggingPort = Number(argument.slice(24))
    } else if (argument.startsWith('--main-inspector-port=')) {
      parsed.mainInspectorPort = Number(argument.slice(22))
    } else if (argument.startsWith('--timeout-ms=')) {
      parsed.timeoutMs = Number(argument.slice(13))
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return parsed
}

function defaultInstanceId(pid = process.pid) {
  return `studioA${pid}`.slice(0, 16)
}

function assertStudioInstanceId(raw) {
  const sanitized = sanitizeDevInstanceId(raw)
  if (sanitized !== raw || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,15}$/.test(raw)) {
    throw new Error('instanceId must already be a sanitized 2–16 character TASKWRAITH instance id')
  }
  if (raw === 'verify') throw new Error('instanceId verify is shared/reserved')
  return raw
}

function buildStudioAcceptancePlan(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'))
  const instanceId = assertStudioInstanceId(options.instanceId || defaultInstanceId(options.pid))
  const artifactRoot = path.resolve(
    options.artifactRoot ||
      path.join(repoRoot, '.local-only', 'taskwraith-studio', 'acceptance', instanceId)
  )
  const home = path.resolve(options.home || path.join(artifactRoot, 'home'))
  const profile = resolveUnpackagedDevUserDataPath({
    instanceId,
    platform: options.platform || process.platform,
    home,
    env: options.env || process.env
  })
  const spawnPlan = buildElectronSpawnPlan({
    instanceId,
    repoRoot,
    home,
    platform: options.platform || process.platform,
    workload: 'dual_run',
    fxPosture: 'reduce_motion',
    ...(options.remoteDebuggingPort == null
      ? {}
      : { remoteDebuggingPort: options.remoteDebuggingPort }),
    ...(options.mainInspectorPort == null ? {} : { mainInspectorPort: options.mainInspectorPort }),
    ...(options.adapters ? { adapters: options.adapters } : {})
  })
  spawnPlan.env.TASKWRAITH_STUDIO_COMPANION = '1'
  const receiptPath = path.join(artifactRoot, 'watchdog-receipt.json')
  const evidencePath = path.join(artifactRoot, 'studio-acceptance-evidence.json')

  return {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    kind: 'taskwraith-studio-acceptance-plan',
    instanceId,
    repoRoot,
    artifactRoot,
    home,
    profile,
    spawnPlan,
    receiptPath,
    evidencePath,
    studioStateDirectory: path.join(profile.userDataPath, STUDIO_STATE_DIR),
    safety: {
      planOnlyByDefault: true,
      usesSanctionedInstanceLane: true,
      isolatedHome: true,
      mockKeychain: spawnPlan.safety.disposableMockKeychain,
      exactPortOwnership: true,
      authoritativeBuildIncludesStudioCompanion: true,
      watchdogOwnsSpawn: true,
      parentDisconnectReapsExactGroup: true,
      neverAutoDeletesArtifacts: true,
      neverTargetsLiveOrSharedProfile: true,
      launchRequiresOwnerOrphanClearance: true
    }
  }
}

function assertLaunchAuthorized(args, plan) {
  if (!args.launch) {
    return { launch: false, reason: 'plan-only; --launch not supplied' }
  }
  if (!args.acceptLaunch) {
    throw new Error('Real launch requires --i-accept-studio-isolated-launch')
  }
  if (!args.ownerConfirmsOrphansCleared) {
    throw new Error(
      'Real launch requires --owner-confirms-existing-orphans-cleared; do not stack another Electron on a known orphan'
    )
  }
  if (process.platform !== 'darwin') {
    throw new Error('Studio acceptance launch is macOS-only')
  }
  if (!args.mediaPath || !path.isAbsolute(args.mediaPath)) {
    throw new Error('Real launch requires --media=<absolute video path>')
  }
  if (!['video/mp4', 'video/quicktime'].includes(String(args.mimeType || '').toLowerCase())) {
    throw new Error('Real launch requires --mime=video/mp4 or --mime=video/quicktime')
  }
  if (!plan.spawnPlan.argv.includes('--use-mock-keychain')) {
    throw new Error('Refuse launch without disposable macOS mock keychain')
  }
  return { launch: true }
}

function mediaExtension(mimeType) {
  if (mimeType === 'video/mp4') return 'mp4'
  if (mimeType === 'video/quicktime') return 'mov'
  throw new Error(`Unsupported Studio acceptance MIME: ${mimeType}`)
}

async function sha256Base64Url(filePath) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('base64url')
}

async function materializeOwnedMedia(options) {
  const sourcePath = path.resolve(options.mediaPath)
  const before = await fsPromises.lstat(sourcePath)
  if (before.isSymbolicLink() || !before.isFile() || before.size <= 0) {
    throw new Error('Acceptance media must be a non-empty regular file, not a symlink')
  }
  const realSource = await fsPromises.realpath(sourcePath)
  const hash = await sha256Base64Url(realSource)
  const mimeType = options.mimeType.toLowerCase()
  const baseDir = path.join(options.userDataPath, TRANSCRIPT_MEDIA_DIR)
  const shard = path.join(baseDir, hash.slice(0, 2))
  const target = path.join(shard, `${hash}.${mediaExtension(mimeType)}`)
  await fsPromises.mkdir(shard, { recursive: true, mode: 0o700 })

  try {
    const existing = await fsPromises.lstat(target)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('Existing acceptance asset is not a safe regular file')
    }
    const existingHash = await sha256Base64Url(target)
    if (existingHash !== hash) throw new Error('Existing acceptance asset hash mismatch')
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
    const temp = path.join(shard, `.${hash}.${process.pid}.tmp`)
    try {
      await fsPromises.copyFile(realSource, temp, fs.constants.COPYFILE_EXCL)
      await fsPromises.chmod(temp, 0o600)
      const copiedHash = await sha256Base64Url(temp)
      if (copiedHash !== hash) throw new Error('Acceptance media copy hash mismatch')
      await fsPromises.rename(temp, target)
    } catch (error) {
      await fsPromises.rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  return {
    sha256: hash,
    mimeType,
    sourcePath: realSource,
    assetPath: await fsPromises.realpath(target),
    byteLength: before.size
  }
}

function launchUnderWatchdog(spec, adapters = {}) {
  const forkProcess =
    adapters.fork ||
    ((modulePath, args, options) => {
      return fork(modulePath, args, options)
    })
  const launchTimeoutMs = adapters.launchTimeoutMs || 10_000
  const controller = forkProcess(WATCHDOG_PATH, [], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, ...(adapters.controllerEnv || {}) }
  })
  if (!controller || !Number.isInteger(controller.pid) || controller.pid <= 0) {
    return Promise.reject(new Error('Studio acceptance watchdog returned no pid'))
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let terminalMessage = null
    const terminalWaiters = []
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`Studio acceptance watchdog launch timed out after ${launchTimeoutMs}ms`))
    }, launchTimeoutMs)

    const settleTerminal = (message) => {
      terminalMessage = message
      while (terminalWaiters.length > 0) terminalWaiters.shift()(message)
    }

    controller.on('message', (message) => {
      if (!isRecord(message)) return
      if (message.type === 'terminal') settleTerminal(message)
      if (message.type === 'error' && !settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(String(message.error || 'watchdog launch failed')))
        return
      }
      if (message.type !== 'launched' || settled) return
      settled = true
      clearTimeout(timer)
      const session = {
        controllerPid: message.controllerPid,
        pid: message.childPid,
        pgid: message.childPgid || undefined,
        receiptPath: message.receiptPath,
        remoteDebuggingPort: spec.remoteDebuggingPort,
        mainInspectorPort: spec.mainInspectorPort,
        instanceId: spec.env.TASKWRAITH_INSTANCE_ID,
        waitForTerminal(timeoutMs = 15_000) {
          if (terminalMessage) return Promise.resolve(terminalMessage)
          return new Promise((accept, deny) => {
            const timeout = setTimeout(
              () => deny(new Error(`watchdog termination timed out after ${timeoutMs}ms`)),
              timeoutMs
            )
            terminalWaiters.push((terminal) => {
              clearTimeout(timeout)
              accept(terminal)
            })
          })
        },
        async stop(reason = 'owner_requested') {
          if (terminalMessage) return terminalMessage
          if (controller.connected) controller.send({ type: 'stop', reason })
          return this.waitForTerminal()
        },
        disconnectOwnerForTest() {
          controller.disconnect()
        }
      }
      resolve(session)
    })

    controller.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    controller.once('exit', (code, signal) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(
          new Error(`Studio acceptance watchdog exited before launch code=${code} signal=${signal}`)
        )
      }
    })

    controller.send({ type: 'launch', spec })
  })
}

async function evaluateByValue(session, expression) {
  const response = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (response && response.exceptionDetails) {
    throw new Error(
      `Renderer evaluation failed: ${JSON.stringify(response.exceptionDetails).slice(0, 1000)}`
    )
  }
  return response && response.result ? response.result.value : undefined
}

async function waitFor(options) {
  const timeoutMs = options.timeoutMs || DEFAULT_WAIT_MS
  const intervalMs = options.intervalMs || 100
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() <= deadline) {
    try {
      const value = await options.probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  const suffix = lastError
    ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : ''
  throw new Error(`${options.label} timed out after ${timeoutMs}ms${suffix}`)
}

async function invokeAuthorizedStudioOpen(renderer, asset) {
  await waitFor({
    label: 'renderer preload Studio API',
    probe: async () =>
      (await evaluateByValue(
        renderer,
        `typeof window.api?.openMediaAssetInStudio === "function"`
      )) === true
  })
  const expression = `window.api.openMediaAssetInStudio(${JSON.stringify(
    asset.sha256
  )}, ${JSON.stringify(asset.mimeType)})`
  return waitFor({
    label: 'hydrated Studio open_media result',
    intervalMs: 250,
    probe: async () => {
      const result = await evaluateByValue(renderer, expression)
      if (result && result.ok === true) return result
      const error = result && typeof result.error === 'string' ? result.error : ''
      if (/unavailable|hydration|not completed/i.test(error)) return null
      throw new Error(`Open in Studio failed: ${error || JSON.stringify(result)}`)
    }
  })
}

function parseProcessTable(stdout) {
  const rows = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4]
    })
  }
  return rows
}

function descendantsOf(rows, rootPid) {
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
        descendants.add(row.pid)
        changed = true
      }
    }
  }
  return rows.filter((row) => row.pid !== rootPid && descendants.has(row.pid))
}

function defaultExecFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: options.timeoutMs || 10_000,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {})
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${path.basename(file)} failed: ${String(
                (stderr && String(stderr).trim()) || error.message || error
              ).slice(0, 1000)}`
            )
          )
        } else {
          resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
        }
      }
    )
  })
}

async function runStudioAcceptanceBuild(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'))
  const runExec = options.execFile || defaultExecFile
  const steps = [
    { command: 'npm', args: ['run', 'prebuild:bridge-daemon'] },
    { command: 'npm', args: ['run', 'prebuild:studio-companion'] },
    { command: 'npx', args: ['electron-vite', 'build'] }
  ]
  const results = []
  for (const step of steps) {
    results.push(
      await runExec(step.command, step.args, {
        cwd: repoRoot,
        env: process.env,
        timeoutMs: 10 * 60 * 1000
      })
    )
  }
  return { ok: true, steps: steps.map((step) => [step.command, ...step.args].join(' ')), results }
}

async function findStudioCompanion(rootPid, adapters = {}) {
  const runExec = adapters.execFile || defaultExecFile
  return waitFor({
    label: 'TaskWraithStudioCompanion descendant',
    probe: async () => {
      const result = await runExec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command='])
      const descendants = descendantsOf(parseProcessTable(result.stdout), rootPid)
      return (
        descendants.find((row) => /(?:^|\/)TaskWraithStudioCompanion(?:\s|$)/.test(row.command)) ||
        null
      )
    }
  })
}

async function probeNativeWindow(pid, adapters = {}) {
  const runExec = adapters.execFile || defaultExecFile
  const result = await runExec('/usr/bin/swift', [WINDOW_PROBE_PATH, String(pid)], {
    timeoutMs: 20_000
  })
  const parsed = JSON.parse(result.stdout)
  if (
    !isRecord(parsed) ||
    parsed.pid !== pid ||
    !Number.isSafeInteger(parsed.visibleWindowCount) ||
    parsed.visibleWindowCount < 1
  ) {
    throw new Error(`No on-screen native Studio window for exact pid ${pid}`)
  }
  return parsed
}

async function verifyDurableOpen(plan, asset) {
  const journalPath = path.join(plan.studioStateDirectory, STUDIO_JOURNAL_FILE)
  return waitFor({
    label: 'durable Studio open_media journal',
    probe: async () => {
      let raw
      try {
        raw = await fsPromises.readFile(journalPath, 'utf8')
      } catch (error) {
        if (error && error.code === 'ENOENT') return null
        throw error
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        const entry = JSON.parse(line)
        if (
          entry &&
          entry.op &&
          entry.op.type === 'open_media' &&
          entry.op.asset &&
          entry.op.asset.assetId === asset.sha256 &&
          path.resolve(entry.op.asset.path) === path.resolve(asset.assetPath)
        ) {
          return { journalPath, revision: entry.revision, operation: entry.op }
        }
      }
      return null
    }
  })
}

async function writeEvidence(plan, evidence) {
  await fsPromises.mkdir(plan.artifactRoot, { recursive: true, mode: 0o700 })
  const temp = `${plan.evidencePath}.tmp-${process.pid}`
  await fsPromises.writeFile(
    temp,
    `${JSON.stringify(
      {
        schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
        kind: 'taskwraith-studio-in-product-acceptance',
        recordedAt: new Date().toISOString(),
        ...evidence
      },
      null,
      2
    )}\n`,
    { encoding: 'utf8', mode: 0o600 }
  )
  await fsPromises.rename(temp, plan.evidencePath)
}

async function runStudioAcceptance(args, adapters = {}) {
  const plan = buildStudioAcceptancePlan({
    instanceId: args.instanceId || undefined,
    remoteDebuggingPort: args.remoteDebuggingPort,
    mainInspectorPort: args.mainInspectorPort,
    ...(adapters.planOptions || {})
  })
  const authorization = assertLaunchAuthorized(args, plan)
  if (!authorization.launch) return { launched: false, plan, authorization }

  await fsPromises.mkdir(plan.home, { recursive: true, mode: 0o700 })
  await fsPromises.mkdir(plan.artifactRoot, { recursive: true, mode: 0o700 })
  const asset = await materializeOwnedMedia({
    mediaPath: args.mediaPath,
    mimeType: args.mimeType,
    userDataPath: plan.profile.userDataPath
  })

  await (adapters.assertLaunchPortsFree || assertLaunchPortsFree)(
    {
      remoteDebuggingPort: plan.spawnPlan.remoteDebuggingPort,
      mainInspectorPort: plan.spawnPlan.mainInspectorPort,
      instanceId: plan.instanceId
    },
    adapters.portAdapters || {}
  )
  await (adapters.runBuild || runStudioAcceptanceBuild)({
    repoRoot: plan.repoRoot,
    ...(adapters.buildAdapters || {})
  })

  const spec = {
    kind: 'electron',
    command: plan.spawnPlan.electronBinary,
    args: plan.spawnPlan.argv,
    cwd: plan.repoRoot,
    env: plan.spawnPlan.env,
    timeoutMs: args.timeoutMs,
    forceAfterMs: 4_000,
    receiptPath: plan.receiptPath,
    remoteDebuggingPort: plan.spawnPlan.remoteDebuggingPort,
    mainInspectorPort: plan.spawnPlan.mainInspectorPort
  }
  const watchdogLaunch = adapters.launchUnderWatchdog || launchUnderWatchdog
  const session = await watchdogLaunch(spec, adapters.watchdogAdapters || {})
  let renderer = null
  try {
    await (adapters.assertExactChildOwnsDebugPorts || assertExactChildOwnsDebugPorts)(
      session,
      adapters.portOwnershipAdapters || {}
    )
    renderer = await (adapters.attachRenderer || attachRendererCdpSession)({
      port: plan.spawnPlan.remoteDebuggingPort,
      ...(adapters.cdpAdapters ? { adapters: adapters.cdpAdapters } : {})
    })
    const openResult = await (adapters.invokeStudioOpen || invokeAuthorizedStudioOpen)(
      renderer,
      asset
    )
    const durable = await (adapters.verifyDurableOpen || verifyDurableOpen)(plan, asset)
    const companion = await (adapters.findCompanion || findStudioCompanion)(
      session.pid,
      adapters.processAdapters || {}
    )
    const window = await (adapters.probeWindow || probeNativeWindow)(
      companion.pid,
      adapters.windowAdapters || {}
    )
    const evidence = {
      ok: true,
      instanceId: plan.instanceId,
      electron: {
        pid: session.pid,
        pgid: session.pgid || null,
        remoteDebuggingPort: plan.spawnPlan.remoteDebuggingPort,
        mainInspectorPort: plan.spawnPlan.mainInspectorPort
      },
      companion,
      window,
      asset,
      openResult,
      durable,
      watchdogReceiptPath: plan.receiptPath,
      safety: plan.safety
    }
    await (adapters.writeEvidence || writeEvidence)(plan, evidence)
    return { launched: true, plan, evidence }
  } finally {
    try {
      renderer?.close()
    } finally {
      await session.stop()
    }
  }
}

function buildStubSpec(options) {
  const directory = path.resolve(options.directory)
  return {
    kind: 'stub',
    command: process.execPath,
    args: [
      '-e',
      [
        "const fs=require('node:fs');",
        "const path=require('node:path');",
        "const {spawn}=require('node:child_process');",
        "const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
        "fs.writeFileSync(path.join(process.cwd(),'grandchild.json'),JSON.stringify({pid:grandchild.pid})+'\\n');",
        "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),10));",
        "process.on('SIGINT',()=>process.exit(0));",
        'setInterval(()=>{},1000);'
      ].join('')
    ],
    cwd: directory,
    env: {
      TASKWRAITH_INSTANCE_ID: 'studioStub',
      IOS_REMOTE_TRUE: '0',
      TASKWRAITH_STUDIO_COMPANION: '1'
    },
    timeoutMs: options.timeoutMs || 5_000,
    forceAfterMs: options.forceAfterMs || 500,
    receiptPath: path.join(directory, 'watchdog-receipt.json')
  }
}

async function runAbandonOwnerSelfTest(directory) {
  const spec = buildStubSpec({ directory })
  const session = await launchUnderWatchdog(spec, {
    controllerEnv: { TASKWRAITH_STUDIO_ACCEPTANCE_TEST: '1' }
  })
  await fsPromises.writeFile(
    path.join(directory, 'launched.json'),
    `${JSON.stringify({
      ownerPid: process.pid,
      controllerPid: session.controllerPid,
      childPid: session.pid,
      childPgid: session.pgid || null,
      receiptPath: session.receiptPath
    })}\n`,
    'utf8'
  )
  // Deliberately skip stop(). The test kills this owner with SIGKILL; only
  // IPC closure can tell the detached watchdog to reap the target group.
  setInterval(() => {}, 1_000)
}

function helpText() {
  return `TaskWraith Studio acceptance harness

Default: print a non-launching plan.

Required for a real run:
  --launch
  --i-accept-studio-isolated-launch
  --owner-confirms-existing-orphans-cleared
  --media=/absolute/path/to/clip.mov
  --mime=video/mp4|video/quicktime

Optional:
  --instance-id=<unique 2-16 char id>
  --remote-debugging-port=<port>
  --main-inspector-port=<port>
  --timeout-ms=<30000..1800000>
  --pretty
`
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 2 && argv[0] === '--self-test-abandon-owner') {
    await runAbandonOwnerSelfTest(argv[1])
    return
  }
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(helpText())
    return
  }
  const result = await runStudioAcceptance(args)
  process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `[studio-acceptance] FAIL — ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  })
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  ACCEPTANCE_SCHEMA_VERSION,
  parseArgs,
  buildStudioAcceptancePlan,
  assertLaunchAuthorized,
  materializeOwnedMedia,
  launchUnderWatchdog,
  evaluateByValue,
  parseProcessTable,
  descendantsOf,
  runStudioAcceptanceBuild,
  findStudioCompanion,
  verifyDurableOpen,
  buildStubSpec,
  runAbandonOwnerSelfTest,
  runStudioAcceptance
}
