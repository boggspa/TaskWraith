import { describe, expect, it } from 'vitest'

import {
  APP_DRIVE_PREVIEW_MAX_BYTES,
  appDrivePreviewFrameFromDaemon,
  shouldRequestPreviewFrame
} from './AppDrivePreviewFrame'

/** Minimal well-formed payload: the PNG signature, base64-encoded. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAGXveEwAAAABJRU5ErkJggg=='

const source = {
  hasFrame: true,
  pngBase64: PNG,
  width: 800,
  height: 600,
  capturedAt: '2026-08-03T20:00:01.000Z'
}

describe('appDrivePreviewFrameFromDaemon', () => {
  it('builds a png data URL and stamps the live attachment generation', () => {
    const result = appDrivePreviewFrameFromDaemon({ source, generation: 4 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frame.dataUrl).toBe(`data:image/png;base64,${PNG}`)
    expect(result.frame.width).toBe(800)
    expect(result.frame.height).toBe(600)
    expect(result.frame.capturedAt).toBe('2026-08-03T20:00:01.000Z')
    expect(result.frame.generation).toBe(4)
  })

  it('refuses when there is no attachment generation to bind to', () => {
    const result = appDrivePreviewFrameFromDaemon({ source, generation: null })
    expect(result).toEqual({ ok: false, reason: 'no_attachment' })
  })

  it('reports an empty stream as no_frame, not a failure', () => {
    expect(appDrivePreviewFrameFromDaemon({ source: { hasFrame: false }, generation: 1 })).toEqual({
      ok: false,
      reason: 'no_frame'
    })
    expect(appDrivePreviewFrameFromDaemon({ source: undefined, generation: 1 })).toEqual({
      ok: false,
      reason: 'no_frame'
    })
    expect(
      appDrivePreviewFrameFromDaemon({ source: { hasFrame: true, pngBase64: '' }, generation: 1 })
    ).toEqual({ ok: false, reason: 'no_frame' })
  })

  it('never lets a reply choose its own scheme or media type', () => {
    // The value lands in an <img src>. A daemon-supplied string that is not
    // base64 PNG must be refused rather than concatenated into a URL.
    for (const pngBase64 of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+', // base64 <svg><script>
      'not base64!!'
    ]) {
      const result = appDrivePreviewFrameFromDaemon({
        source: { ...source, pngBase64 },
        generation: 1
      })
      expect(result).toEqual({ ok: false, reason: 'malformed_frame' })
    }
  })

  it('refuses a frame without honest dimensions', () => {
    for (const dims of [{ width: 0 }, { height: -4 }, { width: 12.5 }, { width: undefined }]) {
      const result = appDrivePreviewFrameFromDaemon({
        source: { ...source, ...dims },
        generation: 1
      })
      expect(result).toEqual({ ok: false, reason: 'malformed_frame' })
    }
  })

  it('bounds the payload by its own length, not the reported byteLength', () => {
    const oversized = 'iVBORw0KGgo' + 'A'.repeat(APP_DRIVE_PREVIEW_MAX_BYTES * 2)
    const result = appDrivePreviewFrameFromDaemon({
      // A small byteLength claim must not smuggle a large image past the ceiling.
      source: { ...source, pngBase64: oversized, byteLength: 128 },
      generation: 1
    })
    expect(result).toEqual({ ok: false, reason: 'frame_too_large' })
  })

  it('tolerates a missing capture timestamp rather than inventing one', () => {
    const result = appDrivePreviewFrameFromDaemon({
      source: { ...source, capturedAt: '   ' },
      generation: 1
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frame.capturedAt).toBeNull()
  })
})

describe('shouldRequestPreviewFrame', () => {
  it('polls only while an attachment is streaming', () => {
    expect(shouldRequestPreviewFrame({ observation: null })).toBe(false)
    expect(shouldRequestPreviewFrame({ observation: {} })).toBe(false)
    expect(shouldRequestPreviewFrame({ observation: { streaming: { frameCount: 0 } } })).toBe(true)
  })
})
