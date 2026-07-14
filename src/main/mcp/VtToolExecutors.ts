import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import { buildAvMediaRef, type AvPosterResult, type GeneratePoster } from '../media/AvMediaRef'

/**
 * VideoToolbox MCP tool executors. Pure logic — the realpath input jail and the
 * daemon RPC are both INJECTED (VtToolDeps), so this is unit-testable without the
 * Swift bridge daemon or Electron. The security boundary lives in the injected
 * `jailInput` (realpath-jail a workspace path); `decodeFrame` / `encodeClip` are
 * the daemon RPCs (`video.decodeFrame` / `video.encodeClip`) the host implements
 * in index.ts.
 *
 * `video_decode_frame` extracts a SINGLE video frame via the daemon's native
 * VideoToolbox (hardware-accelerated; works WITHOUT a user-installed ffmpeg). The
 * decoded frame is a PNG, so — exactly like `video_thumbnail` — it rides the PROVEN
 * image-block lane: we return an `{ type: 'image', mimeType: 'image/png', data }`
 * content block, which the host turns into media_refs (createToolResultMediaRefs)
 * and renders inline. It does NOT use the trusted AV channel.
 *
 * `video_encode_clip` re-encodes a SEGMENT of a workspace video to an H.264 MP4 via
 * the daemon's native VideoToolbox (hardware-accelerated; no ffmpeg). Its output is
 * a VIDEO FILE, so — exactly like the ffmpeg `transcode_video` producer — it CANNOT
 * ride the image-block lane and instead travels the TRUSTED AV channel: the daemon
 * writes the MP4 to a staging path WE own, we read + persist it to the content-
 * addressed asset store (the injected `persistOutput`), and return a media ref built
 * by `buildAvMediaRef` on `McpToolExecutionResult.trustedMediaRefs`. That ref is un-
 * forgeable (only this main-side executor can construct the result) and bypasses the
 * image-only provider sanitizer (which hard-drops kind!=='image').
 *
 * `video_concat_clips` joins N video SEGMENTS (each a workspace video + optional trim)
 * into one H.264 MP4 via the daemon's native VideoToolbox (hardware-accelerated; no
 * ffmpeg). Like `video_encode_clip` the output is a VIDEO FILE, so it rides the same
 * TRUSTED AV channel (persist + `trustedMediaRefs`). EACH segment path is realpath-
 * jailed through the VIDEO jail (`jailInput`) before the daemon ever sees it; any one
 * segment's jail failure aborts the whole concat (the daemon is never invoked).
 *
 * `audio_mix` mixes N workspace AUDIO tracks (each with optional gain/pan/offset/fade)
 * down to one WAV or M4A file via the daemon's native audio engine (`audio.mixdown`;
 * no ffmpeg). Like the video producers the output is an AUDIO FILE, so it rides the
 * same TRUSTED AV channel (persist + `trustedMediaRefs`) — output mime is the
 * asset-store-known `audio/wav` (wav) or `audio/mp4` (m4a). EACH track's `sourcePath`
 * is realpath-jailed through the audio/video jail (`jailInput`) before the daemon ever
 * sees it; any one track's jail failure aborts the whole mix (the daemon is never
 * invoked), exactly like `video_concat_clips`.
 *
 * `transcribe_audio` runs ON-DEVICE speech-to-text on a workspace AUDIO file via the
 * daemon's native Speech framework (`audio.transcribe`; SFSpeechRecognizer, on-device
 * ONLY — no network fallback, the privacy invariant). UNLIKE the producers it writes
 * NO file and emits NO media ref: it returns the transcript as STRUCTURED TEXT (the
 * formatted string + a JSON per-segment array). READ-ONLY (orchestration). The
 * `sourcePath` is realpath-jailed through `jailInput` before the daemon runs; a daemon
 * error (incl. an OS permission denial) is surfaced verbatim via `fail(...)` so the
 * model gets the actionable "enable it in System Settings" message.
 */

export const VT_MCP_TOOL_NAMES = ['video_decode_frame', 'inspect_video_frames', 'video_encode_clip', 'video_concat_clips', 'audio_mix', 'transcribe_audio'] as const
export type VtMcpToolName = (typeof VT_MCP_TOOL_NAMES)[number]

export function isVtMcpToolName(name: string): name is VtMcpToolName {
  return (VT_MCP_TOOL_NAMES as readonly string[]).includes(name)
}

export interface VtToolContext {
  appChatId?: string
  appRunId?: string
  workspacePath?: string
}

export type VtJailedInput =
  | { ok: true; realPath: string; cleanup: () => boolean | void }
  | { ok: false; reason: string }

type Awaitable<T> = T | Promise<T>

export interface VtToolDeps {
  jailInput: (sourcePath: string, ctx: VtToolContext) => Awaitable<VtJailedInput>
  /**
   * Realpath-jail a workspace IMAGE path for the optional encode overlay. DISTINCT
   * from `jailInput`: the overlay is a PNG/JPEG/WebP composited over every frame, so
   * this jails via `validateWorkspaceImagePath` (accepts PNG/JPEG/WebP, REJECTS SVG,
   * size-capped). It must NOT reuse `jailInput`, whose `validateWorkspaceMediaPath`
   * sniffs AUDIO/VIDEO mime and would reject a PNG as `unsupported`.
   */
  jailOverlay: (overlayPath: string, ctx: VtToolContext) => Awaitable<VtJailedInput>
  decodeFrame: (params: { inputPath: string; timestampSeconds?: number; preferHardware?: boolean }) =>
    Promise<{ pngBase64: string; width: number; height: number; timestampSeconds: number; codec: string; usedHardware: boolean }>
  /**
   * `video.encodeClip` daemon RPC — re-encode a segment of the (already-jailed)
   * source video to an H.264 MP4 written at the TS-supplied `outputPath` (a dir WE
   * own). Resolves with the produced clip's metadata; REJECTS on failure. TS reads +
   * deletes `outputPath` afterwards. `overlayPath` (when present) is the JAILED
   * realPath of an image composited over every frame at (`overlayX`,`overlayY`),
   * optionally scaled to `overlayWidth` (aspect preserved) at `overlayOpacity` (the
   * daemon clamps to 0..1).
   */
  encodeClip: (params: { sourcePath: string; outputPath: string; scaleWidth?: number; targetBitrateKbps?: number; startSeconds?: number; durationSeconds?: number; overlayPath?: string; overlayX?: number; overlayY?: number; overlayWidth?: number; overlayOpacity?: number }) =>
    Promise<{ width: number; height: number; durationMs: number; codec: string; usedHardware: boolean }>
  /**
   * `video.concatClips` daemon RPC — concatenate N (already-jailed) source video
   * SEGMENTS, each with an optional trim (`startSeconds`/`durationSeconds`), into one
   * H.264 MP4 written at the TS-supplied `outputPath` (a dir WE own). Segments with
   * different dimensions are letterboxed to the first segment's size. Resolves with the
   * produced clip's metadata (incl. `segmentCount`); REJECTS on failure. TS reads +
   * deletes `outputPath` afterwards.
   */
  concatClips: (params: { outputPath: string; segments: Array<{ sourcePath: string; startSeconds?: number; durationSeconds?: number }>; scaleWidth?: number; targetBitrateKbps?: number }) =>
    Promise<{ width: number; height: number; durationMs: number; codec: string; usedHardware: boolean; segmentCount: number }>
  /**
   * `audio.mixdown` daemon RPC — mix N (already-jailed) source audio TRACKS, each with
   * an optional `gainDb`/`pan`/`offsetMs`/`fadeInMs`/`fadeOutMs`, down to one `format`
   * ('wav' | 'm4a') file written at the TS-supplied `outputPath` (a dir WE own). All
   * sources must already match `sampleRate`. `bitrateKbps` applies to m4a (AAC) only.
   * Resolves with the produced file's metadata (incl. `trackCount`); REJECTS on
   * failure. TS reads + deletes `outputPath` afterwards.
   */
  mixdown: (params: {
    outputPath: string
    format: 'wav' | 'm4a'
    sampleRate: number
    channels: number
    bitrateKbps?: number
    tracks: Array<{ sourcePath: string; gainDb?: number; pan?: number; offsetMs?: number; fadeInMs?: number; fadeOutMs?: number }>
  }) => Promise<{ durationMs: number; sampleRate: number; channels: number; codec: string; trackCount: number }>
  /**
   * `audio.transcribe` daemon RPC — ON-DEVICE speech-to-text of an (already-jailed)
   * source audio file via SFSpeechRecognizer. On-device ONLY (no network fallback).
   * Resolves with the transcript (`text` + per-segment timings/confidence + the locale
   * used + `onDevice`); REJECTS on failure (incl. an OS permission denial, whose
   * rejection message is the actionable "enable it in System Settings" string). Writes
   * no file — there is nothing to read or clean up.
   */
  transcribe: (params: { sourcePath: string; localeIdentifier?: string }) => Promise<{
    text: string
    segments: Array<{ text: string; startMs: number; endMs: number; confidence: number }>
    localeIdentifier: string
    onDevice: boolean
  }>
  /** An absolute staging file path (a dir WE own, never agent-supplied) for the encoded output. */
  stagingPath: (ext: string) => string
  /** Read a produced staging file → bytes (throws if missing / over the size cap). */
  readOutput: (path: string, mimeType: string) => Buffer
  /**
   * Persist a produced output buffer to the content-addressed asset store and return
   * its canonical sha256. The host (index.ts) provides the real implementation.
   */
  persistOutput: (buffer: Buffer, mimeType: string) => { ok: true; sha256: string } | { ok: false; reason: string }
  /**
   * Best-effort poster/waveform for a produced AV file (the card preview). Never
   * throws; resolves undefined on any failure (the producer still returns its ref).
   * Called BEFORE removeFile so the staging file still exists on disk.
   */
  generatePoster: GeneratePoster
  removeFile: (path: string) => void
}

export interface VtToolExecutors {
  executeVtTool: (
    toolName: VtMcpToolName,
    rawArgs: unknown,
    ctx: VtToolContext
  ) => Promise<McpToolExecutionResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function numArg(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : undefined
}

function fail(toolName: string, message: string): McpToolExecutionResult {
  const value = { ok: false, tool: toolName, error: message }
  const text = JSON.stringify(value)
  return { text, isError: true, structuredContent: value, content: [{ type: 'text', text }] }
}

// Last path segment of an agent-supplied sourcePath (cosmetic, for the output label
// only — never a filesystem path). Splits on both separators so a Windows-style path
// still yields a clean leaf; strips any extension so we can append the new one.
function sourceBaseName(sourcePath: unknown): string {
  const raw = typeof sourcePath === 'string' ? sourcePath.trim() : ''
  const leaf = raw.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const stem = leaf.replace(/\.[^.]+$/, '')
  return stem || 'output'
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// inspect_video_frames hard cap on frames per call. RAISED to 24 (was 8 = the image
// lane's default TRANSCRIPT_MEDIA_MAX_REFS_PER_MESSAGE) so a model can scrub a clip in
// more detail; the renderer filmstrip already scrolls + groups any count into one strip.
// A larger `maxFrames` is clamped to this up front, AND the result carries a per-call
// `maxRefs: 24` hint so the dispatch seam's createToolResultMediaRefs honors all 24 (the
// GLOBAL default stays 8 for every other path).
const INSPECT_VIDEO_FRAMES_MAX = 24

// Format a frame timestamp as a compact NLE label, e.g. 3 → "0:03", 75.4 → "1:15".
// Sub-second precision is dropped (the filmstrip caption is a scrub marker, not a code).
function formatTimestampLabel(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const total = Math.floor(safe)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function createVtToolExecutors(deps: VtToolDeps): VtToolExecutors {
  const { jailInput, jailOverlay, decodeFrame, encodeClip, concatClips, mixdown, transcribe, stagingPath, readOutput, persistOutput, generatePoster, removeFile } = deps

  // Guard the injected poster generator: even a misbehaving (throwing) impl must never
  // fail the producer (the poster is decorative). The real impl is already fail-
  // tolerant; this is defense-in-depth so the producer's contract holds for ANY dep.
  async function safePoster(
    outputPath: string,
    kind: 'audio' | 'video',
    mimeType: string,
    byteLength: number
  ): Promise<AvPosterResult | undefined> {
    try {
      return await generatePoster(outputPath, kind, mimeType, byteLength)
    } catch {
      return undefined
    }
  }

  function cleanupInput(input: { cleanup: () => boolean | void } | undefined): void {
    if (!input) return
    try {
      input.cleanup()
    } catch {
      // best-effort staged-input cleanup
    }
  }

  async function executeVideoDecodeFrame(
    args: Record<string, unknown>,
    ctx: VtToolContext
  ): Promise<McpToolExecutionResult> {
    const inputPath = typeof args.inputPath === 'string' ? args.inputPath.trim() : ''
    if (!inputPath) {
      return fail('video_decode_frame', 'provide inputPath (a video file inside the workspace)')
    }

    // Optional timestamp — default 0, must be finite and >= 0 if provided.
    let timestampSeconds: number | undefined
    if (args.timestampSeconds !== undefined) {
      const ts = numArg(args.timestampSeconds)
      if (ts === undefined || ts < 0) {
        return fail('video_decode_frame', 'timestampSeconds must be a finite number >= 0')
      }
      timestampSeconds = ts
    }

    // Optional preferHardware — default true; only override when an explicit boolean.
    const preferHardware = typeof args.preferHardware === 'boolean' ? args.preferHardware : undefined

    const jailed = await jailInput(inputPath, ctx)
    if (!jailed.ok) {
      return fail('video_decode_frame', `could not read video: ${jailed.reason}`)
    }

    try {
      const result = await decodeFrame({
        inputPath: jailed.realPath,
        timestampSeconds,
        preferHardware
      })
      const summary =
        `Decoded frame at ${result.timestampSeconds.toFixed(1)}s ` +
        `(${result.width}×${result.height}, ${result.codec}, ${result.usedHardware ? 'hardware' : 'software'})`
      const block: McpToolContentBlock = { type: 'image', mimeType: 'image/png', data: result.pngBase64 }
      return {
        text: summary,
        content: [{ type: 'text', text: summary }, block]
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail('video_decode_frame', `video_decode_frame failed: ${message}`)
    } finally {
      cleanupInput(jailed)
    }
  }

  // Decode SEVERAL frames from a workspace video in ONE call (read-only analysis) so a
  // model can "scrub" a clip — at explicit `timestamps`, every `everyNSeconds`, or just
  // [0]. Mirrors video_decode_frame's jail + image-block lane, but loops the SAME native
  // `decodeFrame` daemon RPC sequentially (no Swift change). The frames are PNGs, so —
  // exactly like video_decode_frame — they ride the proven SANITIZED image media spine
  // (createToolResultMediaRefs), with per-frame timestamp captions + a `video_frames`
  // group hint (mediaRefHints) so the renderer can lay them out as an NLE filmstrip.
  // HARD-CAPPED to INSPECT_VIDEO_FRAMES_MAX (24) frames; the emission raises the per-call
  // maxRefs hint to match (the global TRANSCRIPT_MEDIA_MAX_REFS_PER_MESSAGE default stays 8).
  // EOF-robust: a decode that fails (e.g. everyNSeconds walking off
  // the end of the clip) STOPS the loop and we return the frames gathered so far; only a
  // ZERO-frame result is an error.
  async function executeInspectVideoFrames(
    args: Record<string, unknown>,
    ctx: VtToolContext
  ): Promise<McpToolExecutionResult> {
    const inputPath = typeof args.inputPath === 'string' ? args.inputPath.trim() : ''
    if (!inputPath) {
      return fail('inspect_video_frames', 'provide inputPath (a video file inside the workspace)')
    }

    // Build the requested timestamp list (seconds, ascending) BEFORE jailing/decoding.
    //  1. explicit `timestamps` — each must be finite and >= 0;
    //  2. else `everyNSeconds` (> 0) → 0, n, 2n, … (count bounded by the cap below);
    //  3. else default to a single frame at [0].
    let timestamps: number[]
    if (args.timestamps !== undefined) {
      if (!Array.isArray(args.timestamps)) {
        return fail('inspect_video_frames', 'timestamps must be an array of numbers >= 0')
      }
      const parsed: number[] = []
      for (const raw of args.timestamps) {
        const ts = numArg(raw)
        if (ts === undefined || ts < 0) {
          return fail('inspect_video_frames', 'each timestamp must be a finite number >= 0')
        }
        parsed.push(ts)
      }
      timestamps = parsed
    } else if (args.everyNSeconds !== undefined) {
      const step = numArg(args.everyNSeconds)
      if (step === undefined || step <= 0) {
        return fail('inspect_video_frames', 'everyNSeconds must be a finite number > 0')
      }
      timestamps = []
    } else {
      timestamps = [0]
    }

    // Clamp the count to min(maxFrames ?? 8, INSPECT_VIDEO_FRAMES_MAX=24). Default stays 8
    // (a sensible scrub size); an explicit larger maxFrames is honored up to the 24 cap.
    const requestedMax = numArg(args.maxFrames)
    const maxFrames = Math.min(
      requestedMax !== undefined && requestedMax >= 1 ? Math.floor(requestedMax) : 8,
      INSPECT_VIDEO_FRAMES_MAX
    )

    // For the everyNSeconds mode, materialize 0, n, 2n, … up to the (clamped) cap. The
    // real end-of-clip cutoff is enforced by the EOF-stop in the decode loop below.
    if (args.everyNSeconds !== undefined && args.timestamps === undefined) {
      const step = numArg(args.everyNSeconds) as number
      for (let i = 0; i < maxFrames; i += 1) timestamps.push(i * step)
    }
    timestamps = timestamps.slice(0, maxFrames)

    const jailed = await jailInput(inputPath, ctx)
    if (!jailed.ok) {
      return fail('inspect_video_frames', `could not read video: ${jailed.reason}`)
    }

    try {
      const blocks: McpToolContentBlock[] = []
      const labels: string[] = []
      let lastError: string | undefined
      // Decode SEQUENTIALLY (for…await), one daemon RPC per timestamp. A failed decode is
      // treated as end-of-clip: STOP the loop and keep the frames collected so far (don't
      // fail the whole tool just because everyNSeconds overshot the clip's duration).
      for (const ts of timestamps) {
        try {
          const result = await decodeFrame({
            inputPath: jailed.realPath,
            timestampSeconds: ts,
            preferHardware: true
          })
          blocks.push({ type: 'image', mimeType: 'image/png', data: result.pngBase64 })
          // Label from the ACTUAL decoded timestamp (the daemon may snap to a keyframe).
          labels.push(formatTimestampLabel(result.timestampSeconds))
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          break
        }
      }

      // Zero successful frames → a real failure (bad clip, first decode threw, etc.).
      if (blocks.length === 0) {
        return fail(
          'inspect_video_frames',
          `inspect_video_frames failed: ${lastError ?? 'no frames could be decoded'}`
        )
      }

      const summary = `Inspected ${blocks.length} frame${blocks.length === 1 ? '' : 's'} at ${labels.join(', ')}`
      return {
        text: summary,
        content: [{ type: 'text', text: summary }, ...blocks],
        // maxRefs: 24 lets the dispatch seam emit all the frames we collected (the GLOBAL
        // default is 8); a trusted main-side hint, ceiling-clamped at createToolResultMediaRefs.
        mediaRefHints: { groupKind: 'video_frames', labels, maxRefs: INSPECT_VIDEO_FRAMES_MAX }
      }
    } finally {
      cleanupInput(jailed)
    }
  }

  // Re-encode a segment of a workspace video to an H.264 MP4 via the daemon's native
  // VideoToolbox. The output is a VIDEO FILE, so — like the ffmpeg transcode_video
  // producer — it rides the TRUSTED AV channel (persist + trustedMediaRefs), NOT the
  // image-block lane. Mirrors FfmpegToolExecutors.runProducer's read/persist/cleanup
  // shape (fail LOUDLY on a null ref; never silent empty-success).
  async function executeVideoEncodeClip(
    args: Record<string, unknown>,
    ctx: VtToolContext
  ): Promise<McpToolExecutionResult> {
    const inputPath = typeof args.inputPath === 'string' ? args.inputPath.trim() : ''
    if (!inputPath) {
      return fail('video_encode_clip', 'provide inputPath (a video file inside the workspace)')
    }

    // Optional output knobs — all numeric, all default at the daemon. Only
    // durationSeconds is value-constrained here (a non-positive clip is meaningless).
    const scaleWidth = numArg(args.scaleWidth)
    const targetBitrateKbps = numArg(args.targetBitrateKbps)
    const startSeconds = numArg(args.startSeconds)
    let durationSeconds: number | undefined
    if (args.durationSeconds !== undefined) {
      const d = numArg(args.durationSeconds)
      if (d === undefined || d <= 0) {
        return fail('video_encode_clip', 'durationSeconds must be a finite number > 0')
      }
      durationSeconds = d
    }

    const jailed = await jailInput(inputPath, ctx)
    if (!jailed.ok) {
      return fail('video_encode_clip', `could not read video: ${jailed.reason}`)
    }

    // Optional CoreImage overlay — an IMAGE (PNG/JPEG/WebP) composited over every
    // frame. Jailed through the SEPARATE image jail (validateWorkspaceImagePath),
    // NOT jailInput (whose video/audio mime-sniff rejects a PNG as `unsupported`).
    // Position/scale/opacity are plain numbers the daemon clamps; only forwarded
    // when an overlay is actually supplied.
    let overlayRealPath: string | undefined
    let overlayX: number | undefined
    let overlayY: number | undefined
    let overlayWidth: number | undefined
    let overlayOpacity: number | undefined
    let jailedOverlay: Extract<VtJailedInput, { ok: true }> | undefined
    const overlayPath = typeof args.overlayPath === 'string' ? args.overlayPath.trim() : ''
    try {
      if (overlayPath) {
        const candidate = await jailOverlay(overlayPath, ctx)
        if (!candidate.ok) {
          return fail('video_encode_clip', `could not read overlay image: ${candidate.reason}`)
        }
        jailedOverlay = candidate
        overlayRealPath = candidate.realPath
        overlayX = numArg(args.overlayX)
        overlayY = numArg(args.overlayY)
        overlayWidth = numArg(args.overlayWidth)
        overlayOpacity = numArg(args.overlayOpacity)
      }

      const outputPath = stagingPath('mp4')
      const mimeType = 'video/mp4'
      try {
        const result = await encodeClip({
          sourcePath: jailed.realPath,
          outputPath,
          scaleWidth,
          targetBitrateKbps,
          startSeconds,
          durationSeconds,
          overlayPath: overlayRealPath,
          overlayX,
          overlayY,
          overlayWidth,
          overlayOpacity
        })
        let buffer: Buffer
        try {
          buffer = readOutput(outputPath, mimeType)
        } catch (error) {
          return fail('video_encode_clip', `encode output unavailable: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!buffer || buffer.length === 0) return fail('video_encode_clip', 'VideoToolbox produced an empty clip')
        const persisted = persistOutput(buffer, mimeType)
        if (!persisted.ok) return fail('video_encode_clip', `Failed to persist output: ${persisted.reason}`)
        // Best-effort poster (fail-tolerant: undefined on any error) BEFORE the
        // finally { removeFile } — the staging MP4 must still be on disk. Guarded so a
        // misbehaving generator can never fail the producer (the poster is decorative).
        const poster = await safePoster(outputPath, 'video', mimeType, buffer.length)
        const ref = buildAvMediaRef({
          sha256: persisted.sha256,
          mimeType,
          name: `${sourceBaseName(args.inputPath)}.mp4`,
          runId: ctx?.appRunId,
          byteLength: buffer.length,
          durationMs: result.durationMs,
          codecs: result.codec,
          thumbnail: poster?.thumbnail
        })
        // buildAvMediaRef only returns null on a non-AV mime — unreachable here
        // (mimeType is the fixed main-derived 'video/mp4'), but fail LOUDLY rather than
        // return silent empty-success that would strand the persisted (content-
        // addressed) asset with no ref pointing at it.
        if (!ref) return fail('video_encode_clip', `internal: unsupported output mime ${mimeType}`)
        const summary =
          `Encoded clip → ${result.width}×${result.height}, ${(result.durationMs / 1000).toFixed(1)}s, ` +
          `${result.codec} (${humanBytes(buffer.length)}, ${result.usedHardware ? 'hardware' : 'software'})` +
          (overlayRealPath ? ' + overlay' : '')
        return {
          text: summary,
          content: [{ type: 'text', text: summary }],
          trustedMediaRefs: [ref]
        }
      } catch (error) {
        return fail('video_encode_clip', error instanceof Error ? error.message : String(error))
      } finally {
        try {
          removeFile(outputPath)
        } catch {
          // best-effort staging cleanup
        }
      }
    } finally {
      cleanupInput(jailedOverlay)
      cleanupInput(jailed)
    }
  }

  // Concatenate N workspace video SEGMENTS (each an input + optional trim) into one
  // H.264 MP4 via the daemon's native VideoToolbox. Like executeVideoEncodeClip the
  // output is a VIDEO FILE, so it rides the TRUSTED AV channel (persist +
  // trustedMediaRefs), NOT the image-block lane. EVERY segment path is realpath-jailed
  // through the VIDEO jail (jailInput) BEFORE the daemon runs; any one segment's jail
  // failure aborts immediately (concatClips never called). Fails LOUDLY on a null ref.
  async function executeVideoConcatClips(
    args: Record<string, unknown>,
    ctx: VtToolContext
  ): Promise<McpToolExecutionResult> {
    const rawSegments = args.segments
    if (!Array.isArray(rawSegments) || rawSegments.length < 2) {
      return fail('video_concat_clips', 'provide at least 2 segments')
    }
    if (rawSegments.length > 50) {
      return fail('video_concat_clips', 'too many segments (max 50)')
    }

    const jailedInputs: Array<Extract<VtJailedInput, { ok: true }>> = []
    try {
      // Validate + jail EACH segment up front. The first segment's inputPath also names
      // the cosmetic output label, so capture it. Any jail failure aborts the whole
      // concat BEFORE the daemon is ever invoked (carries the offending segment index).
      const realSegments: Array<{ sourcePath: string; startSeconds?: number; durationSeconds?: number }> = []
      let firstSegmentInputPath: unknown
      for (let i = 0; i < rawSegments.length; i++) {
        const segment = asRecord(rawSegments[i])
        const inputPath = typeof segment.inputPath === 'string' ? segment.inputPath.trim() : ''
        if (!inputPath) {
          return fail('video_concat_clips', `segment ${i}: provide inputPath (a video file inside the workspace)`)
        }
        if (i === 0) firstSegmentInputPath = segment.inputPath
        const startSeconds = numArg(segment.startSeconds)
        let durationSeconds: number | undefined
        if (segment.durationSeconds !== undefined) {
          const d = numArg(segment.durationSeconds)
          if (d === undefined || d <= 0) {
            return fail('video_concat_clips', `segment ${i}: durationSeconds must be a finite number > 0`)
          }
          durationSeconds = d
        }
        const jailed = await jailInput(inputPath, ctx)
        if (!jailed.ok) {
          return fail('video_concat_clips', `segment ${i}: ${jailed.reason}`)
        }
        jailedInputs.push(jailed)
        realSegments.push({ sourcePath: jailed.realPath, startSeconds, durationSeconds })
      }

      // Optional output knobs — numeric, defaulted at the daemon.
      const scaleWidth = numArg(args.scaleWidth)
      const targetBitrateKbps = numArg(args.targetBitrateKbps)

      const outputPath = stagingPath('mp4')
      const mimeType = 'video/mp4'
      try {
        const result = await concatClips({
          outputPath,
          segments: realSegments,
          scaleWidth,
          targetBitrateKbps
        })
        let buffer: Buffer
        try {
          buffer = readOutput(outputPath, mimeType)
        } catch (error) {
          return fail('video_concat_clips', `concat output unavailable: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!buffer || buffer.length === 0) return fail('video_concat_clips', 'VideoToolbox produced an empty clip')
        const persisted = persistOutput(buffer, mimeType)
        if (!persisted.ok) return fail('video_concat_clips', `Failed to persist output: ${persisted.reason}`)
        // Best-effort poster (fail-tolerant) BEFORE the finally { removeFile }.
        const poster = await safePoster(outputPath, 'video', mimeType, buffer.length)
        const ref = buildAvMediaRef({
          sha256: persisted.sha256,
          mimeType,
          name: `${sourceBaseName(firstSegmentInputPath)}-concat.mp4`,
          runId: ctx?.appRunId,
          byteLength: buffer.length,
          durationMs: result.durationMs,
          codecs: result.codec,
          thumbnail: poster?.thumbnail
        })
        // buildAvMediaRef only returns null on a non-AV mime — unreachable here (mimeType
        // is the fixed main-derived 'video/mp4'), but fail LOUDLY rather than return a
        // silent empty-success that would strand the persisted asset with no ref.
        if (!ref) return fail('video_concat_clips', `internal: unsupported output mime ${mimeType}`)
        const summary =
          `Concatenated ${result.segmentCount} clips → ${result.width}×${result.height}, ` +
          `${(result.durationMs / 1000).toFixed(1)}s, ${result.codec} ` +
          `(${humanBytes(buffer.length)}, ${result.usedHardware ? 'hardware' : 'software'})`
        return {
          text: summary,
          content: [{ type: 'text', text: summary }],
          trustedMediaRefs: [ref]
        }
      } catch (error) {
        return fail('video_concat_clips', error instanceof Error ? error.message : String(error))
      } finally {
        try {
          removeFile(outputPath)
        } catch {
          // best-effort staging cleanup
        }
      }
    } finally {
      for (let i = jailedInputs.length - 1; i >= 0; i -= 1) {
        cleanupInput(jailedInputs[i])
      }
    }
  }

  // Mix N workspace AUDIO tracks (each + optional gain/pan/offset/fade) down to one WAV
  // or M4A via the daemon's native audio engine. Like executeVideoConcatClips the output
  // is an AUDIO FILE, so it rides the TRUSTED AV channel (persist + trustedMediaRefs),
  // NOT the image-block lane. EVERY track sourcePath is realpath-jailed through the
  // audio/video jail (jailInput) BEFORE the daemon runs; any one track's jail failure
  // aborts immediately (mixdown never called). Output mime is the asset-store-known
  // 'audio/wav' (wav) or 'audio/mp4' (m4a) — NEVER 'audio/x-m4a'. Fails LOUDLY on a
  // null ref.
  async function executeAudioMix(
    args: Record<string, unknown>,
    ctx: VtToolContext
  ): Promise<McpToolExecutionResult> {
    const rawTracks = args.tracks
    if (!Array.isArray(rawTracks) || rawTracks.length < 1) {
      return fail('audio_mix', 'provide at least 1 track')
    }
    if (rawTracks.length > 24) {
      return fail('audio_mix', 'too many tracks (max 24)')
    }

    const jailedInputs: Array<Extract<VtJailedInput, { ok: true }>> = []
    try {
      // Validate + jail EACH track up front. The first track's sourcePath also names the
      // cosmetic output label, so capture it. Any jail failure aborts the whole mix BEFORE
      // the daemon is ever invoked (carries the offending track index). Optional per-track
      // numeric knobs (gainDb/pan/offsetMs/fadeInMs/fadeOutMs) are read defensively and
      // only forwarded when finite.
      const realTracks: Array<{ sourcePath: string; gainDb?: number; pan?: number; offsetMs?: number; fadeInMs?: number; fadeOutMs?: number }> = []
      let firstTrackSourcePath: unknown
      for (let i = 0; i < rawTracks.length; i++) {
        const track = asRecord(rawTracks[i])
        const sourcePath = typeof track.sourcePath === 'string' ? track.sourcePath.trim() : ''
        if (!sourcePath) {
          return fail('audio_mix', `track ${i}: provide sourcePath (an audio file inside the workspace)`)
        }
        if (i === 0) firstTrackSourcePath = track.sourcePath
        const jailed = await jailInput(sourcePath, ctx)
        if (!jailed.ok) {
          return fail('audio_mix', `track ${i}: ${jailed.reason}`)
        }
        jailedInputs.push(jailed)
        realTracks.push({
          sourcePath: jailed.realPath,
          gainDb: numArg(track.gainDb),
          pan: numArg(track.pan),
          offsetMs: numArg(track.offsetMs),
          fadeInMs: numArg(track.fadeInMs),
          fadeOutMs: numArg(track.fadeOutMs)
        })
      }

      // Top-level mix knobs. format defaults 'wav' and is the ONLY field that picks the
      // ext+mime; sampleRate (44100) / channels (2) / bitrateKbps (192, m4a/AAC only)
      // default at the daemon. Anything outside the allowed set falls back to the default.
      const rawFormat = typeof args.format === 'string' ? args.format.trim().toLowerCase() : ''
      const format: 'wav' | 'm4a' = rawFormat === 'm4a' ? 'm4a' : 'wav'
      // Round the integer-typed knobs: the daemon decodes sampleRate/bitrateKbps as
      // Swift Int, which rejects a fractional JSON value (44100.5) with invalidParams.
      const sampleRate = Math.round(numArg(args.sampleRate) ?? 44100)
      const rawChannels = numArg(args.channels)
      const channels = rawChannels === 1 ? 1 : 2
      const bitrateKbps = Math.round(numArg(args.bitrateKbps) ?? 192)

      // Output mime MUST be an asset-store-known AV mime: 'audio/wav' for wav, 'audio/mp4'
      // for m4a. NEVER 'audio/x-m4a' — it is absent from AV_MIMES + the asset-store map and
      // would null-ref-fail.
      const ext = format === 'wav' ? 'wav' : 'm4a'
      const mimeType = format === 'wav' ? 'audio/wav' : 'audio/mp4'

      const outputPath = stagingPath(ext)
      try {
        const result = await mixdown({
          outputPath,
          format,
          sampleRate,
          channels,
          bitrateKbps,
          tracks: realTracks
        })
        let buffer: Buffer
        try {
          buffer = readOutput(outputPath, mimeType)
        } catch (error) {
          return fail('audio_mix', `mix output unavailable: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!buffer || buffer.length === 0) return fail('audio_mix', 'audio engine produced an empty mix')
        const persisted = persistOutput(buffer, mimeType)
        if (!persisted.ok) return fail('audio_mix', `Failed to persist output: ${persisted.reason}`)
        // Best-effort waveform poster + harvested peaks (fail-tolerant) BEFORE the
        // finally { removeFile }. Audio carries BOTH the JPEG poster (fallback) and the
        // compact `peaks` envelope the renderer DAW-draws from.
        const poster = await safePoster(outputPath, 'audio', mimeType, buffer.length)
        const ref = buildAvMediaRef({
          sha256: persisted.sha256,
          mimeType,
          name: `${sourceBaseName(firstTrackSourcePath)}-mix.${ext}`,
          runId: ctx?.appRunId,
          byteLength: buffer.length,
          durationMs: result.durationMs,
          codecs: result.codec,
          thumbnail: poster?.thumbnail,
          peaks: poster?.peaks
        })
        // buildAvMediaRef only returns null on a non-AV mime — unreachable here (mimeType is
        // the fixed main-derived 'audio/wav' | 'audio/mp4'), but fail LOUDLY rather than
        // return a silent empty-success that would strand the persisted asset with no ref.
        if (!ref) return fail('audio_mix', `internal: unsupported output mime ${mimeType}`)
        const summary =
          `Mixed ${realTracks.length} tracks → ${ref.name} (${humanBytes(buffer.length)})`
        return {
          text: summary,
          content: [{ type: 'text', text: summary }],
          trustedMediaRefs: [ref]
        }
      } catch (error) {
        return fail('audio_mix', error instanceof Error ? error.message : String(error))
      } finally {
        try {
          removeFile(outputPath)
        } catch {
          // best-effort staging cleanup
        }
      }
    } finally {
      for (let i = jailedInputs.length - 1; i >= 0; i -= 1) {
        cleanupInput(jailedInputs[i])
      }
    }
  }

  // ON-DEVICE speech-to-text of a workspace AUDIO file via the daemon's native Speech
  // framework (audio.transcribe). UNLIKE the producers it writes NO file and emits NO
  // media ref — it returns the transcript as STRUCTURED TEXT (the formatted string + a
  // JSON per-segment array). READ-ONLY. The sourcePath is realpath-jailed through
  // jailInput BEFORE the daemon runs. On ANY daemon error (incl. an OS permission
  // denial, whose rejection carries the actionable "enable it in System Settings"
  // message) we return fail(...) with that message verbatim, so the model is told the
  // exact fix rather than getting a bare crash. Transcription itself runs on-device
  // ONLY (the daemon never falls back to the network — the privacy invariant).
  async function executeTranscribeAudio(
    args: Record<string, unknown>,
    ctx: VtToolContext
  ): Promise<McpToolExecutionResult> {
    const sourcePath = typeof args.sourcePath === 'string' ? args.sourcePath.trim() : ''
    if (!sourcePath) {
      return fail('transcribe_audio', 'provide sourcePath (an audio file inside the workspace)')
    }

    // Optional locale — a non-empty string only; otherwise the daemon defaults to en-US.
    const localeIdentifier =
      typeof args.localeIdentifier === 'string' && args.localeIdentifier.trim()
        ? args.localeIdentifier.trim()
        : undefined

    const jailed = await jailInput(sourcePath, ctx)
    if (!jailed.ok) {
      return fail('transcribe_audio', `could not read audio: ${jailed.reason}`)
    }

    try {
      const result = await transcribe({ sourcePath: jailed.realPath, localeIdentifier })
      // Structured TEXT result: a human transcript line + a machine-readable per-segment
      // array (text + ms timings + confidence). No media ref — speech is read-only text.
      const segmentsJson = JSON.stringify(
        result.segments.map((s) => ({
          text: s.text,
          startMs: s.startMs,
          endMs: s.endMs,
          confidence: s.confidence
        }))
      )
      const trimmed = result.text.trim()
      const header =
        `Transcript (${result.localeIdentifier}, on-device): ` +
        (trimmed ? trimmed : '(no speech detected)')
      const text = `${header}\n\nsegments: ${segmentsJson}`
      const structured = {
        ok: true,
        tool: 'transcribe_audio',
        text: result.text,
        localeIdentifier: result.localeIdentifier,
        onDevice: result.onDevice,
        segments: result.segments
      }
      return {
        text,
        structuredContent: structured,
        content: [{ type: 'text', text }]
      }
    } catch (error) {
      // The daemon's actionable message (auth-denied / unsupported locale / on-device
      // unavailable / recognizer error) rides through verbatim — graceful fail, never a
      // crash. This is also the path the EXPECTED runtime permission denial takes.
      return fail('transcribe_audio', error instanceof Error ? error.message : String(error))
    } finally {
      cleanupInput(jailed)
    }
  }

  return {
    executeVtTool(toolName, rawArgs, ctx) {
      const args = asRecord(rawArgs)
      switch (toolName) {
        case 'video_decode_frame':
          return executeVideoDecodeFrame(args, ctx)
        case 'inspect_video_frames':
          return executeInspectVideoFrames(args, ctx)
        case 'video_encode_clip':
          return executeVideoEncodeClip(args, ctx)
        case 'video_concat_clips':
          return executeVideoConcatClips(args, ctx)
        case 'audio_mix':
          return executeAudioMix(args, ctx)
        case 'transcribe_audio':
          return executeTranscribeAudio(args, ctx)
        default:
          return Promise.resolve(fail(String(toolName), `unknown VideoToolbox tool "${toolName}"`))
      }
    }
  }
}
