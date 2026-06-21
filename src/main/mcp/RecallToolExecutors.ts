/**
 * MCP executor for the exclusive `tw_recall_*` cross-thread retrospection tool
 * family.
 *
 * `tw_recall_find` resolves a deliberately-vague {provider, workspace, time,
 * task} reference to a ranked, bounded set of past runs; `tw_recall_read` /
 * `tw_recall_read_events` read how far a chosen run got (timeline rollup, final
 * message, plan progress / raw bodies). All three are READ-ONLY.
 *
 * Cross-workspace reads are gated by the `crossThreadRead` approval service
 * (wired in the host, Slice 3); the caller's own workspace is auto-allowed.
 * Like the canvas executor this is a factory over injected deps so it stays
 * unit-testable with no Electron.
 *
 * Slice 1 registers the family INERT — the tools are advertised and dispatched
 * here but every verb returns `not_implemented`. Slice 2 fills in
 * `tw_recall_find`; Slice 4 fills in the read verbs.
 */
import type { McpToolExecutionResult } from './McpBridgeRuntime'

export const RECALL_MCP_TOOL_NAMES = [
  'tw_recall_find',
  'tw_recall_read',
  'tw_recall_read_events'
] as const

export type RecallMcpToolName = (typeof RECALL_MCP_TOOL_NAMES)[number]

const RECALL_TOOL_NAME_SET: ReadonlySet<string> = new Set(RECALL_MCP_TOOL_NAMES)

export function isRecallMcpToolName(name: string): name is RecallMcpToolName {
  return RECALL_TOOL_NAME_SET.has(name)
}

/** Narrow context the executor needs; GeminiToolContext is structurally assignable. */
export interface RecallToolContext {
  appChatId?: string
  appRunId?: string
  workspacePath?: string
  workspaceId?: string
}

export interface RecallToolExecutors {
  executeRecallTool: (
    toolName: RecallMcpToolName,
    rawArgs: unknown,
    context: RecallToolContext,
    parentProvider: string
  ) => Promise<McpToolExecutionResult>
}

function fail(toolName: string, message: string): McpToolExecutionResult {
  const value = { ok: false, tool: toolName, error: message }
  const text = JSON.stringify(value)
  return { text, isError: true, structuredContent: value, content: [{ type: 'text', text }] }
}

export function createRecallToolExecutors(): RecallToolExecutors {
  async function executeRecallTool(
    toolName: RecallMcpToolName,
    _rawArgs: unknown,
    _context: RecallToolContext,
    _parentProvider: string
  ): Promise<McpToolExecutionResult> {
    switch (toolName) {
      case 'tw_recall_find':
      case 'tw_recall_read':
      case 'tw_recall_read_events':
        return fail(
          toolName,
          `${toolName} is not implemented yet — cross-thread recall is rolling out in slices.`
        )
      default:
        return fail(toolName, `Unknown recall tool "${toolName}".`)
    }
  }

  return { executeRecallTool }
}
