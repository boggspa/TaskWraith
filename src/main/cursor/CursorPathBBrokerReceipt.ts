import { CURSOR_MCP_SERVER_NAME } from './CursorMcpBridge'
import { taskWraithMcpAdvertisedToolNamesForProfile } from '../mcp/McpToolProfiles'
import type { TaskWraithMcpProfileId } from '../store/types'

/**
 * Tools a Path-B Cursor seat is most likely to reach for. The receipt only
 * names members that this seat's allow-rules and MCP profile actually attach.
 */
export const CURSOR_PATH_B_RECEIPT_PRIORITY_TOOLS = [
  'capability_search',
  'capability_invoke',
  'apply_patch',
  'replace',
  'write_file',
  'run_shell_command',
  'git_status',
  'git_diff',
  'git_stage',
  'git_commit',
  'ask_user_question',
  'ensemble_fanout',
  'ensemble_await',
  'ensemble_yield',
  'ensemble_lane_result',
  'delegate_wave',
  'delegate_to_subthread',
  'ultra_task'
] as const

export function cursorPathBAllowRulesPermitTool(
  allowRules: readonly string[],
  toolName: string
): boolean {
  if (allowRules.includes(`Mcp(${CURSOR_MCP_SERVER_NAME}:*)`)) return true
  return (
    allowRules.includes(`Mcp(${CURSOR_MCP_SERVER_NAME}:${toolName})`) ||
    allowRules.includes(`Mcp(${CURSOR_MCP_SERVER_NAME}-${toolName})`)
  )
}

export function listCursorPathBReceiptTools(input: {
  readonly allowRules: readonly string[]
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
}): readonly string[] {
  const advertised = input.taskWraithMcpProfileId
    ? new Set(taskWraithMcpAdvertisedToolNamesForProfile(input.taskWraithMcpProfileId))
    : null
  return CURSOR_PATH_B_RECEIPT_PRIORITY_TOOLS.filter((toolName) => {
    if (!cursorPathBAllowRulesPermitTool(input.allowRules, toolName)) return false
    if (advertised && !advertised.has(toolName)) return false
    return true
  })
}

export function buildCursorPathBBrokerReceipt(input: {
  readonly listedTools: readonly string[]
}): string {
  const listed =
    input.listedTools.length > 0
      ? input.listedTools.map((toolName) => `\`${toolName}\``).join(', ')
      : 'none beyond what GetMcpTools returns'
  return [
    `TaskWraith Cursor broker receipt: the managed tools are ready under the exact Cursor MCP server id \`${CURSOR_MCP_SERVER_NAME}\`.`,
    `Call GetMcpTools with server \`${CURSOR_MCP_SERVER_NAME}\` before concluding that TaskWraith tools are absent.`,
    'Do not use GetDynamicTools or CallDynamicTool, and do not probe a `taskwraith` or `agbench` namespace — those are Cursor IDE or user-owned servers, not this Path-B broker.',
    `Workspace \`.cursor/mcp.json\` is emptied on purpose during the run; the broker lives in the global Cursor MCP registry.`,
    `This seat's listed TaskWraith tools include: ${listed}. Invoke them as MCP tools on \`${CURSOR_MCP_SERVER_NAME}\` (prompt alias \`taskwraith__<tool>\`).`,
    'If a name is absent from GetMcpTools, do not search the repo catalogue; continue with native sandbox tools or an unambiguous @Role/@Model mention.',
    'Brokered file, shell, and git calls appear in the TaskWraith transcript as ordinary tool-call rows (the same ActivityStack cards as other providers), not a separate presentation element.'
  ].join(' ')
}

export function buildCursorPathBActiveBrokerPrompt(
  prompt: string,
  policy: { readonly allowRules: readonly string[] },
  taskWraithMcpProfileId: TaskWraithMcpProfileId | null
): string {
  const listedTools = listCursorPathBReceiptTools({
    allowRules: policy.allowRules,
    taskWraithMcpProfileId
  })
  return `${prompt}\n\n${buildCursorPathBBrokerReceipt({ listedTools })}`
}
