import { isCursorGrok45ModelId, isGrok45ReasoningModelId } from '../../shared/grok45Models'
import type { ProviderId } from '../store/types'
import type { TaskWraithMcpProfileId } from '../store/types'
import type { TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import {
  CAPABILITY_GATEWAY_TOOL_NAMES,
  type CapabilityGatewayToolName
} from './McpToolGateway'

export { CAPABILITY_GATEWAY_TOOL_NAMES } from './McpToolGateway'
export type { CapabilityGatewayToolName } from './McpToolGateway'
export type TaskWraithMcpAdvertisedToolName =
  | TaskWraithMcpToolName
  | CapabilityGatewayToolName

/**
 * Immutable membership snapshot for `taskwraith-full-v1`.
 *
 * Do not derive this from `TASKWRAITH_MCP_TOOLS`: adding a future canonical
 * tool must not mutate the surface already observed by receipted v1 sessions.
 * Retain implementations for these names until the last v1 receipt can no
 * longer resume; use a new profile id for any membership change.
 */
export const FULL_MCP_ADVERTISE_TOOLS = Object.freeze([
  'run_shell_command',
  'write_file',
  'replace',
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path',
  'read_file',
  'list_directory',
  'find_files',
  'workspace_search',
  'web_search',
  'web_fetch',
  'apply_patch',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_blame',
  'git_stage',
  'git_commit',
  'git_push',
  'git_create_pr',
  'github_ci_status',
  'run_task',
  'start_background_process',
  'list_background_processes',
  'read_background_process',
  'kill_background_process',
  'get_diagnostics',
  'list_active_runs',
  'cancel_active_run',
  'list_chat_attachments',
  'inspect_chat_attachment',
  'workspace_board_snapshot',
  'workspace_board_preview_plan',
  'workspace_board_apply_plan',
  'test_result_summary',
  'prompt_task_normalize',
  'scope_radar',
  'repo_convention_scan',
  'coherence_gate_check',
  'evidence_pack_write',
  'completion_claim_check',
  'list_subthreads',
  'read_subthread_result',
  'cancel_subthread',
  'workspace_symbols',
  'browser_open',
  'browser_click',
  'browser_screenshot',
  'browser_console',
  'attached_window_capture',
  'attached_window_status',
  'appwatch_start',
  'appwatch_stop',
  'appwatch_status',
  'appwatch_latest_frame',
  'appwatch_frames',
  'approval_status',
  'provider_auth_status',
  'provider_usage_status',
  'run_timeline',
  'raw_provider_events',
  'open_workspace_file',
  'creative_app_status',
  'creative_app_capabilities',
  'creative_project_snapshot',
  'creative_timeline_validate',
  'creative_timeline_ir',
  'creative_timeline_diff',
  'creative_timeline_import',
  'creative_applescript_dispatch',
  'creative_blender_python',
  'creative_midi_dispatch',
  'open_in_ide',
  'open_in_ide_at_position',
  'reveal_in_finder',
  'ide_app_status',
  'ide_app_capabilities',
  'list_running_ides',
  'create_handoff_card',
  'switch_auth_profile',
  'agent_delegation_role',
  'ensemble_yield',
  'ensemble_send',
  'ensemble_fanout',
  'ensemble_bossman_control',
  'ensemble_poll_response',
  'ensemble_roster_edit',
  'ensemble_brief_update',
  'list_ensemble_participants',
  'schedule_wakeup',
  'cancel_wakeup',
  'ask_user_question',
  'goal_read',
  'goal_update',
  'update_goal',
  'goal_complete',
  'goal_blocked',
  'todo_write',
  'delegate_to_subthread',
  'ensemble_continue',
  'scout_brief',
  'blackboard_post',
  'blackboard_read',
  'blackboard_delete',
  'launch_list_targets',
  'launch_start',
  'launch_stop',
  'launch_status',
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
  'canvas_close',
  'tw_recall_find',
  'tw_recall_read',
  'tw_recall_read_events',
  'tw_introspection_run',
  'tw_introspection_list',
  'tw_introspection_read',
  'tw_introspection_review',
  'image_edit',
  'svg_rasterize',
  'image_generate',
  'audio_render_wav',
  'audio_analyze',
  'inspect_audio_segment',
  'video_probe',
  'video_thumbnail',
  'video_decode_frame',
  'inspect_video_frames',
  'video_encode_clip',
  'video_concat_clips',
  'audio_extract',
  'transcode_audio',
  'audio_mix',
  'transcribe_audio',
  'transcode_video'
] as const satisfies readonly TaskWraithMcpToolName[])

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
export const CORE_MCP_ADVERTISE_TOOLS = Object.freeze([
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
] as const satisfies readonly TaskWraithMcpToolName[])

const CORE_MCP_TOOL_SET: ReadonlySet<string> = new Set(CORE_MCP_ADVERTISE_TOOLS)

export function isCoreMcpAdvertisedTool(name: string): boolean {
  return CORE_MCP_TOOL_SET.has(name)
}

/**
 * Stable, common direct surface for `taskwraith-gateway-v1`.
 *
 * Less frequent capabilities remain executable through capability_search +
 * capability_invoke. Keep this membership literal: changing it requires a new
 * profile id so a native provider session never sees tools appear or disappear
 * while its receipt is resumable.
 */
export const GATEWAY_MCP_DIRECT_TOOLS = Object.freeze([
  // Workspace reads and navigation.
  'read_file',
  'list_directory',
  'find_files',
  'workspace_search',
  'workspace_symbols',
  // Workspace edits.
  'write_file',
  'replace',
  'apply_patch',
  'create_directory',
  'move_path',
  'delete_path',
  // Run, verify, and commit.
  'run_shell_command',
  'run_task',
  'git_status',
  'git_diff',
  'git_stage',
  'git_commit',
  // User decisions and durable task state.
  'ask_user_question',
  'todo_write',
  'goal_read',
  'update_goal',
  'goal_complete',
  'goal_blocked',
  // Cross-provider delegation.
  'delegate_to_subthread',
  // Long-horizon ensemble coordination.
  'ensemble_yield',
  'ensemble_send',
  'ensemble_fanout',
  'ensemble_bossman_control',
  'ensemble_poll_response',
  'ensemble_roster_edit',
  'ensemble_brief_update',
  'list_ensemble_participants',
  'schedule_wakeup',
  'cancel_wakeup',
  'ensemble_continue',
  'blackboard_post',
  'blackboard_read',
  'blackboard_delete'
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

const GATEWAY_MCP_TOOL_SET: ReadonlySet<string> = new Set(GATEWAY_MCP_ADVERTISE_TOOLS)

export function isGatewayMcpAdvertisedTool(name: string): boolean {
  return GATEWAY_MCP_TOOL_SET.has(name)
}

/** Exact immutable membership for each receiptable profile id. */
export function taskWraithMcpAdvertisedToolNamesForProfile(
  profileId: TaskWraithMcpProfileId
): readonly TaskWraithMcpAdvertisedToolName[] {
  if (profileId === 'taskwraith-gateway-v1') return GATEWAY_MCP_ADVERTISE_TOOLS
  if (profileId === 'taskwraith-core-v1') return CORE_MCP_ADVERTISE_TOOLS
  return FULL_MCP_ADVERTISE_TOOLS
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
