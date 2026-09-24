import crypto from 'node:crypto'
import fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-require-imports */
const runner =
  require('./studio-review-route-lifecycle-runner.cjs') as typeof import('./studio-review-route-lifecycle-runner.cjs')
const diagnosticsRunner = require('./studio-bounded-diagnostics-runner.cjs')
const studioSession = require('./studio-acceptance-session.cjs')

const temporaryRoots: string[] = []

async function temporaryRoot() {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'studio-review-route-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    await fsPromises.rm(temporaryRoots.pop() as string, { recursive: true, force: true })
  }
})

function assetIds() {
  return {
    primary: Buffer.from('ab'.repeat(32), 'hex').toString('base64url'),
    secondary: Buffer.from('cd'.repeat(32), 'hex').toString('base64url')
  }
}

function fixtureAssets() {
  const probe = {
    videoStreamCount: 1,
    audioStreamCount: 1,
    frameCount: 240,
    durationSeconds: 8
  }
  return {
    primary: { outputSha256: 'ab'.repeat(32), durationSeconds: 8, probe },
    secondary: { outputSha256: 'cd'.repeat(32), durationSeconds: 8, probe }
  }
}

function ghostPixel(captureSha256 = 'a'.repeat(64), counterpartSha256 = 'b'.repeat(64)) {
  return {
    schemaVersion: 1,
    kind: 'taskwraith-studio-ghost-difference',
    region: 'review-host',
    route: 'review',
    captureSha256,
    counterpartSha256,
    comparison: {
      ok: true,
      region: 'review-host',
      beforeSha256: captureSha256,
      afterSha256: counterpartSha256
    }
  }
}

function decodedPixel(
  sourceAssetId = assetIds().primary,
  sourcePtsSeconds = 1,
  sourceAssetPath = '/tmp/source.mp4'
) {
  const capturePath = '/tmp/capture.png'
  const referencePath = '/tmp/reference.png'
  const args = diagnosticsRunner.buildReferenceExtractCommand({
    assetPath: sourceAssetPath,
    exactSourcePtsSeconds: sourcePtsSeconds,
    referencePath
  })
  return {
    schemaVersion: 1,
    kind: 'taskwraith-studio-decoded-material',
    region: 'review-host',
    route: 'review',
    capturePath,
    captureSha256: 'a'.repeat(64),
    referencePath,
    referenceSha256: 'b'.repeat(64),
    sourceAssetId,
    sourceAssetPath,
    sourcePtsSeconds,
    ffmpegExecution: {
      executable: studioSession.resolveMediaTool('ffmpeg'),
      args,
      exitCode: 0,
      stdoutByteLength: 0,
      stdoutSha256: 'c'.repeat(64),
      stderrByteLength: 0,
      stderrSha256: 'd'.repeat(64)
    },
    comparison: {
      clean: true,
      capture: { path: capturePath, sha256: 'a'.repeat(64) },
      reference: { path: referencePath, sha256: 'b'.repeat(64) },
      metrics: {
        materialPixelCount: 1,
        meanAbsoluteChannelResidual: 0,
        p95ChannelResidual: 0,
        p99ChannelResidual: 0,
        maximumChannelResidual: 0,
        fractionAbove40: 0,
        fractionAbove80: 0
      }
    }
  }
}

function resource(
  routeActiveSourceCount: number,
  routeRetainedFrameCount: number,
  route = 'timeline'
) {
  return {
    activeSourceCount: routeActiveSourceCount,
    cacheHits: 4,
    ioSurfaceIds: ['00000001'],
    players: 1,
    process: {
      residentBytes: 10,
      physicalFootprintBytes: 10,
      mallocAllocatedBytes: 10,
      productSurfaceIds: ['00000001']
    },
    retainedFrameCount: routeRetainedFrameCount,
    textures: 2,
    routeOwnership: {
      activeSourceCount: routeActiveSourceCount,
      ioSurfaceIds:
        routeActiveSourceCount === 0 && routeRetainedFrameCount === 0 ? [] : ['00000001'],
      retainedFrameCount: routeRetainedFrameCount,
      route: route === 'source' ? 'source' : 'review'
    }
  }
}

function goodEvidence() {
  const ids = assetIds()
  const transitions = runner.ROUTE_SEQUENCE.map(([from, to]: [string, string], index: number) => ({
    index,
    transition: { from, to, accessibilityAction: 'AXPress' },
    sharedClock: {
      ok: true,
      fromBeforeTicks: 10,
      fromAfterTicks: 11,
      toBeforeTicks: 11,
      toAfterTicks: 10,
      routeAction: {
        type: 'press-workspace-route',
        accessibilityAction: 'AXPress',
        accessibilityIdentifier: `studio.workspace.route.${to}`,
        pairedAccessibilityIdentifier: `studio.workspace.route.${from}`,
        routeValueBefore: 'not selected',
        routeValueAfter: 'selected',
        pairedRouteValueBefore: 'selected',
        pairedRouteValueAfter: 'selected'
      }
    },
    content: {
      before: {
        route: from,
        sourceIndependent: from === 'source',
        timelineContentVisible: from === 'timeline'
      },
      after: {
        route: to,
        sourceIndependent: to === 'source',
        timelineContentVisible: to === 'timeline',
        ghostsVisible: false
      }
    },
    resources: {
      before: resource(2, 2, from),
      hidden: resource(0, 0, from),
      after: resource(2, 1, to),
      hiddenRouteDetached: true
    }
  }))
  return {
    schemaVersion: 1,
    kind: 'taskwraith-studio-review-route-lifecycle-journey',
    assetIds: ids,
    assetPaths: {
      primary: '/tmp/primary-materialized.mp4',
      secondary: '/tmp/secondary-materialized.mp4'
    },
    proposal: {
      proposalFirst: true,
      proposalId: 'proposal-o34',
      proposalRevision: 2,
      op: {
        type: 'insert_range',
        itemId: 'item-o34',
        assetId: ids.secondary,
        sourceIn: { n: 0, d: 600 },
        sourceOut: { n: 600, d: 600 },
        at: { n: 1200, d: 600 }
      },
      visibleGhost: true,
      // ghostPixels: pre-ghost baseline (a) -> post-proposal Current (b).
      // currentPixels/proposedPixels: post-proposal Current (b) <-> Proposed (c).
      currentPixels: ghostPixel('b'.repeat(64), 'c'.repeat(64)),
      proposedPixels: ghostPixel('c'.repeat(64), 'b'.repeat(64)),
      ghostPixels: ghostPixel()
    },
    reviewLoop: {
      exact: true,
      route: 'review',
      active: true,
      endpointObservation: 'exact-accessibility',
      insertionStartTicks: 1200,
      insertionEndTicks: 1800,
      preRollTicks: 600,
      postRollTicks: 600,
      startTicks: 600,
      endTicks: 2400
    },
    acceptance: {
      decision: 'accept',
      proposalId: 'proposal-o34',
      resolutionRevision: 3,
      restart: {
        acceptedRevision: 3,
        oldProcess: {
          pid: 10,
          ppid: 1,
          pgid: 2,
          command: '/x/TaskWraithStudioCompanion',
          expectedExecutable: '/x/TaskWraithStudioCompanion'
        },
        replacement: {
          pid: 11,
          ppid: 1,
          pgid: 2,
          command: '/x/TaskWraithStudioCompanion',
          expectedExecutable: '/x/TaskWraithStudioCompanion'
        },
        hydrationOrder: [0, 1, 2],
        journalBefore: { revision: 3, sha256: 'e'.repeat(64), byteLength: 100 },
        journalAfter: { revision: 3, sha256: 'e'.repeat(64), byteLength: 100 },
        windowAbsence: {
          schemaVersion: 1,
          kind: 'taskwraith-studio-zero-hydration-window',
          exactPid: 11,
          visibleWindowCount: 0
        },
        supervisor: { beforeSha256: 'f'.repeat(64), afterSha256: 'f'.repeat(64) }
      },
      committedSequence: [
        {
          assetId: ids.primary,
          position: { n: 0, d: 600 },
          duration: { n: 1200, d: 600 },
          sourceIn: { n: 0, d: 600 }
        },
        {
          assetId: ids.secondary,
          position: { n: 1200, d: 600 },
          duration: { n: 600, d: 600 },
          sourceIn: { n: 0, d: 600 }
        }
      ]
    },
    playbackCrossing: {
      route: 'review',
      viewerTimescale: 600,
      sharedClock: {
        ok: true,
        sourceBeforeTicks: 10,
        sourceAfterTicks: 11,
        reviewBeforeTicks: 11,
        reviewAfterTicks: 10
      },
      cutTicks: 1200,
      samples: [
        {
          assetId: ids.primary,
          positionTicks: 1190,
          pixels: decodedPixel(ids.primary, 1190 / 600, '/tmp/primary-materialized.mp4')
        },
        {
          assetId: ids.secondary,
          positionTicks: 1200,
          pixels: decodedPixel(ids.secondary, 0, '/tmp/secondary-materialized.mp4')
        }
      ]
    },
    routeTransitions: transitions
  }
}

async function finalReceiptFixture(launchMode = 'launch-services') {
  const root = await temporaryRoot()
  const plan = {
    artifactRoot: root,
    instanceId: 'o34adopt01',
    repoRoot: path.resolve(__dirname, '..')
  }
  const launchServicesProof =
    launchMode === 'launch-services'
      ? {
          launchServicesExecutable: '/exact/Studio.app/Contents/MacOS/Studio',
          launchServicesAdoption: {
            requestId: 'review-adoption',
            pid: 20,
            pgid: 20,
            executable: '/exact/Studio.app/Contents/MacOS/Studio',
            startedAt: 'Thu Sep 24 02:00:00 2026',
            acknowledged: true,
            groupExitVerified: true
          }
        }
      : {}
  const terminal = {
    type: 'terminal',
    status: 'reaped',
    reason: 'owner_requested',
    childPid: 10,
    childPgid: 10,
    groupExitVerified: true,
    detachedGroupExitVerified: true,
    detachedProcessGroups:
      launchMode === 'launch-services'
        ? [{ pgid: 20, evidencePids: [20], memberPids: [20, 21] }]
        : [],
    ...launchServicesProof
  }
  const watchdog = {
    schemaVersion: 2,
    kind: 'taskwraith-studio-acceptance-watchdog',
    instanceId: plan.instanceId,
    ...structuredClone(terminal),
    lostOwnershipGroups: [],
    mixedOwnershipGroups: [],
    protectedInstalledGroups: []
  }
  const result = {
    plan: {
      evidencePath: path.join(root, 'studio-acceptance-evidence.json'),
      receiptPath: path.join(root, 'watchdog-receipt.json')
    },
    evidence: {
      schemaVersion: 1,
      kind: 'taskwraith-studio-in-product-acceptance',
      instanceId: plan.instanceId,
      ok: true,
      journey: goodEvidence(),
      electron: {
        launchMode,
        pid: launchMode === 'launch-services' ? 20 : 10,
        pgid: launchMode === 'launch-services' ? 20 : 10,
        launcherPid: launchMode === 'launch-services' ? 10 : null,
        launcherPgid: launchMode === 'launch-services' ? 10 : null
      },
      watchdogTerminal: terminal
    }
  }
  const fixture = async (variant: string) => {
    const outputPath = path.join(root, `${variant}.mp4`)
    const manifestPath = path.join(root, `${variant}.json`)
    const bytes = Buffer.from(`${variant} fixture`)
    const outputSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    await fsPromises.writeFile(outputPath, bytes)
    await fsPromises.writeFile(
      manifestPath,
      JSON.stringify({ outputSha256, outputByteLength: bytes.length })
    )
    return { outputPath, manifestPath, outputSha256 }
  }
  const fixtures = {
    assets: { primary: await fixture('primary'), secondary: await fixture('secondary') }
  }
  return {
    watchdog,
    terminal,
    electron: result.evidence.electron,
    async seal(mutateDisk?: (disk: Record<string, any>) => void) {
      const disk = structuredClone(result.evidence)
      mutateDisk?.(disk)
      await fsPromises.writeFile(result.plan.evidencePath, JSON.stringify(disk))
      await fsPromises.writeFile(result.plan.receiptPath, JSON.stringify(watchdog))
      return runner.writeRunnerEvidence(plan, result, fixtures, {})
    }
  }
}

describe('Outcome 3/4 adoption receipt joins', () => {
  it.each([
    'missing terminal',
    'stripped adoption',
    'stripped executable',
    'requestId',
    'startedAt',
    'executable',
    'missing electron',
    'electron pid',
    'electron metadata'
  ])(
    'rejects disk-harness-only %s while returned and watchdog proofs remain complete',
    async (damage) => {
      const fixture = await finalReceiptFixture()
      await expect(
        fixture.seal((disk) => {
          if (damage === 'missing terminal') delete disk.watchdogTerminal
          else if (damage === 'stripped adoption')
            delete disk.watchdogTerminal.launchServicesAdoption
          else if (damage === 'stripped executable')
            delete disk.watchdogTerminal.launchServicesExecutable
          else if (damage === 'missing electron') delete disk.electron
          else if (damage === 'electron pid') disk.electron.pid += 1
          else if (damage === 'electron metadata') disk.electron.remoteDebuggingPort = 9555
          else disk.watchdogTerminal.launchServicesAdoption[damage] = 'contradictory-disk-proof'
        })
      ).rejects.toThrow(/disk harness (Electron|watchdog)/)
    }
  )

  it('rejects a disk-harness-only direct terminal contradiction', async () => {
    const fixture = await finalReceiptFixture('direct')
    await expect(
      fixture.seal((disk) => {
        disk.watchdogTerminal.childPid += 1
      })
    ).rejects.toThrow(/disk harness watchdog/)
  })

  it.each(['direct', 'launch-services'])(
    'seals the complete %s receipt projection',
    async (mode) => {
      const fixture = await finalReceiptFixture(mode)
      const sealed = await fixture.seal()
      const promoted = sealed.evidence.harness.watchdogTerminal
      for (const key of ['launchServicesExecutable', 'launchServicesAdoption']) {
        if (mode === 'direct') expect(promoted).not.toHaveProperty(key)
        else expect(promoted[key]).toEqual(fixture.watchdog[key])
      }
      const disk = JSON.parse(await fsPromises.readFile(sealed.path, 'utf8'))
      expect(disk.harness.watchdogTerminal).toEqual(promoted)
    }
  )

  it.each(['both', 'disk', 'terminal'])(
    'rejects stripped LaunchServices adoption from %s receipts',
    async (side) => {
      const fixture = await finalReceiptFixture()
      for (const receipt of [
        ...(side !== 'terminal' ? [fixture.watchdog] : []),
        ...(side !== 'disk' ? [fixture.terminal] : [])
      ]) {
        delete receipt.launchServicesExecutable
        delete receipt.launchServicesAdoption
      }
      await expect(fixture.seal()).rejects.toThrow(/adoption/)
    }
  )

  it.each(['requestId', 'startedAt', 'executable', 'pid', 'pgid'] as const)(
    'rejects a mismatched adoption %s despite otherwise reaped receipts',
    async (field) => {
      const fixture = await finalReceiptFixture()
      const adoption = fixture.terminal.launchServicesAdoption!
      if (field === 'requestId') adoption.requestId = 'another-request'
      else if (field === 'startedAt') adoption.startedAt = 'Thu Sep 24 02:00:01 2026'
      else if (field === 'executable')
        adoption.executable = fixture.terminal.launchServicesExecutable = '/other/Studio'
      else if (field === 'pid') fixture.electron.pid = 21
      else {
        for (const receipt of [fixture.watchdog, fixture.terminal]) {
          receipt.launchServicesAdoption!.pgid = 30
          receipt.detachedProcessGroups.push({ pgid: 30, evidencePids: [20], memberPids: [20] })
        }
      }
      await expect(fixture.seal()).rejects.toThrow(/adoption/)
    }
  )
})

describe('Outcome 3/4 review-route plan and fixture contract', () => {
  it('is plan-only by default and does not require a live adapter', async () => {
    const result = await runner.runReviewRouteAcceptance({
      instanceId: 'o34plan01',
      artifactRoot:
        '/Users/chrisizatt/Documents/AGBench-studio-continuation/.local-only/taskwraith-studio/acceptance/o34plan01',
      launch: false
    })
    expect(result).toMatchObject({
      launched: false,
      kind: 'taskwraith-studio-review-route-lifecycle-plan',
      safety: { planOnlyByDefault: true, exactReviewAdaptersRequired: true }
    })
  })

  it('requires all explicit launch interlocks', async () => {
    const root =
      '/Users/chrisizatt/Documents/AGBench-studio-continuation/.local-only/taskwraith-studio/acceptance/o34live01'
    await expect(
      runner.runReviewRouteAcceptance({
        instanceId: 'o34live01',
        artifactRoot: root,
        launch: true,
        acceptLaunch: true,
        ownerConfirmsOrphansCleared: false,
        packagedExecutablePath: '/tmp/TaskWraith Debug.app/Contents/MacOS/TaskWraith Debug'
      })
    ).rejects.toThrow(/owner-confirms-existing-orphans-cleared/)
    expect(() =>
      runner.normalizeOptions({
        instanceId: 'o34live02',
        artifactRoot:
          '/Users/chrisizatt/Documents/AGBench-studio-continuation/.local-only/taskwraith-studio/acceptance/o34live02',
        launch: true,
        acceptLaunch: true,
        ownerConfirmsOrphansCleared: true,
        packagedExecutablePath: null
      })
    ).toThrow(/packaged-executable/)
  })

  it('rejects caller-shaped live adapter evidence outside the explicit test seam', async () => {
    await expect(
      runner.runReviewRouteAcceptance(
        {
          instanceId: 'o34live03',
          artifactRoot:
            '/Users/chrisizatt/Documents/AGBench-studio-continuation/.local-only/taskwraith-studio/acceptance/o34live03',
          launch: true,
          acceptLaunch: true,
          ownerConfirmsOrphansCleared: true,
          packagedExecutablePath: '/tmp/TaskWraith Debug.app/Contents/MacOS/TaskWraith Debug'
        },
        { generateFixtures: async () => ({}) }
      )
    ).rejects.toThrow(/restricted to the explicit test-only seam/)
  })

  it('builds distinct deterministic no-audio fixture commands', () => {
    const primary = runner.buildFixtureCommand({
      outputPath: '/tmp/review/primary.mp4',
      variant: 'primary',
      durationSeconds: 8,
      ffmpegPath: '/virtual/ffmpeg'
    })
    const secondary = runner.buildFixtureCommand({
      outputPath: '/tmp/review/secondary.mp4',
      variant: 'secondary',
      durationSeconds: 8,
      ffmpegPath: '/virtual/ffmpeg'
    })
    expect(primary).toContain('testsrc2=size=640x360:rate=30')
    expect(secondary).toContain('smptebars=size=640x360:rate=30')
    expect(primary).toContain('-n')
    expect(primary).not.toContain('-y')
    expect(primary.at(-1)).not.toBe(secondary.at(-1))
  })

  it('generates two distinct fixtures through hermetic tool adapters', async () => {
    const root = await temporaryRoot()
    const fixture = await runner.generateReviewFixtures(
      { artifactRoot: root, durationSeconds: 2 },
      {
        resolveMediaTool: (name: string) => `/virtual/${name}`,
        realpathTool: async (filePath: string) => filePath,
        execFile: async (command: string, args: string[]) => {
          if (args[0] === '-version') return { stdout: `${command} version test` }
          if (command === '/virtual/ffmpeg') {
            await fsPromises.writeFile(
              args.at(-1) as string,
              args.at(-1)?.includes('secondary') ? 'secondary' : 'primary'
            )
          }
          return {
            stdout:
              command === '/virtual/ffprobe'
                ? '{"streams":[{"codec_type":"video","width":640,"height":360,"r_frame_rate":"30/1","nb_read_frames":"60","duration":"2.000000"}],"format":{"duration":"2.000000"}}'
                : ''
          }
        }
      }
    )
    expect(fixture.assets.primary.outputSha256).not.toBe(fixture.assets.secondary.outputSha256)
    expect(fixture.assets.primary.probe.frameCount).toBe(60)
  })

  it('resizes both live speech variants before probing while preserving duration and copied audio', async () => {
    const root = await temporaryRoot()
    const basePath = path.join(root, 'base.mp4')
    await fsPromises.writeFile(basePath, 'base')
    const convertedVariants: string[] = []
    const fixture = await runner.generateReviewSpeechFixtures(
      { artifactRoot: root, durationSeconds: 8 },
      {
        generateSpeechFixture: async () => ({ outputPath: basePath }),
        realpathTool: async (filePath: string) => filePath,
        execFile: async (command: string, args: string[]) => {
          if (command.includes('ffmpeg')) {
            const variant = args.at(-1)?.includes('secondary') ? 'secondary' : 'primary'
            const filter = args[args.indexOf('-vf') + 1]
            expect(filter).toBe(
              variant === 'secondary'
                ? 'scale=640:360:flags=lanczos,hue=h=45:s=1'
                : 'scale=640:360:flags=lanczos'
            )
            expect(args[args.indexOf('-i') + 1]).toBe(basePath)
            expect(args[args.indexOf('-c:a') + 1]).toBe('copy')
            expect(args[args.indexOf('-t') + 1]).toBe('8')
            expect(args.filter((_, index) => args[index - 1] === '-map')).toEqual([
              '0:v:0',
              '0:a:0'
            ])
            expect(args).not.toContain('-r')
            expect(args).not.toContain('-af')
            convertedVariants.push(variant)
            await fsPromises.writeFile(args.at(-1) as string, `${variant}-video-audio`)
            return { stdout: '', stderr: '' }
          }
          return {
            stdout: JSON.stringify({
              streams: [
                {
                  codec_type: 'video',
                  width: 640,
                  height: 360,
                  r_frame_rate: '30/1',
                  nb_read_frames: '240',
                  duration: '8.000000'
                },
                { codec_type: 'audio', duration: '8.000000' }
              ],
              format: { duration: '8.000000' }
            }),
            stderr: ''
          }
        }
      }
    )
    expect(convertedVariants).toEqual(['primary', 'secondary'])
    expect(fixture.assets.primary.durationSeconds).toBe(8)
    expect(fixture.assets.secondary.probe).toMatchObject({
      videoStreamCount: 1,
      audioStreamCount: 1,
      frameCount: 240,
      durationSeconds: 8
    })
    expect(fixture.assets.secondary.ffmpegExecution).toMatchObject({ exitCode: 0 })
    expect(fixture.assets.secondary.ffprobeExecution).toMatchObject({ exitCode: 0 })
    expect(fixture.assets.primary.outputSha256).not.toBe(fixture.assets.secondary.outputSha256)
  })
})

describe('Outcome 3/4 fail-closed evidence validation', () => {
  it('keeps rational equivalence exact and refuses non-integral viewer ticks', () => {
    expect(runner.sameRational({ n: 1, d: 3 }, { n: 2, d: 6 })).toBe(true)
    expect(runner.addRational({ n: 1, d: 3 }, { n: 1, d: 6 })).toEqual({ n: 1, d: 2 })
    expect(runner.subtractRational({ n: 2, d: 3 }, { n: 1, d: 6 })).toEqual({ n: 1, d: 2 })
    expect(runner.rationalToTicks({ n: 1, d: 2 }, 600)).toBe(300)
    expect(() => runner.rationalToTicks({ n: 1, d: 3 }, 1000)).toThrow(/exact viewer tick/)
  })

  it('executes exact restart custody with ordered hydration and unchanged journal bytes', async () => {
    const root = await temporaryRoot()
    const state = path.join(root, 'state')
    await fsPromises.mkdir(state)
    await fsPromises.writeFile(
      path.join(state, 'studio-project.journal.jsonl'),
      `${JSON.stringify({ format: 'taskwraith-studio-journal', v: 1, revision: 3, op: { type: 'resolve_proposal' } })}\n`
    )
    const bundlePath = path.join(root, 'supervisor.js')
    await fsPromises.writeFile(bundlePath, 'compiled supervisor')
    let probeClosed = false
    let inspectorClosed = false
    const document = { tracks: [{ trackId: 'V1', kind: 'video', items: [] }] }
    const hits = [
      {
        kind: 'response',
        method: 'studio/hello',
        childPid: 11,
        response: { result: { revision: 3 } }
      },
      {
        kind: 'response',
        method: 'studio/getDocument',
        childPid: 11,
        response: { result: { revision: 3, document } }
      },
      { kind: 'hydration', method: 'studio/getDocument', childPid: 11, revision: 3 }
    ]
    const restarted = await runner.restartAcceptedCompanion({
      plan: {
        repoRoot: root,
        studioStateDirectory: state,
        spawnPlan: { mainInspectorPort: 1 }
      },
      currentTarget: {
        companion: { pid: 10, ppid: 1, pgid: 2, command: '/x' },
        electronPgid: 2
      },
      acceptAndWaitResolution: async () => ({ revision: 3 }),
      journeyAdapters: {
        discoverMainInspectorUrl: async () => ({ webSocketDebuggerUrl: 'ws://test' }),
        attachMainInspector: async () => ({
          close: () => {
            inspectorClosed = true
          }
        }),
        locateSupervisorBundle: () => ({ bundlePath, responseLine: 1, hydrationLine: 2 }),
        armSupervisorProbe: async () => ({
          waitForHits: async (predicate: (value: unknown[]) => unknown) => predicate(hits),
          close: async () => {
            probeClosed = true
          }
        }),
        exactCompanionProcess: (companion: { pid: number }) => ({
          pid: companion.pid,
          ppid: 1,
          pgid: 2,
          command: '/x',
          expectedExecutable: '/x'
        }),
        signal: () => undefined,
        isProcessAlive: async () => false,
        findStudioCompanion: async () => ({ pid: 11, ppid: 1, pgid: 2, command: '/x' }),
        assertNoHydrationWindow: async () => ({
          schemaVersion: 1,
          kind: 'taskwraith-studio-zero-hydration-window',
          exactPid: 11,
          visibleWindowCount: 0
        })
      }
    })
    expect(restarted.document).toEqual(document)
    expect(restarted.custody).toMatchObject({
      acceptedRevision: 3,
      hydrationOrder: [0, 1, 2],
      windowAbsence: { visibleWindowCount: 0 }
    })
    expect(restarted.custody.journalBefore.sha256).toBe(restarted.custody.journalAfter.sha256)
    expect(probeClosed).toBe(true)
    expect(inspectorClosed).toBe(true)
  })

  it('always closes the inspector even when supervisor-probe cleanup throws', async () => {
    let inspectorClosed = false
    await expect(
      runner.closeRestartInspection(
        {
          close: async () => {
            throw new Error('probe close failed')
          }
        },
        {
          close: async () => {
            inspectorClosed = true
          }
        }
      )
    ).rejects.toThrow(/probe close failed/)
    expect(inspectorClosed).toBe(true)
  })

  it('derives route setup from observed selection without selected-to-selected presses', () => {
    const sourceWorkspace = {
      sourceRoute: { value: 'selected' },
      timelineRoute: { value: 'not selected' },
      sourceHost: { visible: true },
      timelineHost: { visible: false }
    }
    const timelineWorkspace = {
      sourceRoute: { value: 'not selected' },
      timelineRoute: { value: 'selected' },
      sourceHost: { visible: false },
      timelineHost: { visible: true }
    }
    expect(runner.selectedWorkspaceRoute(sourceWorkspace)).toBe('source')
    expect(runner.selectedWorkspaceRoute(timelineWorkspace)).toBe('timeline')
    expect(runner.routeHostVisible(sourceWorkspace, 'source')).toBe(true)
    expect(runner.routeHostVisible(sourceWorkspace, 'timeline')).toBe(false)
    expect(runner.routeHostVisible(timelineWorkspace, 'timeline')).toBe(true)
    expect(
      runner.selectedWorkspaceRoute({
        ...sourceWorkspace,
        timelineRoute: { value: 'selected' }
      })
    ).toBe('source')
    expect(() =>
      runner.selectedWorkspaceRoute({
        sourceRoute: { value: 'selected' },
        timelineRoute: { value: 'selected' },
        sourceHost: { visible: true },
        timelineHost: { visible: true }
      })
    ).toThrow(/exactly one visible host/)
  })

  it('rejects unreaped or changed source/package custody at the harness boundary', () => {
    const result = {
      evidence: {
        ok: true,
        kind: 'taskwraith-studio-in-product-acceptance',
        watchdogTerminal: {
          status: 'running',
          groupExitVerified: false,
          detachedGroupExitVerified: false
        },
        custodyBefore: { sourceDigest: 'a' },
        custodyAfter: { sourceDigest: 'b' },
        packagedExecutionBefore: { digest: 'a' },
        packagedExecutionAfter: { digest: 'a' }
      }
    }
    expect(() => runner.assertHarnessBoundary(result)).toThrow(/reaping/)
    result.evidence.watchdogTerminal = {
      status: 'reaped',
      groupExitVerified: true,
      detachedGroupExitVerified: true
    }
    expect(() => runner.assertHarnessBoundary(result)).toThrow(/source custody changed/)
  })

  it('accepts a complete exact review/route receipt', () => {
    expect(runner.validateReviewRouteJourney(goodEvidence(), fixtureAssets())).toMatchObject({
      normalized: { primaryId: assetIds().primary, secondaryId: assetIds().secondary }
    })
  })

  it('rejects a proposal aimed at the wrong asset', () => {
    const evidence = goodEvidence()
    evidence.proposal.op.assetId = assetIds().primary
    expect(() => runner.validateReviewRouteJourney(evidence, fixtureAssets())).toThrow(
      /secondary asset/
    )
  })

  it('rejects Current/Proposed proofs built from the baseline or identical captures', () => {
    const baseline = 'a'.repeat(64)
    const currentWithGhost = 'b'.repeat(64)
    const proposedWithGhost = 'c'.repeat(64)
    // The original defect: the version comparison ran against the pre-ghost
    // baseline, so the ghost alone made "Current vs Proposed" look distinct.
    const staleBaseline = goodEvidence()
    staleBaseline.proposal.currentPixels = ghostPixel(baseline, proposedWithGhost)
    staleBaseline.proposal.proposedPixels = ghostPixel(proposedWithGhost, baseline)
    expect(() => runner.validateReviewRouteJourney(staleBaseline, fixtureAssets())).toThrow(
      /post-proposal Current capture/
    )
    const identical = goodEvidence()
    identical.proposal.currentPixels = ghostPixel(currentWithGhost, currentWithGhost)
    identical.proposal.proposedPixels = ghostPixel(currentWithGhost, currentWithGhost)
    expect(() => runner.validateReviewRouteJourney(identical, fixtureAssets())).toThrow(
      /same two version captures/
    )
    const unpaired = goodEvidence()
    unpaired.proposal.proposedPixels = ghostPixel('d'.repeat(64), currentWithGhost)
    expect(() => runner.validateReviewRouteJourney(unpaired, fixtureAssets())).toThrow(
      /same two version captures/
    )
  })

  it('keeps ghost-difference and decoded-material pixel schemas non-interchangeable', () => {
    const forgedGhost = goodEvidence()
    forgedGhost.proposal.ghostPixels = decodedPixel()
    expect(() => runner.validateReviewRouteJourney(forgedGhost, fixtureAssets())).toThrow(
      /ghost-difference/
    )
    const forgedMaterial = goodEvidence()
    forgedMaterial.playbackCrossing.samples[0].pixels = ghostPixel()
    expect(() => runner.validateReviewRouteJourney(forgedMaterial, fixtureAssets())).toThrow(
      /decoded-material/
    )
    const missingExecution = goodEvidence()
    delete missingExecution.playbackCrossing.samples[0].pixels.ffmpegExecution
    expect(() => runner.validateReviewRouteJourney(missingExecution, fixtureAssets())).toThrow(
      /decoded-material proof keys/
    )
    const wrongPath = goodEvidence()
    wrongPath.playbackCrossing.samples[0].pixels.sourceAssetPath = '/tmp/unrelated.mp4'
    expect(() => runner.validateReviewRouteJourney(wrongPath, fixtureAssets())).toThrow(
      /decoded-material pixels|mapped to the wrong source assets/
    )
    const wrongCommand = goodEvidence()
    wrongCommand.playbackCrossing.samples[0].pixels.ffmpegExecution.args = ['forged']
    expect(() => runner.validateReviewRouteJourney(wrongCommand, fixtureAssets())).toThrow(
      /decoded-material pixels/
    )
    const missingMetrics = goodEvidence()
    delete missingMetrics.playbackCrossing.samples[0].pixels.comparison.metrics
    expect(() => runner.validateReviewRouteJourney(missingMetrics, fixtureAssets())).toThrow(
      /decoded-material pixels/
    )
  })

  it('rejects non-exact or incorrectly bounded review-loop endpoints', () => {
    const evidence = goodEvidence()
    evidence.reviewLoop.endpointObservation = 'HUD text'
    expect(() => runner.validateReviewRouteJourney(evidence, fixtureAssets())).toThrow(
      /exact accessibility/
    )
    const wrong = goodEvidence()
    wrong.reviewLoop.endTicks += 1
    expect(() => runner.validateReviewRouteJourney(wrong, fixtureAssets())).toThrow(/post-roll/)
  })

  it('rejects route no-ops, shared-clock drift, and hidden-resource retention', () => {
    const routeNoOp = goodEvidence()
    routeNoOp.routeTransitions[0].transition.to = 'source'
    expect(() => runner.validateReviewRouteJourney(routeNoOp, fixtureAssets())).toThrow(
      /route transition 0/
    )
    const clockDrift = goodEvidence()
    clockDrift.routeTransitions[1].sharedClock.toAfterTicks = 999
    expect(() => runner.validateReviewRouteJourney(clockDrift, fixtureAssets())).toThrow(
      /shared-clock positions/
    )
    const retained = goodEvidence()
    retained.routeTransitions[2].resources.hidden.routeOwnership.activeSourceCount = 1
    expect(() => runner.validateReviewRouteJourney(retained, fixtureAssets())).toThrow(
      /hidden-route resources/
    )
    const retainedSurface = goodEvidence()
    retainedSurface.routeTransitions[0].resources.hidden.routeOwnership.ioSurfaceIds = ['00000001']
    expect(() => runner.validateReviewRouteJourney(retainedSurface, fixtureAssets())).toThrow(
      /hidden-route resources/
    )
  })

  it('rejects missing committed multi-asset playback crossing', () => {
    const evidence = goodEvidence()
    evidence.playbackCrossing.samples[1].assetId = assetIds().primary
    expect(() => runner.validateReviewRouteJourney(evidence, fixtureAssets())).toThrow(
      /cross primary to secondary/
    )
  })

  it('rejects mutated restart order, journal, and supervisor custody', () => {
    for (const mutate of [
      (evidence: ReturnType<typeof goodEvidence>) => {
        evidence.acceptance.restart.hydrationOrder = [1, 0, 2]
      },
      (evidence: ReturnType<typeof goodEvidence>) => {
        evidence.acceptance.restart.journalAfter.sha256 = '0'.repeat(64)
      },
      (evidence: ReturnType<typeof goodEvidence>) => {
        evidence.acceptance.restart.supervisor.afterSha256 = '0'.repeat(64)
      },
      (evidence: ReturnType<typeof goodEvidence>) => {
        delete evidence.acceptance.restart.oldProcess.ppid
      },
      (evidence: ReturnType<typeof goodEvidence>) => {
        delete evidence.acceptance.restart.supervisor
      },
      (evidence: ReturnType<typeof goodEvidence>) => {
        delete evidence.acceptance.restart.journalBefore.sha256
        delete evidence.acceptance.restart.journalAfter.byteLength
      },
      (evidence: ReturnType<typeof goodEvidence>) => {
        evidence.acceptance.restart.windowAbsence.exactPid = 999
      }
    ]) {
      const evidence = goodEvidence()
      mutate(evidence)
      expect(() => runner.validateReviewRouteJourney(evidence, fixtureAssets())).toThrow(
        /restart custody/
      )
    }
  })

  it('rejects a disk harness journey mutated after promotion', async () => {
    const root = await temporaryRoot()
    const harnessPath = path.join(root, 'studio-acceptance-evidence.json')
    const watchdogPath = path.join(root, 'watchdog-receipt.json')
    await fsPromises.writeFile(
      harnessPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: 'taskwraith-studio-in-product-acceptance',
        ok: true,
        instanceId: 'o34disk01',
        journey: { mutated: true }
      })
    )
    await fsPromises.writeFile(
      watchdogPath,
      JSON.stringify({
        schemaVersion: 2,
        kind: 'taskwraith-studio-acceptance-watchdog',
        instanceId: 'o34disk01',
        status: 'reaped',
        reason: 'owner_requested',
        groupExitVerified: true,
        detachedGroupExitVerified: true,
        childPid: 10,
        childPgid: 10,
        detachedProcessGroups: [],
        lostOwnershipGroups: [],
        mixedOwnershipGroups: [],
        protectedInstalledGroups: []
      })
    )
    await expect(
      runner.writeRunnerEvidence(
        {
          artifactRoot: root,
          instanceId: 'o34disk01',
          repoRoot: '/Users/chrisizatt/Documents/AGBench-studio-continuation'
        },
        {
          plan: { evidencePath: harnessPath, receiptPath: watchdogPath },
          evidence: { journey: { mutated: false }, watchdogTerminal: {} }
        },
        { assets: {} },
        {}
      )
    ).rejects.toThrow(/does not exactly equal/)
  })

  async function driveDeterministicJourney(options: { proposedMatchesCurrent?: boolean } = {}) {
    const root = await temporaryRoot()
    const ids = assetIds()
    const screenshot = path.join(root, 'capture.png')
    await fsPromises.writeFile(screenshot, 'capture')
    // Distinct bytes per review capture so the comparison adapter can hash
    // exactly what the runner handed it, the way the harness hashes bytes.
    const capturePaths: Record<string, string> = {
      'review-current-before-ghost': path.join(root, 'review-current-before-ghost.png'),
      'review-current-with-ghost': path.join(root, 'review-current-with-ghost.png'),
      'review-proposed-with-ghost': path.join(root, 'review-proposed-with-ghost.png')
    }
    await fsPromises.writeFile(capturePaths['review-current-before-ghost'], 'current baseline')
    await fsPromises.writeFile(capturePaths['review-current-with-ghost'], 'current with ghost')
    await fsPromises.writeFile(
      capturePaths['review-proposed-with-ghost'],
      options.proposedMatchesCurrent ? 'current with ghost' : 'proposed with ghost'
    )
    const primaryAsset = { sha256: ids.primary, assetPath: path.join(root, 'primary.mp4') }
    const secondaryAsset = { sha256: ids.secondary, assetPath: path.join(root, 'secondary.mp4') }
    await fsPromises.writeFile(primaryAsset.assetPath, 'primary')
    await fsPromises.writeFile(secondaryAsset.assetPath, 'secondary')
    const fixtureValues = fixtureAssets()
    fixtureValues.primary.outputPath = primaryAsset.assetPath
    fixtureValues.secondary.outputPath = secondaryAsset.assetPath
    const fixtures = { assets: fixtureValues }
    const window = {
      pid: 10,
      visibleWindowCount: 1,
      windows: [
        {
          windowId: 1,
          title: 'TaskWraith Studio',
          bounds: { x: 0, y: 0, width: 1280, height: 832 }
        }
      ]
    }
    let activeRoute = 'source'
    let sourceSelected = true
    let timelineSelected = false
    let proposed = false
    let tick = 100
    const routePresses: Array<{ route: string; selectedAfter: boolean }> = []
    const routeSelectors: Array<{ name: string; selector: string; active: string }> = []
    const workspace = () => ({
      sourceRoute: { value: sourceSelected ? 'selected' : 'not selected' },
      timelineRoute: { value: timelineSelected ? 'selected' : 'not selected' },
      sourceHost: {
        visible: activeRoute === 'source',
        frame: { x: 0, y: 0, width: 640, height: 360 }
      },
      timelineHost: {
        visible: activeRoute === 'timeline',
        frame: { x: 0, y: 0, width: 640, height: 360 }
      },
      currentVersion: { value: proposed ? 'not selected' : 'selected' },
      proposedVersion: { value: proposed ? 'selected' : 'not selected' }
    })
    const primaryProposal = {
      revision: 2,
      op: {
        type: 'propose_edit',
        proposal: {
          proposalId: 'base-proposal',
          op: {
            type: 'insert_range',
            itemId: 'primary-item',
            assetId: ids.primary,
            sourceIn: { n: 0, d: 600 },
            sourceOut: { n: 1200, d: 600 },
            at: { n: 0, d: 600 }
          }
        }
      }
    }
    const secondaryProposal = {
      revision: 5,
      op: {
        type: 'propose_edit',
        proposal: {
          proposalId: 'secondary-proposal',
          op: {
            type: 'insert_range',
            itemId: 'secondary-item',
            assetId: ids.secondary,
            sourceIn: { n: 0, d: 600 },
            sourceOut: { n: 600, d: 600 },
            at: { n: 1200, d: 600 }
          }
        }
      }
    }
    const resolution = {
      revision: 6,
      op: {
        type: 'resolve_proposal',
        proposalId: 'secondary-proposal',
        decision: 'accept'
      }
    }
    const restartCustody = structuredClone(goodEvidence().acceptance.restart)
    restartCustody.acceptedRevision = 6
    restartCustody.journalBefore.revision = 6
    restartCustody.journalAfter.revision = 6
    const runUiDriver = async (
      _plan: unknown,
      _target: unknown,
      actions: Array<Record<string, any>>
    ) => ({
      actions: actions.map((action, index) => {
        if (action.type === 'press-workspace-route') {
          const selectedBefore = action.route === 'source' ? sourceSelected : timelineSelected
          expect(selectedBefore).not.toBe(action.selectedAfter)
          routePresses.push({ route: action.route, selectedAfter: action.selectedAfter })
          if (action.route === 'source') sourceSelected = action.selectedAfter
          else timelineSelected = action.selectedAfter
          if (action.selectedAfter) activeRoute = action.route
          else activeRoute = action.route === 'source' ? 'timeline' : 'source'
          return {
            index,
            type: action.type,
            accessibilityAction: 'AXPress',
            accessibilityIdentifier: `studio.workspace.route.${action.route}`,
            pairedAccessibilityIdentifier: `studio.workspace.route.${action.route === 'source' ? 'timeline' : 'source'}`,
            routeValueBefore: action.selectedAfter ? 'not selected' : 'selected',
            routeValueAfter: action.selectedAfter ? 'selected' : 'not selected',
            pairedRouteValueBefore: 'selected',
            pairedRouteValueAfter: 'selected'
          }
        }
        if (action.type === 'read-workspace')
          return { index, type: action.type, workspace: workspace() }
        if (action.type === 'read-transport-mutation')
          return {
            index,
            type: action.type,
            accessibilityValue:
              'tm1 kind=markOrLoop route=source preSrc=machine postSrc=machine host=0.000000 prevHost=- preAnchorT=0 preAnchorH=0.000000 prePos=0 preDur=4800 prePlay=0 preRate=0.000 postAnchorT=0 postAnchorH=0.000000 postPos=0 postDur=4800 postPlay=0 postRate=0.000 crossedDomain=0 clamped=0'
          }
        if (action.type === 'screenshot')
          return {
            index,
            type: action.type,
            screenshotPath: capturePaths[action.name] || screenshot
          }
        if (action.type === 'read-review-range')
          return {
            index,
            type: action.type,
            inPointTicks: 4200,
            outPointTicks: 7800,
            loopingRange: true
          }
        if (action.type === 'step-playhead-frame') {
          const before = tick
          tick += action.playheadStepFrames
          return {
            index,
            type: action.type,
            playheadTicksBefore: before,
            observedPlayheadTicks: tick
          }
        }
        if (action.type === 'key' && action.key === 'v') proposed = true
        return { index, ...action }
      })
    })
    const journey = await runner.defaultDriveReviewRouteJourney(
      {
        repoRoot: root,
        artifactRoot: root,
        transcriptTimeoutMs: 1_000,
        spawnPlan: { mainInspectorPort: 1, remoteDebuggingPort: 2 }
      },
      {
        asset: primaryAsset,
        companion: { pid: 10, ppid: 1, pgid: 2, command: '/x' },
        electronPgid: 2,
        window,
        fixtures
      },
      {
        driveBaseJourney: async () => ({
          accepted: { proposalId: 'base-proposal' },
          finalRevision: 3
        }),
        runUiDriver,
        waitForReviewWorkspace: async (
          _plan: unknown,
          _target: unknown,
          predicate: (value: Record<string, unknown>) => boolean
        ) => {
          const value = workspace()
          expect(predicate(value)).toBe(true)
          return { receipt: { actions: [] }, workspace: value }
        },
        waitForStudioJournalOperation: async (_plan: unknown, criteria: { type: string }) =>
          criteria.type === 'set_transcript'
            ? { revision: 4 }
            : criteria.type === 'propose_edit'
              ? secondaryProposal
              : resolution,
        readStudioJournalOperations: async () => [primaryProposal],
        compareStudioJourneyCaptures: (beforePath: string, afterPath: string) => {
          const before = fs.readFileSync(beforePath)
          const after = fs.readFileSync(afterPath)
          return {
            ok: !before.equals(after),
            region: 'review-host',
            beforeSha256: crypto.createHash('sha256').update(before).digest('hex'),
            afterSha256: crypto.createHash('sha256').update(after).digest('hex')
          }
        },
        restartAcceptedCompanion: async (options: {
          acceptAndWaitResolution: () => Promise<unknown>
        }) => {
          await options.acceptAndWaitResolution()
          activeRoute = 'source'
          sourceSelected = true
          timelineSelected = false
          proposed = false
          return {
            resolution,
            replacement: { pid: 11, ppid: 1, pgid: 2, command: '/x' },
            document: {
              tracks: [
                {
                  trackId: 'V1',
                  kind: 'video',
                  items: [
                    {
                      itemId: 'primary-item',
                      assetId: ids.primary,
                      position: { n: 0, d: 600 },
                      duration: { n: 1200, d: 600 },
                      sourceIn: { n: 0, d: 600 },
                      sourceOut: { n: 1200, d: 600 }
                    },
                    {
                      itemId: 'secondary-item',
                      assetId: ids.secondary,
                      position: { n: 1200, d: 600 },
                      duration: { n: 600, d: 600 },
                      sourceIn: { n: 0, d: 600 },
                      sourceOut: { n: 600, d: 600 }
                    }
                  ]
                }
              ]
            },
            custody: restartCustody
          }
        },
        attachRenderer: async () => ({ close: () => undefined }),
        invokeAuthorizedStudioOpen: async () => undefined,
        waitForSourceWindow: async () => window,
        compareCrossingReference: async (
          _receipt: unknown,
          assetId: string,
          assetPath: string,
          sourcePtsSeconds: number
        ) => decodedPixel(assetId, sourcePtsSeconds, assetPath),
        ocrScreenshot: () => ({
          texts: ['00:00:01.000', 'PAUSE'],
          stdoutSha256: 'a'.repeat(64)
        }),
        hudContainsAsset: (_hud: unknown, assetId: string) => ({
          matched: true,
          assetId,
          distance: 0
        }),
        readRouteObservation: async (
          _plan: unknown,
          _target: unknown,
          _name: string,
          _adapters: unknown,
          selector = activeRoute === 'timeline' ? 'review' : 'source',
          expectedActive = selector
        ) => {
          routeSelectors.push({ name: _name, selector, active: expectedActive })
          activeRoute = expectedActive === 'review' ? 'timeline' : expectedActive
          const hidden = selector !== expectedActive
          return {
            workspace: workspace(),
            resource: resource(
              hidden ? 0 : 2,
              hidden ? 0 : 1,
              selector === 'review' ? 'timeline' : 'source'
            )
          }
        }
      },
      { secondaryAsset, fixtures, openAsset: async () => undefined }
    )
    return { journey, fixtures, routePresses, routeSelectors }
  }

  it('executes the default review journey through exact deterministic adapters', async () => {
    const { journey, fixtures, routePresses, routeSelectors } = await driveDeterministicJourney()
    expect(runner.validateReviewRouteJourney(journey, fixtures.assets)).toMatchObject({
      acceptance: { resolutionRevision: 6 }
    })
    const proposal = journey.proposal
    // ghostPixels keeps the baseline -> Current-with-ghost evidence; the two
    // version proofs share the post-proposal Current capture and mirror each other.
    expect(proposal.currentPixels.captureSha256).toBe(proposal.ghostPixels.counterpartSha256)
    expect(proposal.currentPixels.captureSha256).not.toBe(proposal.ghostPixels.captureSha256)
    expect(proposal.proposedPixels.captureSha256).toBe(proposal.currentPixels.counterpartSha256)
    expect(proposal.proposedPixels.counterpartSha256).toBe(proposal.currentPixels.captureSha256)
    expect(routePresses.some((press) => press.selectedAfter === true)).toBe(true)
    expect(
      routeSelectors
        .filter((entry) => entry.name.includes('-hidden'))
        .every((entry) => entry.selector !== entry.active)
    ).toBe(true)
  })

  it('rejects Proposed pixels identical to post-proposal Current despite a visible ghost', async () => {
    // Baseline differs from both later captures (the ghost is real), but
    // switching Current -> Proposed changes nothing. Only a comparison rooted in
    // the post-proposal Current capture can see that.
    await expect(driveDeterministicJourney({ proposedMatchesCurrent: true })).rejects.toThrow(
      /Current\/Proposed review pixels are not distinct/
    )
  })
})
