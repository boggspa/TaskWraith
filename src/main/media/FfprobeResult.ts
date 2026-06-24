/**
 * PURE parser for `ffprobe -print_format json` output. ffprobe's JSON has several
 * traps that bite naive consumers (all verified against ffprobe behavior):
 *  - duration / bit_rate / sample_rate arrive as QUOTED STRINGS; width / height /
 *    channels are real ints.
 *  - frame rate is a RATIONAL string ("30000/1001"); use avg_frame_rate (not
 *    r_frame_rate) and guard the 0/0 case (cover art / no video) → no fps.
 *  - rotation is dual-path: modern side_data_list "Display Matrix" rotation (often
 *    NEGATIVE, e.g. -90) vs legacy tags.rotate — read both, normalize to [0,360).
 *  - HDR is signalled by color_transfer (smpte2084 / arib-std-b67), NOT color_primaries.
 *  - album/cover art is a FAKE video stream (disposition.attached_pic === 1) — it
 *    must not be mistaken for real video.
 */

export interface MediaProbeFormat {
  formatName?: string
  durationMs?: number
  bitRate?: number
  sizeBytes?: number
}
export interface MediaProbeVideo {
  codec?: string
  width?: number
  height?: number
  fps?: number
  rotationDeg?: number
  hdr?: boolean
  pixFmt?: string
}
export interface MediaProbeAudio {
  codec?: string
  channels?: number
  sampleRate?: number
  bitRate?: number
}
export interface MediaProbeInfo {
  format: MediaProbeFormat
  video?: MediaProbeVideo
  audio?: MediaProbeAudio
  hasVideo: boolean
  hasAudio: boolean
  /** A cover-art-only file (audio with embedded album art, no real video stream). */
  coverArtOnly: boolean
}

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function asStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
/** ffprobe numbers may be real numbers OR quoted strings — accept both. */
function asNum(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
function parseRational(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const m = /^(-?\d+)\/(\d+)$/.exec(value.trim())
  if (!m) {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  const den = Number(m[2])
  if (den === 0) return undefined // 0/0 — "no frame rate" (cover art / still)
  return Number(m[1]) / den
}
function normalizeDeg(value: number): number {
  return ((Math.round(value) % 360) + 360) % 360
}
function parseRotation(stream: Record<string, unknown>): number | undefined {
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : []
  for (const entry of sideData) {
    const rot = asNum(asObj(entry).rotation)
    if (rot !== undefined) return normalizeDeg(rot)
  }
  const tagRotate = asNum(asObj(stream.tags).rotate)
  return tagRotate !== undefined ? normalizeDeg(tagRotate) : undefined
}

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67'])

function isVideo(stream: Record<string, unknown>): boolean {
  return stream.codec_type === 'video'
}
function isAttachedPic(stream: Record<string, unknown>): boolean {
  return asObj(stream.disposition).attached_pic === 1
}

export function parseFfprobeJson(
  jsonText: string
): { ok: true; info: MediaProbeInfo } | { ok: false; error: string } {
  let root: unknown
  try {
    root = JSON.parse(jsonText)
  } catch {
    return { ok: false, error: 'ffprobe output was not valid JSON' }
  }
  const rootObj = asObj(root)
  const rawStreams = Array.isArray(rootObj.streams) ? rootObj.streams : []
  const streams = rawStreams.map(asObj)
  const fmt = asObj(rootObj.format)

  const format: MediaProbeFormat = {}
  const formatName = asStr(fmt.format_name)
  if (formatName) format.formatName = formatName
  const durSec = asNum(fmt.duration)
  if (durSec !== undefined) format.durationMs = Math.round(durSec * 1000)
  const bitRate = asNum(fmt.bit_rate)
  if (bitRate !== undefined) format.bitRate = bitRate
  const sizeBytes = asNum(fmt.size)
  if (sizeBytes !== undefined) format.sizeBytes = sizeBytes

  const realVideo = streams.find((s) => isVideo(s) && !isAttachedPic(s))
  const coverArt = streams.find((s) => isVideo(s) && isAttachedPic(s))
  const audioStream = streams.find((s) => s.codec_type === 'audio')

  let video: MediaProbeVideo | undefined
  if (realVideo) {
    video = {}
    const codec = asStr(realVideo.codec_name)
    if (codec) video.codec = codec
    const w = asNum(realVideo.width)
    if (w !== undefined) video.width = Math.round(w)
    const h = asNum(realVideo.height)
    if (h !== undefined) video.height = Math.round(h)
    const fps = parseRational(realVideo.avg_frame_rate)
    if (fps !== undefined && fps > 0) video.fps = Math.round(fps * 1000) / 1000
    const rotation = parseRotation(realVideo)
    if (rotation !== undefined) video.rotationDeg = rotation
    const pixFmt = asStr(realVideo.pix_fmt)
    if (pixFmt) video.pixFmt = pixFmt
    const transfer = asStr(realVideo.color_transfer)
    if (transfer && HDR_TRANSFERS.has(transfer)) video.hdr = true
  }

  let audio: MediaProbeAudio | undefined
  if (audioStream) {
    audio = {}
    const codec = asStr(audioStream.codec_name)
    if (codec) audio.codec = codec
    const channels = asNum(audioStream.channels)
    if (channels !== undefined) audio.channels = Math.round(channels)
    const sampleRate = asNum(audioStream.sample_rate)
    if (sampleRate !== undefined) audio.sampleRate = Math.round(sampleRate)
    const abr = asNum(audioStream.bit_rate)
    if (abr !== undefined) audio.bitRate = abr
  }

  return {
    ok: true,
    info: {
      format,
      ...(video ? { video } : {}),
      ...(audio ? { audio } : {}),
      hasVideo: !!realVideo,
      hasAudio: !!audioStream,
      coverArtOnly: !realVideo && !!coverArt
    }
  }
}
