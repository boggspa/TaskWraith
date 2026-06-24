import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import { buildFfmpegArgs, buildFfprobeArgs, type FfmpegIntent } from '../media/FfmpegCommand'
import { parseFfprobeJson } from '../media/FfprobeResult'

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
 *
 * Deferred to S1b-3 (needs a trusted non-image media_refs channel — the existing
 * media_refs sinks treat every ref as provider-controlled + image-only): the
 * audio/video PRODUCERS (audio_extract / transcode_audio / transcode_video), whose
 * output is audio/video and so cannot ride the image-block lane.
 */

export const FFMPEG_MCP_TOOL_NAMES = ['video_probe', 'video_thumbnail'] as const
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
  /** Read a produced staging file → bytes (throws if missing / over the size cap). */
  readOutput: (path: string) => Buffer
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

export function createFfmpegToolExecutors(deps: FfmpegToolDeps): FfmpegToolExecutors {
  const { jailInput, resolveFfprobe, resolveFfmpeg, runFfprobe, runFfmpeg, stagingPath, readOutput, removeFile, missingMessage } = deps

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

  return {
    executeFfmpegTool(toolName, rawArgs, ctx) {
      const args = asRecord(rawArgs)
      if (toolName === 'video_probe') return executeVideoProbe(args, ctx)
      if (toolName === 'video_thumbnail') return executeVideoThumbnail(args, ctx)
      return Promise.resolve(fail(String(toolName), `unknown ffmpeg tool "${toolName}"`))
    }
  }
}
