import { describe, expect, it } from 'vitest'
import { parseFfprobeJson } from './FfprobeResult'

function probe(obj: unknown): ReturnType<typeof parseFfprobeJson> {
  return parseFfprobeJson(JSON.stringify(obj))
}

describe('parseFfprobeJson', () => {
  it('parses a typical H.264 video: quoted-string numbers, int dims, avg_frame_rate', () => {
    const r = probe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920, // real int
          height: 1080,
          avg_frame_rate: '30000/1001', // rational string → 29.97
          r_frame_rate: '30/1', // must be IGNORED in favor of avg
          pix_fmt: 'yuv420p'
        },
        { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', bit_rate: '128000' }
      ],
      format: { format_name: 'mov,mp4,m4a', duration: '12.345000', bit_rate: '2500000', size: '4000000' }
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.info.hasVideo).toBe(true)
    expect(r.info.hasAudio).toBe(true)
    expect(r.info.coverArtOnly).toBe(false)
    expect(r.info.video).toMatchObject({ codec: 'h264', width: 1920, height: 1080, fps: 29.97, pixFmt: 'yuv420p' })
    expect(r.info.audio).toMatchObject({ codec: 'aac', channels: 2, sampleRate: 48000, bitRate: 128000 })
    expect(r.info.format).toMatchObject({ durationMs: 12345, bitRate: 2500000, sizeBytes: 4000000 })
  })

  it('reads rotation from the side_data Display Matrix (negative → normalized)', () => {
    const r = probe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1080,
          height: 1920,
          avg_frame_rate: '30/1',
          side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }]
        }
      ],
      format: {}
    })
    expect(r.ok && r.info.video?.rotationDeg).toBe(270) // -90 normalized to [0,360)
  })

  it('falls back to legacy tags.rotate when no side_data is present', () => {
    const r = probe({
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 100, height: 100, avg_frame_rate: '30/1', tags: { rotate: '90' } }],
      format: {}
    })
    expect(r.ok && r.info.video?.rotationDeg).toBe(90)
  })

  it('detects HDR from color_transfer (smpte2084), not color_primaries alone', () => {
    const hdr = probe({
      streams: [{ codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, avg_frame_rate: '24/1', color_primaries: 'bt2020', color_transfer: 'smpte2084' }],
      format: {}
    })
    const sdr = probe({
      streams: [{ codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, avg_frame_rate: '24/1', color_primaries: 'bt2020', color_transfer: 'bt709' }],
      format: {}
    })
    expect(hdr.ok && hdr.info.video?.hdr).toBe(true)
    expect(sdr.ok && (sdr.info.video?.hdr ?? false)).toBe(false)
  })

  it('treats a cover-art (attached_pic) stream as NOT real video', () => {
    const r = probe({
      streams: [
        { codec_type: 'audio', codec_name: 'mp3', channels: 2, sample_rate: '44100' },
        { codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, avg_frame_rate: '90000/3753', disposition: { attached_pic: 1 } }
      ],
      format: { format_name: 'mp3', duration: '180.0' }
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.info.hasVideo).toBe(false) // the mjpeg is cover art, not video
    expect(r.info.hasAudio).toBe(true)
    expect(r.info.coverArtOnly).toBe(true)
    expect(r.info.video).toBeUndefined()
  })

  it('guards the 0/0 avg_frame_rate (no fps)', () => {
    const r = probe({
      streams: [{ codec_type: 'video', codec_name: 'png', width: 800, height: 600, avg_frame_rate: '0/0' }],
      format: {}
    })
    expect(r.ok && r.info.video && 'fps' in r.info.video).toBe(false)
  })

  it('handles audio-only files', () => {
    const r = probe({
      streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '44100' }],
      format: { format_name: 'wav', duration: '3.5' }
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.info.hasVideo).toBe(false)
    expect(r.info.hasAudio).toBe(true)
    expect(r.info.coverArtOnly).toBe(false)
    expect(r.info.format.durationMs).toBe(3500)
  })

  it('rejects non-JSON output', () => {
    expect(parseFfprobeJson('not json').ok).toBe(false)
    expect(parseFfprobeJson('').ok).toBe(false)
  })

  it('caps a pathologically long metadata string to 256 chars', () => {
    const r = probe({
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 100, height: 100, avg_frame_rate: '30/1', pix_fmt: 'p'.repeat(5000) }],
      format: { format_name: 'f'.repeat(5000), duration: '1.0' }
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.info.format.formatName?.length).toBe(256)
    expect(r.info.video?.pixFmt?.length).toBe(256)
  })

  it('drops negative/garbage magnitude numerics (duration, bit_rate, dims) but KEEPS negative rotation', () => {
    const r = probe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: -1920, // garbage → dropped
          height: 1080,
          avg_frame_rate: '30/1',
          side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] // negative is VALID here
        },
        { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', bit_rate: '-128000' }
      ],
      format: { format_name: 'mp4', duration: '-12.0', bit_rate: '-2500000' }
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Negative format magnitudes are dropped, not surfaced as negatives.
    expect(r.info.format.durationMs).toBeUndefined()
    expect(r.info.format.bitRate).toBeUndefined()
    // Negative width dropped; positive height kept.
    expect(r.info.video && 'width' in r.info.video).toBe(false)
    expect(r.info.video?.height).toBe(1080)
    expect(r.info.audio && 'bitRate' in r.info.audio).toBe(false)
    // Rotation legitimately negative → still normalized (regression guard).
    expect(r.info.video?.rotationDeg).toBe(270)
  })
})
