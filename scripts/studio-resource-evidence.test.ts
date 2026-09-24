import { describe, expect, it, vi } from 'vitest'
import { resourceSnapshotFixture } from '../src/main/studio/StudioResourceSnapshot.test-fixtures'
import {
  cooldownFixture,
  ownedSample,
  resourceIdentity,
  warmPlanFixture,
  workloadFixture
} from './studio-resource-evidence.test-fixtures'

/* eslint-disable @typescript-eslint/no-require-imports */
const resource = require('./studio-resource-evidence.cjs')

const executablePath = '/tmp/Studio Package/TaskWraithStudioCompanion'
const expected = { pid: 12, ppid: 10, pgid: 10, executablePath }
const birthLine = `12 10 10 Thu Sep 24 10:00:00 2026 ${executablePath}`

function cpuSample(total: string, start: number, finish = start + 1) {
  return {
    processPid: 12,
    processPgid: 10,
    executablePath,
    ...resource.parseProcessObservation(`${total} ${birthLine}\n`, expected, start, finish)
  }
}

describe('Studio measured process identity and CPU intervals', () => {
  it.each([
    ['0:00.00', 0],
    ['123:45.67', 7_425_670],
    ['1:02:03.45', 3_723_450],
    ['2-03:04:05.06', 183_845_060]
  ])('reads accumulated Darwin CPU time %s', (value, milliseconds) => {
    expect(resource.parseCpuTime(value)).toBe(milliseconds)
  })

  it.each([
    '0:60.00',
    '1:61:00.00',
    '1-25:00:00.00',
    '-0:01.00',
    '0',
    'NaN',
    '0:00.000',
    '999999999999999:00.00'
  ])('refuses invalid or unrepresentable CPU time %s', (value) => {
    expect(() => resource.parseCpuTime(value)).toThrow()
  })

  it('uses the interval counter and conservative read brackets, not top first-sample zero', () => {
    const first = { ...cpuSample('0:01.00', 1000), topFirstSampleCpuPercent: 0 }
    const second = { ...cpuSample('0:01.02', 5001), topFirstSampleCpuPercent: 0 }
    expect(resource.measureCpuInterval(first, second)).toMatchObject({
      source: 'ps-user-plus-system-time-delta',
      elapsedMilliseconds: 4000,
      cpuMilliseconds: 20,
      percentUpperBound: 0.75
    })
    expect(() => resource.measureCpuInterval(first, cpuSample('0:01.20', 5001))).toThrow(
      /CPU remained active/
    )
  })

  it('refuses PID reuse, counter resets, short intervals and tampered parsed counters', () => {
    const first = cpuSample('0:01.00', 1000)
    const replacement = cpuSample('0:01.00', 5001)
    replacement.processBirth.startedAt = 'Thu Sep 24 10:00:01 2026'
    expect(() => resource.measureCpuInterval(first, replacement)).toThrow(/birth/)
    expect(() => resource.measureCpuInterval(first, cpuSample('0:00.99', 5001))).toThrow(
      /counter reset/
    )
    expect(() => resource.measureCpuInterval(first, cpuSample('0:01.00', 2500))).toThrow(/short/)
    const forged = cpuSample('0:01.20', 5001)
    forged.processCpu.totalMilliseconds = 1000
    expect(() => resource.measureCpuInterval(first, forged)).toThrow(/counter evidence/)
  })

  it('requires the exact harness parent, group, executable and a single birth record', () => {
    expect(resource.parseProcessProof(birthLine, expected)).toMatchObject({
      pid: 12,
      ppid: 10,
      pgid: 10,
      command: executablePath
    })
    for (const changed of [
      birthLine.replace('12 10 10', '12 11 10'),
      birthLine.replace('12 10 10', '12 10 11'),
      birthLine.replace(executablePath, `${executablePath}-other`),
      `${birthLine}\n${birthLine}`
    ])
      expect(() => resource.parseProcessProof(changed, expected)).toThrow()
  })
})

describe('Studio native resource evidence', () => {
  it('keeps live overcapacity and lifetime activity distinct, rejecting missing coverage', () => {
    const native = resourceSnapshotFixture()
    native.resources.video.presentationLeases = 9
    native.resources.video.presentationLeaseCapacity = 8
    expect(resource.validateNativeSnapshot(native)).toBe(native)
    expect(() => resource.validateOwnedBounds(native, warmPlanFixture().budget)).toThrow(
      /occupancy/
    )
    delete (native.coverage as Partial<typeof native.coverage>).frameworkInternalCaches
    expect(() => resource.validateNativeSnapshot(native)).toThrow(/coverage/)
  })

  it('preserves lifetime counter history across source disposal and rejects resets', () => {
    const first = resourceSnapshotFixture()
    const next = resourceSnapshotFixture({
      nonce: 'b'.repeat(48),
      sampleSequence: 2,
      monotonicMs: 200
    })
    expect(() => resource.validateProgress(next, first)).not.toThrow()
    next.activity.decodeSubmissions = 0
    expect(() => resource.validateProgress(next, first)).toThrow(/counters reset/)
  })

  it('fails unavailable queries without manufacturing zero resources or sampling another process', async () => {
    const sampleMemory = vi.fn()
    let now = 1
    const collector = resource.createResourceCollector(
      {
        companion: { ...expected, command: executablePath },
        renderer: {},
        asset: { sha256: 'fixture-video' }
      },
      {
        runExact: () => ({ stdout: `0:01.00 ${birthLine}\n` }),
        monotonicNow: () => now++,
        evaluateByValue: async () => ({ ok: false, code: 'resource_snapshot_unavailable' }),
        resourceSample: sampleMemory
      }
    )
    await expect(collector.observe('warm-open', 0)).rejects.toThrow(/unavailable/)
    expect(sampleMemory).not.toHaveBeenCalled()
    expect(collector.samples).toEqual([])
  })

  it('freezes both provider modes and rejects matching cache capacity/occupancy growth', () => {
    const plan = warmPlanFixture()
    const eager = ownedSample('switch', 1, 1, resourceIdentity.secondaryAssetId, 16)
    expect(() => resource.validateOwnedBounds(eager.native, plan.budget)).not.toThrow()
    eager.native.resources.video.compressedCacheCapacity = 3601
    eager.native.resources.video.compressedCacheEntries = 3601
    expect(() => resource.validateOwnedBounds(eager.native, plan.budget)).toThrow(
      /compressedCacheCapacity/
    )
    eager.native.resources.video.compressedCacheCapacity = 3600
    eager.native.resources.video.compressedCacheEntries = 2
    eager.native.resources.video.compressedCacheBytes = plan.budget.compressedCacheBytes + 1
    expect(() => resource.validateOwnedBounds(eager.native, plan.budget)).toThrow(
      /compressedCacheBytes/
    )
  })

  it('admits a predeclared larger secondary PCM track but rejects an extra retained track', () => {
    const original = warmPlanFixture()
    for (const sample of original.samples.filter(
      (value: { assetId: string }) => value.assetId === resourceIdentity.secondaryAssetId
    )) {
      sample.native.resources.audio.pcmBytes = 46_080_000
      for (const field of resource.MEMORY_FIELDS) sample[field] += 46_080_000
    }
    const plan = resource.createWarmPlan(original.samples, original.assets)
    const secondary = ownedSample('switch', 1, 1, resourceIdentity.secondaryAssetId, 16)
    secondary.native.resources.audio.pcmBytes = 46_080_000
    expect(() => resource.validateOwnedBounds(secondary.native, plan.budget)).not.toThrow()
    secondary.native.resources.audio.pcmBuffers = 2
    expect(() => resource.validateOwnedBounds(secondary.native, plan.budget)).toThrow(/pcmBuffers/)
    plan.budget.pcmBuffers = 2
    expect(() => resource.validateWarmPlan(plan)).toThrow(/widened/)
  })

  it('refuses a silent load failure for an asset whose probe declares audio', () => {
    const plan = warmPlanFixture()
    plan.samples[5].native.resources.audio.attachedTracks = 0
    expect(() => resource.createWarmPlan(plan.samples, plan.assets)).toThrow(/audible asset/)
  })

  it('allows a warm Review attachment while the Timeline route is visible', () => {
    const plan = warmPlanFixture()
    // Samples 1-3 are route steps 0-2, where the Timeline route is visible.
    for (const sequence of [1, 2, 3])
      plan.samples[sequence].native.workspace.reviewPresentationAttached = true
    expect(() => resource.createWarmPlan(plan.samples, plan.assets)).not.toThrow()
  })

  // Samples 0-4 are the warm open, then route steps 0-3. Source is hidden at step 1;
  // Timeline is hidden at the open and at step 3.
  it.each([
    ['open Source detached', 0, 'sourcePresentationAttached', false],
    ['open Review attached', 0, 'reviewPresentationAttached', true],
    ['hidden Source attached', 2, 'sourcePresentationAttached', true],
    ['restored Source detached', 4, 'sourcePresentationAttached', false],
    ['hidden-Timeline Review attached', 4, 'reviewPresentationAttached', true]
  ] as const)('refuses a warm sample with %s', (_name, sequence, field, value) => {
    const plan = warmPlanFixture()
    plan.samples[sequence].native.workspace[field] = value
    expect(() => resource.createWarmPlan(plan.samples, plan.assets)).toThrow(/fixed route schedule/)
  })

  it('allows retained silent audio owners, proves stable activity, and rejects hidden continued work', () => {
    const { samples, plan } = workloadFixture()
    const owned = resource.validateOwnedWorkload(samples, plan)
    const live = { baseline: samples[0], peak: samples[0], final: samples.at(-1), owned }
    const { first, second } = cooldownFixture(live).terminalCounters
    const verdict = resource.validateNativeCooldown(first, second, live.baseline, plan)
    expect(verdict).toMatchObject({
      status: 'measured',
      decodeStopped: true,
      allowedRetainedCaches: {
        audio: {
          playerObjects: 1,
          attachedTracks: 1,
          runningEngines: 1,
          pcmBytes: 4096,
          queuedBuffers: 0
        }
      }
    })
    second.native.activity.decodeSubmissions += 1
    expect(() => resource.validateNativeCooldown(first, second, live.baseline, plan)).toThrow(
      /activity continues/
    )
  })

  it('rejects flat-memory resource leaks, native/process substitutions and reused nonces', () => {
    for (const mutation of ['decoded-frame', 'process', 'nonce', 'surface-map']) {
      const { samples, plan } = workloadFixture()
      if (mutation === 'decoded-frame')
        samples[30].native.resources.video.decodedFrameObjects = plan.budget.decodedFrameObjects + 1
      if (mutation === 'process') samples[30].processBirth.startedAt = 'Thu Sep 24 10:00:01 2026'
      if (mutation === 'nonce') samples[30].native.nonce = samples[0].native.nonce
      if (mutation === 'surface-map') samples[30].ioSurfaceIds = [999]
      expect(() => resource.validateOwnedWorkload(samples, plan)).toThrow()
    }
  })
})
