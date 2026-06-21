/**
 * MCP executor for the exclusive `canvas_*` tool family.
 *
 * Mirrors the audit/desktop executor shape: a pure-ish dispatcher built by a
 * factory over injected deps. It depends only on {@link CanvasController}
 * (the CanvasService interface), so it is unit-testable against a fake
 * controller with no Electron. Results use the standard McpToolExecutionResult
 * envelope; `canvas_screenshot` appends an `image` content block.
 *
 * Read-only tools (list/status/snapshot/inspect/network/console) are in
 * MCP_AUTO_ALLOWED_TOOLS; the state-touching tools (open/screenshot/resize/
 * close) flow through the host approval gate like browser_open.
 */
import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import type { CanvasCallContext, CanvasController } from '../canvas/canvasTypes'
import { resolveViewport } from '../canvas/canvasTypes'

export const CANVAS_MCP_TOOL_NAMES = [
  'canvas_open',
  'canvas_list',
  'canvas_status',
  'canvas_snapshot',
  'canvas_screenshot',
  'canvas_inspect',
  'canvas_network',
  'canvas_console',
  'canvas_resize',
  'canvas_close'
] as const

export type CanvasMcpToolName = (typeof CANVAS_MCP_TOOL_NAMES)[number]

const CANVAS_TOOL_NAME_SET: ReadonlySet<string> = new Set(CANVAS_MCP_TOOL_NAMES)

export function isCanvasMcpToolName(name: string): name is CanvasMcpToolName {
  return CANVAS_TOOL_NAME_SET.has(name)
}

/** Narrow context the executor needs; GeminiToolContext is structurally assignable. */
export interface CanvasToolContext {
  appChatId?: string
  appRunId?: string
  workspacePath?: string
}

export interface CanvasToolExecutorDeps {
  controller: CanvasController
}

export interface CanvasToolExecutors {
  executeCanvasTool: (
    toolName: CanvasMcpToolName,
    rawArgs: unknown,
    context: CanvasToolContext,
    parentProvider: string
  ) => Promise<McpToolExecutionResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asOptString(value: unknown): string | undefined {
  const s = asString(value).trim()
  return s ? s : undefined
}

function asOptNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((v) => asString(v).trim()).filter((v): v is string => Boolean(v))
    : []
}

function jsonResult(
  value: Record<string, unknown>,
  extraContent: McpToolContentBlock[] = []
): McpToolExecutionResult {
  const text = JSON.stringify(value)
  return { text, structuredContent: value, content: [{ type: 'text', text }, ...extraContent] }
}

function fail(toolName: CanvasMcpToolName, message: string): McpToolExecutionResult {
  const value = { ok: false, tool: toolName, error: message }
  const text = JSON.stringify(value)
  return { text, isError: true, structuredContent: value, content: [{ type: 'text', text }] }
}

export function createCanvasToolExecutors(deps: CanvasToolExecutorDeps): CanvasToolExecutors {
  const { controller } = deps

  async function executeCanvasTool(
    toolName: CanvasMcpToolName,
    rawArgs: unknown,
    context: CanvasToolContext,
    parentProvider: string
  ): Promise<McpToolExecutionResult> {
    const args = asRecord(rawArgs)
    const ctx: CanvasCallContext = {
      provider: parentProvider,
      chatId: context.appChatId,
      runId: context.appRunId,
      workspacePath: context.workspacePath
    }
    const canvasId = asOptString(args.canvasId)
    const needsId = (): string => {
      if (!canvasId) throw new Error('`canvasId` is required (from canvas_open / canvas_list).')
      return canvasId
    }

    try {
      switch (toolName) {
        case 'canvas_open': {
          const url = asOptString(args.url)
          if (!url) return fail(toolName, '`url` is required.')
          const driver = asOptString(args.driver)
          const viewport = resolveViewport({ width: args.width, height: args.height })
          const opened = await controller.open(
            {
              driver: driver === 'window' || driver === 'device' ? driver : 'web',
              url,
              viewport,
              originAllowlist: asStringArray(args.originAllowlist)
            },
            ctx
          )
          return jsonResult({
            ok: true,
            tool: toolName,
            canvasId: opened.canvasId,
            url: opened.url,
            title: opened.title,
            viewport: opened.viewport
          })
        }
        case 'canvas_list': {
          return jsonResult({ ok: true, tool: toolName, sessions: controller.list(ctx) })
        }
        case 'canvas_status': {
          return jsonResult({ ok: true, tool: toolName, session: controller.status(needsId(), ctx) })
        }
        case 'canvas_snapshot': {
          const tree = await controller.snapshot(needsId(), ctx)
          return jsonResult({ ok: true, tool: toolName, ...tree })
        }
        case 'canvas_screenshot': {
          const frame = await controller.screenshot(needsId(), ctx)
          return jsonResult(
            {
              ok: true,
              tool: toolName,
              mimeType: frame.mimeType,
              width: frame.width,
              height: frame.height,
              byteLength: frame.byteLength,
              hash: frame.hash,
              capturedAt: frame.capturedAt
            },
            [{ type: 'image', mimeType: frame.mimeType, data: frame.data }]
          )
        }
        case 'canvas_inspect': {
          const ref = asOptString(args.ref)
          const selector = asOptString(args.selector)
          if (!ref && !selector) return fail(toolName, 'Provide a `ref` or a `selector`.')
          const detail = await controller.inspect(
            needsId(),
            { ref, selector, styles: asStringArray(args.styles) },
            ctx
          )
          return jsonResult({ ok: true, tool: toolName, ...detail })
        }
        case 'canvas_network': {
          const filterRaw = asOptString(args.filter)
          const filter = filterRaw === 'failed' ? 'failed' : 'all'
          const requestId = asOptNumber(args.requestId)
          const requests = await controller.network(needsId(), { filter, requestId }, ctx)
          return jsonResult({ ok: true, tool: toolName, count: requests.length, requests })
        }
        case 'canvas_console': {
          const levelRaw = asOptString(args.level)
          const level = levelRaw === 'error' ? 'error' : levelRaw === 'warn' ? 'warn' : 'all'
          const entries = await controller.console(
            needsId(),
            { level, lines: asOptNumber(args.lines) },
            ctx
          )
          return jsonResult({ ok: true, tool: toolName, count: entries.length, entries })
        }
        case 'canvas_resize': {
          const viewport = resolveViewport({
            preset: asOptString(args.preset),
            width: args.width,
            height: args.height
          })
          const applied = await controller.resize(needsId(), viewport, ctx)
          return jsonResult({ ok: true, tool: toolName, viewport: applied })
        }
        case 'canvas_close': {
          await controller.close(needsId(), ctx)
          return jsonResult({ ok: true, tool: toolName, canvasId })
        }
        default: {
          return fail(toolName, `Unknown canvas tool "${toolName}".`)
        }
      }
    } catch (err) {
      return fail(toolName, err instanceof Error ? err.message : String(err))
    }
  }

  return { executeCanvasTool }
}
