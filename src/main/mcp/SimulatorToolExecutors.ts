/** Provider-neutral semantic MCP executor for the Simulator Canvas host. */
import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import {
  SIMULATOR_MCP_TOOL_NAMES,
  type SimulatorMcpToolName
} from '../../shared/taskWraithMcpCatalog'
import type { SimulatorHostService } from '../simulator/SimulatorHostService'
import type { SimulatorHostActionResult } from '../../shared/simulatorCanvas'

/** Main-side alias retained for MCP dispatch callers. The shared catalogue owns membership. */
export const SIMULATOR_MCP_TOOL_NAMES_MAIN = SIMULATOR_MCP_TOOL_NAMES
export { SIMULATOR_MCP_TOOL_NAMES }

export type { SimulatorMcpToolName }

const SIMULATOR_TOOL_NAME_SET: ReadonlySet<string> = new Set(SIMULATOR_MCP_TOOL_NAMES)

export function isSimulatorMcpToolName(value: string): value is SimulatorMcpToolName {
  return SIMULATOR_TOOL_NAME_SET.has(value)
}

export interface SimulatorToolExecutors {
  executeSimulatorTool: (
    toolName: SimulatorMcpToolName,
    rawArgs: unknown,
    context: { appChatId?: string; appRunId?: string },
    parentProvider: string
  ) => Promise<McpToolExecutionResult>
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
  const { frame: _frame, ...safe } = result
  return jsonResult({ ok: true, tool, ...safe }, extraContent)
}

/** Factory so this dispatch stays independently testable without Electron. */
export function createSimulatorToolExecutors(host: SimulatorHostService): SimulatorToolExecutors {
  return {
    async executeSimulatorTool(toolName, rawArgs, _context, _parentProvider) {
      const args = asRecord(rawArgs)
      try {
        if (toolName === 'simulator_status') {
          const status = await host.status()
          return jsonResult({ ok: true, tool: toolName, status })
        }
        if (toolName === 'simulator_open') {
          return actionResult(toolName, await host.openSimulatorApp())
        }
        const udid = stringValue(args.udid, 128)
        if (!udid) return fail(toolName, '`udid` is required.')
        if (toolName === 'simulator_boot') {
          return actionResult(toolName, await host.boot(udid))
        }
        if (toolName === 'simulator_install') {
          const appPath = stringValue(args.appPath, 4_096)
          if (!appPath) return fail(toolName, '`appPath` is required.')
          return actionResult(toolName, await host.install(udid, appPath))
        }
        if (toolName === 'simulator_launch') {
          const bundleId = stringValue(args.bundleId, 256)
          if (!bundleId) return fail(toolName, '`bundleId` is required.')
          return actionResult(toolName, await host.launch(udid, bundleId))
        }
        if (toolName === 'simulator_terminate') {
          const bundleId = stringValue(args.bundleId, 256)
          return actionResult(toolName, await host.terminate(udid, bundleId))
        }
        // simulator_screenshot
        const shot = await host.screenshot(udid)
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
