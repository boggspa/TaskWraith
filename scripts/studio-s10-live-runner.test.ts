import * as fsPromises from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cooldownFixture,
  exactCloseFixture,
  ownedSample,
  resourceIdentity,
  warmPlanFixture,
  workloadFixture
} from './studio-resource-evidence.test-fixtures'

/* eslint-disable @typescript-eslint/no-require-imports */
const runner = require('./studio-s10-live-runner.cjs') as {
  PRIMARY_MIN_DURATION_SECONDS: number
  LOOP_MIN_DURATION_SECONDS: number
  SAMPLE_COUNT: number
  SEEK_COUNT: number
  ALTERNATING_OPEN_COUNT: number
  ROUTE_CYCLE_COUNT: number
  CLOSE_REOPEN_COUNT: number
  LOOP_SETUP_KEYS: string[]
  EXPECTED_CLOSE_HELPER: string
  parseS10Cli: (argv: string[]) => Record<string, unknown>
  normalizeS10Options: (options: Record<string, unknown>) => Record<string, unknown>
  buildS10Plan: (options: Record<string, unknown>) => Record<string, unknown>
  validateLoopProof: (proof: Record<string, unknown>) => Record<string, unknown>
  defaultEstablishLoop: (...args: unknown[]) => Promise<Record<string, unknown>>
  validateSeekReceipts: (
    receipts: Array<Record<string, unknown>>,
    assetId: string
  ) => Record<string, unknown>
  validateAlternatingOpens: (
    receipts: Array<Record<string, unknown>>,
    assets: Array<Record<string, unknown>>
  ) => Record<string, unknown>
  validateRouteCycles: (receipts: Array<Record<string, unknown>>) => Record<string, unknown>
  defaultPerformRouteCycles: (...args: unknown[]) => Promise<Array<Record<string, unknown>>>
  defaultPerformAlternatingOpens: (...args: unknown[]) => Promise<Array<Record<string, unknown>>>
  defaultPerformCloseReopenCycles: (...args: unknown[]) => Promise<Array<Record<string, unknown>>>
  assertNoVisibleStudioWindow: (
    pid: number,
    probe: (pid: number) => Promise<unknown>
  ) => Promise<Record<string, unknown>>
  readBoundedJson: (filePath: string, label: string) => Promise<Record<string, unknown>>
  measureHeadBoundSources: (
    root: string,
    paths: string[],
    adapters: Record<string, unknown>
  ) => Promise<Record<string, Record<string, unknown>>>
  assertBoundedArtifactFile: (
    filePath: string,
    artifactRoot: string,
    label: string
  ) => Promise<Record<string, unknown>>
  validateCloseReopenCycles: (
    receipts: Array<Record<string, unknown>>,
    assetId: string
  ) => Record<string, unknown>
  validateS10ResourceVerdict: (resources: Array<Record<string, unknown>>) => Record<string, unknown>
  validateWorkloadResourceVerdict: (
    resources: Array<Record<string, unknown>>,
    identity: Record<string, unknown>,
    resourcePlan: unknown
  ) => Record<string, unknown>
  validateFinalCooldown: (
    cooldown: Record<string, unknown>,
    live: Record<string, unknown>
  ) => Record<string, unknown>
  validateCompleteS10Journey: (...args: unknown[]) => boolean
  validateLoopAwareAvVerdict: (
    evidence: Record<string, unknown>,
    samples: Array<Record<string, unknown>>,
    census: Record<string, unknown>
  ) => Record<string, unknown>
  defaultStopLoopAndReadFinal: (
    plan: Record<string, unknown>,
    target: Record<string, unknown>,
    adapters: Record<string, unknown>,
    context: Record<string, unknown>
  ) => Promise<Record<string, unknown>>
  runLoopAwareSampling: (
    plan: Record<string, unknown>,
    target: Record<string, unknown>,
    prepared: Record<string, unknown>,
    adapters: Record<string, unknown>
  ) => Promise<Record<string, unknown>>
  runS10Journey: (
    plan: Record<string, unknown>,
    target: Record<string, unknown>,
    adapters: Record<string, unknown>
  ) => Promise<Record<string, unknown>>
  writeFinalS10Evidence: (
    plan: Record<string, unknown>,
    result: Record<string, unknown>,
    assets: Record<string, unknown>
  ) => Promise<Record<string, unknown>>
  runS10Acceptance: (
    options: Record<string, unknown>,
    adapters: Record<string, unknown>
  ) => Promise<Record<string, unknown>>
}

const roots: string[] = []

async function tempRoot() {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'studio-s10-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (roots.length > 0)
    await fsPromises.rm(roots.pop() as string, { recursive: true, force: true })
})

const assetA = { sha256: 'a'.repeat(43), assetPath: '/tmp/s10/a.mp4' }
const assetB = { sha256: 'b'.repeat(43), assetPath: '/tmp/s10/b.mp4' }

function goodLoopProof() {
  return {
    loop: true,
    hudText: 'LOOP',
    accessibilityIdentifier: 'Transport mutation detail',
    accessibilityRole: 'AXStaticText',
    accessibilityValue: 'tm1 route=source preSrc=0 postSrc=1',
    backgroundPositioning: true,
    foregroundSetup: true,
    focusBefore: { targetActive: false },
    focusAfter: { targetActive: false },
    focusRestored: true,
    loopStartTicks: 0,
    loopEndTicks: 300,
    startPositioning: { observedPlayheadTicks: 0 },
    endPositioning: { observedPlayheadTicks: 300 }
  }
}

const currentAv =
  'avc1 ts=1000 fd=1 pf=100 ap=100 err=0 errms=0.000 win=1 winms=0.000 drawn=1 expl=not_explained'
const peakAv = 'av1 pf=100 ap=100 err=0 errms=0.000 win=1 winms=0.000 drawn=1 expl=not_explained'

function goodLoopSamples() {
  return Array.from({ length: runner.SAMPLE_COUNT }, (_, index) => ({
    index,
    plannedElapsedMs: index * 30_000,
    actualElapsedMs: index * 30_000,
    monotonicMs: index * 30_000,
    observedPtsSeconds: (index % 10) * 30,
    ptsWrap: index > 0 && index % 10 === 0,
    syntheticClock: false,
    raw: { current: currentAv, peak: peakAv }
  }))
}

function goodAvEvidence() {
  return {
    kind: 'taskwraith-studio-s10-loop-av-evidence',
    verdict: { status: 'green', failures: [] },
    samples: Array.from({ length: runner.SAMPLE_COUNT }, (_, index) => ({
      index,
      referencePixel: { pixelComparison: { clean: true } }
    }))
  }
}

function goodResources() {
  return Array.from({ length: runner.SAMPLE_COUNT }, (_, index) => ({
    index,
    rssBytes: 100_000_000 + (index % 2) * 1_000,
    physicalFootprintBytes: 200_000_000 + (index % 2) * 1_000,
    mallocLiveBytes: 50_000_000 + (index % 2) * 1_000,
    ioSurfaceIds: [1, 2],
    ioSurfaceCapacity: 4,
    residentDecoderCount: 1,
    players: 1,
    frames: 1,
    textures: 1,
    cacheHits: 1_000,
    droppedFrames: 0
  }))
}

function completeJourneyFixture(artifactRoot = '/tmp/s10/artifacts') {
  const { samples, plan } = workloadFixture()
  const resources = runner.validateWorkloadResourceVerdict(samples, resourceIdentity, plan)
  const assets = {
    primary: { ...assetA, byteLength: 10_000 },
    secondary: { ...assetB, byteLength: 20_000 }
  }
  const companion = { pid: 12, pgid: 12, ppid: 10, command: resourceIdentity.executablePath }
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const pixelFiles: Array<[string, string]> = []
  const loopSamples = goodLoopSamples().map((sample, index) => {
    const screenshotPath = path.join(artifactRoot, `capture-${index}.png`)
    const screenshotBytes = `captured frame ${index}`
    const referencePath = path.join(artifactRoot, `reference-${index}.png`)
    const referenceBytes = `source frame ${index}`
    pixelFiles.push([screenshotPath, screenshotBytes], [referencePath, referenceBytes])
    const referenceCommand =
      require('./studio-bounded-diagnostics-runner.cjs').buildReferenceExtractCommand({
        assetPath: assets.primary.assetPath,
        exactSourcePtsSeconds: sample.observedPtsSeconds,
        referencePath
      }) as string[]
    return {
      ...sample,
      loopActive: true,
      assetId: assets.primary.sha256,
      captureMonotonicMs: 1000 + sample.monotonicMs,
      observed: {
        state: 'PLAY',
        contentPtsSeconds: sample.observedPtsSeconds,
        assetMatch: { matched: true, distance: 0, assetId: assets.primary.sha256 }
      },
      resource: samples[index],
      referencePixel: {
        exactSourcePtsSeconds: sample.observedPtsSeconds,
        referencePath,
        referenceSha256: sha(referenceBytes),
        referenceByteLength: Buffer.byteLength(referenceBytes),
        referenceCommand,
        referenceExecution: {
          command: ['/usr/local/bin/ffmpeg', ...referenceCommand],
          stdoutSha256: sha(''),
          stderrSha256: sha('')
        },
        pixelComparison: { clean: true }
      },
      raw: {
        ...sample.raw,
        capture: {
          screenshotPath,
          screenshotSha256: sha(screenshotBytes),
          screenshotByteLength: Buffer.byteLength(screenshotBytes),
          rawOcrText: '[]',
          rawOcrSha256: sha('[]'),
          windowBounds: { x: 0, y: 0, width: 640, height: 480 },
          sourceHostFrame: { x: 0, y: 0, width: 640, height: 360 }
        }
      }
    }
  })
  const journey = {
    green: true,
    phasesComplete: true,
    blockers: [],
    loop: {
      proof: {
        ...goodLoopProof(),
        loopEndTicks: 300_000,
        loopTimebaseTicks: 1000,
        endPositioning: { observedPlayheadTicks: 300_000 }
      },
      avEndurance: { ...goodAvEvidence(), samples: structuredClone(loopSamples) },
      samples: loopSamples,
      sourcePtsCensus: { values: Array.from({ length: 301 }, (_, index) => index) },
      bounds: { startTicks: 0, endTicks: 300_000, timebaseTicks: 1000 }
    },
    seeks: {
      receipts: Array.from({ length: 100 }, (_, index) => {
        const ticks = Math.floor((300_000 * (index + 1)) / 101)
        return {
          index,
          assetId: assetA.sha256,
          action: 'set-playhead-ticks',
          backgroundInput: true,
          requestedPlayheadTicks: ticks,
          playheadTicks: ticks,
          rawAction: { type: 'set-playhead-ticks', observedPlayheadTicks: ticks },
          resourceSample: samples[21 + index]
        }
      })
    },
    alternatingOpens: {
      receipts: Array.from({ length: 20 }, (_, index) => ({
        index,
        assetId: index % 2 ? assetB.sha256 : assetA.sha256,
        foregroundInput: false,
        inputDelivery: 'background-observation-only',
        journalRevision: index + 1,
        journalPath: index % 2 ? assetB.assetPath : assetA.assetPath,
        hudAssetId: index % 2 ? assetB.sha256 : assetA.sha256,
        resourceSample: samples[121 + index]
      }))
    },
    routeCycles: {
      receipts: Array.from({ length: 10 }, (_, index) => ({
        index,
        action: 'AXPress',
        inputDelivery: 'background-observation-only',
        foregroundInput: false,
        transitions: ['timeline-show', 'source-hide', 'source-show', 'timeline-hide'].map(
          (name, step) => ({
            name,
            accessibilityAction: 'AXPress',
            routeValueBefore: step % 2 ? 'selected' : 'not selected',
            routeValueAfter: step % 2 ? 'not selected' : 'selected',
            pairedRouteValueBefore: 'selected',
            pairedRouteValueAfter: 'selected'
          })
        ),
        sourceVisible: true,
        timelineVisible: false,
        hudAssetId: assetB.sha256,
        resource: {},
        resourceSamples: samples.slice(141 + index * 4, 145 + index * 4),
        visibilitySnapshots: [
          { source: true, timeline: true },
          { source: false, timeline: true },
          { source: true, timeline: true },
          { source: true, timeline: false }
        ]
      }))
    },
    closeReopenCycles: {
      receipts: Array.from({ length: 10 }, (_, index) => ({
        index,
        helperPath: runner.EXPECTED_CLOSE_HELPER,
        closed: true,
        windowAbsence: { closed: true, exactPid: 12 },
        cooldownSample: samples[181 + index * 2],
        reopenSample: samples[182 + index * 2],
        windowIdBefore: 7 + index,
        windowIdAfter: 8 + index,
        journalRevisionBefore: 20 + index,
        journalRevisionAfter: 21 + index,
        assetId: assetB.sha256,
        paused: true,
        readiness: 'exact-asset-paused',
        rawCloseReceipt: exactCloseFixture(7 + index)
      }))
    },
    resources,
    finalCloseCooldown: cooldownFixture(resources)
  }
  return { journey, assets, companion, pixelFiles }
}

async function finalEvidenceFixture(launchMode = 'direct') {
  const root = await tempRoot()
  const instanceId = 's10Fixture01'
  const runnerRelativePath = 'scripts/studio-s10-live-runner.cjs'
  const source = 'committed S10 runner\n'
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
  const git = { head: 'a'.repeat(40), tracked: true, status: '', source }
  const zeroCopyBefore: Record<string, { sha256: string; headBlob: string }> = {}
  for (const relativePath of [
    runnerRelativePath,
    'scripts/studio-resource-evidence.cjs',
    'swift/TaskWraithBridge/Sources/TaskWraithStudioCore/StudioVideoTextureBridge.swift',
    'swift/TaskWraithBridge/Sources/TaskWraithStudioCore/StudioVideoFrameSource.swift',
    'src/renderer/src/App.tsx'
  ]) {
    await fsPromises.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true })
    await fsPromises.writeFile(path.join(root, relativePath), source)
    zeroCopyBefore[relativePath] = { sha256: sha256(source), headBlob: 'b'.repeat(40) }
  }
  const runExact = vi.spyOn(require('./studio-acceptance-session.cjs'), 'runExact')
  runExact.mockImplementation(async (_command, args) => {
    if (args[0] === 'ls-files') return { stdout: git.tracked ? `${runnerRelativePath}\n` : '' }
    if (args[0] === 'status') return { stdout: git.status }
    if (args[0] === 'rev-parse')
      return { stdout: `${args[1] === 'HEAD' ? git.head : 'b'.repeat(40)}\n` }
    if (args[0] === 'show') return { stdout: git.source }
    if (args[0] === 'diff') return { stdout: '' }
    throw new Error(`unexpected fixture Git command: ${args.join(' ')}`)
  })
  const artifactRoot = path.join(root, 'artifacts')
  const stateDirectory = path.join(artifactRoot, 'state')
  await fsPromises.mkdir(stateDirectory, { recursive: true })
  await fsPromises.writeFile(path.join(stateDirectory, 'studio-project.journal.jsonl'), '{}\n')
  const primary = { sourcePath: path.join(root, 'primary.mp4') }
  const secondary = { sourcePath: path.join(root, 'secondary.mp4') }
  await fsPromises.writeFile(primary.sourcePath, 'primary bytes')
  await fsPromises.writeFile(secondary.sourcePath, 'secondary bytes')
  const launchServicesProof =
    launchMode === 'launch-services'
      ? {
          launchServicesExecutable: '/exact/Studio.app/Contents/MacOS/Studio',
          launchServicesAdoption: {
            requestId: 's10-adoption',
            pid: 20,
            pgid: 20,
            executable: '/exact/Studio.app/Contents/MacOS/Studio',
            startedAt: 'Thu Sep 24 02:00:00 2026',
            acknowledged: true,
            groupExitVerified: true
          }
        }
      : {}
  const watchdog = {
    schemaVersion: 2,
    kind: 'taskwraith-studio-acceptance-watchdog',
    instanceId,
    status: 'reaped',
    reason: 'owner_requested',
    groupExitVerified: true,
    detachedGroupExitVerified: true,
    childPid: 10,
    childPgid: 10,
    ...launchServicesProof,
    detachedProcessGroups:
      launchMode === 'launch-services'
        ? [{ pgid: 20, evidencePids: [20], memberPids: [20, 21] }]
        : []
  }
  const journey = {
    phasesComplete: true,
    loop: { avEndurance: goodAvEvidence(), samples: goodLoopSamples() },
    resources: goodResources(),
    finalCloseCooldown: {},
    blockers: []
  }
  const baseEvidence = {
    schemaVersion: 1,
    kind: 'taskwraith-studio-in-product-acceptance',
    instanceId,
    ok: true,
    journey: structuredClone(journey),
    electron: {
      pid: launchMode === 'launch-services' ? 20 : 10,
      pgid: launchMode === 'launch-services' ? 20 : 10,
      launchMode,
      launcherPid: launchMode === 'launch-services' ? 10 : null,
      launcherPgid: launchMode === 'launch-services' ? 10 : null
    },
    watchdogTerminal: {
      type: 'terminal',
      status: watchdog.status,
      reason: watchdog.reason,
      childPid: watchdog.childPid,
      childPgid: watchdog.childPgid,
      groupExitVerified: watchdog.groupExitVerified,
      detachedGroupExitVerified: watchdog.detachedGroupExitVerified,
      ...structuredClone(launchServicesProof),
      detachedProcessGroups: structuredClone(watchdog.detachedProcessGroups)
    }
  }
  const plan = {
    instanceId,
    repoRoot: root,
    artifactRoot,
    evidencePath: path.join(artifactRoot, 'harness.json'),
    receiptPath: path.join(artifactRoot, 'watchdog.json'),
    studioStateDirectory: stateDirectory
  }
  const writeReceipts = async () => {
    await fsPromises.writeFile(plan.evidencePath, JSON.stringify(baseEvidence))
    await fsPromises.writeFile(plan.receiptPath, JSON.stringify(watchdog))
  }
  await writeReceipts()
  const assets = {
    primary,
    secondary,
    primarySourceSha256: sha256('primary bytes'),
    secondarySourceSha256: sha256('secondary bytes'),
    gitHeadBefore: git.head,
    runnerBeforeSha256: sha256(source),
    runnerCustodyBefore: {
      gitHead: git.head,
      sha256: sha256(source),
      headBlob: 'b'.repeat(40),
      dependencies: {
        'scripts/studio-resource-evidence.cjs': { sha256: sha256(source), headBlob: 'b'.repeat(40) }
      }
    },
    zeroCopyBefore
  }
  const result = {
    evidence: {
      ok: true,
      instanceId,
      journey
    }
  }
  return {
    root,
    runnerRelativePath,
    source,
    git,
    plan,
    result,
    assets,
    watchdog,
    baseEvidence,
    writeReceipts
  }
}

async function greenFinalEvidenceFixture() {
  const fixture = await finalEvidenceFixture()
  const complete = completeJourneyFixture(fixture.plan.artifactRoot)
  Object.assign(fixture.result.evidence, { journey: complete.journey })
  Object.assign(fixture.baseEvidence, { journey: complete.journey, companion: complete.companion })
  Object.assign(fixture.assets.primary, complete.assets.primary)
  Object.assign(fixture.assets.secondary, complete.assets.secondary)
  for (const [filePath, bytes] of complete.pixelFiles) await fsPromises.writeFile(filePath, bytes)
  await fixture.writeReceipts()
  return { fixture, ...complete }
}

describe('S10 green final-seal semantic joins', () => {
  type Journey = ReturnType<typeof completeJourneyFixture>['journey']
  type LoopSample = Journey['loop']['samples'][number]
  const bothLoops = (mutate: (sample: LoopSample) => void) => (journey: Journey) => {
    mutate(journey.loop.samples[0])
    mutate(journey.loop.avEndurance.samples[0])
  }
  const cases: Array<{ name: string; mutate: (journey: Journey) => void; error: RegExp }> = [
    {
      name: 'missing screenshot hash',
      mutate: bothLoops((sample) => {
        Reflect.deleteProperty(sample.raw.capture, 'screenshotSha256')
      }),
      error: /capture\/reference custody/
    },
    {
      name: 'missing reference hash',
      mutate: bothLoops((sample) => {
        Reflect.deleteProperty(sample.referencePixel, 'referenceSha256')
      }),
      error: /capture\/reference custody/
    },
    {
      name: 'missing exact source PTS',
      mutate: bothLoops((sample) => {
        Reflect.deleteProperty(sample.referencePixel, 'exactSourcePtsSeconds')
      }),
      error: /exact primary source PTS/
    },
    {
      name: 'changed screenshot bytes',
      mutate: bothLoops((sample) => {
        sample.raw.capture.screenshotSha256 = '0'.repeat(64)
      }),
      error: /capture bytes differ/
    },
    {
      name: 'changed reference bytes',
      mutate: bothLoops((sample) => {
        sample.referencePixel.referenceSha256 = '0'.repeat(64)
      }),
      error: /reference bytes differ/
    },
    {
      name: 'wrong primary loop asset',
      mutate: bothLoops((sample) => {
        sample.assetId = assetB.sha256
      }),
      error: /primary-asset identity/
    },
    {
      name: 'wrong exact source PTS',
      mutate: bothLoops((sample) => {
        sample.referencePixel.exactSourcePtsSeconds += 1
      }),
      error: /exact primary source PTS/
    },
    {
      name: 'wrong reference source command',
      mutate: bothLoops((sample) => {
        sample.referencePixel.referenceCommand[4] = assetB.assetPath
      }),
      error: /exact primary source PTS/
    },
    {
      name: 'divergent pixel arrays',
      mutate: (journey) => {
        journey.loop.avEndurance.samples[0].referencePixel.referenceSha256 = '0'.repeat(64)
      },
      error: /canonical A\/V\/reference/
    },
    {
      name: 'divergent raw A/V arrays',
      mutate: (journey) => {
        journey.loop.avEndurance.samples[0].raw.peak = 'different'
      },
      error: /canonical A\/V\/reference/
    },
    {
      name: 'divergent capture clock arrays',
      mutate: (journey) => {
        journey.loop.avEndurance.samples[0].captureMonotonicMs += 1
      },
      error: /canonical A\/V\/reference/
    },
    {
      name: 'divergent native arrays',
      mutate: (journey) => {
        journey.loop.avEndurance.samples[0].resource.native.nonce = '0'.repeat(48)
      },
      error: /canonical A\/V\/reference/
    },
    {
      name: 'different setup marks',
      mutate: (journey) => {
        journey.loop.proof.loopEndTicks += 1000
        journey.loop.proof.endPositioning.observedPlayheadTicks += 1000
      },
      error: /setup marks\/timebase/
    },
    {
      name: 'different setup timebase',
      mutate: (journey) => {
        journey.loop.proof.loopTimebaseTicks += 1
      },
      error: /setup marks\/timebase/
    },
    {
      name: 'different native A/V timebase',
      mutate: bothLoops((sample) => {
        sample.raw.current = sample.raw.current.replace('ts=1000', 'ts=2000')
      }),
      error: /clock\/timebase/
    },
    {
      name: 'foreign route HUD asset',
      mutate: (journey) => {
        journey.routeCycles.receipts[0].hudAssetId = 'c'.repeat(43)
      },
      error: /expected secondary asset/
    },
    {
      name: 'route sample from another cycle',
      mutate: (journey) => {
        journey.routeCycles.receipts[0].resourceSamples[0] =
          journey.routeCycles.receipts[1].resourceSamples[0]
      },
      error: /canonical native observation/
    },
    {
      name: 'arbitrary unequal route values',
      mutate: (journey) => {
        journey.routeCycles.receipts[0].transitions[0].routeValueBefore = 'before'
        journey.routeCycles.receipts[0].transitions[0].routeValueAfter = 'after'
      },
      error: /exact selected-state transition/
    },
    ...[0, 1, 2, 3].map((step) => ({
      name: `native source attachment contradicting route step ${step}`,
      mutate: (journey: Journey) => {
        const sample = journey.routeCycles.receipts[0].resourceSamples[step]
        expect(journey.resources.samples[141 + step]).toBe(sample)
        sample.native.workspace.sourcePresentationAttached = step === 1
      },
      error: /native presentation contradicts source visibility/
    })),
    {
      name: 'native review attachment retained after the Timeline route hides',
      mutate: (journey) => {
        const sample = journey.routeCycles.receipts[0].resourceSamples[3]
        expect(journey.resources.samples[144]).toBe(sample)
        sample.native.workspace.reviewPresentationAttached = true
      },
      error: /native Review stays attached while Timeline is hidden/
    },
    {
      name: 'warm-route review attachment retained after the Timeline route hides',
      mutate: (journey) => {
        const { plan } = journey.resources.owned as {
          plan: { samples: Array<ReturnType<typeof ownedSample>> }
        }
        expect(plan.samples[4]).toMatchObject({ phase: 'warm-route', index: 3 })
        plan.samples[4].native.workspace.reviewPresentationAttached = true
      },
      error: /fixed route schedule/
    },
    {
      name: 'seek sample from another index',
      mutate: (journey) => {
        journey.seeks.receipts[0].resourceSample = journey.seeks.receipts[1].resourceSample
      },
      error: /canonical native observation/
    },
    {
      name: 'seek action contradicting request',
      mutate: (journey) => {
        journey.seeks.receipts[0].rawAction.observedPlayheadTicks += 1
      },
      error: /requested\/observed action/
    },
    {
      name: 'open revisions disconnected from native',
      mutate: (journey) => {
        journey.alternatingOpens.receipts.forEach((receipt) => {
          receipt.journalRevision += 100
        })
      },
      error: /native\/journal revision/
    },
    {
      name: 'minimal closed flag',
      mutate: (journey) => {
        Reflect.set(journey.closeReopenCycles.receipts[0], 'cooldownSample', { closed: true })
      },
      error: /canonical native observation/
    },
    {
      name: 'closed sample from another cycle',
      mutate: (journey) => {
        journey.closeReopenCycles.receipts[0].cooldownSample =
          journey.closeReopenCycles.receipts[1].cooldownSample
      },
      error: /canonical native observation/
    },
    ...(['sourcePresentationAttached', 'reviewPresentationAttached'] as const).map((field) => ({
      name: `closed native sample retaining ${field}`,
      mutate: (journey: Journey) => {
        const sample = journey.closeReopenCycles.receipts[0].cooldownSample
        expect(journey.resources.samples[181]).toBe(sample)
        sample.native.workspace[field] = true
      },
      error: /closed native snapshot still has a visible\/attached presentation/
    })),
    {
      name: 'missing raw close receipt',
      mutate: (journey) => {
        Reflect.deleteProperty(journey.closeReopenCycles.receipts[0], 'rawCloseReceipt')
      },
      error: /close receipt is not exact/
    },
    {
      name: 'foreign close process',
      mutate: (journey) => {
        journey.closeReopenCycles.receipts[0].rawCloseReceipt.pid = 99
      },
      error: /close receipt is not exact/
    },
    {
      name: 'foreign close window',
      mutate: (journey) => {
        journey.closeReopenCycles.receipts[0].rawCloseReceipt.windowId = 99
      },
      error: /close receipt is not exact/
    },
    {
      name: 'reopen sample from another cycle',
      mutate: (journey) => {
        journey.closeReopenCycles.receipts[0].reopenSample =
          journey.closeReopenCycles.receipts[1].reopenSample
      },
      error: /canonical native observation/
    },
    {
      name: 'contradictory reopened window',
      mutate: (journey) => {
        journey.closeReopenCycles.receipts[0].windowIdAfter = 99
      },
      error: /window\/process\/revision history/
    },
    {
      name: 'contradictory closed revision',
      mutate: (journey) => {
        journey.closeReopenCycles.receipts[0].journalRevisionBefore = 0
      },
      error: /window\/process\/revision history/
    },
    {
      name: 'missing final close receipt',
      mutate: (journey) => {
        Reflect.deleteProperty(journey.finalCloseCooldown, 'rawCloseReceipt')
      },
      error: /close receipt is not exact/
    }
  ]

  it('seals the complete green journey with canonical native receipts and rehashed captures', async () => {
    const { fixture } = await greenFinalEvidenceFixture()
    const result = await runner.writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
    expect(result).toMatchObject({ evidence: { green: true } })
  })

  it('accepts an optional review controller attached only while its route is visible', async () => {
    const { fixture, journey } = await greenFinalEvidenceFixture()
    for (const receipt of journey.routeCycles.receipts) {
      receipt.resourceSamples.forEach((sample, step) => {
        sample.native.workspace.reviewPresentationAttached = step < 3
      })
    }
    await fixture.writeReceipts()
    const result = await runner.writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
    expect(result).toMatchObject({ evidence: { green: true } })
  })

  it.each(cases)(
    'refuses $name even when disk and promoted green evidence agree',
    async ({ mutate, error }) => {
      const { fixture, journey } = await greenFinalEvidenceFixture()
      mutate(journey)
      // Both copies deliberately contain the same bad journey. The semantic seal,
      // not the earlier disk/promoted equality check, must refuse it.
      await fixture.writeReceipts()
      await expect(
        runner.writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
      ).rejects.toThrow(error)
      await expect(
        fsPromises.access(path.join(fixture.plan.artifactRoot, 's10-final-evidence.json'))
      ).rejects.toThrow()
    }
  )
})

describe('S10 final custody joins', () => {
  it('refuses a modified resource helper even when the runner itself is unchanged', async () => {
    const fixture = await finalEvidenceFixture()
    await fsPromises.writeFile(
      path.join(fixture.root, 'scripts/studio-resource-evidence.cjs'),
      'changed helper\n'
    )
    await expect(
      runner.writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
    ).rejects.toThrow(/resource helper.*HEAD/)
  })

  it('refuses a bare green flag without the complete native journey evidence', async () => {
    const fixture = await finalEvidenceFixture()
    Object.assign(fixture.result.evidence.journey, { green: true })
    Object.assign(fixture.baseEvidence.journey, { green: true })
    await fixture.writeReceipts()
    await expect(
      runner.writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
    ).rejects.toThrow()
  })

  it.each(['both', 'disk', 'terminal'])(
    'rejects stripped LaunchServices adoption proof from %s receipts',
    async (side) => {
      const fixture = await finalEvidenceFixture('launch-services')
      for (const receipt of [
        ...(side !== 'terminal' ? [fixture.watchdog] : []),
        ...(side !== 'disk' ? [fixture.baseEvidence.watchdogTerminal] : [])
      ]) {
        delete receipt.launchServicesExecutable
        delete receipt.launchServicesAdoption
      }
      await fixture.writeReceipts()
      await expect(
        runner.writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
      ).rejects.toThrow(/adoption/)
    }
  )

  it.each(['requestId', 'startedAt', 'executable'] as const)(
    'rejects a different terminal adoption %s even when each receipt is valid alone',
    async (field) => {
      const fixture = await finalEvidenceFixture('launch-services')
      const terminal = fixture.baseEvidence.watchdogTerminal
      const adoption = terminal.launchServicesAdoption!
      if (field === 'requestId') adoption.requestId = 'another-request'
      else if (field === 'startedAt') adoption.startedAt = 'Thu Sep 24 02:00:01 2026'
      else adoption.executable = terminal.launchServicesExecutable = '/other/Studio'
      await fixture.writeReceipts()
      await expect(
        runner.writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
      ).rejects.toThrow(/adoption/)
    }
  )

  it.each(['pid', 'pgid'] as const)(
    'rejects adoption of a different Electron %s despite a matching detached group',
    async (field) => {
      const fixture = await finalEvidenceFixture('launch-services')
      if (field === 'pid') fixture.baseEvidence.electron.pid = 21
      else {
        for (const receipt of [fixture.watchdog, fixture.baseEvidence.watchdogTerminal]) {
          receipt.launchServicesAdoption!.pgid = 30
          receipt.detachedProcessGroups.push({ pgid: 30, evidencePids: [20], memberPids: [20] })
        }
      }
      await fixture.writeReceipts()
      await expect(
        runner.writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
      ).rejects.toThrow(/adoption/)
    }
  )

  it.each(['direct', 'launch-services'])(
    'seals evidence for the exact %s launch owner',
    async (mode) => {
      const fixture = await finalEvidenceFixture(mode)
      await expect(
        runner.writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
      ).resolves.toMatchObject({
        evidence: {
          instanceId: fixture.plan.instanceId,
          gitHead: fixture.git.head,
          gitHeadBefore: fixture.git.head,
          green: false,
          runner: {
            beforeSha256: fixture.assets.runnerBeforeSha256,
            afterSha256: fixture.assets.runnerBeforeSha256
          }
        }
      })
    }
  )

  it.each(['missing', 'incomplete phases', 'different pixel proof', 'different resource receipt'])(
    'rejects a disk journey with %s despite complete promoted phases',
    async (damage) => {
      const fixture = await finalEvidenceFixture()
      if (damage === 'missing') Reflect.deleteProperty(fixture.baseEvidence, 'journey')
      else if (damage === 'incomplete phases') fixture.baseEvidence.journey.phasesComplete = false
      else if (damage === 'different pixel proof')
        fixture.baseEvidence.journey.loop.avEndurance.samples[0].referencePixel.pixelComparison.clean = false
      else fixture.baseEvidence.journey.resources[0].rssBytes += 1
      await fixture.writeReceipts()
      await expect(
        runner
          .writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
          .then(() => undefined)
      ).rejects.toThrow(/disk.*journey/)
    }
  )

  it.each(['missing', 'different'])(
    'rejects a %s promoted journey despite complete disk phases',
    async (damage) => {
      const fixture = await finalEvidenceFixture()
      if (damage === 'missing') Reflect.deleteProperty(fixture.result.evidence, 'journey')
      else fixture.result.evidence.journey.resources[0].rssBytes += 1
      await expect(
        runner
          .writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
          .then(() => undefined)
      ).rejects.toThrow(/disk.*journey/)
    }
  )

  it.each([
    ['disk', 'missing'],
    ['disk', 'mismatched'],
    ['promoted', 'missing'],
    ['promoted', 'mismatched'],
    ['watchdog', 'missing'],
    ['watchdog', 'mismatched'],
    ['plan', 'missing'],
    ['plan', 'mismatched']
  ] as const)('rejects a %s receipt with %s instance identity', async (location, damage) => {
    const fixture = await finalEvidenceFixture()
    const target = {
      disk: fixture.baseEvidence,
      promoted: fixture.result.evidence,
      watchdog: fixture.watchdog,
      plan: fixture.plan
    }[location]
    if (damage === 'missing') Reflect.deleteProperty(target, 'instanceId')
    else target.instanceId = 'anotherInstance'
    await fixture.writeReceipts()
    await expect(
      runner
        .writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
        .then(() => undefined)
    ).rejects.toThrow(/instance/)
  })

  it.each(['pid', 'pgid'] as const)(
    'rejects a direct watchdog child %s mismatch',
    async (field) => {
      const fixture = await finalEvidenceFixture()
      fixture.baseEvidence.electron[field] = 999
      await fixture.writeReceipts()
      await expect(
        runner.writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
      ).rejects.toThrow(/child identity mismatch/)
    }
  )

  it.each(['launcherPid', 'launcherPgid'] as const)(
    'rejects a LaunchServices %s mismatch',
    async (field) => {
      const fixture = await finalEvidenceFixture('launch-services')
      fixture.baseEvidence.electron[field] = 999
      await fixture.writeReceipts()
      await expect(
        runner.writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
      ).rejects.toThrow(/child identity mismatch/)
    }
  )

  it.each(['missing', 'wrong pgid', 'wrong pid', 'duplicate', 'unreaped'])(
    'rejects %s detached Electron custody',
    async (damage) => {
      const fixture = await finalEvidenceFixture('launch-services')
      const groups = fixture.watchdog.detachedProcessGroups
      if (damage === 'missing') groups.length = 0
      else if (damage === 'wrong pgid') groups[0].pgid = 999
      else if (damage === 'wrong pid') groups[0].memberPids = [999]
      else if (damage === 'duplicate') groups.push(structuredClone(groups[0]))
      else fixture.watchdog.detachedGroupExitVerified = false
      fixture.baseEvidence.watchdogTerminal.detachedProcessGroups = structuredClone(groups)
      fixture.baseEvidence.watchdogTerminal.detachedGroupExitVerified =
        fixture.watchdog.detachedGroupExitVerified
      await fixture.writeReceipts()
      await expect(
        runner.writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
      ).rejects.toThrow(/detached Electron|clean owner-requested teardown/)
    }
  )

  it.each(['dirty', 'untracked', 'pre-modified'])(
    'rejects a %s runner before calling the launch harness',
    async (damage) => {
      const fixture = await finalEvidenceFixture()
      if (damage === 'dirty') fixture.git.status = ` M ${fixture.runnerRelativePath}\n`
      else if (damage === 'untracked') fixture.git.tracked = false
      else
        await fsPromises.writeFile(
          path.join(fixture.root, fixture.runnerRelativePath),
          'modified\n'
        )
      const launch = vi.fn(async () => {
        throw new Error('launch harness must not be reached')
      })
      await expect(
        runner.runS10Acceptance(
          {
            launch: true,
            acceptLaunch: true,
            ownerConfirmsOrphansCleared: true,
            acceptBoundedForegroundLoopSetup: true,
            repoRoot: fixture.root,
            artifactRoot: path.join(fixture.root, 'live-artifacts'),
            instanceId: 's10Custody01',
            packagedExecutablePath: path.join(fixture.root, 'Studio.app/Contents/MacOS/Studio'),
            primaryMediaPath: fixture.assets.primary.sourcePath,
            secondaryMediaPath: fixture.assets.secondary.sourcePath,
            primaryMimeType: 'video/mp4',
            secondaryMimeType: 'video/mp4',
            loopStartTicks: 0,
            loopEndTicks: 300,
            loopTimebaseTicks: 1
          },
          {
            probeMediaDuration: async () => ({ seconds: 630 }),
            materializeOwnedMedia: async () => fixture.assets.secondary,
            runStudioAcceptance: launch
          }
        )
      ).rejects.toThrow(/S10 runner.*(?:tracked|dirty|HEAD)/)
      expect(launch).not.toHaveBeenCalled()
    }
  )

  it.each(['dirty', 'untracked', 'pre-modified'])(
    'refuses final evidence for a %s runner even when its before/after hashes agree',
    async (damage) => {
      const fixture = await finalEvidenceFixture()
      if (damage === 'dirty') fixture.git.status = `M  ${fixture.runnerRelativePath}\n`
      else if (damage === 'untracked') fixture.git.tracked = false
      else {
        const modified = 'pre-modified runner\n'
        await fsPromises.writeFile(path.join(fixture.root, fixture.runnerRelativePath), modified)
        fixture.assets.runnerBeforeSha256 = createHash('sha256').update(modified).digest('hex')
        fixture.assets.runnerCustodyBefore.sha256 = fixture.assets.runnerBeforeSha256
      }
      await expect(
        runner.writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
      ).rejects.toThrow(/S10 runner.*(?:tracked|dirty|HEAD)/)
    }
  )

  it('refuses a changed HEAD even when the committed runner bytes are identical', async () => {
    const fixture = await finalEvidenceFixture()
    fixture.git.head = 'c'.repeat(40)
    await expect(
      runner.writeFinalS10Evidence(fixture.plan, fixture.result, fixture.assets)
    ).rejects.toThrow(/git HEAD changed/)
  })

  it('requires a prelaunch source custody receipt rather than defaulting its hash after the run', async () => {
    const fixture = await finalEvidenceFixture()
    await expect(
      runner.writeFinalS10Evidence(fixture.plan, fixture.result, {
        ...fixture.assets,
        runnerCustodyBefore: undefined,
        runnerBeforeSha256: undefined
      })
    ).rejects.toThrow(/runner.*(?:before launch|custody)/)
  })
})

describe('S10 plan and launch gates', () => {
  it('accepts generated IDs and joins each default artifact directory to its instance', () => {
    const repoRoot = path.resolve(os.tmpdir(), 's10-default-plan')
    const first = runner.normalizeS10Options({ repoRoot })
    const second = runner.normalizeS10Options({ repoRoot })
    for (const args of [first, second]) {
      expect(args.launch).toBe(false)
      expect(args.instanceId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{1,15}$/)
      expect(args.artifactRoot).toBe(
        path.join(
          repoRoot,
          '.local-only',
          'taskwraith-studio',
          'acceptance',
          String(args.instanceId)
        )
      )
    }
    expect(first.instanceId).not.toBe(second.instanceId)
    const explicit = runner.normalizeS10Options({ repoRoot, instanceId: 's10Owner01' })
    expect(explicit.instanceId).toBe('s10Owner01')
    expect(path.basename(String(explicit.artifactRoot))).toBe('s10Owner01')
  })

  it('prints a non-launching plan when the CLI receives no options', () => {
    const result = JSON.parse(
      execFileSync(process.execPath, [require.resolve('./studio-s10-live-runner.cjs')], {
        encoding: 'utf8',
        timeout: 10_000
      })
    )
    expect(result).toMatchObject({ launched: false, plan: { launch: false } })
    expect(result.plan.instanceId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{1,15}$/)
    expect(path.basename(result.plan.artifactRoot)).toBe(result.plan.instanceId)
  })

  it('returns a plan through repeated normalization with omitted loop ticks', async () => {
    const result = await runner.runS10Acceptance({}, {})
    expect(result).toMatchObject({ launched: false, plan: { launch: false } })
    const plan = result.plan as Record<string, unknown>
    expect(path.basename(String(plan.artifactRoot))).toBe(plan.instanceId)
  })

  it.each([null, undefined])('still requires launch loop ticks when omitted as %s', (missing) => {
    expect(() =>
      runner.normalizeS10Options({
        launch: true,
        acceptLaunch: true,
        ownerConfirmsOrphansCleared: true,
        acceptBoundedForegroundLoopSetup: true,
        packagedExecutablePath: '/tmp/TaskWraith.app/Contents/MacOS/TaskWraith',
        primaryMediaPath: '/tmp/a.mp4',
        secondaryMediaPath: '/tmp/b.mp4',
        loopStartTicks: missing,
        loopEndTicks: missing,
        loopTimebaseTicks: missing
      })
    ).toThrow(/S10 launch requires exact --loop-start-ticks/)
  })

  it('is plan-only by default and exposes every exact workload count', () => {
    const plan = runner.buildS10Plan({
      repoRoot: '/Users/chrisizatt/Documents/AGBench-studio-continuation',
      artifactRoot: '/tmp/s10-plan',
      instanceId: 's10Plan01'
    })
    expect(plan).toMatchObject({
      kind: 'taskwraith-studio-s10-acceptance-plan',
      launch: false,
      safety: { planOnlyByDefault: true, noGreenWhenPhaseMissing: true },
      workload: {
        primaryMinimumDurationSeconds: 630,
        loopMinimumSeconds: 600,
        alignedSamples: 21,
        exactPlayheadSeeks: 100,
        alternatingAssetOpens: 20,
        sourceTimelineHideShowCycles: 10,
        exactWindowCloseReopenCycles: 10
      }
    })
  })

  it('requires the separate bounded foreground-loop interlock', () => {
    expect(() =>
      runner.normalizeS10Options({
        launch: true,
        acceptLaunch: true,
        ownerConfirmsOrphansCleared: true,
        packagedExecutablePath: '/tmp/TaskWraith.app/Contents/MacOS/TaskWraith',
        primaryMediaPath: '/tmp/a.mp4',
        primaryMimeType: 'video/mp4',
        secondaryMediaPath: '/tmp/b.mp4',
        secondaryMimeType: 'video/mp4',
        artifactRoot: '/tmp/s10-gate',
        instanceId: 's10Gate01'
      })
    ).toThrow(/bounded-foreground-loop-setup/)
  })

  it('parses both media inputs and the explicit loop setup flag', () => {
    const parsed = runner.parseS10Cli([
      '--launch',
      '--i-accept-studio-isolated-launch',
      '--owner-confirms-existing-orphans-cleared',
      '--i-accept-bounded-foreground-loop-setup',
      '--primary-media=/tmp/a.mp4',
      '--primary-mime=video/mp4',
      '--secondary-media=/tmp/b.mp4',
      '--secondary-mime=video/mp4'
    ])
    expect(parsed).toMatchObject({ launch: true, acceptBoundedForegroundLoopSetup: true })
  })
})

describe('S10 loop authenticity and exact phase controls', () => {
  it('refuses the former fast-clock sampler costume', async () => {
    const target = { asset: assetA, window: {} }
    const samples = await runner.runLoopAwareSampling(
      { artifactRoot: '/tmp/s10', transcriptTimeoutMs: 1_000 },
      target,
      { sourcePtsCensus: { values: [0, 630] } },
      {
        testOnlyFastTimeline: true,
        windowBounds: () => ({ x: 0, y: 0, width: 640, height: 400 }),
        captureLoopSample: async (_plan: unknown, _target: unknown, entry: { index: number }) => {
          const observedPtsSeconds =
            entry.index === 9
              ? 629
              : entry.index < 10
                ? entry.index * 60
                : entry.index === 10
                  ? 1
                  : (entry.index - 10) * 60
          return {
            loopActive: true,
            assetId: assetA.sha256,
            observedPtsSeconds,
            ptsWrap: entry.index === 10
          }
        }
      }
    )
    expect(samples.samples).toHaveLength(21)
    expect(() =>
      runner.validateLoopAwareAvVerdict(
        samples.evidence,
        samples.samples,
        { values: [0, 1, 630] },
        { startTicks: 0, endTicks: 630, timebaseTicks: 1 }
      )
    ).toThrow(/validated non-acoustic pass|synthetic clock/)
  })

  it('binds every wrap flag index to the marked loop and internal monotonic cadence', () => {
    const samples = goodLoopSamples()
    const evidence = goodAvEvidence()
    const loop = { startTicks: 0, endTicks: 300, timebaseTicks: 1 }
    const census = { values: Array.from({ length: 301 }, (_, index) => index) }
    expect(runner.validateLoopAwareAvVerdict(evidence, samples, census, loop)).toMatchObject({
      status: 'green-non-acoustic',
      wraps: [{ index: 10 }, { index: 20 }]
    })
    expect(() =>
      runner.validateLoopAwareAvVerdict(
        evidence,
        samples.map((sample, index) =>
          index === 10
            ? { ...sample, ptsWrap: false }
            : index === 11
              ? { ...sample, ptsWrap: true }
              : sample
        ),
        census,
        loop
      )
    ).toThrow(/wrap flag at 10/)
    expect(() =>
      runner.validateLoopAwareAvVerdict(
        evidence,
        samples.map((sample, index) =>
          index === 10 ? { ...sample, observedPtsSeconds: 5 } : sample
        ),
        census,
        loop
      )
    ).toThrow(/marked loop boundary/)
    expect(() =>
      runner.validateLoopAwareAvVerdict(
        evidence,
        samples.map((sample, index) => (index === 20 ? { ...sample, monotonicMs: 1 } : sample)),
        census,
        loop
      )
    ).toThrow(/cadence\/wall-clock proof/)
    expect(() =>
      runner.validateLoopAwareAvVerdict(
        {
          ...evidence,
          samples: evidence.samples.map((sample, index) =>
            index === 4
              ? { ...sample, referencePixel: { pixelComparison: { clean: false } } }
              : sample
          )
        },
        samples,
        census,
        loop
      )
    ).toThrow(/reference-pixel/)
    expect(() =>
      runner.validateLoopAwareAvVerdict(
        evidence,
        samples.map((sample, index) =>
          index === 3 ? { ...sample, raw: { ...sample.raw, current: 'avc1 forged' } } : sample
        ),
        census,
        loop
      )
    ).toThrow(/A\/V sample 3 is malformed/)
    expect(() =>
      runner.validateLoopAwareAvVerdict(evidence, samples, census, {
        startTicks: 0,
        endTicks: 30,
        timebaseTicks: 1
      })
    ).toThrow(/loop duration/)
    expect(() =>
      runner.validateLoopAwareAvVerdict(
        evidence,
        samples.map((sample, index) => (index === 0 ? { ...sample, ptsWrap: true } : sample)),
        census,
        loop
      )
    ).toThrow(/wrap flag at 0/)
  })
  it('requires a visible AX/HUD LOOP proof and focus restoration', () => {
    expect(runner.validateLoopProof(goodLoopProof())).toMatchObject({ loop: true, hudText: 'LOOP' })
    expect(() => runner.validateLoopProof({ ...goodLoopProof(), hudText: 'PLAY' })).toThrow(
      /HUD proof/
    )
    expect(() => runner.validateLoopProof({ ...goodLoopProof(), foregroundSetup: false })).toThrow(
      /background positioning/
    )
    expect(() => runner.validateLoopProof({ ...goodLoopProof(), focusRestored: false })).toThrow(
      /focus restoration/
    )
  })

  it('positions start then marks I, positions end then marks O before L/P', async () => {
    const batches: Array<Array<Record<string, unknown>>> = []
    const proof = await runner.defaultEstablishLoop(
      { artifactRoot: '/tmp/s10' },
      { companion: { pid: 12 }, window: {} },
      { loopStartTicks: 10, loopEndTicks: 610 },
      {
        windowBounds: () => ({ x: 0, y: 0, width: 640, height: 400 }),
        focusSnapshot: () => ({ frontmostPid: 99, targetActive: false, cursorX: 1, cursorY: 1 }),
        assertSourceWindowFocusIsolation: () => ({ focusPreserved: true, cursorPreserved: true }),
        ocrScreenshot: () => ({ texts: ['LOOP'] }),
        runStudioUiDriver: async (
          _plan: unknown,
          _target: unknown,
          actions: Array<Record<string, unknown>>
        ) => {
          batches.push(actions)
          return {
            actions: actions.map((action) => {
              if (action.type === 'set-playhead-ticks')
                return { ...action, observedPlayheadTicks: action.playheadTicks }
              if (action.type === 'read-transport-mutation')
                return {
                  ...action,
                  accessibilityRole: 'AXStaticText',
                  accessibilityMatchCount: 1,
                  accessibilityValue: 'tm1 loop=1'
                }
              if (action.type === 'screenshot') return { ...action, screenshotPath: '/tmp/x.png' }
              return action
            })
          }
        }
      }
    )
    expect(batches.slice(0, 4).map((batch) => batch.map((action) => action.type))).toEqual([
      ['set-playhead-ticks'],
      ['key'],
      ['set-playhead-ticks'],
      ['key', 'key', 'key']
    ])
    expect(batches[0][0]).toMatchObject({ playheadTicks: 10 })
    expect(batches[2][0]).toMatchObject({ playheadTicks: 610 })
    expect(proof).toMatchObject({ loopStartTicks: 10, loopEndTicks: 610 })
  })

  it('refuses incomplete native process custody before starting a journey', async () => {
    const sample = {
      loopActive: true,
      assetId: assetA.sha256,
      ptsWrap: false,
      raw: {
        current:
          'avc1 pf=1 ap=1 err=0 errms=0.000 win=1 winms=0.000 drawn=1 expl=explained ts=0 fd=1',
        peak: 'av1 pf=1 ap=1 err=0 errms=0.000 win=1 winms=0.000 drawn=1 expl=explained',
        resource: {},
        capture: {}
      }
    }
    await expect(
      runner.runS10Journey(
        { artifactRoot: '/tmp/s10', transcriptTimeoutMs: 1_000, profile: { userDataPath: '/tmp' } },
        { asset: assetA, window: {}, s10Assets: { primary: assetA, secondary: assetB } },
        {
          establishLoop: async () => goodLoopProof(),
          windowBounds: () => ({ x: 0, y: 0, width: 640, height: 400 }),
          prepareAvEnduranceSourceEvidence: () => ({}),
          runLoopAwareAcceptance: async (
            plan: unknown,
            target: unknown,
            prepared: unknown,
            adapters: {
              captureLoopSample: (
                plan: unknown,
                target: unknown,
                entry: { index: number; plannedElapsedMs: number }
              ) => Promise<unknown>
            }
          ) => {
            for (let index = 0; index < 21; index += 1)
              await adapters.captureLoopSample(plan, target, {
                index,
                plannedElapsedMs: index * 30_000
              })
            return { evidence: goodAvEvidence(), samples: [] }
          },
          captureLoopSample: async () => ({ ...sample, ptsWrap: false }),
          performSeeks: async () => [],
          performAlternatingOpens: async () => [],
          performRouteCycles: async () => [],
          performCloseReopenCycles: async () => [],
          stopLoopAndReadFinal: async () => ({})
        }
      )
    ).rejects.toThrow(/resource sample requires the actual harness process and renderer/)
  })

  it('requires exactly 100 ordered background seeks with first/selected/last identity', () => {
    const receipts = Array.from({ length: runner.SEEK_COUNT }, (_, index) => ({
      index,
      assetId: assetA.sha256,
      action: 'set-playhead-ticks',
      backgroundInput: true,
      playheadTicks: index + 1
    }))
    expect(runner.validateSeekReceipts(receipts, assetA.sha256)).toMatchObject({
      count: 100,
      finalAssetId: assetA.sha256
    })
    expect(() => runner.validateSeekReceipts(receipts.slice(0, -1), assetA.sha256)).toThrow(
      /exactly 100/
    )
    expect(() =>
      runner.validateSeekReceipts(
        receipts.map((r, i) => (i === 4 ? { ...r, index: 5 } : r)),
        assetA.sha256
      )
    ).toThrow(/wrong order/)
    expect(() =>
      runner.validateSeekReceipts(
        receipts.map((r, i) => (i === 9 ? { ...r, assetId: assetB.sha256 } : r)),
        assetA.sha256
      )
    ).toThrow(/wrong order or asset/)
    expect(() =>
      runner.validateSeekReceipts(
        receipts.map((receipt, index) =>
          index === 50 ? { ...receipt, playheadTicks: receipts[49].playheadTicks } : receipt
        ),
        assetA.sha256
      )
    ).toThrow(/100 unique/)
  })

  it('requires 20 alternating assets, fresh revisions, exact path and HUD identity', () => {
    const receipts = Array.from({ length: runner.ALTERNATING_OPEN_COUNT }, (_, index) => {
      const asset = index % 2 === 0 ? assetA : assetB
      return {
        index,
        assetId: asset.sha256,
        journalRevision: index + 1,
        journalPath: asset.assetPath,
        hudAssetId: asset.sha256,
        foregroundInput: false,
        inputDelivery: 'background-observation-only'
      }
    })
    expect(runner.validateAlternatingOpens(receipts, [assetA, assetB])).toMatchObject({ count: 20 })
    expect(() => runner.validateAlternatingOpens(receipts.slice(0, 19), [assetA, assetB])).toThrow(
      /exactly 20/
    )
    expect(() =>
      runner.validateAlternatingOpens(
        receipts.map((r, i) => (i === 2 ? { ...r, journalRevision: 2 } : r)),
        [assetA, assetB]
      )
    ).toThrow(/revision did not advance/)
    expect(() =>
      runner.validateAlternatingOpens(
        receipts.map((r, i) => (i === 1 ? { ...r, hudAssetId: assetA.sha256 } : r)),
        [assetA, assetB]
      )
    ).toThrow(/HUD identity/)
  })

  it('propagates the validated open timeout through all 20 default opens', async () => {
    const timeouts: number[] = []
    let current = assetA
    let revision = 0
    const receipts = await runner.defaultPerformAlternatingOpens(
      { artifactRoot: '/tmp/s10' },
      { renderer: {} },
      { primary: assetA, secondary: assetB },
      {
        openTimeoutMs: 123_456,
        invokeStudioOpen: async (
          _renderer: unknown,
          asset: typeof assetA,
          options: { timeoutMs: number }
        ) => {
          current = asset
          revision += 1
          timeouts.push(options.timeoutMs)
        },
        readJournalOperations: async () => [
          {
            revision,
            op: {
              type: 'open_media',
              asset: { assetId: current.sha256, path: current.assetPath }
            }
          }
        ],
        runStudioUiDriver: async () => ({
          actions: [{ type: 'screenshot', screenshotPath: '/tmp/open.png' }]
        }),
        ocrScreenshot: () => ({
          texts: [
            '00:00:01.000',
            'PAUSE',
            'drop 0 held 0 shown 1 cache 1 tex 1',
            'play 1 rss 1 MB'
          ],
          stdoutSha256: 'a'.repeat(64)
        }),
        hudContainsAsset: () => ({ matched: true, assetId: current.sha256, distance: 0 })
      }
    )
    expect(timeouts).toEqual(Array.from({ length: 20 }, () => 123_456))
    expect(runner.validateAlternatingOpens(receipts, [assetA, assetB])).toMatchObject({ count: 20 })
  })

  it('requires 10 exact background AX route cycles', () => {
    const receipts = Array.from({ length: 10 }, (_, index) => ({
      index,
      action: 'AXPress',
      transitions: ['timeline-show', 'source-hide', 'source-show', 'timeline-hide'].map((name) => ({
        name,
        accessibilityAction: 'AXPress',
        routeValueBefore: 'selected',
        routeValueAfter: 'not selected'
      })),
      visibilitySnapshots: [
        { source: true, timeline: true },
        { source: false, timeline: true },
        { source: true, timeline: true },
        { source: true, timeline: false }
      ],
      inputDelivery: 'background-observation-only',
      foregroundInput: false,
      sourceVisible: true,
      timelineVisible: false,
      hudAssetId: assetA.sha256,
      resource: { physicalFootprintBytes: 1 }
    }))
    expect(runner.validateRouteCycles(receipts)).toEqual({ count: 10 })
    expect(() =>
      runner.validateRouteCycles(receipts.map((r, i) => (i === 3 ? { ...r, action: 'noop' } : r)))
    ).toThrow(/AXPress/)
    expect(() =>
      runner.validateRouteCycles(
        receipts.map((r, i) => (i === 3 ? { ...r, foregroundInput: true } : r))
      )
    ).toThrow(/foreground input/)
    expect(() =>
      runner.validateRouteCycles(
        receipts.map((receipt, index) =>
          index === 1
            ? {
                ...receipt,
                transitions: receipt.transitions.map((transition, transitionIndex) =>
                  transitionIndex === 2
                    ? { ...transition, routeValueAfter: transition.routeValueBefore }
                    : transition
                )
              }
            : receipt
        )
      )
    ).toThrow(/no-op/)
  })

  function routeCycleAdapters(
    observeWorkloadResource: (phase: string, index: number) => Promise<unknown>
  ) {
    const snapshots = [
      { source: true, timeline: true },
      { source: false, timeline: true },
      { source: true, timeline: true },
      { source: true, timeline: false }
    ]
    const driver = { calls: 0 }
    const adapters = {
      observeWorkloadResource,
      hudContainsAsset: () => ({ matched: true, assetId: assetA.sha256, distance: 0 }),
      ocrScreenshot: () => ({
        texts: ['00:00:01.000', 'PAUSE', 'drop 0 held 0 shown 1 cache 1 tex 1', 'play 1 rss 1 MB'],
        stdoutSha256: 'a'.repeat(64)
      }),
      resourceSample: () => ({
        physicalFootprintBytes: 1,
        mallocAllocatedBytes: 1,
        residentBytes: 1
      }),
      runStudioUiDriver: async (
        _plan: unknown,
        _target: unknown,
        actions: Array<Record<string, unknown>>
      ) => {
        const phase = driver.calls++ % 4
        const press = actions[0]
        const selectedAfter = press.selectedAfter === true
        return {
          actions: actions.map((action) => {
            if (action.type === 'press-workspace-route')
              return {
                ...action,
                accessibilityAction: 'AXPress',
                routeValueBefore: selectedAfter ? 'not selected' : 'selected',
                routeValueAfter: selectedAfter ? 'selected' : 'not selected',
                pairedRouteValueBefore: 'selected',
                pairedRouteValueAfter: 'selected'
              }
            if (action.type === 'read-workspace')
              return {
                ...action,
                workspace: {
                  sourceHost: { visible: snapshots[phase].source },
                  timelineHost: { visible: snapshots[phase].timeline }
                }
              }
            if (action.type === 'read-av-sync')
              return {
                ...action,
                resourceDetailValue: 'res1 dec=1 cap=4 surf=1 ids=00000001'
              }
            if (action.type === 'screenshot') return { ...action, screenshotPath: '/tmp/x.png' }
            return action
          })
        }
      }
    }
    return { driver, adapters }
  }

  it('derives route-cycle evidence from 40 real action receipts and snapshots', async () => {
    const { driver, adapters } = routeCycleAdapters(async (_phase, index) =>
      ownedSample('route', index, index, assetA.sha256)
    )
    const receipts = await runner.defaultPerformRouteCycles(
      { artifactRoot: '/tmp/s10' },
      { companion: { pid: 12 }, asset: assetA },
      10,
      adapters
    )
    expect(driver.calls).toBe(40)
    expect(runner.validateRouteCycles(receipts)).toEqual({ count: 10 })
  })

  it('refuses a live route step whose native Review stays attached after Timeline hides', async () => {
    const { driver, adapters } = routeCycleAdapters(async (_phase, index) => {
      const sample = ownedSample('route', index, index, assetA.sha256)
      sample.native.workspace.reviewPresentationAttached = true
      return sample
    })
    await expect(
      runner.defaultPerformRouteCycles(
        { artifactRoot: '/tmp/s10' },
        { companion: { pid: 12 }, asset: assetA },
        1,
        adapters
      )
    ).rejects.toThrow(/native Review stays attached while Timeline is hidden/)
    expect(driver.calls).toBe(4)
  })

  it('requires 10 close/reopen helper receipts with new window IDs and paused readiness', () => {
    const receipts = Array.from({ length: 10 }, (_, index) => ({
      index,
      helperPath: runner.EXPECTED_CLOSE_HELPER,
      closed: true,
      cooldownSample: { closed: true },
      windowIdBefore: index + 1,
      windowIdAfter: index + 101,
      assetId: assetA.sha256,
      paused: true,
      readiness: 'exact-asset-paused'
    }))
    expect(runner.validateCloseReopenCycles(receipts, assetA.sha256)).toEqual({ count: 10 })
    expect(() =>
      runner.validateCloseReopenCycles(
        receipts.map((r, i) => (i === 2 ? { ...r, windowIdAfter: r.windowIdBefore } : r)),
        assetA.sha256
      )
    ).toThrow(/reused/)
    expect(() =>
      runner.validateCloseReopenCycles(
        receipts.map((r, i) => (i === 2 ? { ...r, helperPath: 'wrong.swift' } : r)),
        assetA.sha256
      )
    ).toThrow(/exact close helper/)
  })

  it('propagates the validated open timeout through default close/reopen', async () => {
    const root = await tempRoot()
    let reopened = false
    let timeout: number | null = null
    let journalRead = 0
    const receipts = await runner.defaultPerformCloseReopenCycles(
      {
        repoRoot: '/Users/chrisizatt/Documents/AGBench-studio-continuation',
        artifactRoot: root
      },
      {
        companion: { pid: 12, pgid: 12, command: '/tmp/TaskWraithStudioCompanion' },
        window: {
          visibleWindowCount: 1,
          windows: [{ title: 'TaskWraith Studio', windowId: 7 }]
        },
        renderer: {},
        asset: assetA
      },
      1,
      {
        openTimeoutMs: 123_456,
        runExact: () => ({
          stdout: JSON.stringify({
            schemaVersion: 1,
            kind: 'taskwraith-studio-endurance-window-control-receipt',
            pid: 12,
            pgid: 12,
            executablePath: '/tmp/TaskWraithStudioCompanion',
            windowId: 7,
            windowTitle: 'TaskWraith Studio',
            accessibilityRole: 'AXButton',
            accessibilityAction: 'AXPress',
            stateBefore: 'visible',
            stateAfter: 'closed',
            focusIsolation: { focusPreserved: true, cursorPreserved: true }
          })
        }),
        probeNativeWindow: async () => {
          if (!reopened) throw new Error('No on-screen native Studio window for exact pid 12')
          return {
            visibleWindowCount: 1,
            windows: [{ title: 'TaskWraith Studio', windowId: 8 }]
          }
        },
        closedResourceSample: async () => ({ closed: true, windowReappeared: false }),
        invokeStudioOpen: async (
          _renderer: unknown,
          _asset: unknown,
          options: { timeoutMs: number }
        ) => {
          timeout = options.timeoutMs
          reopened = true
        },
        verifyDurableOpen: async () => ({ revision: 2 }),
        readJournalOperations: async () => {
          journalRead += 1
          return journalRead === 1
            ? [{ revision: 1 }]
            : [
                {
                  revision: 2,
                  op: {
                    type: 'open_media',
                    asset: { assetId: assetA.sha256, path: assetA.assetPath }
                  }
                }
              ]
        },
        runStudioUiDriver: async () => ({
          actions: [{ type: 'screenshot', screenshotPath: '/tmp/reopen.png' }]
        }),
        ocrScreenshot: () => ({
          texts: [
            '00:00:01.000',
            'PAUSE',
            'drop 0 held 0 shown 1 cache 1 tex 1',
            'play 1 rss 1 MB'
          ],
          stdoutSha256: 'a'.repeat(64)
        }),
        hudContainsAsset: () => ({ matched: true, assetId: assetA.sha256, distance: 0 })
      }
    )
    expect(timeout).toBe(123_456)
    expect(receipts).toHaveLength(1)
  })
})

describe('S10 resource verdict and evidence custody', () => {
  const workloadIdentity = resourceIdentity

  function workloadResources() {
    return workloadFixture().samples
  }

  it('rechecks all phase receipts and the same native history before promoting a complete journey', () => {
    const { journey, assets, companion } = completeJourneyFixture()
    expect(runner.validateCompleteS10Journey(journey, assets, companion)).toBe(true)
    const substituted = structuredClone(journey)
    substituted.loop.samples[0].resource.native.processInstanceId =
      '12345678-1234-1234-1234-123456789012'
    expect(() => runner.validateCompleteS10Journey(substituted, assets, companion)).toThrow()
    const missingPhase = structuredClone(journey)
    missingPhase.seeks.receipts.pop()
    expect(() => runner.validateCompleteS10Journey(missingPhase, assets, companion)).toThrow(
      /100 receipts/
    )
    expect(() =>
      runner.validateCompleteS10Journey(journey, assets, { ...companion, pid: 99 })
    ).toThrow(/custody/)
  })

  it('preserves every workload measurement and uses the actual post-stress final and peak', () => {
    const samples = workloadResources()
    const peak = samples.find((sample) => sample.phase === 'switch' && sample.index === 7)!
    peak.rssBytes += 4_000_000
    const verdict = runner.validateWorkloadResourceVerdict(
      samples,
      workloadIdentity,
      warmPlanFixture()
    )
    expect(verdict).toMatchObject({ status: 'green', sampleCount: 202 })
    expect(verdict.samples).toEqual(samples)
    expect(verdict.baseline).toEqual(samples[0])
    expect(verdict.peak).toEqual(peak)
    expect(verdict.final).toEqual(samples.at(-1))
  })

  it.each(['seek', 'switch', 'route', 'reopen'])(
    'rejects a memory peak confined to the %s phase even when final cooldown would be clean',
    (phase) => {
      const samples = workloadResources()
      const leaked = samples.find((sample) => sample.phase === phase && sample.index === 5)!
      leaked.rssBytes += 25 * 1_048_576
      expect(() =>
        runner.validateWorkloadResourceVerdict(samples, workloadIdentity, warmPlanFixture())
      ).toThrow(/workload.*budget/)
    }
  )

  it.each(['switch', 'route', 'reopen'])(
    'rejects post-warmup monotonic growth limited to the %s phase',
    (phase) => {
      const samples = workloadResources()
      for (const sample of samples.filter((value) => value.phase === phase)) {
        sample.rssBytes += (sample.index + 1) * 1024
      }
      expect(() =>
        runner.validateWorkloadResourceVerdict(samples, workloadIdentity, warmPlanFixture())
      ).toThrow(/workload.*monotonic/)
    }
  )

  it('rejects a transient decoder leak with flat RSS and a later clean final', () => {
    const samples = workloadResources()
    samples.find(
      (sample) => sample.phase === 'switch' && sample.index === 5
    )!.residentDecoderCount = 3
    expect(() =>
      runner.validateWorkloadResourceVerdict(samples, workloadIdentity, warmPlanFixture())
    ).toThrow(/workload.*decoder/)
  })

  it.each(['missing', 'phase', 'index', 'pid', 'asset', 'stale-clock', 'capacity'])(
    'refuses incomplete or contradictory workload custody: %s',
    (mutation) => {
      const samples = workloadResources()
      const sample = samples[125]
      if (mutation === 'missing') samples.splice(125, 1)
      if (mutation === 'phase') sample.phase = 'loop'
      if (mutation === 'index') sample.index += 1
      if (mutation === 'pid') sample.processPid += 1
      if (mutation === 'asset') sample.assetId = 'foreign'
      if (mutation === 'stale-clock') sample.monotonicMs = samples[124].monotonicMs
      if (mutation === 'capacity') sample.ioSurfaceCapacity += 1
      expect(() =>
        runner.validateWorkloadResourceVerdict(samples, workloadIdentity, warmPlanFixture())
      ).toThrow(/workload/)
    }
  )

  it.each(['rssBytes', 'physicalFootprintBytes', 'mallocLiveBytes'] as const)(
    'refuses a workload %s above the fixed warm allocation ceiling',
    (field) => {
      const { samples, plan } = workloadFixture()
      samples[125][field] = plan.memoryCeilings[field] + 1
      const verdict = () => runner.validateWorkloadResourceVerdict(samples, workloadIdentity, plan)
      expect(verdict).toThrow(`exceeds the ${field} allocation-class budget`)
    }
  )

  it('accepts bounded resource readings only when the shared growth classifier is green', () => {
    expect(runner.validateS10ResourceVerdict(goodResources())).toMatchObject({ status: 'green' })
    const leaking = goodResources().map((sample, index) => ({
      ...sample,
      physicalFootprintBytes: 200_000_000 + index * 2_000_000
    }))
    expect(() => runner.validateS10ResourceVerdict(leaking)).toThrow(/resource verdict/)
    const accumulating = goodResources().map((sample, index) => ({
      ...sample,
      ioSurfaceIds: [1, 2, 3].slice(0, Math.min(3, index + 1))
    }))
    expect(() => runner.validateS10ResourceVerdict(accumulating)).toThrow(/resource verdict/)
    expect(() => runner.validateS10ResourceVerdict(goodResources().slice(0, 20))).toThrow(
      /exactly 21/
    )
    expect(() =>
      runner.validateS10ResourceVerdict(
        goodResources().map((sample) => ({ ...sample, players: 1e99, textures: 1e99 }))
      )
    ).toThrow(/bounded counters/)
  })

  it('requires native cooldown proof joined to the actual workload and immutable budget', () => {
    const { samples, plan } = workloadFixture()
    const live = runner.validateWorkloadResourceVerdict(samples, workloadIdentity, plan)
    const receipt = cooldownFixture(live)
    expect(runner.validateFinalCooldown(receipt, live)).toMatchObject({ closed: true })
    expect(() => runner.validateFinalCooldown({ ...receipt, decodeStopped: false }, live)).toThrow(
      /decode-stopped/
    )
    expect(() =>
      runner.validateFinalCooldown({ ...receipt, memoryReturnedWithinBudget: false }, live)
    ).toThrow(/memory return budget/)
    const windowReturned = structuredClone(receipt)
    windowReturned.resourceSnapshots[3].windowReappeared = true
    expect(() => runner.validateFinalCooldown(windowReturned, live)).toThrow(/window reappeared/)
    const oldHud = structuredClone(receipt)
    oldHud.terminalCounters.status = 'blocked'
    expect(() => runner.validateFinalCooldown(oldHud, live)).toThrow(/measured native/)
    const changedTerminal = structuredClone(receipt)
    changedTerminal.resourceSnapshots[3].rssBytes += 1
    expect(() => runner.validateFinalCooldown(changedTerminal, live)).toThrow(/terminal snapshot/)
    const unrelatedBaseline = structuredClone(receipt)
    unrelatedBaseline.resourceSnapshots[0].rssBytes += 1
    expect(() => runner.validateFinalCooldown(unrelatedBaseline, live)).toThrow(
      /actual whole-workload/
    )
  })

  it.each(['rssBytes', 'physicalFootprintBytes', 'mallocLiveBytes'] as const)(
    'refuses a cooldown %s above the fixed warm return ceiling',
    (field) => {
      const { samples, plan } = workloadFixture()
      const live = runner.validateWorkloadResourceVerdict(samples, workloadIdentity, plan)
      const receipt = structuredClone(cooldownFixture(live))
      const excess = plan.cooldownMemoryCeilings[field] + 1
      receipt.terminalCounters.second[field] = excess
      receipt.resourceSnapshots[3][field] = excess
      expect(() => runner.validateFinalCooldown(receipt, live)).toThrow(
        `cooldown ${field} exceeds warm budget`
      )
    }
  )

  it('captures live resource snapshots before final close and never calls the UI driver after close', async () => {
    const root = await tempRoot()
    let closed = false
    let driverCalls = 0
    let cooldownWaits = 0
    const target = {
      companion: { pid: 12, pgid: 12, command: '/tmp/TaskWraithStudioCompanion' },
      window: {
        visibleWindowCount: 1,
        windows: [{ title: 'TaskWraith Studio', windowId: 7 }]
      },
      asset: assetB
    }
    const { samples, plan: resourcePlan } = workloadFixture()
    const live = runner.validateWorkloadResourceVerdict(samples, workloadIdentity, resourcePlan)
    const closedEvidence = cooldownFixture(live)
    const result = await runner.defaultStopLoopAndReadFinal(
      { artifactRoot: root, repoRoot: '/Users/chrisizatt/Documents/AGBench-studio-continuation' },
      target,
      {
        runStudioUiDriver: async (_plan: unknown, _target: unknown, actions: unknown[]) => {
          driverCalls += 1
          expect(closed).toBe(false)
          expect(actions).toEqual([{ type: 'screenshot', name: 's10-final-paused-before-close' }])
          return { actions: [{ type: 'screenshot', screenshotPath: '/tmp/final-paused.png' }] }
        },
        hudContainsAsset: () => ({ matched: true, assetId: assetB.sha256, distance: 0 }),
        ocrScreenshot: () => ({
          texts: [
            '00:00:01.000',
            'PAUSE',
            'drop 0 held 0 shown 1 cache 1 tex 1',
            'play 1 rss 1 MB'
          ],
          stdoutSha256: 'a'.repeat(64)
        }),
        runExact: (command: string) => {
          if (command === '/usr/bin/swift') {
            closed = true
            return {
              stdout: JSON.stringify({
                schemaVersion: 1,
                kind: 'taskwraith-studio-endurance-window-control-receipt',
                pid: 12,
                pgid: 12,
                executablePath: '/tmp/TaskWraithStudioCompanion',
                windowId: 7,
                windowTitle: 'TaskWraith Studio',
                accessibilityRole: 'AXButton',
                accessibilityAction: 'AXPress',
                stateBefore: 'visible',
                stateAfter: 'closed',
                focusIsolation: { focusPreserved: true, cursorPreserved: true }
              })
            }
          }
          return { stdout: '12 12 /tmp/TaskWraithStudioCompanion' }
        },
        probeNativeWindow: async () => {
          throw new Error('No on-screen native Studio window for exact pid 12')
        },
        waitCooldownInterval: async (milliseconds: number) => {
          expect(milliseconds).toBe(2_000)
          cooldownWaits += 1
        },
        observeWorkloadResource: async (phase: string, index: number) => {
          expect(phase).toBe('cooldown')
          expect(closed).toBe(true)
          return structuredClone(
            index === 0
              ? closedEvidence.terminalCounters.first
              : closedEvidence.terminalCounters.second
          )
        }
      },
      { liveResourceEvidence: live }
    )
    expect(driverCalls).toBe(1)
    expect(cooldownWaits).toBe(2)
    expect(result.resourceSnapshots.map((sample: Record<string, unknown>) => sample.label)).toEqual(
      ['baseline', 'peak', 'final', 'cooldown']
    )
    expect(result.decodeStopped).toBe(true)
    expect(result.terminalCounters).toMatchObject({ status: 'measured' })
  })

  it('distinguishes exact zero-window refusal from an indeterminate probe error', async () => {
    await expect(
      runner.assertNoVisibleStudioWindow(12, async () => {
        throw new Error('Accessibility permission denied')
      })
    ).rejects.toThrow(/indeterminately/)
    await expect(
      runner.assertNoVisibleStudioWindow(12, async () => {
        throw new Error('No on-screen native Studio window for exact pid 12')
      })
    ).resolves.toMatchObject({ closed: true, exactPid: 12 })
  })

  it('requires every live phase before a runner-owned final evidence receipt can claim completeness', async () => {
    const root = await tempRoot()
    const state = path.join(root, 'state')
    await fsPromises.mkdir(state, { recursive: true })
    const plan = {
      artifactRoot: root,
      evidencePath: path.join(root, 'harness.json'),
      receiptPath: path.join(root, 'watchdog.json'),
      studioStateDirectory: state,
      repoRoot: '/Users/chrisizatt/Documents/AGBench-studio-continuation',
      profile: { userDataPath: path.join(root, 'home') }
    }
    await fsPromises.mkdir(path.join(root, 'home'), { recursive: true })
    await fsPromises.writeFile(plan.evidencePath, '{}')
    await fsPromises.writeFile(plan.receiptPath, '{}')
    await fsPromises.writeFile(path.join(state, 'studio-project.journal.jsonl'), '{}\n')
    await expect(
      runner.writeFinalS10Evidence(
        plan,
        { evidence: { journey: { phasesComplete: false } } },
        { primary: assetA, secondary: assetB }
      )
    ).rejects.toThrow()
  })

  it('refuses oversized evidence before parsing it', async () => {
    const root = await tempRoot()
    const evidence = path.join(root, 'oversized.json')
    await fsPromises.writeFile(evidence, '{}')
    await fsPromises.truncate(evidence, 32 * 1024 * 1024 + 1)
    await expect(runner.readBoundedJson(evidence, 'oversized evidence')).rejects.toThrow(
      /bounded regular file/
    )
  })

  it('refuses symlinked or escaped screenshot/reference evidence', async () => {
    const root = await tempRoot()
    const outside = path.join(os.tmpdir(), `s10-outside-${Date.now()}.png`)
    await fsPromises.writeFile(outside, 'pixels')
    const linked = path.join(root, 'linked.png')
    await fsPromises.symlink(outside, linked)
    await expect(
      runner.assertBoundedArtifactFile(linked, root, 'linked screenshot')
    ).rejects.toThrow(/bounded regular file/)
    await expect(
      runner.assertBoundedArtifactFile(outside, root, 'escaped reference')
    ).rejects.toThrow(/escaped/)
    await fsPromises.rm(outside, { force: true })
  })

  it('requires every Outcome2 source to match its HEAD blob before hashing', async () => {
    const root = await tempRoot()
    await fsPromises.writeFile(path.join(root, 'source.swift'), 'clean\n')
    const calls: string[][] = []
    const measured = await runner.measureHeadBoundSources(root, ['source.swift'], {
      runExact: async (_command: string, args: string[]) => {
        calls.push(args)
        return { stdout: args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : '' }
      }
    })
    expect(calls).toEqual([
      ['diff', '--quiet', 'HEAD', '--', 'source.swift'],
      ['rev-parse', 'HEAD:source.swift']
    ])
    expect(measured['source.swift']).toMatchObject({ headBlob: 'a'.repeat(40) })
    await expect(
      runner.measureHeadBoundSources(root, ['source.swift'], {
        runExact: async (_command: string, args: string[]) => {
          if (args[0] === 'diff') throw new Error('dirty versus HEAD')
          return { stdout: `${'a'.repeat(40)}\n` }
        }
      })
    ).rejects.toThrow(/dirty versus HEAD/)
  })
})
