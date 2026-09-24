'use strict'

const MEMORY_BUDGET_BYTES = 24 * 1048576
const VIDEO_FIELDS = [
  'decoderSessions',
  'activeDecodeOperations',
  'pendingSourceLoads',
  'frameObjects',
  'decodedFrameObjects',
  'planeTextures',
  'ioSurfaces',
  'ioSurfaceBytes',
  'gpuCommandFrameHolds',
  'presentationLeases',
  'presentationLeaseCapacity',
  'reorderCacheEntries',
  'reorderCacheCapacity',
  'compressedCacheEntries',
  'compressedCacheCapacity',
  'compressedCacheBytes'
]
const AUDIO_FIELDS = [
  'playerObjects',
  'engineObjects',
  'runningEngines',
  'attachedTracks',
  'playingPlayers',
  'playersWithQueuedOutput',
  'queuedBuffers',
  'queuedPcmBytes',
  'pcmBuffers',
  'pcmBytes'
]
const CACHE_FIELDS = [
  'lutTextures',
  'lutBytes',
  'overlayAtlasTextures',
  'overlayAtlasBytes',
  'metalTextureCacheObjects'
]
const ACTIVITY_FIELDS = [
  'decodeSubmissions',
  'decodeCompletions',
  'decodeFailures',
  'presentedFrames',
  'droppedFrames',
  'textureBinds',
  'frameCacheHits',
  'samplePayloadReads'
]
const MEMORY_FIELDS = ['rssBytes', 'physicalFootprintBytes', 'mallocLiveBytes']
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function invariant(value, message) {
  if (!value) throw new Error(`Studio resource sample: ${message}`)
}
function count(value) {
  return Number.isSafeInteger(value) && value >= 0
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function validateNativeSnapshot(snapshot) {
  invariant(
    snapshot?.schemaVersion === 1 && /^[a-f0-9]{48}$/.test(snapshot.nonce || ''),
    'unsupported snapshot or nonce'
  )
  invariant(
    Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= 64 * 1024,
    'snapshot exceeds byte budget'
  )
  invariant(
    count(snapshot.processPid) &&
      snapshot.processPid > 0 &&
      UUID.test(snapshot.processInstanceId || ''),
    'missing native process identity'
  )
  invariant(
    count(snapshot.sampleSequence) &&
      snapshot.sampleSequence > 0 &&
      count(snapshot.documentRevision) &&
      Number.isFinite(snapshot.monotonicMs) &&
      snapshot.monotonicMs >= 0,
    'invalid native sequence/revision/clock'
  )
  const workspace = snapshot.workspace
  invariant(
    UUID.test(workspace?.windowIdentity || '') &&
      (workspace.windowNumber === null ||
        (count(workspace.windowNumber) && workspace.windowNumber > 0)) &&
      ['windowVisible', 'sourcePresentationAttached', 'reviewPresentationAttached'].every(
        (k) => typeof workspace[k] === 'boolean'
      ),
    'missing actual workspace state'
  )
  const assetId = (value) =>
    value === null ||
    (typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256)
  invariant(
    snapshot.assets &&
      assetId(snapshot.assets.sourceAssetId) &&
      assetId(snapshot.assets.reviewAssetId) &&
      Array.isArray(snapshot.assets.sequenceAssetIds) &&
      snapshot.assets.sequenceAssetIds.length <= 2048 &&
      snapshot.assets.sequenceAssetIds.every((value) => value !== null && assetId(value)) &&
      new Set(snapshot.assets.sequenceAssetIds).size === snapshot.assets.sequenceAssetIds.length,
    'invalid adopted asset context'
  )
  for (const [values, fields] of [
    [snapshot.resources?.video, VIDEO_FIELDS],
    [snapshot.resources?.audio, AUDIO_FIELDS],
    [snapshot.resources?.persistentCaches, CACHE_FIELDS],
    [snapshot.activity, ACTIVITY_FIELDS]
  ]) {
    invariant(
      values && fields.every((field) => count(values[field])),
      'missing or unrepresentable owned resource/activity count'
    )
  }
  const video = snapshot.resources.video
  invariant(
    Array.isArray(video.ioSurfaceIds) &&
      video.ioSurfaceIds.length <= 2048 &&
      video.ioSurfaceIds.every((id) => count(id) && id > 0 && id <= 0xffffffff) &&
      new Set(video.ioSurfaceIds).size === video.ioSurfaceIds.length &&
      video.ioSurfaces === video.ioSurfaceIds.length,
    'invalid physical IOSurface identities'
  )
  invariant(
    snapshot.coverage?.resources === 'application-owned' &&
      snapshot.coverage.frameworkInternalCaches === 'opaque' &&
      snapshot.coverage.gpuDriverRetentions === 'opaque',
    'opaque framework/driver coverage was misrepresented'
  )
  return snapshot
}

function validateProgress(snapshot, previous) {
  validateNativeSnapshot(snapshot)
  if (!previous) return
  invariant(
    snapshot.processPid === previous.processPid &&
      snapshot.processInstanceId === previous.processInstanceId &&
      snapshot.workspace.windowIdentity === previous.workspace.windowIdentity,
    'retained process/workspace was replaced'
  )
  invariant(
    snapshot.nonce !== previous.nonce &&
      snapshot.sampleSequence > previous.sampleSequence &&
      snapshot.monotonicMs > previous.monotonicMs &&
      snapshot.documentRevision >= previous.documentRevision,
    'duplicate, stale or rewound observation'
  )
  invariant(
    ACTIVITY_FIELDS.every((field) => snapshot.activity[field] >= previous.activity[field]),
    'lifetime activity counters reset'
  )
}

function parseProcessProof(stdout, expected) {
  const match =
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(
      String(stdout)
    )
  invariant(match, 'process birth proof unavailable')
  const proof = {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    pgid: Number(match[3]),
    startedAt: match[4].replace(/\s+/g, ' '),
    command: match[5]
  }
  invariant(
    proof.pid === expected.pid &&
      proof.pgid === expected.pgid &&
      (!Number.isSafeInteger(expected.ppid) || proof.ppid === expected.ppid) &&
      (proof.command === expected.executablePath ||
        proof.command.startsWith(`${expected.executablePath} `)),
    'process PID/parent/group/executable departed from harness custody'
  )
  return proof
}

function parseCpuTime(value) {
  // Darwin ps time is accumulated user + system CPU, in centiseconds.
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})\.(\d{2})$/.exec(value)
  invariant(
    match &&
      Number(match[4]) < 60 &&
      (!match[2] || Number(match[3]) < 60) &&
      (!match[1] || (match[2] && Number(match[2]) < 24)),
    'invalid accumulated CPU time'
  )
  const milliseconds =
    (((Number(match[1] || 0) * 24 + Number(match[2] || 0)) * 60 + Number(match[3])) * 60 +
      Number(match[4])) *
      1000 +
    Number(match[5]) * 10
  invariant(count(milliseconds), 'unrepresentable accumulated CPU time')
  return milliseconds
}

function parseProcessObservation(
  stdout,
  expected,
  readStartedMonotonicMs,
  readFinishedMonotonicMs
) {
  // time is first so paths with spaces and date fields retain their exact parser.
  const match = /^\s*(\S+)\s+([^\r\n]+)\s*$/.exec(String(stdout))
  invariant(match, 'process CPU/birth observation unavailable')
  const processBirth = parseProcessProof(match[2], expected)
  invariant(
    Number.isFinite(readStartedMonotonicMs) &&
      readStartedMonotonicMs >= 0 &&
      Number.isFinite(readFinishedMonotonicMs) &&
      readFinishedMonotonicMs >= readStartedMonotonicMs,
    'invalid process observation clock'
  )
  return {
    processBirth,
    processCpu: {
      totalMilliseconds: parseCpuTime(match[1]),
      resolutionMilliseconds: 10,
      readStartedMonotonicMs,
      readFinishedMonotonicMs,
      stdout: String(stdout)
    }
  }
}

function validateCpuObservation(sample) {
  const cpu = sample.processCpu
  invariant(cpu, 'process CPU interval evidence is missing')
  const parsed = parseProcessObservation(
    cpu.stdout,
    {
      pid: sample.processPid,
      pgid: sample.processPgid,
      ppid: sample.processBirth?.ppid,
      executablePath: sample.executablePath
    },
    cpu.readStartedMonotonicMs,
    cpu.readFinishedMonotonicMs
  )
  invariant(
    same(parsed.processBirth, sample.processBirth) && same(parsed.processCpu, cpu),
    'CPU receipt does not match process birth/counter evidence'
  )
  return cpu
}

function measureCpuInterval(first, second) {
  const a = validateCpuObservation(first)
  const b = validateCpuObservation(second)
  invariant(same(first.processBirth, second.processBirth), 'CPU interval process birth changed')
  // The ps read occurred somewhere inside each bracket. Use the shortest real
  // interval and include one counter tick of rounding uncertainty, never top -l1.
  const elapsedMilliseconds = b.readStartedMonotonicMs - a.readFinishedMonotonicMs
  const cpuMilliseconds = b.totalMilliseconds - a.totalMilliseconds
  invariant(
    elapsedMilliseconds >= 2000 && cpuMilliseconds >= 0,
    'CPU interval is short or its counter reset'
  )
  const percentUpperBound =
    (100 * (cpuMilliseconds + a.resolutionMilliseconds)) / elapsedMilliseconds
  invariant(
    Number.isFinite(percentUpperBound) && percentUpperBound <= 1,
    'cooldown CPU remained active'
  )
  return {
    source: 'ps-user-plus-system-time-delta',
    elapsedMilliseconds,
    cpuMilliseconds,
    resolutionMilliseconds: a.resolutionMilliseconds,
    percentUpperBound
  }
}

function createWarmPlan(samples, assets) {
  invariant(
    Array.isArray(assets) &&
      assets.length === 2 &&
      assets.every(
        (asset) =>
          /^[A-Za-z0-9_-]{43}$/.test(asset.assetId) &&
          count(asset.byteLength) &&
          asset.byteLength > 0 &&
          typeof asset.audioExpected === 'boolean'
      ) &&
      assets[0].assetId !== assets[1].assetId,
    'two content-addressed resource-plan assets are required'
  )
  invariant(
    Array.isArray(samples) && samples.length === 15,
    'warm plan requires both assets and all four routes, then primary restore'
  )
  const allowedAssets = new Set(assets.map((asset) => asset.assetId))
  const nonces = new Set()
  let previous
  for (const [sequence, sample] of samples.entries()) {
    validateProgress(sample.native, previous)
    invariant(!nonces.has(sample.native.nonce), 'warm observations reused a request nonce')
    nonces.add(sample.native.nonce)
    const pass = Math.floor(sequence / 5)
    const routeIndex = (sequence % 5) - 1
    invariant(
      sample.sequence === sequence &&
        sample.phase === (routeIndex < 0 ? 'warm-open' : 'warm-route') &&
        sample.index === (routeIndex < 0 ? pass : pass * 4 + routeIndex) &&
        sample.assetId === assets[pass % 2].assetId &&
        sample.native.assets.sourceAssetId === sample.assetId,
      'warm plan does not cover the fixed asset/route schedule'
    )
    // Each pass opens with Timeline hidden, then shows Timeline, hides and restores
    // Source, and hides Timeline. Review may attach only while Timeline is visible.
    const sourceVisible = routeIndex !== 1
    const timelineVisible = routeIndex >= 0 && routeIndex < 3
    invariant(
      sample.native.workspace.sourcePresentationAttached === sourceVisible &&
        (timelineVisible || sample.native.workspace.reviewPresentationAttached === false),
      'warm presentation attachment departs from the fixed route schedule'
    )
    validateObservationJoin(sample, samples[0], allowedAssets)
    const { video, audio } = sample.native.resources
    invariant(
      sample.native.workspace.windowVisible &&
        video.activeDecodeOperations === 0 &&
        video.pendingSourceLoads === 0 &&
        audio.playingPlayers === 0 &&
        audio.queuedBuffers === 0,
      'warm owners are not settled and paused'
    )
    invariant(
      video.decoderSessions <= 2 &&
        video.reorderCacheCapacity <= 12 &&
        video.compressedCacheCapacity <= 7200 &&
        audio.playerObjects <= 1 &&
        audio.engineObjects <= 1 &&
        audio.pcmBuffers <= 3,
      'warm owners exceed the declared two-source/shared-player scope'
    )
    if (routeIndex < 0)
      invariant(
        video.decoderSessions > 0 && video.ioSurfaces > 0 && video.ioSurfaceBytes > 0,
        'single-asset warm allocation is unavailable'
      )
    if (assets[pass % 2].audioExpected)
      invariant(
        audio.attachedTracks === 1 && audio.pcmBuffers > 0 && audio.pcmBytes > 0,
        'planned audible asset has no measured attached PCM allocation'
      )
    previous = sample.native
  }
  const maximum = (get) => Math.max(...samples.map(get))
  const videoMax = (field) => maximum((sample) => sample.native.resources.video[field])
  const audioMax = (field) => maximum((sample) => sample.native.resources.audio[field])
  const presentationLeaseCapacity = videoMax('presentationLeaseCapacity')
  const reorderCacheCapacity = videoMax('reorderCacheCapacity')
  const ioSurfaces = reorderCacheCapacity + 2 * presentationLeaseCapacity + 2
  const persistentCaches = Object.fromEntries(
    CACHE_FIELDS.map((field) => [
      field,
      maximum((sample) => sample.native.resources.persistentCaches[field])
    ])
  )
  // An empirical aggregate warm envelope, not per-asset allocation attribution.
  // The whole observed surface allocation is a conservative ceiling per surface
  // for these prewarmed fixtures. Retained bytes must stay inside that fixed ceiling.
  const budget = {
    memoryBytes: MEMORY_BUDGET_BYTES,
    decoderSessions: videoMax('decoderSessions'),
    activeDecodeOperations: 0,
    pendingSourceLoads: 0,
    reorderCacheCapacity,
    presentationLeaseCapacity,
    compressedCacheCapacity: videoMax('compressedCacheCapacity'),
    // Declared payload ceiling for these self-contained files; not a universal container guarantee.
    compressedCacheBytes: assets.reduce((sum, asset) => sum + asset.byteLength, 0),
    gpuCommandFrameHolds: presentationLeaseCapacity,
    frameObjects: reorderCacheCapacity + 2 * presentationLeaseCapacity,
    decodedFrameObjects: reorderCacheCapacity + 2 * presentationLeaseCapacity,
    ioSurfaces,
    ioSurfaceBytes: ioSurfaces * videoMax('ioSurfaceBytes'),
    playerObjects: audioMax('playerObjects'),
    engineObjects: audioMax('engineObjects'),
    pcmBuffers: audioMax('pcmBuffers'),
    pcmBytes: audioMax('pcmBytes'),
    persistentCaches
  }
  // Logical backing bytes are not an RSS reconciliation. Reserve declared
  // remaining cache/surface capacity plus fixed residual process-memory slack.
  const remainingCapacityBytes =
    Math.max(0, budget.compressedCacheBytes - videoMax('compressedCacheBytes')) +
    Math.max(0, budget.ioSurfaceBytes - videoMax('ioSurfaceBytes'))
  const warmMemory = Object.fromEntries(
    MEMORY_FIELDS.map((field) => [field, maximum((sample) => sample[field])])
  )
  const memoryCeilings = Object.fromEntries(
    MEMORY_FIELDS.map((field) => [
      field,
      warmMemory[field] + remainingCapacityBytes + MEMORY_BUDGET_BYTES
    ])
  )
  const cooldownMemoryCeilings = Object.fromEntries(
    MEMORY_FIELDS.map((field) => [field, warmMemory[field] + MEMORY_BUDGET_BYTES])
  )
  invariant(
    [
      ...Object.values(budget).filter((value) => typeof value === 'number'),
      ...Object.values(memoryCeilings),
      ...Object.values(cooldownMemoryCeilings)
    ].every(count),
    'warm budget is unrepresentable'
  )
  for (const sample of samples) validateOwnedBounds(sample.native, budget)
  return {
    schemaVersion: 1,
    scope: 'empirical-aggregate-warm-envelope',
    assets,
    samples,
    budget,
    warmMemory,
    remainingCapacityBytes,
    memoryCeilings,
    cooldownMemoryCeilings
  }
}

function validateWarmPlan(plan) {
  invariant(plan?.schemaVersion === 1, 'fixed warm plan is missing')
  const measured = createWarmPlan(plan.samples, plan.assets)
  invariant(same(plan, measured), 'warm plan was widened or changed after preflight')
  return measured
}

function validateObservationJoin(sample, baseline, allowedAssets) {
  const native = validateNativeSnapshot(sample.native)
  invariant(
    same(sample.processBirth, baseline.processBirth) &&
      sample.processBirth?.pid === native.processPid &&
      sample.processBirth.pgid === sample.processPgid &&
      sample.processPid === native.processPid &&
      sample.assetId === native.assets.sourceAssetId &&
      sample.monotonicMs === native.monotonicMs &&
      same(sample.ioSurfaceIds, native.resources.video.ioSurfaceIds) &&
      sample.residentDecoderCount === native.resources.video.decoderSessions,
    'ownership observations do not join their process/asset/memory record'
  )
  invariant(
    MEMORY_FIELDS.every((field) => count(sample[field])),
    'process memory measurement unavailable'
  )
  invariant(
    [native.assets.sourceAssetId, native.assets.reviewAssetId, ...native.assets.sequenceAssetIds]
      .filter((value) => value !== null)
      .every((value) => allowedAssets.has(value)),
    'unplanned asset resource ownership'
  )
  validateCpuObservation(sample)
}

function validateOwnedBounds(snapshot, budget) {
  const { video, audio, persistentCaches } = snapshot.resources
  for (const field of [
    'decoderSessions',
    'activeDecodeOperations',
    'pendingSourceLoads',
    'reorderCacheCapacity',
    'compressedCacheCapacity',
    'compressedCacheBytes',
    'presentationLeaseCapacity',
    'gpuCommandFrameHolds',
    'frameObjects',
    'decodedFrameObjects',
    'ioSurfaces',
    'ioSurfaceBytes'
  ]) {
    invariant(video[field] <= budget[field], `${field} exceeds the frozen warm budget`)
  }
  invariant(
    video.presentationLeases <= video.presentationLeaseCapacity &&
      video.reorderCacheEntries <= video.reorderCacheCapacity &&
      video.compressedCacheEntries <= video.compressedCacheCapacity,
    'measured owner occupancy exceeds capacity'
  )
  invariant(
    video.planeTextures === video.frameObjects * 2 &&
      video.ioSurfaces <= video.frameObjects + video.decodedFrameObjects,
    'wrapper/backing ownership is contradictory'
  )
  for (const field of ['playerObjects', 'engineObjects', 'pcmBuffers', 'pcmBytes'])
    invariant(audio[field] <= budget[field], `${field} exceeds retained audio budget`)
  invariant(
    audio.attachedTracks <= audio.playerObjects &&
      audio.runningEngines <= audio.engineObjects &&
      audio.playingPlayers <= audio.playerObjects &&
      audio.playersWithQueuedOutput <= audio.playerObjects &&
      audio.queuedBuffers <= audio.playerObjects,
    'audio owner/queue count is contradictory'
  )
  for (const field of CACHE_FIELDS)
    invariant(
      persistentCaches[field] <= budget.persistentCaches[field],
      `${field} exceeds the persistent cache budget`
    )
}

function createResourceCollector(target, adapters) {
  const executablePath = /^(.*\/TaskWraithStudioCompanion)(?:\s|$)/.exec(
    target.companion?.command || ''
  )?.[1]
  const expected = { ...target.companion, executablePath }
  let birthProof, previous, plan
  const samples = []
  const warmSamples = []
  const now = adapters.monotonicNow || (() => Number(process.hrtime.bigint()) / 1_000_000)
  const proof = async () => {
    const started = now()
    const result = await adapters.runExact(
      '/bin/ps',
      ['-p', String(expected.pid), '-o', 'time=,pid=,ppid=,pgid=,lstart=,command='],
      { timeout: 5000 }
    )
    return parseProcessObservation(result.stdout, expected, started, now())
  }
  return {
    samples,
    get plan() {
      return plan && structuredClone(plan)
    },
    finishWarmup(assets) {
      invariant(!plan && samples.length === 0, 'warm plan cannot change after measurement begins')
      plan = structuredClone(createWarmPlan(warmSamples, assets))
      return structuredClone(plan)
    },
    async observe(phase, index, observedTarget = target) {
      invariant(
        executablePath && observedTarget.renderer,
        'exact harness process and renderer are required'
      )
      invariant(
        plan ? !phase.startsWith('warm-') : phase.startsWith('warm-'),
        'resource phase does not match the fixed preflight boundary'
      )
      const before = await proof()
      if (birthProof)
        invariant(same(before.processBirth, birthProof), 'Companion birth identity changed')
      const outcome = await adapters.evaluateByValue(
        observedTarget.renderer,
        'window.api.getStudioResourceSnapshot()'
      )
      invariant(outcome?.ok === true, `native query unavailable: ${outcome?.code || 'unsupported'}`)
      const native = validateNativeSnapshot(outcome.snapshot)
      invariant(
        native.processPid === expected.pid &&
          native.assets.sourceAssetId === observedTarget.asset.sha256,
        'native process/adopted asset does not match the harness'
      )
      validateProgress(native, previous)
      const raw = await adapters.resourceSample(
        expected.pid,
        `${phase}-${index}`,
        0,
        adapters.resourceAdapters || {}
      )
      const after = await proof()
      invariant(
        same(before.processBirth, after.processBirth) &&
          after.processCpu.totalMilliseconds >= before.processCpu.totalMilliseconds,
        'Companion identity or CPU counter changed during observation'
      )
      const sample = {
        phase,
        index,
        sequence: plan ? samples.length : warmSamples.length,
        assetId: observedTarget.asset.sha256,
        processPid: expected.pid,
        processPgid: expected.pgid,
        executablePath,
        processBirth: before.processBirth,
        processCpu: after.processCpu,
        native,
        monotonicMs: native.monotonicMs,
        rssBytes: raw.ps?.rssKilobytes * 1024,
        physicalFootprintBytes: raw.physicalFootprintBytes,
        mallocLiveBytes: raw.mallocAllocatedBytes,
        topFirstSampleCpuPercent: raw.top?.cpuPercent,
        rawMemory: raw,
        ioSurfaceIds: native.resources.video.ioSurfaceIds,
        residentDecoderCount: native.resources.video.decoderSessions
      }
      invariant(
        MEMORY_FIELDS.every((field) => count(sample[field])),
        'process memory measurement unavailable'
      )
      if (plan) {
        validateOwnedBounds(native, plan.budget)
        sample.ioSurfaceCapacity = plan.budget.ioSurfaces
        for (const field of MEMORY_FIELDS)
          invariant(
            sample[field] <= plan.memoryCeilings[field],
            `${field} exceeds the fixed warm allocation budget`
          )
      }
      birthProof = before.processBirth
      previous = structuredClone(native)
      ;(plan ? samples : warmSamples).push(sample)
      return sample
    }
  }
}

function validateNativeCooldown(first, second, baseline, resourcePlan) {
  invariant(
    first?.native && second?.native && baseline?.native,
    'two actual closed observations and their warm budget are required'
  )
  const plan = validateWarmPlan(resourcePlan)
  const budget = plan.budget
  validateProgress(second.native, first.native)
  validateProgress(first.native, baseline.native)
  invariant(
    same(first.processBirth, second.processBirth) &&
      same(first.processBirth, baseline.processBirth),
    'cooldown process birth changed'
  )
  invariant(
    first.native.documentRevision === second.native.documentRevision &&
      same(first.native.assets, second.native.assets),
    'cooldown document/asset context changed'
  )
  for (const sample of [first, second]) {
    validateObservationJoin(sample, baseline, new Set(plan.assets.map((asset) => asset.assetId)))
    validateOwnedBounds(sample.native, budget)
    invariant(
      sample.native.workspace.windowVisible === false &&
        sample.native.workspace.sourcePresentationAttached === false &&
        sample.native.workspace.reviewPresentationAttached === false,
      'cooldown presentation is still attached'
    )
    const { video, audio } = sample.native.resources
    for (const field of [
      'decoderSessions',
      'activeDecodeOperations',
      'pendingSourceLoads',
      'frameObjects',
      'decodedFrameObjects',
      'planeTextures',
      'ioSurfaces',
      'ioSurfaceBytes',
      'gpuCommandFrameHolds',
      'presentationLeases',
      'reorderCacheEntries',
      'compressedCacheEntries',
      'compressedCacheBytes'
    ]) {
      invariant(video[field] === 0, `closed owner still retains ${field}`)
    }
    for (const field of [
      'playingPlayers',
      'playersWithQueuedOutput',
      'queuedBuffers',
      'queuedPcmBytes'
    ])
      invariant(audio[field] === 0, `closed audio still has ${field}`)
    for (const field of MEMORY_FIELDS)
      invariant(
        count(sample[field]) && sample[field] <= plan.cooldownMemoryCeilings[field],
        `cooldown ${field} exceeds warm budget`
      )
  }
  invariant(
    second.native.monotonicMs - first.native.monotonicMs >= 2000,
    'cooldown interval is too short'
  )
  invariant(
    ACTIVITY_FIELDS.every(
      (field) => first.native.activity[field] === second.native.activity[field]
    ),
    'closed decode/load/presentation activity continues'
  )
  const cpuInterval = measureCpuInterval(first, second)
  return {
    status: 'measured',
    decodeStopped: true,
    first,
    second,
    budget,
    cpuInterval,
    allowedRetainedCaches: {
      audio: second.native.resources.audio,
      persistentCaches: second.native.resources.persistentCaches
    },
    coverage: second.native.coverage
  }
}

function validateOwnedWorkload(samples, resourcePlan) {
  invariant(Array.isArray(samples) && samples.length > 0, 'workload observations are missing')
  const plan = validateWarmPlan(resourcePlan)
  const baseline = samples[0]
  validateNativeSnapshot(baseline.native)
  const budget = plan.budget
  const nonces = new Set(plan.samples.map((sample) => sample.native.nonce))
  let previous = plan.samples.at(-1).native
  const allowedAssets = new Set(plan.assets.map((asset) => asset.assetId))
  for (const sample of samples) {
    const native = sample.native
    validateProgress(native, previous)
    invariant(!nonces.has(native.nonce), 'workload reused a request nonce')
    nonces.add(native.nonce)
    validateObservationJoin(sample, plan.samples[0], allowedAssets)
    invariant(sample.ioSurfaceCapacity === budget.ioSurfaces, 'workload IOSurface capacity changed')
    invariant(
      native.workspace.windowVisible === (sample.phase !== 'closed'),
      'workload window state contradicts its phase'
    )
    validateOwnedBounds(native, budget)
    for (const field of MEMORY_FIELDS)
      invariant(
        sample[field] <= plan.memoryCeilings[field],
        `workload ${field} exceeds fixed budget`
      )
    previous = native
  }
  return {
    status: 'measured',
    plan,
    budget,
    processBirth: baseline.processBirth,
    processInstanceId: baseline.native.processInstanceId,
    coverage: baseline.native.coverage
  }
}

module.exports = {
  VIDEO_FIELDS,
  AUDIO_FIELDS,
  CACHE_FIELDS,
  ACTIVITY_FIELDS,
  MEMORY_FIELDS,
  MEMORY_BUDGET_BYTES,
  validateNativeSnapshot,
  validateProgress,
  parseProcessProof,
  parseCpuTime,
  parseProcessObservation,
  validateCpuObservation,
  measureCpuInterval,
  createWarmPlan,
  validateWarmPlan,
  validateOwnedBounds,
  createResourceCollector,
  validateNativeCooldown,
  validateOwnedWorkload
}
