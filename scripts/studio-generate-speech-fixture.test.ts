import { describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  ACCEPTANCE_SPEECH_TEXT,
  BITEXACT_FFMPEG_FLAGS,
  DEFAULT_FIXTURE_DURATION_SECONDS,
  buildMuxCommand,
  buildSayCommand,
  describeFixturePlan,
  expectedTranscriptPhrases,
  verifyFixtureManifest
} = require('./studio-generate-speech-fixture.cjs')

const SPEECH = '/tmp/fix/acceptance-speech.aiff'
const OUT = '/tmp/fix/test-clip-speech.mp4'

describe('the spoken passage is a single source of truth', () => {
  // THE VACUOUS-CONTROL TRAP THIS EXISTS TO PREVENT: if the spoken text and the
  // phrases the journey asserts against are separate literals, they drift, and
  // the adjudication silently becomes "a transcript arrived" instead of "the
  // RIGHT transcript arrived". Both must come from one constant.
  it('derives the expected phrases from the text that is actually spoken', () => {
    const phrases = expectedTranscriptPhrases()
    expect(phrases.length).toBeGreaterThan(2)
    for (const phrase of phrases) {
      expect(ACCEPTANCE_SPEECH_TEXT.toLowerCase()).toContain(phrase.toLowerCase())
    }
  })

  it('spreads its assertable phrases across the passage so cue-seek has range', () => {
    // The property that matters is NOT a sentence count — that was an arbitrary
    // number. It is that the phrases a journey asserts against are distributed,
    // so seeking to an early cue and a late cue land in genuinely different
    // places rather than both resolving inside one breath.
    expect(ACCEPTANCE_SPEECH_TEXT.length).toBeGreaterThan(120)
    const phrases = expectedTranscriptPhrases()
    const positions = phrases.map((p: string) =>
      ACCEPTANCE_SPEECH_TEXT.toLowerCase().indexOf(p.toLowerCase())
    )
    expect(Math.min(...positions)).toBeLessThan(ACCEPTANCE_SPEECH_TEXT.length * 0.25)
    expect(Math.max(...positions)).toBeGreaterThan(ACCEPTANCE_SPEECH_TEXT.length * 0.75)
    // And more than one sentence, so segmentation has a boundary to find.
    expect(
      ACCEPTANCE_SPEECH_TEXT.split('.').filter((s: string) => s.trim()).length
    ).toBeGreaterThanOrEqual(2)
  })
})

describe('the say command is deterministic and self-contained', () => {
  const argv = () => buildSayCommand({ outputPath: SPEECH })

  it('pins the voice and rate, because the default voice follows system settings', () => {
    // Without an explicit voice and rate the output tracks the operator's
    // Accessibility preferences, so the "deterministic" fixture would differ
    // between machines while every hash check still looked fine locally.
    expect(argv()).toContain('-v')
    expect(argv()).toContain('Samantha')
    expect(argv()).toContain('-r')
    expect(argv()).toContain('165')
  })

  it('writes to the requested path and speaks exactly the shared passage', () => {
    const command = argv()
    expect(command[command.indexOf('-o') + 1]).toBe(SPEECH)
    expect(command).toContain(ACCEPTANCE_SPEECH_TEXT)
  })
})

describe('the mux command generates its own video and stays bit-exact', () => {
  const argv = (overrides = {}) =>
    buildMuxCommand({ speechPath: SPEECH, outputPath: OUT, durationSeconds: 5, ...overrides })

  it('sources video from lavfi rather than any pre-existing file', () => {
    const command = argv()
    const lavfiIndex = command.indexOf('lavfi')
    expect(lavfiIndex).toBeGreaterThan(-1)
    expect(command[lavfiIndex - 1]).toBe('-f')
    // The recorded 2026-08-14 recipe mixed speech into a RETAINED 168MB clip,
    // so it could never be regenerated from source. Nothing here may reference
    // a path that is not this run's own speech file or its own output.
    for (const argument of command) {
      if (typeof argument !== 'string') continue
      if (argument === SPEECH || argument === OUT) continue
      expect(argument.includes('/')).toBe(false)
    }
  })

  it('carries every bit-exact flag, each named LITERALLY so the check cannot shrink', () => {
    const command = argv()
    // Deliberately NOT iterating BITEXACT_FFMPEG_FLAGS. Deriving the expectation
    // from the constant the command is built from is a tautology: delete a flag
    // from the constant and the loop stops looking for it. These are written out
    // so removing any one of them fails here.
    expect(command).toContain('-fflags')
    expect(command).toContain('-flags:v')
    expect(command).toContain('-flags:a')
    expect(command.filter((a: string) => a === '+bitexact')).toHaveLength(3)
    // The exported constant must still agree with that literal list, so a
    // reader cannot be misled about which flags are enforced.
    expect(BITEXACT_FFMPEG_FLAGS).toEqual([
      '-fflags',
      '+bitexact',
      '-flags:v',
      '+bitexact',
      '-flags:a',
      '+bitexact'
    ])
    // Encoder version strings land in container metadata and differ between
    // ffmpeg builds, so stripping metadata is part of determinism, not tidiness.
    const metadataIndex = command.indexOf('-map_metadata')
    expect(metadataIndex).toBeGreaterThan(-1)
    expect(command[metadataIndex + 1]).toBe('-1')
  })

  it('pins pixel format, rate and audio rate so the decode side is stable too', () => {
    const command = argv()
    expect(command[command.indexOf('-pix_fmt') + 1]).toBe('yuv420p')
    expect(command[command.indexOf('-ar') + 1]).toBe('48000')
    expect(command[command.indexOf('-t') + 1]).toBe('5')
  })

  it('refuses a non-positive or non-finite duration', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => argv({ durationSeconds: bad })).toThrow(/duration/i)
    }
  })
})

describe('the fixture plan describes what the journey may assert', () => {
  it('publishes the duration, frame rate and the exact spoken passage', () => {
    const plan = describeFixturePlan({ durationSeconds: DEFAULT_FIXTURE_DURATION_SECONDS })
    expect(plan.durationSeconds).toBe(DEFAULT_FIXTURE_DURATION_SECONDS)
    expect(plan.frameRate).toBe(30)
    expect(plan.expectedFrameCount).toBe(DEFAULT_FIXTURE_DURATION_SECONDS * 30)
    expect(plan.speechText).toBe(ACCEPTANCE_SPEECH_TEXT)
    expect(plan.expectedPhrases).toEqual(expectedTranscriptPhrases())
  })

  it('states plainly that recognition accuracy is not asserted by generation', () => {
    // Generating the fixture proves the AUDIO contains the passage. It does not
    // promise the recognizer will return it. Saying so here stops a later
    // reader treating fixture determinism as recognition evidence.
    expect(describeFixturePlan({ durationSeconds: 5 }).provenanceNote).toMatch(
      /does not.*recogni|recogni.*not/i
    )
  })
})

describe('manifest verification fails closed', () => {
  const good = () => ({
    speechSha256: 'a'.repeat(64),
    outputSha256: 'b'.repeat(64),
    durationSeconds: 600,
    frameRate: 30,
    speechText: ACCEPTANCE_SPEECH_TEXT,
    sayCommand: buildSayCommand({ outputPath: SPEECH }),
    muxCommand: buildMuxCommand({ speechPath: SPEECH, outputPath: OUT, durationSeconds: 600 })
  })

  it('accepts a complete manifest', () => {
    expect(verifyFixtureManifest(good())).toEqual({ ok: true, failures: [] })
  })

  it('is red for a missing, short or non-hex digest, naming which one', () => {
    expect(
      verifyFixtureManifest({ ...good(), speechSha256: undefined }).failures.join(' ')
    ).toMatch(/speechSha256/)
    expect(
      verifyFixtureManifest({ ...good(), outputSha256: 'b'.repeat(63) }).failures.join(' ')
    ).toMatch(/outputSha256/)
    expect(
      verifyFixtureManifest({ ...good(), outputSha256: 'z'.repeat(64) }).failures.join(' ')
    ).toMatch(/outputSha256/)
  })

  it('is red when the recorded passage is not the passage the generator speaks', () => {
    // A manifest that drifted from the constant would let the journey assert
    // phrases the audio never contained.
    const drifted = { ...good(), speechText: 'Something else entirely.' }
    expect(verifyFixtureManifest(drifted).failures.join(' ')).toMatch(/speechText/)
  })

  it('is red when the recorded commands are absent or not the generated ones', () => {
    expect(verifyFixtureManifest({ ...good(), sayCommand: undefined }).failures.join(' ')).toMatch(
      /sayCommand/
    )
    // ISOLATED: this command carries every bit-exact flag, so ONLY the
    // synthesised-source check can object. Without that isolation the flag
    // check reds instead and the lavfi rule is never actually exercised.
    const retainedSource = [
      'ffmpeg',
      ...BITEXACT_FFMPEG_FLAGS,
      '-i',
      '/some/retained/clip.mp4',
      '-map_metadata',
      '-1'
    ]
    const verdict = verifyFixtureManifest({ ...good(), muxCommand: retainedSource })
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.join(' ')).toMatch(/did not synthesise its video source/)
  })

  it('is red on an implausible duration or frame rate', () => {
    expect(verifyFixtureManifest({ ...good(), durationSeconds: 0 }).failures.join(' ')).toMatch(
      /durationSeconds/
    )
    expect(verifyFixtureManifest({ ...good(), frameRate: 0 }).failures.join(' ')).toMatch(
      /frameRate/
    )
  })
})
