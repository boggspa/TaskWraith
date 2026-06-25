import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import { buildAvMediaRef } from '../media/AvMediaRef'

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
 */

export const VT_MCP_TOOL_NAMES = ['video_decode_frame', 'video_encode_clip'] as const
export type VtMcpToolName = (typeof VT_MCP_TOOL_NAMES)[number]

export function isVtMcpToolName(name: string): name is VtMcpToolName {
  return (VT_MCP_TOOL_NAMES as readonly string[]).includes(name)
}

export interface VtToolContext {
  appChatId?: string
  appRunId?: string
  workspacePath?: string
}

export interface VtToolDeps {
  jailInput: (sourcePath: string, ctx: VtToolContext) => { ok: true; realPath: string } | { ok: false; reason: string }
  /**
   * Realpath-jail a workspace IMAGE path for the optional encode overlay. DISTINCT
   * from `jailInput`: the overlay is a PNG/JPEG/WebP composited over every frame, so
   * this jails via `validateWorkspaceImagePath` (accepts PNG/JPEG/WebP, REJECTS SVG,
   * size-capped). It must NOT reuse `jailInput`, whose `validateWorkspaceMediaPath`
   * sniffs AUDIO/VIDEO mime and would reject a PNG as `unsupported`.
   */
  jailOverlay: (overlayPath: string, ctx: VtToolContext) => { ok: true; realPath: string } | { ok: false; reason: string }
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
  /** An absolute staging file path (a dir WE own, never agent-supplied) for the encoded output. */
  stagingPath: (ext: string) => string
  /** Read a produced staging file → bytes (throws if missing / over the size cap). */
  readOutput: (path: string, mimeType: string) => Buffer
  /**
   * Persist a produced output buffer to the content-addressed asset store and return
   * its canonical sha256. The host (index.ts) provides the real implementation.
   */
  persistOutput: (buffer: Buffer, mimeType: string) => { ok: true; sha256: string } | { ok: false; reason: string }
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

export function createVtToolExecutors(deps: VtToolDeps): VtToolExecutors {
  const { jailInput, jailOverlay, decodeFrame, encodeClip, stagingPath, readOutput, persistOutput, removeFile } = deps

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

    const jailed = jailInput(inputPath, ctx)
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

    const jailed = jailInput(inputPath, ctx)
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
    const overlayPath = typeof args.overlayPath === 'string' ? args.overlayPath.trim() : ''
    if (overlayPath) {
      const jailedOverlay = jailOverlay(overlayPath, ctx)
      if (!jailedOverlay.ok) {
        return fail('video_encode_clip', `could not read overlay image: ${jailedOverlay.reason}`)
      }
      overlayRealPath = jailedOverlay.realPath
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
      const ref = buildAvMediaRef({
        sha256: persisted.sha256,
        mimeType,
        name: `${sourceBaseName(args.inputPath)}.mp4`,
        runId: ctx?.appRunId,
        byteLength: buffer.length,
        durationMs: result.durationMs,
        codecs: result.codec
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
  }

  return {
    executeVtTool(toolName, rawArgs, ctx) {
      const args = asRecord(rawArgs)
      switch (toolName) {
        case 'video_decode_frame':
          return executeVideoDecodeFrame(args, ctx)
        case 'video_encode_clip':
          return executeVideoEncodeClip(args, ctx)
        default:
          return Promise.resolve(fail(String(toolName), `unknown VideoToolbox tool "${toolName}"`))
      }
    }
  }
}
