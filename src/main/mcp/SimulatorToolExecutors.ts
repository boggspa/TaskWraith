/** Provider-neutral semantic MCP executor for the Simulator Canvas host. */
import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import {
  SIMULATOR_MCP_TOOL_NAMES,
  type SimulatorMcpToolName
} from '../../shared/taskWraithMcpCatalog'
import type { SimulatorHostControl } from '../simulator/SimulatorHostControl'
import type { SimulatorControllerLease } from '../simulator/SimulatorControllerLease'
import type { IdbClient } from '../simulator/IdbClient'
import type { SimulatorActuationTarget } from '../simulator/SimulatorInteractionBridge'
import type { SimulatorHostActionResult } from '../../shared/simulatorCanvas'
import {
  isSimulatorHardwareButton,
  isSimulatorRotateDirection
} from '../../shared/simulatorCanvas'
import {
  clamp01,
  mapNormalizedScroll,
  mapNormalizedTap
} from '../simulator/simulatorGestureMapping'

/** Main-side alias retained for MCP dispatch callers. The shared catalogue owns membership. */
export const SIMULATOR_MCP_TOOL_NAMES_MAIN = SIMULATOR_MCP_TOOL_NAMES
export { SIMULATOR_MCP_TOOL_NAMES }

export type { SimulatorMcpToolName }

const SIMULATOR_TOOL_NAME_SET: ReadonlySet<string> = new Set(SIMULATOR_MCP_TOOL_NAMES)

/** Mutating simulator tools require an active run controller lease. */
const SIMULATOR_MUTATING_TOOLS: ReadonlySet<SimulatorMcpToolName> = new Set([
  'simulator_open',
  'simulator_boot',
  'simulator_install',
  'simulator_launch',
  'simulator_terminate',
  'simulator_button',
  'simulator_rotate',
  'simulator_tap',
  'simulator_type',
  'simulator_scroll'
])

export function isSimulatorMcpToolName(value: string): value is SimulatorMcpToolName {
  return SIMULATOR_TOOL_NAME_SET.has(value)
}

export interface SimulatorToolContext {
  appChatId?: string
  appRunId?: string
  participantId?: string
  ensembleRun?: { participantId?: string | null } | null
}

export interface SimulatorToolExecutors {
  executeSimulatorTool: (
    toolName: SimulatorMcpToolName,
    rawArgs: unknown,
    context: SimulatorToolContext,
    parentProvider: string
  ) => Promise<McpToolExecutionResult>
}

export interface SimulatorToolExecutorDeps {
  hostControl: Pick<
    SimulatorHostControl,
    'status' | 'openSimulatorApp' | 'boot' | 'install' | 'launch' | 'terminate' | 'screenshot'
  >
  controllerLease: Pick<SimulatorControllerLease, 'mint'>
  /** Required for inspect / button / rotate / HID (idb argv-array path). */
  idb: Pick<
    IdbClient,
    'isAvailable' | 'describeAll' | 'hardwareButton' | 'rotate' | 'tap' | 'text' | 'swipe'
  >
  /**
   * Session point dims for normalizing agent bezel coords. Optional width/height
   * args on tap/scroll override when the session has no frame yet.
   */
  getActuationTarget?: (chatId: string) => SimulatorActuationTarget | null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown, limit = 4_096): string | undefined {
  return typeof value === 'string' && value.trim() && value.trim().length <= limit
    ? value.trim()
    : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function jsonResult(
  value: Record<string, unknown>,
  extraContent: McpToolContentBlock[] = []
): McpToolExecutionResult {
  const text = JSON.stringify(value)
  return { text, structuredContent: value, content: [{ type: 'text', text }, ...extraContent] }
}

function fail(tool: SimulatorMcpToolName, message: string): McpToolExecutionResult {
  const value = { ok: false, tool, error: message }
  const text = JSON.stringify(value)
  return { text, isError: true, structuredContent: value, content: [{ type: 'text', text }] }
}

function actionResult(
  tool: SimulatorMcpToolName,
  result: SimulatorHostActionResult,
  extraContent: McpToolContentBlock[] = []
): McpToolExecutionResult {
  if (!result.ok) {
    return fail(tool, result.error || `${tool} failed.`)
  }
  const { frame: _frame, ok: _ok, ...safe } = result
  return jsonResult({ ok: true, tool, ...safe }, extraContent)
}

function requireRunController(
  toolName: SimulatorMcpToolName,
  context: SimulatorToolContext,
  lease: Pick<SimulatorControllerLease, 'mint'>
):
  | { ok: true; control: { chatId: string; controllerTokenId: string } }
  | { ok: false; result: McpToolExecutionResult } {
  const chatId = stringValue(context.appChatId, 256)
  const runId = stringValue(context.appRunId, 256)
  if (!chatId || !runId) {
    return {
      ok: false,
      result: fail(
        toolName,
        'Simulator mutating tools require an active run context (chatId + runId).'
      )
    }
  }
  const minted = lease.mint({
    chatId,
    runId,
    ownerParticipantId:
      stringValue(context.participantId, 256) ||
      stringValue(context.ensembleRun?.participantId, 256)
  })
  if (!minted.ok) {
    return {
      ok: false,
      result: fail(toolName, minted.error)
    }
  }
  return {
    ok: true,
    control: { chatId, controllerTokenId: minted.token.tokenId }
  }
}

function requireIdb(
  toolName: SimulatorMcpToolName,
  idb: Pick<IdbClient, 'isAvailable'>
): McpToolExecutionResult | null {
  if (idb.isAvailable()) return null
  return fail(
    toolName,
    'idb is not available on PATH. Install idb-companion and fb-idb first (see ADVANCED_OPTIONAL_SETUP).'
  )
}

function resolveAgentPointExtents(
  toolName: SimulatorMcpToolName,
  args: Record<string, unknown>,
  chatId: string,
  getActuationTarget: ((chatId: string) => SimulatorActuationTarget | null) | undefined
):
  | { ok: true; pointWidth: number; pointHeight: number }
  | { ok: false; result: McpToolExecutionResult } {
  const argW = positiveNumber(args.width) ?? positiveNumber(args.pointWidth)
  const argH = positiveNumber(args.height) ?? positiveNumber(args.pointHeight)
  if (argW && argH) {
    return { ok: true, pointWidth: Math.round(argW), pointHeight: Math.round(argH) }
  }
  const target = getActuationTarget?.(chatId) ?? null
  const pointWidth =
    target && typeof target.pointWidth === 'number' && target.pointWidth > 0
      ? target.pointWidth
      : target && typeof target.width === 'number' && target.width > 0
        ? target.width
        : undefined
  const pointHeight =
    target && typeof target.pointHeight === 'number' && target.pointHeight > 0
      ? target.pointHeight
      : target && typeof target.height === 'number' && target.height > 0
        ? target.height
        : undefined
  if (pointWidth && pointHeight) {
    return { ok: true, pointWidth: Math.round(pointWidth), pointHeight: Math.round(pointHeight) }
  }
  return {
    ok: false,
    result: fail(
      toolName,
      'Point size required: take a simulator_screenshot first, or pass width/height (device points).'
    )
  }
}

/**
 * Factory so this dispatch stays independently testable without Electron.
 * Prefer SimulatorHostControl so mutating verbs enforce the controller lease.
 */
export function createSimulatorToolExecutors(
  deps: SimulatorToolExecutorDeps
): SimulatorToolExecutors {
  const { hostControl, controllerLease, idb, getActuationTarget } = deps
  return {
    async executeSimulatorTool(toolName, rawArgs, context, _parentProvider) {
      const args = asRecord(rawArgs)
      try {
        if (toolName === 'simulator_status') {
          const status = await hostControl.status()
          return jsonResult({ ok: true, tool: toolName, status })
        }

        let control: { chatId: string; controllerTokenId: string } | undefined
        if (SIMULATOR_MUTATING_TOOLS.has(toolName)) {
          const gated = requireRunController(toolName, context, controllerLease)
          if (!gated.ok) return gated.result
          control = gated.control
        }

        if (toolName === 'simulator_open') {
          return actionResult(toolName, await hostControl.openSimulatorApp(control!))
        }

        const udid = stringValue(args.udid, 128)
        if (!udid) return fail(toolName, '`udid` is required.')

        if (toolName === 'simulator_boot') {
          return actionResult(toolName, await hostControl.boot(udid, control!))
        }
        if (toolName === 'simulator_install') {
          const appPath = stringValue(args.appPath, 4_096)
          if (!appPath) return fail(toolName, '`appPath` is required.')
          return actionResult(toolName, await hostControl.install(udid, appPath, control!))
        }
        if (toolName === 'simulator_launch') {
          const bundleId = stringValue(args.bundleId, 256)
          if (!bundleId) return fail(toolName, '`bundleId` is required.')
          return actionResult(toolName, await hostControl.launch(udid, bundleId, control!))
        }
        if (toolName === 'simulator_terminate') {
          const bundleId = stringValue(args.bundleId, 256)
          return actionResult(toolName, await hostControl.terminate(udid, bundleId, control!))
        }

        if (toolName === 'simulator_inspect') {
          const missing = requireIdb(toolName, idb)
          if (missing) return missing
          const described = await idb.describeAll(udid)
          if (!described.ok) {
            return fail(toolName, described.error || 'simulator_inspect failed.')
          }
          return jsonResult({
            ok: true,
            tool: toolName,
            udid,
            tree: described.tree,
            truncated: Boolean(described.truncated)
          })
        }

        if (toolName === 'simulator_button') {
          const missing = requireIdb(toolName, idb)
          if (missing) return missing
          const button = args.button
          if (!isSimulatorHardwareButton(button)) {
            return fail(
              toolName,
              '`button` must be one of APPLE_PAY|HOME|LOCK|SIDE_BUTTON|SIRI.'
            )
          }
          const pressed = await idb.hardwareButton(udid, button)
          if (!pressed.ok) {
            return fail(toolName, pressed.error || 'simulator_button failed.')
          }
          return jsonResult({ ok: true, tool: toolName, udid, button })
        }

        if (toolName === 'simulator_rotate') {
          const missing = requireIdb(toolName, idb)
          if (missing) return missing
          const direction = args.direction
          if (!isSimulatorRotateDirection(direction)) {
            return fail(
              toolName,
              '`direction` must be PORTRAIT|PORTRAIT_UPSIDE_DOWN|LANDSCAPE_LEFT|LANDSCAPE_RIGHT.'
            )
          }
          const rotated = await idb.rotate(udid, direction)
          if (!rotated.ok) {
            return fail(toolName, rotated.error || 'simulator_rotate failed.')
          }
          return jsonResult({ ok: true, tool: toolName, udid, direction })
        }

        if (toolName === 'simulator_tap') {
          const missing = requireIdb(toolName, idb)
          if (missing) return missing
          const xNorm = finiteNumber(args.x)
          const yNorm = finiteNumber(args.y)
          if (xNorm === undefined || yNorm === undefined) {
            return fail(toolName, '`x` and `y` are required (normalized 0..1 bezel space).')
          }
          const extents = resolveAgentPointExtents(
            toolName,
            args,
            control!.chatId,
            getActuationTarget
          )
          if (!extents.ok) return extents.result
          const point = mapNormalizedTap(clamp01(xNorm), clamp01(yNorm), extents)
          const tapped = await idb.tap(udid, point.x, point.y)
          if (!tapped.ok) {
            return fail(toolName, tapped.error || 'simulator_tap failed.')
          }
          return jsonResult({
            ok: true,
            tool: toolName,
            udid,
            x: point.x,
            y: point.y,
            pointWidth: extents.pointWidth,
            pointHeight: extents.pointHeight
          })
        }

        if (toolName === 'simulator_type') {
          const missing = requireIdb(toolName, idb)
          if (missing) return missing
          if (typeof args.text !== 'string') {
            return fail(toolName, '`text` is required.')
          }
          const typed = await idb.text(udid, args.text)
          if (!typed.ok) {
            return fail(toolName, typed.error || 'simulator_type failed.')
          }
          return jsonResult({ ok: true, tool: toolName, udid, length: args.text.length })
        }

        if (toolName === 'simulator_scroll') {
          const missing = requireIdb(toolName, idb)
          if (missing) return missing
          const xNorm = finiteNumber(args.x)
          const yNorm = finiteNumber(args.y)
          const deltaX = finiteNumber(args.deltaX)
          const deltaY = finiteNumber(args.deltaY)
          if (
            xNorm === undefined ||
            yNorm === undefined ||
            deltaX === undefined ||
            deltaY === undefined
          ) {
            return fail(
              toolName,
              '`x`, `y`, `deltaX`, and `deltaY` are required (x/y normalized 0..1; deltas in device points).'
            )
          }
          const extents = resolveAgentPointExtents(
            toolName,
            args,
            control!.chatId,
            getActuationTarget
          )
          if (!extents.ok) return extents.result
          // Agent deltas are already point-space — omit pixel dims so no rescale.
          const swipe = mapNormalizedScroll(clamp01(xNorm), clamp01(yNorm), deltaX, deltaY, {
            pointWidth: extents.pointWidth,
            pointHeight: extents.pointHeight
          })
          const swiped = await idb.swipe(
            udid,
            swipe.startX,
            swipe.startY,
            swipe.endX,
            swipe.endY
          )
          if (!swiped.ok) {
            return fail(toolName, swiped.error || 'simulator_scroll failed.')
          }
          return jsonResult({
            ok: true,
            tool: toolName,
            udid,
            ...swipe,
            pointWidth: extents.pointWidth,
            pointHeight: extents.pointHeight
          })
        }

        if (toolName === 'simulator_screenshot') {
          const chatId = stringValue(context.appChatId, 256)
          const shot = await hostControl.screenshot(udid, chatId ? { chatId } : undefined)
          if (!shot.ok || !shot.frame) {
            return fail(toolName, shot.error || 'Screenshot failed.')
          }
          const { pngBase64, width, height, capturedAt, udid: frameUdid } = shot.frame
          return jsonResult(
            {
              ok: true,
              tool: toolName,
              udid: frameUdid,
              mimeType: 'image/png',
              width,
              height,
              capturedAt
            },
            [{ type: 'image', mimeType: 'image/png', data: pngBase64 }]
          )
        }

        return fail(toolName, `Unhandled simulator tool: ${toolName}`)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Simulator Canvas operation failed.'
        return fail(toolName, message)
      }
    }
  }
}
