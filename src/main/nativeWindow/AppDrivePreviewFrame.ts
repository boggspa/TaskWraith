/**
 * App Drive dock preview frame — the bounded projection behind the dock's
 * "Preview appears when Screen Watch is streaming" surface.
 *
 * WHAT THIS IS. A local mirror, inside TaskWraith's own dock, of the window the
 * *user themselves* picked in the Screen Watch picker. It adds no egress and no
 * authority: it mints no lease, admits no action, consumes no step budget, and
 * never reaches a provider. It is strictly less exposure than the already
 * shipped agent-facing `appwatch_latest_frame`, which does send these pixels to
 * a provider.
 *
 * WHAT THIS IS NOT — do not let the surface drift into claiming either:
 *
 * 1. **It is not secret-redacted.** The native capture path refuses outright
 *    when a secure field is present (design §12b) and the web canvas paints
 *    credential boxes over before capture (`secretsRedacted`).
 *    `appwatch.latestFrame` does neither — it returns raw window pixels and
 *    carries no redaction signal at all. Never label this preview "redacted"
 *    unless the daemon starts reporting one: a security claim that holds for
 *    one path and not another is worse than no claim, because it is the one
 *    people quote.
 * 2. **It is not an authorization signal.** A visible preview says the user
 *    attached a window, never that an agent may act on it. Control lives in the
 *    lease projection alongside it.
 *
 * The data URL is always CONSTRUCTED HERE from a validated base64 payload and a
 * hardcoded `image/png` prefix. A daemon-supplied URL is never passed through:
 * the value lands in an `<img src>`, so accepting a foreign string would let a
 * malformed or compromised reply choose the scheme and media type.
 */

/** Raw `appwatch.latestFrame` daemon reply. Every field is untrusted. */
export interface AppDrivePreviewFrameSource {
  readonly hasFrame?: boolean
  readonly pngBase64?: string
  readonly byteLength?: number
  readonly width?: number
  readonly height?: number
  readonly capturedAt?: string
}

export type AppDrivePreviewFrameRefusal =
  /** No Screen Watch attachment for this chat. */
  | 'no_attachment'
  /** Attached, but the stream has produced no frame yet. */
  | 'no_frame'
  /** Decoded PNG exceeds the dock ceiling. Refused whole, never truncated. */
  | 'frame_too_large'
  /** The reply did not describe a PNG this surface is willing to render. */
  | 'malformed_frame'

export interface AppDrivePreviewFrame {
  /** Always `data:image/png;base64,…`, built here. */
  readonly dataUrl: string
  readonly width: number
  readonly height: number
  readonly capturedAt: string | null
  readonly byteLength: number
  /**
   * Attachment generation this frame was captured under. The renderer discards
   * a frame whose generation no longer matches the live attachment: painting a
   * previous target's pixels under the current target's label is the bug this
   * field exists to prevent.
   */
  readonly generation: number
}

export type AppDrivePreviewFrameResult =
  | { readonly ok: true; readonly frame: AppDrivePreviewFrame }
  | { readonly ok: false; readonly reason: AppDrivePreviewFrameRefusal }

/**
 * Decoded-PNG ceiling for one dock preview. Generous enough for a retina
 * window, bounded so a poll cannot stream unbounded bytes across the IPC
 * boundary. Oversized frames are refused whole — a partial image would render
 * as a corrupt preview rather than an honest absence.
 */
export const APP_DRIVE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024

/** `iVBORw0KGgo` is base64 for the 8-byte PNG signature. */
const PNG_BASE64_MAGIC = 'iVBORw0KGgo'
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

function positiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}

/**
 * True only while a preview could exist: an attachment is live and its Screen
 * Watch stream is running. The handler gates on this so a dock poll against an
 * attached-but-not-streaming window costs no daemon request. Policy lives here
 * rather than in the renderer so there is one place that decides.
 */
export function shouldRequestPreviewFrame(status: {
  readonly observation: { readonly streaming?: { readonly frameCount: number } } | null
}): boolean {
  if (!status.observation) return false
  return Boolean(status.observation.streaming)
}

/**
 * Validate one daemon reply into a renderable, generation-stamped frame.
 * Pure: no clock, no IO. `generation` is the caller's live attachment
 * generation, read at request time.
 */
export function appDrivePreviewFrameFromDaemon(input: {
  readonly source: AppDrivePreviewFrameSource | null | undefined
  readonly generation: number | null
}): AppDrivePreviewFrameResult {
  const generation = input.generation
  if (typeof generation !== 'number' || !Number.isInteger(generation)) {
    return { ok: false, reason: 'no_attachment' }
  }
  const source = input.source
  if (!source || source.hasFrame !== true) return { ok: false, reason: 'no_frame' }

  const pngBase64 = source.pngBase64
  if (typeof pngBase64 !== 'string' || pngBase64.length === 0) {
    return { ok: false, reason: 'no_frame' }
  }
  // Media type is checked before the payload is ever concatenated into a URL,
  // so a non-PNG reply cannot pick its own scheme. The magic prefix is a head
  // comparison, so it stays cheap on a large payload.
  if (!pngBase64.startsWith(PNG_BASE64_MAGIC)) return { ok: false, reason: 'malformed_frame' }

  // Trust the payload's own length over the reported one: byteLength is a hint
  // from the same untrusted reply, so a small claim must not smuggle a large
  // image past the ceiling. Checked before the full-payload regex below so an
  // oversized reply is refused without first being scanned end to end.
  const decodedBytes = Math.floor((pngBase64.length * 3) / 4)
  if (decodedBytes > APP_DRIVE_PREVIEW_MAX_BYTES) {
    return { ok: false, reason: 'frame_too_large' }
  }

  if (!BASE64_PATTERN.test(pngBase64)) return { ok: false, reason: 'malformed_frame' }

  const width = positiveInteger(source.width)
  const height = positiveInteger(source.height)
  if (width === null || height === null) return { ok: false, reason: 'malformed_frame' }

  const capturedAt =
    typeof source.capturedAt === 'string' && source.capturedAt.trim().length > 0
      ? source.capturedAt
      : null

  return {
    ok: true,
    frame: Object.freeze({
      dataUrl: `data:image/png;base64,${pngBase64}`,
      width,
      height,
      capturedAt,
      byteLength: decodedBytes,
      generation
    })
  }
}
