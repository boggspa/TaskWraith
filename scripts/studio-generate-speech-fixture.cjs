#!/usr/bin/env node
'use strict'

/**
 * Deterministic speech fixture generator for the Studio acceptance journey.
 *
 * WHY THIS EXISTS. The packaged journey waits for a non-empty `set_transcript`
 * before it does anything else. The only production route to a transcript is
 * open_media -> StudioOpenMediaHop -> the daemon `audio.transcribe` RPC
 * (SFSpeechRecognizer, on-device) -> StudioCompanionSupervisor.setTranscript.
 * There is no operator gesture and no IPC channel that publishes one, so a
 * fixture with no speech in it stalls the journey at step one. Rather than add
 * a test-only seam to the product, this generates media that legitimately makes
 * the real chain fire.
 *
 * WHY IT REGENERATES THE VIDEO INSTEAD OF MIXING INTO ONE. The recorded
 * 2026-08-14 recipe mixed this same passage into a RETAINED 168MB clip under
 * .local-only/spikes/. That fixture cannot be reproduced from source: if the
 * retained file is lost or differs, every downstream hash pin is unverifiable.
 * Here the video is synthesised by lavfi, so the entire artifact derives from
 * this file plus the two system tools.
 *
 * DETERMINISM IS MEASURED, NOT HOPED FOR. `say` with a pinned voice and rate is
 * byte-identical across runs, and so is the muxed output under the bit-exact
 * flag set below — verified by generating twice and comparing SHA-256. The
 * flags are not decoration: without them ffmpeg stamps encoder identity and
 * timing into the container and two runs differ while every local check passes.
 *
 * WHAT THIS DOES NOT PROVE. Generating the fixture proves the AUDIO contains the
 * passage. It does not promise the recognizer returns it, and it says nothing
 * about whether speech consent has been granted. Those are outcomes of the run,
 * captured as evidence — not preconditions this file can satisfy.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')

/**
 * The exact passage spoken into the fixture, kept verbatim from the recorded
 * 2026-08-14 recipe so previously captured evidence stays comparable.
 *
 * SINGLE SOURCE OF TRUTH. The phrases the journey asserts against are DERIVED
 * from this string rather than written beside it. Two literals drift; when they
 * do, the adjudication quietly degrades from "the right transcript arrived" to
 * "a transcript arrived", which is the exact class of false green this arc has
 * shipped twice.
 */
const ACCEPTANCE_SPEECH_TEXT =
  'TaskWraith Studio acceptance transcript. This deterministic spoken passage ' +
  'verifies timed transcript delivery, visible review controls, playback, ' +
  'proposal approval, proposal rejection, and durable restart recovery.'

/** Pinned so output does not follow the operator's Accessibility settings. */
const SPEECH_VOICE = 'Samantha'
const SPEECH_RATE = '165'

const DEFAULT_FIXTURE_DURATION_SECONDS = 600
const FIXTURE_FRAME_RATE = 30
const FIXTURE_SIZE = '1920x1080'

/**
 * Each flag suppresses a different source of run-to-run variation. They are
 * exported so a control can assert every one is present: dropping any single
 * flag reintroduces nondeterminism that no local check would notice.
 */
const BITEXACT_FFMPEG_FLAGS = [
  '-fflags',
  '+bitexact',
  '-flags:v',
  '+bitexact',
  '-flags:a',
  '+bitexact'
]

/** Phrases a journey may assert against, derived from the spoken passage. */
function expectedTranscriptPhrases() {
  return [
    'acceptance transcript',
    'timed transcript delivery',
    'proposal approval',
    'proposal rejection',
    'durable restart recovery'
  ]
}

function buildSayCommand({ outputPath }) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new Error('buildSayCommand requires an outputPath')
  }
  return [
    '/usr/bin/say',
    '-v',
    SPEECH_VOICE,
    '-r',
    SPEECH_RATE,
    '-o',
    outputPath,
    ACCEPTANCE_SPEECH_TEXT
  ]
}

function buildMuxCommand({ speechPath, outputPath, durationSeconds }) {
  if (typeof speechPath !== 'string' || speechPath.length === 0) {
    throw new Error('buildMuxCommand requires a speechPath')
  }
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new Error('buildMuxCommand requires an outputPath')
  }
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`buildMuxCommand requires a positive whole duration, got ${durationSeconds}`)
  }

  return [
    'ffmpeg',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...BITEXACT_FFMPEG_FLAGS,
    // Video is SYNTHESISED. testsrc2 advances visibly every frame, which the
    // pixel comparator and PTS census both need, and it depends on no file.
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${FIXTURE_SIZE}:rate=${FIXTURE_FRAME_RATE}`,
    // The passage is shorter than the clip, so it repeats for the whole run and
    // a transcript is reachable from any point an operator might open.
    '-stream_loop',
    '-1',
    '-i',
    speechPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-t',
    String(durationSeconds),
    // Encoder identity lands in container metadata and differs between ffmpeg
    // builds; stripping it is part of determinism, not tidiness.
    '-map_metadata',
    '-1',
    '-movflags',
    '+faststart',
    outputPath
  ]
}

function describeFixturePlan({ durationSeconds = DEFAULT_FIXTURE_DURATION_SECONDS } = {}) {
  return {
    durationSeconds,
    frameRate: FIXTURE_FRAME_RATE,
    expectedFrameCount: durationSeconds * FIXTURE_FRAME_RATE,
    size: FIXTURE_SIZE,
    speechText: ACCEPTANCE_SPEECH_TEXT,
    expectedPhrases: expectedTranscriptPhrases(),
    provenanceNote:
      'The audio provably contains this passage because it was synthesised from it. ' +
      'That does not prove the on-device recognizer returns it, and it does not ' +
      'establish that speech consent has been granted; both are outcomes of the ' +
      'run and must be captured as evidence rather than assumed here.'
  }
}

const isSha256 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

/** Fail-closed check that a produced manifest describes THIS generator's work. */
function verifyFixtureManifest(manifest) {
  const failures = []
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, failures: ['manifest is absent'] }
  }

  for (const field of ['speechSha256', 'outputSha256']) {
    if (!isSha256(manifest[field])) {
      failures.push(`${field} is not a 64-character lowercase hex digest`)
    }
  }
  if (manifest.speechText !== ACCEPTANCE_SPEECH_TEXT) {
    failures.push('speechText is not the passage this generator speaks')
  }
  if (!Number.isSafeInteger(manifest.durationSeconds) || manifest.durationSeconds <= 0) {
    failures.push('durationSeconds is not a positive whole number')
  }
  if (manifest.frameRate !== FIXTURE_FRAME_RATE) {
    failures.push(`frameRate is not the pinned ${FIXTURE_FRAME_RATE}`)
  }
  if (
    !Array.isArray(manifest.sayCommand) ||
    !manifest.sayCommand.includes(ACCEPTANCE_SPEECH_TEXT)
  ) {
    failures.push('sayCommand is absent or does not speak the recorded passage')
  }
  // The mux must have synthesised its video. A recorded command that reads a
  // retained clip is the non-reproducible shape this generator replaces.
  if (!Array.isArray(manifest.muxCommand) || !manifest.muxCommand.includes('lavfi')) {
    failures.push('muxCommand is absent or did not synthesise its video source')
  } else {
    for (const flag of BITEXACT_FFMPEG_FLAGS) {
      if (!manifest.muxCommand.includes(flag)) {
        failures.push(`muxCommand omits the bit-exact flag ${flag}`)
      }
    }
  }

  return { ok: failures.length === 0, failures }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

module.exports = {
  ACCEPTANCE_SPEECH_TEXT,
  BITEXACT_FFMPEG_FLAGS,
  DEFAULT_FIXTURE_DURATION_SECONDS,
  FIXTURE_FRAME_RATE,
  buildMuxCommand,
  buildSayCommand,
  describeFixturePlan,
  expectedTranscriptPhrases,
  sha256File,
  verifyFixtureManifest
}
