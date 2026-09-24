#!/usr/bin/env node
'use strict'

/**
 * Plan-only-by-default packaged Outcome 3/4 acceptance.
 *
 * The existing acceptance harness owns LaunchServices, the disposable profile,
 * custody, watchdog teardown, and the exact UI driver. This runner owns the
 * two-asset fixture contract and the review/route evidence schema. The default
 * live journey composes the tracked base UI journey with exact proposal,
 * review-range, route-resource, inspector, and playback observations; any
 * unavailable observation remains a hard refusal rather than synthetic evidence.
 */

const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')

const harness = require('./studio-acceptance-harness.cjs')
const acceptanceSession = require('./studio-acceptance-session.cjs')
const diagnostics = require('./studio-bounded-diagnostics-runner.cjs')
const pixels = require('./studio-pixel-evidence-verifier.cjs')
const { resolveMediaTool } = require('./studio-lut-acceptance-runner.cjs')
const {
  attachMainInspectorSession,
  attachRendererCdpSession,
  discoverMainInspectorUrl
} = require('./perf/cdpWebSocketSession.cjs')

const KIND = 'taskwraith-studio-review-route-lifecycle'
const SCHEMA_VERSION = 1
const DEFAULT_DURATION_SECONDS = 8
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1_000
const MAX_DURATION_SECONDS = 30
const MAX_FIXTURE_BYTES = 512 * 1024 * 1024
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024
const ACCEPTANCE_ROOT = path.join(
  path.resolve(__dirname, '..'),
  '.local-only',
  'taskwraith-studio',
  'acceptance'
)
const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{1,15}$/
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const RATIONAL_KEYS = ['d', 'n']
const INSERT_KEYS = ['assetId', 'at', 'itemId', 'sourceIn', 'sourceOut', 'type']
const RESOURCE_KEYS = [
  'activeSourceCount',
  'cacheHits',
  'ioSurfaceIds',
  'players',
  'retainedFrameCount',
  'textures'
]
const ROUTE_RESOURCE_KEYS = [...RESOURCE_KEYS, 'process', 'routeOwnership']
const ROUTE_SEQUENCE = [
  ['source', 'timeline'],
  ['timeline', 'source'],
  ['source', 'timeline'],
  ['timeline', 'source']
]

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

function originallyAbsolute(value, label) {
  const raw = String(value || '')
  invariant(path.isAbsolute(raw), `${label} must be originally absolute`)
  const resolved = path.resolve(raw)
  invariant(resolved !== path.parse(resolved).root, `${label} must not be filesystem root`)
  return resolved
}

function safeInstanceId(value) {
  const id = String(value || '')
  invariant(INSTANCE_PATTERN.test(id), 'instanceId must be a 2–16 character lowercase identifier')
  return id
}

function boundedInteger(value, label, minimum, maximum) {
  const number = Number(value)
  invariant(
    Number.isSafeInteger(number) && number >= minimum && number <= maximum,
    `${label} must be an integer from ${minimum} to ${maximum}`
  )
  return number
}

function artifactRootFor(instanceId, value) {
  const root = originallyAbsolute(value, 'artifactRoot')
  const relative = path.relative(ACCEPTANCE_ROOT, root)
  invariant(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'artifactRoot escaped acceptance custody'
  )
  invariant(path.basename(root) === instanceId, 'artifactRoot basename must equal instanceId')
  return root
}

function buildFixtureCommand({
  outputPath,
  variant,
  durationSeconds = DEFAULT_DURATION_SECONDS,
  ffmpegPath = 'ffmpeg'
}) {
  const output = originallyAbsolute(outputPath, 'fixture outputPath')
  const duration = boundedInteger(durationSeconds, 'durationSeconds', 1, MAX_DURATION_SECONDS)
  invariant(variant === 'primary' || variant === 'secondary', 'fixture variant is invalid')
  const source =
    variant === 'primary' ? 'testsrc2=size=640x360:rate=30' : 'smptebars=size=640x360:rate=30'
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
    source,
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

function buildFixtureProbeCommand({ outputPath, ffprobePath = 'ffprobe' }) {
  const output = originallyAbsolute(outputPath, 'fixture probe outputPath')
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

function parseFixtureProbe(stdout, durationSeconds) {
  let parsed
  try {
    parsed = JSON.parse(String(stdout || ''))
  } catch (error) {
    throw new Error(`fixture ffprobe output is not valid JSON: ${error.message}`)
  }
  invariant(
    isRecord(parsed) && Array.isArray(parsed.streams) && parsed.streams.length === 1,
    'fixture ffprobe must contain exactly one stream'
  )
  const stream = parsed.streams[0]
  const frameCount = Number(stream.nb_read_frames)
  const duration = Number(stream.duration || parsed.format?.duration)
  invariant(
    stream.codec_type === 'video' &&
      Number(stream.width) === 640 &&
      Number(stream.height) === 360 &&
      String(stream.r_frame_rate) === '30/1' &&
      Number.isSafeInteger(frameCount) &&
      frameCount === durationSeconds * 30 &&
      Number.isFinite(duration) &&
      Math.abs(duration - durationSeconds) <= 1 / 30,
    'fixture ffprobe does not match the exact deterministic contract'
  )
  return {
    streamCount: 1,
    videoStreamCount: 1,
    audioStreamCount: 0,
    width: 640,
    height: 360,
    frameRate: '30/1',
    durationSeconds: duration,
    frameCount
  }
}

function parseSpeechFixtureProbe(stdout, durationSeconds) {
  let parsed
  try {
    parsed = JSON.parse(String(stdout || ''))
  } catch (error) {
    throw new Error(`speech fixture ffprobe output is not valid JSON: ${error.message}`)
  }
  invariant(isRecord(parsed) && Array.isArray(parsed.streams), 'speech fixture streams are absent')
  const video = parsed.streams.filter((stream) => stream.codec_type === 'video')
  const audio = parsed.streams.filter((stream) => stream.codec_type === 'audio')
  invariant(
    video.length === 1 && audio.length === 1,
    'speech fixture requires one video and one audio stream'
  )
  const frameCount = Number(video[0].nb_read_frames)
  const formatDuration = Number(parsed.format?.duration)
  const videoDuration = Number(video[0].duration || formatDuration)
  const audioDuration = Number(audio[0].duration || formatDuration)
  invariant(
    Number(video[0].width) === 640 &&
      Number(video[0].height) === 360 &&
      String(video[0].r_frame_rate) === '30/1' &&
      frameCount === durationSeconds * 30 &&
      [formatDuration, videoDuration, audioDuration].every(
        (duration) => Number.isFinite(duration) && Math.abs(duration - durationSeconds) <= 1 / 30
      ),
    'speech fixture probe does not match configured duration/video/audio facts'
  )
  return {
    streamCount: parsed.streams.length,
    videoStreamCount: 1,
    audioStreamCount: 1,
    width: 640,
    height: 360,
    frameRate: '30/1',
    frameCount,
    durationSeconds: formatDuration,
    videoDurationSeconds: videoDuration,
    audioDurationSeconds: audioDuration
  }
}

function exactExecutionReceipt(executable, args, result) {
  const stdout = String(result?.stdout || '')
  const stderr = String(result?.stderr || '')
  return {
    executable,
    args: [...args],
    exitCode: 0,
    stdoutByteLength: Buffer.byteLength(stdout),
    stdoutSha256: sha256Bytes(Buffer.from(stdout)),
    stderrByteLength: Buffer.byteLength(stderr),
    stderrSha256: sha256Bytes(Buffer.from(stderr))
  }
}

function execFilePromise(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      } else resolve({ stdout, stderr })
    })
  })
}

async function assertRegularFile(filePath, label) {
  const stat = await fsPromises.lstat(filePath)
  invariant(
    !stat.isSymbolicLink() && stat.isFile() && stat.size > 0,
    `${label} is not a safe regular file`
  )
  invariant(stat.size <= MAX_FIXTURE_BYTES, `${label} exceeds the shared media byte cap`)
  return stat
}

async function generateReviewFixtures(options = {}, adapters = {}) {
  const artifactRoot = originallyAbsolute(options.artifactRoot, 'artifactRoot')
  const durationSeconds = boundedInteger(
    options.durationSeconds ?? DEFAULT_DURATION_SECONDS,
    'durationSeconds',
    1,
    MAX_DURATION_SECONDS
  )
  const fixtureRoot = path.join(artifactRoot, 'review-fixtures')
  await fsPromises.mkdir(fixtureRoot, { recursive: true, mode: 0o700 })
  const resolveTool = adapters.resolveMediaTool || resolveMediaTool
  const ffmpegPath = await (adapters.realpathTool || fsPromises.realpath)(resolveTool('ffmpeg'))
  const ffprobePath = await (adapters.realpathTool || fsPromises.realpath)(resolveTool('ffprobe'))
  invariant(
    path.isAbsolute(ffmpegPath) && path.isAbsolute(ffprobePath),
    'media tools must resolve to absolute paths'
  )
  const run = adapters.execFile || execFilePromise
  const assets = {}
  for (const variant of ['primary', 'secondary']) {
    const outputPath = path.join(fixtureRoot, `${variant}.mp4`)
    const manifestPath = path.join(fixtureRoot, `${variant}.json`)
    for (const candidate of [outputPath, manifestPath]) {
      await fsPromises.lstat(candidate).then(
        () => {
          throw new Error(
            `review fixture already exists; require a fresh artifact root: ${candidate}`
          )
        },
        (error) => {
          if (error.code !== 'ENOENT') throw error
        }
      )
    }
    const ffmpegCommand = buildFixtureCommand({ outputPath, variant, durationSeconds, ffmpegPath })
    const ffprobeCommand = buildFixtureProbeCommand({ outputPath, ffprobePath })
    await run(ffmpegPath, ffmpegCommand.slice(1), {
      timeout: 10 * 60 * 1_000,
      maxBuffer: 1 * 1024 * 1024
    })
    const stat = await assertRegularFile(outputPath, `${variant} fixture`)
    const probe = parseFixtureProbe(
      (await run(ffprobePath, ffprobeCommand.slice(1), { timeout: 30_000, maxBuffer: 64 * 1024 }))
        .stdout,
      durationSeconds
    )
    const outputSha256 = await sha256File(outputPath)
    const manifest = {
      schemaVersion: 1,
      kind: 'taskwraith-studio-review-route-fixture',
      variant,
      durationSeconds,
      outputPath,
      outputSha256,
      outputByteLength: stat.size,
      ffmpegCommand,
      ffprobeCommand,
      probe
    }
    const encoded = `${JSON.stringify(manifest, null, 2)}\n`
    await fsPromises.writeFile(manifestPath, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    assets[variant] = { ...manifest, manifestPath }
  }
  invariant(
    assets.primary.outputSha256 !== assets.secondary.outputSha256,
    'deterministic review fixtures are not distinct'
  )
  return { fixtureRoot, assets }
}

async function generateReviewSpeechFixtures(options = {}, adapters = {}) {
  const artifactRoot = originallyAbsolute(options.artifactRoot, 'artifactRoot')
  const durationSeconds = boundedInteger(
    options.durationSeconds ?? DEFAULT_DURATION_SECONDS,
    'durationSeconds',
    1,
    MAX_DURATION_SECONDS
  )
  const speechBase = await (
    adapters.generateSpeechFixture || harness.generateAcceptanceSpeechFixture
  )({ artifactRoot }, adapters.speechFixtureAdapters || {})
  const fixtureRoot = path.join(artifactRoot, 'review-fixtures')
  await fsPromises.mkdir(fixtureRoot, { recursive: true, mode: 0o700 })
  const ffmpegPath = await (adapters.realpathTool || fsPromises.realpath)(
    resolveMediaTool('ffmpeg')
  )
  const ffprobePath = await (adapters.realpathTool || fsPromises.realpath)(
    resolveMediaTool('ffprobe')
  )
  const run = adapters.execFile || execFilePromise
  const assets = {}
  for (const variant of ['primary', 'secondary']) {
    const outputPath = path.join(fixtureRoot, `${variant}-speech.mp4`)
    const manifestPath = path.join(fixtureRoot, `${variant}-speech.json`)
    // The 1920x1080 speech base and 640x360 review contract share a 16:9 aspect ratio.
    const filter =
      variant === 'secondary'
        ? 'scale=640:360:flags=lanczos,hue=h=45:s=1'
        : 'scale=640:360:flags=lanczos'
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-n',
      '-i',
      speechBase.outputPath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-vf',
      filter,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'copy',
      '-t',
      String(durationSeconds),
      '-map_metadata',
      '-1',
      '-movflags',
      '+faststart',
      outputPath
    ]
    const ffmpegResult = await run(ffmpegPath, ffmpegArgs, {
      timeout: 10 * 60 * 1_000,
      maxBuffer: 1 * 1024 * 1024
    })
    const stat = await assertRegularFile(outputPath, `${variant} speech fixture`)
    const ffprobeCommand = buildFixtureProbeCommand({ outputPath, ffprobePath })
    const ffprobeResult = await run(ffprobePath, ffprobeCommand.slice(1), {
      timeout: 30_000,
      maxBuffer: 64 * 1024
    })
    const probe = parseSpeechFixtureProbe(ffprobeResult.stdout, durationSeconds)
    const manifest = {
      schemaVersion: 1,
      kind: 'taskwraith-studio-review-route-speech-fixture',
      variant,
      visualFilter: filter,
      durationSeconds,
      frameRate: probe.frameRate,
      outputPath,
      outputSha256: await sha256File(outputPath),
      outputByteLength: stat.size,
      ffmpegCommand: [ffmpegPath, ...ffmpegArgs],
      ffmpegExecution: exactExecutionReceipt(ffmpegPath, ffmpegArgs, ffmpegResult),
      ffprobeCommand,
      ffprobeExecution: exactExecutionReceipt(ffprobePath, ffprobeCommand.slice(1), ffprobeResult),
      manifestPath,
      probe
    }
    await fsPromises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    assets[variant] = manifest
  }
  invariant(
    assets.primary.outputSha256 !== assets.secondary.outputSha256,
    'speech fixtures are not distinct'
  )
  return {
    fixtureRoot,
    speechBase,
    assets
  }
}

function fixtureAssetId(fixture) {
  invariant(/^[a-f0-9]{64}$/.test(fixture?.outputSha256 || ''), 'fixture outputSha256 is invalid')
  return Buffer.from(fixture.outputSha256, 'hex').toString('base64url')
}

function exactKeys(value, keys, label) {
  invariant(isRecord(value), `${label} is not an object`)
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    `${label} keys are not exact`
  )
}

function exactRational(value, label) {
  exactKeys(value, RATIONAL_KEYS, label)
  invariant(
    Number.isSafeInteger(value.n) && Number.isSafeInteger(value.d) && value.d > 0,
    `${label} is not an exact rational`
  )
  return value
}

function validateGhostDifferenceProof(proof, label) {
  exactKeys(
    proof,
    [
      'captureSha256',
      'comparison',
      'counterpartSha256',
      'kind',
      'region',
      'route',
      'schemaVersion'
    ],
    `${label} ghost-difference proof`
  )
  invariant(
    proof.schemaVersion === 1 &&
      proof.kind === 'taskwraith-studio-ghost-difference' &&
      proof.route === 'review' &&
      proof.region === 'review-host' &&
      proof.comparison?.ok === true &&
      proof.comparison.region === 'review-host' &&
      proof.comparison.beforeSha256 === proof.captureSha256 &&
      proof.comparison.afterSha256 === proof.counterpartSha256 &&
      /^[a-f0-9]{64}$/.test(proof.captureSha256) &&
      /^[a-f0-9]{64}$/.test(proof.counterpartSha256),
    `${label} ghost-difference pixels are not exact Green evidence`
  )
  return proof
}

function validateDecodedMaterialProof(proof, label) {
  exactKeys(
    proof,
    [
      'captureSha256',
      'capturePath',
      'comparison',
      'ffmpegExecution',
      'kind',
      'referenceSha256',
      'referencePath',
      'region',
      'route',
      'schemaVersion',
      'sourceAssetPath',
      'sourceAssetId',
      'sourcePtsSeconds'
    ],
    `${label} decoded-material proof`
  )
  exactKeys(
    proof.ffmpegExecution,
    [
      'args',
      'executable',
      'exitCode',
      'stderrByteLength',
      'stderrSha256',
      'stdoutByteLength',
      'stdoutSha256'
    ],
    `${label} ffmpeg execution`
  )
  const expectedFfmpeg = acceptanceSession.resolveMediaTool('ffmpeg')
  const expectedArgs = diagnostics.buildReferenceExtractCommand({
    assetPath: proof.sourceAssetPath,
    exactSourcePtsSeconds: proof.sourcePtsSeconds,
    referencePath: proof.referencePath
  })
  const metrics = proof.comparison?.metrics
  invariant(
    proof.schemaVersion === 1 &&
      proof.kind === 'taskwraith-studio-decoded-material' &&
      proof.route === 'review' &&
      proof.region === 'review-host' &&
      proof.comparison?.clean === true &&
      proof.comparison.capture?.path === proof.capturePath &&
      proof.comparison.capture?.sha256 === proof.captureSha256 &&
      proof.comparison.reference?.path === proof.referencePath &&
      proof.comparison.reference?.sha256 === proof.referenceSha256 &&
      isRecord(metrics) &&
      [
        'materialPixelCount',
        'meanAbsoluteChannelResidual',
        'p95ChannelResidual',
        'p99ChannelResidual',
        'maximumChannelResidual',
        'fractionAbove40',
        'fractionAbove80'
      ].every((key) => Number.isFinite(metrics[key])) &&
      proof.ffmpegExecution.exitCode === 0 &&
      Array.isArray(proof.ffmpegExecution.args) &&
      Number.isSafeInteger(proof.ffmpegExecution.stdoutByteLength) &&
      proof.ffmpegExecution.stdoutByteLength >= 0 &&
      Number.isSafeInteger(proof.ffmpegExecution.stderrByteLength) &&
      proof.ffmpegExecution.stderrByteLength >= 0 &&
      /^[a-f0-9]{64}$/.test(proof.ffmpegExecution.stdoutSha256) &&
      /^[a-f0-9]{64}$/.test(proof.ffmpegExecution.stderrSha256) &&
      proof.ffmpegExecution.executable === expectedFfmpeg &&
      JSON.stringify(proof.ffmpegExecution.args) === JSON.stringify(expectedArgs) &&
      path.isAbsolute(proof.capturePath) &&
      path.isAbsolute(proof.referencePath) &&
      path.isAbsolute(proof.sourceAssetPath) &&
      ASSET_ID_PATTERN.test(proof.sourceAssetId) &&
      Number.isFinite(proof.sourcePtsSeconds) &&
      /^[a-f0-9]{64}$/.test(proof.captureSha256) &&
      /^[a-f0-9]{64}$/.test(proof.referenceSha256),
    `${label} decoded-material pixels are not exact Green evidence`
  )
  return proof
}

function validateResource(resource, label, routeSpecific = false) {
  exactKeys(resource, routeSpecific ? ROUTE_RESOURCE_KEYS : RESOURCE_KEYS, label)
  invariant(
    Number.isSafeInteger(resource.activeSourceCount) && resource.activeSourceCount >= 0,
    `${label}.activeSourceCount is invalid`
  )
  invariant(
    Number.isSafeInteger(resource.retainedFrameCount) && resource.retainedFrameCount >= 0,
    `${label}.retainedFrameCount is invalid`
  )
  invariant(Array.isArray(resource.ioSurfaceIds), `${label}.ioSurfaceIds is absent`)
  for (const key of ['cacheHits', 'players', 'textures']) {
    invariant(
      Number.isSafeInteger(resource[key]) && resource[key] >= 0,
      `${label}.${key} is invalid`
    )
  }
  if (routeSpecific) {
    invariant(isRecord(resource.process), `${label}.process resource is absent`)
    for (const key of ['residentBytes', 'physicalFootprintBytes', 'mallocAllocatedBytes']) {
      invariant(
        Number.isSafeInteger(resource.process[key]) && resource.process[key] >= 0,
        `${label}.process.${key} is invalid`
      )
    }
    invariant(
      Array.isArray(resource.process.productSurfaceIds),
      `${label}.process.productSurfaceIds is absent`
    )
    exactKeys(
      resource.routeOwnership,
      ['activeSourceCount', 'ioSurfaceIds', 'retainedFrameCount', 'route'],
      `${label}.routeOwnership`
    )
    invariant(
      resource.routeOwnership.route === 'source' || resource.routeOwnership.route === 'review',
      `${label}.routeOwnership.route is invalid`
    )
    invariant(
      Number.isSafeInteger(resource.routeOwnership.activeSourceCount) &&
        resource.routeOwnership.activeSourceCount >= 0 &&
        Number.isSafeInteger(resource.routeOwnership.retainedFrameCount) &&
        resource.routeOwnership.retainedFrameCount >= 0 &&
        Array.isArray(resource.routeOwnership.ioSurfaceIds),
      `${label}.routeOwnership values are invalid`
    )
  }
  return resource
}

function validateReviewRouteJourney(evidence, assets) {
  invariant(
    isRecord(evidence) && evidence.schemaVersion === 1 && evidence.kind === `${KIND}-journey`,
    'review journey schema is invalid'
  )
  const primaryId = fixtureAssetId(assets.primary)
  const secondaryId = fixtureAssetId(assets.secondary)
  invariant(
    evidence.assetIds?.primary === primaryId && evidence.assetIds?.secondary === secondaryId,
    'review journey asset identities are wrong'
  )
  invariant(
    path.isAbsolute(evidence.assetPaths?.primary || '') &&
      path.isAbsolute(evidence.assetPaths?.secondary || '') &&
      evidence.assetPaths.primary !== evidence.assetPaths.secondary,
    'review journey exact materialized asset paths are absent'
  )
  invariant(
    [assets.primary, assets.secondary].every(
      (asset) =>
        asset.probe?.videoStreamCount === 1 &&
        asset.probe?.audioStreamCount === 1 &&
        asset.probe?.frameCount === asset.durationSeconds * 30 &&
        Math.abs(asset.probe.durationSeconds - asset.durationSeconds) <= 1 / 30
    ) && assets.primary.durationSeconds === assets.secondary.durationSeconds,
    'live review fixtures lack exact configured audio/video/duration probe facts'
  )
  const proposal = evidence.proposal
  invariant(
    proposal?.proposalFirst === true && proposal.op?.type === 'insert_range',
    'proposal-first insert evidence is absent'
  )
  exactKeys(proposal.op, INSERT_KEYS, 'insert_range operation')
  invariant(
    proposal.op.assetId === secondaryId,
    'insert_range did not target the distinct secondary asset'
  )
  const sourceIn = exactRational(proposal.op.sourceIn, 'insert_range.sourceIn')
  const sourceOut = exactRational(proposal.op.sourceOut, 'insert_range.sourceOut')
  const at = exactRational(proposal.op.at, 'insert_range.at')
  invariant(compareRational(sourceOut, sourceIn) > 0 && at.n >= 0, 'insert_range timing is invalid')
  invariant(proposal.visibleGhost === true, 'proposal ghost was not proven visible')
  validateGhostDifferenceProof(proposal.currentPixels, 'Current-at-cut')
  validateGhostDifferenceProof(proposal.proposedPixels, 'Proposed-at-cut')
  validateGhostDifferenceProof(proposal.ghostPixels, 'ghost')
  // The ghost proof runs pre-ghost baseline -> post-proposal Current. The two
  // version proofs must both be rooted in that same post-proposal Current
  // capture and mirror each other against the Proposed capture; a proof that
  // reaches back to the baseline lets the ghost alone manufacture a
  // Current/Proposed difference when switching versions changed nothing.
  invariant(
    proposal.currentPixels.captureSha256 === proposal.ghostPixels.counterpartSha256,
    'Current-at-cut pixels were not taken from the post-proposal Current capture'
  )
  invariant(
    proposal.currentPixels.captureSha256 !== proposal.currentPixels.counterpartSha256 &&
      proposal.proposedPixels.captureSha256 === proposal.currentPixels.counterpartSha256 &&
      proposal.proposedPixels.counterpartSha256 === proposal.currentPixels.captureSha256,
    'Current-at-cut and Proposed-at-cut pixels do not mirror the same two version captures'
  )

  const loop = evidence.reviewLoop
  invariant(
    loop?.exact === true && loop.route === 'review' && loop.active === true,
    'exact review loop evidence is absent'
  )
  for (const key of [
    'startTicks',
    'endTicks',
    'preRollTicks',
    'postRollTicks',
    'insertionStartTicks',
    'insertionEndTicks'
  ]) {
    invariant(Number.isSafeInteger(loop[key]) && loop[key] >= 0, `review loop ${key} is invalid`)
  }
  invariant(loop.endTicks > loop.startTicks, 'review loop endpoints are not ordered')
  invariant(
    loop.startTicks === Math.max(0, loop.insertionStartTicks - loop.preRollTicks),
    'review loop start does not prove pre-roll'
  )
  invariant(
    loop.endTicks === loop.insertionEndTicks + loop.postRollTicks,
    'review loop end does not prove post-roll'
  )
  invariant(
    loop.endpointObservation === 'exact-accessibility',
    'review loop endpoints are not exact accessibility observations'
  )

  const acceptance = evidence.acceptance
  invariant(
    acceptance?.decision === 'accept' && acceptance.proposalId === proposal.proposalId,
    'accepted proposal evidence is absent'
  )
  invariant(
    Number.isSafeInteger(acceptance.resolutionRevision) &&
      acceptance.resolutionRevision > proposal.proposalRevision,
    'acceptance revision is invalid'
  )
  const restart = acceptance.restart
  const exactProcessReceipt = (processReceipt) =>
    isRecord(processReceipt) &&
    Number.isSafeInteger(processReceipt.pid) &&
    processReceipt.pid > 0 &&
    Number.isSafeInteger(processReceipt.ppid) &&
    processReceipt.ppid > 0 &&
    Number.isSafeInteger(processReceipt.pgid) &&
    processReceipt.pgid > 0 &&
    typeof processReceipt.command === 'string' &&
    processReceipt.command.length > 0 &&
    typeof processReceipt.expectedExecutable === 'string' &&
    path.isAbsolute(processReceipt.expectedExecutable)
  invariant(
    isRecord(restart) &&
      restart.acceptedRevision === acceptance.resolutionRevision &&
      exactProcessReceipt(restart.oldProcess) &&
      exactProcessReceipt(restart.replacement) &&
      restart.oldProcess?.pid !== restart.replacement?.pid &&
      restart.oldProcess?.ppid === restart.replacement?.ppid &&
      restart.oldProcess?.pgid === restart.replacement?.pgid &&
      restart.oldProcess?.expectedExecutable === restart.replacement?.expectedExecutable &&
      restart.oldProcess?.command === restart.replacement?.command &&
      Array.isArray(restart.hydrationOrder) &&
      restart.hydrationOrder.length === 3 &&
      restart.hydrationOrder[0] < restart.hydrationOrder[1] &&
      restart.hydrationOrder[1] < restart.hydrationOrder[2] &&
      /^[a-f0-9]{64}$/.test(restart.journalBefore?.sha256 || '') &&
      /^[a-f0-9]{64}$/.test(restart.journalAfter?.sha256 || '') &&
      Number.isSafeInteger(restart.journalBefore?.byteLength) &&
      restart.journalBefore.byteLength > 0 &&
      Number.isSafeInteger(restart.journalAfter?.byteLength) &&
      restart.journalAfter.byteLength > 0 &&
      Number.isSafeInteger(restart.journalBefore?.revision) &&
      Number.isSafeInteger(restart.journalAfter?.revision) &&
      restart.journalBefore?.revision === acceptance.resolutionRevision &&
      restart.journalAfter?.revision === acceptance.resolutionRevision &&
      restart.journalBefore?.sha256 === restart.journalAfter?.sha256 &&
      restart.journalBefore?.byteLength === restart.journalAfter?.byteLength &&
      restart.windowAbsence?.schemaVersion === 1 &&
      restart.windowAbsence?.kind === 'taskwraith-studio-zero-hydration-window' &&
      restart.windowAbsence?.exactPid === restart.replacement.pid &&
      restart.windowAbsence?.visibleWindowCount === 0 &&
      /^[a-f0-9]{64}$/.test(restart.supervisor?.beforeSha256 || '') &&
      /^[a-f0-9]{64}$/.test(restart.supervisor?.afterSha256 || '') &&
      restart.supervisor?.beforeSha256 === restart.supervisor?.afterSha256,
    'accepted restart custody is incomplete or inconsistent'
  )
  invariant(
    Array.isArray(acceptance.committedSequence) && acceptance.committedSequence.length >= 2,
    'committed multi-asset sequence is absent'
  )
  const sequenceAssets = new Set(acceptance.committedSequence.map((item) => item.assetId))
  invariant(
    sequenceAssets.has(primaryId) && sequenceAssets.has(secondaryId),
    'committed sequence does not contain both exact assets'
  )
  const sequencePrimary = acceptance.committedSequence.find((item) => item.assetId === primaryId)
  const sequenceSecondary = acceptance.committedSequence.find(
    (item) => item.assetId === secondaryId
  )
  invariant(
    isRecord(sequencePrimary) &&
      isRecord(sequenceSecondary) &&
      isRecord(sequencePrimary.position) &&
      isRecord(sequencePrimary.duration) &&
      isRecord(sequencePrimary.sourceIn) &&
      isRecord(sequenceSecondary.position) &&
      isRecord(sequenceSecondary.sourceIn),
    'committed sequence item timing is absent'
  )
  invariant(
    sameRational(
      addRational(sequencePrimary.position, sequencePrimary.duration),
      sequenceSecondary.position
    ),
    'committed sequence does not prove contiguous primary then secondary items'
  )

  const crossing = evidence.playbackCrossing
  invariant(
    crossing?.route === 'review' && crossing.sharedClock?.ok === true,
    'committed Review playback crossing is absent'
  )
  for (const key of [
    'sourceBeforeTicks',
    'sourceAfterTicks',
    'reviewBeforeTicks',
    'reviewAfterTicks'
  ]) {
    invariant(
      Number.isSafeInteger(crossing.sharedClock[key]),
      `Review shared clock ${key} is absent`
    )
  }
  invariant(
    Array.isArray(crossing.samples) && crossing.samples.length >= 2,
    'Review playback crossing samples are absent'
  )
  const first = crossing.samples[0]
  const last = crossing.samples.at(-1)
  invariant(
    first.assetId === primaryId && last.assetId === secondaryId,
    'Review playback did not cross primary to secondary asset'
  )
  validateDecodedMaterialProof(first.pixels, 'Review primary crossing')
  validateDecodedMaterialProof(last.pixels, 'Review secondary crossing')
  invariant(
    first.pixels.sourceAssetId === primaryId &&
      last.pixels.sourceAssetId === secondaryId &&
      first.pixels.sourceAssetPath === evidence.assetPaths.primary &&
      last.pixels.sourceAssetPath === evidence.assetPaths.secondary,
    'Review decoded material proofs are mapped to the wrong source assets'
  )
  invariant(
    Number.isSafeInteger(crossing.viewerTimescale) && crossing.viewerTimescale > 0,
    'Review crossing viewer timescale is absent'
  )
  const sourceSecondsAt = (item, positionTicks) =>
    item.sourceIn.n / item.sourceIn.d +
    (positionTicks - rationalToTicks(item.position, crossing.viewerTimescale)) /
      crossing.viewerTimescale
  invariant(
    Math.abs(
      first.pixels.sourcePtsSeconds - sourceSecondsAt(sequencePrimary, first.positionTicks)
    ) <= Number.EPSILON &&
      Math.abs(
        last.pixels.sourcePtsSeconds - sourceSecondsAt(sequenceSecondary, last.positionTicks)
      ) <= Number.EPSILON,
    'Review decoded material source PTS mapping is not exact'
  )
  invariant(
    first.positionTicks < crossing.cutTicks && last.positionTicks >= crossing.cutTicks,
    'Review crossing positions do not straddle the cut'
  )

  invariant(
    Array.isArray(evidence.routeTransitions) && evidence.routeTransitions.length === 4,
    'exactly four route transitions are required'
  )
  evidence.routeTransitions.forEach((transition, index) => {
    const [from, to] = ROUTE_SEQUENCE[index]
    invariant(
      transition.transition?.from === from && transition.transition?.to === to,
      `route transition ${index} is not the exact Source/Timeline sequence`
    )
    invariant(
      transition.transition.accessibilityAction === 'AXPress',
      `route transition ${index} is not AXPress`
    )
    invariant(
      transition.sharedClock?.ok === true,
      `route transition ${index} lacks exact shared-clock evidence`
    )
    const routeAction = transition.sharedClock.routeAction
    invariant(
      routeAction?.type === 'press-workspace-route' &&
        routeAction.accessibilityAction === 'AXPress' &&
        routeAction.accessibilityIdentifier?.endsWith(`.route.${to}`) &&
        routeAction.pairedAccessibilityIdentifier?.endsWith(`.route.${from}`) &&
        routeAction.routeValueBefore === 'not selected' &&
        routeAction.routeValueAfter === 'selected' &&
        routeAction.pairedRouteValueBefore === 'selected' &&
        routeAction.pairedRouteValueAfter === 'selected',
      `route transition ${index} lacks the exact AX route receipt`
    )
    for (const key of ['fromBeforeTicks', 'fromAfterTicks', 'toBeforeTicks', 'toAfterTicks']) {
      invariant(
        Number.isSafeInteger(transition.sharedClock[key]),
        `route transition ${index} shared clock ${key} is absent`
      )
    }
    invariant(
      transition.sharedClock.fromAfterTicks === transition.sharedClock.toBeforeTicks &&
        transition.sharedClock.toAfterTicks === transition.sharedClock.fromBeforeTicks,
      `route transition ${index} shared-clock positions do not cancel exactly`
    )
    invariant(
      transition.content?.before?.route === from && transition.content?.after?.route === to,
      `route transition ${index} lacks route-specific content`
    )
    if (from === 'source') {
      invariant(
        transition.content.before.sourceIndependent === true,
        `route transition ${index} lacks Source independence semantics`
      )
    } else {
      invariant(
        transition.content.before.timelineContentVisible === true,
        `route transition ${index} lacks Timeline content semantics`
      )
    }
    if (to === 'source') {
      invariant(
        transition.content.after.sourceIndependent === true &&
          transition.content.after.ghostsVisible === false,
        `route transition ${index} lacks clean Source semantics`
      )
    } else {
      invariant(
        transition.content.after.timelineContentVisible === true,
        `route transition ${index} lacks Timeline content semantics`
      )
    }
    validateResource(transition.resources.before, `route ${index} before resource`, true)
    validateResource(transition.resources.hidden, `route ${index} hidden resource`, true)
    validateResource(transition.resources.after, `route ${index} after resource`, true)
    invariant(
      transition.resources.before.routeOwnership.route ===
        (from === 'source' ? 'source' : 'review') &&
        transition.resources.hidden.routeOwnership.route ===
          (from === 'source' ? 'source' : 'review') &&
        transition.resources.after.routeOwnership.route === (to === 'source' ? 'source' : 'review'),
      `route transition ${index} resource ownership route is not exact`
    )
    invariant(
      transition.resources.hiddenRouteDetached === true,
      `route transition ${index} did not prove hidden-route detach`
    )
    invariant(
      transition.resources.hidden.routeOwnership.activeSourceCount === 0 &&
        transition.resources.hidden.routeOwnership.retainedFrameCount === 0 &&
        transition.resources.hidden.routeOwnership.ioSurfaceIds.length === 0,
      `route transition ${index} did not release hidden-route resources`
    )
  })
  return { ...evidence, normalized: { primaryId, secondaryId, sourceIn, sourceOut, at } }
}

function assertSelfCustody(repoRoot, adapters = {}) {
  const runnerRelativePath = 'scripts/studio-review-route-lifecycle-runner.cjs'
  const testRelativePath = 'scripts/studio-review-route-lifecycle-runner.test.ts'
  const run =
    adapters.runGit ||
    ((args) =>
      execFilePromise('/usr/bin/git', ['-C', repoRoot, ...args], {
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024
      }))
  return Promise.all([
    run(['ls-files', '--', runnerRelativePath, testRelativePath]),
    run(['status', '--porcelain=v1', '--', runnerRelativePath, testRelativePath])
  ]).then(async ([trackedResult, statusResult]) => {
    const tracked = String(trackedResult.stdout || '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort()
    invariant(
      JSON.stringify(tracked) === JSON.stringify([runnerRelativePath, testRelativePath].sort()),
      'review route runner and test must be tracked before live launch'
    )
    invariant(
      String(statusResult.stdout || '').trim() === '',
      'review route runner or test is dirty at live boundary'
    )
    const runnerPath = path.join(repoRoot, runnerRelativePath)
    const testPath = path.join(repoRoot, testRelativePath)
    const runnerHead = Buffer.from((await run(['show', `HEAD:${runnerRelativePath}`])).stdout)
    const testHead = Buffer.from((await run(['show', `HEAD:${testRelativePath}`])).stdout)
    const runnerSha256 = await sha256File(runnerPath)
    const testSha256 = await sha256File(testPath)
    invariant(runnerSha256 === sha256Bytes(runnerHead), 'review runner bytes differ from HEAD')
    invariant(testSha256 === sha256Bytes(testHead), 'review runner test bytes differ from HEAD')
    return {
      runner: { path: runnerRelativePath, sha256: runnerSha256 },
      test: { path: testRelativePath, sha256: testSha256 }
    }
  })
}

function assertHarnessBoundary(result) {
  const evidence = result?.evidence
  invariant(
    evidence?.ok === true && evidence.kind === 'taskwraith-studio-in-product-acceptance',
    'harness evidence is not Green'
  )
  const terminal = evidence.watchdogTerminal
  invariant(
    terminal?.status === 'reaped' &&
      terminal.groupExitVerified === true &&
      terminal.detachedGroupExitVerified === true,
    'watchdog did not prove exact reaping'
  )
  invariant(evidence.custodyBefore && evidence.custodyAfter, 'source custody evidence is absent')
  invariant(
    JSON.stringify(evidence.custodyBefore) === JSON.stringify(evidence.custodyAfter),
    'source custody changed during the journey'
  )
  invariant(
    evidence.packagedExecutionBefore && evidence.packagedExecutionAfter,
    'package custody evidence is absent'
  )
  invariant(
    JSON.stringify(evidence.packagedExecutionBefore) ===
      JSON.stringify(evidence.packagedExecutionAfter),
    'package custody changed during the journey'
  )
  return evidence
}

function workspaceFromReceipt(receipt, bounds) {
  const action = receipt?.actions?.find((candidate) => candidate?.type === 'read-workspace')
  invariant(action, 'review journey workspace receipt is absent')
  return harness.validateStudioWorkspaceObservation(action.workspace, bounds)
}

function screenshotFromReceipt(receipt) {
  const action = receipt?.actions?.find((candidate) => candidate?.type === 'screenshot')
  invariant(action?.screenshotPath, 'review journey screenshot receipt is absent')
  return action.screenshotPath
}

async function runReviewDriver(plan, target, actions, adapters = {}) {
  const interactive = actions.some((action) => action.type === 'key' || action.type === 'click')
  return (adapters.runUiDriver || harness.runStudioUiDriver)(plan, target, actions, {
    ...(adapters.driverAdapters || {}),
    inputDelivery: interactive ? 'foreground-global-explicit' : 'background-observation-only',
    allowForegroundInput: interactive
  })
}

async function waitForReviewWorkspace(plan, target, predicate, adapters = {}) {
  const bounds = harness.resolveStudioWorkspaceWindow(target).bounds
  return (adapters.waitFor || harness.waitFor)({
    label: 'exact Outcome 3/4 workspace state',
    timeoutMs: 15_000,
    intervalMs: 100,
    probe: async () => {
      const receipt = await runReviewDriver(plan, target, [{ type: 'read-workspace' }], adapters)
      const workspace = workspaceFromReceipt(receipt, bounds)
      return predicate(workspace) ? { receipt, workspace } : null
    }
  })
}

function parseRouteResource(readAvReceipt, hud, processResource, expectedRoute) {
  const action = readAvReceipt?.actions?.find((candidate) => candidate?.type === 'read-av-sync')
  invariant(action, 'route resource read-av-sync receipt is absent')
  const routeAction = readAvReceipt?.actions?.find(
    (candidate) => candidate?.type === 'read-route-resource'
  )
  invariant(routeAction, 'route resource read-route-resource receipt is absent')
  invariant(
    routeAction.route === expectedRoute,
    `route resource receipt selector ${routeAction.route} does not match ${expectedRoute}`
  )
  const routeParsed = harness.parseRouteResourceDetailExport(routeAction.routeResourceDetailValue)
  invariant(routeParsed.ok, `route resource rr1 detail is invalid: ${routeParsed.reason}`)
  invariant(
    routeParsed.route === expectedRoute,
    `route resource rr1 route ${routeParsed.route} does not match ${expectedRoute}`
  )
  const parsed = harness.parseResourceDetailExport(action.resourceDetailValue)
  invariant(parsed.ok, `route resource detail is invalid: ${parsed.reason}`)
  const observed = diagnostics.parseVisibleHud(hud, '', {
    matchAsset: () => ({ matched: true, distance: 0 })
  })
  const resource = {
    activeSourceCount: parsed.residentDecoderCount,
    cacheHits: observed.diagnostics.cacheHits,
    ioSurfaceIds: parsed.liveIoSurfaceIds,
    players: observed.players.count,
    retainedFrameCount: observed.diagnostics.heldFrames,
    textures: observed.diagnostics.textures,
    routeOwnership: {
      activeSourceCount: routeParsed.activeSourceCount,
      ioSurfaceIds: routeParsed.ioSurfaceIds,
      retainedFrameCount: routeParsed.retainedFrameCount,
      route: routeParsed.route
    },
    process: processResource
      ? {
          residentBytes: processResource.residentBytes,
          physicalFootprintBytes: processResource.physicalFootprintBytes,
          mallocAllocatedBytes: processResource.mallocAllocatedBytes,
          productSurfaceIds: processResource.productSurfaceIds
        }
      : null
  }
  return resource
}

async function readRouteObservation(
  plan,
  target,
  name,
  adapters = {},
  selectorRoute = null,
  expectedActiveRoute = selectorRoute
) {
  let selectedRoute = selectorRoute
  if (selectedRoute === null) {
    const initialReceipt = await runReviewDriver(
      plan,
      target,
      [{ type: 'read-workspace' }],
      adapters
    )
    const initialWorkspace = workspaceFromReceipt(
      initialReceipt,
      harness.resolveStudioWorkspaceWindow(target).bounds
    )
    selectedRoute = selectedWorkspaceRoute(initialWorkspace) === 'timeline' ? 'review' : 'source'
    expectedActiveRoute = selectedRoute
  }
  invariant(
    selectedRoute === 'source' || selectedRoute === 'review',
    'route resource observation requires an explicit Source or Review selector'
  )
  const receipt = await runReviewDriver(
    plan,
    target,
    [
      { type: 'read-workspace' },
      { type: 'read-av-sync' },
      {
        type: 'read-route-resource',
        route: selectedRoute
      },
      { type: 'screenshot', name }
    ],
    adapters
  )
  const bounds = harness.resolveStudioWorkspaceWindow(target).bounds
  const workspace = workspaceFromReceipt(receipt, bounds)
  const observedRoute = selectedWorkspaceRoute(workspace) === 'timeline' ? 'review' : 'source'
  invariant(
    observedRoute === expectedActiveRoute,
    'route resource observation active route changed during read'
  )
  const screenshotPath = screenshotFromReceipt(receipt)
  const hud = (adapters.ocrScreenshot || acceptanceSession.ocrScreenshot)(screenshotPath)
  const processResource = (adapters.resourceSample || acceptanceSession.resourceSample)(
    target.companion.pid,
    name,
    0,
    adapters.resourceAdapters || {}
  )
  return {
    workspace,
    screenshotPath,
    screenshotSha256: await sha256File(screenshotPath),
    resource: parseRouteResource(receipt, hud, processResource, selectedRoute),
    hud
  }
}

function routeContentSemantics(workspace, route) {
  return {
    route,
    sourceIndependent:
      route === 'source' &&
      workspace.sourceRoute?.value === 'selected' &&
      workspace.sourceHost?.visible === true,
    timelineContentVisible:
      route === 'timeline' &&
      workspace.timelineRoute?.value === 'selected' &&
      workspace.timelineHost?.visible === true,
    ghostsVisible: route === 'timeline' && workspace.proposedVersion?.value === 'selected'
  }
}

function selectedWorkspaceRoute(workspace) {
  const sourceVisible = workspace?.sourceHost?.visible === true
  const timelineVisible = workspace?.timelineHost?.visible === true
  invariant(
    sourceVisible !== timelineVisible,
    'workspace active route is not exactly one visible host'
  )
  if (sourceVisible) {
    invariant(workspace?.sourceRoute?.value === 'selected', 'visible Source route is not selected')
    return 'source'
  }
  invariant(
    workspace?.timelineRoute?.value === 'selected',
    'visible Timeline route is not selected'
  )
  return 'timeline'
}

function routeHostVisible(workspace, route) {
  return route === 'source'
    ? workspace?.sourceHost?.visible === true
    : workspace?.timelineHost?.visible === true
}

function exactProposalEvidence(entry, secondaryAssetId) {
  invariant(
    entry?.op?.type === 'propose_edit',
    'review proposal journal operation is not propose_edit'
  )
  const proposal = entry.op.proposal
  invariant(proposal?.op?.type === 'insert_range', 'review proposal is not insert_range')
  invariant(proposal.op.assetId === secondaryAssetId, 'review proposal targets the wrong asset')
  exactKeys(proposal.op, INSERT_KEYS, 'review insert_range')
  exactRational(proposal.op.sourceIn, 'review sourceIn')
  exactRational(proposal.op.sourceOut, 'review sourceOut')
  exactRational(proposal.op.at, 'review at')
  invariant(
    compareRational(proposal.op.sourceOut, proposal.op.sourceIn) > 0,
    'review proposal source range is empty'
  )
  return proposal
}

function locateSupervisorBundle(repoRoot) {
  const root = path.join(repoRoot, 'out', 'main')
  const pending = [root]
  const matches = []
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(candidate)
      else if (entry.isFile() && candidate.endsWith('.js')) {
        const source = fs.readFileSync(candidate, 'utf8')
        if (
          source.includes('await handleStudioMessage(this.store, value)') &&
          source.includes('hydration_served')
        ) {
          matches.push({ candidate, source })
        }
      }
    }
  }
  invariant(
    matches.length === 1,
    `compiled supervisor bundle is not unique: ${JSON.stringify(matches.map((entry) => entry.candidate))}`
  )
  const lines = matches[0].source.split(/\r?\n/)
  const responseAssignment = lines.findIndex((line) =>
    line.includes('await handleStudioMessage(this.store, value)')
  )
  const responseLine = lines.findIndex(
    (line, index) => index > responseAssignment && line.includes('if (response === null)')
  )
  const hydrationLine = lines.findIndex(
    (line) => line.includes('hydration_served') && line.includes('revision')
  )
  invariant(
    responseAssignment >= 0 && responseLine > responseAssignment && hydrationLine > responseLine,
    'compiled supervisor inspector seams are unavailable'
  )
  return {
    bundlePath: matches[0].candidate,
    urlRegex: path.basename(matches[0].candidate).replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '$',
    responseLine,
    hydrationLine
  }
}

async function armSupervisorProbe(repoRoot, inspector) {
  const definition = locateSupervisorBundle(repoRoot)
  const hits = []
  let failure = null
  let pending = Promise.resolve()
  const remove = inspector.on('Debugger.paused', (params) => {
    pending = pending
      .then(async () => {
        const frame = params?.callFrames?.[0]
        invariant(frame?.callFrameId, 'supervisor inspector paused without a call frame')
        const line = frame.location?.lineNumber
        const expression =
          line === definition.hydrationLine
            ? '({kind:"hydration",method:value?.method??null,childPid:child?.pid??null,revision:hydratedRevision,response})'
            : '({kind:"response",method:value?.method??null,params:value?.params??null,requestId:value?.id??null,childPid:child?.pid??null,response})'
        const evaluated = await inspector.post('Debugger.evaluateOnCallFrame', {
          callFrameId: frame.callFrameId,
          expression,
          returnByValue: true
        })
        invariant(!evaluated?.exceptionDetails, 'supervisor inspector evaluation failed')
        hits.push({ line, observedAt: new Date().toISOString(), ...evaluated.result.value })
      })
      .catch((error) => {
        failure = error
      })
      .finally(() => inspector.post('Debugger.resume').catch((error) => (failure ||= error)))
  })
  await inspector.post('Debugger.enable')
  const response = await inspector.post('Debugger.setBreakpointByUrl', {
    lineNumber: definition.responseLine,
    urlRegex: definition.urlRegex
  })
  const hydration = await inspector.post('Debugger.setBreakpointByUrl', {
    lineNumber: definition.hydrationLine,
    urlRegex: definition.urlRegex
  })
  invariant(
    response?.breakpointId && response.locations?.length,
    'supervisor response breakpoint did not bind'
  )
  invariant(
    hydration?.breakpointId && hydration.locations?.length,
    'supervisor hydration breakpoint did not bind'
  )
  return {
    hits,
    waitForHits: (predicate, label) =>
      harness.waitFor({
        label,
        timeoutMs: 30_000,
        intervalMs: 50,
        probe: async () => {
          if (failure) throw failure
          await pending
          return predicate(hits) || null
        }
      }),
    close: async () => {
      await pending
      remove()
      await inspector
        .post('Debugger.removeBreakpoint', { breakpointId: response.breakpointId })
        .catch(() => {})
      await inspector
        .post('Debugger.removeBreakpoint', { breakpointId: hydration.breakpointId })
        .catch(() => {})
      await inspector.post('Debugger.disable').catch(() => {})
      if (failure) throw failure
    }
  }
}

async function readJournalSnapshot(plan) {
  const journalPath = path.join(plan.studioStateDirectory, 'studio-project.journal.jsonl')
  const stat = await fsPromises.lstat(journalPath)
  invariant(
    stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_RECEIPT_BYTES,
    'review restart journal is not a bounded regular file'
  )
  const raw = await fsPromises.readFile(journalPath)
  const entries = await harness.readStudioJournalOperations(plan)
  const revision = Math.max(
    0,
    ...entries.map((entry) => entry.revision).filter(Number.isSafeInteger)
  )
  return { journalPath, raw, sha256: sha256Bytes(raw), byteLength: raw.byteLength, revision }
}

async function assertNoHydrationWindow(companion, adapters = {}) {
  if (typeof adapters.assertNoHydrationWindow === 'function') {
    return adapters.assertNoHydrationWindow(companion)
  }
  try {
    await (adapters.probeNativeWindow || harness.probeNativeWindow)(companion.pid, adapters)
  } catch (error) {
    invariant(
      error instanceof Error &&
        error.message === `No on-screen native Studio window for exact pid ${companion.pid}`,
      `hydration window probe failed indeterminately: ${error instanceof Error ? error.message : String(error)}`
    )
    return {
      schemaVersion: 1,
      kind: 'taskwraith-studio-zero-hydration-window',
      exactPid: companion.pid,
      visibleWindowCount: 0
    }
  }
  throw new Error('replacement hydration presented a Studio window before explicit open')
}

async function closeRestartInspection(supervisorProbe, inspector) {
  try {
    if (supervisorProbe) await supervisorProbe.close()
  } finally {
    await inspector.close()
  }
}

async function restartAcceptedCompanion(options) {
  const { plan, currentTarget, journeyAdapters, acceptAndWaitResolution } = options
  const inspectorUrl = await (journeyAdapters.discoverMainInspectorUrl || discoverMainInspectorUrl)(
    { port: plan.spawnPlan.mainInspectorPort }
  )
  const inspector = await (journeyAdapters.attachMainInspector || attachMainInspectorSession)({
    webSocketDebuggerUrl: inspectorUrl
  })
  let supervisorProbe = null
  try {
    const supervisorDefinitionBefore = (
      journeyAdapters.locateSupervisorBundle || locateSupervisorBundle
    )(plan.repoRoot)
    const supervisorSha256Before = await sha256File(supervisorDefinitionBefore.bundlePath)
    supervisorProbe = await (journeyAdapters.armSupervisorProbe || armSupervisorProbe)(
      plan.repoRoot,
      inspector
    )
    const resolution = await acceptAndWaitResolution()
    invariant(Number.isSafeInteger(resolution?.revision), 'accepted resolution revision is absent')
    const journalBefore = await readJournalSnapshot(plan)
    invariant(
      journalBefore.revision === resolution.revision,
      'accepted revision does not equal the pre-restart journal revision'
    )
    const exactProcess =
      journeyAdapters.exactCompanionProcess || acceptanceSession.exactCompanionProcess
    const oldProcess = exactProcess(currentTarget.companion, currentTarget.electronPgid)
    const preSignalProcess = exactProcess(currentTarget.companion, currentTarget.electronPgid)
    invariant(
      JSON.stringify(preSignalProcess) === JSON.stringify(oldProcess),
      'Companion process identity changed immediately before SIGKILL'
    )
    ;(journeyAdapters.signal || process.kill)(preSignalProcess.pid, 'SIGKILL')
    await harness.waitFor({
      label: 'accepted-review old Companion disappearance',
      timeoutMs: 20_000,
      intervalMs: 50,
      probe: async () => {
        if (journeyAdapters.isProcessAlive) {
          return (await journeyAdapters.isProcessAlive(preSignalProcess.pid)) ? null : true
        }
        try {
          process.kill(preSignalProcess.pid, 0)
          return null
        } catch {
          return true
        }
      }
    })
    const replacementCandidate = await harness.waitFor({
      label: 'accepted-review replacement Companion',
      timeoutMs: 30_000,
      intervalMs: 100,
      probe: async () => {
        const candidate = await (
          journeyAdapters.findStudioCompanion || harness.findStudioCompanion
        )(preSignalProcess.ppid)
        return candidate.pid === preSignalProcess.pid ? null : candidate
      }
    })
    const replacement = exactProcess(replacementCandidate, currentTarget.electronPgid)
    invariant(
      replacement.pid !== preSignalProcess.pid &&
        replacement.ppid === preSignalProcess.ppid &&
        replacement.pgid === preSignalProcess.pgid &&
        replacement.expectedExecutable === preSignalProcess.expectedExecutable &&
        replacement.command === preSignalProcess.command,
      'replacement Companion parent/PGID/executable custody is not exact'
    )
    const hydration = await supervisorProbe.waitForHits((hits) => {
      const childHits = hits.filter((hit) => hit.childPid === replacement.pid)
      const helloIndex = childHits.findIndex(
        (hit) => hit.kind === 'response' && hit.method === 'studio/hello'
      )
      const documentIndex = childHits.findIndex(
        (hit, index) =>
          index > helloIndex && hit.kind === 'response' && hit.method === 'studio/getDocument'
      )
      const hydrationIndex = childHits.findIndex(
        (hit, index) => index > documentIndex && hit.kind === 'hydration'
      )
      if (helloIndex < 0 || documentIndex < 0 || hydrationIndex < 0) return null
      return {
        hello: childHits[helloIndex],
        document: childHits[documentIndex],
        hydration: childHits[hydrationIndex],
        order: [helloIndex, documentIndex, hydrationIndex]
      }
    }, 'ordered hello -> getDocument -> hydration')
    const acceptedRevision = resolution.revision
    invariant(
      hydration.hello.response?.result?.revision === acceptedRevision &&
        hydration.document.response?.result?.revision === acceptedRevision &&
        hydration.hydration.revision === acceptedRevision &&
        hydration.document.response?.result?.document,
      'replacement hydration did not carry the exact accepted revision/document'
    )
    const journalAfter = await readJournalSnapshot(plan)
    invariant(
      journalAfter.revision === journalBefore.revision &&
        journalAfter.sha256 === journalBefore.sha256 &&
        journalAfter.raw.equals(journalBefore.raw),
      'restart changed durable journal bytes or revision'
    )
    const windowAbsence = await assertNoHydrationWindow(replacement, journeyAdapters)
    invariant(
      windowAbsence?.schemaVersion === 1 &&
        windowAbsence.kind === 'taskwraith-studio-zero-hydration-window' &&
        windowAbsence.exactPid === replacement.pid &&
        windowAbsence.visibleWindowCount === 0,
      'replacement zero-window hydration receipt is not exact'
    )
    const supervisorSha256After = await sha256File(supervisorDefinitionBefore.bundlePath)
    invariant(
      supervisorSha256After === supervisorSha256Before,
      'compiled supervisor bundle changed during restart probe'
    )
    return {
      resolution,
      replacement,
      document: hydration.document.response.result.document,
      custody: {
        oldProcess: preSignalProcess,
        replacement,
        acceptedRevision,
        hydrationOrder: hydration.order,
        journalBefore: {
          path: journalBefore.journalPath,
          sha256: journalBefore.sha256,
          byteLength: journalBefore.byteLength,
          revision: journalBefore.revision
        },
        journalAfter: {
          path: journalAfter.journalPath,
          sha256: journalAfter.sha256,
          byteLength: journalAfter.byteLength,
          revision: journalAfter.revision
        },
        windowAbsence,
        supervisor: {
          path: supervisorDefinitionBefore.bundlePath,
          beforeSha256: supervisorSha256Before,
          afterSha256: supervisorSha256After
        }
      }
    }
  } finally {
    await closeRestartInspection(supervisorProbe, inspector)
  }
}

function addRational(left, right) {
  const leftN = BigInt(left.n)
  const rightN = BigInt(right.n)
  const leftD = BigInt(left.d)
  const rightD = BigInt(right.d)
  const numerator = leftN * rightD + rightN * leftD
  const denominator = leftD * rightD
  let a = numerator < 0n ? -numerator : numerator
  let b = denominator
  while (b !== 0n) {
    const next = a % b
    a = b
    b = next
  }
  if (a === 0n) return { n: 0, d: 1 }
  return { n: Number(numerator / a), d: Number(denominator / a) }
}

function subtractRational(left, right) {
  return addRational(left, { n: -right.n, d: right.d })
}

function rationalToTicks(value, timescale) {
  const numerator = BigInt(value.n) * BigInt(timescale)
  const denominator = BigInt(value.d)
  invariant(
    numerator % denominator === 0n,
    'review rational does not convert to an exact viewer tick'
  )
  return Number(numerator / denominator)
}

function sameRational(left, right) {
  return BigInt(left.n) * BigInt(right.d) === BigInt(right.n) * BigInt(left.d)
}

function compareRational(left, right) {
  const lhs = BigInt(left.n) * BigInt(right.d)
  const rhs = BigInt(right.n) * BigInt(left.d)
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0
}

async function defaultDriveReviewRouteJourney(plan, target, journeyAdapters, context) {
  const base = await (journeyAdapters.driveBaseJourney || harness.driveStudioUiJourney)(
    plan,
    target,
    journeyAdapters
  )
  const waitWorkspace = journeyAdapters.waitForReviewWorkspace || waitForReviewWorkspace
  const secondary = context.secondaryAsset
  invariant(secondary, 'secondary asset was not materialized before the review journey')
  let currentTarget = { ...target, window: harness.resolveStudioWorkspaceWindow(target) }
  await context.openAsset(secondary)
  const waitJournal =
    journeyAdapters.waitForStudioJournalOperation || harness.waitForStudioJournalOperation
  const readJournal =
    journeyAdapters.readStudioJournalOperations || harness.readStudioJournalOperations
  const transcript = await waitJournal(
    plan,
    { type: 'set_transcript', assetId: secondary.sha256, requireNonEmptyTranscript: true },
    { afterRevision: base.finalRevision, timeoutMs: plan.transcriptTimeoutMs }
  )
  const openedWorkspace = await waitWorkspace(
    plan,
    currentTarget,
    (workspace) => {
      selectedWorkspaceRoute(workspace)
      return true
    },
    journeyAdapters
  )
  invariant(
    selectedWorkspaceRoute(openedWorkspace.workspace) === 'source',
    'base journey did not leave Source as the one visible active host'
  )
  if (openedWorkspace.workspace.timelineRoute.value === 'selected') {
    await runReviewDriver(
      plan,
      currentTarget,
      [{ type: 'press-workspace-route', route: 'timeline', selectedAfter: false }],
      journeyAdapters
    )
  }
  await waitWorkspace(
    plan,
    currentTarget,
    (workspace) =>
      workspace.sourceRoute.value === 'selected' &&
      workspace.timelineRoute.value === 'not selected' &&
      workspace.sourceHost.visible === true,
    journeyAdapters
  )
  const baseEntries = await readJournal(plan)
  const primaryProposalEntry = baseEntries.find(
    (entry) =>
      entry?.op?.type === 'propose_edit' &&
      entry.op.proposal?.proposalId === base.accepted?.proposalId
  )
  const primaryInsert = primaryProposalEntry?.op?.proposal?.op
  invariant(
    primaryInsert?.type === 'insert_range',
    'base journal did not contain the primary insertion'
  )
  const transportReceipt = await runReviewDriver(
    plan,
    currentTarget,
    [{ type: 'read-transport-mutation' }],
    journeyAdapters
  )
  const transportAction = transportReceipt.actions?.find(
    (action) => action.type === 'read-transport-mutation'
  )
  const transport = harness.parseStudioTransportMutationText(transportAction?.accessibilityValue)
  const durationTicks = BigInt(transport.afterDurationTicks)
  const primaryDuration = subtractRational(primaryInsert.sourceOut, primaryInsert.sourceIn)
  const timescaleNumerator = durationTicks * BigInt(primaryDuration.d)
  invariant(
    primaryDuration.n > 0 && timescaleNumerator % BigInt(primaryDuration.n) === 0n,
    'viewer timebase is not exactly derivable from the accepted primary range'
  )
  const viewerTimescale = Number(timescaleNumerator / BigInt(primaryDuration.n))
  invariant(
    Number.isSafeInteger(viewerTimescale) && viewerTimescale > 0,
    'derived viewer timescale is outside the safe integer range'
  )
  const primaryEndTicks = rationalToTicks(
    addRational(
      primaryInsert.at,
      subtractRational(primaryInsert.sourceOut, primaryInsert.sourceIn)
    ),
    viewerTimescale
  )
  await runReviewDriver(
    plan,
    currentTarget,
    [
      {
        type: 'set-playhead-ticks',
        playheadTicks: primaryEndTicks,
        playheadToleranceTicks: 0,
        playheadMaximumForwardAdvanceTicks: 0
      }
    ],
    journeyAdapters
  )
  await runReviewDriver(
    plan,
    currentTarget,
    [{ type: 'press-workspace-route', route: 'timeline', selectedAfter: true }],
    journeyAdapters
  )
  const preGhostWorkspace = await waitWorkspace(
    plan,
    currentTarget,
    (workspace) =>
      workspace.timelineRoute.value === 'selected' &&
      workspace.timelineHost.visible === true &&
      workspace.currentVersion.value === 'selected',
    journeyAdapters
  )
  const currentCapture = await runReviewDriver(
    plan,
    currentTarget,
    [{ type: 'screenshot', name: 'review-current-before-ghost' }],
    journeyAdapters
  )
  await runReviewDriver(
    plan,
    currentTarget,
    [{ type: 'press-workspace-route', route: 'timeline', selectedAfter: false }],
    journeyAdapters
  )
  await waitWorkspace(
    plan,
    currentTarget,
    (workspace) =>
      workspace.sourceRoute.value === 'selected' &&
      workspace.sourceHost.visible === true &&
      workspace.timelineRoute.value === 'not selected',
    journeyAdapters
  )
  await runReviewDriver(
    plan,
    currentTarget,
    [
      { type: 'key', key: 'tab' },
      { type: 'key', key: 'bracket-left' },
      { type: 'key', key: 'return' }
    ],
    journeyAdapters
  )
  const proposalEntry = await waitJournal(
    plan,
    { type: 'propose_edit' },
    { afterRevision: transcript.revision, timeoutMs: plan.transcriptTimeoutMs }
  )
  const proposal = exactProposalEvidence(proposalEntry, secondary.sha256)
  await runReviewDriver(
    plan,
    currentTarget,
    [{ type: 'press-workspace-route', route: 'timeline', selectedAfter: true }],
    journeyAdapters
  )
  await waitWorkspace(
    plan,
    currentTarget,
    (workspace) =>
      workspace.timelineRoute.value === 'selected' &&
      workspace.timelineHost.visible === true &&
      workspace.currentVersion.value === 'selected',
    journeyAdapters
  )
  const ghostCapture = await runReviewDriver(
    plan,
    currentTarget,
    [{ type: 'screenshot', name: 'review-current-with-ghost' }],
    journeyAdapters
  )
  const currentPath = screenshotFromReceipt(currentCapture)
  const ghostPath = screenshotFromReceipt(ghostCapture)
  const compareCaptures =
    journeyAdapters.compareStudioJourneyCaptures || harness.compareStudioJourneyCaptures
  const ghostComparison = compareCaptures(
    currentPath,
    ghostPath,
    currentTarget.window.bounds,
    'review-host',
    preGhostWorkspace.workspace.timelineHost.frame
  )
  invariant(ghostComparison.ok === true, 'Current-to-ghost pixels did not prove a material ghost')
  await runReviewDriver(plan, currentTarget, [{ type: 'key', key: 'v' }], journeyAdapters)
  const proposedWorkspace = await waitWorkspace(
    plan,
    currentTarget,
    (workspace) => workspace.proposedVersion.value === 'selected',
    journeyAdapters
  )
  const proposedCapture = await runReviewDriver(
    plan,
    currentTarget,
    [{ type: 'screenshot', name: 'review-proposed-with-ghost' }],
    journeyAdapters
  )
  const proposedPath = screenshotFromReceipt(proposedCapture)
  // Version distinctness is proven from the post-proposal Current capture
  // (ghostPath), never from the pre-ghost baseline (currentPath): the baseline
  // already differs from Proposed by the ghost alone, which would let an inert
  // Current -> Proposed switch pass. The mirrored comparison is a second real
  // receipt so each version proof carries its own provenance.
  const comparison = compareCaptures(
    ghostPath,
    proposedPath,
    currentTarget.window.bounds,
    'review-host',
    proposedWorkspace.workspace.timelineHost.frame
  )
  invariant(comparison.ok === true, 'Current/Proposed review pixels are not distinct and clean')
  const proposedComparison = compareCaptures(
    proposedPath,
    ghostPath,
    currentTarget.window.bounds,
    'review-host',
    proposedWorkspace.workspace.timelineHost.frame
  )
  invariant(
    proposedComparison.ok === true,
    'Proposed/Current review pixels are not distinct and clean'
  )
  await runReviewDriver(plan, currentTarget, [{ type: 'key', key: 'c' }], journeyAdapters)
  const rangeReceipt = await runReviewDriver(
    plan,
    currentTarget,
    [{ type: 'read-review-range' }],
    journeyAdapters
  )
  const rangeAction = rangeReceipt.actions?.find((action) => action.type === 'read-review-range')
  invariant(rangeAction?.loopingRange === true, 'review loop did not become active')
  const insertionTicks = rationalToTicks(proposal.op.at, viewerTimescale)
  const spanTicks = rationalToTicks(
    subtractRational(proposal.op.sourceOut, proposal.op.sourceIn),
    viewerTimescale
  )
  invariant(
    rangeAction.inPointTicks < insertionTicks &&
      rangeAction.outPointTicks > insertionTicks + spanTicks,
    'review loop endpoints do not surround the affected cut'
  )
  const restart = await (journeyAdapters.restartAcceptedCompanion || restartAcceptedCompanion)({
    plan,
    currentTarget,
    journeyAdapters,
    acceptAndWaitResolution: async () => {
      await runReviewDriver(
        plan,
        currentTarget,
        [
          {
            type: 'set-playhead-ticks',
            playheadTicks: insertionTicks,
            playheadToleranceTicks: 0,
            playheadMaximumForwardAdvanceTicks: 0
          },
          { type: 'key', key: 'a' }
        ],
        journeyAdapters
      )
      return waitJournal(
        plan,
        { type: 'resolve_proposal', proposalId: proposal.proposalId, decision: 'accept' },
        { afterRevision: proposalEntry.revision, timeoutMs: plan.transcriptTimeoutMs }
      )
    }
  })
  const resolution = restart.resolution
  const replacement = restart.replacement
  const document = restart.document
  const tracks = Array.isArray(document.tracks) ? document.tracks : []
  invariant(
    new Set(tracks.map((track) => track.trackId)).size === tracks.length,
    'authoritative getDocument contains duplicate track identities'
  )
  const targetTrackId = proposal.op.trackId || 'V1'
  const targetTracks = tracks.filter(
    (track) => track.trackId === targetTrackId && track.kind === 'video'
  )
  invariant(targetTracks.length === 1, 'authoritative target video track is not unique')
  const items = tracks.flatMap((track) => (Array.isArray(track.items) ? track.items : []))
  invariant(
    new Set(items.map((item) => item.itemId)).size === items.length,
    'authoritative getDocument contains duplicate item identities'
  )
  const targetItems = targetTracks[0].items
  invariant(Array.isArray(targetItems), 'authoritative target video track items are absent')
  targetItems.forEach((item, index) => {
    exactRational(item.position, `hydrated item ${index} position`)
    const duration = exactRational(item.duration, `hydrated item ${index} duration`)
    exactRational(item.sourceIn, `hydrated item ${index} sourceIn`)
    const sourceOut = exactRational(item.sourceOut, `hydrated item ${index} sourceOut`)
    invariant(
      duration.n > 0 && sameRational(duration, subtractRational(sourceOut, item.sourceIn)),
      `hydrated item ${index} duration is not positive or range-matched`
    )
  })
  const primaryItem = targetItems.find(
    (item) => item.itemId === primaryInsert.itemId && item.assetId === target.asset.sha256
  )
  const secondaryItem = targetItems.find(
    (item) => item.itemId === proposal.op.itemId && item.assetId === secondary.sha256
  )
  invariant(
    primaryItem && secondaryItem,
    'authoritative getDocument omitted primary or secondary committed item'
  )
  invariant(
    sameRational(secondaryItem.position, proposal.op.at),
    'authoritative secondary item position does not equal B insertion point'
  )
  invariant(
    sameRational(addRational(primaryItem.position, primaryItem.duration), secondaryItem.position),
    'authoritative committed sequence is not exact A then B'
  )
  const orderedTargetItems = [...targetItems].sort((left, right) => {
    const leftCross = BigInt(left.position.n) * BigInt(right.position.d)
    const rightCross = BigInt(right.position.n) * BigInt(left.position.d)
    return leftCross < rightCross ? -1 : leftCross > rightCross ? 1 : 0
  })
  for (let index = 1; index < orderedTargetItems.length; index += 1) {
    const previous = orderedTargetItems[index - 1]
    const previousEnd = addRational(previous.position, previous.duration)
    invariant(
      !(
        BigInt(previousEnd.n) * BigInt(orderedTargetItems[index].position.d) >
        BigInt(orderedTargetItems[index].position.n) * BigInt(previousEnd.d)
      ),
      'authoritative target video track contains overlap'
    )
  }
  const committedSequence = items
  const replacementRenderer = await (journeyAdapters.attachRenderer || attachRendererCdpSession)({
    port: plan.spawnPlan.remoteDebuggingPort
  })
  try {
    await (journeyAdapters.invokeAuthorizedStudioOpen || harness.invokeAuthorizedStudioOpen)(
      replacementRenderer,
      target.asset
    )
  } finally {
    replacementRenderer.close()
  }
  const replacementWindow = await (
    journeyAdapters.waitForSourceWindow || acceptanceSession.waitForSourceWindow
  )(replacement)
  currentTarget = { ...currentTarget, companion: replacement, window: replacementWindow }
  const postOpenWorkspace = await waitWorkspace(
    plan,
    currentTarget,
    (workspace) => selectedWorkspaceRoute(workspace) === 'source',
    journeyAdapters
  )
  if (postOpenWorkspace.workspace.timelineRoute.value === 'not selected') {
    await runReviewDriver(
      plan,
      currentTarget,
      [{ type: 'press-workspace-route', route: 'timeline', selectedAfter: true }],
      journeyAdapters
    )
  } else {
    await runReviewDriver(
      plan,
      currentTarget,
      [{ type: 'press-workspace-route', route: 'source', selectedAfter: false }],
      journeyAdapters
    )
  }
  const postRestartReview = await waitWorkspace(
    plan,
    currentTarget,
    (workspace) =>
      workspace.timelineRoute.value === 'selected' && workspace.timelineHost.visible === true,
    journeyAdapters
  )
  const beforeCrossing = await runReviewDriver(
    plan,
    currentTarget,
    [
      {
        type: 'set-playhead-ticks',
        playheadTicks: Math.max(0, insertionTicks - 1),
        playheadToleranceTicks: 0,
        playheadMaximumForwardAdvanceTicks: 0
      },
      { type: 'screenshot', name: 'review-crossing-primary' }
    ],
    journeyAdapters
  )
  const afterCrossing = await runReviewDriver(
    plan,
    currentTarget,
    [
      {
        type: 'set-playhead-ticks',
        playheadTicks: insertionTicks,
        playheadToleranceTicks: 0,
        playheadMaximumForwardAdvanceTicks: 0
      },
      { type: 'screenshot', name: 'review-crossing-secondary' }
    ],
    journeyAdapters
  )
  const compareCrossingReference = async (
    receipt,
    sourceAssetId,
    assetPath,
    sourcePtsSeconds,
    name
  ) => {
    const capturePath = screenshotFromReceipt(receipt)
    const referencePath = path.join(plan.artifactRoot, 'review-references', `${name}.png`)
    await fsPromises.mkdir(path.dirname(referencePath), { recursive: true, mode: 0o700 })
    const command = diagnostics.buildReferenceExtractCommand({
      assetPath,
      exactSourcePtsSeconds: sourcePtsSeconds,
      referencePath
    })
    const ffmpegExecutable = acceptanceSession.resolveMediaTool('ffmpeg')
    const ffmpegResult = await Promise.resolve(
      (journeyAdapters.runExact || acceptanceSession.runExact)(ffmpegExecutable, command, {
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024
      })
    )
    const comparison = pixels.compareWindowCaptureToReference(
      capturePath,
      referencePath,
      currentTarget.window.bounds,
      { sourceHostFrame: postRestartReview.workspace.timelineHost.frame }
    )
    invariant(comparison.clean === true, `${name} decoded-frame comparison is Red`)
    return {
      schemaVersion: 1,
      kind: 'taskwraith-studio-decoded-material',
      route: 'review',
      region: 'review-host',
      capturePath,
      captureSha256: await sha256File(capturePath),
      referencePath,
      referenceSha256: await sha256File(referencePath),
      sourceAssetId,
      sourceAssetPath: assetPath,
      sourcePtsSeconds,
      ffmpegExecution: exactExecutionReceipt(ffmpegExecutable, command, ffmpegResult),
      comparison
    }
  }
  const compareDecodedMaterial =
    journeyAdapters.compareCrossingReference || compareCrossingReference
  const primaryCrossingPixels = await compareDecodedMaterial(
    beforeCrossing,
    target.asset.sha256,
    target.asset.assetPath,
    primaryItem.sourceIn.n / primaryItem.sourceIn.d +
      (Math.max(0, insertionTicks - 1) - rationalToTicks(primaryItem.position, viewerTimescale)) /
        viewerTimescale,
    'crossing-primary'
  )
  const secondaryCrossingPixels = await compareDecodedMaterial(
    afterCrossing,
    secondary.sha256,
    secondary.assetPath,
    secondaryItem.sourceIn.n / secondaryItem.sourceIn.d +
      (insertionTicks - rationalToTicks(secondaryItem.position, viewerTimescale)) / viewerTimescale,
    'crossing-secondary'
  )
  const matchHud = async (receipt, assetId) => {
    const screenshotPath = screenshotFromReceipt(receipt)
    const hud = (journeyAdapters.ocrScreenshot || acceptanceSession.ocrScreenshot)(screenshotPath)
    const observed = diagnostics.parseVisibleHud(hud, assetId, {
      matchAsset: journeyAdapters.hudContainsAsset || acceptanceSession.hudContainsAsset
    })
    invariant(
      observed.assetMatch.matched === true && observed.assetMatch.distance === 0,
      `HUD did not prove exact asset ${assetId}`
    )
    return { screenshotPath, screenshotSha256: await sha256File(screenshotPath), observed }
  }
  await matchHud(beforeCrossing, target.asset.sha256)
  await matchHud(afterCrossing, secondary.sha256)
  const routeTransitions = []
  const observeRoute = journeyAdapters.readRouteObservation || readRouteObservation
  const initialRoute = await observeRoute(
    plan,
    currentTarget,
    'route-initial-before-actions',
    journeyAdapters
  )
  const initialActiveRoute = selectedWorkspaceRoute(initialRoute.workspace)
  if (
    initialActiveRoute === 'timeline' &&
    initialRoute.workspace.sourceRoute.value === 'not selected'
  ) {
    await runReviewDriver(
      plan,
      currentTarget,
      [{ type: 'press-workspace-route', route: 'source', selectedAfter: true }],
      journeyAdapters
    )
  }
  if (initialRoute.workspace.timelineRoute.value === 'selected') {
    await runReviewDriver(
      plan,
      currentTarget,
      [{ type: 'press-workspace-route', route: 'timeline', selectedAfter: false }],
      journeyAdapters
    )
  }
  let sourceOnly = await observeRoute(
    plan,
    currentTarget,
    'route-source-only-selected',
    journeyAdapters,
    'source'
  )
  invariant(
    sourceOnly.workspace.sourceHost.visible === true &&
      sourceOnly.workspace.timelineHost.visible === false &&
      sourceOnly.workspace.timelineRoute.value === 'not selected',
    'could not establish Source-only route state before route lifecycle'
  )
  let route = 'source'
  for (let index = 0; index < 4; index += 1) {
    const to = route === 'source' ? 'timeline' : 'source'
    const before =
      index === 0
        ? sourceOnly
        : await observeRoute(
            plan,
            currentTarget,
            `route-${index}-before`,
            journeyAdapters,
            route === 'source' ? 'source' : 'review'
          )
    invariant(
      !routeHostVisible(before.workspace, to) &&
        (to === 'source'
          ? before.workspace.sourceRoute.value
          : before.workspace.timelineRoute.value) === 'not selected',
      `route transition ${index} destination was not an exact unselected hidden route`
    )
    const fromStep = await runReviewDriver(
      plan,
      currentTarget,
      [{ type: 'step-playhead-frame', playheadStepFrames: 1 }],
      journeyAdapters
    )
    const routeReceipt = await runReviewDriver(
      plan,
      currentTarget,
      [{ type: 'press-workspace-route', route: to, selectedAfter: true }],
      journeyAdapters
    )
    const toStep = await runReviewDriver(
      plan,
      currentTarget,
      [{ type: 'step-playhead-frame', playheadStepFrames: -1 }],
      journeyAdapters
    )
    const routeAction = routeReceipt.actions?.find(
      (action) => action.type === 'press-workspace-route'
    )
    const fromStepAction = fromStep.actions?.find((action) => action.type === 'step-playhead-frame')
    const toStepAction = toStep.actions?.find((action) => action.type === 'step-playhead-frame')
    const sharedClock = {
      ok:
        routeAction?.accessibilityAction === 'AXPress' &&
        fromStepAction?.observedPlayheadTicks === toStepAction?.playheadTicksBefore &&
        toStepAction?.observedPlayheadTicks === fromStepAction?.playheadTicksBefore,
      fromBeforeTicks: fromStepAction?.playheadTicksBefore,
      fromAfterTicks: fromStepAction?.observedPlayheadTicks,
      toBeforeTicks: toStepAction?.playheadTicksBefore,
      toAfterTicks: toStepAction?.observedPlayheadTicks,
      routeAction
    }
    invariant(sharedClock.ok === true, `route transition ${index} did not prove one shared clock`)
    await runReviewDriver(
      plan,
      currentTarget,
      [{ type: 'press-workspace-route', route, selectedAfter: false }],
      journeyAdapters
    )
    const hidden = await observeRoute(
      plan,
      currentTarget,
      `route-${index}-hidden`,
      journeyAdapters,
      route === 'source' ? 'source' : 'review',
      to === 'source' ? 'source' : 'review'
    )
    const after = await observeRoute(
      plan,
      currentTarget,
      `route-${index}-after`,
      journeyAdapters,
      to === 'source' ? 'source' : 'review'
    )
    const beforeContent = routeContentSemantics(before.workspace, route)
    const afterContent = routeContentSemantics(after.workspace, to)
    invariant(
      beforeContent.route === route && afterContent.route === to,
      `route transition ${index} route state changed unexpectedly`
    )
    routeTransitions.push({
      index,
      transition: {
        from: beforeContent.route,
        to: afterContent.route,
        accessibilityAction: routeAction.accessibilityAction
      },
      sharedClock,
      content: {
        before: beforeContent,
        after: afterContent
      },
      resources: {
        before: before.resource,
        hidden: hidden.resource,
        after: after.resource,
        hiddenRouteDetached:
          (route === 'source'
            ? hidden.workspace.sourceHost.visible
            : hidden.workspace.timelineHost.visible) === false
      }
    })
    route = to
  }
  const ghostDifferenceProof = (difference) => ({
    schemaVersion: 1,
    kind: 'taskwraith-studio-ghost-difference',
    route: 'review',
    region: 'review-host',
    captureSha256: difference.beforeSha256,
    counterpartSha256: difference.afterSha256,
    comparison: difference
  })
  return {
    schemaVersion: 1,
    kind: `${KIND}-journey`,
    assetIds: { primary: target.asset.sha256, secondary: secondary.sha256 },
    assetPaths: { primary: target.asset.assetPath, secondary: secondary.assetPath },
    proposal: {
      proposalFirst: true,
      proposalId: proposal.proposalId,
      proposalRevision: proposalEntry.revision,
      op: proposal.op,
      visibleGhost: ghostComparison.ok === true,
      currentPixels: ghostDifferenceProof(comparison),
      proposedPixels: ghostDifferenceProof(proposedComparison),
      ghostPixels: ghostDifferenceProof(ghostComparison)
    },
    reviewLoop: {
      exact:
        Number.isSafeInteger(rangeAction.inPointTicks) &&
        Number.isSafeInteger(rangeAction.outPointTicks),
      route: proposedWorkspace.workspace.timelineRoute.value === 'selected' ? 'review' : null,
      active: rangeAction.loopingRange === true,
      endpointObservation: 'exact-accessibility',
      insertionStartTicks: insertionTicks,
      insertionEndTicks: insertionTicks + spanTicks,
      preRollTicks: insertionTicks - rangeAction.inPointTicks,
      postRollTicks: rangeAction.outPointTicks - (insertionTicks + spanTicks),
      startTicks: rangeAction.inPointTicks,
      endTicks: rangeAction.outPointTicks
    },
    acceptance: {
      decision: resolution.op?.decision,
      proposalId: resolution.op?.proposalId,
      resolutionRevision: resolution.revision,
      committedSequence,
      restart: restart.custody
    },
    playbackCrossing: {
      route: postRestartReview.workspace.timelineRoute.value === 'selected' ? 'review' : null,
      viewerTimescale,
      sharedClock: routeTransitions[0]
        ? {
            ok: routeTransitions[0].sharedClock.ok,
            sourceBeforeTicks: routeTransitions[0].sharedClock.fromBeforeTicks,
            sourceAfterTicks: routeTransitions[0].sharedClock.fromAfterTicks,
            reviewBeforeTicks: routeTransitions[0].sharedClock.toBeforeTicks,
            reviewAfterTicks: routeTransitions[0].sharedClock.toAfterTicks
          }
        : null,
      cutTicks: insertionTicks,
      samples: [
        {
          assetId: target.asset.sha256,
          positionTicks: Math.max(0, insertionTicks - 1),
          pixels: { route: 'review', ...primaryCrossingPixels }
        },
        {
          assetId: secondary.sha256,
          positionTicks: insertionTicks,
          pixels: { route: 'review', ...secondaryCrossingPixels }
        }
      ]
    },
    routeTransitions
  }
}

function parseCli(argv = process.argv.slice(2)) {
  const parsed = {
    launch: false,
    acceptLaunch: false,
    ownerConfirmsOrphansCleared: false,
    pretty: false,
    instanceId: null,
    artifactRoot: null,
    packagedExecutablePath: null,
    durationSeconds: DEFAULT_DURATION_SECONDS,
    timeoutMs: DEFAULT_TIMEOUT_MS
  }
  for (const argument of argv) {
    if (argument === '--launch') parsed.launch = true
    else if (argument === '--i-accept-studio-isolated-launch') parsed.acceptLaunch = true
    else if (argument === '--owner-confirms-existing-orphans-cleared')
      parsed.ownerConfirmsOrphansCleared = true
    else if (argument === '--pretty') parsed.pretty = true
    else if (argument.startsWith('--instance-id=')) parsed.instanceId = argument.slice(14)
    else if (argument.startsWith('--artifact-root=')) parsed.artifactRoot = argument.slice(16)
    else if (argument.startsWith('--packaged-executable='))
      parsed.packagedExecutablePath = argument.slice('--packaged-executable='.length)
    else if (argument.startsWith('--duration-seconds='))
      parsed.durationSeconds = Number(argument.slice('--duration-seconds='.length))
    else if (argument.startsWith('--timeout-ms='))
      parsed.timeoutMs = Number(argument.slice('--timeout-ms='.length))
    else throw new Error(`unknown argument ${argument}`)
  }
  return parsed
}

function normalizeOptions(options = {}) {
  const instanceId = safeInstanceId(options.instanceId || `o34-${process.pid}`)
  const artifactRoot = artifactRootFor(
    instanceId,
    options.artifactRoot || path.join(ACCEPTANCE_ROOT, instanceId)
  )
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    'timeoutMs',
    60_000,
    30 * 60 * 1_000
  )
  const durationSeconds = boundedInteger(
    options.durationSeconds ?? DEFAULT_DURATION_SECONDS,
    'durationSeconds',
    1,
    MAX_DURATION_SECONDS
  )
  if (options.launch) {
    invariant(options.acceptLaunch === true, 'launch requires --i-accept-studio-isolated-launch')
    invariant(
      options.ownerConfirmsOrphansCleared === true,
      'launch requires --owner-confirms-existing-orphans-cleared'
    )
    invariant(options.packagedExecutablePath, 'launch requires --packaged-executable')
    invariant(!fs.existsSync(artifactRoot), 'live launch requires a fresh artifact root')
  }
  return {
    launch: options.launch === true,
    acceptLaunch: options.acceptLaunch === true,
    ownerConfirmsOrphansCleared: options.ownerConfirmsOrphansCleared === true,
    pretty: options.pretty === true,
    instanceId,
    artifactRoot,
    packagedExecutablePath: options.packagedExecutablePath
      ? originallyAbsolute(options.packagedExecutablePath, 'packagedExecutablePath')
      : null,
    durationSeconds,
    timeoutMs
  }
}

function buildPlan(options = {}) {
  const normalized = normalizeOptions(options)
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: `${KIND}-plan`,
    launched: false,
    ...normalized,
    fixturePlan: {
      durationSeconds: normalized.durationSeconds,
      variants: ['primary', 'secondary'],
      outputRoot: path.join(normalized.artifactRoot, 'review-fixtures'),
      deterministic: true
    },
    safety: {
      planOnlyByDefault: true,
      freshArtifactRoot: true,
      explicitLaunchInterlocks: true,
      signedDisposableHarnessRequired: true,
      exactReviewAdaptersRequired: true,
      noInferenceForMissingObservations: true
    }
  }
}

async function writeRunnerEvidence(plan, result, fixtures, selfCustody, _adapters = {}) {
  const finalPath = path.join(plan.artifactRoot, 'review-route-lifecycle-evidence.json')
  await fsPromises.mkdir(plan.artifactRoot, { recursive: true, mode: 0o700 })
  await fsPromises.lstat(finalPath).then(
    () => {
      throw new Error('runner-owned review evidence already exists')
    },
    (error) => {
      if (error.code !== 'ENOENT') throw error
    }
  )
  const baseEvidencePath =
    result.plan?.evidencePath || path.join(plan.artifactRoot, 'studio-acceptance-evidence.json')
  const watchdogPath =
    result.plan?.receiptPath || path.join(plan.artifactRoot, 'watchdog-receipt.json')
  const readReceipt = async (filePath, label, parseJson = false) => {
    const resolved = originallyAbsolute(filePath, label)
    const relative = path.relative(path.resolve(plan.artifactRoot), resolved)
    invariant(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      `${label} escaped the artifact root`
    )
    const stat = await fsPromises.lstat(resolved)
    invariant(
      stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_RECEIPT_BYTES,
      `${label} is not a safe regular file`
    )
    const canonicalRoot = await fsPromises.realpath(plan.artifactRoot)
    const canonical = await fsPromises.realpath(resolved)
    const canonicalRelative = path.relative(canonicalRoot, canonical)
    invariant(
      canonicalRelative &&
        !canonicalRelative.startsWith('..') &&
        !path.isAbsolute(canonicalRelative),
      `${label} resolves outside the artifact root`
    )
    const raw = await fsPromises.readFile(resolved)
    const after = await fsPromises.lstat(resolved)
    invariant(
      after.dev === stat.dev &&
        after.ino === stat.ino &&
        after.size === stat.size &&
        after.mtimeMs === stat.mtimeMs,
      `${label} changed while being read`
    )
    let parsed = null
    if (parseJson) {
      try {
        parsed = JSON.parse(raw.toString('utf8'))
      } catch (error) {
        throw new Error(`${label} is not valid JSON: ${error.message}`)
      }
    }
    return {
      path: resolved,
      byteLength: raw.byteLength,
      sha256: sha256Bytes(raw),
      ...(parseJson ? { parsed } : {})
    }
  }
  const harnessReceipt = await readReceipt(baseEvidencePath, 'harness evidence', true)
  const watchdogReceipt = await readReceipt(watchdogPath, 'watchdog receipt', true)
  invariant(
    harnessReceipt.parsed?.schemaVersion === 1 &&
      harnessReceipt.parsed.kind === 'taskwraith-studio-in-product-acceptance' &&
      harnessReceipt.parsed.ok === true &&
      harnessReceipt.parsed.instanceId === plan.instanceId,
    'disk harness evidence did not reconcile to exact Green instance'
  )
  invariant(
    JSON.stringify(harnessReceipt.parsed.journey) === JSON.stringify(result.evidence.journey),
    'disk harness journey does not exactly equal the promoted journey'
  )
  const watchdog = watchdogReceipt.parsed
  const terminal = result.evidence.watchdogTerminal
  harness.assertCleanWatchdogTerminal(watchdog)
  harness.assertCleanWatchdogTerminal(terminal)
  invariant(
    watchdog.schemaVersion === 2 &&
      watchdog.kind === 'taskwraith-studio-acceptance-watchdog' &&
      watchdog.instanceId === plan.instanceId &&
      watchdog.reason === 'owner_requested' &&
      terminal.type === 'terminal' &&
      ['status', 'reason', 'groupExitVerified', 'detachedGroupExitVerified'].every(
        (key) => watchdog[key] === terminal[key]
      ) &&
      watchdog.childPid === terminal.childPid &&
      watchdog.childPgid === terminal.childPgid &&
      JSON.stringify(watchdog.detachedProcessGroups) ===
        JSON.stringify(terminal.detachedProcessGroups) &&
      ['lostOwnershipGroups', 'mixedOwnershipGroups', 'protectedInstalledGroups'].every(
        (key) => Array.isArray(watchdog[key]) && watchdog[key].length === 0
      ),
    'disk watchdog reason/instance/groups/ownership do not reconcile exactly'
  )
  const electron = result.evidence.electron
  const expectedWatchdogPid =
    electron.launchMode === 'launch-services' ? electron.launcherPid : electron.pid
  const expectedWatchdogPgid =
    electron.launchMode === 'launch-services' ? electron.launcherPgid : electron.pgid
  invariant(
    watchdog.childPid === expectedWatchdogPid && watchdog.childPgid === expectedWatchdogPgid,
    'watchdog child does not equal the exact harness launch owner'
  )
  if (electron.launchMode === 'launch-services') {
    invariant(
      watchdog.detachedProcessGroups.filter(
        (group) =>
          group.pgid === electron.pgid &&
          Array.isArray(group.memberPids) &&
          group.memberPids.includes(electron.pid)
      ).length === 1,
      'watchdog does not bind the exact detached Electron group'
    )
  }
  const promotedWatchdogTerminal = {
    schemaVersion: watchdog.schemaVersion,
    kind: watchdog.kind,
    instanceId: watchdog.instanceId,
    type: terminal.type,
    status: terminal.status,
    reason: terminal.reason,
    childPid: terminal.childPid,
    childPgid: terminal.childPgid,
    groupExitVerified: terminal.groupExitVerified,
    detachedGroupExitVerified: terminal.detachedGroupExitVerified,
    detachedProcessGroups: terminal.detachedProcessGroups,
    lostOwnershipGroups: watchdog.lostOwnershipGroups,
    mixedOwnershipGroups: watchdog.mixedOwnershipGroups,
    protectedInstalledGroups: watchdog.protectedInstalledGroups
  }
  invariant(
    JSON.stringify(promotedWatchdogTerminal) ===
      JSON.stringify({
        schemaVersion: watchdog.schemaVersion,
        kind: watchdog.kind,
        instanceId: watchdog.instanceId,
        type: 'terminal',
        status: watchdog.status,
        reason: watchdog.reason,
        childPid: watchdog.childPid,
        childPgid: watchdog.childPgid,
        groupExitVerified: watchdog.groupExitVerified,
        detachedGroupExitVerified: watchdog.detachedGroupExitVerified,
        detachedProcessGroups: watchdog.detachedProcessGroups,
        lostOwnershipGroups: watchdog.lostOwnershipGroups,
        mixedOwnershipGroups: watchdog.mixedOwnershipGroups,
        protectedInstalledGroups: watchdog.protectedInstalledGroups
      }),
    'promoted watchdog terminal does not exactly equal the disk ownership receipt'
  )
  const fixtureReceipts = {}
  for (const [variant, fixture] of Object.entries(fixtures.assets)) {
    const outputReceipt = await readReceipt(fixture.outputPath, `${variant} fixture output`)
    const manifestReceipt = await readReceipt(
      fixture.manifestPath,
      `${variant} fixture manifest`,
      true
    )
    invariant(
      manifestReceipt.parsed?.outputSha256 === (fixture.outputSha256 || outputReceipt.sha256) &&
        manifestReceipt.parsed?.outputByteLength === outputReceipt.byteLength,
      `${variant} fixture manifest does not reconcile to disk output`
    )
    fixtureReceipts[variant] = {
      output: outputReceipt,
      manifest: manifestReceipt
    }
  }
  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    kind: `${KIND}-evidence`,
    instanceId: plan.instanceId,
    gitHead: (
      await execFilePromise('/usr/bin/git', ['-C', plan.repoRoot, 'rev-parse', 'HEAD'], {
        timeout: 10_000,
        maxBuffer: 4096
      })
    ).stdout.trim(),
    selfCustody,
    fixtures: fixtures.assets,
    harnessEvidence: harnessReceipt,
    watchdogReceipt: watchdogReceipt,
    fixtureReceipts,
    harness: { ...result.evidence, watchdogTerminal: promotedWatchdogTerminal },
    journey: result.evidence.journey
  }
  const encoded = `${JSON.stringify(evidence, null, 2)}\n`
  invariant(
    Buffer.byteLength(encoded) <= MAX_RECEIPT_BYTES,
    'runner-owned review evidence exceeds the bounded receipt size'
  )
  const tempPath = `${finalPath}.tmp-${process.pid}`
  try {
    await fsPromises.writeFile(tempPath, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fsPromises.link(tempPath, finalPath)
  } finally {
    await fsPromises.rm(tempPath, { force: true }).catch(() => undefined)
  }
  const sealedStat = await fsPromises.lstat(finalPath)
  invariant(
    sealedStat.isFile() &&
      !sealedStat.isSymbolicLink() &&
      sealedStat.size === Buffer.byteLength(encoded),
    'runner-owned final evidence leaf changed after seal'
  )
  const sealed = await fsPromises.readFile(finalPath)
  invariant(
    sha256Bytes(sealed) === sha256Bytes(Buffer.from(encoded)),
    'runner-owned final evidence bytes changed after seal'
  )
  return {
    path: finalPath,
    sha256: sha256Bytes(Buffer.from(encoded)),
    byteLength: Buffer.byteLength(encoded),
    evidence
  }
}

async function runReviewRouteAcceptance(options = {}, adapters = {}) {
  const config = options.argv ? normalizeOptions(parseCli(options.argv)) : normalizeOptions(options)
  const plan = buildPlan(config)
  if (!config.launch) return plan
  const adapterKeys = Object.keys(adapters).filter((key) => key !== 'testOnly')
  invariant(
    adapterKeys.length === 0 ||
      (adapters.testOnly === true && process.env.TASKWRAITH_STUDIO_REVIEW_TEST === '1'),
    'live review-route adapter overrides are restricted to the explicit test-only seam'
  )
  const repoRoot = path.resolve(__dirname, '..')
  const selfCustody = await (adapters.assertSelfCustody || assertSelfCustody)(
    repoRoot,
    adapters.selfCustodyAdapters || {}
  )
  const fixtures = await (adapters.generateFixtures || generateReviewSpeechFixtures)(
    { artifactRoot: config.artifactRoot, durationSeconds: config.durationSeconds },
    adapters.fixtureAdapters || {}
  )
  const primaryPath = fixtures.assets.primary.outputPath
  const runAcceptance = adapters.runStudioAcceptance || harness.runStudioAcceptance
  const harnessPlan = harness.buildStudioAcceptancePlan({
    artifactRoot: config.artifactRoot,
    instanceId: config.instanceId,
    packagedExecutablePath: config.packagedExecutablePath
  })
  let secondaryAsset = null
  let activeRenderer = null
  const invokeOpen = async (renderer, asset, openOptions) => {
    activeRenderer = renderer
    const first = await (adapters.invokeStudioOpen || harness.invokeAuthorizedStudioOpen)(
      renderer,
      asset,
      openOptions
    )
    secondaryAsset = await harness.materializeOwnedMedia({
      mediaPath: fixtures.assets.secondary.outputPath,
      mimeType: 'video/mp4',
      userDataPath: harnessPlan.profile.userDataPath
    })
    await (adapters.invokeStudioOpen || harness.invokeAuthorizedStudioOpen)(
      renderer,
      secondaryAsset,
      openOptions
    )
    await (adapters.invokeStudioOpen || harness.invokeAuthorizedStudioOpen)(
      renderer,
      asset,
      openOptions
    )
    return first
  }
  const result = await runAcceptance(
    {
      launch: true,
      acceptLaunch: true,
      ownerConfirmsOrphansCleared: true,
      instanceId: config.instanceId,
      packagedExecutablePath: config.packagedExecutablePath,
      mediaPath: primaryPath,
      mimeType: 'video/mp4',
      generateSpeechFixture: false,
      timeoutMs: config.timeoutMs,
      transcriptTimeoutMs: Math.min(config.timeoutMs, 180_000)
    },
    {
      planOptions: {
        artifactRoot: config.artifactRoot,
        instanceId: config.instanceId,
        packagedExecutablePath: config.packagedExecutablePath
      },
      invokeStudioOpen: invokeOpen,
      driveUiJourney: async (acceptancePlan, target, journeyAdapters) => {
        invariant(secondaryAsset, 'secondary asset was not materialized before the review journey')
        const journey = await (adapters.driveReviewRouteJourney || defaultDriveReviewRouteJourney)(
          acceptancePlan,
          {
            ...target,
            reviewAssets: { primary: target.asset, secondary: secondaryAsset },
            fixtures
          },
          journeyAdapters,
          {
            secondaryAsset,
            fixtures,
            openAsset: async (asset) => {
              invariant(activeRenderer, 'review renderer is unavailable for the second asset open')
              return (adapters.invokeStudioOpen || harness.invokeAuthorizedStudioOpen)(
                activeRenderer,
                asset,
                { timeoutMs: acceptancePlan.transcriptTimeoutMs }
              )
            }
          }
        )
        return validateReviewRouteJourney(journey, fixtures.assets)
      }
    }
  )
  const evidence = assertHarnessBoundary(result)
  const finalEvidence = await (adapters.writeEvidence || writeRunnerEvidence)(
    {
      ...config,
      repoRoot,
      evidencePath: harnessPlan.evidencePath,
      receiptPath: harnessPlan.receiptPath
    },
    { ...result, evidence },
    fixtures,
    selfCustody,
    adapters
  )
  return { launched: true, ...result, finalEvidence, reviewRouteLifecycle: true }
}

async function main(argv = process.argv.slice(2)) {
  const result = await runReviewRouteAcceptance({ argv })
  process.stdout.write(`${JSON.stringify(result, null, result.pretty ? 2 : 0)}\n`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[studio-review-route-lifecycle] FAIL — ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  KIND,
  SCHEMA_VERSION,
  DEFAULT_DURATION_SECONDS,
  DEFAULT_TIMEOUT_MS,
  ROUTE_SEQUENCE,
  buildFixtureCommand,
  buildFixtureProbeCommand,
  parseFixtureProbe,
  parseSpeechFixtureProbe,
  generateReviewFixtures,
  generateReviewSpeechFixtures,
  fixtureAssetId,
  validateGhostDifferenceProof,
  validateDecodedMaterialProof,
  validateResource,
  validateReviewRouteJourney,
  selectedWorkspaceRoute,
  routeHostVisible,
  defaultDriveReviewRouteJourney,
  restartAcceptedCompanion,
  closeRestartInspection,
  addRational,
  subtractRational,
  rationalToTicks,
  sameRational,
  assertSelfCustody,
  assertHarnessBoundary,
  parseCli,
  normalizeOptions,
  buildPlan,
  writeRunnerEvidence,
  runReviewRouteAcceptance
}
