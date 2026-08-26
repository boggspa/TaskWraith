import { fork as forkChild, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The production harness is CommonJS because it is run directly by Node.
/* eslint-disable @typescript-eslint/no-require-imports */
const {
  adjudicatePlaybackRoundTrip,
  adjudicateRecognizedTranscript,
  adjudicateSharedStudioClock,
  assertGeneratedSpeechFixtureCustody,
  assertStudioAcceptanceCustody,
  classifyStudioAcceptanceDirt,
  measureStudioAcceptanceCustody,
  measureStudioAcceptanceArtifacts,
  assertCleanWatchdogTerminal,
  assertDetachedLaunchAuthorized,
  assertLaunchAuthorized,
  assertNoPriorStudioOrphans,
  buildDetachedCoordinatorIdentity,
  buildDetachedCoordinatorPaths,
  buildStudioAcceptanceJourney,
  buildStudioAcceptancePlan,
  buildStudioUiDriverRequest,
  buildStubSpec,
  compareStudioJourneyCaptures,
  descendantsOf,
  driveStudioUiJourney,
  findAcceptanceArtifactGroups,
  generateAcceptanceSpeechFixture,
  launchDetachedCoordinator,
  launchUnderWatchdog,
  materializeIsolatedProviderGuards,
  materializeOwnedMedia,
  parseArgs,
  parseProcessTable,
  parseStudioTransportMutationText,
  readDetachedCoordinatorStatus,
  runStudioAcceptanceBuild,
  runStudioUiDriver,
  resolveStudioWorkspaceWindow,
  studioProposalInsertionEvidence,
  studioReviewHostCaptureRegion,
  studioSourceHostOverlayCaptureRegion,
  studioWorkspaceReviewPresented,
  validateStudioWorkspaceObservation,
  validateDetachedCoordinatorRequest,
  waitForStudioJournalOperation,
  runStudioAcceptance
} = require('./studio-acceptance-harness.cjs') as {
  adjudicatePlaybackRoundTrip: (receipt: Record<string, any>) => Record<string, any>
  adjudicateRecognizedTranscript: (
    entry: Record<string, any>,
    expectedPhrases: string[]
  ) => Record<string, any>
  adjudicateSharedStudioClock: (
    sourceReceipt: Record<string, any>,
    reviewReceipt: Record<string, any>
  ) => Record<string, any>
  assertGeneratedSpeechFixtureCustody: (
    fixture: Record<string, any>,
    asset: Record<string, any>,
    artifactRoot: string
  ) => Promise<Record<string, any>>
  assertStudioAcceptanceCustody: (
    actual: Record<string, any>,
    options: Record<string, any>
  ) => Record<string, any>
  classifyStudioAcceptanceDirt: (
    status: string,
    digestPath: (relativePath: string) => Promise<string | null> | string | null
  ) => Promise<Record<string, any>>
  measureStudioAcceptanceCustody: (
    options: Record<string, any>,
    adapters?: Record<string, any>
  ) => Promise<Record<string, any>>
  measureStudioAcceptanceArtifacts: (repoRoot: string) => Promise<Record<string, any>>
  assertCleanWatchdogTerminal: (terminal: Record<string, unknown>) => Record<string, unknown>
  assertDetachedLaunchAuthorized: (
    args: Record<string, any>,
    plan: Record<string, any>
  ) => { launch: true; detached: true }
  buildDetachedCoordinatorIdentity: () => Promise<Record<string, any>>
  buildDetachedCoordinatorPaths: (plan: Record<string, any>) => Record<string, string>
  assertLaunchAuthorized: (
    args: Record<string, unknown>,
    plan: Record<string, any>
  ) => {
    launch: boolean
    reason?: string
  }
  assertNoPriorStudioOrphans: (
    plan: { artifactRoot: string },
    adapters?: Record<string, unknown>
  ) => Promise<{
    scanned: number
    trusted: number
    protectedInstalledGroups: Array<{
      receiptPath: string
      pgid: number
      memberPids: number[]
    }>
    orphans: unknown[]
  }>
  buildStudioAcceptanceJourney: () => Array<Record<string, any>>
  buildStudioAcceptancePlan: (options?: Record<string, unknown>) => Record<string, any>
  buildStudioUiDriverRequest: (options: Record<string, any>) => Record<string, any>
  buildStubSpec: (options: {
    directory: string
    timeoutMs?: number
    forceAfterMs?: number
    stubbornGrandchild?: boolean
    grandchildGracefulExitMs?: number
  }) => Record<string, any>
  compareStudioJourneyCaptures: (
    beforePath: string,
    afterPath: string,
    windowBounds: Record<string, number>,
    region: 'material' | 'timeline' | 'review-host',
    reviewHostFrame?: Record<string, number>
  ) => Record<string, any>
  descendantsOf: (
    rows: Array<{ pid: number; ppid: number; pgid: number; command: string }>,
    rootPid: number
  ) => Array<{ pid: number; ppid: number; pgid: number; command: string }>
  driveStudioUiJourney: (
    plan: Record<string, any>,
    target: Record<string, any>,
    adapters?: Record<string, any>
  ) => Promise<Record<string, any>>
  findAcceptanceArtifactGroups: (
    rows: Array<{ pid: number; ppid: number; pgid: number; command: string }>,
    artifactHomes: string[],
    baselinePids?: Set<number>
  ) => Array<{
    pgid: number
    evidencePids: number[]
    members: Array<{ pid: number; ppid: number; pgid: number; command: string }>
  }>
  generateAcceptanceSpeechFixture: (
    options: Record<string, any>,
    adapters?: Record<string, any>
  ) => Promise<Record<string, any>>
  launchDetachedCoordinator: (
    args: Record<string, any>,
    adapters?: Record<string, any>
  ) => Promise<Record<string, any>>
  launchUnderWatchdog: (
    spec: Record<string, unknown>,
    adapters?: Record<string, unknown>
  ) => Promise<{
    controllerPid: number
    pid: number
    pgid?: number
    receiptPath: string
    stop: () => Promise<Record<string, unknown>>
  }>
  readDetachedCoordinatorStatus: (
    options: Record<string, any>,
    adapters?: Record<string, any>
  ) => Promise<Record<string, any>>
  validateDetachedCoordinatorRequest: (
    request: Record<string, any>,
    options?: Record<string, any>
  ) => Record<string, any>
  materializeIsolatedProviderGuards: (options: { home: string }) => Promise<{
    grokBinaryPath: string
    sha256: string
  }>
  materializeOwnedMedia: (options: {
    mediaPath: string
    mimeType: string
    userDataPath: string
  }) => Promise<{
    sha256: string
    mimeType: string
    sourcePath: string
    assetPath: string
    byteLength: number
  }>
  parseArgs: (argv: string[]) => Record<string, any>
  parseProcessTable: (
    stdout: string
  ) => Array<{ pid: number; ppid: number; pgid: number; command: string }>
  parseStudioTransportMutationText: (text: string) => Record<string, unknown>
  studioProposalInsertionEvidence: (
    entry: Record<string, any>,
    boundary: { assetId: string; durationSeconds: number }
  ) => Record<string, any>
  resolveStudioWorkspaceWindow: (target: Record<string, any>) => Record<string, any>
  studioReviewHostCaptureRegion: (
    image: { width: number; height: number },
    windowBounds: Record<string, number>,
    hostFrame: Record<string, number>
  ) => { x: number; y: number; width: number; height: number }
  studioSourceHostOverlayCaptureRegion: (
    image: { width: number; height: number },
    windowBounds: Record<string, number>,
    hostFrame: Record<string, number>
  ) => { x: number; y: number; width: number; height: number }
  validateStudioWorkspaceObservation: (
    workspace: Record<string, any>,
    windowBounds: Record<string, number>
  ) => Record<string, any>
  studioWorkspaceReviewPresented: (workspace: Record<string, any>) => boolean
  runStudioUiDriver: (
    plan: Record<string, any>,
    target: Record<string, any>,
    actions: Array<Record<string, unknown>>,
    adapters?: Record<string, any>
  ) => Promise<Record<string, any>>
  waitForStudioJournalOperation: (
    plan: Record<string, any>,
    expectation: Record<string, any>,
    options?: Record<string, any>
  ) => Promise<Record<string, any>>
  runStudioAcceptanceBuild: (options?: Record<string, any>) => Promise<Record<string, any>>
  runStudioAcceptance: (
    args: Record<string, any>,
    adapters?: Record<string, any>
  ) => Promise<Record<string, any>>
}
const { buildMuxCommand, buildSayCommand, describeFixturePlan, expectedTranscriptPhrases } =
  require('./studio-generate-speech-fixture.cjs') as {
    buildMuxCommand: (options: Record<string, any>) => string[]
    buildSayCommand: (options: Record<string, any>) => string[]
    describeFixturePlan: (options: Record<string, any>) => Record<string, any>
    expectedTranscriptPhrases: () => string[]
  }
const { classifyDetachedArtifactGroups } = require('./studio-acceptance-watchdog.cjs') as {
  classifyDetachedArtifactGroups: (options: {
    rows: Array<{ pid: number; ppid: number; pgid: number; command: string }>
    artifactHomeAliases: string[]
    baselineRows: Array<{ pid: number; ppid: number; pgid: number; command: string }>
    childPgid: number | null
    knownPgids: number[]
  }) => {
    authorizedGroups: Array<{
      pgid: number
      evidencePids: number[]
      members: Array<{ pid: number; ppid: number; pgid: number; command: string }>
    }>
    lostOwnershipGroups: Array<{ pgid: number; memberPids: number[] }>
    mixedOwnershipGroups: Array<{ pgid: number; memberPids: number[]; baselinePids: number[] }>
    protectedInstalledGroups: Array<{ pgid: number; memberPids: number[] }>
  }
}
/* eslint-enable @typescript-eslint/no-require-imports */

const WORKSPACE_WINDOW_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 }
const WORKSPACE_REVIEW_HOST_FRAME = { x: 640, y: 28, width: 640, height: 772 }

function workspaceElement(
  identifier: string,
  visible: boolean,
  role: string | null,
  value: string | null,
  enabled: boolean | null,
  frame: Record<string, number> | null
): Record<string, any> {
  return { identifier, visible, role, value, enabled, frame }
}

function validWorkspaceObservation(review: boolean): { elements: Array<Record<string, any>> } {
  return {
    elements: [
      workspaceElement('studio.workspace.root', true, 'AXGroup', null, null, {
        x: 0,
        y: 28,
        width: 1280,
        height: 772
      }),
      workspaceElement(
        'studio.workspace.route.source',
        true,
        'AXCheckBox',
        review ? 'not selected' : 'selected',
        true,
        { x: 4, y: 4, width: 40, height: 20 }
      ),
      workspaceElement(
        'studio.workspace.route.timeline',
        true,
        'AXCheckBox',
        review ? 'selected' : 'not selected',
        true,
        { x: 48, y: 4, width: 48, height: 20 }
      ),
      workspaceElement(
        'studio.workspace.viewer.source',
        !review,
        !review ? 'AXGroup' : null,
        null,
        null,
        review ? null : { x: 0, y: 28, width: 640, height: 772 }
      ),
      workspaceElement(
        'studio.workspace.viewer.timeline',
        review,
        review ? 'AXGroup' : null,
        null,
        null,
        review ? WORKSPACE_REVIEW_HOST_FRAME : null
      ),
      workspaceElement(
        'studio.workspace.review-version.current',
        true,
        'AXRadioButton',
        review ? 'selected' : 'unavailable',
        review ? true : false,
        { x: 100, y: 4, width: 60, height: 20 }
      ),
      workspaceElement(
        'studio.workspace.review-version.proposed',
        true,
        'AXRadioButton',
        review ? 'not selected' : 'unavailable',
        review ? true : false,
        { x: 164, y: 4, width: 80, height: 20 }
      )
    ]
  }
}

const roots: string[] = []

const validTransportMutationText =
  'tm1 kind=lifecycleAttach route=review preSrc=audio postSrc=audio ' +
  'host=4.125000 prevHost=- preAnchorT=2000000 preAnchorH=4.000000 ' +
  'prePos=2062500 preDur=300000000 prePlay=1 preRate=1.000 ' +
  'postAnchorT=2062500 postAnchorH=4.125000 postPos=2062500 postDur=300000000 ' +
  'postPlay=1 postRate=1.000 crossedDomain=0 clamped=0'

const validAvSyncPeakText =
  'av1 pf=1000 ap=1100 err=-100 errms=-3.333 win=1000000 winms=1.000 ' + 'drawn=1 expl=explained'
const validAvSyncCurrentText =
  'avc1 ts=30000 fd=1000 pf=1000 ap=1100 err=-100 errms=-3.333 ' +
  'win=1000000 winms=1.000 drawn=1 expl=explained'
const validCoreAudioRouteHealthReceipt = {
  id: 42,
  name: 'Acceptance Output',
  uid: 'acceptance-output',
  nominalSampleRate: 48_000,
  alive: true,
  running: true,
  hasOutputStream: true,
  outputStreamCount: 1,
  outputChannelCount: 2,
  muteSupported: true,
  muted: false,
  volumeSupported: true,
  volume: 0.75
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fsPromises.rm(root, { recursive: true, force: true }))
  )
})

async function temporaryRoot(label: string): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), label))
  roots.push(root)
  return root
}

async function waitFor<T>(
  probe: () => T | null | Promise<T | null>,
  label: string,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() <= deadline) {
    try {
      const value = await probe()
      if (value !== null) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function processGroupRows(
  pgid: number
): Array<{ pid: number; ppid: number; pgid: number; command: string }> {
  // @portability-ok: this process-group helper is called only by the POSIX-gated
  // detached-process cases; Windows has no equivalent pgid contract.
  const sample = spawnSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,command='], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 2 * 1024 * 1024
  })
  if (sample.error || sample.status !== 0) {
    throw sample.error || new Error(`ps exited with status ${String(sample.status)}`)
  }
  return parseProcessTable(sample.stdout).filter((row) => row.pgid === pgid)
}

const DETACHED_TEST_TOKEN = 'A'.repeat(32)

async function sha256HexFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  const bytes = await fsPromises.readFile(filePath)
  hash.update(bytes)
  return hash.digest('hex')
}

async function writeDetachedCompletionFixture(
  artifactRoot: string,
  overrides: {
    manifest?: Record<string, unknown>
    evidence?: Record<string, unknown>
    receipt?: Record<string, unknown>
  } = {}
): Promise<{
  plan: Record<string, any>
  paths: Record<string, string>
  manifest: Record<string, any>
  evidence: Record<string, any>
  receipt: Record<string, any>
}> {
  const instanceId = 'studioDetach01'
  const plan = buildStudioAcceptancePlan({
    instanceId,
    artifactRoot,
    home: path.join(artifactRoot, 'home'),
    platform: 'darwin',
    adapters: { resolveElectronPath: () => '/virtual/Electron' }
  })
  const paths = buildDetachedCoordinatorPaths(plan)
  await fsPromises.mkdir(artifactRoot, { recursive: true, mode: 0o700 })
  await fsPromises.writeFile(paths.stdoutLogPath, '', { mode: 0o600 })
  await fsPromises.writeFile(paths.stderrLogPath, '', { mode: 0o600 })

  const receipt = {
    schemaVersion: 2,
    kind: 'taskwraith-studio-acceptance-watchdog',
    status: 'reaped',
    reason: 'owner_requested',
    controllerPid: 8801,
    childPid: 8802,
    childPgid: 8802,
    groupExitVerified: true,
    detachedGroupExitVerified: true,
    detachedProcessGroups: [],
    lostOwnershipGroups: [],
    mixedOwnershipGroups: [],
    protectedInstalledGroups: [],
    survivors: [],
    ...overrides.receipt
  }
  await fsPromises.writeFile(paths.watchdogReceiptPath, `${JSON.stringify(receipt)}\n`, 'utf8')

  const evidence = {
    schemaVersion: 1,
    kind: 'taskwraith-studio-in-product-acceptance',
    recordedAt: '2026-08-16T04:00:03.000Z',
    ok: true,
    instanceId,
    watchdogTerminal: {
      status: receipt.status,
      reason: receipt.reason,
      groupExitVerified: receipt.groupExitVerified,
      detachedGroupExitVerified: receipt.detachedGroupExitVerified,
      detachedProcessGroups: receipt.detachedProcessGroups
    },
    ...overrides.evidence
  }
  await fsPromises.writeFile(paths.evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8')

  const manifest = {
    schemaVersion: 1,
    kind: 'taskwraith-studio-acceptance-detached-coordinator',
    state: 'succeeded',
    revision: 3,
    token: DETACHED_TEST_TOKEN,
    instanceId,
    coordinatorPid: 8800,
    launcherPid: 8799,
    identity: await buildDetachedCoordinatorIdentity(),
    artifactRoot,
    manifestPath: paths.manifestPath,
    evidencePath: paths.evidencePath,
    watchdogReceiptPath: paths.watchdogReceiptPath,
    stdoutLogPath: paths.stdoutLogPath,
    stderrLogPath: paths.stderrLogPath,
    startedAt: '2026-08-16T04:00:00.000Z',
    updatedAt: '2026-08-16T04:00:03.000Z',
    heartbeatAt: '2026-08-16T04:00:02.000Z',
    completedAt: '2026-08-16T04:00:03.000Z',
    evidenceSha256: await sha256HexFile(paths.evidencePath),
    watchdogReceiptSha256: await sha256HexFile(paths.watchdogReceiptPath),
    error: null,
    ...overrides.manifest
  }
  await fsPromises.writeFile(paths.manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8')
  return { plan, paths, manifest, evidence, receipt }
}

describe('Studio acceptance harness', () => {
  it.runIf(process.platform === 'darwin')('requires explicit detached launch consent and a caller-supplied sanitized instance id', () => {
    const parsed = parseArgs([
      '--launch',
      '--detach',
      '--i-accept-studio-isolated-launch',
      '--owner-confirms-existing-orphans-cleared',
      '--media=/tmp/fixture.mov',
      '--mime=video/quicktime'
    ])
    const plan = buildStudioAcceptancePlan({
      instanceId: 'studioDetach01',
      repoRoot: '/virtual/repo',
      home: '/virtual/repo/.local-only/studio/home',
      platform: 'darwin',
      adapters: { resolveElectronPath: () => '/virtual/Electron' }
    })

    expect(parsed.detach).toBe(true)
    expect(() => assertDetachedLaunchAuthorized(parsed, plan)).toThrow(/explicit.*instance/i)
    parsed.instanceId = 'studioDetach01'
    expect(assertDetachedLaunchAuthorized(parsed, plan)).toEqual({
      launch: true,
      detached: true
    })
    expect(() => assertDetachedLaunchAuthorized({ ...parsed, acceptLaunch: false }, plan)).toThrow(
      /i-accept-studio-isolated-launch/
    )
    expect(() =>
      assertDetachedLaunchAuthorized({ ...parsed, ownerConfirmsOrphansCleared: false }, plan)
    ).toThrow(/owner-confirms-existing-orphans-cleared/)
    expect(() =>
      assertDetachedLaunchAuthorized({ ...parsed, detachedToken: DETACHED_TEST_TOKEN }, plan)
    ).toThrow(/status-only/)
  })

  it.runIf(process.platform === 'darwin')('waits for coordinator readiness and never forks the watchdog directly', async () => {
    const root = await temporaryRoot('studio-acceptance-detached-ready-')
    const source = path.join(root, 'fixture.mov')
    const artifactRoot = path.join(root, 'artifacts', 'studioReady01')
    await fsPromises.writeFile(source, 'fixture')
    const controller = Object.assign(new EventEmitter(), {
      pid: 9911,
      connected: true,
      sent: null as Record<string, any> | null,
      disconnected: false,
      unrefed: false,
      send(message: Record<string, any>, callback?: (error?: Error) => void) {
        this.sent = message
        callback?.()
      },
      disconnect() {
        this.connected = false
        this.disconnected = true
      },
      unref() {
        this.unrefed = true
      }
    })
    let forkedPath = ''
    let forkedOptions: Record<string, any> | null = null
    let resolved = false
    const launch = launchDetachedCoordinator(
      {
        ...parseArgs([]),
        launch: true,
        detach: true,
        acceptLaunch: true,
        ownerConfirmsOrphansCleared: true,
        instanceId: 'studioReady01',
        mediaPath: source,
        mimeType: 'video/quicktime'
      },
      {
        planOptions: {
          artifactRoot,
          home: path.join(artifactRoot, 'home'),
          platform: 'darwin',
          adapters: { resolveElectronPath: () => '/virtual/Electron' }
        },
        fork: (modulePath: string, _args: string[], options: Record<string, any>) => {
          forkedPath = modulePath
          forkedOptions = options
          return controller
        },
        verifyReadyManifest: async () => true
      }
    ).then((value: Record<string, any>) => {
      resolved = true
      return value
    })

    await waitFor(() => (forkedPath ? forkedPath : null), 'detached coordinator fork')
    expect(resolved).toBe(false)
    expect(forkedPath).toMatch(/studio-acceptance-detached-coordinator\.cjs$/)
    expect(forkedPath).not.toMatch(/watchdog/)
    expect(forkedOptions).toMatchObject({ execPath: process.execPath, detached: true })
    expect(controller.sent).toMatchObject({
      schemaVersion: 1,
      kind: 'taskwraith-studio-acceptance-detached-start',
      type: 'start',
      artifactRoot
    })
    controller.emit('message', {
      type: 'ready',
      token: controller.sent!.token,
      coordinatorPid: controller.pid,
      manifestPath: path.join(artifactRoot, 'detached-coordinator.json')
    })

    await expect(launch).resolves.toMatchObject({
      kind: 'taskwraith-studio-acceptance-detached-token',
      instanceId: 'studioReady01',
      artifactRoot,
      coordinatorPid: controller.pid
    })
    expect(controller.disconnected).toBe(true)
    expect(controller.unrefed).toBe(true)
    expect(controller.sent).toMatchObject({
      type: 'ready-accepted',
      coordinatorPid: controller.pid
    })
  })

  it.runIf(process.platform === 'darwin')('does not acknowledge or detach when the ready manifest cannot be verified', async () => {
    const root = await temporaryRoot('studio-acceptance-detached-ready-red-')
    const source = path.join(root, 'fixture.mov')
    const artifactRoot = path.join(root, 'artifacts', 'studioReady02')
    await fsPromises.writeFile(source, 'fixture')
    const sent: Array<Record<string, any>> = []
    const controller = Object.assign(new EventEmitter(), {
      pid: 9912,
      connected: true,
      send(message: Record<string, any>, callback?: (error?: Error) => void) {
        sent.push(message)
        callback?.()
      },
      disconnect() {
        this.connected = false
      },
      unref: vi.fn()
    })
    const launch = launchDetachedCoordinator(
      {
        ...parseArgs([]),
        launch: true,
        detach: true,
        acceptLaunch: true,
        ownerConfirmsOrphansCleared: true,
        instanceId: 'studioReady02',
        mediaPath: source,
        mimeType: 'video/quicktime'
      },
      {
        planOptions: {
          artifactRoot,
          home: path.join(artifactRoot, 'home'),
          platform: 'darwin',
          adapters: { resolveElectronPath: () => '/virtual/Electron' }
        },
        fork: () => controller,
        verifyReadyManifest: async () => {
          throw new Error('ready manifest tampered')
        }
      }
    )
    await waitFor(() => (sent.length === 1 ? true : null), 'detached start request')
    controller.emit('message', {
      type: 'ready',
      token: sent[0].token,
      coordinatorPid: controller.pid,
      manifestPath: path.join(artifactRoot, 'detached-coordinator.json')
    })
    await expect(launch).rejects.toThrow(/ready manifest tampered/)
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('start')
    expect(controller.unref).not.toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')(
    'refuses to start the workflow when the launcher disconnects before ready acceptance',
    async () => {
      const root = await temporaryRoot('studio-acceptance-detached-unacked-')
      const artifactRoot = path.join(root, 'acceptance', 'studioNoAck01')
      await fsPromises.mkdir(artifactRoot, { recursive: true, mode: 0o700 })
      await fsPromises.writeFile(path.join(artifactRoot, 'detached-coordinator.stdout.log'), '', {
        mode: 0o600
      })
      await fsPromises.writeFile(path.join(artifactRoot, 'detached-coordinator.stderr.log'), '', {
        mode: 0o600
      })
      const coordinatorPath = path.resolve(
        __dirname,
        '..',
        'scripts',
        'studio-acceptance-detached-coordinator.cjs'
      )
      const coordinator = forkChild(coordinatorPath, [], {
        detached: true,
        env: { ...process.env, TASKWRAITH_STUDIO_ACCEPTANCE_TEST: '1' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      })
      let running: Record<string, any> | null = null
      try {
        const readyPromise = new Promise<Record<string, any>>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('coordinator did not announce ready')),
            5_000
          )
          coordinator.on('message', (message) => {
            if (
              message &&
              typeof message === 'object' &&
              (message as Record<string, any>).type === 'ready'
            ) {
              clearTimeout(timer)
              resolve(message as Record<string, any>)
            }
          })
        })
        coordinator.send({
          schemaVersion: 1,
          kind: 'taskwraith-studio-acceptance-detached-start',
          type: 'start',
          token: DETACHED_TEST_TOKEN,
          launcherPid: process.pid,
          artifactRoot,
          args: {
            ...parseArgs([]),
            launch: true,
            detach: true,
            acceptLaunch: true,
            ownerConfirmsOrphansCleared: true,
            instanceId: 'studioNoAck01',
            mediaPath: '/test-only/unused.mov',
            mimeType: 'video/quicktime'
          },
          selfTest: true
        })
        const ready = await readyPromise
        expect(ready).toMatchObject({
          type: 'ready',
          token: DETACHED_TEST_TOKEN,
          coordinatorPid: coordinator.pid
        })
        const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => coordinator.once('exit', (code, signal) => resolve({ code, signal }))
        )
        coordinator.disconnect()
        const exited = await Promise.race([
          exitPromise,
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error('unacknowledged coordinator kept running')), 2_000)
          )
        ])
        expect(exited).toEqual({ code: 1, signal: null })
        await expect(
          fsPromises.access(path.join(artifactRoot, 'detached-stub-running.json'))
        ).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(
          fsPromises.access(path.join(artifactRoot, 'watchdog-receipt.json'))
        ).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        if (coordinator.pid && processIsAlive(coordinator.pid)) {
          try {
            process.kill(coordinator.pid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
        try {
          running = JSON.parse(
            await fsPromises.readFile(path.join(artifactRoot, 'detached-stub-running.json'), 'utf8')
          )
        } catch {
          running = null
        }
        if (running?.childPgid) {
          try {
            process.kill(-running.childPgid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
      }
    },
    8_000
  )

  it.runIf(process.platform !== 'win32')('refuses arbitrary coordinator commands, scripts, tokens, and path overrides', () => {
    const request = {
      schemaVersion: 1,
      kind: 'taskwraith-studio-acceptance-detached-start',
      type: 'start',
      token: DETACHED_TEST_TOKEN,
      launcherPid: 1234,
      artifactRoot: '/tmp/studio-detached',
      args: {
        ...parseArgs([]),
        launch: true,
        detach: true,
        acceptLaunch: true,
        ownerConfirmsOrphansCleared: true,
        instanceId: 'studioDetach01',
        mediaPath: '/tmp/fixture.mov',
        mimeType: 'video/quicktime'
      }
    }
    expect(validateDetachedCoordinatorRequest(request)).toMatchObject({
      token: DETACHED_TEST_TOKEN,
      artifactRoot: '/tmp/studio-detached'
    })
    expect(() => validateDetachedCoordinatorRequest({ ...request, command: '/bin/sh' })).toThrow(
      /unexpected.*command/i
    )
    expect(() =>
      validateDetachedCoordinatorRequest({ ...request, script: '/tmp/other.cjs' })
    ).toThrow(/unexpected.*script/i)
    expect(() => validateDetachedCoordinatorRequest({ ...request, token: '../escape' })).toThrow(
      /token/i
    )
    expect(() =>
      validateDetachedCoordinatorRequest({
        ...request,
        artifactRoot: '/tmp/studio-detached',
        manifestPath: '/tmp/elsewhere.json'
      })
    ).toThrow(/unexpected.*manifestPath/i)
  })

  it('adjudicates only a hash-matched v2 zero-survivor completion as Green', async () => {
    const root = await temporaryRoot('studio-acceptance-detached-green-')
    const fixture = await writeDetachedCompletionFixture(root)
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN
      })
    ).resolves.toMatchObject({
      state: 'succeeded',
      verdict: 'GREEN',
      green: true,
      evidenceSha256: fixture.manifest.evidenceSha256
    })
  })

  it('rehashes every semantic leaf on a detached RED failure receipt', async () => {
    const root = await temporaryRoot('studio-acceptance-detached-failure-receipt-')
    const fixture = await writeDetachedCompletionFixture(root)
    const leafDirectory = path.join(root, 'failure-leaves')
    await fsPromises.mkdir(leafDirectory)
    const leafPaths = {
      fixtureManifest: path.join(leafDirectory, 'fixture-manifest.json'),
      generatedFixture: path.join(leafDirectory, 'generated.mp4'),
      openedMedia: path.join(leafDirectory, 'opened.mp4'),
      journal: path.join(leafDirectory, 'journal.jsonl'),
      driverRequest: path.join(leafDirectory, 'request.json'),
      driverRaw: path.join(leafDirectory, 'raw.json'),
      driverValidated: path.join(leafDirectory, 'validated.json'),
      watchdogReceipt: fixture.paths.watchdogReceiptPath
    }
    const leafContents = {
      fixtureManifest: 'fixture manifest',
      generatedFixture: 'generated fixture',
      openedMedia: 'opened fixture',
      journal: 'journal leaf',
      driverRequest: 'driver request',
      driverRaw: 'driver raw',
      driverValidated: 'driver validated'
    }
    for (const [name, contents] of Object.entries(leafContents)) {
      await fsPromises.writeFile(leafPaths[name as keyof typeof leafPaths], contents)
    }
    const watchdogReceiptSha256 = await sha256HexFile(fixture.paths.watchdogReceiptPath)
    const artifactReferences = Object.fromEntries(
      await Promise.all(
        Object.entries(leafPaths).map(async ([name, leafPath]) => {
          const stat = await fsPromises.stat(leafPath)
          return [
            name,
            {
              path: leafPath,
              present: true,
              byteLength: stat.size,
              sha256: await sha256HexFile(leafPath)
            }
          ]
        })
      )
    )
    const redEvidence = {
      ...fixture.evidence,
      ok: false,
      verdict: 'RED',
      speechFixture: {
        manifestPath: leafPaths.fixtureManifest,
        outputPath: leafPaths.generatedFixture
      },
      asset: { assetPath: leafPaths.openedMedia },
      durable: { journalPath: leafPaths.journal },
      watchdogReceiptPath: leafPaths.watchdogReceipt,
      failure: {
        name: 'Error',
        message: 'bounded journey failure',
        stage: 'native-exec',
        driverEvidence: {
          requestPath: leafPaths.driverRequest,
          rawReceiptPath: leafPaths.driverRaw,
          validatedReceiptPath: leafPaths.driverValidated
        }
      },
      artifactJoinPolicy: {
        root,
        exactSemanticPathSet: true,
        sha256EveryPresentRegularFile: true,
        revalidateEveryLeafAtStatusRead: true,
        missingFilesRemainExplicit: true
      },
      artifactReferences
    }
    const sealEvidence = async () => {
      await fsPromises.writeFile(
        fixture.paths.evidencePath,
        `${JSON.stringify(redEvidence)}\n`,
        'utf8'
      )
    }
    await sealEvidence()
    const failedManifest = {
      ...fixture.manifest,
      state: 'failed',
      error: 'bounded journey failure',
      evidenceSha256: await sha256HexFile(fixture.paths.evidencePath),
      watchdogReceiptSha256
    }
    const sealManifest = async () => {
      await fsPromises.writeFile(
        fixture.paths.manifestPath,
        `${JSON.stringify(failedManifest)}\n`,
        'utf8'
      )
    }
    await sealManifest()

    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN
      })
    ).resolves.toMatchObject({
      state: 'failed',
      verdict: 'RED',
      green: false,
      reason: 'bounded journey failure',
      failureEvidenceVerified: true,
      evidenceSha256: failedManifest.evidenceSha256,
      watchdogReceiptSha256
    })

    await fsPromises.appendFile(leafPaths.journal, '-tamper')
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN
      })
    ).resolves.toMatchObject({
      state: 'failed',
      verdict: 'RED',
      green: false,
      reason: 'detached RED artifact leaf join mismatch'
    })
    await fsPromises.writeFile(leafPaths.journal, leafContents.journal)

    await fsPromises.appendFile(leafPaths.driverRaw, '-tamper')
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN
      })
    ).resolves.toMatchObject({
      state: 'failed',
      verdict: 'RED',
      green: false,
      reason: 'detached RED artifact leaf join mismatch'
    })
    await fsPromises.writeFile(leafPaths.driverRaw, leafContents.driverRaw)

    const driverValidatedReference = redEvidence.artifactReferences.driverValidated
    await fsPromises.unlink(leafPaths.driverValidated)
    redEvidence.artifactReferences.driverValidated = {
      path: leafPaths.driverValidated,
      present: false
    }
    await sealEvidence()
    failedManifest.evidenceSha256 = await sha256HexFile(fixture.paths.evidencePath)
    await sealManifest()
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN
      })
    ).resolves.toMatchObject({
      state: 'failed',
      verdict: 'RED',
      green: false,
      failureEvidenceVerified: true
    })
    await fsPromises.writeFile(leafPaths.driverValidated, leafContents.driverValidated)
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN
      })
    ).resolves.toMatchObject({
      state: 'failed',
      verdict: 'RED',
      green: false,
      reason: 'detached RED artifact leaf join mismatch'
    })
    redEvidence.artifactReferences.driverValidated = driverValidatedReference
    await sealEvidence()
    failedManifest.evidenceSha256 = await sha256HexFile(fixture.paths.evidencePath)
    await sealManifest()

    const journalReference = redEvidence.artifactReferences.journal
    redEvidence.artifactReferences.journal = redEvidence.artifactReferences.driverRaw
    await sealEvidence()
    failedManifest.evidenceSha256 = await sha256HexFile(fixture.paths.evidencePath)
    await sealManifest()
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN
      })
    ).resolves.toMatchObject({
      state: 'failed',
      verdict: 'RED',
      green: false,
      reason: 'detached RED artifact leaf join mismatch'
    })

    redEvidence.artifactReferences.journal = journalReference
    redEvidence.artifactReferences.watchdogReceipt.sha256 = '0'.repeat(64)
    await sealEvidence()
    failedManifest.evidenceSha256 = await sha256HexFile(fixture.paths.evidencePath)
    await sealManifest()
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN
      })
    ).resolves.toMatchObject({
      state: 'failed',
      verdict: 'RED',
      green: false,
      reason: 'detached RED artifact leaf join mismatch'
    })

    redEvidence.artifactReferences.watchdogReceipt.sha256 = watchdogReceiptSha256
    await sealEvidence()
    failedManifest.evidenceSha256 = await sha256HexFile(fixture.paths.evidencePath)
    await sealManifest()
    await fsPromises.appendFile(fixture.paths.evidencePath, 'tamper')
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN
      })
    ).resolves.toMatchObject({
      state: 'failed',
      verdict: 'RED',
      green: false,
      reason: 'detached RED artifact hash mismatch'
    })
  })

  it.each([
    {
      label: 'tampered evidence',
      mutate: async (fixture: Awaited<ReturnType<typeof writeDetachedCompletionFixture>>) => {
        await fsPromises.appendFile(fixture.paths.evidencePath, 'tamper')
      },
      reason: /evidence.*hash/i
    },
    {
      label: 'unsuccessful evidence',
      mutate: async (fixture: Awaited<ReturnType<typeof writeDetachedCompletionFixture>>) => {
        fixture.evidence.ok = false
        await fsPromises.writeFile(
          fixture.paths.evidencePath,
          `${JSON.stringify(fixture.evidence)}\n`,
          'utf8'
        )
        fixture.manifest.evidenceSha256 = await sha256HexFile(fixture.paths.evidencePath)
        await fsPromises.writeFile(
          fixture.paths.manifestPath,
          `${JSON.stringify(fixture.manifest)}\n`,
          'utf8'
        )
      },
      reason: /not a successful exact-instance/i
    },
    {
      label: 'unverified v1 watchdog',
      mutate: async (fixture: Awaited<ReturnType<typeof writeDetachedCompletionFixture>>) => {
        fixture.receipt.schemaVersion = 1
        await fsPromises.writeFile(
          fixture.paths.watchdogReceiptPath,
          `${JSON.stringify(fixture.receipt)}\n`,
          'utf8'
        )
        fixture.manifest.watchdogReceiptSha256 = await sha256HexFile(
          fixture.paths.watchdogReceiptPath
        )
        await fsPromises.writeFile(
          fixture.paths.manifestPath,
          `${JSON.stringify(fixture.manifest)}\n`,
          'utf8'
        )
      },
      reason: /watchdog.*schema/i
    },
    {
      label: 'reported survivor',
      mutate: async (fixture: Awaited<ReturnType<typeof writeDetachedCompletionFixture>>) => {
        fixture.receipt.survivors = [{ pid: 9919 }]
        await fsPromises.writeFile(
          fixture.paths.watchdogReceiptPath,
          `${JSON.stringify(fixture.receipt)}\n`,
          'utf8'
        )
        fixture.manifest.watchdogReceiptSha256 = await sha256HexFile(
          fixture.paths.watchdogReceiptPath
        )
        await fsPromises.writeFile(
          fixture.paths.manifestPath,
          `${JSON.stringify(fixture.manifest)}\n`,
          'utf8'
        )
      },
      reason: /survivor/i
    }
  ])('keeps $label Red during detached adjudication', async ({ mutate, reason }) => {
    const root = await temporaryRoot('studio-acceptance-detached-red-')
    const fixture = await writeDetachedCompletionFixture(root)
    await mutate(fixture)
    const status = await readDetachedCoordinatorStatus({
      instanceId: fixture.plan.instanceId,
      artifactRoot: root,
      token: DETACHED_TEST_TOKEN
    })
    expect(status).toMatchObject({ green: false, verdict: 'RED' })
    expect(status.reason).toMatch(reason)
  })

  it('keeps missing, running, stale, failed, and unsupported states distinct and never Green', async () => {
    const root = await temporaryRoot('studio-acceptance-detached-states-')
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: 'studioDetach01',
        artifactRoot: path.join(root, 'missing'),
        token: DETACHED_TEST_TOKEN
      })
    ).resolves.toMatchObject({
      state: 'unknown',
      verdict: 'UNKNOWN',
      green: false,
      reason: 'artifact root missing'
    })
    const fixture = await writeDetachedCompletionFixture(root)
    const writeManifest = async (patch: Record<string, unknown>) => {
      const manifest = { ...fixture.manifest, ...patch }
      await fsPromises.writeFile(
        fixture.paths.manifestPath,
        `${JSON.stringify(manifest)}\n`,
        'utf8'
      )
    }

    await writeManifest({
      state: 'running',
      revision: 2,
      updatedAt: '2026-08-16T04:00:02.000Z',
      heartbeatAt: '2026-08-16T04:00:02.000Z',
      completedAt: null,
      evidenceSha256: null,
      watchdogReceiptSha256: null
    })
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN,
        nowMs: Date.parse('2026-08-16T04:00:03.000Z'),
        staleAfterMs: 5_000
      })
    ).resolves.toMatchObject({ state: 'running', verdict: 'UNKNOWN', green: false })
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN,
        nowMs: Date.parse('2026-08-16T04:00:20.000Z'),
        staleAfterMs: 5_000
      })
    ).resolves.toMatchObject({ state: 'stale', verdict: 'RED', green: false })

    await writeManifest({
      state: 'failed',
      revision: 3,
      updatedAt: '2026-08-16T04:00:03.000Z',
      heartbeatAt: '2026-08-16T04:00:02.000Z',
      completedAt: '2026-08-16T04:00:03.000Z',
      error: 'bounded failure',
      evidenceSha256: null,
      watchdogReceiptSha256: null
    })
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN
      })
    ).resolves.toMatchObject({
      state: 'failed',
      verdict: 'RED',
      green: false,
      reason: 'bounded failure'
    })

    await writeManifest({ schemaVersion: 99, state: 'future' })
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN
      })
    ).resolves.toMatchObject({ state: 'unknown', verdict: 'UNKNOWN', green: false })
  })

  it('refuses token mismatch, escaped evidence paths, and symlink or nonregular manifests', async () => {
    const root = await temporaryRoot('studio-acceptance-detached-paths-')
    const fixture = await writeDetachedCompletionFixture(root)
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: 'B'.repeat(32)
      })
    ).rejects.toThrow(/token/i)

    fixture.manifest.evidencePath = path.join(path.dirname(root), 'escaped.json')
    await fsPromises.writeFile(
      fixture.paths.manifestPath,
      `${JSON.stringify(fixture.manifest)}\n`,
      'utf8'
    )
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN
      })
    ).rejects.toThrow(/path|escape/i)

    await fsPromises.rm(fixture.paths.manifestPath)
    await fsPromises.symlink('/tmp/does-not-matter', fixture.paths.manifestPath)
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN
      })
    ).rejects.toThrow(/symlink|regular/i)

    await fsPromises.rm(fixture.paths.manifestPath)
    await fsPromises.mkdir(fixture.paths.manifestPath)
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: fixture.plan.instanceId,
        artifactRoot: root,
        token: DETACHED_TEST_TOKEN
      })
    ).rejects.toThrow(/regular/i)

    const evidenceRoot = path.join(root, 'evidence-symlink')
    const evidenceFixture = await writeDetachedCompletionFixture(evidenceRoot)
    const evidenceTarget = path.join(root, 'outside-evidence.json')
    await fsPromises.rename(evidenceFixture.paths.evidencePath, evidenceTarget)
    await fsPromises.symlink(evidenceTarget, evidenceFixture.paths.evidencePath)
    await expect(
      readDetachedCoordinatorStatus({
        instanceId: evidenceFixture.plan.instanceId,
        artifactRoot: evidenceRoot,
        token: DETACHED_TEST_TOKEN
      })
    ).rejects.toThrow(/regular|symlink/i)
  })

  it.runIf(process.platform === 'darwin')('refuses a preexisting manifest and duplicate instance before any coordinator fork', async () => {
    const root = await temporaryRoot('studio-acceptance-detached-duplicate-')
    const fixture = await writeDetachedCompletionFixture(root)
    const source = path.join(path.dirname(root), 'duplicate-fixture.mov')
    await fsPromises.writeFile(source, 'fixture')
    const forkProcess = vi.fn()
    await expect(
      launchDetachedCoordinator(
        {
          ...parseArgs([]),
          launch: true,
          detach: true,
          acceptLaunch: true,
          ownerConfirmsOrphansCleared: true,
          instanceId: fixture.plan.instanceId,
          mediaPath: source,
          mimeType: 'video/quicktime'
        },
        {
          planOptions: {
            artifactRoot: root,
            home: path.join(root, 'home'),
            platform: 'darwin',
            adapters: { resolveElectronPath: () => '/virtual/Electron' }
          },
          fork: forkProcess
        }
      )
    ).rejects.toThrow(/fresh unique instance|manifest already exists/i)
    expect(forkProcess).not.toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')(
    'seals a real detached stub completion and later adjudicates it Green',
    async () => {
      const root = await temporaryRoot('studio-acceptance-detached-complete-')
      const artifactRoot = path.join(root, 'acceptance', 'studioDetach03')
      const previousTestMode = process.env.TASKWRAITH_STUDIO_ACCEPTANCE_TEST
      process.env.TASKWRAITH_STUDIO_ACCEPTANCE_TEST = '1'
      let token: Record<string, any> | null = null
      try {
        token = await launchDetachedCoordinator(
          {
            ...parseArgs([]),
            launch: true,
            detach: true,
            acceptLaunch: true,
            ownerConfirmsOrphansCleared: true,
            instanceId: 'studioDetach03',
            mediaPath: '/test-only/unused.mov',
            mimeType: 'video/quicktime'
          },
          {
            selfTest: true,
            planOptions: {
              artifactRoot,
              home: path.join(artifactRoot, 'home'),
              platform: 'darwin',
              adapters: { resolveElectronPath: () => '/virtual/Electron' }
            }
          }
        )
        await waitFor(async () => {
          try {
            return JSON.parse(
              await fsPromises.readFile(
                path.join(artifactRoot, 'detached-stub-running.json'),
                'utf8'
              )
            )
          } catch {
            return null
          }
        }, 'detached stub running before completion')
        await fsPromises.writeFile(path.join(artifactRoot, 'detached-stub-stop'), 'stop\n', {
          mode: 0o600
        })
        const completedManifest = await waitFor(async () => {
          try {
            const manifest = JSON.parse(
              await fsPromises.readFile(
                path.join(artifactRoot, 'detached-coordinator.json'),
                'utf8'
              )
            )
            return manifest.state === 'succeeded' ? manifest : null
          } catch {
            return null
          }
        }, 'detached stub success manifest')
        expect(completedManifest).toMatchObject({
          state: 'succeeded',
          error: null,
          evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          watchdogReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
        expect(completedManifest.revision).toBeGreaterThanOrEqual(3)
        expect(Date.parse(completedManifest.updatedAt)).toBeGreaterThanOrEqual(
          Date.parse(completedManifest.startedAt)
        )
        await expect(
          readDetachedCoordinatorStatus({
            instanceId: token.instanceId,
            artifactRoot: token.artifactRoot,
            token: token.token
          })
        ).resolves.toMatchObject({
          state: 'succeeded',
          verdict: 'GREEN',
          green: true
        })
        await waitFor(
          () => (processIsAlive(token!.coordinatorPid) ? null : true),
          'detached coordinator exit after success'
        )
      } finally {
        if (previousTestMode === undefined) {
          delete process.env.TASKWRAITH_STUDIO_ACCEPTANCE_TEST
        } else {
          process.env.TASKWRAITH_STUDIO_ACCEPTANCE_TEST = previousTestMode
        }
        if (token?.coordinatorPid && processIsAlive(token.coordinatorPid)) {
          try {
            process.kill(token.coordinatorPid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
      }
    },
    15_000
  )

  it.runIf(process.platform !== 'win32')(
    'keeps the coordinator-owned stub alive after launcher death and reaps it on coordinator death',
    async () => {
      const root = await temporaryRoot('studio-acceptance-detached-lifecycle-')
      const harnessPath = path.resolve(__dirname, '..', 'scripts', 'studio-acceptance-harness.cjs')
      const launcher = spawn(
        process.execPath,
        [harnessPath, '--self-test-detached-launcher', root, 'studioDetach02'],
        {
          cwd: path.resolve(__dirname, '..'),
          env: { ...process.env, TASKWRAITH_STUDIO_ACCEPTANCE_TEST: '1' },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      let launcherKilled = false
      let ready: Record<string, any> | null = null
      let running: Record<string, any> | null = null
      try {
        ready = await waitFor(async () => {
          try {
            return JSON.parse(
              await fsPromises.readFile(path.join(root, 'launcher-ready.json'), 'utf8')
            )
          } catch {
            return null
          }
        }, 'detached launcher readiness')
        running = await waitFor(async () => {
          try {
            return JSON.parse(
              await fsPromises.readFile(
                path.join(ready!.artifactRoot, 'detached-stub-running.json'),
                'utf8'
              )
            )
          } catch {
            return null
          }
        }, 'detached coordinator stub readiness')

        expect(processIsAlive(ready.coordinatorPid)).toBe(true)
        expect(processIsAlive(running.watchdogControllerPid)).toBe(true)
        expect(processIsAlive(running.childPid)).toBe(true)
        const runningManifest = JSON.parse(
          await fsPromises.readFile(
            path.join(ready.artifactRoot, 'detached-coordinator.json'),
            'utf8'
          )
        )
        expect(runningManifest).toMatchObject({
          state: 'running',
          coordinatorPid: ready.coordinatorPid,
          token: ready.token,
          completedAt: null
        })
        expect(runningManifest.revision).toBeGreaterThanOrEqual(2)
        expect(Date.parse(runningManifest.heartbeatAt)).toBeGreaterThanOrEqual(
          Date.parse(runningManifest.startedAt)
        )

        launcherKilled = launcher.kill('SIGKILL')
        expect(launcherKilled).toBe(true)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('launcher did not exit')), 5_000)
          launcher.once('exit', (_code, signal) => {
            clearTimeout(timer)
            expect(signal).toBe('SIGKILL')
            resolve()
          })
        })
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(processIsAlive(ready.coordinatorPid)).toBe(true)
        expect(processIsAlive(running.childPid)).toBe(true)

        process.kill(ready.coordinatorPid, 'SIGKILL')
        const terminal = await waitFor(async () => {
          try {
            const parsed = JSON.parse(
              await fsPromises.readFile(
                path.join(ready!.artifactRoot, 'watchdog-receipt.json'),
                'utf8'
              )
            )
            return parsed.status === 'reaped' ? parsed : null
          } catch {
            return null
          }
        }, 'coordinator-death watchdog reap')
        expect(terminal).toMatchObject({
          schemaVersion: 2,
          status: 'reaped',
          reason: 'owner_disconnected',
          groupExitVerified: true,
          detachedGroupExitVerified: true
        })
        await waitFor(
          () =>
            processGroupRows(running!.childPgid).length === 0 &&
            !processIsAlive(running!.watchdogControllerPid)
              ? true
              : null,
          'coordinator-owned group cleanup'
        )
      } finally {
        if (!launcherKilled && launcher.pid && processIsAlive(launcher.pid)) {
          launcher.kill('SIGKILL')
        }
        if (ready?.coordinatorPid && processIsAlive(ready.coordinatorPid)) {
          try {
            process.kill(ready.coordinatorPid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
        if (running?.childPgid) {
          try {
            process.kill(-running.childPgid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
      }
    },
    15_000
  )

  it.runIf(process.platform !== 'win32')('is plan-only by default and uses the sanctioned isolated profile posture', () => {
    const plan = buildStudioAcceptancePlan({
      instanceId: 'studioPlan01',
      repoRoot: '/virtual/repo',
      home: '/virtual/repo/.local-only/studio/home',
      platform: 'darwin',
      adapters: { resolveElectronPath: () => '/virtual/Electron' }
    })
    const args = parseArgs([])

    expect(assertLaunchAuthorized(args, plan)).toEqual({
      launch: false,
      reason: 'plan-only; --launch not supplied'
    })
    expect(plan.instanceId).toBe('studioPlan01')
    expect(plan.profile.appName).toBe('TaskWraith Dev studioPlan01')
    expect(plan.spawnPlan.env).toMatchObject({
      TASKWRAITH_INSTANCE_ID: 'studioPlan01',
      IOS_REMOTE_TRUE: '0',
      TASKWRAITH_STUDIO_COMPANION: '1',
      CFFIXED_USER_HOME: '/virtual/repo/.local-only/studio/home'
    })
    expect(plan.spawnPlan.argv).toContain('--use-mock-keychain')
    expect(plan.spawnPlan.argv).not.toContain(expect.stringContaining('--user-data-dir'))
    expect(plan.safety).toMatchObject({
      watchdogOwnsSpawn: true,
      parentDisconnectReapsExactGroup: true,
      neverTargetsLiveOrSharedProfile: true,
      launchRequiresOwnerOrphanClearance: true,
      exactCompanionWindowTargeting: true,
      uiDriverNeverSignalsProcesses: true,
      realTranscriptRequired: true,
      evidenceAfterVerifiedGroupExit: true
    })
  })

  it('carries an explicit bounded transcript wait into the acceptance plan', () => {
    const args = parseArgs(['--transcript-timeout-ms=720000'])
    expect(args.transcriptTimeoutMs).toBe(720_000)
    const plan = buildStudioAcceptancePlan({
      instanceId: 'studioWait01',
      repoRoot: '/virtual/repo',
      home: '/virtual/repo/.local-only/studio/home',
      platform: 'darwin',
      transcriptTimeoutMs: args.transcriptTimeoutMs,
      adapters: { resolveElectronPath: () => '/virtual/Electron' }
    })
    expect(plan.transcriptTimeoutMs).toBe(720_000)
  })

  it.runIf(process.platform === 'darwin')('accepts only one bounded media source for a real launch', () => {
    const plan = buildStudioAcceptancePlan({
      instanceId: 'studioSpeech01',
      repoRoot: '/virtual/repo',
      home: '/virtual/repo/.local-only/studio/home',
      platform: 'darwin',
      adapters: { resolveElectronPath: () => '/virtual/Electron' }
    })
    const generated = {
      ...parseArgs([
        '--launch',
        '--i-accept-studio-isolated-launch',
        '--owner-confirms-existing-orphans-cleared',
        '--generate-speech-fixture'
      ])
    }

    expect(generated.generateSpeechFixture).toBe(true)
    expect(assertLaunchAuthorized(generated, plan)).toEqual({ launch: true })
    expect(() =>
      assertLaunchAuthorized({ ...generated, mediaPath: '/also.mp4', mimeType: 'video/mp4' }, plan)
    ).toThrow(/exactly one.*media source/i)
    expect(() =>
      assertLaunchAuthorized(
        {
          ...generated,
          generateSpeechFixture: false,
          mediaPath: null,
          mimeType: null
        },
        plan
      )
    ).toThrow(/media/i)
  })

  it('refuses a real launch without both explicit consent and orphan clearance', () => {
    const plan = buildStudioAcceptancePlan({
      instanceId: 'studioGuard01',
      repoRoot: '/virtual/repo',
      home: '/virtual/repo/.local-only/studio/home',
      platform: 'darwin',
      adapters: { resolveElectronPath: () => '/virtual/Electron' }
    })
    const base = {
      ...parseArgs([]),
      launch: true,
      mediaPath: '/video.mov',
      mimeType: 'video/quicktime'
    }
    expect(() => assertLaunchAuthorized(base, plan)).toThrow(/i-accept-studio-isolated-launch/)
    expect(() => assertLaunchAuthorized({ ...base, acceptLaunch: true }, plan)).toThrow(
      /owner-confirms-existing-orphans-cleared/
    )
    // The third arm of the matrix: orphan clearance supplied but consent still
    // missing must fail on consent rather than fall through.
    expect(() =>
      assertLaunchAuthorized({ ...base, ownerConfirmsOrphansCleared: true }, plan)
    ).toThrow(/i-accept-studio-isolated-launch/)
  })

  it('materializes a content-addressed video only inside the isolated transcript-media store', async () => {
    const root = await temporaryRoot('studio-acceptance-media-')
    const source = path.join(root, 'source.mov')
    const userDataPath = path.join(root, 'home', 'Library', 'Application Support', 'isolated')
    await fsPromises.writeFile(source, Buffer.from('real media bytes'))

    const asset = await materializeOwnedMedia({
      mediaPath: source,
      mimeType: 'video/quicktime',
      userDataPath
    })

    expect(asset.sha256).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(asset.assetPath).toBe(
      await fsPromises.realpath(
        path.join(userDataPath, 'transcript-media', asset.sha256.slice(0, 2), `${asset.sha256}.mov`)
      )
    )
    expect(await fsPromises.readFile(asset.assetPath, 'utf8')).toBe('real media bytes')
    expect(asset.assetPath.startsWith((await fsPromises.realpath(userDataPath)) + path.sep)).toBe(
      true
    )
  })

  it('generates and seals the bounded 30-second speech fixture inside its artifact root', async () => {
    const artifactRoot = await temporaryRoot('studio-acceptance-speech-')
    const calls: string[][] = []
    const fixture = await generateAcceptanceSpeechFixture(
      { artifactRoot },
      {
        execFile: async (file: string, args: string[]) => {
          const argv = [file, ...args]
          calls.push(argv)
          const outputIndex = argv.indexOf('-o')
          if (file === '/usr/bin/say') {
            await fsPromises.writeFile(argv[outputIndex + 1], 'deterministic speech bytes')
          } else {
            await fsPromises.writeFile(argv.at(-1)!, 'deterministic mux bytes')
          }
          return { stdout: '', stderr: '' }
        }
      }
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('Samantha')
    expect(calls[1][calls[1].indexOf('-t') + 1]).toBe('30')
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      kind: 'taskwraith-studio-generated-speech-fixture',
      durationSeconds: 30,
      mimeType: 'video/mp4',
      expectedPhrases: expectedTranscriptPhrases(),
      sayExitCode: 0,
      muxExitCode: 0
    })
    expect(fixture.outputPath.startsWith(artifactRoot + path.sep)).toBe(true)
    expect(fixture.manifestPath.startsWith(artifactRoot + path.sep)).toBe(true)
    expect(JSON.parse(await fsPromises.readFile(fixture.manifestPath, 'utf8'))).toEqual(fixture)
  })

  it('does not seal a successful fixture manifest after a generator failure', async () => {
    const artifactRoot = await temporaryRoot('studio-acceptance-speech-red-')
    let calls = 0
    await expect(
      generateAcceptanceSpeechFixture(
        { artifactRoot },
        {
          execFile: async (file: string, args: string[]) => {
            calls += 1
            if (file === '/usr/bin/say') {
              await fsPromises.writeFile(args[args.indexOf('-o') + 1], 'speech')
              return { stdout: '', stderr: '' }
            }
            throw new Error('ffmpeg controlled failure')
          }
        }
      )
    ).rejects.toThrow(/ffmpeg controlled failure/)
    expect(calls).toBe(2)
    await expect(
      fsPromises.access(path.join(artifactRoot, 'fixtures', 'speech-fixture-manifest.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(process.platform !== 'win32')('shadows the interactive Grok usage probe inside the disposable HOME', async () => {
    const root = await temporaryRoot('studio-acceptance-provider-guard-')
    const home = path.join(root, 'home')

    const guard = await materializeIsolatedProviderGuards({ home })

    expect(guard.grokBinaryPath).toBe(path.join(home, '.grok', 'bin', 'grok'))
    expect(guard.sha256).toMatch(/^[a-f0-9]{64}$/)
    const stat = await fsPromises.stat(guard.grokBinaryPath)
    expect(stat.isFile()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o700)
    expect(await fsPromises.readFile(guard.grokBinaryPath, 'utf8')).toContain(
      'TaskWraith Studio isolated acceptance: provider probe disabled'
    )
  })

  it.runIf(process.platform !== 'win32')('finds a reparented group from an exact disposable-home command even when its leader hides the path', () => {
    const home = '/virtual/acceptance/prior/home'
    const rows = parseProcessTable(
      [
        '9000 1 9000 /Applications/Firefox.app/Contents/MacOS/firefox',
        `9001 9000 9000 /Applications/Firefox.app/Contents/MacOS/plugin-container -profile ${home}/Library/Application Support/Firefox/Profiles/fixture`,
        '9100 1 9100 /Applications/Firefox.app/Contents/MacOS/firefox'
      ].join('\n')
    )

    expect(findAcceptanceArtifactGroups(rows, [home])).toEqual([
      {
        pgid: 9000,
        evidencePids: [9001],
        members: [rows[0], rows[1]]
      }
    ])
  })

  it('derives only exact descendants when locating the Studio child', () => {
    const rows = parseProcessTable(
      [
        '100 1 100 /Applications/Electron',
        '101 100 100 /helper',
        '102 101 100 /TaskWraithStudioCompanion --viewer',
        '200 1 200 /TaskWraithStudioCompanion --unrelated'
      ].join('\n')
    )
    expect(descendantsOf(rows, 100).map((row) => row.pid)).toEqual([101, 102])
  })

  it('disconnects a watchdog controller whose launch handshake times out', async () => {
    const root = await temporaryRoot('studio-acceptance-watchdog-timeout-')
    const controller = new EventEmitter() as EventEmitter & {
      pid: number
      connected: boolean
      send: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
    }
    controller.pid = 6101
    controller.connected = true
    controller.send = vi.fn()
    controller.disconnect = vi.fn(() => {
      controller.connected = false
    })

    await expect(
      launchUnderWatchdog(buildStubSpec({ directory: root }), {
        fork: () => controller,
        launchTimeoutMs: 20
      })
    ).rejects.toThrow(/launch timed out/)
    expect(controller.disconnect).toHaveBeenCalledOnce()
  })

  it.runIf(process.platform !== 'win32')(
    'reaps the exact stub process group on a normal owner stop',
    async () => {
      const root = await temporaryRoot('studio-acceptance-watchdog-stop-')
      const spec = buildStubSpec({ directory: root, forceAfterMs: 250 })
      const session = await launchUnderWatchdog(spec, {
        controllerEnv: { TASKWRAITH_STUDIO_ACCEPTANCE_TEST: '1' }
      })
      expect(processIsAlive(session.pid)).toBe(true)
      const grandchild = await waitFor(async () => {
        try {
          return JSON.parse(await fsPromises.readFile(path.join(root, 'grandchild.json'), 'utf8'))
        } catch {
          return null
        }
      }, 'stub grandchild launch')
      expect(processIsAlive(grandchild.pid)).toBe(true)

      const terminal = await session.stop()
      expect(terminal).toMatchObject({ status: 'reaped', reason: 'owner_requested' })
      await waitFor(() => (processIsAlive(session.pid) ? null : true), 'stub process exit')
      await waitFor(
        () => (processIsAlive(grandchild.pid) ? null : true),
        'stub grandchild process-group exit'
      )

      const receipt = JSON.parse(await fsPromises.readFile(session.receiptPath, 'utf8'))
      expect(receipt).toMatchObject({
        status: 'reaped',
        childPid: session.pid,
        childPgid: session.pgid,
        reason: 'owner_requested'
      })
    }
  )

  it.runIf(process.platform !== 'win32')('refuses a detached group that contains an exact pre-launch baseline member', () => {
    const home = '/private/var/folders/acceptance/home'
    const baseline = {
      pid: 7001,
      ppid: 1,
      pgid: 7000,
      command: '/usr/bin/baseline-helper --serve'
    }
    const result = classifyDetachedArtifactGroups({
      rows: [
        baseline,
        {
          pid: 7002,
          ppid: 7001,
          pgid: 7000,
          command: `/usr/bin/node ${home}/detached-child.cjs`
        }
      ],
      artifactHomeAliases: [home],
      baselineRows: [baseline],
      childPgid: 6000,
      knownPgids: []
    })

    expect(result.authorizedGroups).toEqual([])
    expect(result.mixedOwnershipGroups).toEqual([
      { pgid: 7000, memberPids: [7001, 7002], baselinePids: [7001] }
    ])
  })

  it.runIf(process.platform !== 'win32')('does not confuse a reused pid with its changed process-row identity', () => {
    const home = '/private/var/folders/acceptance/home'
    const result = classifyDetachedArtifactGroups({
      rows: [
        {
          pid: 7101,
          ppid: 1,
          pgid: 7101,
          command: `/usr/bin/node ${home}/detached-child.cjs`
        }
      ],
      artifactHomeAliases: [home],
      baselineRows: [
        {
          pid: 7101,
          ppid: 7000,
          pgid: 7000,
          command: '/usr/bin/prelaunch-helper --idle'
        }
      ],
      childPgid: 6000,
      knownPgids: []
    })

    expect(result.mixedOwnershipGroups).toEqual([])
    expect(result.authorizedGroups).toMatchObject([
      { pgid: 7101, evidencePids: [7101], members: [{ pid: 7101 }] }
    ])
  })

  it.runIf(process.platform !== 'win32')('refuses an installed TaskWraith group even when another member references the disposable home', () => {
    const home = '/private/var/folders/acceptance/home'
    const result = classifyDetachedArtifactGroups({
      rows: [
        {
          pid: 7201,
          ppid: 1,
          pgid: 7201,
          command: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith'
        },
        {
          pid: 7202,
          ppid: 7201,
          pgid: 7201,
          command: `/usr/bin/helper --profile ${home}/browser`
        },
        {
          pid: 7301,
          ppid: 1,
          pgid: 7301,
          command:
            '/Applications/TaskWraith.app/Contents/Resources/studio/TaskWraith Studio.app/Contents/MacOS/TaskWraithStudioCompanion'
        },
        {
          pid: 7302,
          ppid: 7301,
          pgid: 7301,
          command: `/usr/bin/helper --profile ${home}/studio`
        }
      ],
      artifactHomeAliases: [home],
      baselineRows: [],
      childPgid: 6000,
      knownPgids: []
    })

    expect(result.authorizedGroups).toEqual([])
    expect(result.protectedInstalledGroups).toEqual([
      { pgid: 7201, memberPids: [7201, 7202] },
      { pgid: 7301, memberPids: [7301, 7302] }
    ])
  })

  it.runIf(process.platform !== 'win32')(
    'reaps a detached process group that remains bound to the disposable acceptance home',
    async () => {
      const root = await temporaryRoot('studio-acceptance-watchdog-detached-')
      const detachedBody = [
        "const fs=require('node:fs');",
        "const path=require('node:path');",
        'const home=__dirname;',
        "process.on('SIGTERM',()=>{});",
        "fs.writeFileSync(path.join(home,'detached-ready.json'),JSON.stringify({pid:process.pid})+'\\n');",
        'setInterval(()=>{},1000);'
      ].join('')
      const detachedScript = path.join(root, 'detached-child.cjs')
      await fsPromises.writeFile(detachedScript, detachedBody, 'utf8')
      const leaderBody = [
        "const fs=require('node:fs');",
        "const path=require('node:path');",
        "const {spawn}=require('node:child_process');",
        'const detachedScript=process.argv[1];',
        'const home=process.argv[2];',
        "const detached=spawn(process.execPath,[detachedScript],{detached:true,stdio:'ignore'});",
        'detached.unref();',
        "fs.writeFileSync(path.join(home,'detached.json'),JSON.stringify({pid:detached.pid})+'\\n');",
        "process.on('SIGTERM',()=>process.exit(0));",
        'setInterval(()=>{},1000);'
      ].join('')
      const spec = {
        kind: 'stub',
        command: process.execPath,
        args: ['-e', leaderBody, detachedScript, root],
        cwd: root,
        env: {
          TASKWRAITH_INSTANCE_ID: 'studioDetached',
          IOS_REMOTE_TRUE: '0',
          TASKWRAITH_STUDIO_COMPANION: '1',
          HOME: root
        },
        timeoutMs: 5_000,
        forceAfterMs: 250,
        receiptPath: path.join(root, 'watchdog-receipt.json')
      }
      const session = await launchUnderWatchdog(spec, {
        controllerEnv: { TASKWRAITH_STUDIO_ACCEPTANCE_TEST: '1' }
      })
      const detached = await waitFor(async () => {
        try {
          return JSON.parse(
            await fsPromises.readFile(path.join(root, 'detached-ready.json'), 'utf8')
          )
        } catch {
          return null
        }
      }, 'detached acceptance-owned process readiness')
      expect(processIsAlive(detached.pid)).toBe(true)

      try {
        const terminal = await session.stop()
        expect(terminal).toMatchObject({
          status: 'reaped',
          groupExitVerified: true,
          detachedGroupExitVerified: true
        })
        const receipt = JSON.parse(await fsPromises.readFile(session.receiptPath, 'utf8'))
        expect(receipt.artifactHome).toBe(await fsPromises.realpath(root))
        expect(receipt.artifactScanError).toBeUndefined()
        expect(receipt).toMatchObject({
          schemaVersion: 2,
          status: 'reaped',
          detachedGroupExitVerified: true,
          detachedProcessGroups: [
            {
              pgid: detached.pid,
              evidencePids: [detached.pid]
            }
          ]
        })
        await waitFor(() => {
          const rows = processGroupRows(detached.pid)
          if (rows.length > 0) throw new Error(JSON.stringify(rows))
          return true
        }, 'detached acceptance-owned process-group exit')
      } finally {
        try {
          process.kill(-detached.pid, 'SIGKILL')
        } catch {
          // Already gone, which is the expected outcome.
        }
        if (session.pgid) {
          try {
            process.kill(-session.pgid, 'SIGKILL')
          } catch {
            // Already gone, which is the expected outcome.
          }
        }
      }
    },
    12_000
  )

  it.runIf(process.platform !== 'win32')(
    'refuses to signal a known detached group after its disposable-home evidence disappears',
    async () => {
      const root = await temporaryRoot('studio-acceptance-watchdog-lost-ownership-')
      const detachedBody = [
        "const fs=require('node:fs');",
        "const path=require('node:path');",
        'const home=__dirname;',
        "process.on('SIGTERM',()=>{",
        "process.title='studio-lost-evidence';",
        "fs.writeFileSync(path.join(home,'lost-evidence.json'),JSON.stringify({pid:process.pid})+'\\n');",
        '});',
        "fs.writeFileSync(path.join(home,'detached-ready.json'),JSON.stringify({pid:process.pid})+'\\n');",
        'setInterval(()=>{},1000);'
      ].join('')
      const detachedScript = path.join(root, 'detached-child.cjs')
      await fsPromises.writeFile(detachedScript, detachedBody, 'utf8')
      const leaderBody = [
        "const fs=require('node:fs');",
        "const path=require('node:path');",
        "const {spawn}=require('node:child_process');",
        'const detachedScript=process.argv[1];',
        'const home=process.argv[2];',
        "const detached=spawn(process.execPath,[detachedScript],{detached:true,stdio:'ignore'});",
        'detached.unref();',
        "fs.writeFileSync(path.join(home,'detached.json'),JSON.stringify({pid:detached.pid})+'\\n');",
        "process.on('SIGTERM',()=>process.exit(0));",
        'setInterval(()=>{},1000);'
      ].join('')
      const spec = {
        kind: 'stub',
        command: process.execPath,
        args: ['-e', leaderBody, detachedScript, root],
        cwd: root,
        env: {
          TASKWRAITH_INSTANCE_ID: 'studioLostOwner',
          IOS_REMOTE_TRUE: '0',
          TASKWRAITH_STUDIO_COMPANION: '1',
          HOME: root
        },
        timeoutMs: 5_000,
        forceAfterMs: 250,
        receiptPath: path.join(root, 'watchdog-receipt.json')
      }
      const session = await launchUnderWatchdog(spec, {
        controllerEnv: { TASKWRAITH_STUDIO_ACCEPTANCE_TEST: '1' }
      })
      const detached = await waitFor(async () => {
        try {
          return JSON.parse(
            await fsPromises.readFile(path.join(root, 'detached-ready.json'), 'utf8')
          )
        } catch {
          return null
        }
      }, 'detached lost-ownership fixture readiness')

      try {
        const terminalPromise = session.stop()
        await waitFor(async () => {
          try {
            return JSON.parse(
              await fsPromises.readFile(path.join(root, 'lost-evidence.json'), 'utf8')
            )
          } catch {
            return null
          }
        }, 'detached fixture dropping disposable-home evidence')
        const terminal = await terminalPromise
        expect(terminal).toMatchObject({
          status: 'reap_incomplete',
          detachedGroupExitVerified: false
        })
        expect(processGroupRows(detached.pid).length).toBeGreaterThan(0)

        const receipt = JSON.parse(await fsPromises.readFile(session.receiptPath, 'utf8'))
        expect(receipt).toMatchObject({
          status: 'reap_incomplete',
          detachedGroupExitVerified: false,
          lostOwnershipGroups: [{ pgid: detached.pid, memberPids: [detached.pid] }]
        })
        expect(receipt.error).toMatch(/manual adjudication/)
        expect(receipt.detachedProcessGroups).toMatchObject([
          {
            pgid: detached.pid,
            evidencePids: [detached.pid]
          }
        ])
      } finally {
        try {
          process.kill(-detached.pid, 'SIGKILL')
        } catch {
          // The unsafe implementation kills this group; the corrected one leaves it for adjudication.
        }
        if (session.pgid) {
          try {
            process.kill(-session.pgid, 'SIGKILL')
          } catch {
            // Already gone, which is the expected outcome.
          }
        }
        await waitFor(() => {
          const rows = processGroupRows(detached.pid)
          if (rows.length > 0) throw new Error(JSON.stringify(rows))
          return true
        }, 'lost-ownership fixture cleanup')
      }
    },
    12_000
  )

  it.runIf(process.platform !== 'win32')(
    'reaps the exact stub group when the owner process dies without cleanup',
    async () => {
      const root = await temporaryRoot('studio-acceptance-watchdog-abandon-')
      const harnessPath = path.resolve(__dirname, '..', 'scripts', 'studio-acceptance-harness.cjs')
      const owner = spawn(process.execPath, [harnessPath, '--self-test-abandon-owner', root], {
        cwd: path.resolve(__dirname, '..'),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let ownerKilled = false
      let launched: {
        controllerPid: number
        childPid: number
        childPgid?: number
      } | null = null
      try {
        launched = await waitFor(async () => {
          try {
            return JSON.parse(await fsPromises.readFile(path.join(root, 'launched.json'), 'utf8'))
          } catch {
            return null
          }
        }, 'abandon-owner launch receipt')
        const grandchild = await waitFor(async () => {
          try {
            return JSON.parse(await fsPromises.readFile(path.join(root, 'grandchild.json'), 'utf8'))
          } catch {
            return null
          }
        }, 'abandon-owner grandchild launch')
        expect(processIsAlive(launched.childPid)).toBe(true)
        expect(processIsAlive(grandchild.pid)).toBe(true)

        ownerKilled = owner.kill('SIGKILL')
        expect(ownerKilled).toBe(true)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('owner did not exit after SIGKILL')),
            5_000
          )
          owner.once('exit', (_code, signal) => {
            clearTimeout(timer)
            expect(signal).toBe('SIGKILL')
            resolve()
          })
        })

        const terminal = await waitFor(async () => {
          try {
            const parsed = JSON.parse(
              await fsPromises.readFile(path.join(root, 'watchdog-receipt.json'), 'utf8')
            )
            return parsed.status === 'reaped' ? parsed : null
          } catch {
            return null
          }
        }, 'watchdog parent-death reaping')

        expect(terminal).toMatchObject({
          status: 'reaped',
          controllerPid: launched.controllerPid,
          childPid: launched.childPid,
          childPgid: launched.childPgid,
          reason: 'owner_disconnected'
        })
        await waitFor(
          () => (processIsAlive(launched.childPid) || processIsAlive(grandchild.pid) ? null : true),
          'entire abandoned stub process group exit'
        )
        await waitFor(
          () => (processIsAlive(launched.controllerPid) ? null : true),
          'watchdog controller exit'
        )
      } finally {
        if (!ownerKilled && processIsAlive(owner.pid!)) owner.kill('SIGKILL')
        if (launched?.childPgid) {
          try {
            process.kill(-launched.childPgid, 'SIGKILL')
          } catch {
            // Already gone, which is the expected outcome.
          }
        }
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'refuses to report a clean reap while a SIGTERM-ignoring descendant survives',
    async () => {
      const root = await temporaryRoot('studio-acceptance-watchdog-stubborn-')
      const spec = buildStubSpec({ directory: root, forceAfterMs: 250, stubbornGrandchild: true })
      const session = await launchUnderWatchdog(spec, {
        controllerEnv: { TASKWRAITH_STUDIO_ACCEPTANCE_TEST: '1' }
      })
      // Wait for the grandchild's OWN announcement: it is only stubborn once it
      // has installed its SIGTERM handler, and the leader writes its pid before
      // that runtime exists.
      const grandchild = await waitFor(async () => {
        try {
          return JSON.parse(
            await fsPromises.readFile(path.join(root, 'grandchild-ready.json'), 'utf8')
          )
        } catch {
          return null
        }
      }, 'stubborn grandchild readiness')
      expect(processIsAlive(grandchild.pid)).toBe(true)

      try {
        // The group leader dies on SIGTERM; this grandchild ignores it. A
        // terminal `reaped` is only honest once the exact group is gone.
        const terminalPromise = session.stop()
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(processIsAlive(grandchild.pid)).toBe(true)
        const terminal = await terminalPromise
        expect(terminal).toMatchObject({ status: 'reaped', groupExitVerified: true })
        await waitFor(
          () => (processIsAlive(grandchild.pid) ? null : true),
          'stubborn grandchild process-group exit'
        )

        const receipt = JSON.parse(await fsPromises.readFile(session.receiptPath, 'utf8'))
        expect(receipt).toMatchObject({
          schemaVersion: 2,
          status: 'reaped',
          groupExitVerified: true,
          groupRequiredForceKill: true
        })
      } finally {
        if (session.pgid) {
          try {
            process.kill(-session.pgid, 'SIGKILL')
          } catch {
            // Already gone, which is the expected outcome.
          }
        }
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'allows the exact group its configured grace interval before forcing it down',
    async () => {
      const root = await temporaryRoot('studio-acceptance-watchdog-grace-')
      const spec = buildStubSpec({
        directory: root,
        forceAfterMs: 500,
        grandchildGracefulExitMs: 150
      })
      const session = await launchUnderWatchdog(spec, {
        controllerEnv: { TASKWRAITH_STUDIO_ACCEPTANCE_TEST: '1' }
      })
      const grandchild = await waitFor(async () => {
        try {
          return JSON.parse(
            await fsPromises.readFile(path.join(root, 'grandchild-ready.json'), 'utf8')
          )
        } catch {
          return null
        }
      }, 'graceful grandchild readiness')

      try {
        const terminal = await session.stop()
        expect(terminal).toMatchObject({
          status: 'reaped',
          reason: 'owner_requested',
          groupExitVerified: true
        })
        await waitFor(
          () => (processIsAlive(grandchild.pid) ? null : true),
          'graceful grandchild process-group exit'
        )
        const receipt = JSON.parse(await fsPromises.readFile(session.receiptPath, 'utf8'))
        expect(receipt).toMatchObject({
          schemaVersion: 2,
          status: 'reaped',
          groupExitVerified: true
        })
        expect(receipt.groupRequiredForceKill).not.toBe(true)
      } finally {
        if (session.pgid) {
          try {
            process.kill(-session.pgid, 'SIGKILL')
          } catch {
            // Already gone, which is the expected outcome.
          }
        }
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'refuses a launch while a prior receipt names a still-live group, and never kills it',
    async () => {
      const root = await temporaryRoot('studio-acceptance-orphan-live-')
      const acceptanceRoot = path.join(root, 'acceptance')
      await fsPromises.mkdir(path.join(acceptanceRoot, 'studioPrior01'), { recursive: true })
      const orphan = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true,
        stdio: 'ignore'
      })
      orphan.unref()
      try {
        // A detached child leads its own group, so pgid === pid. The receipt
        // claims `reaped` on purpose: that is exactly the false-green shape.
        await fsPromises.writeFile(
          path.join(acceptanceRoot, 'studioPrior01', 'watchdog-receipt.json'),
          JSON.stringify({
            kind: 'taskwraith-studio-acceptance-watchdog',
            schemaVersion: 1,
            status: 'reaped',
            childPid: orphan.pid,
            childPgid: orphan.pid
          })
        )

        await expect(
          assertNoPriorStudioOrphans({ artifactRoot: path.join(acceptanceRoot, 'studioNow01') })
        ).rejects.toThrow(/still alive/)
        expect(processIsAlive(orphan.pid!)).toBe(true)
      } finally {
        try {
          process.kill(orphan.pid!, 'SIGKILL')
        } catch {
          // Already gone.
        }
        await waitFor(() => (processIsAlive(orphan.pid!) ? null : true), 'orphan fixture exit')
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'trusts a v2 receipt that verified its own group exit, so a reused pgid cannot block forever',
    async () => {
      const root = await temporaryRoot('studio-acceptance-orphan-trusted-')
      const acceptanceRoot = path.join(root, 'acceptance')
      await fsPromises.mkdir(path.join(acceptanceRoot, 'studioPrior02'), { recursive: true })
      const reused = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true,
        stdio: 'ignore'
      })
      reused.unref()
      try {
        await fsPromises.writeFile(
          path.join(acceptanceRoot, 'studioPrior02', 'watchdog-receipt.json'),
          JSON.stringify({
            kind: 'taskwraith-studio-acceptance-watchdog',
            schemaVersion: 2,
            status: 'reaped',
            groupExitVerified: true,
            childPid: reused.pid,
            childPgid: reused.pid
          })
        )

        await expect(
          assertNoPriorStudioOrphans({ artifactRoot: path.join(acceptanceRoot, 'studioNow02') })
        ).resolves.toMatchObject({ trusted: 1, orphans: [] })
      } finally {
        try {
          process.kill(reused.pid!, 'SIGKILL')
        } catch {
          // Already gone.
        }
        await waitFor(
          () => (processIsAlive(reused.pid!) ? null : true),
          'reused process-group fixture exit'
        )
      }
    }
  )

  it.runIf(process.platform !== 'win32')('refuses a trusted prior receipt when a detached process group still references that artifact home', async () => {
    const receiptPath = '/virtual/acceptance/prior/watchdog-receipt.json'
    const priorHome = '/virtual/acceptance/prior/home'
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.some((argument) => argument.includes('command='))) {
        return {
          stdout: [
            '9000 1 9000 /Applications/Firefox.app/Contents/MacOS/firefox',
            `9001 9000 9000 /Applications/Firefox.app/Contents/MacOS/plugin-container -profile ${priorHome}/Library/Application Support/Firefox/Profiles/acceptance`
          ].join('\\n'),
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      assertNoPriorStudioOrphans(
        { artifactRoot: '/virtual/acceptance/current' },
        {
          readPriorReceipts: async () => [
            {
              receiptPath,
              receipt: {
                kind: 'taskwraith-studio-acceptance-watchdog',
                schemaVersion: 2,
                status: 'reaped',
                groupExitVerified: true,
                childPid: 8000,
                childPgid: 8000
              }
            }
          ],
          execFile
        }
      )
    ).rejects.toThrow(/artifact-bound.*still alive|detached/i)
  })

  it.runIf(process.platform !== 'win32')('excludes the owner installed TaskWraith Studio group from a legacy pgid collision without signaling it', async () => {
    const installedPgid = 93870
    const execFile = vi.fn(async () => ({
      stdout: [
        `${installedPgid} 1 ${installedPgid} /Applications/TaskWraith.app/Contents/MacOS/TaskWraith`,
        `95216 ${installedPgid} ${installedPgid} /Applications/TaskWraith.app/Contents/Resources/studio/TaskWraith Studio.app/Contents/MacOS/TaskWraithStudioCompanion`
      ].join('\n'),
      stderr: ''
    }))

    await expect(
      assertNoPriorStudioOrphans(
        { artifactRoot: '/virtual/acceptance/studioNowInstalled' },
        {
          readPriorReceipts: async () => [
            {
              receiptPath: '/virtual/acceptance/prior/watchdog-receipt.json',
              receipt: {
                kind: 'taskwraith-studio-acceptance-watchdog',
                schemaVersion: 1,
                status: 'reaped',
                childPid: installedPgid,
                childPgid: installedPgid
              }
            }
          ],
          execFile
        }
      )
    ).resolves.toMatchObject({
      orphans: [],
      protectedInstalledGroups: [
        {
          receiptPath: '/virtual/acceptance/prior/watchdog-receipt.json',
          pgid: installedPgid,
          memberPids: [installedPgid, 95216]
        }
      ]
    })
    expect(execFile).toHaveBeenCalledOnce()
    expect(execFile).toHaveBeenCalledWith('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,command='])
  })

  it.runIf(process.platform !== 'win32')('does not exempt a Studio-looking descendant unless the exact installed app owns the group', async () => {
    const acceptancePgid = 93871

    await expect(
      assertNoPriorStudioOrphans(
        { artifactRoot: '/virtual/acceptance/studioNowUntrusted' },
        {
          readPriorReceipts: async () => [
            {
              receiptPath: '/virtual/acceptance/prior/watchdog-receipt.json',
              receipt: {
                kind: 'taskwraith-studio-acceptance-watchdog',
                schemaVersion: 1,
                status: 'reaped',
                childPid: acceptancePgid,
                childPgid: acceptancePgid
              }
            }
          ],
          execFile: async () => ({
            stdout: [
              `${acceptancePgid} 1 ${acceptancePgid} /virtual/acceptance/Electron`,
              `95217 ${acceptancePgid} ${acceptancePgid} /Applications/TaskWraith.app/Contents/Resources/studio/TaskWraith Studio.app/Contents/MacOS/TaskWraithStudioCompanion`
            ].join('\n'),
            stderr: ''
          })
        }
      )
    ).rejects.toThrow(/still alive/)
  })

  it.runIf(process.platform !== 'win32')('fails closed when a prior watchdog receipt cannot be read', async () => {
    const root = await temporaryRoot('studio-acceptance-orphan-malformed-')
    const acceptanceRoot = path.join(root, 'acceptance')
    await fsPromises.mkdir(path.join(acceptanceRoot, 'studioPrior03'), { recursive: true })
    await fsPromises.writeFile(
      path.join(acceptanceRoot, 'studioPrior03', 'watchdog-receipt.json'),
      'this is not a receipt'
    )

    await expect(
      assertNoPriorStudioOrphans({ artifactRoot: path.join(acceptanceRoot, 'studioNow03') })
    ).rejects.toThrow(/could not be read/)
  })

  it.runIf(process.platform !== 'win32').each([
    [
      'wrong kind',
      {
        kind: 'unrelated-receipt',
        schemaVersion: 2,
        status: 'reaped',
        groupExitVerified: true,
        childPid: 8101,
        childPgid: 8101
      }
    ],
    [
      'future schema',
      {
        kind: 'taskwraith-studio-acceptance-watchdog',
        schemaVersion: 3,
        status: 'reaped',
        groupExitVerified: true,
        childPid: 8102,
        childPgid: 8102
      }
    ],
    [
      'missing process group identity',
      {
        kind: 'taskwraith-studio-acceptance-watchdog',
        schemaVersion: 2,
        status: 'reaped',
        groupExitVerified: true,
        childPid: 8103,
        childPgid: null
      }
    ]
  ])('fails closed for a prior watchdog receipt with %s', async (_label, receipt) => {
    await expect(
      assertNoPriorStudioOrphans(
        { artifactRoot: '/virtual/acceptance/studioNow04' },
        {
          readPriorReceipts: async () => [
            { receiptPath: '/virtual/acceptance/prior/watchdog-receipt.json', receipt }
          ]
        }
      )
    ).rejects.toThrow(/could not be read/)
  })

  it.runIf(process.platform !== 'win32')('does not trust a non-terminal v2 receipt merely because it claims group verification', async () => {
    await expect(
      assertNoPriorStudioOrphans(
        { artifactRoot: '/virtual/acceptance/studioNow05' },
        {
          readPriorReceipts: async () => [
            {
              receiptPath: '/virtual/acceptance/prior/watchdog-receipt.json',
              receipt: {
                kind: 'taskwraith-studio-acceptance-watchdog',
                schemaVersion: 2,
                status: 'running',
                groupExitVerified: true,
                childPid: 8104,
                childPgid: 8104
              }
            }
          ],
          execFile: async () => ({ stdout: '8104 1 8104 /usr/bin/node\n', stderr: '' })
        }
      )
    ).rejects.toThrow(/still alive/)
  })

  it('builds a bounded exact-window driver request and refuses unsafe targets', () => {
    const target = {
      companion: {
        pid: 7002,
        ppid: 7001,
        pgid: 7001,
        command: '/virtual/TaskWraithStudioCompanion --viewer'
      },
      electronPgid: 7001,
      window: {
        pid: 7002,
        visibleWindowCount: 1,
        windows: [
          {
            windowId: 42,
            title: 'TaskWraith Studio',
            bounds: { x: 100, y: 120, width: 1280, height: 720 }
          }
        ]
      },
      artifactRoot: '/virtual/acceptance/studioDriver01'
    }
    const foregroundInput = {
      inputDelivery: 'foreground-global-explicit',
      allowForegroundInput: true
    }
    expect(
      buildStudioUiDriverRequest({
        ...target,
        ...foregroundInput,
        actions: [
          { type: 'key', key: 'tab' },
          { type: 'key', key: 'return' }
        ]
      })
    ).toMatchObject({
      schemaVersion: 1,
      inputDelivery: 'foreground-global-explicit',
      allowForegroundInput: true,
      expectedPid: 7002,
      expectedPgid: 7001,
      windowId: 42,
      windowTitle: 'TaskWraith Studio',
      actions: [
        { type: 'key', key: 'tab' },
        { type: 'key', key: 'return' }
      ]
    })
    const timecodeActions = [...'0123456789'].map((key) => ({ type: 'key', key }))
    expect(
      buildStudioUiDriverRequest({
        ...target,
        ...foregroundInput,
        actions: [...timecodeActions, { type: 'key', key: 'return' }]
      })
    ).toMatchObject({
      actions: [...timecodeActions, { type: 'key', key: 'return' }]
    })
    expect(
      buildStudioUiDriverRequest({
        ...target,
        ...foregroundInput,
        actions: [{ type: 'key', key: 'shift-left' }]
      })
    ).toMatchObject({
      actions: [{ type: 'key', key: 'shift-left' }]
    })
    expect(() =>
      buildStudioUiDriverRequest({
        ...target,
        actions: [{ type: 'click', xFraction: 0.884, yFraction: 0.895 }]
      })
    ).toThrow(/background observation refuses keyboard and pointer/)
    expect(
      buildStudioUiDriverRequest({
        ...target,
        inputDelivery: 'foreground-global-explicit',
        allowForegroundInput: true,
        actions: [{ type: 'click', xFraction: 0.884, yFraction: 0.895 }]
      })
    ).toMatchObject({
      inputDelivery: 'foreground-global-explicit',
      actions: [{ type: 'click', xFraction: 0.884, yFraction: 0.895 }]
    })
    expect(() =>
      buildStudioUiDriverRequest({
        ...target,
        inputDelivery: 'foreground-global-explicit',
        actions: [{ type: 'click', xFraction: 0.884, yFraction: 0.895 }]
      })
    ).toThrow(/explicit per-call interactive opt-in/)
    expect(
      buildStudioUiDriverRequest({
        ...target,
        inputDelivery: 'foreground-global-explicit',
        allowForegroundInput: true,
        actions: [{ type: 'key', key: 'tab' }]
      })
    ).toMatchObject({
      inputDelivery: 'foreground-global-explicit',
      actions: [{ type: 'key', key: 'tab' }]
    })
    expect(() =>
      buildStudioUiDriverRequest({
        ...target,
        inputDelivery: 'unbounded',
        actions: [{ type: 'key', key: 'tab' }]
      })
    ).toThrow(/unknown input-delivery mode/)
    expect(() =>
      buildStudioUiDriverRequest({
        ...target,
        inputDelivery: 'foreground-global-explicit',
        allowForegroundInput: true,
        actions: [{ type: 'click', xFraction: 1.1, yFraction: 0.5 }]
      })
    ).toThrow(/unsupported UI action/)
    expect(
      buildStudioUiDriverRequest({
        ...target,
        actions: [{ type: 'audio-probe', durationSeconds: 2 }]
      })
    ).toMatchObject({
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false,
      actions: [{ type: 'audio-probe', durationSeconds: 2 }]
    })
    expect(
      buildStudioUiDriverRequest({
        ...target,
        actions: [
          {
            type: 'press-playback',
            playbackValueBefore: 'paused',
            playbackValueAfter: 'playing'
          }
        ]
      })
    ).toMatchObject({
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false,
      actions: [
        {
          type: 'press-playback',
          accessibilityLabel: 'Playback',
          accessibilityAction: 'AXPress',
          playbackValueBefore: 'paused',
          playbackValueAfter: 'playing'
        }
      ]
    })
    expect(
      buildStudioUiDriverRequest({
        ...target,
        actions: [
          {
            type: 'press-playback',
            playbackValueBefore: 'playing',
            playbackValueAfter: 'paused'
          }
        ]
      })
    ).toMatchObject({
      actions: [
        {
          playbackValueBefore: 'playing',
          playbackValueAfter: 'paused'
        }
      ]
    })
    for (const action of [
      { type: 'press-playback', playbackValueBefore: 'paused' },
      {
        type: 'press-playback',
        playbackValueBefore: 'paused',
        playbackValueAfter: 'paused'
      },
      {
        type: 'press-playback',
        playbackValueBefore: 'stopped',
        playbackValueAfter: 'playing'
      }
    ]) {
      expect(() => buildStudioUiDriverRequest({ ...target, actions: [action] })).toThrow(
        /unsupported UI action/
      )
    }
    expect(
      buildStudioUiDriverRequest({
        ...target,
        actions: [
          {
            type: 'set-playhead-ticks',
            playheadTicks: 241_000,
            playheadToleranceTicks: 50_000
          }
        ]
      })
    ).toMatchObject({
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false,
      actions: [
        {
          type: 'set-playhead-ticks',
          playheadTicks: 241_000,
          playheadToleranceTicks: 50_000,
          playheadMaximumForwardAdvanceTicks: 0
        }
      ]
    })
    expect(
      buildStudioUiDriverRequest({
        ...target,
        actions: [
          {
            type: 'set-playhead-ticks',
            playheadTicks: 241_000,
            playheadToleranceTicks: 50_000,
            playheadMaximumForwardAdvanceTicks: 1_000_000
          }
        ]
      })
    ).toMatchObject({
      actions: [
        {
          type: 'set-playhead-ticks',
          playheadMaximumForwardAdvanceTicks: 1_000_000
        }
      ]
    })
    for (const playheadMaximumForwardAdvanceTicks of [-1, 1_000_001, 1.5]) {
      expect(() =>
        buildStudioUiDriverRequest({
          ...target,
          actions: [
            {
              type: 'set-playhead-ticks',
              playheadTicks: 241_000,
              playheadMaximumForwardAdvanceTicks
            }
          ]
        })
      ).toThrow(/unsupported UI action/)
    }
    expect(() =>
      buildStudioUiDriverRequest({
        ...target,
        actions: [
          {
            type: 'set-playhead-ticks',
            playheadTicks: 241_000,
            playheadToleranceTicks: 50_001
          }
        ]
      })
    ).toThrow(/unsupported UI action/)
    expect(() =>
      buildStudioUiDriverRequest({
        ...target,
        actions: [{ type: 'set-playhead-ticks', playheadTicks: -1 }]
      })
    ).toThrow(/unsupported UI action/)
    expect(
      buildStudioUiDriverRequest({
        ...target,
        actions: [{ type: 'step-playhead-frame', playheadStepFrames: -1 }]
      })
    ).toMatchObject({
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false,
      actions: [{ type: 'step-playhead-frame', playheadStepFrames: -1 }]
    })
    expect(() =>
      buildStudioUiDriverRequest({
        ...target,
        actions: [{ type: 'step-playhead-frame', playheadStepFrames: -2 }]
      })
    ).toThrow(/unsupported UI action/)
    expect(() =>
      buildStudioUiDriverRequest({
        ...target,
        actions: [{ type: 'audio-probe', durationSeconds: 0 }]
      })
    ).toThrow(/unsupported UI action/)
    expect(() =>
      buildStudioUiDriverRequest({
        ...target,
        actions: [{ type: 'audio-probe', durationSeconds: 601 }]
      })
    ).toThrow(/unsupported UI action/)
    const dualWindowTarget = {
      ...target,
      window: {
        ...target.window,
        visibleWindowCount: 2,
        windows: [
          ...target.window.windows,
          {
            windowId: 43,
            title: 'TaskWraith Studio — Review',
            bounds: { x: 101, y: 121, width: 1280, height: 720 }
          }
        ]
      }
    }
    expect(
      buildStudioUiDriverRequest({
        ...dualWindowTarget,
        ...foregroundInput,
        expectedWindowTitle: 'TaskWraith Studio — Review',
        actions: [{ type: 'key', key: 'a' }]
      })
    ).toMatchObject({ windowId: 43, windowTitle: 'TaskWraith Studio — Review' })
    expect(() =>
      buildStudioUiDriverRequest({
        ...dualWindowTarget,
        actions: [{ type: 'key', key: 'a' }]
      })
    ).toThrow(/one exact visible window identity/)
    expect(() =>
      buildStudioUiDriverRequest({
        ...target,
        companion: { ...target.companion, pgid: 9999 },
        actions: [{ type: 'key', key: 'tab' }]
      })
    ).toThrow(/process group/)
    expect(() =>
      buildStudioUiDriverRequest({
        ...target,
        companion: {
          ...target.companion,
          command:
            '/Applications/TaskWraith.app/Contents/Resources/studio/TaskWraith Studio.app/Contents/MacOS/TaskWraithStudioCompanion --viewer'
        },
        actions: [{ type: 'key', key: 'tab' }]
      })
    ).toThrow(/installed TaskWraith/)
    expect(
      buildStudioUiDriverRequest({
        ...target,
        actions: [
          { type: 'read-av-sync', callerControlledValue: 'must-be-ignored' },
          { type: 'coreaudio-route-health', callerControlledValue: 'must-be-ignored' }
        ]
      })
    ).toMatchObject({
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false,
      actions: [{ type: 'read-av-sync' }, { type: 'coreaudio-route-health' }]
    })
    expect(
      buildStudioUiDriverRequest({
        ...target,
        actions: [
          {
            type: 'read-transport-mutation',
            accessibilityLabel: 'caller-must-not-control-this',
            accessibilityValue: 'caller-must-not-control-this'
          }
        ]
      })
    ).toMatchObject({
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false,
      actions: [
        {
          type: 'read-transport-mutation',
          accessibilityLabel: 'Transport mutation detail'
        }
      ]
    })
    expect(() =>
      buildStudioUiDriverRequest({ ...target, actions: [{ type: 'key', key: 'delete-all' }] })
    ).toThrow(/unsupported UI action/)
  })

  it('parses only the exact ordered tm1 schema and recomputes its derived bits', () => {
    expect(parseStudioTransportMutationText(validTransportMutationText)).toMatchObject({
      schema: 'tm1',
      kind: 'lifecycleAttach',
      route: 'review',
      beforeSource: 'audio',
      afterSource: 'audio',
      suppliedHostSeconds: 4.125,
      previousHostSeconds: null,
      beforeAnchorTicks: '2000000',
      afterAnchorTicks: '2062500',
      crossedDomain: false,
      clamped: false
    })

    const oscillator = validTransportMutationText
      .replace('kind=lifecycleAttach', 'kind=oscillatorReconciliation')
      .replace('postSrc=audio', 'postSrc=machine')
      .replace('prevHost=-', 'prevHost=4.000000')
      .replace('crossedDomain=0', 'crossedDomain=1')
    expect(parseStudioTransportMutationText(oscillator)).toMatchObject({
      kind: 'oscillatorReconciliation',
      beforeSource: 'audio',
      afterSource: 'machine',
      previousHostSeconds: 4,
      crossedDomain: true
    })

    const audioRescheduleMachineToAudio = validTransportMutationText
      .replace('kind=lifecycleAttach', 'kind=audioReschedule')
      .replace('preSrc=audio', 'preSrc=machine')
      .replace('prevHost=-', 'prevHost=88234.125000')
      .replace('crossedDomain=0', 'crossedDomain=1')
    expect(parseStudioTransportMutationText(audioRescheduleMachineToAudio)).toMatchObject({
      kind: 'audioReschedule',
      beforeSource: 'machine',
      afterSource: 'audio',
      previousHostSeconds: 88_234.125,
      crossedDomain: true
    })

    const audioRescheduleAudioToAudio = validTransportMutationText
      .replace('kind=lifecycleAttach', 'kind=audioReschedule')
      .replace('prevHost=-', 'prevHost=4.000000')
    expect(parseStudioTransportMutationText(audioRescheduleAudioToAudio)).toMatchObject({
      kind: 'audioReschedule',
      beforeSource: 'audio',
      afterSource: 'audio',
      previousHostSeconds: 4,
      crossedDomain: false
    })

    const clamped = validTransportMutationText
      .replace('postAnchorT=2062500', 'postAnchorT=300000000')
      .replace('clamped=0', 'clamped=1')
    expect(parseStudioTransportMutationText(clamped)).toMatchObject({ clamped: true })

    for (const malformed of [
      '',
      validTransportMutationText.replace('kind=lifecycleAttach', 'kind=unknown'),
      validTransportMutationText.replace(
        'kind=lifecycleAttach route=review',
        'route=review kind=lifecycleAttach'
      ),
      validTransportMutationText.replace('host=4.125000', 'host=NaN'),
      validTransportMutationText.replace('preRate=1.000', 'preRate=Infinity'),
      validTransportMutationText.replace('preAnchorT=2000000', 'preAnchorT=01'),
      validTransportMutationText.replace('preAnchorT=2000000', 'preAnchorT=9223372036854775808'),
      validTransportMutationText.replace('prePlay=1', 'prePlay=true'),
      validTransportMutationText.replace('crossedDomain=0', 'crossedDomain=1'),
      validTransportMutationText.replace('clamped=0', 'clamped=1'),
      validTransportMutationText.replace('route=review', 'route=other'),
      validTransportMutationText.replace('postSrc=audio', 'postSrc=machine'),
      validTransportMutationText.replace('prevHost=-', 'prevHost=4.000000'),
      oscillator.replace('prevHost=4.000000', 'prevHost=-'),
      audioRescheduleAudioToAudio.replace('prevHost=4.000000', 'prevHost=-'),
      audioRescheduleAudioToAudio
        .replace('postSrc=audio', 'postSrc=machine')
        .replace('crossedDomain=0', 'crossedDomain=1')
    ]) {
      expect(() => parseStudioTransportMutationText(malformed)).toThrow(/tm1/)
    }
  })

  /// THE ABSOLUTE CAP IS NOT A BOUND ON A SMALL ASSET.
  ///
  /// 1,000,000 ticks is about two seconds on the 500 kHz fixture and fifty-five
  /// times the ENTIRE 18,000-tick asset. Since the settled() predicate allows
  /// `candidate - ticks <= tolerance + envelope`, a cap that exceeds the span
  /// lets any observation on a low-timescale asset satisfy the check, so a
  /// failed or wildly short seek reports settled. The guard therefore has to be
  /// relative to the live range, and it has to sit where that range is already
  /// read.
  it('bounds the forward envelope against the live slider span, not only the absolute cap', async () => {
    const driverSource = await fsPromises.readFile(
      path.resolve(__dirname, 'studio-acceptance-ui-driver.swift'),
      'utf8'
    )

    // Pinned at the exact expression: a dropped clause, a flipped comparison or
    // a renamed divisor all fail here. This arm is source-pinned because the
    // guard needs a live AXUIElement and cannot be invoked from a unit test.
    expect(driverSource).toContain(
      'maximumForwardAdvanceTicks <= (maximum - minimum) / playheadForwardAdvanceRangeDivisor'
    )
    // The absolute cap stays as the backstop; the range bound is additional.
    expect(driverSource).toContain('maximumForwardAdvanceTicks <= 1_000_000')

    const divisor = Number(
      driverSource.match(/let playheadForwardAdvanceRangeDivisor: Int64 = (\d+)/)?.[1]
    )
    expect(Number.isSafeInteger(divisor)).toBe(true)
    // A divisor of 1 would readmit the whole span and restore the defect.
    expect(divisor).toBeGreaterThanOrEqual(100)

    // Executable arm: the same arithmetic the shipped guard runs, driven by the
    // divisor read out of the driver rather than a number retyped here, so a
    // drifted constant changes these outcomes rather than passing silently.
    const permits = (span: number, envelope: number): boolean =>
      envelope <= Math.floor(span / divisor)

    // The reported false-green, on the exact low-timescale asset that exposed it.
    expect(permits(18_000, 1_000_000)).toBe(false)
    // A proportionate envelope on that same asset remains usable.
    expect(permits(18_000, 180)).toBe(true)
    // The proven 500 kHz seek is unaffected.
    expect(permits(300_000_000, 500_000)).toBe(true)
    // Default zero stays valid on every timebase — paused callers are untouched.
    expect(permits(18_000, 0)).toBe(true)
    expect(permits(300_000_000, 0)).toBe(true)
  })

  it('makes background mode observation-only and gates every interactive path explicitly', async () => {
    const driverSource = await fsPromises.readFile(
      path.resolve(__dirname, 'studio-acceptance-ui-driver.swift'),
      'utf8'
    )

    expect(driverSource.match(/\.postToPid\(pid_t\(request\.expectedPid\)\)/g)).toHaveLength(2)
    expect(driverSource.match(/\.post\(tap: \.cghidEventTap\)/g)).toHaveLength(2)
    expect(driverSource).toContain('(request.inputDelivery == "background-observation-only" ||')
    expect(driverSource).toContain('((request.inputDelivery == "background-observation-only" &&')
    expect(driverSource).toContain('request.allowForegroundInput &&')
    expect(driverSource).toContain(
      'if request.inputDelivery == "foreground-global-explicit" {\n' +
        '        try activateExactWindowForExplicitForeground('
    )
    expect(driverSource).toContain(
      'action.type == "click",\n' +
        '                  request.inputDelivery == "foreground-global-explicit"'
    )
    expect(driverSource).toContain(
      'action.type == "set-playhead-ticks",\n' +
        '                  request.inputDelivery == "background-observation-only"'
    )
    expect(driverSource).toContain(
      'action.type == "press-playback",\n' +
        '           request.inputDelivery == "background-observation-only"'
    )
    expect(driverSource).toContain('func exactAccessibilityPlaybackControl(')
    expect(driverSource).toContain('kAXButtonRole')
    expect(driverSource).toContain('kAXPressAction')
    expect(driverSource).toContain(
      'AXUIElementPerformAction(playback, kAXPressAction as CFString) == .success'
    )
    expect(driverSource).toContain('accessibilityLabel == "Playback"')
    expect(driverSource).toContain('playbackValueBefore == observedBefore')
    expect(driverSource).toContain('playbackValueAfter == observedAfter')
    const playbackPressStart = driverSource.indexOf('func pressAccessibilityPlayback(')
    const playbackPressEnd = driverSource.indexOf(
      'func activateExactWindowForExplicitForeground(',
      playbackPressStart
    )
    const playbackPressSource = driverSource.slice(playbackPressStart, playbackPressEnd)
    expect(playbackPressSource).toContain('let freshWindow = try exactAccessibilityWindow(request)')
    expect(playbackPressSource).toContain('lastObservationFailure')
    expect(playbackPressSource).not.toContain('try? exactAccessibilityPlaybackControl')
    expect(driverSource).toContain('taskwraith-studio-ui-driver-refusal')
    expect(driverSource).toContain('Playback accessibility control is absent')
    expect(driverSource).toContain('Playback accessibility control is duplicated')
    expect(driverSource).toContain('Playback accessibility control is not an AXButton')
    expect(driverSource).toContain('Playback accessibility control has no AXPress action')
    expect(driverSource).toContain('Playback accessibility value is unreadable')
    expect(driverSource).toContain(
      'let playheadMaximumForwardAdvanceTicks =\n' +
        '                action.playheadMaximumForwardAdvanceTicks ?? 0'
    )
    expect(driverSource).toContain('maximumForwardAdvanceTicks <= 1_000_000')
    expect(driverSource).toContain(
      'candidate - ticks <= toleranceTicks + maximumForwardAdvanceTicks'
    )
    expect(driverSource).toContain(': ticks - candidate <= toleranceTicks')
    expect(driverSource).toContain('foregroundAfter == foregroundBefore')
    const transportReadStart = driverSource.indexOf('func exactAccessibilityTransportMutation(')
    const transportReadEnd = driverSource.indexOf(
      '/// The forward-advance envelope',
      transportReadStart
    )
    const transportReadSource = driverSource.slice(transportReadStart, transportReadEnd)
    expect(transportReadStart).toBeGreaterThan(0)
    expect(transportReadSource).toContain('kAXStaticTextRole')
    expect(driverSource).toContain(
      'let transportMutationAccessibilityLabel = "Transport mutation detail"'
    )
    expect(transportReadSource).toContain('matches.count == 1')
    expect(transportReadSource).toContain('stringAttribute(kAXValueAttribute, of: element)')
    expect(transportReadSource).toContain(
      'guard visited + queue.count + children.count <= 512 else'
    )
    expect(transportReadSource).toContain('Transport mutation accessibility tree exceeds 512')
    expect(transportReadSource).toContain('foregroundAfter == foregroundBefore')
    expect(transportReadSource).toContain('pgidAfter == pgidBefore')
    expect(transportReadSource).toContain('executableAfter == executableBefore')
    expect(transportReadSource).not.toContain('AXUIElementPerformAction')
    expect(driverSource).not.toContain('validateAccessibilityWindow')
  })

  it('waits for a real nonempty transcript journal operation', async () => {
    const root = await temporaryRoot('studio-acceptance-transcript-journal-')
    const studioStateDirectory = path.join(root, 'studio-companion')
    await fsPromises.mkdir(studioStateDirectory, { recursive: true })
    await fsPromises.writeFile(
      path.join(studioStateDirectory, 'studio-project.journal.jsonl'),
      [
        JSON.stringify({
          format: 'taskwraith-studio-journal',
          v: 1,
          revision: 1,
          op: { type: 'set_transcript', transcript: { assetId: 'asset-a', segments: [] } }
        }),
        JSON.stringify({
          format: 'taskwraith-studio-journal',
          v: 1,
          revision: 2,
          op: {
            type: 'set_transcript',
            transcript: {
              assetId: 'asset-a',
              segments: [{ segmentId: 'seg-a', text: 'spoken words' }]
            }
          }
        })
      ].join('\n') + '\n'
    )

    await expect(
      waitForStudioJournalOperation(
        { studioStateDirectory },
        { type: 'set_transcript', assetId: 'asset-a', requireNonEmptyTranscript: true },
        { timeoutMs: 100 }
      )
    ).resolves.toMatchObject({ revision: 2, op: { type: 'set_transcript' } })
  })

  it('adjudicates only an asset-bound, timed, ordered recognized passage', () => {
    const phrases = expectedTranscriptPhrases()
    const boundary = { assetId: 'asset-a', durationSeconds: 30, frameRate: 30 }
    const transcript = {
      revision: 2,
      op: {
        type: 'set_transcript',
        transcript: {
          schemaVersion: 1,
          transcriptId: 'transcript-a',
          assetId: 'asset-a',
          segments: [
            {
              segmentId: 'seg-a',
              text: 'TaskWraith Studio ACCEPTANCE transcript; this verifies timed transcript delivery.',
              sourceIn: { n: 0, d: 30 },
              sourceOut: { n: 120, d: 30 }
            },
            {
              segmentId: 'seg-b',
              text: 'Proposal approval, proposal rejection, and durable restart recovery are checked.',
              sourceIn: { n: 120, d: 30 },
              sourceOut: { n: 300, d: 30 }
            }
          ]
        }
      }
    }

    expect(adjudicateRecognizedTranscript(transcript, phrases, boundary)).toMatchObject({
      ok: true,
      segmentCount: 2,
      matchedPhrases: phrases,
      phraseMatches: phrases.map((phrase) => expect.objectContaining({ phrase, editDistance: 0 })),
      timingPolicy: {
        exactAssetId: 'asset-a',
        positiveRanges: true,
        orderedNonOverlapping: true,
        durationSeconds: 30,
        frameRate: 30,
        tailToleranceFrames: 1
      },
      transcriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    const measuredRecognition = structuredClone(transcript)
    measuredRecognition.op.transcript.segments[0].text =
      'Task rate Studio ACCEPTANCE transcript; this verifies time transcript delivery.'
    expect(adjudicateRecognizedTranscript(measuredRecognition, phrases, boundary)).toMatchObject({
      ok: true,
      matchedPhrases: phrases,
      phraseMatches: expect.arrayContaining([
        expect.objectContaining({ phrase: 'timed transcript delivery', editDistance: 1 })
      ])
    })
    const wrong = structuredClone(transcript)
    wrong.op.transcript.segments = [
      {
        segmentId: 'seg-wrong',
        text: 'unrelated spoken words',
        sourceIn: { n: 0, d: 30 },
        sourceOut: { n: 30, d: 30 }
      }
    ]
    expect(adjudicateRecognizedTranscript(wrong, phrases, boundary)).toMatchObject({
      ok: false,
      missingPhrases: phrases
    })
    const missing = structuredClone(transcript)
    missing.op.transcript.segments[1].text =
      'Proposal approval and durable restart recovery are checked.'
    expect(adjudicateRecognizedTranscript(missing, phrases, boundary)).toMatchObject({
      ok: false,
      missingPhrases: ['proposal rejection']
    })
    const phraseOutOfOrder = structuredClone(transcript)
    phraseOutOfOrder.op.transcript.segments[1].text =
      'Proposal rejection, proposal approval, and durable restart recovery are checked.'
    expect(adjudicateRecognizedTranscript(phraseOutOfOrder, phrases, boundary)).toMatchObject({
      ok: false,
      missingPhrases: ['proposal rejection']
    })
    const oneFrameTail = structuredClone(transcript)
    oneFrameTail.op.transcript.segments[1].sourceIn = { n: 900, d: 30 }
    oneFrameTail.op.transcript.segments[1].sourceOut = { n: 901, d: 30 }
    expect(adjudicateRecognizedTranscript(oneFrameTail, phrases, boundary)).toMatchObject({
      ok: true,
      timingPolicy: { tailToleranceFrames: 1 }
    })
    const reversed = structuredClone(transcript)
    reversed.op.transcript.segments[0].sourceIn = { n: 300, d: 30 }
    reversed.op.transcript.segments[0].sourceOut = { n: 30, d: 30 }
    expect(() => adjudicateRecognizedTranscript(reversed, phrases, boundary)).toThrow(
      /positive timed range/i
    )
    const overlapping = structuredClone(transcript)
    overlapping.op.transcript.segments[1].sourceIn = { n: 119, d: 30 }
    expect(() => adjudicateRecognizedTranscript(overlapping, phrases, boundary)).toThrow(
      /ordered and nonoverlapping/i
    )
    const outOfRange = structuredClone(transcript)
    outOfRange.op.transcript.segments[1].sourceOut = { n: 902, d: 30 }
    expect(() => adjudicateRecognizedTranscript(outOfRange, phrases, boundary)).toThrow(
      /fixture duration/i
    )
    const duplicateId = structuredClone(transcript)
    duplicateId.op.transcript.segments[1].segmentId = 'seg-a'
    expect(() => adjudicateRecognizedTranscript(duplicateId, phrases, boundary)).toThrow(
      /unique segmentId/i
    )
    const malformedExtra = structuredClone(transcript)
    malformedExtra.op.transcript.segments.push({
      segmentId: 'seg-c',
      text: 'ignored malformed segment'
    })
    expect(() => adjudicateRecognizedTranscript(malformedExtra, phrases, boundary)).toThrow(
      /timed transcript segment/i
    )
    const foreignAsset = structuredClone(transcript)
    foreignAsset.op.transcript.assetId = 'asset-b'
    expect(() => adjudicateRecognizedTranscript(foreignAsset, phrases, boundary)).toThrow(
      /asset identity/i
    )
    expect(() => adjudicateRecognizedTranscript(transcript, [], boundary)).toThrow(
      /expected transcript phrases/i
    )
  })

  it.runIf(process.platform !== 'win32')('runs the Swift driver from a bounded request file and validates its receipt', async () => {
    const root = await temporaryRoot('studio-acceptance-driver-request-')
    const target = {
      companion: {
        pid: 7002,
        ppid: 7001,
        pgid: 7001,
        command: '/virtual/TaskWraithStudioCompanion --viewer'
      },
      electronPgid: 7001,
      window: {
        pid: 7002,
        visibleWindowCount: 1,
        windows: [
          {
            windowId: 42,
            title: 'TaskWraith Studio',
            bounds: { x: 1, y: 2, width: 640, height: 360 }
          }
        ]
      }
    }
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      const request = JSON.parse(await fsPromises.readFile(args[1], 'utf8'))
      return {
        stdout: `${JSON.stringify({
          schemaVersion: 1,
          kind: 'taskwraith-studio-ui-driver-receipt',
          inputDelivery: request.inputDelivery,
          pid: request.expectedPid,
          pgid: request.expectedPgid,
          windowId: request.windowId,
          actions: request.actions.map((action: Record<string, unknown>, index: number) => ({
            index,
            type: action.type,
            key: action.key ?? null,
            screenshotPath: action.path ?? null,
            byteLength: action.path ? 4096 : null,
            xFraction: action.xFraction ?? null,
            yFraction: action.yFraction ?? null,
            playheadTicks: action.playheadTicks ?? null,
            playheadToleranceTicks: action.playheadToleranceTicks ?? null,
            playheadMaximumForwardAdvanceTicks: action.playheadMaximumForwardAdvanceTicks ?? null,
            playheadStepFrames: action.playheadStepFrames ?? null,
            playheadTicksBefore: action.type === 'step-playhead-frame' ? 1_000 : null,
            observedPlayheadTicks:
              action.type === 'step-playhead-frame'
                ? 980
                : action.playheadTicks === undefined
                  ? null
                  : Number(action.playheadTicks) - 1_307,
            accessibilityLabel: action.accessibilityLabel ?? null,
            accessibilityRole: action.type === 'read-transport-mutation' ? 'AXStaticText' : null,
            accessibilityMatchCount: action.type === 'read-transport-mutation' ? 1 : null,
            accessibilityValue:
              action.type === 'read-transport-mutation' ? validTransportMutationText : null,
            avSyncPeakValue: action.type === 'read-av-sync' ? validAvSyncPeakText : null,
            avSyncCurrentValue: action.type === 'read-av-sync' ? validAvSyncCurrentText : null,
            routeHealth:
              action.type === 'coreaudio-route-health' ? validCoreAudioRouteHealthReceipt : null,
            accessibilityAction: action.accessibilityAction ?? null,
            playbackValueBefore: action.playbackValueBefore ?? null,
            playbackValueAfter: action.playbackValueAfter ?? null,
            audioProbe:
              action.type === 'audio-probe'
                ? {
                    durationSeconds: action.durationSeconds,
                    elapsedSeconds: action.durationSeconds,
                    sampleBufferCount: 24,
                    frameCount: 96_000,
                    sampleValueCount: 192_000,
                    sampleRate: 48_000,
                    channelCount: 2,
                    rms: 0.125,
                    peak: 0.5,
                    nonSilentFraction: 0.75,
                    defaultOutputDevice: {
                      id: 42,
                      name: 'Acceptance Output',
                      uid: 'acceptance-output',
                      nominalSampleRate: 48_000
                    }
                  }
                : null
          }))
        })}\n`,
        stderr: ''
      }
    })

    const receipt = await runStudioUiDriver(
      { artifactRoot: root },
      target,
      [
        { type: 'key', key: 'tab' },
        { type: 'screenshot', name: 'transcript-band' },
        { type: 'audio-probe', durationSeconds: 75 }
      ],
      {
        execFile,
        inputDelivery: 'foreground-global-explicit',
        allowForegroundInput: true
      }
    )
    expect(receipt).toMatchObject({
      kind: 'taskwraith-studio-ui-driver-receipt',
      inputDelivery: 'foreground-global-explicit',
      pid: 7002,
      pgid: 7001,
      windowId: 42,
      actions: [
        { index: 0, type: 'key', key: 'tab' },
        { index: 1, type: 'screenshot' },
        {
          index: 2,
          type: 'audio-probe',
          audioProbe: {
            durationSeconds: 75,
            sampleRate: 48_000,
            channelCount: 2,
            rms: 0.125,
            peak: 0.5
          }
        }
      ]
    })
    const explicitReceipt = await runStudioUiDriver(
      { artifactRoot: root },
      target,
      [{ type: 'click', xFraction: 0.405, yFraction: 0.86 }],
      {
        execFile,
        inputDelivery: 'foreground-global-explicit',
        allowForegroundInput: true
      }
    )
    expect(explicitReceipt).toMatchObject({
      inputDelivery: 'foreground-global-explicit',
      actions: [{ type: 'click', xFraction: 0.405, yFraction: 0.86 }]
    })
    const observationReceipt = await runStudioUiDriver(
      { artifactRoot: root },
      target,
      [{ type: 'screenshot', name: 'background-observation' }],
      { execFile }
    )
    expect(observationReceipt).toMatchObject({
      inputDelivery: 'background-observation-only',
      actions: [{ type: 'screenshot' }]
    })
    const transportMutationReceipt = await runStudioUiDriver(
      { artifactRoot: root },
      target,
      [{ type: 'read-transport-mutation' }],
      { execFile }
    )
    expect(transportMutationReceipt).toMatchObject({
      inputDelivery: 'background-observation-only',
      actions: [
        {
          type: 'read-transport-mutation',
          accessibilityLabel: 'Transport mutation detail',
          accessibilityRole: 'AXStaticText',
          accessibilityMatchCount: 1,
          accessibilityValue: validTransportMutationText
        }
      ]
    })
    const measurementReceipt = await runStudioUiDriver(
      { artifactRoot: root },
      target,
      [{ type: 'read-av-sync' }, { type: 'coreaudio-route-health' }],
      { execFile }
    )
    expect(measurementReceipt).toMatchObject({
      inputDelivery: 'background-observation-only',
      actions: [
        {
          type: 'read-av-sync',
          avSyncPeakValue: validAvSyncPeakText,
          avSyncCurrentValue: validAvSyncCurrentText
        },
        {
          type: 'coreaudio-route-health',
          routeHealth: {
            id: 42,
            name: 'Acceptance Output',
            uid: 'acceptance-output',
            nominalSampleRate: 48_000,
            alive: true,
            running: true,
            hasOutputStream: true,
            outputStreamCount: 1,
            outputChannelCount: 2,
            muteSupported: true,
            muted: false,
            volumeSupported: true,
            volume: 0.75
          }
        }
      ]
    })
    const playbackReceipt = await runStudioUiDriver(
      { artifactRoot: root },
      target,
      [
        {
          type: 'press-playback',
          playbackValueBefore: 'paused',
          playbackValueAfter: 'playing'
        }
      ],
      { execFile }
    )
    expect(playbackReceipt).toMatchObject({
      inputDelivery: 'background-observation-only',
      actions: [
        {
          type: 'press-playback',
          accessibilityLabel: 'Playback',
          accessibilityAction: 'AXPress',
          playbackValueBefore: 'paused',
          playbackValueAfter: 'playing'
        }
      ]
    })
    const playheadReceipt = await runStudioUiDriver(
      { artifactRoot: root },
      target,
      [
        {
          type: 'set-playhead-ticks',
          playheadTicks: 241_000,
          playheadToleranceTicks: 50_000,
          playheadMaximumForwardAdvanceTicks: 500_000
        }
      ],
      { execFile }
    )
    expect(playheadReceipt).toMatchObject({
      inputDelivery: 'background-observation-only',
      actions: [
        {
          type: 'set-playhead-ticks',
          playheadTicks: 241_000,
          playheadToleranceTicks: 50_000,
          playheadMaximumForwardAdvanceTicks: 500_000,
          observedPlayheadTicks: 239_693
        }
      ]
    })
    const playheadStepReceipt = await runStudioUiDriver(
      { artifactRoot: root },
      target,
      [{ type: 'step-playhead-frame', playheadStepFrames: -1 }],
      { execFile }
    )
    expect(playheadStepReceipt).toMatchObject({
      inputDelivery: 'background-observation-only',
      actions: [
        {
          type: 'step-playhead-frame',
          playheadStepFrames: -1,
          playheadTicksBefore: 1_000,
          observedPlayheadTicks: 980
        }
      ]
    })
    expect(execFile).toHaveBeenCalledTimes(8)

    // @portability-ok: the Swift/AppKit Studio UI driver is a macOS-only
    // acceptance surface, and this assertion pins its system interpreter.
    expect(execFile.mock.calls[0][0]).toBe('/usr/bin/swift')
    expect(execFile.mock.calls[0][1][0]).toMatch(/studio-acceptance-ui-driver\.swift$/)
    expect(execFile.mock.calls[0][2]).toMatchObject({ timeoutMs: 105_000 })
    expect(receipt.receiptPath).toMatch(/ui-driver-receipts\/.*\.json$/)
    expect(receipt.rawReceiptPath).toMatch(/ui-driver-raw-receipts\/.*\.json\.stdout$/)
    expect(receipt.rawStdoutSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.rawStdoutByteLength).toBeGreaterThan(0)
    await expect(fsPromises.readFile(receipt.rawReceiptPath as string, 'utf8')).resolves.toContain(
      'taskwraith-studio-ui-driver-receipt'
    )
    await expect(
      fsPromises.readFile(receipt.receiptPath as string, 'utf8').then((raw) => JSON.parse(raw))
    ).resolves.toMatchObject({
      kind: 'taskwraith-studio-ui-driver-receipt',
      inputDelivery: 'foreground-global-explicit',
      pid: 7002,
      pgid: 7001,
      windowId: 42
    })
  })

  it.runIf(process.platform !== 'win32')('rejects malformed A/V and CoreAudio measurement receipts with raw evidence', async () => {
    const root = await temporaryRoot('studio-acceptance-measurement-receipt-')
    const target = {
      companion: {
        pid: 7002,
        ppid: 7001,
        pgid: 7001,
        command: '/virtual/TaskWraithStudioCompanion --viewer'
      },
      electronPgid: 7001,
      window: {
        pid: 7002,
        visibleWindowCount: 1,
        windows: [
          {
            windowId: 42,
            title: 'TaskWraith Studio',
            bounds: { x: 1, y: 2, width: 640, height: 360 }
          }
        ]
      }
    }
    const run = (
      requestedAction: Record<string, unknown>,
      observedAction: Record<string, unknown>
    ) =>
      runStudioUiDriver({ artifactRoot: root }, target, [requestedAction], {
        execFile: vi.fn(async (_file: string, args: string[]) => {
          const request = JSON.parse(await fsPromises.readFile(args[1], 'utf8'))
          return {
            stdout: `${JSON.stringify({
              schemaVersion: 1,
              kind: 'taskwraith-studio-ui-driver-receipt',
              inputDelivery: request.inputDelivery,
              pid: request.expectedPid,
              pgid: request.expectedPgid,
              windowId: request.windowId,
              actions: [observedAction]
            })}\n`,
            stderr: ''
          }
        })
      })
    const captureFailure = async (operation: Promise<Record<string, unknown>>) => {
      try {
        await operation
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        return error as Error & {
          studioUiDriverEvidence: {
            rawReceiptPath: string | null
            rawStdoutSha256: string | null
            rawStdoutByteLength: number | null
            validatedReceiptPath: string | null
            failureStage: string
          }
        }
      }
      throw new Error('expected Studio measurement receipt failure')
    }

    const peakInCurrentFailure = await captureFailure(
      run(
        { type: 'read-av-sync' },
        {
          index: 0,
          type: 'read-av-sync',
          avSyncPeakValue: validAvSyncPeakText,
          avSyncCurrentValue: validAvSyncPeakText
        }
      )
    )
    expect(peakInCurrentFailure.message).toMatch(/A\/V sync current receipt is invalid.*avc1/i)
    expect(peakInCurrentFailure.studioUiDriverEvidence).toMatchObject({
      failureStage: 'av-sync-validation',
      validatedReceiptPath: null
    })
    expect(peakInCurrentFailure.studioUiDriverEvidence.rawReceiptPath).toMatch(
      /ui-driver-raw-receipts\/.*\.json\.stdout$/
    )
    expect(peakInCurrentFailure.studioUiDriverEvidence.rawStdoutSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(peakInCurrentFailure.studioUiDriverEvidence.rawStdoutByteLength).toBeGreaterThan(0)

    await expect(
      run(
        { type: 'read-av-sync' },
        {
          index: 0,
          type: 'read-av-sync',
          avSyncPeakValue: validAvSyncCurrentText,
          avSyncCurrentValue: validAvSyncCurrentText
        }
      )
    ).rejects.toThrow(/A\/V sync peak receipt is invalid.*av1/i)

    const inconsistentRouteFailure = await captureFailure(
      run(
        { type: 'coreaudio-route-health' },
        {
          index: 0,
          type: 'coreaudio-route-health',
          routeHealth: {
            ...validCoreAudioRouteHealthReceipt,
            outputStreamCount: 0
          }
        }
      )
    )
    expect(inconsistentRouteFailure.message).toMatch(
      /CoreAudio route-health receipt is invalid.*hasOutputStream.*counts/i
    )
    expect(inconsistentRouteFailure.studioUiDriverEvidence).toMatchObject({
      failureStage: 'coreaudio-route-health-validation',
      validatedReceiptPath: null
    })
    expect(inconsistentRouteFailure.studioUiDriverEvidence.rawReceiptPath).toMatch(
      /ui-driver-raw-receipts\/.*\.json\.stdout$/
    )

    await expect(
      run(
        { type: 'coreaudio-route-health' },
        {
          index: 0,
          type: 'coreaudio-route-health',
          routeHealth: {
            ...validCoreAudioRouteHealthReceipt,
            muted: undefined
          }
        }
      )
    ).rejects.toThrow(/CoreAudio route-health receipt is invalid.*muted/i)

    await expect(
      run(
        { type: 'coreaudio-route-health' },
        {
          index: 0,
          type: 'coreaudio-route-health',
          routeHealth: {
            ...validCoreAudioRouteHealthReceipt,
            muteSupported: false,
            muted: undefined,
            volumeSupported: false,
            volume: undefined
          }
        }
      )
    ).resolves.toMatchObject({
      actions: [
        {
          type: 'coreaudio-route-health',
          routeHealth: {
            muteSupported: false,
            volumeSupported: false
          }
        }
      ]
    })
  })

  it.runIf(process.platform !== 'win32')('rejects missing, duplicate, mismatched, and malformed tm1 action receipts', async () => {
    const root = await temporaryRoot('studio-acceptance-tm1-receipt-')
    const target = {
      companion: {
        pid: 7002,
        ppid: 7001,
        pgid: 7001,
        command: '/virtual/TaskWraithStudioCompanion --viewer'
      },
      electronPgid: 7001,
      window: {
        pid: 7002,
        visibleWindowCount: 1,
        windows: [
          {
            windowId: 42,
            title: 'TaskWraith Studio',
            bounds: { x: 1, y: 2, width: 640, height: 360 }
          }
        ]
      }
    }
    const run = (actions: Array<Record<string, unknown>>) =>
      runStudioUiDriver({ artifactRoot: root }, target, [{ type: 'read-transport-mutation' }], {
        execFile: vi.fn(async (_file: string, args: string[]) => {
          const request = JSON.parse(await fsPromises.readFile(args[1], 'utf8'))
          return {
            stdout: `${JSON.stringify({
              schemaVersion: 1,
              kind: 'taskwraith-studio-ui-driver-receipt',
              inputDelivery: request.inputDelivery,
              pid: request.expectedPid,
              pgid: request.expectedPgid,
              windowId: request.windowId,
              actions
            })}\n`,
            stderr: ''
          }
        })
      })
    const exactAction = {
      index: 0,
      type: 'read-transport-mutation',
      accessibilityLabel: 'Transport mutation detail',
      accessibilityRole: 'AXStaticText',
      accessibilityMatchCount: 1,
      accessibilityValue: validTransportMutationText
    }

    const captureFailure = async (operation: Promise<Record<string, unknown>>) => {
      try {
        await operation
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        return error as Error & {
          studioUiDriverEvidence: {
            requestPath: string
            rawReceiptPath: string | null
            rawStdoutSha256: string | null
            rawStdoutByteLength: number | null
            validatedReceiptPath: string | null
            failureStage: string
          }
        }
      }
      throw new Error('expected Studio UI driver failure')
    }
    const expectRawEvidence = async (
      failure: Awaited<ReturnType<typeof captureFailure>>,
      expectedStage: string,
      expectedStdout: string
    ) => {
      const evidence = failure.studioUiDriverEvidence
      expect(evidence).toMatchObject({
        failureStage: expectedStage,
        rawStdoutByteLength: Buffer.byteLength(expectedStdout),
        rawStdoutSha256: crypto.createHash('sha256').update(expectedStdout).digest('hex'),
        validatedReceiptPath: null
      })
      expect(evidence.requestPath).toMatch(/ui-driver-requests\/.*\.json$/)
      expect(evidence.rawReceiptPath).toMatch(/ui-driver-raw-receipts\/.*\.json\.stdout$/)
      await expect(fsPromises.readFile(evidence.requestPath, 'utf8')).resolves.toContain(
        'read-transport-mutation'
      )
      await expect(fsPromises.readFile(evidence.rawReceiptPath as string, 'utf8')).resolves.toBe(
        expectedStdout
      )
    }

    const missingFailure = await captureFailure(run([]))
    expect(missingFailure.message).toMatch(/invalid receipt/)
    const missingRaw = await fsPromises.readFile(
      missingFailure.studioUiDriverEvidence.rawReceiptPath as string,
      'utf8'
    )
    await expectRawEvidence(missingFailure, 'receipt-schema', missingRaw)

    await expect(run([exactAction, exactAction])).rejects.toThrow(/invalid receipt/)
    await expect(run([{ ...exactAction, accessibilityLabel: 'Sync detail' }])).rejects.toThrow(
      /transport-mutation receipt/
    )
    await expect(run([{ ...exactAction, accessibilityRole: 'AXButton' }])).rejects.toThrow(
      /transport-mutation receipt/
    )
    await expect(run([{ ...exactAction, accessibilityMatchCount: 2 }])).rejects.toThrow(
      /transport-mutation receipt/
    )

    const malformedFailure = await captureFailure(
      run([
        {
          ...exactAction,
          accessibilityValue: validTransportMutationText.replace('clamped=0', 'clamped=1')
        }
      ])
    )
    expect(malformedFailure.message).toMatch(/transport-mutation receipt is invalid/)
    const malformedRaw = await fsPromises.readFile(
      malformedFailure.studioUiDriverEvidence.rawReceiptPath as string,
      'utf8'
    )
    await expectRawEvidence(malformedFailure, 'tm1-validation', malformedRaw)

    const invalidJson = 'not-json\n'
    const invalidJsonFailure = await captureFailure(
      runStudioUiDriver({ artifactRoot: root }, target, [{ type: 'read-transport-mutation' }], {
        execFile: vi.fn(async () => ({ stdout: invalidJson, stderr: '' }))
      })
    )
    expect(invalidJsonFailure.message).toMatch(/did not return a JSON receipt/)
    await expectRawEvidence(invalidJsonFailure, 'json-parse', invalidJson)

    const nativeRefusal = {
      schemaVersion: 1,
      kind: 'taskwraith-studio-ui-driver-refusal',
      recordedAt: '2026-08-16T14:00:00.000Z',
      reason: 'Playback accessibility control is absent'
    }
    const nativeStdout = `${JSON.stringify(nativeRefusal)}\n`
    const nativeFailure = await captureFailure(
      runStudioUiDriver({ artifactRoot: root }, target, [{ type: 'read-transport-mutation' }], {
        execFile: vi.fn(async () => {
          throw Object.assign(new Error('native driver failed'), { stdout: nativeStdout })
        })
      })
    )
    expect(nativeFailure.message).toMatch(/native driver failed/)
    await expectRawEvidence(nativeFailure, 'native-exec', nativeStdout)
    await expect(
      fsPromises
        .readFile(nativeFailure.studioUiDriverEvidence.rawReceiptPath as string, 'utf8')
        .then((raw) => JSON.parse(raw))
    ).resolves.toEqual(nativeRefusal)
    const oversizedStdout = 'x'.repeat(256 * 1024 + 1)
    const oversizedFailure = await captureFailure(
      runStudioUiDriver({ artifactRoot: root }, target, [{ type: 'read-transport-mutation' }], {
        execFile: vi.fn(async () => ({ stdout: oversizedStdout, stderr: '' }))
      })
    )
    expect(oversizedFailure.message).toMatch(/raw receipt exceeds/)
    expect(oversizedFailure.studioUiDriverEvidence).toMatchObject({
      rawReceiptPath: null,
      rawStdoutByteLength: Buffer.byteLength(oversizedStdout),
      rawStdoutSha256: crypto.createHash('sha256').update(oversizedStdout).digest('hex'),
      validatedReceiptPath: null,
      failureStage: 'raw-receipt-write'
    })
  })

  it('rejects a Playback AXPress receipt that does not prove the exact transition', async () => {
    const root = await temporaryRoot('studio-acceptance-playback-press-receipt-')
    const target = {
      companion: {
        pid: 7002,
        ppid: 7001,
        pgid: 7001,
        command: '/virtual/TaskWraithStudioCompanion --viewer'
      },
      electronPgid: 7001,
      window: {
        pid: 7002,
        visibleWindowCount: 1,
        windows: [
          {
            windowId: 42,
            title: 'TaskWraith Studio',
            bounds: { x: 1, y: 2, width: 640, height: 360 }
          }
        ]
      }
    }
    const run = (overrides: Record<string, unknown>) =>
      runStudioUiDriver(
        { artifactRoot: root },
        target,
        [
          {
            type: 'press-playback',
            playbackValueBefore: 'paused',
            playbackValueAfter: 'playing'
          }
        ],
        {
          execFile: vi.fn(async (_file: string, args: string[]) => {
            const request = JSON.parse(await fsPromises.readFile(args[1], 'utf8'))
            const action = request.actions[0]
            return {
              stdout: `${JSON.stringify({
                schemaVersion: 1,
                kind: 'taskwraith-studio-ui-driver-receipt',
                inputDelivery: request.inputDelivery,
                pid: request.expectedPid,
                pgid: request.expectedPgid,
                windowId: request.windowId,
                actions: [
                  {
                    index: 0,
                    type: action.type,
                    accessibilityLabel: action.accessibilityLabel,
                    accessibilityAction: action.accessibilityAction,
                    playbackValueBefore: action.playbackValueBefore,
                    playbackValueAfter: action.playbackValueAfter,
                    ...overrides
                  }
                ]
              })}\n`,
              stderr: ''
            }
          })
        }
      )

    await expect(run({ playbackValueAfter: 'paused' })).rejects.toThrow(/Playback receipt/)
    await expect(run({ accessibilityLabel: 'Loop' })).rejects.toThrow(/Playback receipt/)
    await expect(run({ accessibilityAction: 'AXShowMenu' })).rejects.toThrow(/Playback receipt/)
  })

  it('bounds live Playhead settlement with an explicit forward-only envelope', async () => {
    const root = await temporaryRoot('studio-acceptance-playhead-envelope-')
    const target = {
      companion: {
        pid: 7002,
        ppid: 7001,
        pgid: 7001,
        command: '/virtual/TaskWraithStudioCompanion --viewer'
      },
      electronPgid: 7001,
      window: {
        pid: 7002,
        visibleWindowCount: 1,
        windows: [
          {
            windowId: 42,
            title: 'TaskWraith Studio',
            bounds: { x: 1, y: 2, width: 640, height: 360 }
          }
        ]
      }
    }
    const run = (observedPlayheadTicks: number, receiptMaximumForwardAdvanceTicks = 1_000_000) =>
      runStudioUiDriver(
        { artifactRoot: root },
        target,
        [
          {
            type: 'set-playhead-ticks',
            playheadTicks: 241_000,
            playheadToleranceTicks: 50_000,
            playheadMaximumForwardAdvanceTicks: 1_000_000
          }
        ],
        {
          execFile: vi.fn(async (_file: string, args: string[]) => {
            const request = JSON.parse(await fsPromises.readFile(args[1], 'utf8'))
            const action = request.actions[0]
            return {
              stdout: `${JSON.stringify({
                schemaVersion: 1,
                kind: 'taskwraith-studio-ui-driver-receipt',
                inputDelivery: request.inputDelivery,
                pid: request.expectedPid,
                pgid: request.expectedPgid,
                windowId: request.windowId,
                actions: [
                  {
                    index: 0,
                    type: action.type,
                    playheadTicks: action.playheadTicks,
                    playheadToleranceTicks: action.playheadToleranceTicks,
                    playheadMaximumForwardAdvanceTicks: receiptMaximumForwardAdvanceTicks,
                    observedPlayheadTicks
                  }
                ]
              })}\n`,
              stderr: ''
            }
          })
        }
      )

    await expect(run(1_291_000)).resolves.toMatchObject({
      actions: [
        {
          playheadMaximumForwardAdvanceTicks: 1_000_000,
          observedPlayheadTicks: 1_291_000
        }
      ]
    })
    await expect(run(1_291_001)).rejects.toThrow(/playhead receipt/)
    await expect(run(190_999)).rejects.toThrow(/playhead receipt/)
    await expect(run(241_000, 999_999)).rejects.toThrow(/playhead receipt/)
  })

  it('adjudicates journey captures only in the bounded material or timeline region', async () => {
    const root = await temporaryRoot('studio-journey-captures-')
    const bounds = { x: 10, y: 20, width: 640, height: 390 }
    const makeCapture = async (
      name: string,
      mutate?: (image: InstanceType<typeof PNG>) => void
    ) => {
      const image = new PNG({ width: 1_280, height: 780 })
      image.data.fill(255)
      mutate?.(image)
      const destination = path.join(root, name)
      await fsPromises.writeFile(destination, PNG.sync.write(image))
      return destination
    }
    const paintRectangle = (
      image: InstanceType<typeof PNG>,
      left: number,
      top: number,
      width: number,
      height: number
    ) => {
      for (let y = top; y < top + height; y += 1) {
        for (let x = left; x < left + width; x += 1) {
          const offset = (y * image.width + x) * 4
          image.data[offset] = 0
          image.data[offset + 1] = 0
          image.data[offset + 2] = 0
          image.data[offset + 3] = 255
        }
      }
    }
    const baseline = await makeCapture('baseline.png')
    const material = await makeCapture('material.png', (image) => {
      for (const y of [96, 248, 440]) {
        for (const x of [64, 416, 800, 1_184]) {
          paintRectangle(image, x, y, 32, 32)
        }
      }
    })
    const localizedNoise = await makeCapture('localized-noise.png', (image) =>
      paintRectangle(image, 100, 200, 8, 4)
    )
    const timeline = await makeCapture('timeline.png', (image) =>
      paintRectangle(image, 100, 650, 24, 24)
    )

    expect(compareStudioJourneyCaptures(baseline, material, bounds, 'material')).toMatchObject({
      ok: true,
      region: 'material',
      spatialSpread: {
        horizontalSpanFraction: expect.any(Number),
        verticalSpanFraction: expect.any(Number),
        occupiedCellCount: expect.any(Number)
      },
      threshold: {
        channelDelta: 16,
        minimumChangedFraction: 0.014,
        minimumOccupiedCells: 6,
        minimumSpanFraction: 0.5,
        policy: {
          kind: 'fixed-spatial-material-change-policy',
          basis: 'fixed-acceptance-policy-not-measured-calibration',
          gridColumns: 4,
          gridRows: 3,
          minimumChangedFraction: 0.014,
          minimumOccupiedCells: 6,
          minimumSpanFraction: 0.5,
          occupiedCellPixelDivisor: 256
        }
      }
    })
    expect(
      compareStudioJourneyCaptures(baseline, material, bounds, 'material').threshold
    ).not.toHaveProperty('calibration')
    expect(compareStudioJourneyCaptures(baseline, timeline, bounds, 'timeline')).toMatchObject({
      ok: true,
      region: 'timeline'
    })
    expect(() =>
      compareStudioJourneyCaptures(baseline, localizedNoise, bounds, 'material')
    ).toThrow(/spatially distributed material change/)
    expect(() => compareStudioJourneyCaptures(baseline, timeline, bounds, 'material')).toThrow(
      /spatially distributed material change/
    )
    expect(() => compareStudioJourneyCaptures(baseline, baseline, bounds, 'timeline')).toThrow(
      /timeline region did not materially change/
    )
  })

  it('rejects peak-shaped proposal, split-clock, and playback summaries that are not exact', () => {
    const proposalEntry = {
      op: {
        proposal: {
          proposalId: 'proposal-a',
          op: {
            type: 'insert_range',
            assetId: 'asset-a',
            sourceIn: { n: 500_000, d: 500_000 },
            sourceOut: { n: 1_000_000, d: 500_000 },
            at: { n: 1_500_000, d: 500_000 }
          }
        }
      }
    }
    const proposalBoundary = { assetId: 'asset-a', durationSeconds: 30 }
    expect(studioProposalInsertionEvidence(proposalEntry, proposalBoundary)).toMatchObject({
      proposalId: 'proposal-a',
      assetId: 'asset-a',
      insertionTicks: 1_500_000,
      timebase: 500_000,
      durationSeconds: 30,
      durationBoundTicks: '15000000'
    })
    const mismatchedTimebase = structuredClone(proposalEntry)
    mismatchedTimebase.op.proposal.op.at.d = 30_000
    expect(() => studioProposalInsertionEvidence(mismatchedTimebase, proposalBoundary)).toThrow(
      /exact bounded insert_range/
    )
    const foreignAsset = structuredClone(proposalEntry)
    foreignAsset.op.proposal.op.assetId = 'asset-b'
    expect(() => studioProposalInsertionEvidence(foreignAsset, proposalBoundary)).toThrow(
      /opened asset/
    )
    const unboundedSource = structuredClone(proposalEntry)
    unboundedSource.op.proposal.op.sourceOut.n = Number.MAX_SAFE_INTEGER
    expect(() => studioProposalInsertionEvidence(unboundedSource, proposalBoundary)).toThrow(
      /fixture duration/
    )
    const unboundedInsertion = structuredClone(proposalEntry)
    unboundedInsertion.op.proposal.op.at.n = Number.MAX_SAFE_INTEGER
    expect(() => studioProposalInsertionEvidence(unboundedInsertion, proposalBoundary)).toThrow(
      /fixture duration/
    )

    const source = {
      actions: [
        {
          type: 'step-playhead-frame',
          playheadStepFrames: 1,
          playheadTicksBefore: 1_500_000,
          observedPlayheadTicks: 1_501_000
        }
      ]
    }
    const review = {
      actions: [
        {
          type: 'step-playhead-frame',
          playheadStepFrames: -1,
          playheadTicksBefore: 1_501_000,
          observedPlayheadTicks: 1_500_000
        }
      ]
    }
    expect(adjudicateSharedStudioClock(source, review)).toMatchObject({
      ok: true,
      reviewAfterTicks: 1_500_000
    })
    const splitClock = structuredClone(review)
    splitClock.actions[0].playheadTicksBefore = 9_000_000
    expect(() => adjudicateSharedStudioClock(source, splitClock)).toThrow(/one shared clock/)

    const playback = {
      actions: [
        {
          type: 'press-playback',
          playbackValueBefore: 'paused',
          playbackValueAfter: 'playing'
        },
        {
          type: 'press-playback',
          playbackValueBefore: 'playing',
          playbackValueAfter: 'paused'
        }
      ]
    }
    expect(adjudicatePlaybackRoundTrip(playback)).toMatchObject({
      ok: true,
      initial: 'paused',
      final: 'paused'
    })
    const oneWay = structuredClone(playback)
    oneWay.actions.pop()
    expect(() => adjudicatePlaybackRoundTrip(oneWay)).toThrow(/round trip/)
  })

  it('defines and drives the host-authorized accept/reject journey in exact order', async () => {
    expect(buildStudioAcceptanceJourney().map((stage) => stage.id)).toEqual([
      'transcript-ready',
      'propose-accept',
      'review-current-proposed',
      'accept',
      'propose-reject',
      'reject'
    ])

    const calls: string[] = []
    const deliveries: string[] = []
    const windowTargetsSeen: Array<Record<string, any>> = []
    let proposalNumber = 0
    let sharedPlayheadTicks = 1_500_000
    let readWorkspaceCallCount = 0
    const receipt = await driveStudioUiJourney(
      { artifactRoot: '/virtual/acceptance/studioJourney01', transcriptTimeoutMs: 720_000 },
      {
        companion: { pid: 7002, pgid: 7001, command: '/virtual/TaskWraithStudioCompanion' },
        electronPgid: 7001,
        window: {
          pid: 7002,
          visibleWindowCount: 1,
          windows: [
            {
              windowId: 42,
              title: 'TaskWraith Studio',
              bounds: { x: 0, y: 0, width: 1280, height: 800 }
            }
          ]
        },
        asset: { sha256: 'asset-a' },
        speechFixture: {
          manifestPath: '/virtual/acceptance/studioJourney01/fixtures/speech-fixture-manifest.json',
          outputSha256: 'b'.repeat(64),
          durationSeconds: 30,
          frameRate: 30,
          expectedPhrases: expectedTranscriptPhrases(),
          provenanceNote: 'generation alone does not prove recognition'
        }
      },
      {
        waitForJournalOperation: async (
          _plan: unknown,
          expectation: Record<string, unknown>,
          options: Record<string, unknown>
        ) => {
          if (expectation.type === 'set_transcript') {
            expect(options).toMatchObject({ afterRevision: 0, timeoutMs: 720_000 })
          }
          calls.push(
            `journal:${String(expectation.type)}:${String(
              expectation.decision ?? expectation.assetId ?? ''
            )}`
          )
          if (expectation.type === 'set_transcript') {
            return {
              revision: 2,
              op: {
                type: 'set_transcript',
                transcript: {
                  schemaVersion: 1,
                  transcriptId: 'transcript-a',
                  assetId: 'asset-a',
                  segments: [
                    {
                      segmentId: 'segment-a',
                      text: expectedTranscriptPhrases().join('. '),
                      sourceIn: { n: 0, d: 30 },
                      sourceOut: { n: 300, d: 30 }
                    }
                  ]
                }
              }
            }
          }
          if (expectation.type === 'propose_edit') {
            proposalNumber += 1
            return {
              revision: 2 + proposalNumber * 2 - 1,
              op: {
                type: 'propose_edit',
                proposal: {
                  proposalId: `proposal-${proposalNumber}`,
                  op: {
                    type: 'insert_range',
                    assetId: 'asset-a',
                    sourceIn: { n: 500_000, d: 500_000 },
                    sourceOut: { n: 1_000_000, d: 500_000 },
                    at: { n: 1_500_000, d: 500_000 }
                  }
                }
              }
            }
          }
          return {
            revision: 2 + proposalNumber * 2,
            op: {
              type: 'resolve_proposal',
              proposalId: `proposal-${proposalNumber}`,
              decision: expectation.decision
            }
          }
        },
        compareCaptures: (
          beforePath: string,
          afterPath: string,
          _bounds: Record<string, number>,
          region: string
        ) => {
          calls.push(`compare:${region}:${path.basename(beforePath)}:${path.basename(afterPath)}`)
          return { ok: true, region, changedPixelCount: 512, changedPixelFraction: 0.01 }
        },
        runUiDriver: async (
          _plan: unknown,
          target: Record<string, any>,
          actions: Array<Record<string, any>>,
          driverOptions: Record<string, any>
        ) => {
          // Every single driver call across the whole journey — transcript
          // reads, ghost, current/proposed, accept, reject, read-workspace
          // probes — must resolve the exact same immutable one-window
          // identity and bounds. This is asserted in full below.
          windowTargetsSeen.push(target?.window?.windows?.[0] ?? null)
          if (actions.length === 1 && actions[0].type === 'read-workspace') {
            calls.push('driver:read-workspace')
            readWorkspaceCallCount += 1
            // The very first read-workspace call happens at journey start,
            // before Timeline is ever shown: Source is selected/visible and
            // Timeline is not. Every later call (the accept/reject
            // waitForWorkspaceReview polls) happens after `w` has shown
            // Timeline, so review=true from then on.
            const review = readWorkspaceCallCount > 1
            return {
              schemaVersion: 1,
              kind: 'taskwraith-studio-ui-driver-receipt',
              pid: 7002,
              pgid: 7001,
              windowId: 42,
              actions: [
                {
                  index: 0,
                  type: 'read-workspace',
                  workspace: validWorkspaceObservation(review)
                }
              ]
            }
          }
          deliveries.push(driverOptions.inputDelivery)
          const actionNames = actions.map((action) => {
            if (action.type === 'key') return action.key
            if (action.type === 'screenshot') return action.name
            if (action.type === 'set-playhead-ticks') return `set:${action.playheadTicks}`
            if (action.type === 'step-playhead-frame') return `step:${action.playheadStepFrames}`
            return action.type
          })
          calls.push(`driver:${actionNames.join(',')}`)
          return {
            schemaVersion: 1,
            kind: 'taskwraith-studio-ui-driver-receipt',
            pid: 7002,
            pgid: 7001,
            windowId: 42,
            actions: actions.map((action, index) => {
              const observed: Record<string, any> = {
                index,
                type: action.type,
                key: action.key ?? null,
                screenshotPath:
                  action.type === 'screenshot' ? `/virtual/${String(action.name)}.png` : null
              }
              if (action.type === 'press-playback') {
                Object.assign(observed, {
                  accessibilityLabel: 'Playback',
                  accessibilityAction: 'AXPress',
                  playbackValueBefore: action.playbackValueBefore,
                  playbackValueAfter: action.playbackValueAfter
                })
              }
              if (action.type === 'set-playhead-ticks') {
                sharedPlayheadTicks = action.playheadTicks
                Object.assign(observed, {
                  playheadTicks: action.playheadTicks,
                  playheadToleranceTicks: action.playheadToleranceTicks ?? 0,
                  playheadMaximumForwardAdvanceTicks:
                    action.playheadMaximumForwardAdvanceTicks ?? 0,
                  observedPlayheadTicks: sharedPlayheadTicks
                })
              }
              if (action.type === 'step-playhead-frame') {
                const before = sharedPlayheadTicks
                sharedPlayheadTicks += action.playheadStepFrames * 1_000
                Object.assign(observed, {
                  playheadStepFrames: action.playheadStepFrames,
                  playheadTicksBefore: before,
                  observedPlayheadTicks: sharedPlayheadTicks
                })
              }
              return observed
            })
          }
        }
      }
    )

    expect(receipt).toMatchObject({
      ok: true,
      transcript: {
        revision: 2,
        recognition: {
          ok: true,
          matchedPhrases: expectedTranscriptPhrases(),
          transcriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        }
      },
      accepted: { proposalId: 'proposal-1', resolutionRevision: 4 },
      rejected: {
        proposalId: 'proposal-2',
        resolutionRevision: 6,
        proposal: {
          proposalId: 'proposal-2',
          assetId: 'asset-a',
          durationSeconds: 30
        }
      },
      adjudication: {
        transcriptPixels: { ok: true, region: 'source-host-overlay' },
        currentProposedPixels: { ok: true, region: 'review-host' },
        ghostRejectPixels: { ok: true, region: 'review-host' },
        workspace: {
          accepted: {
            timelineRoute: { value: 'selected' },
            timelineHost: { visible: true }
          },
          rejected: {
            timelineRoute: { value: 'selected' },
            timelineHost: { visible: true }
          }
        },
        sharedClock: {
          sourceBeforeTicks: 1_500_000,
          sourceAfterTicks: 1_501_000,
          reviewBeforeTicks: 1_501_000,
          reviewAfterTicks: 1_500_000
        },
        playbackRoundTrip: {
          ok: true,
          initial: 'paused',
          intermediate: 'playing',
          final: 'paused'
        }
      }
    })
    expect(calls).toEqual([
      'journal:set_transcript:asset-a',
      'driver:read-workspace',
      'driver:press-playback',
      'driver:transcript-band',
      'driver:tab',
      'driver:transcript-selected',
      'driver:bracket-left',
      'driver:trim-pending',
      'driver:return',
      'driver:proposal-sent',
      'compare:source-host-overlay:transcript-band.png:transcript-selected.png',
      'journal:propose_edit:',
      'driver:ghost',
      'driver:w',
      'driver:read-workspace',
      'driver:set:1500000',
      'driver:current',
      'driver:v',
      'driver:set:1500000',
      'driver:proposed',
      'compare:review-host:current.png:proposed.png',
      'driver:step:1',
      'driver:step:-1',
      'driver:a,accept-sent',
      'journal:resolve_proposal:accept',
      'driver:w,tab,bracket-right,return',
      'journal:propose_edit:',
      'driver:w',
      'driver:read-workspace',
      'driver:ghost-reject',
      'driver:r,reject-sent',
      'compare:review-host:ghost-reject.png:reject-sent.png',
      'journal:resolve_proposal:reject',
      'driver:press-playback,press-playback'
    ])
    expect(deliveries).toEqual([
      'background-observation-only',
      'background-observation-only',
      'foreground-global-explicit',
      'background-observation-only',
      'foreground-global-explicit',
      'background-observation-only',
      'foreground-global-explicit',
      'background-observation-only',
      'background-observation-only',
      'foreground-global-explicit',
      'background-observation-only',
      'background-observation-only',
      'foreground-global-explicit',
      'background-observation-only',
      'background-observation-only',
      'background-observation-only',
      'background-observation-only',
      'foreground-global-explicit',
      'foreground-global-explicit',
      'foreground-global-explicit',
      'background-observation-only',
      'foreground-global-explicit',
      'background-observation-only'
    ])
    expect(receipt.screenshots).toEqual([
      '/virtual/transcript-band.png',
      '/virtual/transcript-selected.png',
      '/virtual/trim-pending.png',
      '/virtual/proposal-sent.png',
      '/virtual/ghost.png',
      '/virtual/current.png',
      '/virtual/proposed.png',
      '/virtual/accept-sent.png',
      '/virtual/ghost-reject.png',
      '/virtual/reject-sent.png'
    ])
    // No retired second Review window is ever targeted, and no call drifts
    // onto a different windowId/title/bounds mid-journey: one immutable
    // window carries every Source and Review action.
    expect(windowTargetsSeen.length).toBeGreaterThan(5)
    for (const seen of windowTargetsSeen) {
      expect(seen).toEqual({
        windowId: 42,
        title: 'TaskWraith Studio',
        bounds: { x: 0, y: 0, width: 1280, height: 800 }
      })
    }
  })

  it('fails a partial UI journey without manufacturing a success receipt', async () => {
    let driverCalls = 0
    await expect(
      driveStudioUiJourney(
        { artifactRoot: '/virtual/acceptance/studioJourneyFail' },
        {
          companion: { pid: 7002, pgid: 7001, command: '/virtual/TaskWraithStudioCompanion' },
          electronPgid: 7001,
          window: {
            pid: 7002,
            visibleWindowCount: 1,
            windows: [
              {
                windowId: 42,
                title: 'TaskWraith Studio',
                bounds: { x: 0, y: 0, width: 1280, height: 800 }
              }
            ]
          }
        },
        {
          waitForJournalOperation: async (_plan: unknown, expectation: Record<string, unknown>) => {
            if (expectation.type === 'set_transcript') {
              return { revision: 2, op: { type: 'set_transcript' } }
            }
            return {
              revision: 3,
              op: { type: 'propose_edit', proposal: { proposalId: 'proposal-fail' } }
            }
          },
          runUiDriver: async () => {
            driverCalls += 1
            if (driverCalls === 1) {
              return {
                actions: [
                  { index: 0, type: 'read-workspace', workspace: validWorkspaceObservation(false) }
                ]
              }
            }
            if (driverCalls === 3) throw new Error('screenshot failed')
            return { actions: [] }
          }
        }
      )
    ).rejects.toThrow(/screenshot failed/)
  })

  it.each([
    [{ status: 'reap_incomplete', reason: 'owner_requested', groupExitVerified: false }],
    [{ status: 'exited', reason: 'child_exit', groupExitVerified: true }],
    [{ status: 'reaped', reason: 'deadline_exceeded', groupExitVerified: true }]
  ])('rejects an unclean acceptance watchdog terminal %#', (terminal) => {
    expect(() => assertCleanWatchdogTerminal(terminal)).toThrow(/did not confirm clean/)
  })

  it('fails live-build custody for tracked and untracked product inputs while hashing foreign dirt', async () => {
    const digests: Record<string, string> = {
      'src/main/store/index.ts': 'a'.repeat(64),
      'src/main/store/NewModule.ts': 'b'.repeat(64),
      'docs/acceptance-note.md': 'c'.repeat(64),
      '.local-only.patch': 'd'.repeat(64)
    }
    const digestPath = async (relativePath: string) => digests[relativePath] ?? null
    const dirt = await classifyStudioAcceptanceDirt(
      [
        ' M src/main/store/index.ts',
        '?? src/main/store/NewModule.ts',
        ' M docs/acceptance-note.md',
        '?? .local-only.patch',
        ''
      ].join('\0'),
      digestPath
    )

    expect(dirt).toMatchObject({
      wholeTrackedTreeClean: false,
      wholeWorkspaceClean: false,
      studioPathsClean: false,
      studioTrackedDirt: [
        {
          status: ' M',
          path: 'src/main/store/index.ts',
          worktreeSha256: 'a'.repeat(64)
        }
      ],
      studioUntrackedDirt: [
        {
          status: '??',
          path: 'src/main/store/NewModule.ts',
          worktreeSha256: 'b'.repeat(64)
        }
      ],
      foreignTrackedDirt: [
        {
          status: ' M',
          path: 'docs/acceptance-note.md',
          worktreeSha256: 'c'.repeat(64)
        }
      ],
      foreignUntrackedDirt: [
        {
          status: '??',
          path: '.local-only.patch',
          worktreeSha256: 'd'.repeat(64)
        }
      ]
    })

    const foreignOnly = await classifyStudioAcceptanceDirt(
      [' M docs/acceptance-note.md', '?? .local-only.patch', ''].join('\0'),
      digestPath
    )
    expect(foreignOnly).toMatchObject({
      wholeTrackedTreeClean: false,
      wholeWorkspaceClean: false,
      studioPathsClean: true,
      studioTrackedDirt: [],
      studioUntrackedDirt: [],
      foreignTrackedDirt: expect.any(Array),
      foreignUntrackedDirt: expect.any(Array)
    })
  })

  it.runIf(process.platform !== 'win32')('builds the exact resolver-preferred debug products before selecting them', async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []
    const result = await runStudioAcceptanceBuild({
      repoRoot: '/virtual/repo',
      execFile: async (command: string, args: string[], options: { cwd: string }) => {
        calls.push({ command, args, cwd: options.cwd })
        return { stdout: '', stderr: '', exitCode: 0 }
      }
    })

    expect(calls).toEqual([
      {
        command: 'swift',
        args: [
          'build',
          '--disable-sandbox',
          '-c',
          'debug',
          '--package-path',
          'swift/TaskWraithBridge',
          '--product',
          'TaskWraithBridgeDaemon'
        ],
        cwd: '/virtual/repo'
      },
      {
        command: 'swift',
        args: [
          'build',
          '--disable-sandbox',
          '-c',
          'debug',
          '--package-path',
          'swift/TaskWraithBridge',
          '--product',
          'TaskWraithStudioCompanion'
        ],
        cwd: '/virtual/repo'
      },
      {
        command: 'npm',
        args: ['run', 'prebuild:bridge-daemon'],
        cwd: '/virtual/repo'
      },
      {
        command: 'npm',
        args: ['run', 'prebuild:studio-companion'],
        cwd: '/virtual/repo'
      },
      {
        command: 'npx',
        args: ['electron-vite', 'build'],
        cwd: '/virtual/repo'
      }
    ])
    expect(result).toMatchObject({
      ok: true,
      selectedNativeProducts: {
        bridgeDaemon: 'swift/TaskWraithBridge/.build/debug/TaskWraithBridgeDaemon',
        companion: 'swift/TaskWraithBridge/.build/debug/TaskWraithStudioCompanion'
      }
    })
  })

  it('never substitutes retained release binaries for the selected debug products', async () => {
    const root = await temporaryRoot('studio-acceptance-native-selection-')
    const releaseRoot = path.join(root, 'swift/TaskWraithBridge/.build/release')
    const debugRoot = path.join(root, 'swift/TaskWraithBridge/.build/debug')
    await fsPromises.mkdir(path.join(root, 'out'), { recursive: true })
    await fsPromises.mkdir(releaseRoot, { recursive: true })
    await fsPromises.writeFile(path.join(root, 'out/main.js'), 'built renderer')
    await fsPromises.writeFile(path.join(releaseRoot, 'TaskWraithStudioCompanion'), 'release')
    await fsPromises.writeFile(path.join(releaseRoot, 'TaskWraithBridgeDaemon'), 'release')

    await expect(measureStudioAcceptanceArtifacts(root)).rejects.toThrow(
      /selected companion binary/
    )

    await fsPromises.mkdir(debugRoot, { recursive: true })
    await fsPromises.writeFile(path.join(debugRoot, 'TaskWraithStudioCompanion'), 'debug companion')
    await fsPromises.writeFile(path.join(debugRoot, 'TaskWraithBridgeDaemon'), 'debug bridge')
    await expect(measureStudioAcceptanceArtifacts(root)).resolves.toMatchObject({
      artifactCount: 3,
      outCount: 1,
      companionPath: 'swift/TaskWraithBridge/.build/debug/TaskWraithStudioCompanion',
      companionSha256: crypto.createHash('sha256').update('debug companion').digest('hex'),
      bridgeDaemonPath: 'swift/TaskWraithBridge/.build/debug/TaskWraithBridgeDaemon',
      bridgeDaemonSha256: crypto.createHash('sha256').update('debug bridge').digest('hex')
    })
  })

  it('measures the pinned live-build source and support custody from the workspace', async () => {
    const receipt = await measureStudioAcceptanceCustody({
      repoRoot: path.resolve(__dirname, '..'),
      env: {},
      buildReady: false
    })

    expect(receipt).toMatchObject({
      requiredProductAncestor: '4b4c1913acd777277d16ae638c39bae635f1355e',
      productAncestorPresent: true,
      sourceDigest: '35b6f9b4208ab8f8f901a7ee0d048fa03125a33336cbee72b8468255f3b4d433',
      sourceCount: 2425,
      buildEnvironmentDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      buildEnvironmentCount: 0,
      supportMatches: true,
      artifactDigest: null,
      artifactCount: null,
      outDigest: null,
      outCount: null,
      companionSha256: null,
      bridgeDaemonSha256: null
    })
    expect(receipt.supportHashes).toEqual(receipt.expectedSupportHashes)
    expect(receipt.runnerSha256).toMatch(/^[a-f0-9]{64}$/)
  }, 30_000)

  it('requires one source, built-artifact, fixture, and support custody conjunction before and after', () => {
    const sourceCustody = {
      head: '1'.repeat(40),
      requiredProductAncestor: '2'.repeat(40),
      productAncestorPresent: true,
      wholeTrackedTreeClean: false,
      wholeWorkspaceClean: false,
      studioPathsClean: true,
      studioTrackedDirt: [],
      studioUntrackedDirt: [],
      foreignTrackedDirt: [
        {
          status: ' M',
          path: 'docs/acceptance-note.md',
          worktreeSha256: '3'.repeat(64)
        }
      ],
      foreignUntrackedDirt: [],
      sourceDigest: '4'.repeat(64),
      sourceCount: 42,
      buildEnvironmentDigest: '5'.repeat(64),
      buildEnvironmentCount: 0,
      supportHashes: { 'scripts/studio-acceptance-watchdog.cjs': '6'.repeat(64) },
      supportMatches: true,
      runnerSha256: '7'.repeat(64),
      artifactDigest: null,
      artifactCount: null,
      outDigest: null,
      outCount: null,
      companionSha256: null,
      bridgeDaemonSha256: null,
      fixtureSha256: null,
      fixtureByteLength: null
    }
    const fixture = { sha256: '8'.repeat(64), byteLength: 123 }
    const custodyBefore = {
      ...sourceCustody,
      artifactDigest: '9'.repeat(64),
      artifactCount: 105,
      outDigest: 'a'.repeat(64),
      outCount: 102,
      companionPath: 'swift/TaskWraithBridge/.build/debug/TaskWraithStudioCompanion',
      companionSha256: 'b'.repeat(64),
      bridgeDaemonPath: 'swift/TaskWraithBridge/.build/debug/TaskWraithBridgeDaemon',
      bridgeDaemonSha256: 'c'.repeat(64),
      fixtureSha256: fixture.sha256,
      fixtureByteLength: fixture.byteLength
    }
    const expected = {
      sourceDigest: sourceCustody.sourceDigest,
      sourceCount: sourceCustody.sourceCount,
      buildEnvironmentDigest: sourceCustody.buildEnvironmentDigest,
      buildEnvironmentCount: sourceCustody.buildEnvironmentCount,
      companionPath: custodyBefore.companionPath,
      companionSha256: custodyBefore.companionSha256,
      bridgeDaemonPath: custodyBefore.bridgeDaemonPath,
      bridgeDaemonSha256: custodyBefore.bridgeDaemonSha256
    }

    expect(assertStudioAcceptanceCustody(sourceCustody, { phase: 'source', expected })).toBe(
      sourceCustody
    )
    expect(
      assertStudioAcceptanceCustody(custodyBefore, {
        phase: 'before-run',
        sourceCustody,
        fixture,
        expected
      })
    ).toBe(custodyBefore)
    expect(
      assertStudioAcceptanceCustody(
        {
          ...custodyBefore,
          foreignTrackedDirt: [
            {
              status: ' M',
              path: 'docs/later-note.md',
              worktreeSha256: 'd'.repeat(64)
            }
          ]
        },
        {
          phase: 'after-run',
          sourceCustody,
          custodyBefore,
          fixture,
          expected
        }
      )
    ).toMatchObject({ artifactDigest: custodyBefore.artifactDigest })

    expect(() =>
      assertStudioAcceptanceCustody(
        { ...sourceCustody, studioPathsClean: false },
        { phase: 'source', expected }
      )
    ).toThrow(/build-input dirt/)
    expect(() =>
      assertStudioAcceptanceCustody(
        { ...sourceCustody, sourceDigest: 'e'.repeat(64) },
        { phase: 'source', expected }
      )
    ).toThrow(/source custody pins/)
    expect(() =>
      assertStudioAcceptanceCustody(
        { ...sourceCustody, buildEnvironmentDigest: 'f'.repeat(64) },
        { phase: 'source', expected }
      )
    ).toThrow(/source custody pins/)
    expect(() =>
      assertStudioAcceptanceCustody(
        { ...custodyBefore, supportMatches: false },
        { phase: 'before-run', sourceCustody, fixture, expected }
      )
    ).toThrow(/support/)
    expect(() =>
      assertStudioAcceptanceCustody(
        { ...custodyBefore, companionSha256: 'f'.repeat(64) },
        { phase: 'before-run', sourceCustody, fixture, expected }
      )
    ).toThrow(/built artifact custody pins/)
    expect(() =>
      assertStudioAcceptanceCustody(
        {
          ...custodyBefore,
          companionPath: 'swift/TaskWraithBridge/.build/release/TaskWraithStudioCompanion'
        },
        { phase: 'before-run', sourceCustody, fixture, expected }
      )
    ).toThrow(/built artifact custody pins/)
    expect(() =>
      assertStudioAcceptanceCustody(
        { ...custodyBefore, fixtureSha256: 'f'.repeat(64) },
        { phase: 'before-run', sourceCustody, fixture, expected }
      )
    ).toThrow(/fixture/)
    expect(() =>
      assertStudioAcceptanceCustody(
        { ...custodyBefore, outDigest: '0'.repeat(64) },
        { phase: 'after-run', sourceCustody, custodyBefore, fixture, expected }
      )
    ).toThrow(/built artifact/)
  })

  it('binds the persisted generated fixture to the exact bytes opened by Studio', async () => {
    const root = await temporaryRoot('studio-speech-fixture-custody-')
    const artifactRoot = path.join(root, 'artifacts')
    const fixtureDirectory = path.join(artifactRoot, 'fixtures')
    const speechPath = path.join(fixtureDirectory, 'acceptance-speech.aiff')
    const outputPath = path.join(fixtureDirectory, 'acceptance-speech-30s.mp4')
    const manifestPath = path.join(fixtureDirectory, 'speech-fixture-manifest.json')
    await fsPromises.mkdir(fixtureDirectory, { recursive: true })
    const speechBytes = Buffer.from('deterministic speech')
    const outputBytes = Buffer.from('deterministic muxed fixture')
    await fsPromises.writeFile(speechPath, speechBytes)
    await fsPromises.writeFile(outputPath, outputBytes)
    const fixturePlan = describeFixturePlan({ durationSeconds: 30 })
    const manifest = {
      schemaVersion: 1,
      kind: 'taskwraith-studio-generated-speech-fixture',
      ...fixturePlan,
      speechPath,
      outputPath,
      manifestPath,
      mimeType: 'video/mp4',
      speechSha256: crypto.createHash('sha256').update(speechBytes).digest('hex'),
      outputSha256: crypto.createHash('sha256').update(outputBytes).digest('hex'),
      speechByteLength: speechBytes.length,
      outputByteLength: outputBytes.length,
      sayCommand: buildSayCommand({ outputPath: speechPath }),
      muxCommand: buildMuxCommand({
        speechPath,
        outputPath,
        durationSeconds: fixturePlan.durationSeconds
      }),
      sayExitCode: 0,
      muxExitCode: 0
    }
    await fsPromises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const asset = await materializeOwnedMedia({
      mediaPath: outputPath,
      mimeType: 'video/mp4',
      userDataPath: path.join(root, 'user-data')
    })

    await expect(
      assertGeneratedSpeechFixtureCustody(manifest, asset, artifactRoot)
    ).resolves.toMatchObject({
      ok: true,
      outputSha256: manifest.outputSha256,
      outputByteLength: outputBytes.length,
      assetSha256: crypto.createHash('sha256').update(outputBytes).digest('base64url'),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })

    const forgedDigest = { ...manifest, outputSha256: 'b'.repeat(64) }
    await fsPromises.writeFile(manifestPath, `${JSON.stringify(forgedDigest, null, 2)}\n`)
    await expect(
      assertGeneratedSpeechFixtureCustody(forgedDigest, asset, artifactRoot)
    ).rejects.toThrow(/output digest/)

    const forgedLength = { ...manifest, outputByteLength: outputBytes.length + 1 }
    await fsPromises.writeFile(manifestPath, `${JSON.stringify(forgedLength, null, 2)}\n`)
    await expect(
      assertGeneratedSpeechFixtureCustody(forgedLength, asset, artifactRoot)
    ).rejects.toThrow(/output byte length/)

    const escapedPath = { ...manifest, outputPath: path.join(root, 'outside.mp4') }
    await fsPromises.writeFile(manifestPath, `${JSON.stringify(escapedPath, null, 2)}\n`)
    await expect(
      assertGeneratedSpeechFixtureCustody(escapedPath, asset, artifactRoot)
    ).rejects.toThrow(/artifact-root path/)
  })

  it.runIf(process.platform === 'darwin')('drives the authorized renderer-to-durable-window joins in order without launching Electron', async () => {
    const root = await temporaryRoot('studio-acceptance-joins-')
    const artifactRoot = path.join(root, 'acceptance', 'studioJoin01')
    const calls: string[] = []
    const renderer = { close: () => calls.push('renderer.close') }
    const watchdogTerminal = {
      status: 'reaped',
      reason: 'owner_requested',
      groupExitVerified: true,
      detachedGroupExitVerified: true
    }
    let journeyError: Error | null = null
    let writtenEvidence: Record<string, any> | null = null
    let forgeFixtureDigest = false
    let dirtySourceCustody = false
    const session = {
      pid: 7001,
      pgid: 7001,
      remoteDebuggingPort: 9401,
      mainInspectorPort: 9801,
      stop: async () => {
        calls.push('watchdog.stop')
        return watchdogTerminal
      }
    }

    let speechFixture: Record<string, any> | null = null
    const custodySource = {
      head: '1'.repeat(40),
      requiredProductAncestor: '2'.repeat(40),
      productAncestorPresent: true,
      wholeTrackedTreeClean: true,
      wholeWorkspaceClean: true,
      studioPathsClean: true,
      studioTrackedDirt: [],
      studioUntrackedDirt: [],
      foreignTrackedDirt: [],
      foreignUntrackedDirt: [],
      sourceDigest: '3'.repeat(64),
      sourceCount: 42,
      buildEnvironmentDigest: '4'.repeat(64),
      buildEnvironmentCount: 0,
      supportHashes: { 'scripts/studio-acceptance-watchdog.cjs': '5'.repeat(64) },
      supportMatches: true,
      runnerSha256: '6'.repeat(64),
      artifactDigest: null,
      artifactCount: null,
      outDigest: null,
      outCount: null,
      companionPath: null,
      companionSha256: null,
      bridgeDaemonPath: null,
      bridgeDaemonSha256: null,
      fixtureSha256: null,
      fixtureByteLength: null
    }
    const builtCustody = () => ({
      ...custodySource,
      artifactDigest: '7'.repeat(64),
      artifactCount: 105,
      outDigest: '8'.repeat(64),
      outCount: 103,
      companionPath: 'swift/TaskWraithBridge/.build/debug/TaskWraithStudioCompanion',
      companionSha256: '9'.repeat(64),
      bridgeDaemonPath: 'swift/TaskWraithBridge/.build/debug/TaskWraithBridgeDaemon',
      bridgeDaemonSha256: 'a'.repeat(64),
      fixtureSha256: speechFixture?.outputSha256,
      fixtureByteLength: speechFixture?.outputByteLength
    })
    const custodyExpected = {
      sourceDigest: custodySource.sourceDigest,
      sourceCount: custodySource.sourceCount,
      buildEnvironmentDigest: custodySource.buildEnvironmentDigest,
      buildEnvironmentCount: custodySource.buildEnvironmentCount,
      companionPath: 'swift/TaskWraithBridge/.build/debug/TaskWraithStudioCompanion',
      companionSha256: '9'.repeat(64),
      bridgeDaemonPath: 'swift/TaskWraithBridge/.build/debug/TaskWraithBridgeDaemon',
      bridgeDaemonSha256: 'a'.repeat(64)
    }
    const args = {
      ...parseArgs([]),
      launch: true,
      acceptLaunch: true,
      ownerConfirmsOrphansCleared: true,
      instanceId: 'studioJoin01',
      generateSpeechFixture: true
    }
    const adapters = {
      custodyExpected,
      measureCustody: async ({ phase }: { phase: string }) => {
        calls.push(`custody.${phase}`)
        if (phase !== 'source') return builtCustody()
        return dirtySourceCustody
          ? {
              ...custodySource,
              studioPathsClean: false,
              studioTrackedDirt: [
                {
                  status: ' M',
                  path: 'src/main/store/ConcurrentProductEdit.ts',
                  worktreeSha256: 'f'.repeat(64)
                }
              ]
            }
          : custodySource
      },
      planOptions: {
        repoRoot: root,
        artifactRoot,
        home: path.join(artifactRoot, 'home'),
        platform: 'darwin',
        adapters: { resolveElectronPath: () => '/virtual/Electron' }
      },
      generateSpeechFixture: async ({ artifactRoot }: { artifactRoot: string }) => {
        const fixtureDirectory = path.join(artifactRoot, 'fixtures')
        const speechPath = path.join(fixtureDirectory, 'acceptance-speech.aiff')
        const outputPath = path.join(fixtureDirectory, 'acceptance-speech-30s.mp4')
        const manifestPath = path.join(fixtureDirectory, 'speech-fixture-manifest.json')
        await fsPromises.mkdir(fixtureDirectory, { recursive: true })
        const speechBytes = Buffer.from('joined speech')
        const outputBytes = Buffer.from('joined fixture')
        await fsPromises.writeFile(speechPath, speechBytes)
        await fsPromises.writeFile(outputPath, outputBytes)
        const fixturePlan = describeFixturePlan({ durationSeconds: 30 })
        speechFixture = {
          schemaVersion: 1,
          kind: 'taskwraith-studio-generated-speech-fixture',
          ...fixturePlan,
          speechPath,
          outputPath,
          manifestPath,
          mimeType: 'video/mp4',
          speechSha256: crypto.createHash('sha256').update(speechBytes).digest('hex'),
          outputSha256: forgeFixtureDigest
            ? 'b'.repeat(64)
            : crypto.createHash('sha256').update(outputBytes).digest('hex'),
          speechByteLength: speechBytes.length,
          outputByteLength: outputBytes.length,
          sayCommand: buildSayCommand({ outputPath: speechPath }),
          muxCommand: buildMuxCommand({
            speechPath,
            outputPath,
            durationSeconds: fixturePlan.durationSeconds
          }),
          sayExitCode: 0,
          muxExitCode: 0
        }
        await fsPromises.writeFile(manifestPath, `${JSON.stringify(speechFixture, null, 2)}\n`)
        calls.push('fixture.generate')
        return speechFixture
      },
      assertLaunchPortsFree: async () => {
        calls.push('ports.free')
      },
      runBuild: async () => {
        calls.push('build')
      },
      launchUnderWatchdog: async (spec: { env: Record<string, string> }) => {
        expect(spec.env.TASKWRAITH_GROK_USAGE_BINARY_OVERRIDE).toBe(
          path.join(artifactRoot, 'home', '.grok', 'bin', 'grok')
        )
        calls.push('watchdog.launch')
        return session
      },
      assertExactChildOwnsDebugPorts: async () => {
        calls.push('ports.owned')
      },
      attachRenderer: async () => {
        calls.push('renderer.attach')
        return renderer
      },
      invokeStudioOpen: async (_renderer: unknown, asset: { sha256: string }) => {
        calls.push('preload.open')
        return { ok: true, assetId: asset.sha256 }
      },
      verifyDurableOpen: async () => {
        calls.push('journal.verify')
        return { revision: 1 }
      },
      findCompanion: async () => {
        calls.push('companion.find')
        return {
          pid: 7002,
          ppid: 7001,
          pgid: 7001,
          command: `${path.join(
            root,
            'swift/TaskWraithBridge/.build/debug/TaskWraithStudioCompanion'
          )} --viewer`
        }
      },
      probeWindow: async () => {
        calls.push('window.probe')
        return {
          pid: 7002,
          visibleWindowCount: 1,
          windows: [
            {
              windowId: 42,
              title: 'TaskWraith Studio',
              bounds: { x: 100, y: 100, width: 1280, height: 720 }
            }
          ]
        }
      },
      driveUiJourney: async (
        _plan: unknown,
        target: { speechFixture: Record<string, unknown> }
      ) => {
        expect(target.speechFixture).toEqual(speechFixture)
        calls.push('journey.drive')
        if (journeyError) throw journeyError
        return { ok: true, screenshots: ['/virtual/final.png'] }
      },
      writeEvidence: async (_plan: unknown, evidence: Record<string, any>) => {
        writtenEvidence = evidence
        calls.push('evidence.write')
      }
    }

    const result = await runStudioAcceptance(args, adapters)

    expect(result).toMatchObject({
      launched: true,
      evidence: {
        ok: true,
        electron: { pid: 7001, pgid: 7001 },
        companion: { pid: 7002 },
        window: { visibleWindowCount: 1 },
        speechFixture,
        speechFixtureCustody: {
          ok: true,
          outputSha256: speechFixture?.outputSha256,
          outputByteLength: speechFixture?.outputByteLength,
          manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        },
        custodyFixture: {
          sha256: speechFixture?.outputSha256,
          byteLength: speechFixture?.outputByteLength,
          provenance: 'generated-speech-fixture'
        },
        custodySource,
        custodyBefore: expect.objectContaining({ artifactDigest: '7'.repeat(64) }),
        custodyAfter: expect.objectContaining({ artifactDigest: '7'.repeat(64) }),
        companionCustody: {
          ok: true,
          sha256: '9'.repeat(64),
          expectedPath: path.join(
            root,
            'swift/TaskWraithBridge/.build/debug/TaskWraithStudioCompanion'
          )
        },
        durable: { revision: 1 },
        journey: { ok: true, screenshots: ['/virtual/final.png'] },
        watchdogTerminal
      }
    })
    expect(calls).toEqual([
      'custody.source',
      'fixture.generate',
      'ports.free',
      'build',
      'custody.before-run',
      'watchdog.launch',
      'ports.owned',
      'renderer.attach',
      'preload.open',
      'journal.verify',
      'companion.find',
      'window.probe',
      'journey.drive',
      'renderer.close',
      'watchdog.stop',
      'custody.after-run',
      'evidence.write'
    ])
    expect(writtenEvidence).toMatchObject({ ok: true })

    calls.length = 0
    writtenEvidence = null
    journeyError = new Error('mid-action failure')
    await expect(runStudioAcceptance(args, adapters)).rejects.toThrow(/mid-action failure/)
    expect(calls).toEqual([
      'custody.source',
      'fixture.generate',
      'ports.free',
      'build',
      'custody.before-run',
      'watchdog.launch',
      'ports.owned',
      'renderer.attach',
      'preload.open',
      'journal.verify',
      'companion.find',
      'window.probe',
      'journey.drive',
      'renderer.close',
      'watchdog.stop',
      'custody.after-run',
      'evidence.write'
    ])
    expect(writtenEvidence).toMatchObject({
      ok: false,
      verdict: 'RED',
      failure: expect.objectContaining({ message: 'mid-action failure' }),
      custodySource,
      custodyBefore: expect.objectContaining({ artifactDigest: '7'.repeat(64) }),
      custodyAfter: expect.objectContaining({ artifactDigest: '7'.repeat(64) }),
      artifactReferences: {
        fixtureManifest: expect.objectContaining({
          present: true,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        }),
        generatedFixture: expect.objectContaining({
          present: true,
          sha256: speechFixture?.outputSha256
        }),
        openedMedia: expect.objectContaining({
          present: true,
          sha256: speechFixture?.outputSha256
        }),
        watchdogReceipt: expect.objectContaining({ present: false })
      },
      watchdogTerminal
    })

    calls.length = 0
    journeyError = null
    forgeFixtureDigest = true
    await expect(
      runStudioAcceptance({ ...args, instanceId: 'studioForge01' }, adapters)
    ).rejects.toThrow(/output digest/)
    expect(calls).toEqual(['custody.source', 'fixture.generate'])

    calls.length = 0
    forgeFixtureDigest = false
    dirtySourceCustody = true
    await expect(
      runStudioAcceptance({ ...args, instanceId: 'studioDirty01' }, adapters)
    ).rejects.toThrow(/build-input dirt/)
    expect(calls).toEqual(['custody.source'])
  })

  describe('Studio one-window workspace acceptance join', () => {
    describe('resolveStudioWorkspaceWindow', () => {
      it('accepts the exact single workspace window and stamps expectedWindowTitle', () => {
        const target = {
          window: {
            pid: 7002,
            visibleWindowCount: 1,
            windows: [{ windowId: 42, title: 'TaskWraith Studio', bounds: WORKSPACE_WINDOW_BOUNDS }]
          }
        }
        const resolved = resolveStudioWorkspaceWindow(target)
        expect(resolved.expectedWindowTitle).toBe('TaskWraith Studio')
        expect(resolved.window).toBe(target.window)
      })

      it('rejects a missing window set', () => {
        expect(() => resolveStudioWorkspaceWindow({})).toThrow(/exact visible-window set/)
      })

      it('rejects zero visible windows', () => {
        const target = { window: { pid: 7002, visibleWindowCount: 0, windows: [] } }
        expect(() => resolveStudioWorkspaceWindow(target)).toThrow(
          /exactly one visible workspace window/
        )
      })

      it('rejects the retired two-window Source/Review model', () => {
        const target = {
          window: {
            pid: 7002,
            visibleWindowCount: 2,
            windows: [
              { windowId: 41, title: 'TaskWraith Studio — Source', bounds: WORKSPACE_WINDOW_BOUNDS },
              { windowId: 42, title: 'TaskWraith Studio — Review', bounds: WORKSPACE_WINDOW_BOUNDS }
            ]
          }
        }
        expect(() => resolveStudioWorkspaceWindow(target)).toThrow(
          /exactly one visible workspace window/
        )
      })

      it('rejects duplicate exact-title windows', () => {
        const target = {
          window: {
            pid: 7002,
            visibleWindowCount: 2,
            windows: [
              { windowId: 42, title: 'TaskWraith Studio', bounds: WORKSPACE_WINDOW_BOUNDS },
              { windowId: 43, title: 'TaskWraith Studio', bounds: WORKSPACE_WINDOW_BOUNDS }
            ]
          }
        }
        expect(() => resolveStudioWorkspaceWindow(target)).toThrow(
          /exactly one visible workspace window/
        )
      })

      it('rejects a single window with a mismatched title', () => {
        const target = {
          window: {
            pid: 7002,
            visibleWindowCount: 1,
            windows: [
              { windowId: 42, title: 'TaskWraith Studio — Source', bounds: WORKSPACE_WINDOW_BOUNDS }
            ]
          }
        }
        expect(() => resolveStudioWorkspaceWindow(target)).toThrow(
          /requires the single TaskWraith Studio workspace window/
        )
      })
    })

    describe('validateStudioWorkspaceObservation', () => {
      it('accepts the exact valid review-presented observation and normalizes keys', () => {
        const normalized = validateStudioWorkspaceObservation(
          validWorkspaceObservation(true),
          WORKSPACE_WINDOW_BOUNDS
        )
        expect(Object.keys(normalized).sort()).toEqual(
          [
            'currentVersion',
            'proposedVersion',
            'root',
            'sourceHost',
            'sourceRoute',
            'timelineHost',
            'timelineRoute'
          ].sort()
        )
        expect(normalized.timelineHost).toEqual({
          visible: true,
          role: 'AXGroup',
          value: null,
          enabled: null,
          frame: WORKSPACE_REVIEW_HOST_FRAME
        })
        expect(normalized.sourceHost).toEqual({
          visible: false,
          role: null,
          value: null,
          enabled: null,
          frame: null
        })
      })

      it('accepts the exact valid source-only observation', () => {
        expect(() =>
          validateStudioWorkspaceObservation(validWorkspaceObservation(false), WORKSPACE_WINDOW_BOUNDS)
        ).not.toThrow()
      })

      it('rejects a non-record or extra-keyed top-level observation', () => {
        expect(() => validateStudioWorkspaceObservation(null, WORKSPACE_WINDOW_BOUNDS)).toThrow(
          /not one exact elements array/
        )
        expect(() =>
          validateStudioWorkspaceObservation({ elements: [], extra: true }, WORKSPACE_WINDOW_BOUNDS)
        ).toThrow(/not one exact elements array/)
      })

      it('rejects a wrong element count', () => {
        const obs = validWorkspaceObservation(true)
        obs.elements.pop()
        expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
          /exact element count/
        )
      })

      it('rejects a required identifier displaced by a duplicate', () => {
        const obs = validWorkspaceObservation(true)
        obs.elements[0].identifier = obs.elements[1].identifier
        expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
          /duplicates identifier/
        )
      })

      it('rejects a required identifier displaced by an unrecognized one', () => {
        const obs = validWorkspaceObservation(true)
        obs.elements[0].identifier = 'studio.workspace.bogus'
        expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
          /is missing identifier studio\.workspace\.root/
        )
      })

      it('rejects an element with an extra field', () => {
        const obs = validWorkspaceObservation(true)
        ;(obs.elements[0] as Record<string, any>).extra = true
        expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
          /malformed or extra element field/
        )
      })

      it('rejects an element with a renamed required field', () => {
        const obs = validWorkspaceObservation(true)
        const element = obs.elements[0] as Record<string, any>
        element.frames = element.frame
        delete element.frame
        expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
          /missing element field frame/
        )
      })

      it('rejects a non-string identifier', () => {
        const obs = validWorkspaceObservation(true)
        ;(obs.elements[0] as Record<string, any>).identifier = 42
        expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
          /identifier is not an exact string/
        )
      })

      it('rejects a non-boolean visible flag', () => {
        const obs = validWorkspaceObservation(true)
        ;(obs.elements[0] as Record<string, any>).visible = 'true'
        expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
          /visibility is not boolean/
        )
      })

      describe('root element contract', () => {
        it('rejects a hidden root', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[0].visible = false
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /root must be visible/
          )
        })
        it('rejects a non-AXGroup root role', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[0].role = 'AXWindow'
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /root is not an AXGroup/
          )
        })
        it('rejects a root carrying a value', () => {
          const obs = validWorkspaceObservation(true)
          ;(obs.elements[0] as Record<string, any>).value = 'oops'
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /root must not carry a value/
          )
        })
        it('rejects a root carrying an enabled flag', () => {
          const obs = validWorkspaceObservation(true)
          ;(obs.elements[0] as Record<string, any>).enabled = true
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /root must not carry an enabled flag/
          )
        })
        it('rejects a root frame outside the window', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[0].frame = { x: 5000, y: 5000, width: 10, height: 10 }
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /root frame is outside the immutable window bounds/
          )
        })
      })

      describe('host element contract', () => {
        it('rejects a hidden host carrying a role', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[3].role = 'AXGroup' // sourceHost is hidden when review === true
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /hidden workspace host .* must not carry role\/value\/enabled\/frame/
          )
        })
        it('rejects a hidden host carrying a frame', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[3].frame = { x: 0, y: 0, width: 10, height: 10 }
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /hidden workspace host .* must not carry role\/value\/enabled\/frame/
          )
        })
        it('rejects a visible host with the wrong role', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[4].role = 'AXScrollArea' // timelineHost is visible when review === true
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /is not an AXGroup/
          )
        })
        it('rejects a visible host carrying a value', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[4].value = 'oops'
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /must not carry a value/
          )
        })
        it('rejects a visible host frame outside the window', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[4].frame = { x: 5000, y: 5000, width: 10, height: 10 }
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /frame is outside the immutable window bounds/
          )
        })
      })

      describe('route element contract', () => {
        it('rejects a hidden route control', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[1].visible = false
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /route control .* must be visible/
          )
        })
        it('rejects a non-AXCheckBox route role', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[1].role = 'AXButton'
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /is not an AXCheckBox/
          )
        })
        it('rejects an invalid route value', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[1].value = 'on'
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /has an invalid value/
          )
        })
        it('rejects a disabled route control', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[1].enabled = false
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /must be enabled/
          )
        })
        it('rejects a route frame outside the window', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[1].frame = { x: -5000, y: 0, width: 10, height: 10 }
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /route control .* frame is outside/
          )
        })
      })

      describe('review-version element contract', () => {
        it('rejects a hidden version control', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[5].visible = false
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /version control .* must be visible/
          )
        })
        it('rejects a non-AXRadioButton version role', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[5].role = 'AXCheckBox'
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /is not an AXRadioButton/
          )
        })
        it('rejects an invalid version value', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[5].value = 'on'
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /has an invalid value/
          )
        })
        it('rejects enabled=true paired with value=unavailable', () => {
          const obs = validWorkspaceObservation(false)
          obs.elements[5].enabled = true
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /enabled state does not match its value/
          )
        })
        it('rejects enabled=false paired with a real selection value', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[5].enabled = false
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /enabled state does not match its value/
          )
        })
        it('rejects a version control frame outside the window', () => {
          const obs = validWorkspaceObservation(true)
          obs.elements[5].frame = { x: 0, y: 5000, width: 10, height: 10 }
          expect(() => validateStudioWorkspaceObservation(obs, WORKSPACE_WINDOW_BOUNDS)).toThrow(
            /version control .* frame is outside/
          )
        })
      })
    })

    describe('studioWorkspaceReviewPresented', () => {
      it('is true for a fully review-ready workspace', () => {
        const normalized = validateStudioWorkspaceObservation(
          validWorkspaceObservation(true),
          WORKSPACE_WINDOW_BOUNDS
        )
        expect(studioWorkspaceReviewPresented(normalized)).toBe(true)
      })

      it('is false before the Timeline route is selected', () => {
        const normalized = validateStudioWorkspaceObservation(
          validWorkspaceObservation(false),
          WORKSPACE_WINDOW_BOUNDS
        )
        expect(studioWorkspaceReviewPresented(normalized)).toBe(false)
      })

      it('is false when Timeline is selected but its host is still hidden (necessary, not sufficient)', () => {
        const normalized = validateStudioWorkspaceObservation(
          validWorkspaceObservation(true),
          WORKSPACE_WINDOW_BOUNDS
        )
        normalized.timelineHost = { ...normalized.timelineHost, visible: false }
        expect(studioWorkspaceReviewPresented(normalized)).toBe(false)
      })

      it('is false when the Timeline host is visible but its route is not selected', () => {
        const normalized = validateStudioWorkspaceObservation(
          validWorkspaceObservation(true),
          WORKSPACE_WINDOW_BOUNDS
        )
        normalized.timelineRoute = { ...normalized.timelineRoute, value: 'not selected' }
        expect(studioWorkspaceReviewPresented(normalized)).toBe(false)
      })

      it('is false when neither Current nor Proposed reports selected', () => {
        const normalized = validateStudioWorkspaceObservation(
          validWorkspaceObservation(true),
          WORKSPACE_WINDOW_BOUNDS
        )
        normalized.currentVersion = { ...normalized.currentVersion, value: 'not selected' }
        expect(studioWorkspaceReviewPresented(normalized)).toBe(false)
      })

      it('is false when both Current and Proposed report selected', () => {
        const normalized = validateStudioWorkspaceObservation(
          validWorkspaceObservation(true),
          WORKSPACE_WINDOW_BOUNDS
        )
        normalized.proposedVersion = { ...normalized.proposedVersion, value: 'selected' }
        expect(studioWorkspaceReviewPresented(normalized)).toBe(false)
      })

      it('is false when an A/B control is disabled/unavailable', () => {
        const normalized = validateStudioWorkspaceObservation(
          validWorkspaceObservation(true),
          WORKSPACE_WINDOW_BOUNDS
        )
        normalized.proposedVersion = { ...normalized.proposedVersion, enabled: false, value: 'unavailable' }
        expect(studioWorkspaceReviewPresented(normalized)).toBe(false)
      })

      it('is false when an A/B control does not carry the radio role', () => {
        const normalized = validateStudioWorkspaceObservation(
          validWorkspaceObservation(true),
          WORKSPACE_WINDOW_BOUNDS
        )
        normalized.currentVersion = { ...normalized.currentVersion, role: 'AXCheckBox' }
        expect(studioWorkspaceReviewPresented(normalized)).toBe(false)
      })

      it('does not require Source to be hidden (wide-dual presentation still counts)', () => {
        const normalized = validateStudioWorkspaceObservation(
          validWorkspaceObservation(true),
          WORKSPACE_WINDOW_BOUNDS
        )
        normalized.sourceHost = { ...normalized.sourceHost, visible: true }
        expect(studioWorkspaceReviewPresented(normalized)).toBe(true)
      })
    })

    describe('studioReviewHostCaptureRegion', () => {
      const bounds = { x: 100, y: 50, width: 1280, height: 800 }
      const image = { width: 2560, height: 1600 }

      it('derives an explicit, tested 2x transform from the host frame (no orientation flip)', () => {
        const hostFrame = { x: 740, y: 90, width: 620, height: 700 }
        const region = studioReviewHostCaptureRegion(image, bounds, hostFrame)
        expect(region).toEqual({ x: 1280, y: 80, width: 1240, height: 1400 })
        expect(region.x + region.width).toBeLessThanOrEqual(image.width)
        expect(region.y + region.height).toBeLessThanOrEqual(image.height)
      })

      it('rejects non-integer or non-positive window bounds', () => {
        expect(() =>
          studioReviewHostCaptureRegion(
            image,
            { x: 0, y: 0, width: 1280.5, height: 800 },
            { x: 0, y: 0, width: 10, height: 10 }
          )
        ).toThrow(/window bounds are invalid/)
        expect(() =>
          studioReviewHostCaptureRegion(
            image,
            { x: 0, y: 0, width: 0, height: 800 },
            { x: 0, y: 0, width: 10, height: 10 }
          )
        ).toThrow(/window bounds are invalid/)
      })

      it('rejects a non-finite window origin', () => {
        expect(() =>
          studioReviewHostCaptureRegion(
            image,
            { x: Number.NaN, y: 0, width: 1280, height: 800 },
            { x: 0, y: 0, width: 10, height: 10 }
          )
        ).toThrow(/window bounds are invalid/)
      })

      it('rejects a screenshot that is not exactly 2x the window bounds', () => {
        expect(() =>
          studioReviewHostCaptureRegion({ width: 100, height: 100 }, bounds, {
            x: 740,
            y: 90,
            width: 620,
            height: 700
          })
        ).toThrow(/exact 2x window bounds/)
      })

      it('rejects a non-finite or non-positive host frame', () => {
        expect(() =>
          studioReviewHostCaptureRegion(image, bounds, { x: 0, y: 0, width: 0, height: 10 })
        ).toThrow(/bounded finite rectangle/)
        expect(() =>
          studioReviewHostCaptureRegion(image, bounds, {
            x: Number.POSITIVE_INFINITY,
            y: 0,
            width: 10,
            height: 10
          })
        ).toThrow(/bounded finite rectangle/)
        expect(() =>
          studioReviewHostCaptureRegion(image, bounds, { x: 0, y: 0, width: -10, height: 10 })
        ).toThrow(/bounded finite rectangle/)
      })

      it('rejects a host frame with no overlap with the window', () => {
        expect(() =>
          studioReviewHostCaptureRegion(image, bounds, { x: 5000, y: 5000, width: 10, height: 10 })
        ).toThrow(/outside the immutable window bounds/)
      })

      it('clips a host frame that overhangs one window edge without covering the full window', () => {
        const hostFrame = { x: 100, y: 50, width: 1281, height: 700 }
        const region = studioReviewHostCaptureRegion(image, bounds, hostFrame)
        expect(region).toEqual({ x: 0, y: 0, width: 2560, height: 1400 })
        expect(region.x + region.width).toBeLessThanOrEqual(image.width)
        expect(region.y + region.height).toBeLessThanOrEqual(image.height)
      })

      it('rejects a host frame that clips to exactly the whole window (materiality violation)', () => {
        expect(() =>
          studioReviewHostCaptureRegion(image, bounds, { x: 100, y: 50, width: 1280, height: 800 })
        ).toThrow(/must not equal the whole window/)
      })

      it('rejects a host frame that clips to more than the whole window', () => {
        expect(() =>
          studioReviewHostCaptureRegion(image, bounds, { x: 0, y: 0, width: 2000, height: 2000 })
        ).toThrow(/must not equal the whole window/)
      })
    })

    describe('buildStudioUiDriverRequest for read-workspace', () => {
      it('strips caller-controlled fields down to the bare action type', () => {
        const target = {
          companion: {
            pid: 7002,
            ppid: 7001,
            pgid: 7001,
            command: '/virtual/TaskWraithStudioCompanion --viewer'
          },
          electronPgid: 7001,
          window: {
            pid: 7002,
            visibleWindowCount: 1,
            windows: [
              { windowId: 42, title: 'TaskWraith Studio', bounds: WORKSPACE_WINDOW_BOUNDS }
            ]
          },
          artifactRoot: '/virtual/acceptance/studioWorkspaceRead01'
        }
        expect(
          buildStudioUiDriverRequest({
            ...target,
            actions: [
              { type: 'read-workspace', callerControlledValue: 'must-be-ignored', windowId: 999 }
            ]
          })
        ).toMatchObject({
          inputDelivery: 'background-observation-only',
          allowForegroundInput: false,
          actions: [{ type: 'read-workspace' }]
        })
        const built = buildStudioUiDriverRequest({
          ...target,
          actions: [{ type: 'read-workspace', callerControlledValue: 'must-be-ignored' }]
        })
        expect(Object.keys(built.actions[0])).toEqual(['type'])
      })
    })

    describe('Hold 1: real one-window transcript-region computation', () => {
      // These exercise the REAL region math end to end (real PNGs through
      // the real comparator), not a mocked compareCaptures — the mock is
      // exactly why the deterministic throw against real one-window
      // geometry went unnoticed until an independent review measured it.
      const oneWindowBounds = { x: 0, y: 0, width: 1280, height: 800 }

      async function makeOneWindowCapture(
        root: string,
        name: string,
        mutate?: (image: InstanceType<typeof PNG>) => void
      ): Promise<string> {
        const image = new PNG({ width: 2_560, height: 1_600 })
        image.data.fill(255)
        mutate?.(image)
        const destination = path.join(root, name)
        await fsPromises.writeFile(destination, PNG.sync.write(image))
        return destination
      }

      function paintOneWindowRectangle(
        image: InstanceType<typeof PNG>,
        left: number,
        top: number,
        width: number,
        height: number
      ): void {
        for (let y = top; y < top + height; y += 1) {
          for (let x = left; x < left + width; x += 1) {
            const offset = (y * image.width + x) * 4
            image.data[offset] = 0
            image.data[offset + 1] = 0
            image.data[offset + 2] = 0
            image.data[offset + 3] = 255
          }
        }
      }

      it('rejects the legacy whole-window "timeline" region against real one-window 1280x800 geometry', async () => {
        const root = await temporaryRoot('studio-onewindow-legacy-timeline-')
        const before = await makeOneWindowCapture(root, 'before.png')
        const after = await makeOneWindowCapture(root, 'after.png', (image) =>
          paintOneWindowRectangle(image, 100, 1_400, 40, 40)
        )
        // This is exactly Hold 1, reproduced from real bytes rather than
        // asserted from arithmetic: 1280*9/16=720 video height, 800-720=80
        // pseudo-titlebar, and 80 falls outside the legacy 20...40 bound
        // that only ever made sense for the old dedicated per-route window.
        expect(() =>
          compareStudioJourneyCaptures(before, after, oneWindowBounds, 'timeline')
        ).toThrow(/bounded Companion geometry/)
      })

      it('derives the transcript overlay band from the live Source host frame and detects a real change inside it', async () => {
        const sourceHostFrame = { x: 0, y: 100, width: 640, height: 600 }
        const root = await temporaryRoot('studio-onewindow-source-overlay-')
        const before = await makeOneWindowCapture(root, 'before.png')
        // Overlay band is the bottom 118pt (236px at 2x) of the 600pt-tall
        // host: y in [200, 1200) scaled, so the band is y in [1164, 1400).
        const after = await makeOneWindowCapture(root, 'after.png', (image) =>
          paintOneWindowRectangle(image, 50, 1_200, 20, 20)
        )
        const result = compareStudioJourneyCaptures(
          before,
          after,
          oneWindowBounds,
          'source-host-overlay',
          sourceHostFrame
        )
        expect(result).toMatchObject({ ok: true, region: 'source-host-overlay' })
        expect(
          studioSourceHostOverlayCaptureRegion({ width: 2_560, height: 1_600 }, oneWindowBounds, sourceHostFrame)
        ).toEqual({ x: 0, y: 1_164, width: 1_280, height: 236 })
      })

      it('does not detect a change painted outside the live overlay band (correctly scoped, not whole-host)', async () => {
        const sourceHostFrame = { x: 0, y: 100, width: 640, height: 600 }
        const root = await temporaryRoot('studio-onewindow-source-overlay-scope-')
        const before = await makeOneWindowCapture(root, 'before.png')
        // Painted well above the overlay band (y=1164..1400), inside the
        // rest of the Source host and the rest of the window.
        const after = await makeOneWindowCapture(root, 'after.png', (image) =>
          paintOneWindowRectangle(image, 50, 300, 20, 20)
        )
        expect(() =>
          compareStudioJourneyCaptures(before, after, oneWindowBounds, 'source-host-overlay', sourceHostFrame)
        ).toThrow(/source-host-overlay region did not materially change/)
      })

      it('fails the journey loudly if Source is not selected/visible at journey start', async () => {
        await expect(
          driveStudioUiJourney(
            { artifactRoot: '/virtual/acceptance/studioJourneySourceGate' },
            {
              companion: { pid: 7002, pgid: 7001, command: '/virtual/TaskWraithStudioCompanion' },
              electronPgid: 7001,
              window: {
                pid: 7002,
                visibleWindowCount: 1,
                windows: [
                  { windowId: 42, title: 'TaskWraith Studio', bounds: oneWindowBounds }
                ]
              }
            },
            {
              waitForJournalOperation: async () => ({ revision: 2, op: { type: 'set_transcript' } }),
              runUiDriver: async () => ({
                actions: [
                  // review=true: Timeline selected/visible, Source hidden —
                  // exactly the state that must never be silently accepted
                  // as "Source presented" for the transcript-overlay crop.
                  { index: 0, type: 'read-workspace', workspace: validWorkspaceObservation(true) }
                ]
              })
            }
          )
        ).rejects.toThrow(/requires Source selected and visible at journey start/)
      })

      it('rejects a Source host frame too short to contain the overlay band', () => {
        const shortFrame = { x: 0, y: 0, width: 640, height: 50 }
        expect(() =>
          studioSourceHostOverlayCaptureRegion(
            { width: 2_560, height: 1_600 },
            oneWindowBounds,
            shortFrame
          )
        ).toThrow(/overlay band does not fit/)
      })
    })
  })
})
