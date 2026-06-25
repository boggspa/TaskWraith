import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'

/**
 * VideoToolbox MCP tool executors. Pure logic — the realpath input jail and the
 * daemon RPC are both INJECTED (VtToolDeps), so this is unit-testable without the
 * Swift bridge daemon or Electron. The security boundary lives in the injected
 * `jailInput` (realpath-jail a workspace path); `decodeFrame` is the daemon RPC
 * (`video.decodeFrame`) the host implements in index.ts.
 *
 * `video_decode_frame` extracts a SINGLE video frame via the daemon's native
 * VideoToolbox (hardware-accelerated; works WITHOUT a user-installed ffmpeg). The
 * decoded frame is a PNG, so — exactly like `video_thumbnail` — it rides the PROVEN
 * image-block lane: we return an `{ type: 'image', mimeType: 'image/png', data }`
 * content block, which the host turns into media_refs (createToolResultMediaRefs)
 * and renders inline. It does NOT use the trusted AV channel (that lane is only for
 * audio/video PRODUCERS whose output can't be an image block).
 */

export const VT_MCP_TOOL_NAMES = ['video_decode_frame'] as const
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
  decodeFrame: (params: { inputPath: string; timestampSeconds?: number; preferHardware?: boolean }) =>
    Promise<{ pngBase64: string; width: number; height: number; timestampSeconds: number; codec: string; usedHardware: boolean }>
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

export function createVtToolExecutors(deps: VtToolDeps): VtToolExecutors {
  const { jailInput, decodeFrame } = deps

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

  return {
    executeVtTool(toolName, rawArgs, ctx) {
      const args = asRecord(rawArgs)
      switch (toolName) {
        case 'video_decode_frame':
          return executeVideoDecodeFrame(args, ctx)
        default:
          return Promise.resolve(fail(String(toolName), `unknown VideoToolbox tool "${toolName}"`))
      }
    }
  }
}
