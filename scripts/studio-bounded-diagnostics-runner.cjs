#!/usr/bin/env node
'use strict'

/**
 * Bounded visible-diagnostics acceptance runner (Studio Outcome 9).
 *
 * WHY THIS FILE EXISTS. Outcome 9 was previously reported Green on the strength
 * of a real run - three background-only WindowServer samples adjudicated through
 * a pixel comparator. The observation was genuine. The APPARATUS was not in the
 * repository: it lived only at
 *   .local-only/taskwraith-studio/acceptance/w1acc10e/bounded-diagnostics-run.cjs
 * and pulled its session layer from two more untracked siblings. `git ls-files
 * .local-only/` returns zero files, so a fresh clone could not execute the run at
 * all. An outcome is not Green because a run passed; it is Green because someone
 * else could run it. This file promotes the ADJUDICATION - the part that encodes
 * what Outcome 9 actually claims - into tracked, tested, portable code.
 *
 * WHAT WAS DELIBERATELY CHANGED FROM THE UNTRACKED ORIGINAL.
 *
 * 1. THE FIXTURE CENSUS IS DERIVED, NOT PINNED. The original threw unless the
 *    frame census was exactly 22_800, a number bound to a retained 116MB blob no
 *    code synthesises. The tracked generator produces 600s at 30fps = 18_000
 *    frames, so inheriting that pin would make this runner reject its own
 *    derivable fixture. The count now comes from the generator's own duration and
 *    frame rate, so the two cannot drift.
 *
 * 2. THE PTS CENSUS PARSER FAILS LOUDLY. The original did
 *    `.map(Number).filter(Number.isFinite)`. Homebrew ffprobe emits a trailing
 *    comma on 2s boundaries with `-of csv=p=0`, and `Number('4.0,')` is NaN - so
 *    every boundary frame was silently DISCARDED. A census count measured against
 *    that behaviour encodes the bug. Commas are now stripped and anything still
 *    unparseable raises rather than shrinking the census.
 *
 * 3. TOOL AND ROOT RESOLUTION ARE PORTABLE. The shared session layer assigned
 *    `repoRoot` a literal absolute path inside one operator's home directory, and
 *    pinned a single Homebrew prefix for ffmpeg/ffprobe. Here the root is derived
 *    from this file's own location and tools are resolved across candidate
 *    prefixes and PATH. (The literal is deliberately not reproduced anywhere in
 *    this file - a control scans for it, and prose spells it just as effectively
 *    as code.)
 *
 * WHAT THIS FILE HONESTLY CANNOT DO YET. The session layer - disposable-profile
 * setup, Studio open, native capture, OCR, resource sampling, focus isolation -
 * is still untracked (~3,000 lines across two `.local-only` modules). Rather than
 * reach back into `.local-only` and keep the defect while looking tracked, an
 * end-to-end run REFUSES and names every missing dependency. Shipping a runner
 * that merely looks runnable is precisely how an outcome gets promoted on
 * apparatus nobody can reproduce.
 */

const fs = require('node:fs')
const path = require('node:path')

const speechFixture = require('./studio-generate-speech-fixture.cjs')

/** Resolved from this file so the runner is not bound to one checkout path. */
const repoRoot = path.resolve(__dirname, '..')

/**
 * Plausible presented-frame-rate band, stated as literals here and asserted as
 * literals in the controls. A control that reads this constant to build its own
 * expectation is a tautology: shrink the band and the control shrinks silently.
 */
const DIAGNOSTICS_PRESENTED_RATE_BOUNDS = { minimum: 20, maximum: 90 }

/**
 * Every visible counter assertDiagnostics reports as evidence. Listed explicitly
 * so a field cannot be added to the verdict without also being required to be
 * legible - the omission that made heldFrames and textures decoration.
 */
const REQUIRED_VISIBLE_COUNTERS = [
  'droppedFrames',
  'heldFrames',
  'shownFrames',
  'cacheHits',
  'textures'
]

/**
 * Upper bound on a believable visible RSS reading, in megabytes. OCR can inflate
 * digits, and an absurd value would otherwise be compared against the real process
 * footprint as though it were a measurement.
 */
const DIAGNOSTICS_VISIBLE_RSS_CEILING_MEGABYTES = 1_048_576

/** Tolerance when matching a rounded HUD timecode back to an exact source PTS. */
const PTS_SELECTION_TOLERANCE_SECONDS = 0.000_501

/** Half-width of the ffmpeg select bracket around the exact source PTS. */
const PTS_BRACKET_HALF_WIDTH_SECONDS = 0.000_001

/**
 * Session-layer functions this runner needs for an end-to-end observation, which
 * still exist only in the untracked evidence root. Named individually so the
 * follow-up slice is unambiguous rather than "port the session layer".
 */
const UNPROMOTED_SESSION_DEPENDENCIES = [
  'withIsolatedSession',
  'invokeStudioOpen',
  'waitForSourceWindow',
  'captureNative',
  'ocrScreenshot',
  'resourceSample',
  'consoleSessionState',
  'assertWindowServerSessionAvailable',
  'assertSourceWindowFocusIsolation',
  'focusSnapshot',
  'hudContainsAsset'
]

/**
 * The fixture contract, derived from the tracked generator rather than restated.
 * Two literals drift; when they do, this runner silently starts adjudicating a
 * different clip than the one it generates.
 */
function describeFixtureContract() {
  const durationSeconds = speechFixture.DEFAULT_FIXTURE_DURATION_SECONDS
  const frameRate = speechFixture.FIXTURE_FRAME_RATE
  return {
    durationSeconds,
    frameRate,
    expectedFrameCount: durationSeconds * frameRate,
    generator: path.relative(repoRoot, path.join(__dirname, 'studio-generate-speech-fixture.cjs'))
  }
}

/**
 * Candidate absolute paths for a media tool. Both Homebrew prefixes are listed
 * because pinning only the Apple Silicon one - the original defect - fails on
 * Intel installs, and PATH entries are appended so a non-Homebrew ffmpeg works.
 */
function mediaToolCandidates(name) {
  const prefixes = [
    path.join('/opt', 'homebrew', 'bin'),
    path.join('/usr', 'local', 'bin'),
    path.join('/usr', 'bin'),
    path.join('/bin')
  ]
  const fromPath = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
  const seen = new Set()
  const candidates = []
  for (const prefix of [...prefixes, ...fromPath]) {
    const candidate = path.join(prefix, name)
    if (!seen.has(candidate)) {
      seen.add(candidate)
      candidates.push(candidate)
    }
  }
  return candidates
}

/** First existing candidate, or a named refusal. Never a silent fallback. */
function resolveMediaTool(name, options = {}) {
  const candidates = options.candidates || mediaToolCandidates(name)
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* candidate absent; try the next one */
    }
  }
  throw new Error(
    'bounded diagnostics could not resolve the media tool ' +
      name +
      ' in any candidate location: ' +
      JSON.stringify(candidates)
  )
}

/** ffprobe argv for a video frame PTS census. */
function buildFramePtsCensusCommand(assetPath) {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=best_effort_timestamp_time',
    '-of',
    'csv=p=0',
    assetPath
  ]
}

/**
 * Parses ffprobe census output. Trailing commas are stripped rather than allowed
 * to become NaN and vanish through a filter; anything still unparseable raises,
 * because a silently shortened census is indistinguishable from a short clip.
 */
function parseFramePtsCensus(stdout) {
  const rows = String(stdout)
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0)
  const values = []
  for (const [index, row] of rows.entries()) {
    const normalized = row.replace(/,+$/, '').trim()
    const value = Number(normalized)
    if (!Number.isFinite(value)) {
      throw new Error(
        'bounded diagnostics PTS census contained an unparseable row at index ' +
          String(index) +
          ': ' +
          JSON.stringify(row)
      )
    }
    values.push(value)
  }
  return { count: values.length, values }
}

/**
 * ffmpeg argv extracting the single frame at an exact source PTS. `-fps_mode
 * passthrough` is load-bearing: without it ffmpeg resamples and the "reference"
 * is not the frame the HUD was showing, so the comparator adjudicates the wrong
 * pair while every hash still matches.
 */
function buildReferenceExtractCommand(options) {
  const { assetPath, exactSourcePtsSeconds, referencePath } = options
  const lowerBound = exactSourcePtsSeconds - PTS_BRACKET_HALF_WIDTH_SECONDS
  const upperBound = exactSourcePtsSeconds + PTS_BRACKET_HALF_WIDTH_SECONDS
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    assetPath,
    '-vf',
    'select=between(t\\,' + lowerBound.toFixed(6) + '\\,' + upperBound.toFixed(6) + ')',
    '-fps_mode',
    'passthrough',
    '-frames:v',
    '1',
    '-y',
    referencePath
  ]
}

/** Resolves one exact source PTS for a rounded HUD reading, or refuses. */
function resolveExactSourcePts(censusValues, roundedHudSeconds) {
  const matches = censusValues.filter(
    (candidate) => Math.abs(candidate - roundedHudSeconds) <= PTS_SELECTION_TOLERANCE_SECONDS
  )
  if (matches.length !== 1) {
    throw new Error(
      'bounded diagnostics could not resolve one exact source PTS for ' +
        String(roundedHudSeconds) +
        ': ' +
        JSON.stringify(matches)
    )
  }
  return matches[0]
}

/** OCR routinely renders 0 as o/ø/Ø/e. Anything not an integer stays null. */
function parseOcrInteger(token) {
  if (typeof token !== 'string' || token.length < 1) return null
  const normalized = token.replace(/[oøØe]/g, '0')
  return /^\d+$/.test(normalized) ? Number(normalized) : null
}

/**
 * Reads the visible HUD. `matchAsset` is injected rather than imported so this
 * stays free of the untracked session layer; an unreadable field becomes null,
 * never 0, because 0 is a legitimate counter value and coercing to it would let
 * a blind sample satisfy the validity gate.
 */
function parseVisibleHud(hud, assetId, options = {}) {
  const matchAsset = options.matchAsset
  if (typeof matchAsset !== 'function') {
    throw new Error('bounded diagnostics requires an explicit HUD asset matcher')
  }
  const texts = hud.texts || []
  const joined = texts.join(' ')
  const contentPtsText = texts.find((text) => /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(text))
  const contentPtsMatch = contentPtsText?.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/)
  const field = (label) => {
    const matches = [...joined.matchAll(new RegExp('\\b' + label + '\\s*([0-9oøØe]+)', 'gi'))]
    return parseOcrInteger(matches.at(-1)?.[1])
  }
  const rssMatch = joined.match(/\brss\s*([0-9.]+)\s*MB/i)
  const stateMatch = joined.match(/\b(PLAY|PAUSE)\b/i)
  return {
    contentPtsText: contentPtsText || null,
    contentPtsSeconds: contentPtsMatch
      ? Number(contentPtsMatch[1]) * 3_600 +
        Number(contentPtsMatch[2]) * 60 +
        Number(contentPtsMatch[3]) +
        Number(contentPtsMatch[4]) / 1_000
      : null,
    state: stateMatch?.[1]?.toUpperCase() || null,
    diagnostics: {
      droppedFrames: field('drop'),
      heldFrames: field('held'),
      shownFrames: field('shown'),
      cacheHits: field('cache'),
      textures: field('tex')
    },
    players: {
      count: field('play'),
      rssMegabytes: rssMatch ? Number(rssMatch[1]) : null
    },
    assetMatch: matchAsset(hud, assetId),
    rawOcrSha256: hud.stdoutSha256 || null
  }
}

/**
 * Whether one observation is a usable playing sample. Extracted from the
 * original's inline boolean so each rejection reason is nameable in evidence
 * instead of collapsing into "not valid".
 */
function isPlayableSample(observed, previousPtsSeconds, options = {}) {
  const maximumPtsSeconds = options.maximumPtsSeconds ?? describeFixtureContract().durationSeconds
  const pts = observed.contentPtsSeconds
  const numeric = [
    observed.diagnostics?.droppedFrames,
    observed.diagnostics?.heldFrames,
    observed.diagnostics?.shownFrames,
    observed.diagnostics?.cacheHits,
    observed.diagnostics?.textures,
    observed.players?.count,
    observed.players?.rssMegabytes
  ]
  const reasons = []
  if (!Number.isFinite(pts) || pts < 0 || pts > maximumPtsSeconds)
    reasons.push('playhead-unreadable-or-out-of-range')
  if (observed.state !== 'PLAY') reasons.push('transport-not-playing')
  if (observed.assetMatch?.matched !== true) reasons.push('asset-identity-mismatch')
  if (!numeric.every(Number.isFinite)) reasons.push('counter-unreadable')
  if (previousPtsSeconds !== null && previousPtsSeconds !== undefined) {
    if (!(pts > previousPtsSeconds + 0.25)) reasons.push('playhead-did-not-advance')
    if (!(pts < previousPtsSeconds + 90)) reasons.push('playhead-jumped-implausibly')
  }
  return { valid: reasons.length === 0, reasons }
}

/**
 * THE OUTCOME 9 CLAIM. Every branch below is a distinct way the claim can be
 * false while a screenshot still looks correct - most importantly a frozen image
 * under a running clock, which `shownFrames` monotonicity is what catches.
 */
function assertDiagnostics(samples, firstResources, lastResources) {
  const parsed = samples.map((sample) => sample.observed)
  if (parsed.length < 2) {
    throw new Error('bounded diagnostics needs at least two samples to prove advance')
  }

  for (const [index, sample] of parsed.entries()) {
    if (!sample.diagnostics || !sample.players || sample.state !== 'PLAY') {
      throw new Error('sample omitted visible diagnostics: ' + String(index))
    }

    // EVERY counter this claim reports must have been legibly read. Before this
    // gate existed the function reported all five diagnostics in its verdict while
    // only ever examining three of them, and those three rejected an unreadable
    // value by coercion accident rather than by validation: null !== 0 tripped the
    // dropped-frame check, null <= null tripped monotonicity, null < 1 tripped the
    // player bound. heldFrames and textures were never examined; cacheHits passed
    // because null < null is false; and an unreadable RSS survived whenever the
    // process footprint was small enough for the tolerance floor to absorb it.
    // A HUD rendering blanks would therefore have produced a truthful-looking
    // Green - the counters were decoration, not evidence.
    for (const field of REQUIRED_VISIBLE_COUNTERS) {
      const value = sample.diagnostics[field]
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(
          'visible diagnostics counter is unreadable or invalid at sample ' +
            String(index) +
            ': ' +
            JSON.stringify({ field, value })
        )
      }
    }
    if (!Number.isInteger(sample.players.count) || sample.players.count < 0) {
      throw new Error(
        'visible player count is unreadable or invalid at sample ' +
          String(index) +
          ': ' +
          JSON.stringify({ value: sample.players.count })
      )
    }
    if (
      !Number.isFinite(sample.players.rssMegabytes) ||
      sample.players.rssMegabytes < 0 ||
      sample.players.rssMegabytes > DIAGNOSTICS_VISIBLE_RSS_CEILING_MEGABYTES
    ) {
      throw new Error(
        'visible RSS is unreadable or out of bounds at sample ' +
          String(index) +
          ': ' +
          JSON.stringify({
            value: sample.players.rssMegabytes,
            ceilingMegabytes: DIAGNOSTICS_VISIBLE_RSS_CEILING_MEGABYTES
          })
      )
    }

    if (sample.diagnostics.droppedFrames !== 0) {
      throw new Error(
        'visible dropped-frame counter is nonzero at sample ' +
          String(index) +
          ': ' +
          String(sample.diagnostics.droppedFrames)
      )
    }
  }

  for (let index = 1; index < parsed.length; index += 1) {
    const prior = parsed[index - 1]
    const current = parsed[index]
    if (
      current.contentPtsSeconds <= prior.contentPtsSeconds ||
      current.diagnostics.shownFrames <= prior.diagnostics.shownFrames ||
      current.diagnostics.cacheHits < prior.diagnostics.cacheHits ||
      current.diagnostics.droppedFrames < prior.diagnostics.droppedFrames
    ) {
      throw new Error(
        'visible diagnostics did not advance monotonically: ' +
          JSON.stringify({ index, prior, current })
      )
    }
  }

  const first = parsed[0]
  const last = parsed.at(-1)
  const ptsDeltaSeconds = last.contentPtsSeconds - first.contentPtsSeconds
  const shownDelta = last.diagnostics.shownFrames - first.diagnostics.shownFrames
  const presentedRate = shownDelta / ptsDeltaSeconds
  if (
    !Number.isFinite(presentedRate) ||
    presentedRate < DIAGNOSTICS_PRESENTED_RATE_BOUNDS.minimum ||
    presentedRate > DIAGNOSTICS_PRESENTED_RATE_BOUNDS.maximum ||
    first.players.count !== last.players.count ||
    last.players.count < 1 ||
    last.players.count > 2
  ) {
    throw new Error(
      'visible diagnostics rate/player bounds failed: ' +
        JSON.stringify({ ptsDeltaSeconds, shownDelta, presentedRate, first, last })
    )
  }

  const visibleRssMegabytes = last.players.rssMegabytes
  const processRssMegabytes = lastResources.ps.rssKilobytes / 1024
  const rssDifferenceMegabytes = Math.abs(visibleRssMegabytes - processRssMegabytes)
  const rssToleranceMegabytes = Math.max(64, processRssMegabytes * 0.15)
  if (rssDifferenceMegabytes > rssToleranceMegabytes) {
    throw new Error(
      'visible RSS disagrees with exact-process ps sample: ' +
        JSON.stringify({
          visibleRssMegabytes,
          processRssMegabytes,
          rssDifferenceMegabytes,
          rssToleranceMegabytes
        })
    )
  }

  return {
    droppedFramesStayedZero: true,
    ptsAdvanced: true,
    shownFramesAdvanced: true,
    cacheHitsNondecreasing: true,
    playerCountStable: true,
    ptsDeltaSeconds,
    shownDelta,
    presentedRate,
    rssAgreement: {
      visibleRssMegabytes,
      processRssMegabytes,
      rssDifferenceMegabytes,
      rssToleranceMegabytes,
      withinTolerance: true
    },
    resourceDelta: {
      exactProcessRssBytes: (lastResources.ps.rssKilobytes - firstResources.ps.rssKilobytes) * 1024,
      physicalFootprintBytes:
        lastResources.physicalFootprintBytes - firstResources.physicalFootprintBytes,
      peakPhysicalFootprintBytes:
        lastResources.peakPhysicalFootprintBytes - firstResources.peakPhysicalFootprintBytes,
      mallocAllocatedBytes:
        lastResources.mallocAllocatedBytes - firstResources.mallocAllocatedBytes,
      iosurfaceVirtualBytes:
        lastResources.iosurfaceVirtualBytes - firstResources.iosurfaceVirtualBytes,
      iosurfaceResidentBytes:
        lastResources.iosurfaceResidentBytes - firstResources.iosurfaceResidentBytes,
      iosurfaceRegionCount:
        lastResources.iosurfaceRegionCount - firstResources.iosurfaceRegionCount,
      productSurfaceIds: {
        first: firstResources.productSurfaceIds,
        last: lastResources.productSurfaceIds
      },
      mappedRegionIdentities: {
        first: firstResources.mappedRegionIdentities,
        last: lastResources.mappedRegionIdentities
      }
    }
  }
}

/**
 * End-to-end run. Refuses until the session layer is tracked. This is deliberate:
 * silently requiring the untracked `.local-only` modules would leave the exact
 * reproducibility defect this promotion exists to repair, disguised as a tracked
 * runner.
 */
async function runBoundedDiagnostics() {
  throw new Error(
    'bounded diagnostics cannot run end to end: the session layer is not yet promoted ' +
      'into tracked scripts/. Missing dependencies: ' +
      UNPROMOTED_SESSION_DEPENDENCIES.join(', ') +
      '. They remain only in the untracked acceptance evidence root; promote them ' +
      'before claiming Outcome 9 from a fresh checkout.'
  )
}

module.exports = {
  DIAGNOSTICS_PRESENTED_RATE_BOUNDS,
  DIAGNOSTICS_VISIBLE_RSS_CEILING_MEGABYTES,
  REQUIRED_VISIBLE_COUNTERS,
  PTS_SELECTION_TOLERANCE_SECONDS,
  UNPROMOTED_SESSION_DEPENDENCIES,
  assertDiagnostics,
  buildFramePtsCensusCommand,
  buildReferenceExtractCommand,
  describeFixtureContract,
  isPlayableSample,
  mediaToolCandidates,
  parseFramePtsCensus,
  parseOcrInteger,
  parseVisibleHud,
  repoRoot,
  resolveExactSourcePts,
  resolveMediaTool,
  runBoundedDiagnostics
}

if (require.main === module) {
  runBoundedDiagnostics().catch((error) => {
    console.error(
      '[studio-bounded-diagnostics-runner] FAIL — ' +
        (error instanceof Error ? error.message : String(error))
    )
    process.exitCode = 1
  })
}
