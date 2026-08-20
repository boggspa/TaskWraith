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
  CanvasSketchUpdateInput,
  CanvasWindowOpenTarget
} from '../canvas/canvasTypes'
import { CANVAS_EVAL_SCRIPT_CAP, CANVAS_EVAL_VALUE_CAP } from '../canvas/canvasTypes'
import {
  redactUrlQuery,
  resolveViewport,
  validateCanvasHtml,
  validateCanvasImageRef,
  validateCanvasUrl
} from '../canvas/canvasTypes'
import { validateCanvasChart } from '../../shared/canvasChart'
import type { LaunchAttempt } from '../launch/types'

export const CANVAS_MCP_TOOL_NAMES = [
  'canvas_open',
  'canvas_render_html',
  'canvas_render_chart',
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
  'canvas_key',
  'canvas_scroll',
  'canvas_hover',
  'canvas_select',
  'canvas_wait_for',
  'canvas_annotate',
  'canvas_eval',
  'canvas_navigate',
  'canvas_close'
] as const

export type CanvasMcpToolName = (typeof CANVAS_MCP_TOOL_NAMES)[number]

const CANVAS_TOOL_NAME_SET: ReadonlySet<string> = new Set(CANVAS_MCP_TOOL_NAMES)
const NATIVE_WINDOW_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  'not-native-macos-launch',
  'attachment-required',
  'view-control-not-approved',
  'attachment-stale',
  'native-bridge-unavailable',
  'target-unavailable'
])

export function isCanvasMcpToolName(name: string): name is CanvasMcpToolName {
  return CANVAS_TOOL_NAME_SET.has(name)
}

/** Narrow context the executor needs; GeminiToolContext is structurally assignable. */
export interface CanvasToolContext {
  appChatId?: string
  appRunId?: string
  workspacePath?: string
  /** Direct seat id when the tool context carries one. */
  participantId?: string
  /** Ensemble run identity — participantId is used for device lease mint. */
  ensembleRun?: { participantId?: string | null } | null
  canvasEvalApproval?: CanvasEvalApprovalReceipt
  /**
   * Gates the NATIVE window branch of canvas_open_launch on Ensemble
   * Boss/Captain authority. The detected-loopback-URL branch is deliberately
   * NOT gated: previewing a dev server is ordinary lane work, and every
   * participant could already do it.
   */
  assertAppDriveAuthority?: () => { ok: true } | { ok: false; reason: string }
}

export type CanvasWindowOpenUnavailableReason =
  | 'not-native-macos-launch'
  | 'attachment-required'
  | 'view-control-not-approved'
  | 'attachment-stale'
  | 'native-bridge-unavailable'
  | 'target-unavailable'

export type CanvasWindowOpenTargetResolution =
  | { ok: true; target: CanvasWindowOpenTarget }
  | { ok: false; reason: CanvasWindowOpenUnavailableReason }

export interface CanvasWindowOpenResolveContext {
  appChatId: string
  appRunId: string
  workspacePath?: string
  parentProvider: string
}

export interface CanvasToolExecutorDeps {
  controller: CanvasController
  /**
   * Lazy snapshot of LaunchManager attempts. Kept optional so the canvas executor
   * remains usable in tests / early app startup; canvas_open_launch errors if it
   * is called before launch infrastructure is available.
   */
  launchAttempts?: () => LaunchAttempt[]
  /**
   * Main-owned native-window capability resolver. It receives only an exact
   * chat+run-owned launch attempt and returns an opaque lease reference or a
   * structured reason; raw attached-window handles never cross this boundary.
   */
  resolveWindowOpenTarget?: (
    attempt: LaunchAttempt,
    context: CanvasWindowOpenResolveContext
  ) => CanvasWindowOpenTargetResolution | Promise<CanvasWindowOpenTargetResolution>
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

function asCanonicalContextString(value: unknown): string | undefined {
  return typeof value === 'string' && Boolean(value) && value.trim() === value ? value : undefined
}

function canonicalWindowTarget(value: unknown): CanvasWindowOpenTarget | undefined {
  const leaseId = asCanonicalContextString(
    (value as Partial<CanvasWindowOpenTarget> | null)?.leaseId
  )
  return leaseId ? Object.freeze({ leaseId }) : undefined
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
  appChatId: string,
  appRunId: string
): LaunchAttempt[] {
  return attempts.filter((attempt) => attempt.chatId === appChatId && attempt.runId === appRunId)
}

function liveLaunchAttempt(attempt: LaunchAttempt): boolean {
  return attempt.status === 'starting' || attempt.status === 'running'
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

/**
 * One reason, one instruction. A single generic "attach it in Screen Watch"
 * for every failure is why an agent that had already been attached kept
 * retrying: the message never distinguished "the human has not done their part
 * yet" from "no amount of retrying will help".
 */
const NATIVE_WINDOW_GUIDANCE: Readonly<Record<CanvasWindowOpenUnavailableReason, string>> =
  Object.freeze({
    'attachment-required':
      'Ask the user to open Screen Watch for this chat, pick this launch’s window, and approve View & Control. You cannot initiate the pick.',
    'view-control-not-approved':
      'A window is attached but only for viewing. Ask the user to approve View & Control for this launch, then retry.',
    'attachment-stale':
      'The attached window or its control lease no longer matches this launch. Ask the user to attach the window again.',
    'target-unavailable':
      'The attached window does not belong to this launch, or could not be proved to descend from it. Check that the window is one this run started — an app opened through `open -a` is started by launchd, not by TaskWraith, so run its executable directly instead.',
    'not-native-macos-launch':
      'Native window control needs macOS 15.2 or newer. Use the launch’s detected localhost URL with canvas_open instead, or read launch_status output.',
    'native-bridge-unavailable':
      'The native bridge is not running, so no window can be driven. Report this to the user rather than retrying.'
  })

function nativeWindowGuidance(
  attemptId: string,
  reason: CanvasWindowOpenUnavailableReason
): McpToolExecutionResult {
  const guidance =
    NATIVE_WINDOW_GUIDANCE[reason] ??
    'Open Screen Watch for this launch, attach the app window, and approve View & Control; then retry canvas_open_launch.'
  const value = {
    ok: false,
    tool: 'canvas_open_launch',
    attemptId,
    reason,
    guidance,
    /** Retrying an unchanged call cannot succeed for these. */
    retryable: reason === 'attachment-required' || reason === 'view-control-not-approved'
  }
  const text = JSON.stringify(value)
  return {
    text,
    isError: true,
    structuredContent: value,
    content: [{ type: 'text', text }]
  }
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
    const ownerParticipantId =
      asOptString(context.participantId) || asOptString(context.ensembleRun?.participantId)
    const ctx: CanvasCallContext = {
      provider: parentProvider,
      chatId: context.appChatId,
      runId: context.appRunId,
      workspacePath: context.workspacePath,
      ...(ownerParticipantId ? { participantId: ownerParticipantId } : {}),
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
          const requestedDriver = asOptString(args.driver)
          const requestedPresentation = asOptString(args.presentation)
          if (
            requestedPresentation &&
            requestedPresentation !== 'window' &&
            requestedPresentation !== 'dock'
          ) {
            return fail(
              toolName,
              `Unsupported canvas presentation: ${requestedPresentation}. Use "window" or "dock".`
            )
          }
          if (requestedDriver === 'window') {
            return fail(
              toolName,
              'The native window driver is available only through canvas_open_launch after Screen Watch consent.'
            )
          }
          if (requestedDriver && requestedDriver !== 'web' && requestedDriver !== 'device') {
            return fail(toolName, `Unsupported canvas driver: ${requestedDriver}.`)
          }
          const driver = requestedDriver === 'device' ? 'device' : 'web'
          const viewport = resolveViewport({ width: args.width, height: args.height })
          if (driver === 'device') {
            if (requestedPresentation === 'dock') {
              return fail(toolName, 'Dock presentation is available only for the web driver.')
            }
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
              originAllowlist: asStringArray(args.originAllowlist),
              ...(requestedPresentation === 'dock'
                ? { embed: true, presentation: 'dock' as const }
                : {})
            },
            ctx
          )
          return jsonResult({
            ok: true,
            tool: toolName,
            canvasId: opened.canvasId,
            url: redactUrlQuery(opened.url),
            title: opened.title,
            viewport: opened.viewport,
            presentation: requestedPresentation === 'dock' ? 'dock' : 'window'
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
        case 'canvas_render_chart': {
          // Structured series data only — never canvas_eval / HTML / CDN scripts.
          const rawDocument =
            args.chartDocument !== undefined
              ? args.chartDocument
              : args.chart !== undefined
                ? args.chart
                : undefined
          if (rawDocument === undefined) {
            return fail(toolName, '`chartDocument` (structured chart JSON) is required.')
          }
          const verdict = validateCanvasChart(rawDocument)
          if (!verdict.ok) return fail(toolName, verdict.reason || 'Invalid chart document.')
          const viewport = resolveViewport({ width: args.width, height: args.height })
          const opened = await controller.open(
            {
              driver: 'chart',
              chartDocument: verdict.document,
              presentation: 'dock',
              viewport
            },
            ctx
          )
          const frame = await controller.screenshot(opened.canvasId, ctx)
          return jsonResult(
            {
              ok: true,
              tool: toolName,
              canvasId: opened.canvasId,
              url: redactUrlQuery(opened.url),
              title: opened.title,
              presentation: 'dock' as const,
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
          const requestedPresentation = asOptString(args.presentation)
          if (
            requestedPresentation &&
            requestedPresentation !== 'window' &&
            requestedPresentation !== 'dock'
          ) {
            return fail(
              toolName,
              `Unsupported canvas presentation: ${requestedPresentation}. Use "window" or "dock".`
            )
          }
          const appChatId = asCanonicalContextString(context.appChatId)
          const appRunId = asCanonicalContextString(context.appRunId)
          if (!appChatId || !appRunId) {
            return fail(
              toolName,
              'canvas_open_launch requires canonical active chat and run authority.'
            )
          }
          if (!deps.launchAttempts) {
            return fail(toolName, 'Launch attempts are not available yet (app still initializing).')
          }
          const attempt = ownLaunchAttempts(deps.launchAttempts(), appChatId, appRunId).find(
            (candidate) => candidate.id === attemptId
          )
          if (!attempt) return fail(toolName, `Launch attempt "${attemptId}" was not found.`)

          const viewport = resolveViewport({ width: args.width, height: args.height })
          const url = firstPreviewableLaunchUrl(attempt)
          if (url) {
            const opened = await controller.open(
              {
                driver: 'web',
                url,
                viewport,
                ...(requestedPresentation === 'dock'
                  ? { embed: true, presentation: 'dock' as const }
                  : {})
              },
              ctx
            )
            return jsonResult({
              ok: true,
              tool: toolName,
              attemptId,
              source: 'detectedUrl',
              canvasId: opened.canvasId,
              url: redactUrlQuery(opened.url),
              title: opened.title,
              viewport: opened.viewport,
              presentation: requestedPresentation === 'dock' ? 'dock' : 'window'
            })
          }

          if (requestedPresentation === 'dock') {
            return fail(
              toolName,
              'Dock presentation requires a running launch with a detected loopback URL.'
            )
          }

          if (liveLaunchAttempt(attempt)) {
            const authority = context.assertAppDriveAuthority?.()
            if (authority && !authority.ok) return fail(toolName, authority.reason)
            let resolution: CanvasWindowOpenTargetResolution | undefined
            if (deps.resolveWindowOpenTarget) {
              try {
                resolution = await deps.resolveWindowOpenTarget(attempt, {
                  appChatId,
                  appRunId,
                  workspacePath: context.workspacePath,
                  parentProvider
                })
              } catch {
                resolution = { ok: false, reason: 'native-bridge-unavailable' }
              }
            }

            if (resolution?.ok === true) {
              const windowTarget = canonicalWindowTarget(resolution.target)
              if (!windowTarget) {
                return nativeWindowGuidance(attemptId, 'target-unavailable')
              }
              const opened = await controller.open(
                { driver: 'window', windowTarget, viewport },
                ctx
              )
              return jsonResult({
                ok: true,
                tool: toolName,
                attemptId,
                source: 'attachedWindow',
                canvasId: opened.canvasId,
                url: redactUrlQuery(opened.url),
                title: opened.title,
                viewport: opened.viewport
              })
            }

            if (resolution?.ok === false) {
              const reason = NATIVE_WINDOW_UNAVAILABLE_REASONS.has(resolution.reason)
                ? resolution.reason
                : 'target-unavailable'
              if (
                reason !== 'not-native-macos-launch' ||
                attempt.targetSnapshot.platform === 'macos'
              ) {
                return nativeWindowGuidance(
                  attemptId,
                  reason === 'not-native-macos-launch' ? 'target-unavailable' : reason
                )
              }
            } else if (attempt.targetSnapshot.platform === 'macos') {
              return nativeWindowGuidance(attemptId, 'attachment-required')
            }
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
          const opened = await controller.open(
            { driver: 'sketch', embed: true, presentation: 'dock', viewport },
            ctx
          )
          const document = await controller.sketchDocument(opened.canvasId, ctx)
          return jsonResult({
            ok: true,
            tool: toolName,
            canvasId: opened.canvasId,
            url: redactUrlQuery(opened.url),
            title: opened.title,
            viewport: opened.viewport,
            presentation: 'dock' as const,
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
            {
              ref,
              selector,
              styles: asStringArray(args.styles),
              expectedObservationId: asOptString(args.expectedObservationId)
            },
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
          const expectedInputEpoch = asOptNumber(args.expectedInputEpoch)
          const expectedObservationId = asOptString(args.expectedObservationId)
          const result = await controller.click(
            needsId(),
            {
              kind: 'click',
              ref,
              selector,
              x,
              y,
              expectedInputEpoch,
              expectedObservationId
            },
            ctx
          )
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
            {
              kind: 'fill',
              ref,
              selector,
              value: args.value,
              expectedInputEpoch: asOptNumber(args.expectedInputEpoch),
              expectedObservationId: asOptString(args.expectedObservationId)
            },
            ctx
          )
          return jsonResult({
            ...result,
            ...(result.url ? { url: redactUrlQuery(result.url) } : {}),
            tool: toolName
          })
        }
        case 'canvas_key':
        case 'canvas_hover':
        case 'canvas_select':
        case 'canvas_wait_for': {
          const ref = asOptString(args.ref)
          const selector = asOptString(args.selector)
          if (!ref && !selector) return fail(toolName, 'Provide a `ref` or a `selector`.')
          const kind = toolName.slice('canvas_'.length) as
            | 'key'
            | 'hover'
            | 'select'
            | 'wait_for'
          if (kind === 'key' && typeof args.key !== 'string') {
            return fail(toolName, '`key` (string) is required.')
          }
          if (kind === 'select' && typeof args.value !== 'string') {
            return fail(toolName, '`value` (option value or label) is required.')
          }
          const result = await controller.act(
            needsId(),
            {
              kind,
              ref,
              selector,
              ...(kind === 'key' ? { key: args.key as string } : {}),
              ...(kind === 'select' ? { value: args.value as string } : {}),
              ...(kind === 'wait_for' ? { timeoutMs: asOptNumber(args.timeoutMs) } : {}),
              expectedInputEpoch: asOptNumber(args.expectedInputEpoch),
              expectedObservationId: asOptString(args.expectedObservationId)
            },
            ctx
          )
          return jsonResult({
            ...result,
            ...(result.url ? { url: redactUrlQuery(result.url) } : {}),
            tool: toolName
          })
        }
        case 'canvas_scroll': {
          const deltaX = asOptNumber(args.deltaX) ?? 0
          const deltaY = asOptNumber(args.deltaY) ?? 0
          if (deltaX === 0 && deltaY === 0) {
            return fail(toolName, 'Provide a non-zero `deltaX` and/or `deltaY`.')
          }
          const result = await controller.act(
            needsId(),
            {
              kind: 'scroll',
              ref: asOptString(args.ref),
              selector: asOptString(args.selector),
              x: asOptNumber(args.x),
              y: asOptNumber(args.y),
              deltaX,
              deltaY,
              expectedInputEpoch: asOptNumber(args.expectedInputEpoch),
              expectedObservationId: asOptString(args.expectedObservationId)
            },
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
        case 'canvas_navigate': {
          const url = asOptString(args.url)
          const rawAction = asOptString(args.action)
          const action =
            rawAction === 'back' ||
            rawAction === 'forward' ||
            rawAction === 'reload' ||
            rawAction === 'stop'
              ? rawAction
              : undefined
          if (rawAction && !action) {
            return fail(toolName, `Unsupported action "${rawAction}". Use back/forward/reload/stop.`)
          }
          if ((url && action) || (!url && !action)) {
            return fail(toolName, 'Provide exactly one of `url` or `action`.')
          }
          // Resolve the target: explicit canvasId → the chat's most recent open
          // web canvas → (goto only) auto-open a fresh browser canvas in the
          // active chat dock. A casual "browse to …" should present its work;
          // callers need not know the lower-level canvas_open presentation arg.
          let targetId = canvasId
          if (!targetId) {
            const webSessions = controller
              .list(ctx)
              .filter((session) => session.driver === 'web' && session.status === 'active')
            targetId = webSessions.at(-1)?.canvasId
          }
          if (!targetId) {
            if (!url) {
              return fail(
                toolName,
                'No open web canvas to control. Navigate to a `url` first (this opens the Canvas Browser automatically).'
              )
            }
            const viewport = resolveViewport({ width: args.width, height: args.height })
            const opened = await controller.open(
              { driver: 'web', url, viewport, embed: true, presentation: 'dock' },
              ctx
            )
            const state = controller.status(opened.canvasId, ctx)
            return jsonResult({
              ok: true,
              tool: toolName,
              canvasId: opened.canvasId,
              opened: true,
              presentation: 'dock',
              url: redactUrlQuery(opened.url),
              title: opened.title,
              isLoading: state?.isLoading ?? false,
              canGoBack: state?.canGoBack ?? false,
              canGoForward: state?.canGoForward ?? false
            })
          }
          const state = await controller.navigate(targetId, { url, action }, ctx)
          return jsonResult({
            ok: true,
            tool: toolName,
            canvasId: targetId,
            opened: false,
            url: redactUrlQuery(state.url),
            title: state.title,
            isLoading: state.isLoading,
            canGoBack: state.canGoBack,
            canGoForward: state.canGoForward
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
