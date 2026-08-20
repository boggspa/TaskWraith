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
 * The shared session layer is now tracked in studio-acceptance-session.cjs.
 * Disposable launch, generated media, one-window capture, exact OCR identity,
 * focus isolation, and allocation sampling therefore execute without loading
 * apparatus from .local-only.
 */

const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')

const acceptanceSession = require('./studio-acceptance-session.cjs')
const harness = require('./studio-acceptance-harness.cjs')
const speechFixture = require('./studio-generate-speech-fixture.cjs')
const { compareWindowCaptureToReference } = require('./studio-pixel-evidence-verifier.cjs')

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

/**
 * Permitted visible player count. Stated here and asserted literally in a control
 * so the band cannot be widened without a test noticing.
 */
const DIAGNOSTICS_PLAYER_COUNT_BOUNDS = { minimum: 1, maximum: 2 }

/**
 * Every resource-sample field serialized into the verdict's resourceDelta. Listed
 * explicitly so a field cannot be reported as evidence without also being
 * required to be a finite reading.
 */
/**
 * A raw OCR digest must be a real SHA-256 hex digest. A one-character string is
 * "present" but carries no information, and evidence that carries no information
 * is not evidence - it only makes a schema check pass.
 */
const DIAGNOSTICS_OCR_DIGEST_PATTERN = /^[0-9a-f]{64}$/

/**
 * Absurdity ceiling for a HUD asset-match distance. This is NOT the matcher's
 * accept/reject threshold - the matcher owns that. It only refuses values that
 * cannot be a distance at all.
 */
const DIAGNOSTICS_MAX_ASSET_MATCH_DISTANCE = 4096

/** Bound on the serialized surface/region identity arrays. */
const DIAGNOSTICS_MAX_IDENTITY_ENTRIES = 4096

/** The two identity arrays serialized into resourceDelta as evidence. */
const REQUIRED_RESOURCE_IDENTITY_ARRAYS = ['productSurfaceIds', 'mappedRegionIdentities']

const REQUIRED_RESOURCE_FIELDS = [
  'physicalFootprintBytes',
  'peakPhysicalFootprintBytes',
  'mallocAllocatedBytes',
  'iosurfaceVirtualBytes',
  'iosurfaceResidentBytes',
  'iosurfaceRegionCount'
]

/** Tolerance when matching a rounded HUD timecode back to an exact source PTS. */
const PTS_SELECTION_TOLERANCE_SECONDS = 0.000_501

/** Half-width of the ffmpeg select bracket around the exact source PTS. */
const PTS_BRACKET_HALF_WIDTH_SECONDS = 0.000_001

/**
 * Session-layer functions this runner requires for an end-to-end observation.
 * The list is executable: module load fails if the tracked session facade stops
 * carrying one, instead of discovering the drift after a packaged app launches.
 */
const TRACKED_SESSION_DEPENDENCIES = [
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
for (const dependency of TRACKED_SESSION_DEPENDENCIES) {
  if (typeof acceptanceSession[dependency] !== 'function') {
    throw new Error('tracked Studio acceptance session is missing ' + dependency)
  }
}

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

function parseStudioTimecodeText(text, frameRate = speechFixture.FIXTURE_FRAME_RATE) {
  if (typeof text !== 'string') return null
  const decimal = text.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/)
  if (decimal) {
    return (
      Number(decimal[1]) * 3_600 +
      Number(decimal[2]) * 60 +
      Number(decimal[3]) +
      Number(decimal[4]) / 1_000
    )
  }
  const framed = text.match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/)
  if (
    !framed ||
    !Number.isSafeInteger(frameRate) ||
    frameRate <= 0 ||
    Number(framed[4]) >= frameRate
  ) {
    return null
  }
  return (
    Number(framed[1]) * 3_600 +
    Number(framed[2]) * 60 +
    Number(framed[3]) +
    Number(framed[4]) / frameRate
  )
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
  const contentPtsText = texts.find((text) => /^\d{2}:\d{2}:\d{2}(?:\.\d{3}|:\d{2})$/.test(text))
  const field = (label) => {
    const matches = [...joined.matchAll(new RegExp('\\b' + label + '\\s*([0-9oøØe]+)', 'gi'))]
    return parseOcrInteger(matches.at(-1)?.[1])
  }
  const rssMatch = joined.match(/\brss\s*([0-9.]+)\s*MB/i)
  const stateTokens = texts
    .filter((text) => typeof text === 'string')
    .map((text) => text.trim())
    .filter((text) => text === 'PLAY' || text === 'PAUSE')
  const state = stateTokens.length === 1 ? stateTokens[0] : null
  return {
    contentPtsText: contentPtsText || null,
    contentPtsSeconds: parseStudioTimecodeText(contentPtsText),
    state,
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
    assetMatch: { ...matchAsset(hud, assetId), assetId },
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
function assertDiagnostics(samples, firstResources, lastResources, options) {
  const parsed = samples.map((sample) => sample.observed)
  if (parsed.length < 2) {
    throw new Error('bounded diagnostics needs at least two samples to prove advance')
  }

  // THE CLAIM MUST NAME ITS SUBJECT. Previously the samples were the only source
  // of asset identity, so an internally consistent set about the WRONG media
  // satisfied the claim. The caller now declares what it opened and every sample
  // must have been matched against exactly that token.
  const expectedAssetId = options?.expectedAssetId
  if (typeof expectedAssetId !== 'string' || expectedAssetId.length < 1) {
    throw new Error(
      'bounded diagnostics requires the caller to declare the expected asset identity: ' +
        JSON.stringify({ expectedAssetId: expectedAssetId ?? null })
    )
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
    // THE PLAYHEAD. A string playhead coerces perfectly: '20' - '10' is 10 and
    // 300/10 is 30, so ptsAdvanced and presentedRate both read correct while
    // nothing numeric was ever measured. null/NaN/Infinity previously rejected
    // only as a side effect of downstream arithmetic, not by validation.
    //
    // Number.isFinite is the load-bearing guard here and does NOT coerce, so it
    // rejects '10' on its own - a mutation removing the typeof clause stays green,
    // measured. The typeof clause is kept as belt-and-braces against a future
    // refactor to the GLOBAL isFinite, which does coerce and would reopen this.
    const pts = sample.contentPtsSeconds
    if (
      typeof pts !== 'number' ||
      !Number.isFinite(pts) ||
      pts < 0 ||
      pts > describeFixtureContract().durationSeconds
    ) {
      throw new Error(
        'visible playhead is unreadable or out of range at sample ' +
          String(index) +
          ': ' +
          JSON.stringify({ value: pts, maximumSeconds: describeFixtureContract().durationSeconds })
      )
    }

    // ASSET IDENTITY. Nothing in this claim previously checked it, so the whole
    // of Outcome 9 could have been satisfied by screenshots of entirely different
    // media whose counters happened to advance. isPlayableSample checked it, but
    // no tracked composition enforced that join.
    const assetMatch = sample.assetMatch
    if (
      !assetMatch ||
      assetMatch.matched !== true ||
      assetMatch.assetId !== expectedAssetId ||
      !Number.isSafeInteger(assetMatch.distance) ||
      assetMatch.distance < 0 ||
      assetMatch.distance > DIAGNOSTICS_MAX_ASSET_MATCH_DISTANCE
    ) {
      throw new Error(
        'sample does not show the opened asset at sample ' +
          String(index) +
          ': ' +
          JSON.stringify({ assetMatch: assetMatch ?? null, expectedAssetId })
      )
    }

    // The HUD timecode and the parsed playhead are serialized side by side. If
    // they disagree, the OCR parse is untrustworthy and neither is evidence.
    const reparsedPts = parseStudioTimecodeText(sample.contentPtsText)
    if (reparsedPts === null || Math.abs(reparsedPts - pts) > Number.EPSILON) {
      throw new Error(
        'visible timecode disagrees with the parsed playhead at sample ' +
          String(index) +
          ': ' +
          JSON.stringify({
            text: sample.contentPtsText ?? null,
            parsed: pts,
            reparsed: reparsedPts
          })
      )
    }

    // OBSERVATION IDENTITY. The verdict now serializes these digests, so a reader
    // can re-derive which OCR output each reading came from. Requiring it keeps
    // that field from being silently absent on the evidence it rests on.
    if (
      typeof sample.rawOcrSha256 !== 'string' ||
      !DIAGNOSTICS_OCR_DIGEST_PATTERN.test(sample.rawOcrSha256)
    ) {
      throw new Error(
        'observation identity (raw OCR digest) is missing or malformed at sample ' +
          String(index) +
          ': ' +
          JSON.stringify({ value: sample.rawOcrSha256 ?? null })
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

  // PLAYER-COUNT STABILITY. The claim is named playerCountStable, but only the
  // FIRST and LAST samples were compared - so a 1 -> 2 -> 1 excursion reported
  // stable:true while a second player existed mid-run, which is precisely the
  // shared-decoder violation the claim exists to detect.
  const expectedPlayerCount = parsed[0].players.count
  for (const [index, sample] of parsed.entries()) {
    if (
      sample.players.count !== expectedPlayerCount ||
      sample.players.count < DIAGNOSTICS_PLAYER_COUNT_BOUNDS.minimum ||
      sample.players.count > DIAGNOSTICS_PLAYER_COUNT_BOUNDS.maximum
    ) {
      throw new Error(
        'visible player count is unstable or out of bounds at sample ' +
          String(index) +
          ': ' +
          JSON.stringify({
            value: sample.players.count,
            expected: expectedPlayerCount,
            bounds: DIAGNOSTICS_PLAYER_COUNT_BOUNDS
          })
      )
    }
  }

  // RESOURCE SAMPLES. Every field below is serialized into resourceDelta as
  // evidence; a non-numeric or absent reading previously produced a coerced or
  // NaN delta while the verdict still returned ok.
  for (const [label, resource] of [
    ['first', firstResources],
    ['last', lastResources]
  ]) {
    const processRssKilobytes = resource?.ps?.rssKilobytes
    if (!resource || !Number.isSafeInteger(processRssKilobytes) || processRssKilobytes < 0) {
      throw new Error(
        'resource sample process RSS is unreadable or not a real quantity: ' +
          JSON.stringify({ phase: label, value: processRssKilobytes ?? null })
      )
    }
    for (const field of REQUIRED_RESOURCE_FIELDS) {
      const value = resource[field]
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(
          'resource sample field is unreadable or not a real quantity: ' +
            JSON.stringify({ phase: label, field, value: value ?? null })
        )
      }
    }

    // The identity arrays are serialized into resourceDelta as evidence. An empty
    // array is a legitimate probe result; a missing one, a non-array, an oversized
    // one, or one holding blank entries is not, and must not be reported as though
    // the probe had measured something.
    for (const field of REQUIRED_RESOURCE_IDENTITY_ARRAYS) {
      const entries = resource[field]
      if (!Array.isArray(entries) || entries.length > DIAGNOSTICS_MAX_IDENTITY_ENTRIES) {
        throw new Error(
          'resource sample identity array is missing, malformed or oversized: ' +
            JSON.stringify({
              phase: label,
              field,
              length: Array.isArray(entries) ? entries.length : null,
              maximum: DIAGNOSTICS_MAX_IDENTITY_ENTRIES
            })
        )
      }
      for (const [entryIndex, entry] of entries.entries()) {
        const validString = typeof entry === 'string' && entry.trim().length > 0
        const validNumber = Number.isSafeInteger(entry) && entry >= 0
        if (!validString && !validNumber) {
          throw new Error(
            'resource sample identity entry is not a usable identity: ' +
              JSON.stringify({ phase: label, field, entryIndex, entry: entry ?? null })
          )
        }
      }
    }
  }

  // Two observations cannot legitimately share a raw OCR digest: that is the same
  // captured image, which cannot show two different advancing counter readings.
  const digests = parsed.map((sample) => sample.rawOcrSha256)
  if (new Set(digests).size !== digests.length) {
    throw new Error(
      'observation identities are not distinct - the same capture was reused: ' +
        JSON.stringify({ digests })
    )
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
    expectedAssetId,
    observationIdentities: parsed.map((sample, index) => ({
      index,
      rawOcrSha256: sample.rawOcrSha256,
      assetMatched: sample.assetMatch.matched,
      contentPtsSeconds: sample.contentPtsSeconds
    })),
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function sourcePtsCensus(assetPath, adapters = {}) {
  const run = adapters.runExact || acceptanceSession.runExact
  const command = buildFramePtsCensusCommand(assetPath)
  const receipt = run(acceptanceSession.resolveMediaTool('ffprobe'), command, {
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024
  })
  const parsed = parseFramePtsCensus(receipt.stdout)
  const expected = describeFixtureContract().expectedFrameCount
  if (parsed.count !== expected) {
    throw new Error(
      'bounded diagnostics generated fixture census changed: ' +
        JSON.stringify({ expected, actual: parsed.count })
    )
  }
  return {
    ...parsed,
    command: receipt.command
  }
}

function generateReference(assetPath, exactSourcePtsSeconds, referencePath, adapters = {}) {
  const run = adapters.runExact || acceptanceSession.runExact
  const command = buildReferenceExtractCommand({
    assetPath,
    exactSourcePtsSeconds,
    referencePath
  })
  const receipt = run(acceptanceSession.resolveMediaTool('ffmpeg'), command, {
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024
  })
  return {
    path: referencePath,
    sha256: acceptanceSession.sha256File(referencePath),
    exactSourcePtsSeconds,
    command: receipt.command
  }
}

async function capturePlayableSample(
  plan,
  target,
  census,
  bounds,
  sourceHostFrame,
  index,
  previousPtsSeconds,
  adapters = {}
) {
  acceptanceSession.assertWindowServerSessionAvailable(index, 'before-capture')
  const capture = await (adapters.captureNative || acceptanceSession.captureNative)(
    plan,
    target,
    'diagnostics-' + String(index)
  )
  acceptanceSession.assertWindowServerSessionAvailable(index, 'after-capture')
  const hud = (adapters.ocrScreenshot || acceptanceSession.ocrScreenshot)(capture.path)
  const observed = parseVisibleHud(hud, target.asset.sha256, {
    matchAsset: adapters.hudContainsAsset || acceptanceSession.hudContainsAsset
  })
  const playable = isPlayableSample(observed, previousPtsSeconds)
  if (!playable.valid) {
    throw new Error(
      'bounded diagnostics sample is not playable: ' +
        JSON.stringify({ index, reasons: playable.reasons, observed })
    )
  }
  const exactSourcePtsSeconds = resolveExactSourcePts(census.values, observed.contentPtsSeconds)
  const reference = (adapters.generateReference || generateReference)(
    target.asset.assetPath,
    exactSourcePtsSeconds,
    path.join(plan.artifactRoot, 'diagnostics-reference-' + String(index) + '.png'),
    adapters
  )
  const materialPixels = (
    adapters.compareWindowCaptureToReference || compareWindowCaptureToReference
  )(capture.path, reference.path, bounds, { sourceHostFrame })
  if (materialPixels.clean !== true) {
    throw new Error(
      'bounded diagnostics WindowServer frame disagrees with decoded source: ' +
        JSON.stringify({ index, metrics: materialPixels.metrics })
    )
  }
  return {
    index,
    sourceHostFrame,
    capture,
    hud,
    observed,
    playable,
    exactSourcePtsSeconds,
    reference,
    materialPixels
  }
}

async function readSourceWorkspaceObservation(plan, target, windowBounds, adapters = {}) {
  const runDriver = adapters.runStudioUiDriver || harness.runStudioUiDriver
  const receipt = await runDriver(plan, target, [{ type: 'read-workspace' }], {
    ...(adapters.driverAdapters || {}),
    inputDelivery: 'background-observation-only',
    allowForegroundInput: false
  })
  const actions = Array.isArray(receipt?.actions)
    ? receipt.actions.filter((action) => action?.type === 'read-workspace')
    : []
  if (actions.length !== 1) {
    throw new Error('bounded diagnostics workspace read did not return exactly one action')
  }
  const workspace = harness.validateStudioWorkspaceObservation(
    actions[0].workspace,
    windowBounds
  )
  if (
    workspace.sourceRoute?.value !== 'selected' ||
    workspace.sourceHost?.visible !== true ||
    !workspace.sourceHost?.frame
  ) {
    throw new Error('bounded diagnostics requires Source selected and visibly presented')
  }
  return {
    receipt,
    workspace,
    sourceHostFrame: workspace.sourceHost.frame
  }
}

async function pressPlaybackTransition(plan, target, before, after, adapters = {}) {
  if (!['paused', 'playing'].includes(before) || !['paused', 'playing'].includes(after) || before === after) {
    throw new Error('bounded diagnostics Playback transition is not an exact state change')
  }
  const runDriver = adapters.runStudioUiDriver || harness.runStudioUiDriver
  const receipt = await runDriver(
    plan,
    target,
    [{ type: 'press-playback', playbackValueBefore: before, playbackValueAfter: after }],
    {
      ...(adapters.driverAdapters || {}),
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false
    }
  )
  const actions = Array.isArray(receipt?.actions) ? receipt.actions : []
  if (
    receipt?.inputDelivery !== 'background-observation-only' ||
    actions.length !== 1
  ) {
    throw new Error('bounded diagnostics Playback transition receipt is not one background action')
  }
  const action = actions[0]
  const expectedKeys = [
    'accessibilityAction',
    'accessibilityLabel',
    'index',
    'playbackValueAfter',
    'playbackValueBefore',
    'type'
  ]
  if (
    JSON.stringify(Object.keys(action).sort()) !== JSON.stringify(expectedKeys) ||
    action.index !== 0 ||
    action.type !== 'press-playback' ||
    action.accessibilityLabel !== 'Playback' ||
    action.accessibilityAction !== 'AXPress' ||
    action.playbackValueBefore !== before ||
    action.playbackValueAfter !== after
  ) {
    throw new Error('bounded diagnostics Playback transition receipt is forged or malformed')
  }
  return receipt
}

async function waitFor(label, probe, timeoutMs = 30_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() <= deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''}`
  )
}

async function waitForPausedMediaReadiness(plan, target, windowBounds, adapters = {}, options = {}) {
  const runCapture = adapters.captureNative || acceptanceSession.captureNative
  const observe = async () => {
    const workspaceObservation = await readSourceWorkspaceObservation(
      plan,
      target,
      windowBounds,
      adapters
    )
    const capture = await runCapture(plan, target, 'diagnostics-readiness')
    const hud = (adapters.ocrScreenshot || acceptanceSession.ocrScreenshot)(capture.path)
    const observed = parseVisibleHud(hud, target.asset.sha256, {
      matchAsset: adapters.hudContainsAsset || acceptanceSession.hudContainsAsset
    })
    const durationTicks = capture.transportMutationBracket?.after?.parsedValue?.afterDurationTicks
    if (
      capture.transportMutationBracket?.ok !== true ||
      observed.state !== 'PAUSE' ||
      observed.assetMatch?.matched !== true ||
      observed.assetMatch?.distance !== 0 ||
      !Number.isFinite(observed.contentPtsSeconds) ||
      typeof durationTicks !== 'string' ||
      !/^[1-9]\d*$/.test(durationTicks)
    ) {
      throw new Error(
        'bounded diagnostics media is not ready for playback: ' +
          JSON.stringify({ observed, durationTicks, transportMutationBracket: capture.transportMutationBracket })
      )
    }
    return { workspaceObservation, capture, hud, observed }
  }
  return waitFor(
    'paused exact Studio media readiness',
    observe,
    options.timeoutMs ?? 30_000,
    options.intervalMs ?? 250
  )
}

async function captureFreshPlayableSample(
  plan,
  target,
  census,
  bounds,
  index,
  previousPtsSeconds,
  adapters = {}
) {
  const workspaceObservation = await readSourceWorkspaceObservation(
    plan,
    target,
    bounds,
    adapters
  )
  const sample = await capturePlayableSample(
    plan,
    target,
    census,
    bounds,
    workspaceObservation.sourceHostFrame,
    index,
    previousPtsSeconds,
    adapters
  )
  return { ...sample, workspaceObservation }
}

async function runBoundedDiagnostics(options = {}, adapters = {}) {
  const artifactRoot = path.resolve(String(options.artifactRoot || ''))
  if (
    !path.isAbsolute(artifactRoot) ||
    artifactRoot === path.parse(artifactRoot).root ||
    fs.existsSync(artifactRoot)
  ) {
    throw new Error('bounded diagnostics requires a fresh absolute artifact root')
  }
  const staticCustody = acceptanceSession.assertAcceptanceCustody()
  await fsPromises.mkdir(path.dirname(artifactRoot), { recursive: true, mode: 0o700 })
  await fsPromises.mkdir(artifactRoot, { recursive: false, mode: 0o700 })
  const inputs = await (
    adapters.materializePortableInputs || acceptanceSession.materializePortableInputs
  )(artifactRoot, adapters.inputAdapters || {})
  const custody = acceptanceSession.assertAcceptanceCustody(inputs)
  const runtime = await (adapters.prepareFreshRuntime || acceptanceSession.prepareFreshRuntime)(
    artifactRoot,
    inputs
  )
  acceptanceSession.assertWindowServerSessionAvailable(-1, 'preflight')
  const startedAt = new Date().toISOString()
  const result = await (adapters.withIsolatedSession || acceptanceSession.withIsolatedSession)(
    runtime,
    {
      phase: 'bounded-visible-diagnostics',
      remoteDebuggingPort: options.remoteDebuggingPort || 9460,
      mainInspectorPort: options.mainInspectorPort || 9860,
      timeoutMs: options.timeoutMs || 210_000
    },
    async (context) => {
      const plan = { ...context.plan, artifactRoot }
      await sleep(options.hydrationSettleMilliseconds ?? 15_000)
      const focusBeforeOpen = acceptanceSession.focusSnapshot(context.companion.pid)
      const openResult = await acceptanceSession.invokeStudioOpen(context.renderer, runtime.asset)
      const window = await acceptanceSession.waitForSourceWindow(context.companion)
      const focusAfterOpen = acceptanceSession.focusSnapshot(context.companion.pid)
      const openFocusIsolation = acceptanceSession.assertSourceWindowFocusIsolation(
        focusBeforeOpen,
        focusAfterOpen,
        context.companion.pid
      )
      const bounds = acceptanceSession.windowBounds(window)
      const target = {
        companion: context.companion,
        electronPgid: context.session.pgid,
        window,
        expectedWindowTitle: 'TaskWraith Studio',
        asset: runtime.asset
      }
      const readiness = await waitForPausedMediaReadiness(plan, target, bounds, adapters)
      const focusBeforePlaybackStart = acceptanceSession.focusSnapshot(context.companion.pid)
      const playbackStart = await pressPlaybackTransition(
        plan,
        target,
        'paused',
        'playing',
        adapters
      )
      const focusAfterPlaybackStart = acceptanceSession.focusSnapshot(context.companion.pid)
      const playbackStartFocusIsolation = acceptanceSession.assertSourceWindowFocusIsolation(
        focusBeforePlaybackStart,
        focusAfterPlaybackStart,
        context.companion.pid
      )
      const census = sourcePtsCensus(runtime.asset.assetPath, adapters)
      const samples = []
      samples.push(
        await captureFreshPlayableSample(plan, target, census, bounds, 0, null, adapters)
      )
      const firstResources = acceptanceSession.resourceSample(
        context.companion.pid,
        0,
        samples[0].observed.contentPtsSeconds,
        adapters.resourceAdapters || {}
      )
      await sleep(options.sampleIntervalMilliseconds ?? 5_000)
      samples.push(
        await captureFreshPlayableSample(
          plan,
          target,
          census,
          bounds,
          1,
          samples.at(-1).observed.contentPtsSeconds,
          adapters
        )
      )
      await sleep(options.sampleIntervalMilliseconds ?? 5_000)
      samples.push(
        await captureFreshPlayableSample(
          plan,
          target,
          census,
          bounds,
          2,
          samples.at(-1).observed.contentPtsSeconds,
          adapters
        )
      )
      const lastResources = acceptanceSession.resourceSample(
        context.companion.pid,
        2,
        samples.at(-1).observed.contentPtsSeconds,
        adapters.resourceAdapters || {}
      )
      const focusBeforePlaybackStop = acceptanceSession.focusSnapshot(context.companion.pid)
      const playbackStop = await pressPlaybackTransition(
        plan,
        target,
        'playing',
        'paused',
        adapters
      )
      const focusAfterPlaybackStop = acceptanceSession.focusSnapshot(context.companion.pid)
      const playbackStopFocusIsolation = acceptanceSession.assertSourceWindowFocusIsolation(
        focusBeforePlaybackStop,
        focusAfterPlaybackStop,
        context.companion.pid
      )
      const diagnosticsVerdict = assertDiagnostics(samples, firstResources, lastResources, {
        expectedAssetId: runtime.asset.sha256
      })
      const focusAtEnd = acceptanceSession.focusSnapshot(context.companion.pid)
      const finalFocusIsolation = acceptanceSession.assertSourceWindowFocusIsolation(
        focusAfterOpen,
        focusAtEnd,
        context.companion.pid
      )
      return {
        asset: runtime.asset,
        readiness,
        workspaceObservation: samples[0].workspaceObservation,
        openResult,
        playback: {
          start: playbackStart,
          stop: playbackStop,
          focusIsolation: {
            start: playbackStartFocusIsolation,
            stop: playbackStopFocusIsolation
          }
        },
        focusIsolation: {
          open: openFocusIsolation,
          final: finalFocusIsolation
        },
        census: {
          count: census.count,
          command: census.command
        },
        samples,
        resources: {
          first: firstResources,
          last: lastResources
        },
        diagnosticsVerdict,
        portOwnership: context.portOwnership,
        mainIdentity: context.mainIdentity
      }
    }
  )
  const custodyAfter = acceptanceSession.assertAcceptanceCustody(inputs)
  const evidence = {
    schemaVersion: 1,
    kind: 'taskwraith-studio-bounded-visible-playback-diagnostics',
    ok: true,
    startedAt,
    recordedAt: new Date().toISOString(),
    staticCustody,
    custody,
    custodyAfter,
    inputBoundary: {
      mode: 'background-observation-only',
      foregroundInputUsed: false,
      manualInputRequired: false
    },
    inputs,
    ...result
  }
  const evidencePath = path.join(artifactRoot, 'evidence.json')
  await acceptanceSession.writeJson(evidencePath, evidence)
  return {
    evidencePath,
    evidenceSha256: acceptanceSession.sha256File(evidencePath),
    evidence
  }
}

function parseDiagnosticsCli(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { help: true, artifactRoot: null }
  }
  let artifactRoot = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument.startsWith('--artifact-root=')) {
      artifactRoot = argument.slice('--artifact-root='.length)
    } else if (argument === '--artifact-root' && index + 1 < argv.length) {
      artifactRoot = argv[++index]
    } else {
      throw new Error('unknown bounded diagnostics argument: ' + argument)
    }
  }
  if (!artifactRoot) throw new Error('--artifact-root is required')
  return { help: false, artifactRoot }
}

module.exports = {
  DIAGNOSTICS_MAX_ASSET_MATCH_DISTANCE,
  DIAGNOSTICS_MAX_IDENTITY_ENTRIES,
  DIAGNOSTICS_OCR_DIGEST_PATTERN,
  DIAGNOSTICS_PLAYER_COUNT_BOUNDS,
  DIAGNOSTICS_PRESENTED_RATE_BOUNDS,
  DIAGNOSTICS_VISIBLE_RSS_CEILING_MEGABYTES,
  REQUIRED_RESOURCE_FIELDS,
  REQUIRED_RESOURCE_IDENTITY_ARRAYS,
  REQUIRED_VISIBLE_COUNTERS,
  PTS_SELECTION_TOLERANCE_SECONDS,
  TRACKED_SESSION_DEPENDENCIES,
  assertDiagnostics,
  buildFramePtsCensusCommand,
  buildReferenceExtractCommand,
  describeFixtureContract,
  isPlayableSample,
  mediaToolCandidates,
  parseFramePtsCensus,
  parseDiagnosticsCli,
  parseOcrInteger,
  parseStudioTimecodeText,
  parseVisibleHud,
  capturePlayableSample,
  captureFreshPlayableSample,
  pressPlaybackTransition,
  waitForPausedMediaReadiness,
  readSourceWorkspaceObservation,
  repoRoot,
  resolveExactSourcePts,
  resolveMediaTool,
  runBoundedDiagnostics
}

if (require.main === module) {
  let cli
  try {
    cli = parseDiagnosticsCli(process.argv.slice(2))
  } catch (error) {
    console.error(
      '[studio-bounded-diagnostics-runner] FAIL — ' +
        (error instanceof Error ? error.message : String(error))
    )
    process.exitCode = 1
  }
  if (cli?.help) {
    process.stdout.write(
      'Usage: node scripts/studio-bounded-diagnostics-runner.cjs --artifact-root=/fresh/absolute/path\n'
    )
  } else if (cli) {
    runBoundedDiagnostics({ artifactRoot: cli.artifactRoot }).catch((error) => {
      console.error(
        '[studio-bounded-diagnostics-runner] FAIL — ' +
          (error instanceof Error ? error.message : String(error))
      )
      process.exitCode = 1
    })
  }
}
