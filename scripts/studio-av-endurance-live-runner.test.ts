import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  parseLiveCli,
  normalizeRunOptions,
  requireTerminalBackgroundObservation,
  runLiveAcceptance,
  runOutcome5Journey,
  validatePostStopPausedState
} = require('./studio-av-endurance-live-runner.cjs') as {
  parseLiveCli: (argv: string[]) => Record<string, any>
  normalizeRunOptions: (options?: Record<string, any>) => Record<string, any>
  requireTerminalBackgroundObservation: (
    snapshot: Record<string, any>,
    targetPid: number
  ) => Record<string, any>
  runLiveAcceptance: (options: Record<string, any>, adapters: Record<string, any>) => Promise<any>
  runOutcome5Journey: (
    plan: Record<string, any>,
    target: Record<string, any>,
    adapters: Record<string, any>
  ) => Promise<any>
  validatePostStopPausedState: (
    hud: Record<string, any>,
    assetId: string,
    census: Record<string, any>,
    expectedPts: number,
    index: number
  ) => Record<string, any>
}
const { hudAssetIdentityToken } = require('./studio-acceptance-session.cjs') as {
  hudAssetIdentityToken: (assetId: string) => string
}

const ASSET_ID = 'rdQM2RCZQARUViCxHpzBJ9TQEqbdFfDhCHxs5UNMZTU'
const CURRENT =
  'avc1 ts=30000 fd=1000 pf=0 ap=0 err=0 errms=0.000 win=30000 winms=0.030 drawn=1 expl=not_explained'
const PEAK = 'av1 pf=0 ap=0 err=0 errms=0.000 win=30000 winms=0.030 drawn=1 expl=not_explained'
const BOUNDS = { x: 0, y: 0, width: 320, height: 180 }
const HOST_FRAME = { x: 1, y: 1, width: 318, height: 178 }

function root(label: string) {
  return mkdtempSync(path.join(os.tmpdir(), `taskwraith-live-${label}-`))
}

function fakeJourneyAdapters(log: string[], finalTerminalPaused = true) {
  const resource = {
    ps: { rssKilobytes: 500_000 },
    physicalFootprintBytes: 400_000_000,
    mallocAllocatedBytes: 100_000_000,
    residentBytes: 512_000_000,
    productSurfaceIds: ['0x2A'],
    mappedRegionIdentities: ['region']
  }
  const audio = {
    durationSeconds: 2,
    elapsedSeconds: 2,
    sampleBufferCount: 10,
    frameCount: 96_000,
    sampleValueCount: 192_000,
    sampleRate: 48_000,
    channelCount: 2,
    rms: 0.2,
    peak: 0.5,
    nonSilentFraction: 1,
    defaultOutputDevice: { id: 1, name: 'Output', uid: 'output', nominalSampleRate: 48_000 }
  }
  const silence = { ...audio, rms: 0.0001, peak: 0.002, nonSilentFraction: 0 }
  return {
    windowBounds: () => BOUNDS,
    waitForPausedMediaReadiness: async () => {
      log.push('readiness')
      return { observed: { state: 'PAUSE', contentPtsSeconds: 0 } }
    },
    pressPlaybackTransition: async (_plan: any, _target: any, before: string, after: string) => {
      log.push(`${before}->${after}`)
      return { inputDelivery: 'background-observation-only', actions: [{ type: 'press-playback' }] }
    },
    focusSnapshot: (targetPid: number) => ({
      frontmostPid: 1,
      frontmostBundleIdentifier: 'com.openai.codex',
      targetPid,
      targetIsActive: false,
      cursorX: 10,
      cursorY: 20
    }),
    assertSourceWindowFocusIsolation: () => ({ ok: true }),
    prepareAvEnduranceSourceEvidence: async () => {
      log.push('census')
      return {
        sourcePtsCensus: {
          values: Array.from({ length: 18_001 }, (_, index) => index / 30),
          count: 18_001
        }
      }
    },
    waitForFreshRawPlayableSample: async (
      _plan: any,
      _target: any,
      _census: any,
      _bounds: any,
      index: number
    ) => {
      log.push(`sample-${index}`)
      return {
        index,
        sourceHostFrame: HOST_FRAME,
        capture: {
          path: `/tmp/live-${index}.png`,
          sha256: `${String(index).padStart(2, '0')}${'a'.repeat(62)}`
        },
        reference: {
          path: `/tmp/reference-${index}.png`,
          sha256: `${String(index).padStart(2, '0')}${'b'.repeat(62)}`
        },
        hud: { observations: [`sample-${index}`] },
        observed: {
          state: 'PLAY',
          contentPtsSeconds: index * 30,
          assetMatch: { matched: true, distance: 0, assetId: ASSET_ID },
          diagnostics: { droppedFrames: 0 }
        },
        materialPixels: { registration: { logicalHudOverlayHeight: 118 } }
      }
    },
    captureTerminalSample: async (
      _plan: any,
      _target: any,
      _census: any,
      _bounds: any,
      index: number
    ) => {
      log.push(`terminal-${index}`)
      return {
        index,
        sourceHostFrame: HOST_FRAME,
        capture: {
          path: `/tmp/live-${index}.png`,
          sha256: `${String(index).padStart(2, '0')}${'a'.repeat(62)}`
        },
        reference: {
          path: `/tmp/reference-${index}.png`,
          sha256: `${String(index).padStart(2, '0')}${'b'.repeat(62)}`
        },
        hud: { observations: [`sample-${index}`] },
        terminalPaused: finalTerminalPaused,
        observed: {
          state: finalTerminalPaused ? 'PAUSE' : 'PLAY',
          contentPtsSeconds: index * 30,
          assetMatch: { matched: true, distance: 0, assetId: ASSET_ID },
          diagnostics: { droppedFrames: 0 }
        },
        materialPixels: { registration: { logicalHudOverlayHeight: 118 } }
      }
    },
    readSampleUi: async (
      _plan: any,
      _target: any,
      _bounds: any,
      index: number,
      options: Record<string, any>
    ) => {
      log.push(options.includeAudio ? `ui-audio-${index}` : `ui-${index}`)
      return {
        workspaceObservation: { sourceHostFrame: HOST_FRAME },
        avSync: {
          current: CURRENT,
          peak: PEAK,
          resourceDetailValue: 'res1 dec=1 cap=3 surf=1 ids=0000002A',
          resourceMatchCount: 1
        },
        routeHealth: options.includeAudio ? { id: 1 } : undefined,
        audioProbe: options.includeAudio ? (index === 20 ? silence : audio) : undefined,
        pausedState: options.requirePausedState
          ? {
              observed: { state: 'PAUSE', contentPtsSeconds: 599.966667 },
              exactSourcePtsSeconds: 599.966667
            }
          : undefined
      }
    },
    resourceSample: async () => resource,
    runAvEnduranceAcceptance: async (
      options: Record<string, any>,
      avAdapters: Record<string, any>
    ) => {
      expect(options.expectedAssetId).toBe(ASSET_ID)
      expect(options.sourceAssetPath).toMatch(/owner-600s\.mp4$/)
      expect(avAdapters).not.toHaveProperty('monotonicNow')
      const joinedSamples = []
      for (let index = 0; index < 21; index += 1) {
        const sample = await avAdapters.sampleAt({
          index,
          plannedElapsedMs: index * 30_000,
          plannedAtMs: index * 30_000
        })
        expect(Object.keys(sample).sort()).toEqual(['capture', 'current', 'peak', 'resource'])
        expect(Object.keys(sample.capture).sort()).toEqual([
          'hudOverlayHeight',
          'rawOcrSha256',
          'rawOcrText',
          'screenshotPath',
          'screenshotSha256',
          'sourceHostFrame',
          'windowBounds'
        ])
        joinedSamples.push(sample)
      }
      return { evidence: { audio: avAdapters.audioEvidence, samples: joinedSamples } }
    }
  }
}

describe('Studio AV endurance live runner', () => {
  it('records terminal background state without claiming ten-minute cursor isolation', () => {
    const observation = requireTerminalBackgroundObservation(
      {
        frontmostPid: 99,
        frontmostBundleIdentifier: 'com.apple.finder',
        targetPid: 42,
        targetIsActive: false,
        cursorX: 1_100,
        cursorY: 700
      },
      42
    )
    expect(observation).toMatchObject({ targetInactive: true, targetPid: 42 })
    expect(() =>
      requireTerminalBackgroundObservation(
        {
          frontmostPid: 42,
          frontmostBundleIdentifier: 'com.example.target',
          targetPid: 42,
          targetIsActive: true,
          cursorX: 10,
          cursorY: 20
        },
        42
      )
    ).toThrow(/terminal focus observation/i)
    expect(() =>
      requireTerminalBackgroundObservation(
        {
          frontmostPid: 99,
          targetPid: 42,
          targetIsActive: false,
          cursorX: 10,
          cursorY: 20
        },
        42
      )
    ).toThrow(/terminal focus observation/i)
  })

  it('binds the silence window to an exact paused HUD at the terminal PTS', () => {
    const observations = [
      { text: '00:09:59:29' },
      { text: 'PAUSE' },
      { text: 'drop 0 held 0 shown 18000 cache 10 tex 3' },
      { text: 'play 1 rss 400.0 MB' },
      { text: hudAssetIdentityToken(ASSET_ID) }
    ]
    const hud = {
      observations,
      texts: observations.map((observation) => observation.text),
      stdoutSha256: 'a'.repeat(64)
    }
    const census = { values: [570, 599.966667] }
    const paused = validatePostStopPausedState(hud, ASSET_ID, census, 599.966667, 20)
    expect(paused.observed.state).toBe('PAUSE')
    expect(paused.exactSourcePtsSeconds).toBe(599.966667)

    const playing = {
      ...hud,
      observations: observations.map((observation) =>
        observation.text === 'PAUSE' ? { text: 'PLAY' } : observation
      ),
      texts: hud.texts.map((text) => (text === 'PAUSE' ? 'PLAY' : text))
    }
    expect(() => validatePostStopPausedState(playing, ASSET_ID, census, 599.966667, 20)).toThrow(
      /not bound to PAUSE/i
    )
    expect(() => validatePostStopPausedState(hud, ASSET_ID, census, 570, 20)).toThrow(
      /not bound to PAUSE/i
    )
  })

  it('defaults safely to plan-only owner-media mode and rejects generated fixtures', () => {
    const parsed = parseLiveCli([])
    expect(parsed.launch).toBe(false)
    expect(parsed.generateSpeechFixture).toBe(false)
    expect(parsed.openTimeoutMs).toBe(180_000)
    expect(parseLiveCli(['--open-timeout-ms=240000']).openTimeoutMs).toBe(240_000)
    expect(() => parseLiveCli(['--open-timeout-ms=300001'])).toThrow(/open-timeout-ms/i)
    expect(() => parseLiveCli(['--generate-speech-fixture'])).toThrow(/owner-supplied/i)
    expect(() => normalizeRunOptions({ timeoutMs: 180_000, openTimeoutMs: 180_000 })).toThrow(
      /remaining watchdog budget/i
    )
    expect(() => normalizeRunOptions({ launch: true, mimeType: 'video/mp4' })).toThrow(
      /media path/i
    )
  })

  it('wires plan-only CLI through the harness without launching an app', async () => {
    const artifactRoot = root('plan')
    const result = await runLiveAcceptance(
      { artifactRoot },
      {
        runStudioAcceptance: async (args: Record<string, any>, adapters: Record<string, any>) => ({
          args,
          journeyDriverPresent: typeof adapters.driveUiJourney === 'function',
          planOptions: adapters.planOptions,
          openAdapters: adapters.openAdapters
        })
      }
    )
    expect(result.args).toMatchObject({ launch: false, artifactRoot, generateSpeechFixture: false })
    expect(result.journeyDriverPresent).toBe(true)
    expect(result.planOptions).toEqual({ artifactRoot })
    expect(result.openAdapters).toEqual({ timeoutMs: 180_000 })
  })

  it('runs readiness, 21 samples, terminal pause allowance, audio, and focus through adapters', async () => {
    const artifactRoot = root('journey')
    const assetPath = path.join(artifactRoot, 'owner-600s.mp4')
    writeFileSync(assetPath, 'owner media fixture')
    const log: string[] = []
    const journey = await runOutcome5Journey(
      { artifactRoot },
      {
        companion: { pid: 42 },
        window: { id: 7 },
        asset: { assetPath, sha256: ASSET_ID }
      },
      fakeJourneyAdapters(log)
    )
    expect(log[0]).toBe('readiness')
    expect(log).toContain('paused->playing')
    expect(log.indexOf('census')).toBeLessThan(log.indexOf('paused->playing'))
    expect(log.filter((entry) => entry.startsWith('sample-'))).toHaveLength(20)
    expect(log).toContain('terminal-20')
    expect(log).toContain('ui-audio-0')
    expect(log).toContain('ui-audio-20')
    expect(log).not.toContain('playing->paused')
    expect(journey.avEndurance.evidence.samples).toHaveLength(21)
    expect(journey.physicalAudibility).toBe('blocked')
    expect(journey.outcomePromotionAuthorized).toBe(false)
    expect(journey.playback.postStopPausedState.observed.state).toBe('PAUSE')
    expect(journey.playback.focusIsolation.terminalObservation.targetInactive).toBe(true)
  })

  it('refuses to join intentional-silence audio without a post-stop PAUSE receipt', async () => {
    const artifactRoot = root('missing-pause')
    const assetPath = path.join(artifactRoot, 'owner-600s.mp4')
    writeFileSync(assetPath, 'owner media fixture')
    const adapters = fakeJourneyAdapters([])
    const readSampleUi = adapters.readSampleUi
    adapters.readSampleUi = async (...args: any[]) => {
      const receipt = await readSampleUi(...args)
      delete receipt.pausedState
      return receipt
    }
    await expect(
      runOutcome5Journey(
        { artifactRoot },
        {
          companion: { pid: 42 },
          window: { id: 7 },
          asset: { assetPath, sha256: ASSET_ID }
        },
        adapters
      )
    ).rejects.toThrow(/silence probe.*PAUSE/i)
  })

  it('requires the materialized asset to remain inside artifactRoot', async () => {
    const artifactRoot = root('outside')
    const outside = path.join(os.tmpdir(), 'owner-media-outside.mp4')
    writeFileSync(outside, 'outside')
    await expect(
      runOutcome5Journey(
        { artifactRoot },
        {
          companion: { pid: 42 },
          window: { id: 7 },
          asset: { assetPath: outside, sha256: ASSET_ID }
        },
        fakeJourneyAdapters([])
      )
    ).rejects.toThrow(/escaped artifactRoot/i)
  })
})
