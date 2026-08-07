/**
 * Agent-facing AppShots MCP tools — capture frames of owned/attached processes
 * and list capture targets for the current chat.
 */

import type { TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import {
  resolveAppshotsTargetOwnership,
  type AppshotsLaunchCandidate,
  type AppshotsSpawnCandidate
} from '../AppshotsTargetOwnership'
import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import type {
  DesktopAttachedWindowState,
  DesktopBridgeDaemon,
  DesktopToolContext
} from './DesktopToolExecutors'
import type { ScopedAttachedWindowSnapshot } from '../nativeWindow/ScopedAttachedWindowState'
import type { NativeCapabilitySnapshot } from '../NativeCapabilities'

export const APPSHOTS_MCP_TOOL_NAMES = [
  'appshots',
  'appshots_status'
] as const satisfies readonly TaskWraithMcpToolName[]

export type AppshotsMcpToolName = (typeof APPSHOTS_MCP_TOOL_NAMES)[number]

const APPSHOTS_TOOL_SET = new Set<string>(APPSHOTS_MCP_TOOL_NAMES)

export function isAppshotsMcpToolName(toolName: string): toolName is AppshotsMcpToolName {
  return APPSHOTS_TOOL_SET.has(toolName)
}

const DEFAULT_MAX_DIMENSION_PX = 1600
const MAX_FRAMES = 8
const MAX_FRAMES_WITH_OCR = 5
const MIN_INTERVAL_MS = 100
const MAX_INTERVAL_MS = 60_000

export interface AppshotsProtectedOwners {
  pids: number[]
  windowIDs?: number[]
}

export interface AppshotsToolExecutorDeps {
  getBridgeDaemon(): DesktopBridgeDaemon | null
  getNativeCapabilities?: () => NativeCapabilitySnapshot
  attachedWindow: DesktopAttachedWindowState
  listTrackedSpawns: () => ReadonlyArray<AppshotsSpawnCandidate>
  listLaunchAttempts: () => ReadonlyArray<AppshotsLaunchCandidate>
  getWorkspacePathForChat?: (chatId: string) => string | null | undefined
  getProtectedOwners?: () => AppshotsProtectedOwners | null
  /** True when the mcpTools gate already approved this invocation (e.g. Full Access / user Accept). */
  allowForeignAfterApproval?: (context: DesktopToolContext) => boolean
  sleep?: (ms: number) => Promise<void>
}

type CaptureDaemonResult = {
  pngBase64?: string
  byteLength?: number
  width?: number
  height?: number
  windowMeta?: Record<string, unknown>
  capturedAt?: string
  ocr?: { text?: string }
  ocrError?: string | null
  captureMode?: string
  error?: string
}

function jsonResult(
  value: Record<string, unknown>,
  extraContent: McpToolContentBlock[] = []
): McpToolExecutionResult {
  const text = JSON.stringify(value, null, 2)
  return {
    text,
    structuredContent: value,
    content: [{ type: 'text', text }, ...extraContent]
  }
}

function scopedAccess(snapshot: ScopedAttachedWindowSnapshot) {
  return {
    handleID: snapshot.handleID,
    scopeID: snapshot.scopeID,
    chatID: snapshot.chatID,
    consentEpoch: snapshot.consentEpoch,
    generation: snapshot.generation
  }
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parsePid(args: Record<string, unknown>): number | null {
  const raw = args.pid ?? args.process_id ?? args.processId
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.trunc(n)
}

function parseCount(args: Record<string, unknown>, includeOcr: boolean): number {
  const raw = Number(args.count ?? 1)
  const max = includeOcr ? MAX_FRAMES_WITH_OCR : MAX_FRAMES
  if (!Number.isFinite(raw) || raw < 1) return 1
  return Math.min(max, Math.trunc(raw))
}

function parseIntervalMs(args: Record<string, unknown>): number | null {
  const raw = args.interval_ms ?? args.intervalMs ?? args.interval
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.trunc(n)))
}

function parseMaxDimension(args: Record<string, unknown>): number {
  const raw = Number(args.max_dimension_px ?? args.maxDimensionPx)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_DIMENSION_PX
  return Math.min(4096, Math.max(240, Math.trunc(raw)))
}

function parseWindowId(args: Record<string, unknown>): number | null {
  const raw = args.window_id ?? args.windowId ?? args.windowID
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.trunc(n)
}

function unsupportedNative(
  tool: string,
  caps?: NativeCapabilitySnapshot
): McpToolExecutionResult | null {
  if (!caps) return null
  if (caps.appwatch?.available === false || caps.screenWatch?.available === false) {
    return jsonResult({
      ok: false,
      tool,
      error:
        caps.appwatch?.reason ||
        caps.screenWatch?.reason ||
        'AppShots / Screen Watch is unavailable on this platform.'
    })
  }
  return null
}

export function createAppshotsToolExecutors(deps: AppshotsToolExecutorDeps) {
  const sleep = deps.sleep || sleepDefault

  function resolveContext(
    context: DesktopToolContext,
    requestedPid: number | null
  ): {
    chatId: string
    attached: ScopedAttachedWindowSnapshot | null
    ownership: ReturnType<typeof resolveAppshotsTargetOwnership>
  } {
    const chatId = String(context.appChatId || '').trim()
    const attached = deps.attachedWindow.getForChat(chatId || null)
    const workspacePath =
      (chatId && deps.getWorkspacePathForChat?.(chatId)) ||
      context.workspacePath ||
      context.cwd
    const ownership = resolveAppshotsTargetOwnership({
      chatId,
      requestedPid,
      attached: attached
        ? {
            pid: attached.windowMeta.pid,
            chatId: attached.chatID,
            processStartedAt: attached.windowMeta.processStartedAt,
            label:
              attached.windowMeta.applicationName ||
              attached.windowMeta.title ||
              attached.windowMeta.bundleID
          }
        : null,
      spawns: deps.listTrackedSpawns(),
      launches: deps.listLaunchAttempts(),
      workspacePath
    })
    return { chatId, attached, ownership }
  }

  async function captureFrame(opts: {
    pid: number
    useAttached: boolean
    attached: ScopedAttachedWindowSnapshot | null
    includeOcr: boolean
    maxDimensionPx: number
    windowId: number | null
  }): Promise<{ pngBase64: string; meta: CaptureDaemonResult } | { error: string }> {
    const daemon = deps.getBridgeDaemon()
    if (!daemon?.status().running) {
      return {
        error:
          'TaskWraith bridge daemon is not running. Enable it in Settings -> Bridge Networking.'
      }
    }

    let result: CaptureDaemonResult
    try {
      if (opts.useAttached && opts.attached) {
        result = await daemon.request<CaptureDaemonResult>(
          'attachedWindow.capture',
          {
            ...scopedAccess(opts.attached),
            includeOCR: opts.includeOcr,
            maxDimensionPx: opts.maxDimensionPx
          },
          { timeoutMs: 30_000 }
        )
      } else {
        const protectedOwners = deps.getProtectedOwners?.() || null
        result = await daemon.request<CaptureDaemonResult>(
          'attachedWindow.captureByPid',
          {
            pid: opts.pid,
            ...(opts.windowId ? { windowID: opts.windowId } : {}),
            includeOCR: opts.includeOcr,
            maxDimensionPx: opts.maxDimensionPx,
            ...(protectedOwners && protectedOwners.pids.length > 0
              ? { protectedOwners }
              : {})
          },
          { timeoutMs: 30_000 }
        )
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }

    const pngBase64 = typeof result.pngBase64 === 'string' ? result.pngBase64 : ''
    if (!pngBase64) {
      return {
        error:
          typeof result.error === 'string' ? result.error : 'Bridge daemon returned no PNG payload.'
      }
    }
    return { pngBase64, meta: result }
  }

  async function executeAppshots(
    args: Record<string, unknown>,
    context: DesktopToolContext
  ): Promise<McpToolExecutionResult> {
    const unsupported = unsupportedNative('appshots', deps.getNativeCapabilities?.())
    if (unsupported) return { ...unsupported, isError: true }

    const includeOcr = args.include_ocr === true || args.includeOCR === true
    const count = parseCount(args, includeOcr)
    const intervalMs = parseIntervalMs(args)
    const maxDimensionPx = parseMaxDimension(args)
    const windowId = parseWindowId(args)
    const requestedPid = parsePid(args)
    const { attached, ownership } = resolveContext(context, requestedPid)
    const allowForeign = deps.allowForeignAfterApproval?.(context) === true

    if (!ownership.allowed) {
      if (!allowForeign || requestedPid === null) {
        return {
          ...jsonResult({
            ok: false,
            tool: 'appshots',
            reason: ownership.reason,
            error:
              ownership.reason === 'missing'
                ? 'No window attached and no pid provided. Attach via Screen Watch or pass a TaskWraith-spawned pid.'
                : 'Process is not owned by this chat. Attach the window, use a TaskWraith-spawned pid, or get approval (Full Access auto-allows after the mcpTools gate).'
          }),
          isError: true
        }
      }
    }

    const pid = ownership.target?.pid ?? requestedPid
    if (!pid) {
      return {
        ...jsonResult({
          ok: false,
          tool: 'appshots',
          error: 'No capture target pid.'
        }),
        isError: true
      }
    }

    const useAttached =
      ownership.allowed &&
      ownership.reason === 'attached' &&
      Boolean(attached) &&
      attached!.windowMeta.pid === pid

    const frames: Array<Record<string, unknown>> = []
    const images: McpToolContentBlock[] = []
    const labels: string[] = []

    for (let i = 0; i < count; i++) {
      if (i > 0 && intervalMs) await sleep(intervalMs)
      const captured = await captureFrame({
        pid,
        useAttached,
        attached,
        includeOcr,
        maxDimensionPx,
        windowId
      })
      if ('error' in captured) {
        return {
          ...jsonResult({ ok: false, tool: 'appshots', error: captured.error }),
          isError: true
        }
      }
      const label = count === 1 ? 'appshots' : `frame-${i + 1}`
      labels.push(label)
      images.push({ type: 'image', mimeType: 'image/png', data: captured.pngBase64 })
      frames.push({
        index: i,
        label,
        mimeType: 'image/png',
        byteLength: captured.meta.byteLength ?? 0,
        width: captured.meta.width ?? 0,
        height: captured.meta.height ?? 0,
        capturedAt: captured.meta.capturedAt ?? new Date().toISOString(),
        windowMeta: captured.meta.windowMeta ?? null,
        ocrText: captured.meta.ocr?.text ?? null,
        ocrError: captured.meta.ocrError ?? null,
        captureMode: captured.meta.captureMode ?? (useAttached ? 'attached' : 'byPid')
      })
    }

    const result = jsonResult(
      {
        ok: true,
        tool: 'appshots',
        ownership: ownership.allowed ? ownership.reason : 'foreign-approved',
        pid,
        frameCount: frames.length,
        intervalMs: intervalMs ?? null,
        frames
      },
      images
    )
    return {
      ...result,
      mediaRefHints: {
        groupKind: 'appshots',
        labels,
        maxRefs: Math.max(frames.length, 8)
      }
    }
  }

  async function executeAppshotsStatus(
    context: DesktopToolContext
  ): Promise<McpToolExecutionResult> {
    const unsupported = unsupportedNative('appshots_status', deps.getNativeCapabilities?.())
    if (unsupported) return unsupported

    const chatId = String(context.appChatId || '').trim()
    const attached = deps.attachedWindow.getForChat(chatId || null)
    const workspacePath =
      (chatId && deps.getWorkspacePathForChat?.(chatId)) ||
      context.workspacePath ||
      context.cwd
    const spawns = deps.listTrackedSpawns()
    const launches = deps.listLaunchAttempts()

    const targets: Array<Record<string, unknown>> = []
    if (attached) {
      targets.push({
        kind: 'attached',
        pid: attached.windowMeta.pid,
        label:
          attached.windowMeta.applicationName ||
          attached.windowMeta.title ||
          attached.windowMeta.bundleID,
        processStartedAt: attached.windowMeta.processStartedAt ?? null
      })
    }

    for (const spawn of spawns) {
      if (targets.some((t) => t.pid === spawn.pid)) continue
      const ownership = resolveAppshotsTargetOwnership({
        chatId,
        requestedPid: spawn.pid,
        attached: attached
          ? { pid: attached.windowMeta.pid, chatId: attached.chatID }
          : null,
        spawns: [spawn],
        launches: [],
        workspacePath
      })
      if (!ownership.allowed) continue
      targets.push({
        kind: ownership.reason,
        pid: spawn.pid,
        label: spawn.label || spawn.provider || `pid ${spawn.pid}`,
        processStartedAt: spawn.startedAt ?? null
      })
    }

    for (const launch of launches) {
      if (!launch.pid || targets.some((t) => t.pid === launch.pid)) continue
      const ownership = resolveAppshotsTargetOwnership({
        chatId,
        requestedPid: launch.pid,
        attached: null,
        spawns: [],
        launches: [launch],
        workspacePath
      })
      if (!ownership.allowed) continue
      targets.push({
        kind: ownership.reason,
        pid: launch.pid,
        label: launch.targetLabel || `pid ${launch.pid}`,
        processStartedAt: launch.processStartedAt ?? null
      })
    }

    return jsonResult({
      ok: true,
      tool: 'appshots_status',
      attached: Boolean(attached),
      targetCount: targets.length,
      targets
    })
  }

  async function executeAppshotsTool(
    toolName: AppshotsMcpToolName,
    args: Record<string, unknown>,
    context: DesktopToolContext
  ): Promise<McpToolExecutionResult> {
    if (toolName === 'appshots_status') return executeAppshotsStatus(context)
    return executeAppshots(args, context)
  }

  return {
    executeAppshotsTool,
    executeAppshots,
    executeAppshotsStatus
  }
}
