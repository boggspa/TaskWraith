import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import { buildFfmpegArgs, buildFfprobeArgs, type AudioOutFormat, type FfmpegIntent } from '../media/FfmpegCommand'
import { parseFfprobeJson } from '../media/FfprobeResult'
import { buildAvMediaRef } from '../media/AvMediaRef'

/**
 * ffmpeg-family MCP tool executors. Pure logic — the binary resolver, the realpath
 * input jail, the execFile runner, the staging file paths are all INJECTED, so this
 * is unit-testable without a real ffmpeg or Electron. Security invariants live in
 * the injected jail + FfmpegCommand (intent→fixed argv, -protocol_whitelist file).
 *
 * S1b-1: `video_probe` (read-only ffprobe analysis).
 * S1b-2: `video_thumbnail` — extract one PNG frame and return it as an IMAGE block,
 *   so it rides the PROVEN image media spine (createToolResultMediaRefs → media_refs)
 *   and renders inline, no new trust lane required.
 * S1b-3: the audio/video PRODUCERS (audio_extract / transcode_audio / transcode_video),
 *   whose output is audio/video and so cannot ride the image-block lane. They persist
 *   the output to the content-addressed asset store (the INJECTED `persistOutput` dep)
 *   and return a `trustedMediaRefs` ref built by buildAvMediaRef. That ref travels a
 *   NEW trusted channel (McpToolExecutionResult.trustedMediaRefs) the host injects
 *   straight into run state — bypassing the image-only provider sanitizer (which hard-
 *   drops kind!=='image'). It is un-forgeable: only this main-side executor code can
 *   construct a McpToolExecutionResult, so provider stdout can never reach the field.
 */

export const FFMPEG_MCP_TOOL_NAMES = ['video_probe', 'video_thumbnail', 'audio_extract', 'transcode_audio', 'transcode_video'] as const
export type FfmpegMcpToolName = (typeof FFMPEG_MCP_TOOL_NAMES)[number]

export function isFfmpegMcpToolName(name: string): name is FfmpegMcpToolName {
  return (FFMPEG_MCP_TOOL_NAMES as readonly string[]).includes(name)
}

export interface FfmpegToolContext {
  appChatId?: string
  appRunId?: string
  workspacePath?: string
}

export type JailedMediaInput =
  | { ok: true; realPath: string; mimeType: string }
  | { ok: false; reason: string }

export interface FfmpegRunResult {
  stdout: string
  stderr: string
}

export interface FfmpegToolDeps {
  /** Realpath-jail a workspace media path (the security boundary). */
  jailInput: (sourcePath: string, ctx: FfmpegToolContext) => JailedMediaInput
  resolveFfprobe: () => string | null
  resolveFfmpeg: () => string | null
  runFfprobe: (binaryPath: string, args: string[]) => Promise<FfmpegRunResult>
  /** Run ffmpeg (heavier: longer timeout + the concurrency semaphore). */
  runFfmpeg: (binaryPath: string, args: string[]) => Promise<FfmpegRunResult>
  /** An absolute staging file path (a dir WE own, never agent-supplied) for ffmpeg output. */
  stagingPath: (ext: string) => string
  /**
   * Read a produced staging file → bytes (throws if missing / over the size cap).
   * The optional mimeType selects the PER-MIME cap (audio 64MB / video 512MB) so an
   * oversized output is rejected before it is read into the heap; omit for the video
   * ceiling (the thumbnail PNG path).
   */
  readOutput: (path: string, mimeType?: string) => Buffer
  /**
   * Persist a produced output buffer to the content-addressed asset store and return
   * its canonical sha256. Owns the hashing (this module introduces no hash scheme).
   * The host (index.ts) provides the real implementation; the producers only CALL it.
   */
  persistOutput: (buffer: Buffer, mimeType: string) => { ok: true; sha256: string } | { ok: false; reason: string }
  removeFile: (path: string) => void
  missingMessage: (which: 'ffmpeg' | 'ffprobe') => string
}

export interface FfmpegToolExecutors {
  executeFfmpegTool: (
    toolName: FfmpegMcpToolName,
    rawArgs: unknown,
    ctx: FfmpegToolContext
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

// The producers map a typed AudioOutFormat to its canonical output mime (these 3 +
// video/mp4 are the only mimes S1b-3 emits; buildAvMediaRef re-validates them).
const AUDIO_FORMAT_MIME: Record<AudioOutFormat, string> = {
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg'
}

function isAudioOutFormat(value: unknown): value is AudioOutFormat {
  return value === 'wav' || value === 'm4a' || value === 'mp3'
}

// The 3 S1b-3 PRODUCER tools (subset of FfmpegMcpToolName whose output is AV media).
type ProducerToolName = 'audio_extract' | 'transcode_audio' | 'transcode_video'

// Human verb for each producer's concise result summary (e.g. "Extracted audio → …").
const PRODUCER_VERB: Record<ProducerToolName, string> = {
  audio_extract: 'Extracted audio →',
  transcode_audio: 'Transcoded audio →',
  transcode_video: 'Transcoded video →'
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

export function createFfmpegToolExecutors(deps: FfmpegToolDeps): FfmpegToolExecutors {
  const { jailInput, resolveFfprobe, resolveFfmpeg, runFfprobe, runFfmpeg, stagingPath, readOutput, persistOutput, removeFile, missingMessage } = deps

  function jail(toolName: string, args: Record<string, unknown>, ctx: FfmpegToolContext):
    | { ok: true; realPath: string; mimeType: string }
    | { ok: false; result: McpToolExecutionResult } {
    const sourcePath = typeof args.sourcePath === 'string' ? args.sourcePath.trim() : ''
    if (!sourcePath) return { ok: false, result: fail(toolName, 'provide sourcePath (a media file inside the workspace)') }
    const jailed = jailInput(sourcePath, ctx)
    if (!jailed.ok) return { ok: false, result: fail(toolName, `could not read media: ${jailed.reason}`) }
    return { ok: true, realPath: jailed.realPath, mimeType: jailed.mimeType }
  }

  async function executeVideoProbe(args: Record<string, unknown>, ctx: FfmpegToolContext): Promise<McpToolExecutionResult> {
    const j = jail('video_probe', args, ctx)
    if (!j.ok) return j.result
    const ffprobe = resolveFfprobe()
    if (!ffprobe) return fail('video_probe', missingMessage('ffprobe'))
    const argv = buildFfprobeArgs(j.realPath)
    if (!argv.ok) return fail('video_probe', argv.error)
    let run: FfmpegRunResult
    try {
      run = await runFfprobe(ffprobe, argv.args)
    } catch (error) {
      return fail('video_probe', error instanceof Error ? error.message : String(error))
    }
    const parsed = parseFfprobeJson(run.stdout)
    if (!parsed.ok) return fail('video_probe', parsed.error)
    const full = { ok: true, tool: 'video_probe', sniffedMime: j.mimeType, ...parsed.info }
    const text = JSON.stringify(full)
    return { text, structuredContent: full, content: [{ type: 'text', text }] }
  }

  async function executeVideoThumbnail(args: Record<string, unknown>, ctx: FfmpegToolContext): Promise<McpToolExecutionResult> {
    const j = jail('video_thumbnail', args, ctx)
    if (!j.ok) return j.result
    const ffmpeg = resolveFfmpeg()
    if (!ffmpeg) return fail('video_thumbnail', missingMessage('ffmpeg'))
    const outputPath = stagingPath('png')
    const intent: FfmpegIntent = {
      kind: 'thumbnail',
      inputPath: j.realPath,
      outputPath,
      atMs: numArg(args.atMs),
      width: numArg(args.width)
    }
    const argv = buildFfmpegArgs(intent)
    if (!argv.ok) return fail('video_thumbnail', argv.error)
    try {
      await runFfmpeg(ffmpeg, argv.args)
      let buffer: Buffer
      try {
        buffer = readOutput(outputPath)
      } catch (error) {
        return fail('video_thumbnail', `ffmpeg output unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!buffer || buffer.length === 0) return fail('video_thumbnail', 'ffmpeg produced an empty frame')
      // Return the PNG as an image block → it rides the PROVEN image media spine
      // (createToolResultMediaRefs) and renders inline, no trusted lane needed.
      const full = { ok: true, tool: 'video_thumbnail', mimeType: 'image/png', byteLength: buffer.length }
      const text = JSON.stringify(full)
      const block: McpToolContentBlock = { type: 'image', mimeType: 'image/png', data: buffer.toString('base64') }
      return { text, structuredContent: full, content: [{ type: 'text', text }, block] }
    } catch (error) {
      return fail('video_thumbnail', error instanceof Error ? error.message : String(error))
    } finally {
      try {
        removeFile(outputPath)
      } catch {
        // best-effort staging cleanup
      }
    }
  }

  // Shared producer tail (audio_extract / transcode_audio / transcode_video): run the
  // already-built intent, persist the output to the asset store, and return a TRUSTED
  // AV media ref. Mirrors executeVideoThumbnail's run/read/cleanup shape exactly — the
  // only difference is the persist+ref step (the output is audio/video, so it cannot
  // ride the image-block lane and instead travels McpToolExecutionResult.trustedMediaRefs).
  async function runProducer(
    toolName: ProducerToolName,
    intent: FfmpegIntent,
    outputPath: string,
    mimeType: string,
    outputName: string,
    ctx: FfmpegToolContext
  ): Promise<McpToolExecutionResult> {
    const ffmpeg = resolveFfmpeg()
    if (!ffmpeg) return fail(toolName, missingMessage('ffmpeg'))
    const argv = buildFfmpegArgs(intent)
    if (!argv.ok) return fail(toolName, argv.error)
    try {
      await runFfmpeg(ffmpeg, argv.args)
      let buffer: Buffer
      try {
        buffer = readOutput(outputPath, mimeType)
      } catch (error) {
        return fail(toolName, `ffmpeg output unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!buffer || buffer.length === 0) return fail(toolName, 'ffmpeg produced an empty output')
      const persisted = persistOutput(buffer, mimeType)
      if (!persisted.ok) return fail(toolName, `Failed to persist output: ${persisted.reason}`)
      const ref = buildAvMediaRef({
        sha256: persisted.sha256,
        mimeType,
        name: outputName,
        runId: ctx?.appRunId,
        byteLength: buffer.length
      })
      // buildAvMediaRef only returns null on a non-AV mime — unreachable here
      // (mimeType is main-derived from a validated format), but fail LOUDLY rather
      // than return silent empty-success that would strand the persisted (content-
      // addressed) asset with no ref pointing at it.
      if (!ref) return fail(toolName, `internal: unsupported output mime ${mimeType}`)
      const summary = `${PRODUCER_VERB[toolName]} ${outputName} (${humanBytes(buffer.length)})`
      return {
        text: summary,
        content: [{ type: 'text', text: summary }],
        trustedMediaRefs: [ref]
      }
    } catch (error) {
      return fail(toolName, error instanceof Error ? error.message : String(error))
    } finally {
      try {
        removeFile(outputPath)
      } catch {
        // best-effort staging cleanup
      }
    }
  }

  async function executeAudioExtract(args: Record<string, unknown>, ctx: FfmpegToolContext): Promise<McpToolExecutionResult> {
    const j = jail('audio_extract', args, ctx)
    if (!j.ok) return j.result
    if (!isAudioOutFormat(args.format)) return fail('audio_extract', 'provide format: one of "wav", "m4a", "mp3"')
    const format = args.format
    const mimeType = AUDIO_FORMAT_MIME[format]
    const outputPath = stagingPath(format)
    const intent: FfmpegIntent = {
      kind: 'extract_audio',
      inputPath: j.realPath,
      outputPath,
      format,
      bitrateKbps: numArg(args.bitrateKbps)
    }
    return runProducer('audio_extract', intent, outputPath, mimeType, `${sourceBaseName(args.sourcePath)}.${format}`, ctx)
  }

  async function executeTranscodeAudio(args: Record<string, unknown>, ctx: FfmpegToolContext): Promise<McpToolExecutionResult> {
    const j = jail('transcode_audio', args, ctx)
    if (!j.ok) return j.result
    if (!isAudioOutFormat(args.format)) return fail('transcode_audio', 'provide format: one of "wav", "m4a", "mp3"')
    const format = args.format
    const mimeType = AUDIO_FORMAT_MIME[format]
    const outputPath = stagingPath(format)
    const intent: FfmpegIntent = {
      kind: 'transcode_audio',
      inputPath: j.realPath,
      outputPath,
      format,
      bitrateKbps: numArg(args.bitrateKbps)
    }
    return runProducer('transcode_audio', intent, outputPath, mimeType, `${sourceBaseName(args.sourcePath)}.${format}`, ctx)
  }

  async function executeTranscodeVideo(args: Record<string, unknown>, ctx: FfmpegToolContext): Promise<McpToolExecutionResult> {
    const j = jail('transcode_video', args, ctx)
    if (!j.ok) return j.result
    const outputPath = stagingPath('mp4')
    const intent: FfmpegIntent = {
      kind: 'transcode_video',
      inputPath: j.realPath,
      outputPath,
      crf: numArg(args.crf),
      scaleWidth: numArg(args.scaleWidth),
      fps: numArg(args.fps)
    }
    return runProducer('transcode_video', intent, outputPath, 'video/mp4', `${sourceBaseName(args.sourcePath)}.mp4`, ctx)
  }

  return {
    executeFfmpegTool(toolName, rawArgs, ctx) {
      const args = asRecord(rawArgs)
      switch (toolName) {
        case 'video_probe':
          return executeVideoProbe(args, ctx)
        case 'video_thumbnail':
          return executeVideoThumbnail(args, ctx)
        case 'audio_extract':
          return executeAudioExtract(args, ctx)
        case 'transcode_audio':
          return executeTranscodeAudio(args, ctx)
        case 'transcode_video':
          return executeTranscodeVideo(args, ctx)
        default:
          return Promise.resolve(fail(String(toolName), `unknown ffmpeg tool "${toolName}"`))
      }
    }
  }
}
