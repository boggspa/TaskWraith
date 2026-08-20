#!/usr/bin/env node
'use strict'

/**
 * Plan-only-by-default negative transcript acceptance apparatus.
 *
 * This deliberately uses a path-disjoint fixture and journey from the normal
 * acceptance harness.  A no-audio video must reach the renderer's typed
 * `unavailable` status without ever committing a `set_transcript` operation
 * for the opened asset.  The harness still owns launch, custody, package,
 * watchdog, and evidence sealing; this file only supplies the fixture and the
 * negative journey.
 */

const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')

const mediaLimits = require('../src/shared/mediaLimits.json')
const { resolveMediaTool } = require('./studio-lut-acceptance-runner.cjs')
const {
  buildStudioAcceptancePlan,
  assertCleanWatchdogTerminal,
  evaluateByValue,
  invokeAuthorizedStudioOpen,
  runStudioAcceptance,
  readStudioJournalOperations,
  waitFor
} = require('./studio-acceptance-harness.cjs')

const FIXTURE_DURATION_SECONDS = 30
const FIXTURE_FRAME_RATE = 30
const FIXTURE_SIZE = '640x360'
const MAX_FIXTURE_BYTES = mediaLimits.transcriptMediaMaxVideoBytes
const MAX_MANIFEST_BYTES = 64 * 1024
const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,15}$/
const EXPECTED_FAILURE_CODE = 'transcribe_failed'
const FIXTURE_PROVENANCE_NOTE =
  'Video is synthesised from lavfi testsrc2 with no audio stream. The unavailable status and absence of a set_transcript journal operation are measured by the live journey.'
const MANIFEST_KEYS = [
  'schemaVersion',
  'kind',
  'durationSeconds',
  'expectedFrameCount',
  'frameRate',
  'size',
  'mimeType',
  'outputPath',
  'manifestPath',
  'outputSha256',
  'outputByteLength',
  'ffmpegCommand',
  'ffprobeCommand',
  'ffmpegExitCode',
  'ffprobeExitCode',
  'tools',
  'toolReceipts',
  'probe',
  'provenanceNote'
]

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

function fileIdentity(stat) {
  const mtimeNs =
    stat.mtimeNs !== undefined ? String(stat.mtimeNs) : String(Math.round(stat.mtimeMs * 1e6))
  const ctimeNs =
    stat.ctimeNs !== undefined ? String(stat.ctimeNs) : String(Math.round(stat.ctimeMs * 1e6))
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    size: Number(stat.size),
    mtimeNs,
    ctimeNs
  }
}

function assertStableFixtureIdentity(before, after, label = 'fixture') {
  if (!sameIdentity(before?.identity, after?.identity) || before?.sha256 !== after?.sha256) {
    throw new Error(`${label} identity or hash changed during validation`)
  }
  return after
}

function sameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function readStableRegularFile(filePath, label, options = {}) {
  const before = await fsPromises.lstat(filePath)
  if (before.isSymbolicLink() || !before.isFile() || before.size < 1) {
    throw new Error(`${label} must be a non-empty regular file`)
  }
  if (options.maxBytes !== undefined && before.size > options.maxBytes) {
    throw new Error(`${label} exceeds its bounded byte limit`)
  }
  const beforeIdentity = fileIdentity(before)
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  const handle = await fsPromises.open(filePath, flags)
  try {
    const opened = await handle.stat()
    if (!sameIdentity(beforeIdentity, fileIdentity(opened))) {
      throw new Error(`${label} changed before descriptor custody was established`)
    }
    const hash = crypto.createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    let position = 0
    while (position < before.size) {
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position
      )
      if (result.bytesRead < 1) throw new Error(`${label} ended during descriptor hashing`)
      hash.update(buffer.subarray(0, result.bytesRead))
      position += result.bytesRead
    }
    const after = await handle.stat()
    const afterLstat = await fsPromises.lstat(filePath)
    if (
      !sameIdentity(beforeIdentity, fileIdentity(after)) ||
      !sameIdentity(beforeIdentity, fileIdentity(afterLstat))
    ) {
      throw new Error(`${label} changed during descriptor hashing`)
    }
    return {
      path: path.resolve(filePath),
      byteLength: before.size,
      sha256: hash.digest('hex'),
      identity: beforeIdentity
    }
  } finally {
    await handle.close()
  }
}

async function readStableDirectoryIdentity(directory, label) {
  const stat = await fsPromises.lstat(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real non-symlink directory`)
  }
  return { dev: Number(stat.dev), ino: Number(stat.ino) }
}

async function assertStableDirectoryIdentity(directory, expected, label) {
  const current = await readStableDirectoryIdentity(directory, label)
  if (!sameIdentity(current, expected)) throw new Error(`${label} changed during acceptance`)
  return current
}

function boundedArtifactRoot(value) {
  const raw = String(value || '')
  if (!path.isAbsolute(raw))
    throw new Error('artifactRoot must be an originally absolute directory')
  const root = path.resolve(raw)
  if (root === path.parse(root).root) {
    throw new Error('artifactRoot must be a bounded absolute directory')
  }
  return root
}

function assertPositiveDuration(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600) {
    throw new Error('durationSeconds must be an integer from 1 to 3600')
  }
  return value
}

function buildNoAudioFixtureCommand({
  outputPath,
  durationSeconds = FIXTURE_DURATION_SECONDS,
  ffmpegPath = 'ffmpeg'
}) {
  const rawOutput = String(outputPath || '')
  if (!path.isAbsolute(rawOutput)) {
    throw new Error('no-audio fixture outputPath must be an originally absolute file')
  }
  const output = path.resolve(rawOutput)
  if (output === path.parse(output).root) {
    throw new Error('no-audio fixture outputPath must be a bounded absolute file')
  }
  const duration = assertPositiveDuration(durationSeconds)
  return [
    ffmpegPath,
    '-hide_banner',
    '-loglevel',
    'error',
    '-n',
    '-fflags',
    '+bitexact',
    '-flags:v',
    '+bitexact',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${FIXTURE_SIZE}:rate=${FIXTURE_FRAME_RATE}`,
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-pix_fmt',
    'yuv420p',
    '-t',
    String(duration),
    '-map_metadata',
    '-1',
    '-movflags',
    '+faststart',
    output
  ]
}

function buildNoAudioProbeCommand({ outputPath, ffprobePath = 'ffprobe' }) {
  const rawOutput = String(outputPath || '')
  if (!path.isAbsolute(rawOutput)) {
    throw new Error('no-audio fixture probe outputPath must be an originally absolute file')
  }
  const output = path.resolve(rawOutput)
  if (output === path.parse(output).root) {
    throw new Error('no-audio fixture probe outputPath must be a bounded absolute file')
  }
  return [
    ffprobePath,
    '-hide_banner',
    '-loglevel',
    'error',
    '-show_entries',
    'stream=codec_type,width,height,r_frame_rate,nb_read_frames,duration:format=duration',
    '-count_frames',
    '-of',
    'json',
    output
  ]
}

function parseNoAudioProbe(stdout, expected = {}) {
  let parsed
  try {
    parsed = JSON.parse(String(stdout || ''))
  } catch (error) {
    throw new Error(`ffprobe no-audio receipt is not valid JSON: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.streams)) {
    throw new Error('ffprobe no-audio receipt must contain a streams array')
  }
  const stream = parsed.streams[0]
  if (parsed.streams.length !== 1 || stream?.codec_type !== 'video') {
    throw new Error('no-audio fixture must contain exactly one video stream and no audio stream')
  }
  if (
    JSON.stringify(Object.keys(parsed).sort()) !==
      JSON.stringify(['format', 'programs', 'stream_groups', 'streams']) ||
    JSON.stringify(Object.keys(stream).sort()) !==
      JSON.stringify([
        'codec_type',
        'duration',
        'height',
        'nb_read_frames',
        'r_frame_rate',
        'width'
      ]) ||
    JSON.stringify(Object.keys(parsed.format || {}).sort()) !== JSON.stringify(['duration']) ||
    !Array.isArray(parsed.programs) ||
    parsed.programs.length !== 0 ||
    !Array.isArray(parsed.stream_groups) ||
    parsed.stream_groups.length !== 0
  ) {
    throw new Error('ffprobe no-audio receipt has an unexpected schema')
  }
  const width = Number(stream.width)
  const height = Number(stream.height)
  const frameRate = String(stream.r_frame_rate || '')
  const frameCount = Number(stream.nb_read_frames)
  const durationSeconds = Number(stream.duration || parsed.format?.duration)
  if (
    width !== (expected.width || 640) ||
    height !== (expected.height || 360) ||
    frameRate !== (expected.frameRate || '30/1') ||
    !Number.isSafeInteger(frameCount) ||
    frameCount !== expected.frameCount ||
    !Number.isFinite(durationSeconds) ||
    Math.abs(durationSeconds - Number(expected.durationSeconds)) > 1 / 30
  ) {
    throw new Error('no-audio fixture probe does not match the exact bounded timing contract')
  }
  return {
    streamCount: parsed.streams.length,
    videoStreamCount: 1,
    audioStreamCount: 0,
    width,
    height,
    frameRate,
    durationSeconds,
    frameCount
  }
}

async function assertSafeFixtureFile(filePath, label = 'no-audio fixture') {
  try {
    const receipt = await readStableRegularFile(filePath, label, { maxBytes: MAX_FIXTURE_BYTES })
    return { ...receipt, size: receipt.byteLength }
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`)
    throw error
  }
}

async function ensureRealDirectory(directory, label) {
  const raw = String(directory || '')
  if (!path.isAbsolute(raw)) throw new Error(`${label} must be originally absolute`)
  const resolved = path.resolve(raw)
  await fsPromises.mkdir(resolved, { recursive: true, mode: 0o700 })
  const stat = await fsPromises.lstat(resolved)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real non-symlink directory`)
  }
  const real = await fsPromises.realpath(resolved)
  return real
}

function validateNoAudioManifest(manifest, expected) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('no-audio fixture manifest must be an object')
  }
  const actualKeys = Object.keys(manifest).sort()
  const expectedKeys = [...MANIFEST_KEYS].sort()
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error('no-audio fixture manifest keys are not exact')
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== 'taskwraith-studio-transcript-failure-no-audio-fixture' ||
    manifest.durationSeconds !== expected.durationSeconds ||
    manifest.expectedFrameCount !== expected.durationSeconds * FIXTURE_FRAME_RATE ||
    manifest.frameRate !== FIXTURE_FRAME_RATE ||
    manifest.size !== FIXTURE_SIZE ||
    manifest.mimeType !== 'video/mp4' ||
    manifest.outputPath !== expected.outputPath ||
    manifest.manifestPath !== expected.manifestPath ||
    !/^[a-f0-9]{64}$/.test(manifest.outputSha256) ||
    !Number.isSafeInteger(manifest.outputByteLength) ||
    manifest.outputByteLength < 1 ||
    manifest.outputByteLength > MAX_FIXTURE_BYTES ||
    !manifest.tools ||
    typeof manifest.tools.ffmpeg !== 'string' ||
    !path.isAbsolute(manifest.tools.ffmpeg) ||
    typeof manifest.tools.ffprobe !== 'string' ||
    !path.isAbsolute(manifest.tools.ffprobe) ||
    JSON.stringify(manifest.ffmpegCommand) !==
      JSON.stringify(
        buildNoAudioFixtureCommand({
          outputPath: expected.outputPath,
          durationSeconds: expected.durationSeconds,
          ffmpegPath: manifest.tools.ffmpeg
        })
      ) ||
    JSON.stringify(manifest.ffprobeCommand) !==
      JSON.stringify(
        buildNoAudioProbeCommand({
          outputPath: expected.outputPath,
          ffprobePath: manifest.tools.ffprobe
        })
      ) ||
    manifest.ffmpegExitCode !== 0 ||
    manifest.ffprobeExitCode !== 0 ||
    manifest.probe?.streamCount !== 1 ||
    manifest.probe?.videoStreamCount !== 1 ||
    manifest.probe?.audioStreamCount !== 0 ||
    manifest.probe?.width !== 640 ||
    manifest.probe?.height !== 360 ||
    manifest.probe?.frameRate !== '30/1' ||
    manifest.probe?.durationSeconds !== expected.durationSeconds ||
    manifest.probe?.frameCount !== expected.durationSeconds * FIXTURE_FRAME_RATE ||
    !manifest.toolReceipts ||
    JSON.stringify(Object.keys(manifest.toolReceipts).sort()) !==
      JSON.stringify(['ffmpeg', 'ffprobe']) ||
    !['ffmpeg', 'ffprobe'].every((name) => {
      const receipt = manifest.toolReceipts[name]
      return (
        receipt &&
        JSON.stringify(Object.keys(receipt).sort()) ===
          JSON.stringify(['byteLength', 'path', 'sha256', 'version']) &&
        receipt.path === manifest.tools[name] &&
        /^[a-f0-9]{64}$/.test(receipt.sha256) &&
        Number.isSafeInteger(receipt.byteLength) &&
        receipt.byteLength > 0 &&
        typeof receipt.version === 'string' &&
        receipt.version.length > 0
      )
    }) ||
    manifest.provenanceNote !== FIXTURE_PROVENANCE_NOTE
  ) {
    throw new Error('no-audio fixture manifest does not match the bounded deterministic contract')
  }
  return manifest
}

function execFilePromise(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

async function generateNoAudioFixture(options = {}, adapters = {}) {
  const artifactRoot = boundedArtifactRoot(options.artifactRoot)
  const durationSeconds = assertPositiveDuration(
    options.durationSeconds === undefined ? FIXTURE_DURATION_SECONDS : options.durationSeconds
  )
  const realArtifactRoot = await ensureRealDirectory(artifactRoot, 'artifactRoot')
  const fixtureDirectory = path.join(realArtifactRoot, 'fixtures')
  const realFixtureDirectory = await ensureRealDirectory(fixtureDirectory, 'fixture directory')
  const artifactRootIdentity = await readStableDirectoryIdentity(realArtifactRoot, 'artifactRoot')
  const fixtureDirectoryIdentity = await readStableDirectoryIdentity(
    realFixtureDirectory,
    'fixture directory'
  )
  const outputPath = path.join(fixtureDirectory, 'acceptance-no-audio.mp4')
  const manifestPath = path.join(fixtureDirectory, 'no-audio-fixture-manifest.json')
  const artifactRelative = path.relative(realArtifactRoot, outputPath)
  if (!artifactRelative || artifactRelative.startsWith('..') || path.isAbsolute(artifactRelative)) {
    throw new Error('no-audio fixture output escaped artifactRoot')
  }
  for (const candidate of [outputPath, manifestPath]) {
    try {
      await fsPromises.lstat(candidate)
      throw new Error(
        `no-audio fixture path already exists; require a fresh artifact root: ${candidate}`
      )
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const resolveTool = adapters.resolveMediaTool || resolveMediaTool
  const resolveToolPath = adapters.realpathTool || ((candidate) => fsPromises.realpath(candidate))
  const ffmpegPath = await resolveToolPath(resolveTool('ffmpeg'))
  const ffprobePath = await resolveToolPath(resolveTool('ffprobe'))
  if (!path.isAbsolute(ffmpegPath) || !path.isAbsolute(ffprobePath)) {
    throw new Error('resolved media tools must be absolute paths')
  }
  const ffmpegCommand = buildNoAudioFixtureCommand({ outputPath, durationSeconds, ffmpegPath })
  const ffprobeCommand = buildNoAudioProbeCommand({ outputPath, ffprobePath })
  const runExecFile = adapters.execFile || execFilePromise
  const readToolReceipt =
    adapters.readToolReceipt || ((toolPath, label) => readStableRegularFile(toolPath, label))
  const ffmpegToolReceipt = await readToolReceipt(ffmpegPath, 'ffmpeg tool')
  const ffprobeToolReceipt = await readToolReceipt(ffprobePath, 'ffprobe tool')
  const ffmpegVersionResult = await runExecFile(ffmpegPath, ['-version'], {
    timeout: 30_000,
    maxBuffer: 64 * 1024
  })
  const ffprobeVersionResult = await runExecFile(ffprobePath, ['-version'], {
    timeout: 30_000,
    maxBuffer: 64 * 1024
  })
  const ffmpegVersion = String(ffmpegVersionResult?.stdout || '')
    .split(/\r?\n/, 1)[0]
    .trim()
  const ffprobeVersion = String(ffprobeVersionResult?.stdout || '')
    .split(/\r?\n/, 1)[0]
    .trim()
  if (!ffmpegVersion || !ffprobeVersion) throw new Error('media tool version receipts are empty')
  await assertStableDirectoryIdentity(realArtifactRoot, artifactRootIdentity, 'artifactRoot')
  await assertStableDirectoryIdentity(
    realFixtureDirectory,
    fixtureDirectoryIdentity,
    'fixture directory'
  )
  try {
    await runExecFile(ffmpegCommand[0], ffmpegCommand.slice(1), {
      timeout: Math.min(10 * 60 * 1_000, Math.max(30_000, durationSeconds * 10_000)),
      maxBuffer: 1 * 1024 * 1024
    })
  } catch (error) {
    // Preserve every partial, including a raced regular owner file. The
    // artifact is evidence of the failed external command and must not be
    // unlinked by this runner.
    throw error
  }
  await assertStableDirectoryIdentity(realArtifactRoot, artifactRootIdentity, 'artifactRoot')
  await assertStableDirectoryIdentity(
    realFixtureDirectory,
    fixtureDirectoryIdentity,
    'fixture directory'
  )
  const outputStat = await assertSafeFixtureFile(outputPath)
  await assertStableDirectoryIdentity(realArtifactRoot, artifactRootIdentity, 'artifactRoot')
  await assertStableDirectoryIdentity(
    realFixtureDirectory,
    fixtureDirectoryIdentity,
    'fixture directory'
  )
  const probeResult = await runExecFile(ffprobeCommand[0], ffprobeCommand.slice(1), {
    timeout: 30_000,
    maxBuffer: 64 * 1024
  })
  await assertStableDirectoryIdentity(realArtifactRoot, artifactRootIdentity, 'artifactRoot')
  await assertStableDirectoryIdentity(
    realFixtureDirectory,
    fixtureDirectoryIdentity,
    'fixture directory'
  )
  const ffprobe = parseNoAudioProbe(probeResult?.stdout, {
    width: 640,
    height: 360,
    frameRate: '30/1',
    frameCount: durationSeconds * FIXTURE_FRAME_RATE,
    durationSeconds
  })
  const outputAfterProbe = await assertSafeFixtureFile(outputPath)
  assertStableFixtureIdentity(outputStat, outputAfterProbe, 'no-audio fixture')
  const realOutput = await fsPromises.realpath(outputPath)
  const realOutputRelative = path.relative(realArtifactRoot, realOutput)
  if (
    !realOutputRelative ||
    realOutputRelative.startsWith('..') ||
    path.isAbsolute(realOutputRelative)
  ) {
    throw new Error('no-audio fixture resolves outside artifactRoot')
  }
  const ffmpegToolAfter = await readToolReceipt(ffmpegPath, 'ffmpeg tool after probe')
  const ffprobeToolAfter = await readToolReceipt(ffprobePath, 'ffprobe tool after probe')
  assertStableFixtureIdentity(ffmpegToolReceipt, ffmpegToolAfter, 'ffmpeg tool')
  assertStableFixtureIdentity(ffprobeToolReceipt, ffprobeToolAfter, 'ffprobe tool')
  const manifest = {
    schemaVersion: 1,
    kind: 'taskwraith-studio-transcript-failure-no-audio-fixture',
    durationSeconds,
    expectedFrameCount: durationSeconds * FIXTURE_FRAME_RATE,
    frameRate: FIXTURE_FRAME_RATE,
    size: FIXTURE_SIZE,
    mimeType: 'video/mp4',
    outputPath,
    manifestPath,
    outputSha256: outputStat.sha256,
    outputByteLength: outputStat.byteLength,
    ffmpegCommand,
    ffprobeCommand,
    ffmpegExitCode: 0,
    ffprobeExitCode: 0,
    tools: { ffmpeg: ffmpegPath, ffprobe: ffprobePath },
    toolReceipts: {
      ffmpeg: {
        path: ffmpegToolReceipt.path,
        sha256: ffmpegToolReceipt.sha256,
        byteLength: ffmpegToolReceipt.byteLength,
        version: ffmpegVersion
      },
      ffprobe: {
        path: ffprobeToolReceipt.path,
        sha256: ffprobeToolReceipt.sha256,
        byteLength: ffprobeToolReceipt.byteLength,
        version: ffprobeVersion
      }
    },
    probe: ffprobe,
    provenanceNote: FIXTURE_PROVENANCE_NOTE
  }
  validateNoAudioManifest(manifest, { durationSeconds, outputPath, manifestPath })
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`
  if (Buffer.byteLength(encoded) > MAX_MANIFEST_BYTES) {
    throw new Error('no-audio fixture manifest exceeds its bounded size')
  }
  const tempPath = `${manifestPath}.tmp-${process.pid}`
  try {
    await assertStableDirectoryIdentity(realArtifactRoot, artifactRootIdentity, 'artifactRoot')
    await assertStableDirectoryIdentity(
      realFixtureDirectory,
      fixtureDirectoryIdentity,
      'fixture directory'
    )
    await fsPromises.writeFile(tempPath, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fsPromises.rename(tempPath, manifestPath)
    await assertStableDirectoryIdentity(realArtifactRoot, artifactRootIdentity, 'artifactRoot')
    await assertStableDirectoryIdentity(
      realFixtureDirectory,
      fixtureDirectoryIdentity,
      'fixture directory'
    )
  } finally {
    await fsPromises.rm(tempPath, { force: true }).catch(() => undefined)
  }
  return manifest
}

function assertTypedTranscriptStatus(status, expectedAssetId) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new Error('renderer transcript status is not an object')
  }
  if (status.schemaVersion !== 1) throw new Error('renderer transcript status schema is invalid')
  if (status.assetId !== expectedAssetId)
    throw new Error('renderer transcript status asset is wrong')
  if (!['pending', 'unavailable'].includes(status.state)) {
    throw new Error('renderer transcript status state is invalid')
  }
  if (status.state === 'pending' && status.code !== null) {
    throw new Error('pending transcript status code must be null')
  }
  if (
    status.state === 'unavailable' &&
    (typeof status.code !== 'string' || !status.code.trim() || status.code.length > 64)
  ) {
    throw new Error('renderer unavailable transcript status code must be nonempty and bounded')
  }
  if (typeof status.message !== 'string' || !status.message.trim() || status.message.length > 512) {
    throw new Error('renderer transcript status message must be nonempty and bounded')
  }
  if (!Number.isSafeInteger(status.updatedAt) || status.updatedAt <= 0) {
    throw new Error('renderer transcript status updatedAt is invalid')
  }
  return {
    schemaVersion: 1,
    assetId: status.assetId,
    state: status.state,
    code: status.code === null ? null : status.code.trim(),
    message: status.message.trim(),
    updatedAt: status.updatedAt
  }
}

function assertUnavailableTranscriptStatus(status, expectedAssetId, options = {}) {
  const normalized = assertTypedTranscriptStatus(status, expectedAssetId)
  if (normalized.state !== 'unavailable')
    throw new Error('renderer transcript status is not unavailable')
  if (normalized.code !== EXPECTED_FAILURE_CODE) {
    throw new Error(`renderer unavailable transcript status code must be ${EXPECTED_FAILURE_CODE}`)
  }
  if (
    options.minimumUpdatedAt !== undefined &&
    (!Number.isSafeInteger(options.minimumUpdatedAt) ||
      normalized.updatedAt < options.minimumUpdatedAt)
  ) {
    throw new Error('renderer transcript status is stale')
  }
  return normalized
}

function assertTranscriptStatusHistory(history, expectedAssetId, options = {}) {
  if (!Array.isArray(history)) throw new Error('renderer transcript status history is not an array')
  const installedAt = options.installedAt || 0
  const floorAt = options.floorAt || installedAt
  const captured = history.filter(
    (event) => event && Number.isSafeInteger(event.receivedAt) && event.receivedAt >= installedAt
  )
  if (
    captured.some(
      (event) =>
        event.receivedAt < floorAt ||
        !Number.isSafeInteger(event.status?.updatedAt) ||
        event.status.updatedAt < floorAt
    )
  ) {
    throw new Error('renderer transcript status history contains a pre-install or stale event')
  }
  const events = history
    .filter(
      (event) => event && Number.isSafeInteger(event.receivedAt) && event.receivedAt >= installedAt
    )
    .filter((event) => event.status?.assetId === expectedAssetId)
  if (events.length < 2)
    throw new Error('renderer transcript status history lacks pending and unavailable events')
  let previousUpdatedAt = 0
  let previousReceivedAt = 0
  const normalized = events.map((event) => {
    if (event.receivedAt < previousReceivedAt)
      throw new Error('renderer transcript status receive order is not monotonic')
    const status = assertTypedTranscriptStatus(event.status, expectedAssetId)
    if (status.updatedAt < previousUpdatedAt)
      throw new Error('renderer transcript status updatedAt is not monotonic')
    previousReceivedAt = event.receivedAt
    previousUpdatedAt = status.updatedAt
    return { receivedAt: event.receivedAt, status }
  })
  const pendingIndex = normalized.findIndex((event) => event.status.state === 'pending')
  const unavailableIndex = normalized.findIndex((event) => event.status.state === 'unavailable')
  if (pendingIndex < 0 || unavailableIndex < 0 || pendingIndex >= unavailableIndex) {
    throw new Error('renderer transcript status history is not ordered pending then unavailable')
  }
  if (
    normalized.at(-1).status.state !== 'unavailable' ||
    normalized.slice(unavailableIndex + 1).some((event) => event.status.state !== 'unavailable')
  ) {
    throw new Error('renderer transcript status history has a post-terminal state')
  }
  const unavailable = assertUnavailableTranscriptStatus(
    normalized[unavailableIndex].status,
    expectedAssetId,
    options
  )
  return {
    installedAt,
    events: normalized,
    pending: normalized[pendingIndex],
    unavailable: { receivedAt: normalized[unavailableIndex].receivedAt, status: unavailable }
  }
}

async function waitForUnavailableTranscriptStatus(options = {}) {
  const assetId = String(options.assetId || '')
  if (!assetId) throw new Error('waitForUnavailableTranscriptStatus requires an assetId')
  if (typeof options.readHistory !== 'function') {
    throw new Error('waitForUnavailableTranscriptStatus requires a renderer status history reader')
  }
  const wait = options.waitFor || waitFor
  return wait({
    label: 'exact renderer StudioTranscriptStatusNotice pending-to-unavailable history',
    timeoutMs: options.timeoutMs,
    intervalMs: 100,
    probe: async () => {
      const history = await options.readHistory()
      try {
        return assertTranscriptStatusHistory(history, assetId, options)
      } catch (error) {
        if (
          /code must be|schema is invalid|state is invalid|updatedAt is invalid|message must/.test(
            error.message
          )
        )
          throw error
        return null
      }
    }
  })
}

function journalDigest(entries) {
  return sha256Text(entries.map((entry) => JSON.stringify(entry)).join('\n'))
}

function fixtureAssetId(fixture) {
  if (!/^[a-f0-9]{64}$/.test(fixture?.outputSha256 || '')) {
    throw new Error('negative fixture outputSha256 is invalid')
  }
  return Buffer.from(fixture.outputSha256, 'hex').toString('base64url')
}

function materializedFixtureAssetPath(plan, fixture) {
  const assetId = fixtureAssetId(fixture)
  return path.join(
    plan.profile.userDataPath,
    'transcript-media',
    assetId.slice(0, 2),
    `${assetId}.mp4`
  )
}

function assertTargetMatchesFixture(target, fixture, plan) {
  const assetId = fixtureAssetId(fixture)
  if (
    target?.asset?.sourcePath !== fixture.outputPath ||
    target?.asset?.sha256 !== assetId ||
    target?.asset?.assetPath !== materializedFixtureAssetPath(plan, fixture)
  ) {
    throw new Error('live Studio target does not match the sealed no-audio fixture')
  }
  return { assetId, assetPath: target.asset.assetPath }
}

function proveNoTranscriptJournal(entries, assetId, assetPath) {
  if (!Array.isArray(entries)) throw new Error('Studio journal receipt must be an array')
  if (typeof assetId !== 'string' || !assetId) throw new Error('journal proof requires an assetId')
  if (typeof assetPath !== 'string' || !path.isAbsolute(assetPath)) {
    throw new Error('journal proof requires an absolute asset path')
  }
  const openMedia = entries.filter((entry) => {
    const asset = entry?.op?.type === 'open_media' ? entry.op.asset : null
    return asset?.assetId === assetId
  })
  if (
    openMedia.length !== 1 ||
    openMedia[0].op.asset.path !== assetPath ||
    openMedia[0].op.asset.mediaKind !== 'video'
  ) {
    throw new Error('journal must contain exactly one matching open_media asset/path/mediaKind')
  }
  const matching = entries.filter((entry) => {
    const operation = entry?.op
    return operation?.type === 'set_transcript'
  })
  if (matching.length > 0) {
    throw new Error(`journal committed set_transcript (${matching.length})`)
  }
  const revisions = entries.map((entry) => entry?.revision).filter(Number.isSafeInteger)
  return {
    pathSafe: true,
    entryCount: entries.length,
    setTranscriptForAsset: 0,
    maxRevision: revisions.length > 0 ? Math.max(...revisions) : 0,
    journalSha256: journalDigest(entries)
  }
}

async function provePostReapJournal(options) {
  const readJournal = options.readJournalOperations || readStudioJournalOperations
  const beforeEntries = await readJournal(options.plan)
  const before = proveNoTranscriptJournal(beforeEntries, options.assetId, options.assetPath)
  await (options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(100)
  const afterEntries = await readJournal(options.plan)
  const after = proveNoTranscriptJournal(afterEntries, options.assetId, options.assetPath)
  if (before.journalSha256 !== after.journalSha256 || before.maxRevision !== after.maxRevision) {
    throw new Error('post-reap journal changed during terminal fence')
  }
  return { before, after, quiescenceMs: 100 }
}

async function driveNegativeTranscriptJourney(plan, target, adapters = {}) {
  const readHistory = adapters.readTranscriptHistory
  const readJournal = adapters.readJournalOperations || readStudioJournalOperations
  if (typeof readHistory !== 'function')
    throw new Error('negative journey requires typed status history')
  const targetIdentity = assertTargetMatchesFixture(target, target.fixture, plan)
  const history = await waitForUnavailableTranscriptStatus({
    assetId: targetIdentity.assetId,
    readHistory,
    waitFor: adapters.waitFor,
    timeoutMs: plan.transcriptTimeoutMs,
    installedAt: target.transcriptCapture?.installedAt,
    floorAt: target.transcriptCapture?.floorAt
  })
  const entriesBefore = await readJournal(plan)
  const journalBefore = proveNoTranscriptJournal(
    entriesBefore,
    targetIdentity.assetId,
    targetIdentity.assetPath
  )
  await (adapters.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(1_000)
  const entriesAfter = await readJournal(plan)
  const journalAfter = proveNoTranscriptJournal(
    entriesAfter,
    targetIdentity.assetId,
    targetIdentity.assetPath
  )
  if (
    journalBefore.journalSha256 !== journalAfter.journalSha256 ||
    journalBefore.maxRevision !== journalAfter.maxRevision
  ) {
    throw new Error('Studio journal changed during negative transcript quiescence')
  }
  return {
    schemaVersion: 1,
    kind: 'taskwraith-studio-negative-transcript-journey',
    assetId: targetIdentity.assetId,
    openedAssetPath: targetIdentity.assetPath,
    fixture: target.fixture || null,
    statusHistory: history,
    journal: { before: journalBefore, after: journalAfter, quiescenceMs: 1_000 }
  }
}

const TRANSCRIPT_CAPTURE_KEY = '__taskwraithStudioTranscriptFailureCaptureV1'

async function installTranscriptStatusCapture(renderer, evaluate = evaluateByValue) {
  const installedAt = Date.now()
  const installed = await evaluate(
    renderer,
    `(() => {
      const api = window.api
      if (typeof api?.onStudioTranscriptStatus !== 'function') return false
      const events = []
      const unsubscribe = api.onStudioTranscriptStatus((status) => {
        events.push({ status, receivedAt: Date.now() })
      })
      window.${TRANSCRIPT_CAPTURE_KEY} = { events, unsubscribe }
      return true
    })()`
  )
  if (installed !== true)
    throw new Error('renderer typed transcript status subscription is unavailable')
  return { renderer, installedAt, floorAt: installedAt }
}

async function readTranscriptStatusCapture(capture, evaluate = evaluateByValue) {
  const history = await evaluate(capture.renderer, `window.${TRANSCRIPT_CAPTURE_KEY}?.events || []`)
  if (!Array.isArray(history)) throw new Error('renderer transcript status capture is not an array')
  return history
}

async function removeTranscriptStatusCapture(capture, evaluate = evaluateByValue) {
  if (!capture?.renderer) return
  await evaluate(
    capture.renderer,
    `(() => {
      const capture = window.${TRANSCRIPT_CAPTURE_KEY}
      if (capture?.unsubscribe) capture.unsubscribe()
      delete window.${TRANSCRIPT_CAPTURE_KEY}
      return true
    })()`
  ).catch(() => undefined)
}

async function readBoundedJsonReceipt(filePath, label) {
  const receipt = await readStableRegularFile(filePath, label, { maxBytes: 16 * 1024 * 1024 })
  const raw = await fsPromises.readFile(filePath, 'utf8')
  const after = await readStableRegularFile(filePath, label, { maxBytes: 16 * 1024 * 1024 })
  if (!sameIdentity(receipt.identity, after.identity) || receipt.sha256 !== after.sha256) {
    throw new Error(`${label} changed while being read`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
  return { ...receipt, parsed }
}

function assertVerifiedWatchdogReceipt(receipt, terminal, electron) {
  if (receipt?.schemaVersion !== 2 || receipt?.kind !== 'taskwraith-studio-acceptance-watchdog') {
    throw new Error('watchdog receipt schema or kind is not trusted')
  }
  assertCleanWatchdogTerminal(receipt)
  assertCleanWatchdogTerminal(terminal)
  for (const key of ['status', 'reason', 'groupExitVerified', 'detachedGroupExitVerified']) {
    if (terminal[key] !== receipt[key])
      throw new Error(`watchdog terminal ${key} does not match receipt`)
  }
  if (terminal.childPid !== receipt.childPid || terminal.childPgid !== receipt.childPgid) {
    throw new Error('watchdog terminal child pid/pgid does not match receipt')
  }
  if (
    !Number.isSafeInteger(electron?.pid) ||
    !Number.isSafeInteger(electron?.pgid) ||
    receipt.childPid !== electron.pid ||
    receipt.childPgid !== electron.pgid
  ) {
    throw new Error('watchdog receipt child pid/pgid does not match exact harness child')
  }
  return receipt
}

async function sealTranscriptFailureEvidence(options) {
  const { plan, fixture, result } = options
  const realArtifactRoot = await fsPromises.realpath(plan.artifactRoot)
  const artifactRootIdentity = await readStableDirectoryIdentity(realArtifactRoot, 'artifactRoot')
  const finalPath = path.join(realArtifactRoot, 'transcript-failure-evidence.json')
  try {
    await fsPromises.lstat(finalPath)
    throw new Error('runner-owned final transcript evidence already exists')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const harnessEvidence = await readBoundedJsonReceipt(
    plan.evidencePath,
    'harness acceptance evidence'
  )
  const watchdog = await readBoundedJsonReceipt(plan.receiptPath, 'watchdog receipt')
  const fixtureManifest = await readBoundedJsonReceipt(fixture.manifestPath, 'fixture manifest')
  validateNoAudioManifest(fixtureManifest.parsed, {
    durationSeconds: fixture.durationSeconds,
    outputPath: fixture.outputPath,
    manifestPath: fixture.manifestPath
  })
  const fixtureOutput = await readStableRegularFile(fixture.outputPath, 'fixture output', {
    maxBytes: MAX_FIXTURE_BYTES
  })
  if (
    fixtureManifest.parsed.outputSha256 !== fixtureOutput.sha256 ||
    fixtureManifest.parsed.outputByteLength !== fixtureOutput.byteLength ||
    fixtureManifest.parsed.outputPath !== fixture.outputPath
  ) {
    throw new Error('fixture manifest and output custody do not agree')
  }
  const runnerPath = path.join(
    plan.repoRoot,
    'scripts',
    'studio-transcript-failure-live-runner.cjs'
  )
  const runnerReceipt = await readStableRegularFile(runnerPath, 'negative transcript runner')
  const gitReceipt = await execFilePromise('git', ['rev-parse', 'HEAD'], {
    cwd: plan.repoRoot,
    timeout: 30_000,
    maxBuffer: 4 * 1024
  })
  const gitHead = String(gitReceipt.stdout || '').trim()
  if (!/^[a-f0-9]{40,64}$/.test(gitHead)) throw new Error('git HEAD receipt is invalid')
  const journey = result?.evidence?.journey
  if (!journey || !journey.statusHistory || !journey.journal) {
    throw new Error('harness result omitted the in-journey negative transcript proof')
  }
  const receipt = watchdog.parsed
  assertVerifiedWatchdogReceipt(receipt, result.evidence.watchdogTerminal, result.evidence.electron)
  const assetId = fixtureAssetId(fixture)
  const assetPath = materializedFixtureAssetPath(plan, fixture)
  const postReapProof = await provePostReapJournal({
    plan,
    assetId,
    assetPath,
    readJournalOperations: options.readJournalOperations,
    sleep: options.sleep
  })
  await assertStableDirectoryIdentity(realArtifactRoot, artifactRootIdentity, 'artifactRoot')
  const evidence = {
    schemaVersion: 1,
    kind: 'taskwraith-studio-transcript-failure-final-evidence',
    gitHead,
    runner: {
      workspaceRelativePath: 'scripts/studio-transcript-failure-live-runner.cjs',
      sha256: runnerReceipt.sha256,
      byteLength: runnerReceipt.byteLength
    },
    harnessEvidence: {
      path: plan.evidencePath,
      sha256: harnessEvidence.sha256,
      byteLength: harnessEvidence.byteLength
    },
    watchdog: {
      path: plan.receiptPath,
      sha256: watchdog.sha256,
      byteLength: watchdog.byteLength
    },
    fixture: {
      outputPath: fixture.outputPath,
      outputSha256: fixtureOutput.sha256,
      outputByteLength: fixtureOutput.byteLength,
      manifestPath: fixture.manifestPath,
      manifestSha256: fixtureManifest.sha256,
      manifestByteLength: fixtureManifest.byteLength,
      manifestOutputSha256: fixtureManifest.parsed.outputSha256,
      assetId,
      materializedAssetPath: assetPath
    },
    statusHistory: journey.statusHistory,
    inJourneyJournal: journey.journal,
    postReapJournal: {
      path: path.join(plan.studioStateDirectory, 'studio-project.journal.jsonl'),
      ...postReapProof
    },
    terminalFence: {
      harnessReturnedAfterWatchdogReap:
        receipt.status === 'reaped' &&
        receipt.reason === 'owner_requested' &&
        receipt.groupExitVerified === true &&
        receipt.detachedGroupExitVerified === true,
      status: receipt.status,
      reason: receipt.reason,
      groupExitVerified: receipt.groupExitVerified,
      detachedGroupExitVerified: receipt.detachedGroupExitVerified,
      childPid: receipt.childPid,
      childPgid: receipt.childPgid
    }
  }
  const encoded = `${JSON.stringify(evidence, null, 2)}\n`
  const tempPath = `${finalPath}.tmp-${process.pid}`
  try {
    await fsPromises.writeFile(tempPath, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fsPromises.link(tempPath, finalPath)
    await assertStableDirectoryIdentity(realArtifactRoot, artifactRootIdentity, 'artifactRoot')
  } finally {
    await fsPromises.rm(tempPath, { force: true }).catch(() => undefined)
  }
  const sealed = await readStableRegularFile(finalPath, 'final transcript failure evidence', {
    maxBytes: 16 * 1024 * 1024
  })
  if (sealed.sha256 !== sha256Text(encoded))
    throw new Error('final transcript evidence hash changed after sealing')
  return { path: finalPath, sha256: sealed.sha256, byteLength: sealed.byteLength, evidence }
}

function parseTranscriptFailureArgs(argv = []) {
  const parsed = {
    launch: false,
    acceptLaunch: false,
    ownerConfirmsOrphansCleared: false,
    pretty: false,
    instanceId: null,
    artifactRoot: null,
    packagedExecutablePath: null,
    repoRoot: path.resolve(__dirname, '..'),
    durationSeconds: FIXTURE_DURATION_SECONDS,
    timeoutMs: 180_000,
    transcriptTimeoutMs: 120_000
  }
  for (const argument of argv) {
    if (argument === '--launch') parsed.launch = true
    else if (argument === '--i-accept-studio-isolated-launch') parsed.acceptLaunch = true
    else if (argument === '--owner-confirms-existing-orphans-cleared') {
      parsed.ownerConfirmsOrphansCleared = true
    } else if (argument === '--pretty') parsed.pretty = true
    else if (argument.startsWith('--instance-id=')) parsed.instanceId = argument.slice(14)
    else if (argument.startsWith('--artifact-root=')) parsed.artifactRoot = argument.slice(16)
    else if (argument.startsWith('--packaged-executable=')) {
      parsed.packagedExecutablePath = argument.slice('--packaged-executable='.length)
    } else if (argument.startsWith('--repo-root='))
      parsed.repoRoot = path.resolve(argument.slice(12))
    else if (argument.startsWith('--duration-seconds=')) {
      parsed.durationSeconds = Number(argument.slice('--duration-seconds='.length))
    } else if (argument.startsWith('--timeout-ms=')) parsed.timeoutMs = Number(argument.slice(13))
    else if (argument.startsWith('--transcript-timeout-ms=')) {
      parsed.transcriptTimeoutMs = Number(argument.slice(24))
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (parsed.instanceId !== null && !INSTANCE_PATTERN.test(parsed.instanceId)) {
    throw new Error('instanceId must be a sanitized 2–16 character identifier')
  }
  assertPositiveDuration(parsed.durationSeconds)
  boundedArtifactRoot(
    parsed.artifactRoot ||
      path.join(parsed.repoRoot, '.local-only', 'taskwraith-studio', 'negative')
  )
  return parsed
}

async function runTranscriptFailureAcceptance(options = {}, adapters = {}) {
  const config = options.argv
    ? parseTranscriptFailureArgs(options.argv)
    : {
        launch: false,
        acceptLaunch: false,
        ownerConfirmsOrphansCleared: false,
        pretty: false,
        repoRoot: path.resolve(__dirname, '..'),
        durationSeconds: FIXTURE_DURATION_SECONDS,
        timeoutMs: 180_000,
        transcriptTimeoutMs: 120_000,
        ...options
      }
  const artifactRoot = boundedArtifactRoot(
    config.artifactRoot ||
      path.join(
        path.resolve(config.repoRoot || path.join(__dirname, '..')),
        '.local-only',
        'taskwraith-studio',
        'acceptance',
        config.instanceId || `transcriptFailure${process.pid}`
      )
  )
  const instanceId = config.instanceId || `transcriptF${process.pid}`.slice(0, 16)
  const planOptions = {
    repoRoot: config.repoRoot,
    artifactRoot,
    instanceId,
    transcriptTimeoutMs: config.transcriptTimeoutMs,
    packagedExecutablePath: config.packagedExecutablePath
  }
  const plan = buildStudioAcceptancePlan(planOptions)
  if (
    config.launch &&
    (!Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs < 30_000 ||
      config.timeoutMs > 1_800_000)
  ) {
    throw new Error('timeoutMs must be an integer from 30000 to 1800000 before fixture generation')
  }
  if (
    !Number.isSafeInteger(config.transcriptTimeoutMs) ||
    config.transcriptTimeoutMs < 1_000 ||
    config.transcriptTimeoutMs > 1_800_000 ||
    (config.launch && config.transcriptTimeoutMs > config.timeoutMs)
  ) {
    throw new Error('transcriptTimeoutMs is outside the bounded launch range')
  }
  const fixturePlan = {
    durationSeconds: config.durationSeconds,
    expectedFrameCount: config.durationSeconds * FIXTURE_FRAME_RATE,
    frameRate: FIXTURE_FRAME_RATE,
    size: FIXTURE_SIZE,
    mimeType: 'video/mp4',
    provenanceNote: FIXTURE_PROVENANCE_NOTE,
    outputPath: path.join(artifactRoot, 'fixtures', 'acceptance-no-audio.mp4'),
    manifestPath: path.join(artifactRoot, 'fixtures', 'no-audio-fixture-manifest.json')
  }
  try {
    await fsPromises.lstat(path.join(artifactRoot, 'transcript-failure-evidence.json'))
    throw new Error(
      'runner-owned final transcript evidence already exists; require a fresh artifact root'
    )
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!config.launch) {
    return {
      launched: false,
      pretty: config.pretty === true,
      plan,
      fixturePlan,
      authorization: { launch: false, reason: 'plan-only; --launch not supplied' },
      safety: {
        planOnlyByDefault: true,
        noAudioFixtureNotGenerated: true,
        noGuiProcessStarted: true,
        requiresExplicitLaunchInterlocks: true
      }
    }
  }
  if (!config.acceptLaunch || !config.ownerConfirmsOrphansCleared) {
    throw new Error(
      'Negative transcript launch requires --i-accept-studio-isolated-launch and --owner-confirms-existing-orphans-cleared'
    )
  }
  if (!config.packagedExecutablePath) {
    throw new Error('Negative transcript launch requires --packaged-executable')
  }
  const fixture = await (adapters.generateFixture || generateNoAudioFixture)(
    {
      artifactRoot,
      durationSeconds: config.durationSeconds
    },
    adapters.fixtureAdapters || {}
  )
  const acceptanceArgs = {
    launch: true,
    acceptLaunch: true,
    ownerConfirmsOrphansCleared: true,
    instanceId,
    packagedExecutablePath: config.packagedExecutablePath,
    mediaPath: fixture.outputPath,
    mimeType: 'video/mp4',
    generateSpeechFixture: false,
    timeoutMs: config.timeoutMs,
    transcriptTimeoutMs: config.transcriptTimeoutMs
  }
  const runAcceptance = adapters.runStudioAcceptance || runStudioAcceptance
  let transcriptCapture = null
  const baseInvokeOpen = adapters.invokeStudioOpen || invokeAuthorizedStudioOpen
  const invokeOpenWithCapture = async (renderer, asset, openOptions) => {
    transcriptCapture = await installTranscriptStatusCapture(
      renderer,
      adapters.evaluateByValue || evaluateByValue
    )
    transcriptCapture.openStartedAt = Date.now()
    transcriptCapture.floorAt = transcriptCapture.openStartedAt
    try {
      return await baseInvokeOpen(renderer, asset, openOptions)
    } finally {
      transcriptCapture.openCompletedAt = Date.now()
    }
  }
  let result
  let finalEvidence
  try {
    result = await runAcceptance(acceptanceArgs, {
      planOptions,
      invokeStudioOpen: invokeOpenWithCapture,
      driveUiJourney: async (acceptancePlan, target, journeyAdapters) => {
        try {
          return await (adapters.driveJourney || driveNegativeTranscriptJourney)(
            acceptancePlan,
            { ...target, fixture, transcriptCapture },
            {
              ...journeyAdapters,
              readTranscriptHistory: () =>
                readTranscriptStatusCapture(
                  transcriptCapture,
                  adapters.evaluateByValue || evaluateByValue
                ),
              readJournalOperations:
                adapters.readJournalOperations || journeyAdapters.readJournalOperations,
              sleep: adapters.sleep || journeyAdapters.sleep,
              waitFor: journeyAdapters.waitFor || adapters.waitFor
            }
          )
        } finally {
          await removeTranscriptStatusCapture(
            transcriptCapture,
            adapters.evaluateByValue || evaluateByValue
          )
        }
      }
    })
    finalEvidence = await (adapters.sealFinalEvidence || sealTranscriptFailureEvidence)({
      plan: buildStudioAcceptancePlan(planOptions),
      fixture,
      result
    })
  } finally {
    await removeTranscriptStatusCapture(
      transcriptCapture,
      adapters.evaluateByValue || evaluateByValue
    )
  }
  return {
    ...result,
    pretty: config.pretty === true,
    negativeFixture: fixture,
    finalEvidence,
    negativeTranscript: true
  }
}

async function main(argv = process.argv.slice(2)) {
  const result = await runTranscriptFailureAcceptance({ argv })
  process.stdout.write(`${JSON.stringify(result, null, result.pretty ? 2 : 0)}\n`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[studio-transcript-failure] FAIL — ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  FIXTURE_DURATION_SECONDS,
  FIXTURE_FRAME_RATE,
  FIXTURE_SIZE,
  EXPECTED_FAILURE_CODE,
  FIXTURE_PROVENANCE_NOTE,
  MAX_FIXTURE_BYTES,
  boundedArtifactRoot,
  buildNoAudioFixtureCommand,
  buildNoAudioProbeCommand,
  parseNoAudioProbe,
  assertSafeFixtureFile,
  assertStableFixtureIdentity,
  validateNoAudioManifest,
  generateNoAudioFixture,
  assertTypedTranscriptStatus,
  assertUnavailableTranscriptStatus,
  assertTranscriptStatusHistory,
  waitForUnavailableTranscriptStatus,
  assertTargetMatchesFixture,
  sealTranscriptFailureEvidence,
  assertVerifiedWatchdogReceipt,
  proveNoTranscriptJournal,
  provePostReapJournal,
  driveNegativeTranscriptJourney,
  parseTranscriptFailureArgs,
  runTranscriptFailureAcceptance,
  sha256Text
}
