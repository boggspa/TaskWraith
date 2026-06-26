import { describe, expect, it } from 'vitest'
import { buildAvMediaRef } from './AvMediaRef'

describe('buildAvMediaRef', () => {
  it('builds an audio ref (happy path) with the fixed container/generated/available fields', () => {
    const ref = buildAvMediaRef({
      sha256: 'a'.repeat(64),
      mimeType: 'audio/mp4',
      name: 'clip.m4a',
      runId: 'r1',
      byteLength: 1234,
      durationMs: 5000,
      codecs: 'aac'
    })
    expect(ref).not.toBeNull()
    expect(ref!.kind).toBe('audio')
    expect(ref!.format).toBe('container')
    expect(ref!.source).toBe('generated')
    expect(ref!.status).toBe('available')
    expect(ref!.mimeType).toBe('audio/mp4')
    expect(ref!.sha256).toBe('a'.repeat(64))
    expect(ref!.name).toBe('clip.m4a')
    expect(ref!.byteLength).toBe(1234)
    expect(ref!.durationMs).toBe(5000)
    expect(ref!.codecs).toBe('aac')
    expect(ref!.id).toBe(`r1:av:${'a'.repeat(24)}`)
  })

  it('builds a video ref (happy path) and derives kind=video from the mime prefix', () => {
    const ref = buildAvMediaRef({ sha256: 'b'.repeat(64), mimeType: 'video/mp4', name: 'out.mp4' })
    expect(ref).not.toBeNull()
    expect(ref!.kind).toBe('video')
    expect(ref!.format).toBe('container')
    expect(ref!.source).toBe('generated')
    expect(ref!.status).toBe('available')
  })

  it('derives kind from the mime: audio/* → audio, video/* → video', () => {
    expect(buildAvMediaRef({ sha256: 'c'.repeat(64), mimeType: 'audio/wav', name: 'a.wav' })!.kind).toBe('audio')
    expect(buildAvMediaRef({ sha256: 'c'.repeat(64), mimeType: 'audio/flac', name: 'a.flac' })!.kind).toBe('audio')
    expect(buildAvMediaRef({ sha256: 'c'.repeat(64), mimeType: 'video/quicktime', name: 'v.mov' })!.kind).toBe('video')
    expect(buildAvMediaRef({ sha256: 'c'.repeat(64), mimeType: 'video/webm', name: 'v.webm' })!.kind).toBe('video')
  })

  it('returns null on an unknown / non-AV mime', () => {
    expect(buildAvMediaRef({ sha256: 'd'.repeat(64), mimeType: 'image/png', name: 'x.png' })).toBeNull()
    expect(buildAvMediaRef({ sha256: 'd'.repeat(64), mimeType: 'application/octet-stream', name: 'x.bin' })).toBeNull()
    expect(buildAvMediaRef({ sha256: 'd'.repeat(64), mimeType: '', name: 'x' })).toBeNull()
  })

  it('returns null on an empty sha256', () => {
    expect(buildAvMediaRef({ sha256: '', mimeType: 'audio/mp4', name: 'x.m4a' })).toBeNull()
    expect(buildAvMediaRef({ sha256: '   ', mimeType: 'audio/mp4', name: 'x.m4a' })).toBeNull()
  })

  it('always produces a non-empty id (renderer drops refs with an empty id)', () => {
    const withRun = buildAvMediaRef({ sha256: 'e'.repeat(64), mimeType: 'video/mp4', name: 'v.mp4', runId: 'run-9' })
    expect(withRun!.id.length).toBeGreaterThan(0)
    expect(withRun!.id).toContain('run-9')
    // No runId still yields a non-empty id (falls back to the 'run' sentinel).
    const noRun = buildAvMediaRef({ sha256: 'e'.repeat(64), mimeType: 'video/mp4', name: 'v.mp4' })
    expect(noRun!.id.length).toBeGreaterThan(0)
    expect(noRun!.id.startsWith('run:av:')).toBe(true)
  })

  it('fixes format/source/status regardless of input', () => {
    const ref = buildAvMediaRef({ sha256: 'f'.repeat(64), mimeType: 'audio/mpeg', name: 'song.mp3' })
    expect(ref!.format).toBe('container')
    expect(ref!.source).toBe('generated')
    expect(ref!.status).toBe('available')
  })

  it('omits byteLength/durationMs/codecs when not provided', () => {
    const ref = buildAvMediaRef({ sha256: 'a'.repeat(64), mimeType: 'audio/wav', name: 'a.wav' })
    expect(ref!.byteLength).toBeUndefined()
    expect(ref!.durationMs).toBeUndefined()
    expect(ref!.codecs).toBeUndefined()
  })

  it('threads a provided thumbnail through (pure passthrough)', () => {
    const thumbnail = { dataBase64: 'UE9TVEVS', mimeType: 'image/jpeg', width: 320, height: 180 }
    const ref = buildAvMediaRef({ sha256: 'a'.repeat(64), mimeType: 'video/mp4', name: 'v.mp4', thumbnail })
    expect(ref!.thumbnail).toEqual(thumbnail)
  })

  it('omits the thumbnail when not provided / empty', () => {
    expect(buildAvMediaRef({ sha256: 'a'.repeat(64), mimeType: 'video/mp4', name: 'v.mp4' })!.thumbnail).toBeUndefined()
    // An empty dataBase64 is dropped (never ship a useless poster).
    const empty = buildAvMediaRef({
      sha256: 'a'.repeat(64),
      mimeType: 'video/mp4',
      name: 'v.mp4',
      thumbnail: { dataBase64: '', mimeType: 'image/jpeg' }
    })
    expect(empty!.thumbnail).toBeUndefined()
  })

  it('threads a well-formed peaks envelope through (ints 0..255)', () => {
    const ref = buildAvMediaRef({
      sha256: 'a'.repeat(64),
      mimeType: 'audio/wav',
      name: 'a.wav',
      peaks: [0, 64, 128, 255]
    })
    expect(ref!.peaks).toEqual([0, 64, 128, 255])
  })

  it('coerces/clamps peaks (round to int, clamp 0..255, drop non-finite) — fail-tolerant', () => {
    const ref = buildAvMediaRef({
      sha256: 'a'.repeat(64),
      mimeType: 'audio/wav',
      name: 'a.wav',
      peaks: [-10, 12.6, 300, Number.NaN, 200]
    })
    // -10→0, 12.6→13, 300→255, NaN dropped, 200→200.
    expect(ref!.peaks).toEqual([0, 13, 255, 200])
    for (const v of ref!.peaks!) {
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(255)
    }
  })

  it('HARD-caps the peaks array at 512 buckets', () => {
    const ref = buildAvMediaRef({
      sha256: 'a'.repeat(64),
      mimeType: 'audio/wav',
      name: 'a.wav',
      peaks: Array.from({ length: 3000 }, () => 100)
    })
    expect(ref!.peaks).toHaveLength(512)
  })

  it('omits peaks when absent / empty / fully malformed', () => {
    expect(buildAvMediaRef({ sha256: 'a'.repeat(64), mimeType: 'audio/wav', name: 'a.wav' })!.peaks).toBeUndefined()
    expect(
      buildAvMediaRef({ sha256: 'a'.repeat(64), mimeType: 'audio/wav', name: 'a.wav', peaks: [] })!.peaks
    ).toBeUndefined()
    // All non-finite → nothing survives the filter → omitted.
    expect(
      buildAvMediaRef({
        sha256: 'a'.repeat(64),
        mimeType: 'audio/wav',
        name: 'a.wav',
        peaks: [Number.NaN, Number.POSITIVE_INFINITY]
      })!.peaks
    ).toBeUndefined()
  })
})
