import { resourceSnapshotFixture } from '../src/main/studio/StudioResourceSnapshot.test-fixtures'

/* eslint-disable @typescript-eslint/no-require-imports */
const resource = require('./studio-resource-evidence.cjs')

export const resourceIdentity = {
  processPid: 12,
  processPgid: 12,
  executablePath: '/tmp/TaskWraithStudioCompanion',
  primaryAssetId: 'a'.repeat(43),
  secondaryAssetId: 'b'.repeat(43)
}

export function ownedSample(
  phase: string,
  index: number,
  sequence: number,
  assetId: string,
  nativeOrdinal = sequence
) {
  const closed = phase === 'closed' || phase === 'cooldown'
  const native = resourceSnapshotFixture({
    processPid: 12,
    nonce: (nativeOrdinal + 1).toString(16).padStart(48, '0'),
    sampleSequence: nativeOrdinal + 1,
    monotonicMs: 1000 + nativeOrdinal * 3000
  })
  native.assets.sourceAssetId = assetId
  Object.assign(native.workspace, {
    windowVisible: !closed,
    sourcePresentationAttached:
      !closed && !((phase === 'route' || phase === 'warm-route') && index % 4 === 1),
    windowNumber: 7
  })
  Object.assign(native.resources.video, {
    decoderSessions: closed ? 0 : 1,
    frameObjects: closed ? 0 : 1,
    decodedFrameObjects: closed ? 0 : 1,
    planeTextures: closed ? 0 : 2,
    ioSurfaces: closed ? 0 : 1,
    ioSurfaceBytes: closed ? 0 : 4096,
    ioSurfaceIds: closed ? [] : [1],
    presentationLeases: closed ? 0 : 1,
    presentationLeaseCapacity: 8,
    reorderCacheEntries: closed ? 0 : 1,
    reorderCacheCapacity: closed ? 0 : 6,
    compressedCacheEntries: closed ? 0 : 2,
    compressedCacheCapacity: closed ? 0 : assetId === resourceIdentity.primaryAssetId ? 240 : 3600,
    compressedCacheBytes: closed ? 0 : 2048
  })
  native.resources.audio.runningEngines = 1
  const processEvidence = resource.parseProcessObservation(
    '0:01.00 12 10 12 Thu Sep 24 10:00:00 2026 /tmp/TaskWraithStudioCompanion\n',
    { pid: 12, ppid: 10, pgid: 12, executablePath: resourceIdentity.executablePath },
    native.monotonicMs + 1,
    native.monotonicMs + 2
  )
  return {
    phase,
    index,
    sequence,
    assetId,
    processPid: 12,
    processPgid: 12,
    executablePath: resourceIdentity.executablePath,
    ...processEvidence,
    native,
    monotonicMs: native.monotonicMs,
    rssBytes: 100_000_000,
    physicalFootprintBytes: 100_000_000,
    mallocLiveBytes: 100_000_000,
    ioSurfaceIds: native.resources.video.ioSurfaceIds,
    residentDecoderCount: native.resources.video.decoderSessions,
    ioSurfaceCapacity: 24,
    ...(closed
      ? { closed: true, windowReappeared: false, windowAbsence: { closed: true, exactPid: 12 } }
      : {})
  }
}

export function warmPlanFixture() {
  const samples = Array.from({ length: 15 }, (_, sequence) => {
    const pass = Math.floor(sequence / 5)
    const route = (sequence % 5) - 1
    return ownedSample(
      route < 0 ? 'warm-open' : 'warm-route',
      route < 0 ? pass : pass * 4 + route,
      sequence,
      pass === 1 ? resourceIdentity.secondaryAssetId : resourceIdentity.primaryAssetId
    )
  })
  return resource.createWarmPlan(samples, [
    { assetId: resourceIdentity.primaryAssetId, byteLength: 10_000, audioExpected: true },
    { assetId: resourceIdentity.secondaryAssetId, byteLength: 20_000, audioExpected: true }
  ])
}

export function workloadFixture() {
  const plan = warmPlanFixture()
  const phases = [
    ...Array.from({ length: 21 }, (_, index) => ({ phase: 'loop', index })),
    ...Array.from({ length: 100 }, (_, index) => ({ phase: 'seek', index })),
    ...Array.from({ length: 20 }, (_, index) => ({ phase: 'switch', index })),
    ...Array.from({ length: 40 }, (_, index) => ({ phase: 'route', index })),
    ...Array.from({ length: 10 }, (_, index) => [
      { phase: 'closed', index },
      { phase: 'reopen', index }
    ]).flat(),
    { phase: 'final', index: 0 }
  ]
  const samples = phases.map(({ phase, index }, sequence) => {
    const sample = ownedSample(
      phase,
      index,
      sequence,
      phase === 'loop' || phase === 'seek' || (phase === 'switch' && index % 2 === 0)
        ? resourceIdentity.primaryAssetId
        : resourceIdentity.secondaryAssetId,
      sequence + 15
    )
    sample.native.documentRevision =
      phase === 'switch'
        ? index + 1
        : phase === 'route'
          ? 20
          : phase === 'closed'
            ? 20 + index
            : phase === 'reopen'
              ? 21 + index
              : phase === 'final'
                ? 30
                : 0
    sample.native.workspace.windowNumber =
      phase === 'closed' ? 7 + index : phase === 'reopen' ? 8 + index : phase === 'final' ? 17 : 7
    return sample
  })
  return { plan, samples }
}

export function exactCloseFixture(windowId: number) {
  return {
    schemaVersion: 1,
    kind: 'taskwraith-studio-endurance-window-control-receipt',
    pid: 12,
    pgid: 12,
    executablePath: resourceIdentity.executablePath,
    windowId,
    windowTitle: 'TaskWraith Studio',
    accessibilityRole: 'AXButton',
    accessibilityAction: 'AXPress',
    stateBefore: 'visible',
    stateAfter: 'closed',
    focusIsolation: { focusPreserved: true, cursorPreserved: true }
  }
}

export function cooldownFixture(live: Record<string, unknown>) {
  const first = ownedSample('cooldown', 0, 202, resourceIdentity.secondaryAssetId, 217)
  const second = ownedSample('cooldown', 1, 203, resourceIdentity.secondaryAssetId, 218)
  const final = live.final as ReturnType<typeof ownedSample>
  for (const sample of [first, second]) {
    sample.native.documentRevision = final.native.documentRevision
    sample.native.workspace.windowNumber = final.native.workspace.windowNumber
  }
  return {
    closed: true,
    cooldown: { closed: true },
    decodeStopped: true,
    processPid: 12,
    processPgid: 12,
    executablePath: resourceIdentity.executablePath,
    targetAssetId: resourceIdentity.secondaryAssetId,
    rawCloseReceipt: exactCloseFixture(final.native.workspace.windowNumber as number),
    resourceSnapshots: [
      ...['baseline', 'peak', 'final'].map((label) => ({
        ...(live[label] as Record<string, unknown>),
        label
      })),
      { ...second, label: 'cooldown' }
    ],
    terminalCounters: resource.validateNativeCooldown(
      first,
      second,
      live.baseline,
      (live.owned as { plan: unknown }).plan
    ),
    memoryReturnedWithinBudget: true,
    memoryReturnBudgetBytes: resource.MEMORY_BUDGET_BYTES
  }
}
