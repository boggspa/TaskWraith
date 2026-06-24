import type { McpToolExecutionResult } from './McpBridgeRuntime'
import { buildFfprobeArgs } from '../media/FfmpegCommand'
import { parseFfprobeJson } from '../media/FfprobeResult'

/**
 * ffmpeg-family MCP tool executors (S1b). Pure logic — the binary resolver, the
 * realpath input jail, and the execFile runner are all INJECTED, so this is
 * unit-testable without a real ffmpeg or Electron. The security invariants live in
 * the injected deps (jail) + FfmpegCommand (intent→fixed argv); this module just
 * orchestrates jail → resolve → run → parse.
 *
 * S1b-1 ships `video_probe` (read-only analysis). The producing tools
 * (audio_extract / transcode_* / video_thumbnail) land in S1b-2 on the same deps.
 */

export const FFMPEG_MCP_TOOL_NAMES = ['video_probe'] as const
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
  /** Realpath-jail a workspace media path (the security boundary) → an absolute
   * real path safe to hand to ffprobe, or a reason it was rejected. */
  jailInput: (sourcePath: string, ctx: FfmpegToolContext) => JailedMediaInput
  /** Absolute ffprobe path, or null if the user hasn't installed it. */
  resolveFfprobe: () => string | null
  /** Run ffprobe with a fixed argv; resolve stdout/stderr, reject on non-zero/timeout. */
  runFfprobe: (binaryPath: string, args: string[]) => Promise<FfmpegRunResult>
  /** Actionable "install ffmpeg" capability message. */
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

function fail(toolName: string, message: string): McpToolExecutionResult {
  const value = { ok: false, tool: toolName, error: message }
  const text = JSON.stringify(value)
  return { text, isError: true, structuredContent: value, content: [{ type: 'text', text }] }
}

function success(toolName: string, value: Record<string, unknown>): McpToolExecutionResult {
  const full = { ok: true, tool: toolName, ...value }
  const text = JSON.stringify(full)
  return { text, structuredContent: full, content: [{ type: 'text', text }] }
}

export function createFfmpegToolExecutors(deps: FfmpegToolDeps): FfmpegToolExecutors {
  const { jailInput, resolveFfprobe, runFfprobe, missingMessage } = deps

  async function executeVideoProbe(
    args: Record<string, unknown>,
    ctx: FfmpegToolContext
  ): Promise<McpToolExecutionResult> {
    const sourcePath = typeof args.sourcePath === 'string' ? args.sourcePath.trim() : ''
    if (!sourcePath) return fail('video_probe', 'provide sourcePath (a media file inside the workspace)')

    const jailed = jailInput(sourcePath, ctx)
    if (!jailed.ok) return fail('video_probe', `could not read media: ${jailed.reason}`)

    const ffprobe = resolveFfprobe()
    if (!ffprobe) return fail('video_probe', missingMessage('ffprobe'))

    const argv = buildFfprobeArgs(jailed.realPath)
    if (!argv.ok) return fail('video_probe', argv.error)

    let run: FfmpegRunResult
    try {
      run = await runFfprobe(ffprobe, argv.args)
    } catch (error) {
      return fail('video_probe', error instanceof Error ? error.message : String(error))
    }

    const parsed = parseFfprobeJson(run.stdout)
    if (!parsed.ok) return fail('video_probe', parsed.error)

    return success('video_probe', { sniffedMime: jailed.mimeType, ...parsed.info })
  }

  return {
    executeFfmpegTool(toolName, rawArgs, ctx) {
      const args = asRecord(rawArgs)
      if (toolName === 'video_probe') return executeVideoProbe(args, ctx)
      return Promise.resolve(fail(String(toolName), `unknown ffmpeg tool "${toolName}"`))
    }
  }
}
