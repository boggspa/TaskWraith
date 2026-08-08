/** Provider-neutral semantic MCP executor for the Simulator Canvas host. */
import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import {
  SIMULATOR_MCP_TOOL_NAMES,
  type SimulatorMcpToolName
} from '../../shared/taskWraithMcpCatalog'
import type { SimulatorHostControl } from '../simulator/SimulatorHostControl'
import type { SimulatorControllerLease } from '../simulator/SimulatorControllerLease'
import type { SimulatorHostActionResult } from '../../shared/simulatorCanvas'

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
  'simulator_terminate'
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

/**
 * Factory so this dispatch stays independently testable without Electron.
 * Prefer SimulatorHostControl so mutating verbs enforce the controller lease.
 */
export function createSimulatorToolExecutors(
  deps: SimulatorToolExecutorDeps
): SimulatorToolExecutors {
  const { hostControl, controllerLease } = deps
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

        // simulator_screenshot — chat-readable; no controller required.
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
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Simulator Canvas operation failed.'
        return fail(toolName, message)
      }
    }
  }
}
