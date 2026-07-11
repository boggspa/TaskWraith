import { isCursorGrok45ModelId, isGrok45ReasoningModelId } from '../../shared/grok45Models'
import type { ProviderId } from '../store/types'
import type { TaskWraithMcpToolName } from '../TaskWraithMcpTools'

/**
 * Cursor's Grok 4.5 catalogue currently rejects large MCP surfaces before a
 * turn starts. Keep TaskWraith below the observed ~80-tool ceiling while
 * reserving room for Cursor/global MCP tools and the three audit-role tools.
 *
 * This is deliberately a named profile rather than `slice(0, N)`: additions to
 * the full catalog cannot silently change which capabilities constrained models
 * receive. Remove the model routing (not this safety boundary) when Cursor lifts
 * the provider limit.
 */
export const CORE_MCP_TOOL_BUDGET = 60

/**
 * General coding + TaskWraith orchestration surface for tool-constrained models.
 * Specialized Canvas, attached-window, creative-app, media, and introspection
 * families stay on the full profile used by models without the catalogue cap.
 */
export const CORE_MCP_ADVERTISE_TOOLS = [
  // Read and navigation.
  'read_file',
  'list_directory',
  'find_files',
  'workspace_search',
  'workspace_symbols',
  'list_chat_attachments',
  'inspect_chat_attachment',
  // Repository and web reads.
  'git_status',
  'git_diff',
  'web_search',
  'web_fetch',
  // Workspace edits.
  'write_file',
  'replace',
  'apply_patch',
  'create_directory',
  'move_path',
  'delete_path',
  // Run and verify.
  'run_shell_command',
  'run_task',
  'get_diagnostics',
  'test_result_summary',
  'start_background_process',
  'list_background_processes',
  'read_background_process',
  'kill_background_process',
  // Publish.
  'git_stage',
  'git_commit',
  'git_push',
  'git_create_pr',
  // Web-app debugging.
  'browser_open',
  'browser_click',
  'browser_screenshot',
  'browser_console',
  // Run and account status.
  'list_active_runs',
  'approval_status',
  // Task UX. update_goal is the exact alias required by Grok's native /goal.
  'ask_user_question',
  'todo_write',
  'goal_read',
  'update_goal',
  'goal_complete',
  'goal_blocked',
  // Sub-threads.
  'delegate_to_subthread',
  'list_subthreads',
  'read_subthread_result',
  'cancel_subthread',
  // Ensemble coordination.
  'ensemble_yield',
  'ensemble_send',
  'ensemble_fanout',
  'ensemble_bossman_control',
  'ensemble_poll_response',
  'ensemble_roster_edit',
  'ensemble_brief_update',
  'schedule_wakeup',
  'cancel_wakeup',
  'list_ensemble_participants',
  'ensemble_continue',
  'scout_brief',
  'blackboard_post',
  'blackboard_read',
  'blackboard_delete'
] as const satisfies readonly TaskWraithMcpToolName[]

const CORE_MCP_TOOL_SET: ReadonlySet<string> = new Set(CORE_MCP_ADVERTISE_TOOLS)

export function isCoreMcpAdvertisedTool(name: string): boolean {
  return CORE_MCP_TOOL_SET.has(name)
}

/** Keep the workaround model-aware so Cursor Composer 2.5 retains the full MCP surface. */
export function shouldUseCoreMcpProfile(
  provider: ProviderId,
  modelId: string | null | undefined
): boolean {
  if (provider === 'cursor') return isCursorGrok45ModelId(modelId)
  if (provider === 'grok') {
    if (!String(modelId || '').trim()) return true
    return isGrok45ReasoningModelId(modelId) || isCursorGrok45ModelId(modelId)
  }
  return false
}
