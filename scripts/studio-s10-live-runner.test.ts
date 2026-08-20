import * as fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

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
  validateFinalCooldown: (cooldown: Record<string, unknown>) => Record<string, unknown>
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
}

const roots: string[] = []

async function tempRoot() {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'studio-s10-'))
  roots.push(root)
  return root
}

afterEach(async () => {
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

describe('S10 plan and launch gates', () => {
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

  it('rejects missing PTS wrap and accepts a real wrap receipt', async () => {
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
            adapters: Record<string, Function>
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
    ).rejects.toThrow(/PTS wrap|resource sample/)
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

  it('derives route-cycle evidence from 40 real action receipts and snapshots', async () => {
    let call = 0
    const snapshots = [
      { source: true, timeline: true },
      { source: false, timeline: true },
      { source: true, timeline: true },
      { source: true, timeline: false }
    ]
    const receipts = await runner.defaultPerformRouteCycles(
      { artifactRoot: '/tmp/s10' },
      { companion: { pid: 12 }, asset: assetA },
      10,
      {
        hudContainsAsset: () => ({ matched: true, assetId: assetA.sha256, distance: 0 }),
        ocrScreenshot: () => ({
          texts: [
            '00:00:01.000',
            'PAUSE',
            'drop 0 held 0 shown 1 cache 1 tex 1',
            'play 1 rss 1 MB'
          ],
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
          const phase = call++ % 4
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
    )
    expect(call).toBe(40)
    expect(runner.validateRouteCycles(receipts)).toEqual({ count: 10 })
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

  it('requires baseline/peak/final/cooldown counters and an evidenced memory return budget', () => {
    const snapshots = ['baseline', 'peak', 'final', 'cooldown'].map((label) => ({
      label,
      rssBytes: 1,
      physicalFootprintBytes: 2,
      mallocLiveBytes: 3,
      players: 1,
      frames: 1,
      textures: 1,
      cacheHits: 1,
      droppedFrames: 0,
      cpuPercent: 0,
      windowReappeared: false,
      ioSurfaceIds: [1]
    }))
    expect(
      runner.validateFinalCooldown({
        closed: true,
        processPid: 12,
        processPgid: 12,
        executablePath: '/tmp/TaskWraithStudioCompanion',
        targetAssetId: assetA.sha256,
        cooldown: { closed: true },
        terminalCounters: { status: 'blocked', reason: 'no HUD after close' },
        decodeStopped: true,
        resourceSnapshots: snapshots,
        memoryReturnedWithinBudget: true,
        memoryReturnBudgetBytes: 100
      })
    ).toMatchObject({ closed: true })
    expect(() =>
      runner.validateFinalCooldown({
        closed: true,
        processPid: 12,
        processPgid: 12,
        executablePath: '/tmp/TaskWraithStudioCompanion',
        targetAssetId: assetA.sha256,
        cooldown: { closed: true },
        terminalCounters: { status: 'blocked', reason: 'no HUD after close' },
        decodeStopped: false,
        resourceSnapshots: snapshots,
        memoryReturnedWithinBudget: true,
        memoryReturnBudgetBytes: 100
      })
    ).toThrow(/decode-stopped/)
    expect(() =>
      runner.validateFinalCooldown({
        closed: true,
        processPid: 12,
        processPgid: 12,
        executablePath: '/tmp/TaskWraithStudioCompanion',
        targetAssetId: assetA.sha256,
        cooldown: { closed: true },
        terminalCounters: { status: 'blocked', reason: 'no HUD after close' },
        decodeStopped: true,
        resourceSnapshots: snapshots,
        memoryReturnedWithinBudget: false,
        memoryReturnBudgetBytes: 100
      })
    ).toThrow(/memory return budget/)
    expect(() =>
      runner.validateFinalCooldown({
        closed: true,
        processPid: 12,
        processPgid: 12,
        executablePath: '/tmp/TaskWraithStudioCompanion',
        targetAssetId: assetA.sha256,
        cooldown: { closed: true },
        terminalCounters: { status: 'blocked', reason: 'no HUD after close' },
        decodeStopped: true,
        resourceSnapshots: snapshots.map((sample, index) =>
          index === 3 ? { ...sample, cpuPercent: 2 } : sample
        ),
        memoryReturnedWithinBudget: true,
        memoryReturnBudgetBytes: 100
      })
    ).toThrow(/CPU remained active/)
    expect(() =>
      runner.validateFinalCooldown({
        closed: true,
        processPid: 12,
        processPgid: 12,
        executablePath: '/tmp/TaskWraithStudioCompanion',
        targetAssetId: assetA.sha256,
        cooldown: { closed: true },
        terminalCounters: { status: 'blocked', reason: 'no HUD after close' },
        decodeStopped: true,
        resourceSnapshots: snapshots.map((sample, index) =>
          index === 3 ? { ...sample, windowReappeared: true } : sample
        ),
        memoryReturnedWithinBudget: true,
        memoryReturnBudgetBytes: 100
      })
    ).toThrow(/window reappeared/)
    expect(() =>
      runner.validateFinalCooldown({
        closed: true,
        processPid: 12,
        processPgid: 12,
        executablePath: '/tmp/TaskWraithStudioCompanion',
        targetAssetId: assetA.sha256,
        cooldown: { closed: true },
        terminalCounters: { status: 'blocked', reason: 'no HUD after close' },
        decodeStopped: true,
        resourceSnapshots: snapshots.map((sample, index) =>
          index === 3 ? { ...sample, rssBytes: 1_000 } : sample
        ),
        memoryReturnedWithinBudget: true,
        memoryReturnBudgetBytes: 100
      })
    ).toThrow(/memory remained over budget/)
  })

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
      asset: assetA
    }
    const live = ['baseline', 'peak', 'final'].map((label) => ({
      label,
      rssBytes: 100,
      physicalFootprintBytes: 100,
      mallocLiveBytes: 100,
      players: 1,
      frames: 10,
      textures: 2,
      cacheHits: 3,
      droppedFrames: 0,
      ioSurfaceIds: [1],
      windowReappeared: false
    }))
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
        hudContainsAsset: () => ({ matched: true, assetId: assetA.sha256, distance: 0 }),
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
        resourceSample: async () => ({
          ps: { rssKilobytes: 1 },
          physicalFootprintBytes: 100,
          mallocAllocatedBytes: 100,
          top: { cpuPercent: 0 },
          mappedRegionIdentities: ['1']
        })
      },
      { liveResourceEvidence: { baseline: live[0], peak: live[1], final: live[2] } }
    )
    expect(driverCalls).toBe(1)
    expect(cooldownWaits).toBe(1)
    expect(result.resourceSnapshots.map((sample: Record<string, unknown>) => sample.label)).toEqual(
      ['baseline', 'peak', 'final', 'cooldown']
    )
    expect(result.decodeStopped).toBe(true)
    expect(result.terminalCounters).toMatchObject({ status: 'blocked' })
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
