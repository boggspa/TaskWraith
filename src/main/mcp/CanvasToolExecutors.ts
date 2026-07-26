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
import type {
  CanvasCallContext,
  CanvasController,
  CanvasEvalApprovalReceipt,
  CanvasMark,
  CanvasSketchElement,
  CanvasSketchUpdateInput
} from '../canvas/canvasTypes'
import { CANVAS_EVAL_SCRIPT_CAP, CANVAS_EVAL_VALUE_CAP } from '../canvas/canvasTypes'
import {
  redactUrlQuery,
  resolveViewport,
  validateCanvasHtml,
  validateCanvasImageRef,
  validateCanvasUrl
} from '../canvas/canvasTypes'
import type { LaunchAttempt } from '../launch/types'

export const CANVAS_MCP_TOOL_NAMES = [
  'canvas_open',
  'canvas_render_html',
  'canvas_open_attachment',
  'canvas_open_launch',
  'canvas_sketch_open',
  'canvas_sketch_get',
  'canvas_sketch_update',
  'canvas_list',
  'canvas_status',
  'canvas_snapshot',
  'canvas_screenshot',
  'canvas_inspect',
  'canvas_network',
  'canvas_console',
  'canvas_resize',
  'canvas_click',
  'canvas_fill',
  'canvas_annotate',
  'canvas_eval',
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
  canvasEvalApproval?: CanvasEvalApprovalReceipt
}

export interface CanvasToolExecutorDeps {
  controller: CanvasController
  /**
   * Lazy snapshot of LaunchManager attempts. Kept optional so the canvas executor
   * remains usable in tests / early app startup; canvas_open_launch errors if it
   * is called before launch infrastructure is available.
   */
  launchAttempts?: () => LaunchAttempt[]
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

function parseMarks(value: unknown): CanvasMark[] {
  if (!Array.isArray(value)) return []
  const marks: CanvasMark[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const label = asString(r.label).trim()
    if (!label) continue
    const mark: CanvasMark = { label: label.slice(0, 200) }
    const ref = asOptString(r.ref)
    if (ref) mark.ref = ref
    if (Array.isArray(r.bbox) && r.bbox.length === 4 && r.bbox.every((n) => typeof n === 'number')) {
      mark.bbox = [r.bbox[0] as number, r.bbox[1] as number, r.bbox[2] as number, r.bbox[3] as number]
    }
    if (r.severity === 'info' || r.severity === 'warn' || r.severity === 'error') {
      mark.severity = r.severity
    }
    // A mark needs a target (ref or bbox) to render.
    if (mark.ref || mark.bbox) marks.push(mark)
  }
  return marks
}

function parseSketchElements(value: unknown): CanvasSketchElement[] {
  return Array.isArray(value)
    ? value.filter((item): item is CanvasSketchElement => Boolean(item) && typeof item === 'object')
        .filter((item) =>
          ['rect', 'ellipse', 'line', 'arrow', 'text', 'path'].includes(
            String((item as { kind?: unknown }).kind || '')
          )
        )
    : []
}

function parseSketchUpdate(args: Record<string, unknown>): CanvasSketchUpdateInput {
  const rawMode = asOptString(args.mode)
  const mode =
    rawMode === 'replace' || rawMode === 'clear' || rawMode === 'delete'
      ? rawMode
      : 'append'
  const update: CanvasSketchUpdateInput = { mode }
  const title = asOptString(args.title)
  if (title) update.title = title
  // Optimistic-concurrency guard from canvas_sketch_get. Optional: omitting it
  // forces the write, which is the pre-existing behaviour.
  const expectedUpdatedAt = asOptString(args.expectedUpdatedAt)
  if (expectedUpdatedAt) update.expectedUpdatedAt = expectedUpdatedAt
  if (mode === 'delete') {
    update.elementIds = asStringArray(args.elementIds)
  } else if (mode !== 'clear') {
    update.elements = parseSketchElements(args.elements)
  }
  return update
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

function canvasToolErrorForProvider(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const lower = raw.toLowerCase()
  // Retryable refusals are surfaced with their own codes: collapsing them into
  // operation_failed leaves the caller unable to tell "wait and retry" from
  // "this will never work", which is exactly when agents escalate destructively.
  const code = lower.includes('user is drawing')
    ? 'user_busy'
    : lower.includes('stale expectedupdatedat')
      ? 'stale_document'
      : lower.includes('timed out')
    ? 'timeout'
    : lower.includes('cancel') || lower.includes('history')
      ? 'authority_changed'
      : lower.includes('navigation') || lower.includes('load')
        ? 'navigation_failed'
        : lower.includes('not found') || lower.includes('no open canvas')
          ? 'not_found'
          : 'operation_failed'
  return `Canvas operation failed (${code}).`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function ownLaunchAttempts(
  attempts: LaunchAttempt[],
  context: CanvasToolContext
): LaunchAttempt[] {
  const chat = context.appChatId
  if (!chat) return []
  return attempts.filter((attempt) => attempt.chatId === chat)
}

function firstPreviewableLaunchUrl(attempt: LaunchAttempt): string | undefined {
  if (attempt.status !== 'starting' && attempt.status !== 'running') return undefined
  for (const rawUrl of attempt.detectedUrls ?? []) {
    const verdict = validateCanvasUrl(rawUrl)
    // LaunchManager only detects loopback URLs; keep the extra class check here
    // so a future detector broadening cannot turn canvas_open_launch into a
    // public-web opener without an explicit design change.
    if (verdict.ok && verdict.hostClass === 'loopback') {
      return verdict.normalizedUrl ?? rawUrl
    }
  }
  return undefined
}

function launchLogHtml(attempt: LaunchAttempt): string {
  const output = attempt.outputTail.trimEnd()
  const body = output || '(no process output captured yet)'
  const truncated = attempt.outputTruncated
    ? '<div class="notice">Showing the most recent captured output.</div>'
    : ''
  const lines = [
    ['Target', attempt.targetLabel],
    ['Status', attempt.status],
    ['Started', attempt.startedAt],
    ['Updated', attempt.updatedAt]
  ]
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || '')}</dd></div>`)
    .join('')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(attempt.targetLabel)} output</title>
<style>
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; background: #111318; color: #f4f7fb; }
main { min-height: 100vh; box-sizing: border-box; padding: 28px; }
h1 { margin: 0 0 16px; font-size: 24px; font-weight: 650; letter-spacing: 0; }
dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 0 0 20px; }
dl > div { padding: 10px 12px; border: 1px solid #303643; border-radius: 6px; background: #191d25; }
dt { color: #aab4c2; font-size: 12px; margin-bottom: 4px; }
dd { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.notice { margin: 0 0 12px; color: #f7d488; font-size: 13px; }
pre { margin: 0; padding: 16px; border: 1px solid #303643; border-radius: 6px; background: #07090d; color: #f4f7fb; overflow: auto; white-space: pre-wrap; word-break: break-word; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(attempt.targetLabel)} output</h1>
<dl>${lines}</dl>
${truncated}
<pre>${escapeHtml(body)}</pre>
</main>
</body>
</html>`
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
      workspacePath: context.workspacePath,
      canvasEvalApproval: context.canvasEvalApproval
    }
    const canvasId = asOptString(args.canvasId)
    const needsId = (): string => {
      if (!canvasId) throw new Error('`canvasId` is required (from canvas_open / canvas_list).')
      return canvasId
    }

    try {
      switch (toolName) {
        case 'canvas_open': {
          const driver = asOptString(args.driver) === 'device' ? 'device' : 'web'
          const viewport = resolveViewport({ width: args.width, height: args.height })
          if (driver === 'device') {
            // iOS simulator: launch + screenshot an app by bundle id (no url).
            const bundleId = asOptString(args.bundleId)
            if (!bundleId) {
              return fail(toolName, '`bundleId` is required for the device driver.')
            }
            const udid = asOptString(args.udid)
            const opened = await controller.open(
              {
                driver: 'device',
                bundleId,
                appPath: asOptString(args.appPath),
                device: udid ? { udid } : undefined,
                viewport
              },
              ctx
            )
            return jsonResult({
              ok: true,
              tool: toolName,
              canvasId: opened.canvasId,
              url: redactUrlQuery(opened.url),
              title: opened.title,
              viewport: opened.viewport
            })
          }
          const url = asOptString(args.url)
          if (!url) return fail(toolName, '`url` is required.')
          const opened = await controller.open(
            {
              driver: 'web',
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
            url: redactUrlQuery(opened.url),
            title: opened.title,
            viewport: opened.viewport
          })
        }
        case 'canvas_render_html': {
          const html = asString(args.html)
          const verdict = validateCanvasHtml(html)
          if (!verdict.ok) return fail(toolName, verdict.reason || 'Invalid `html`.')
          const viewport = resolveViewport({ width: args.width, height: args.height })
          const opened = await controller.open({ driver: 'html', html, viewport }, ctx)
          // Return the first rendered frame so the agent sees its layout immediately.
          const frame = await controller.screenshot(opened.canvasId, ctx)
          return jsonResult(
            {
              ok: true,
              tool: toolName,
              canvasId: opened.canvasId,
              url: redactUrlQuery(opened.url),
              title: opened.title,
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
        case 'canvas_open_attachment': {
          const sha256 = asOptString(args.sha256) ?? asOptString(args.mediaSha256) ?? ''
          const mimeType = asOptString(args.mimeType) ?? asOptString(args.mediaMimeType) ?? ''
          const verdict = validateCanvasImageRef(sha256, mimeType)
          if (!verdict.ok) return fail(toolName, verdict.reason || 'Invalid attachment ref.')
          const viewport = resolveViewport({ width: args.width, height: args.height })
          const opened = await controller.open(
            { driver: 'image', mediaSha256: sha256, mediaMimeType: mimeType, viewport },
            ctx
          )
          // Surface the image immediately as an MCP image content block.
          const frame = await controller.screenshot(opened.canvasId, ctx)
          return jsonResult(
            {
              ok: true,
              tool: toolName,
              canvasId: opened.canvasId,
              url: redactUrlQuery(opened.url),
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
        case 'canvas_open_launch': {
          const attemptId = asOptString(args.attemptId)
          if (!attemptId) return fail(toolName, '`attemptId` is required (from launch_start / launch_status).')
          if (!deps.launchAttempts) {
            return fail(toolName, 'Launch attempts are not available yet (app still initializing).')
          }
          const attempt = ownLaunchAttempts(deps.launchAttempts(), context).find((a) => a.id === attemptId)
          if (!attempt) return fail(toolName, `Launch attempt "${attemptId}" was not found.`)

          const viewport = resolveViewport({ width: args.width, height: args.height })
          const url = firstPreviewableLaunchUrl(attempt)
          if (url) {
            const opened = await controller.open({ driver: 'web', url, viewport }, ctx)
            return jsonResult({
              ok: true,
              tool: toolName,
              attemptId,
              source: 'detectedUrl',
              canvasId: opened.canvasId,
              url: redactUrlQuery(opened.url),
              title: opened.title,
              viewport: opened.viewport
            })
          }
          if (!attempt.runId) {
            return fail(
              toolName,
              'Launch output is only available for agent-started attempts; no live loopback URL was detected.'
            )
          }

          const opened = await controller.open(
            { driver: 'html', html: launchLogHtml(attempt), viewport },
            ctx
          )
          const frame = await controller.screenshot(opened.canvasId, ctx)
          return jsonResult(
            {
              ok: true,
              tool: toolName,
              attemptId,
              source: 'outputTail',
              canvasId: opened.canvasId,
              url: redactUrlQuery(opened.url),
              title: opened.title,
              status: attempt.status,
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
        case 'canvas_sketch_open': {
          const viewport = resolveViewport({ width: args.width, height: args.height })
          const opened = await controller.open({ driver: 'sketch', viewport }, ctx)
          const document = await controller.sketchDocument(opened.canvasId, ctx)
          return jsonResult({
            ok: true,
            tool: toolName,
            canvasId: opened.canvasId,
            url: redactUrlQuery(opened.url),
            title: opened.title,
            viewport: opened.viewport,
            document
          })
        }
        case 'canvas_sketch_get': {
          const document = await controller.sketchDocument(needsId(), ctx)
          return jsonResult({ ok: true, tool: toolName, canvasId, document })
        }
        case 'canvas_sketch_update': {
          const update = parseSketchUpdate(args)
          if (update.mode === 'delete' && (!update.elementIds || update.elementIds.length === 0)) {
            return fail(toolName, '`elementIds` is required when mode is "delete".')
          }
          if (
            (update.mode === 'append' || update.mode === 'replace') &&
            (!update.elements || update.elements.length === 0) &&
            !update.title
          ) {
            return fail(toolName, '`elements` or `title` is required for sketch updates.')
          }
          const document = await controller.sketchUpdate(needsId(), update, ctx)
          return jsonResult({
            ok: true,
            tool: toolName,
            canvasId,
            mode: update.mode,
            elementCount: document.elements.length,
            document
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
          return jsonResult({
            ok: true,
            tool: toolName,
            ...tree,
            url: redactUrlQuery(tree.url)
          })
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
          return jsonResult({
            ok: true,
            tool: toolName,
            count: requests.length,
            requests: requests.map((request) => ({
              ...request,
              url: redactUrlQuery(request.url)
            }))
          })
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
        case 'canvas_click': {
          const ref = asOptString(args.ref)
          const selector = asOptString(args.selector)
          const x = asOptNumber(args.x)
          const y = asOptNumber(args.y)
          if (!ref && !selector && (x === undefined || y === undefined)) {
            return fail(toolName, 'Provide a `ref`, a `selector`, or both `x` and `y`.')
          }
          const result = await controller.click(needsId(), { kind: 'click', ref, selector, x, y }, ctx)
          return jsonResult({
            ...result,
            ...(result.url ? { url: redactUrlQuery(result.url) } : {}),
            tool: toolName
          })
        }
        case 'canvas_fill': {
          const ref = asOptString(args.ref)
          const selector = asOptString(args.selector)
          if (!ref && !selector) return fail(toolName, 'Provide a `ref` or a `selector`.')
          if (typeof args.value !== 'string') return fail(toolName, '`value` (string) is required.')
          const result = await controller.fill(
            needsId(),
            { kind: 'fill', ref, selector, value: args.value },
            ctx
          )
          return jsonResult({
            ...result,
            ...(result.url ? { url: redactUrlQuery(result.url) } : {}),
            tool: toolName
          })
        }
        case 'canvas_annotate': {
          const marks = parseMarks(args.marks)
          if (marks.length === 0) {
            return fail(toolName, '`marks` must be a non-empty array of { ref | bbox, label }.')
          }
          const annotation = await controller.annotate(needsId(), marks, ctx)
          return jsonResult({
            ok: true,
            tool: toolName,
            annotationId: annotation.id,
            count: annotation.marks.length
          })
        }
        case 'canvas_eval': {
          const script = asString(args.script)
          if (!script.trim()) return fail(toolName, '`script` (JavaScript string) is required.')
          // Bound the script size before it ever reaches the page (defence-in-depth
          // alongside the per-session eval budget and the signed-elevated approval).
          if (script.length > CANVAS_EVAL_SCRIPT_CAP) {
            return fail(
              toolName,
              `\`script\` too large (max ${CANVAS_EVAL_SCRIPT_CAP} chars).`
            )
          }
          if (!ctx.canvasEvalApproval) {
            return fail(toolName, 'canvas_eval requires a bound per-call approval receipt.')
          }
          const result = await controller.evaluate(needsId(), { script }, ctx)
          return jsonResult({
            ...result,
            ...(result.url ? { url: redactUrlQuery(result.url) } : {}),
            tool: toolName
          })
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
      return fail(
        toolName,
        toolName === 'canvas_eval'
          ? canvasToolErrorForProvider(err).slice(0, CANVAS_EVAL_VALUE_CAP)
          : canvasToolErrorForProvider(err)
      )
    }
  }

  return { executeCanvasTool }
}
