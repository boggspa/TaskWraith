import { isCursorGrokModelId, isGrokReasoningModelId } from '../../shared/grok45Models'
import type { ProviderId } from '../store/types'
import type { TaskWraithMcpProfileId } from '../store/types'
import {
  MESH_SCENE_MCP_TOOL_NAMES,
  MESH_TOPOLOGY_MCP_TOOL_NAMES,
  SIMULATOR_MCP_TOOL_NAMES,
  type TaskWraithMcpToolName
} from '../TaskWraithMcpTools'
import { CAPABILITY_GATEWAY_TOOL_NAMES, type CapabilityGatewayToolName } from './McpToolGateway'

export { CAPABILITY_GATEWAY_TOOL_NAMES } from './McpToolGateway'
export type { CapabilityGatewayToolName } from './McpToolGateway'
export type TaskWraithMcpAdvertisedToolName = TaskWraithMcpToolName | CapabilityGatewayToolName

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
  'appshots',
  'appshots_status',
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
  'ensemble_propose_goal_complete',
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
  'scout_brief',
  'blackboard_post',
  'blackboard_read',
  'blackboard_delete',
  'launch_list_targets',
  'launch_start',
  'launch_adopt',
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
  'theme_tokens_get',
  'theme_tokens_set',
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
 * Immutable membership snapshot for `taskwraith-full-v2`.
 *
 * v2 replaces the legacy wide `ensemble_bossman_control` declaration with the
 * compact `ensemble_control` front door. Execution still reaches the exact
 * same legacy authority handler after transport normalization.
 */
export const FULL_V2_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...FULL_MCP_ADVERTISE_TOOLS.filter((tool) => tool !== 'ensemble_bossman_control'),
  'ensemble_control'
] as const satisfies readonly TaskWraithMcpToolName[])

/**
 * Grok reasoning and Cursor-hosted Grok catalogues reject large MCP surfaces
 * before a turn starts. Managed runs therefore use this named core profile for
 * those constrained models when the governed broker attaches; compatible
 * constrained-model routes and historical pinned receipts use the same stable
 * definition.
 *
 * This is deliberately a named profile rather than `slice(0, N)`: additions to
 * the full catalog cannot silently change which capabilities constrained live
 * models receive. Historical Cursor profile receipts remain decodable without
 * changing the live profile.
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
  'scout_brief',
  'blackboard_post',
  'blackboard_read',
  'blackboard_delete'
] as const satisfies readonly TaskWraithMcpToolName[])

/** Immutable successor to core-v1 with the portable Ensemble control shape. */
export const CORE_V2_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...CORE_MCP_ADVERTISE_TOOLS.filter((tool) => tool !== 'ensemble_bossman_control'),
  'ensemble_control'
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
  'ensemble_propose_goal_complete',
  'ensemble_roster_edit',
  'ensemble_brief_update',
  'list_ensemble_participants',
  'schedule_wakeup',
  'cancel_wakeup',
  'blackboard_post',
  'blackboard_read',
  'blackboard_delete'
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

/**
 * Gateway-v6 keeps the same size as v1 while replacing the overloaded legacy
 * Bossman declaration with its compact portable front door. Earlier gateway
 * arrays remain frozen because native provider sessions can resume with their
 * original catalogue receipt.
 */
export const GATEWAY_V6_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_MCP_DIRECT_TOOLS.filter((tool) => tool !== 'ensemble_bossman_control'),
  'ensemble_control'
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V6_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V6_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

/**
 * Gateway-v7 makes the Mesh Canvas family discoverable without enlarging the
 * normal direct catalogue. The explicit tool list is a new immutable
 * membership snapshot: a provider-native session receipted before v7 cannot
 * discover a tool that it did not observe at birth.
 */
export const GATEWAY_V7_ADDED_TOOL_NAMES = Object.freeze([
  ...MESH_SCENE_MCP_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V7_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V6_MCP_DIRECT_TOOLS
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V7_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V7_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

/**
 * A separate immutable v7 birth catalogue for a participant whose CURRENT
 * signed run posture does not deny Mesh Canvas. This only changes discovery:
 * promptable Accept Edits runs receive the direct surface, while every mesh
 * call remains checked against that current participant/run posture at
 * dispatch. A persisted provider-session receipt is compatibility evidence,
 * never a permission grant.
 */
export const GATEWAY_V7_MESH_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V7_MCP_DIRECT_TOOLS,
  ...GATEWAY_V7_ADDED_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V7_MESH_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V7_MESH_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

/**
 * Gateway-v8 promotes Sketch Canvas to a first-class direct surface for every
 * fresh seat. The separate bridge flag preserves v1-v7 receipts exactly:
 * older sessions keep Sketch behind capability discovery, while v8 births see
 * open/get/update without a search round-trip. Per-call permission still comes
 * from the active run posture.
 */
export const GATEWAY_V8_ADDED_TOOL_NAMES = Object.freeze([
  'canvas_sketch_open',
  'canvas_sketch_get',
  'canvas_sketch_update'
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V8_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V7_MCP_DIRECT_TOOLS,
  ...GATEWAY_V8_ADDED_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V8_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V8_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

export const GATEWAY_V8_MESH_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V8_MCP_DIRECT_TOOLS,
  ...GATEWAY_V7_ADDED_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V8_MESH_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V8_MESH_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

/**
 * Gateway-v9 makes exact one-shot permission retry discoverable. It stays
 * hidden because agents need it only after a permission-like failure; both
 * direct catalogues remain exact clones of their immutable v8 predecessors.
 */
export const GATEWAY_V9_ADDED_TOOL_NAMES = Object.freeze([
  'request_tool_permission'
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V9_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V8_MCP_DIRECT_TOOLS
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V9_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V9_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

export const GATEWAY_V9_MESH_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V8_MESH_MCP_DIRECT_TOOLS
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V9_MESH_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V9_MESH_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

/**
 * Gateway-v10 makes Canvas Browser navigation (canvas_navigate) discoverable
 * through capability search. It stays hidden rather than direct — browsing is
 * a specialist surface like the rest of the canvas family — and both direct
 * catalogues remain exact clones of their immutable v9 predecessors, so a
 * receipted pre-v10 session never sees a tool appear mid-session.
 */
export const GATEWAY_V10_ADDED_TOOL_NAMES = Object.freeze([
  'canvas_navigate'
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V10_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V9_MCP_DIRECT_TOOLS
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V10_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V10_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

export const GATEWAY_V10_MESH_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V9_MESH_MCP_DIRECT_TOOLS
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V10_MESH_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V10_MESH_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

/**
 * Gateway-v11 makes the Simulator Canvas family discoverable without enlarging
 * the normal direct catalogue — same shape as Mesh on v7 and Outlook on v3.
 * Status stays auto-allowed at the approval gate; mutating verbs still require
 * the simulatorCanvas service. Direct catalogues remain exact clones of their
 * immutable v10 predecessors so a receipted pre-v11 session never sees a tool
 * appear mid-session. Not added to FULL_MCP_ADVERTISE_TOOLS: that v1 snapshot
 * stays frozen (Mesh followed the same rule).
 */
export const GATEWAY_V11_ADDED_TOOL_NAMES = Object.freeze([
  ...SIMULATOR_MCP_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V11_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V10_MCP_DIRECT_TOOLS
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V11_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V11_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

export const GATEWAY_V11_MESH_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V10_MESH_MCP_DIRECT_TOOLS
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V11_MESH_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V11_MESH_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

/**
 * Gateway-v12 makes `project_reference_list` discoverable without enlarging the
 * normal direct catalogue — same shape as Simulator on v11 / Outlook on v3.
 *
 * ADDED is intentionally ONLY `project_reference_list`. A concurrent Skills
 * worktree that later needs gateway surface growth must mint v13 (or later)
 * rather than appending into this frozen v12 ADDED set — keep this birth
 * catalogue clean so receipted v12 sessions never see mid-session drift.
 * Direct catalogues remain exact clones of their immutable v11 predecessors.
 */
export const GATEWAY_V12_ADDED_TOOL_NAMES = Object.freeze([
  'project_reference_list'
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V12_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V11_MCP_DIRECT_TOOLS
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V12_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V12_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

export const GATEWAY_V12_MESH_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V11_MESH_MCP_DIRECT_TOOLS
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V12_MESH_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V12_MESH_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

/**
 * Gateway-v13 promotes orchestration join/brief/wave tools to the fresh
 * DIRECT birth catalogue (v8 Sketch shape): ADDED grows DIRECT; HIDDEN is an
 * exact clone of v12 (no remove) so previously discoverable names stay
 * discoverable. `delegate_wave` is new to the catalogue and therefore only
 * appears on DIRECT for v13+ seats.
 *
 * Naive full-prose promotion breaches the 40k transport ceiling — see
 * GATEWAY_V13_COMPACT_TOOL_DESCRIPTIONS + compactGatewayV13ToolDefinitionsForTransport.
 */
export const GATEWAY_V13_ADDED_TOOL_NAMES = Object.freeze([
  'scout_brief',
  'ensemble_await',
  'ensemble_lane_result',
  'delegate_wave'
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V13_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V12_MCP_DIRECT_TOOLS,
  ...GATEWAY_V13_ADDED_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V13_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V13_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

export const GATEWAY_V13_MESH_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V12_MESH_MCP_DIRECT_TOOLS,
  ...GATEWAY_V13_ADDED_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V13_MESH_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V13_MESH_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

/**
 * Gateway-v14 makes TaskWraith-owned skills discoverable without enlarging the
 * normal direct catalogue. Direct catalogues remain exact clones of their
 * immutable v13 predecessors so a receipted pre-v14 session never sees a tool
 * appear mid-session. skill_list / skill_read must NOT land in frozen v12/v13.
 */
export const GATEWAY_V14_ADDED_TOOL_NAMES = Object.freeze([
  'skill_list',
  'skill_read'
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V14_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V13_MCP_DIRECT_TOOLS
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V14_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V14_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

export const GATEWAY_V14_MESH_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V13_MESH_MCP_DIRECT_TOOLS
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V14_MESH_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V14_MESH_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

/**
 * Gateway-v15 adds revisioned Mesh topology tools. Normal seats discover them
 * through capability_search; mesh-posture births receive the same three tools
 * directly. Frozen v7-v14 arrays continue to contain only the original scene
 * family.
 */
export const GATEWAY_V15_ADDED_TOOL_NAMES = Object.freeze([
  ...MESH_TOPOLOGY_MCP_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V15_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V14_MCP_DIRECT_TOOLS
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V15_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V15_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

export const GATEWAY_V15_MESH_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V14_MESH_MCP_DIRECT_TOOLS,
  ...GATEWAY_V15_ADDED_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V15_MESH_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V15_MESH_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

/**
 * Gateway-v16 makes `canvas_render_chart` discoverable through capability
 * search without enlarging the direct catalogue — same shape as
 * `canvas_navigate` on v10. Direct catalogues remain exact clones of their
 * immutable v15 predecessors so a receipted pre-v16 session never sees a tool
 * appear mid-session. Not added to FULL_MCP_ADVERTISE_TOOLS: that v1 snapshot
 * stays frozen.
 */
export const GATEWAY_V16_ADDED_TOOL_NAMES = Object.freeze([
  'canvas_render_chart'
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V16_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V15_MCP_DIRECT_TOOLS
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V16_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V16_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

export const GATEWAY_V16_MESH_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V15_MESH_MCP_DIRECT_TOOLS
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V16_MESH_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V16_MESH_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

/**
 * Gateway-v17 promotes the canonical existing-image viewer to the fresh direct
 * surface. Provider-native viewer spellings and screenshot producers still
 * execute under their exact names, but transcript activity coalesces them to
 * this same identity. Frozen v1-v16 memberships remain byte-for-byte stable.
 */
export const GATEWAY_V17_ADDED_TOOL_NAMES = Object.freeze([
  'image_view'
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V17_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V16_MCP_DIRECT_TOOLS,
  ...GATEWAY_V17_ADDED_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V17_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V17_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

export const GATEWAY_V17_MESH_MCP_DIRECT_TOOLS = Object.freeze([
  ...GATEWAY_V16_MESH_MCP_DIRECT_TOOLS,
  ...GATEWAY_V17_ADDED_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V17_MESH_MCP_ADVERTISE_TOOLS = Object.freeze([
  ...GATEWAY_V17_MESH_MCP_DIRECT_TOOLS,
  ...CAPABILITY_GATEWAY_TOOL_NAMES
] as const satisfies readonly TaskWraithMcpAdvertisedToolName[])

type GatewayV8MeshTransportToolDefinition = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/**
 * The combined Mesh + Sketch direct catalogue needs concise wire guidance to
 * remain below the 40k transport ceiling without demoting any established
 * direct tool. Long-form prose is replaced with bounded guidance: names, typed
 * schemas, required fields, enums, annotations, and tools/call behavior are
 * unchanged. Canonical definitions remain untouched for every other profile.
 */
const GATEWAY_V8_MESH_COMPACT_TOOL_DESCRIPTIONS = Object.freeze({
  mesh_scene_create: 'Create a chat-owned 3D scene. Gated; returns sceneId.',
  mesh_scene_list: 'List chat-owned 3D scenes. Read-only.',
  mesh_scene_inspect: "Read a scene's nodes, materials, camera, settings, and bindings.",
  mesh_scene_import: 'Import a workspace GLB/glTF/OBJ into a scene. Gated.',
  mesh_scene_apply:
    'Apply node/scene/fact/binding ops. Rotation is Euler degrees; binding source is object_data or node_property; numericTransform is scale/offset. Gated.',
  mesh_scene_set_material: 'Set node PBR material and optional workspace texture. Gated.',
  mesh_scene_present: 'Present a scene in the Mesh Canvas dock. Gated.',
  mesh_scene_close: 'Close its presentation without deleting the scene. Gated.',
  mesh_scene_delete: 'Delete a chat-owned scene and unreferenced assets. Gated.',
  mesh_topology_convert: 'Convert a primitive/import to revisioned editable topology. Gated.',
  mesh_topology_inspect: 'Page vertices, edges, faces, UV loops, or bones. Read-only call; gated.',
  mesh_topology_edit:
    'CAS edit batch: expectedRevision + clientMutationId + operations. Supports topology, UV, sculpt, and rig ops. Gated.',
  canvas_sketch_open: "Open/restore this chat's Sketch Canvas. Read-only-safe; returns canvasId.",
  canvas_sketch_get: 'Read Sketch elements and updatedAt. Read-only.',
  canvas_sketch_update:
    'Append/replace/clear/delete rect/ellipse/line/arrow/text/path elements. Respect expectedUpdatedAt; retry user_busy, reread on stale_document. Gated.'
} satisfies Partial<Record<TaskWraithMcpToolName, string>>)

/**
 * Fresh gateway-v13 adds four orchestration tools whose schemas alone (~2.2k)
 * would push the direct transport over 40k even with tiny top-level prose.
 * Compact those four plus `ensemble_fanout` (largest pre-existing DIRECT
 * payload) on the v13 wire only. Names, typed schemas, required fields, enums,
 * annotations, and tools/call behavior stay intact — same contract as the
 * v8-mesh Mesh/Sketch compactor. Canonical catalogue prose is untouched.
 */
const GATEWAY_V13_COMPACT_TOOL_DESCRIPTIONS = Object.freeze({
  scout_brief: 'Fan-out lane brief (findings+confidence). Lane-only.',
  ensemble_await: 'JOIN wait on fan-out lanes; timeout≤600s. Then lane_result.',
  ensemble_lane_result: 'READ one fan-out lane output (status+text). Partial ok.',
  delegate_wave:
    'Wave (ephemeral|durable): workers[{provider?,prompt,role?,label?}]; allowMultiProvider; join→waveId. Gated.',
  // Budget companion: long DIRECT fan-out prose + schema descriptions would
  // leave the four promotions structurally unable to fit under 40k.
  ensemble_fanout: 'Fan-out Ensemble lanes (concurrent; capped). Then await / lane_result.'
} satisfies Partial<Record<TaskWraithMcpToolName, string>>)

// v15-mesh adds three typed topology tools. Compact pre-existing large
// schemas only on this receipt so the transport stays below 40k without
// changing any frozen v13/v14 wire catalogue. blackboard_post joined after
// its image posting/inspection guidance (1effe8c13) breached the mesh
// transport; canonical prose is untouched for every other profile.
const GATEWAY_V15_MESH_COMPACT_TOOL_DESCRIPTIONS = Object.freeze({
  ensemble_roster_edit: 'Edit Ensemble roster participants/settings. Gated.',
  blackboard_post:
    'Post a Blackboard entry/poll. ttlMinutes=self-delete, else durable. Poll: 2–6 pollOptions; vote via ensemble_poll_response. Images ≤4: attachmentIds (chat) or workspaceImagePaths (workspace-confined); readers inspect via inspect_chat_attachment.'
} satisfies Partial<Record<TaskWraithMcpToolName, string>>)

// v17 spends one new direct slot on Image View. Its full canonical guidance is
// retained for discovery/settings, while the wire receipt compacts that schema
// plus the largest remaining delegation definition. This keeps both normal and
// Mesh fresh births below the 40k provider transport ceiling without removing
// a capability or changing any pre-v17 receipt.
const GATEWAY_V17_COMPACT_TOOL_DESCRIPTIONS = Object.freeze({
  image_view: 'View up to 8 existing workspace/chat raster images. Read-only.',
  delegate_to_subthread: 'Delegate one task to a provider sub-thread. Gated.'
} satisfies Partial<Record<TaskWraithMcpToolName, string>>)

function stripSchemaDescriptionFields(value: unknown, inPropertyNameBag = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripSchemaDescriptionFields(entry))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      // Keys inside a properties/patternProperties bag are ARGUMENT NAMES, not
      // schema annotations — an argument literally named `description` must
      // survive compaction; only annotation `description` keys are stripped.
      .filter(([key]) => inPropertyNameBag || key !== 'description')
      .map(([key, nested]) => [
        key,
        stripSchemaDescriptionFields(
          nested,
          !inPropertyNameBag && (key === 'properties' || key === 'patternProperties')
        )
      ])
  )
}

function compactToolDefinitionsForTransport<T extends GatewayV8MeshTransportToolDefinition>(
  definitions: readonly T[],
  descriptions: Readonly<Record<string, string | undefined>>
): T[] {
  return definitions.map((definition) => {
    const description = descriptions[definition.name]
    if (!description) return definition
    return {
      ...definition,
      description,
      ...(definition.inputSchema
        ? {
            inputSchema: stripSchemaDescriptionFields(definition.inputSchema) as Record<
              string,
              unknown
            >
          }
        : {})
    }
  })
}

export function compactGatewayV8MeshToolDefinitionsForTransport<
  T extends GatewayV8MeshTransportToolDefinition
>(definitions: readonly T[]): T[] {
  return compactToolDefinitionsForTransport(
    definitions,
    GATEWAY_V8_MESH_COMPACT_TOOL_DESCRIPTIONS as Readonly<Record<string, string | undefined>>
  )
}

/** Compact the four gateway-v13 direct-promotion tools for the 40k transport ceiling. */
export function compactGatewayV13ToolDefinitionsForTransport<
  T extends GatewayV8MeshTransportToolDefinition
>(definitions: readonly T[]): T[] {
  return compactToolDefinitionsForTransport(
    definitions,
    GATEWAY_V13_COMPACT_TOOL_DESCRIPTIONS as Readonly<Record<string, string | undefined>>
  )
}

/** v15-mesh-only compaction; older receipt transports remain untouched. */
export function compactGatewayV15MeshToolDefinitionsForTransport<
  T extends GatewayV8MeshTransportToolDefinition
>(definitions: readonly T[]): T[] {
  return compactToolDefinitionsForTransport(
    definitions,
    GATEWAY_V15_MESH_COMPACT_TOOL_DESCRIPTIONS as Readonly<Record<string, string | undefined>>
  )
}

/** v17-only wire compaction; membership, schemas, and runtime behavior stay unchanged. */
export function compactGatewayV17ToolDefinitionsForTransport<
  T extends GatewayV8MeshTransportToolDefinition
>(definitions: readonly T[]): T[] {
  return compactToolDefinitionsForTransport(
    definitions,
    GATEWAY_V17_COMPACT_TOOL_DESCRIPTIONS as Readonly<Record<string, string | undefined>>
  )
}

const GATEWAY_MCP_TOOL_SET: ReadonlySet<string> = new Set(GATEWAY_MCP_ADVERTISE_TOOLS)
const GATEWAY_MCP_DIRECT_TOOL_SET: ReadonlySet<string> = new Set(GATEWAY_MCP_DIRECT_TOOLS)

/**
 * Exact hidden universe observed by receipted gateway-v1 sessions.
 *
 * This is derived only from the two immutable v1 literals above. Never append a
 * future tool here: a provider-native session may resume this exact catalogue.
 */
export const GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES = Object.freeze(
  FULL_MCP_ADVERTISE_TOOLS.filter((name) => !GATEWAY_MCP_DIRECT_TOOL_SET.has(name))
)

/** First capability intentionally available only to fresh gateway-v2 sessions. */
export const PROJECT_REFERENCE_PROPOSE_GATEWAY_TOOL_NAME =
  'project_reference_propose' as const satisfies TaskWraithMcpToolName

/**
 * Gateway-v2 keeps the v1 direct surface but receives its own hidden universe.
 * Its one addition is also pinned against the canonical tool-name union.
 */
/** Second gateway-v2 addition: Boss/Captain full-roster concurrent fan-out
 * (each lane under its own normal-turn posture). Pinned against the
 * canonical union like the first addition; the frozen v1 literals above
 * stay untouched (receipted sessions must never see surface drift). */
export const ENSEMBLE_FANOUT_ALL_GATEWAY_TOOL_NAME =
  'ensemble_fanout_all' as const satisfies TaskWraithMcpToolName

export const GATEWAY_V2_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES,
  PROJECT_REFERENCE_PROPOSE_GATEWAY_TOOL_NAME,
  ENSEMBLE_FANOUT_ALL_GATEWAY_TOOL_NAME
] as const satisfies readonly string[])

/**
 * Gateway-v3 additions: the Outlook mail/calendar lane and the document
 * extraction pair.
 *
 * All eight were reachable from NO profile — present in the canonical
 * catalogue, implemented, gated, and callable by nobody. `taskWraithMcpCatalogIsFullyReachable`
 * in the tests now fails if that ever happens again.
 *
 * Hidden rather than direct: they are discovered through capability_search
 * like every other specialist capability, so the small direct gateway surface
 * stays small.
 */
export const GATEWAY_V3_ADDED_TOOL_NAMES = Object.freeze([
  'outlook_list_messages',
  'outlook_search_messages',
  'outlook_get_message',
  'outlook_list_events',
  'outlook_create_draft',
  'outlook_create_event',
  'document_extract_text',
  'document_ocr_image'
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V3_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V2_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V3_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

/**
 * Gateway-v4 additions: the agent-programmed-graph primitives — a bounded
 * JOIN (`ensemble_await`) and a structured lane READ (`ensemble_lane_result`).
 * With `ensemble_fanout` these let a Boss express planner → workers → join →
 * synthesize → gate → retry entirely in tool calls; no graph-authoring UI.
 *
 * Hidden rather than direct, like every other specialist capability: the
 * small direct gateway surface stays small, and the frozen v1–v3 snapshots
 * stay untouched so receipted sessions keep the exact surface they were born
 * with.
 */
export const GATEWAY_V4_ADDED_TOOL_NAMES = Object.freeze([
  'ensemble_await',
  'ensemble_lane_result'
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V4_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V3_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V4_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

/**
 * Gateway-v5 addition: the peer thread-to-thread message. Hidden rather than
 * direct, like every other specialist capability, and minted as a NEW profile
 * rather than added to v4 so receipted sessions keep the exact surface they were
 * born with.
 *
 * Note this tool is deliberately NOT in MCP_AUTO_ALLOWED_TOOLS: it writes into
 * another thread's context and self-gates through the `threadMessage` service.
 */
export const GATEWAY_V5_ADDED_TOOL_NAMES = Object.freeze([
  'thread_message'
] as const satisfies readonly TaskWraithMcpToolName[])

export const GATEWAY_V5_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V4_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V5_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

/**
 * v6 changes only the direct surface. Its hidden universe is deliberately the
 * exact v5 universe; `ensemble_control` is direct, not a discovered target.
 */
export const GATEWAY_V6_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V5_MCP_HIDDEN_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V7_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V6_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V7_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

/**
 * Direct promotion does not mutate the hidden capability universe: Sketch was
 * already discoverable there, and Mesh mirrors this direct+discoverable shape.
 * Keeping the exact v7 array also preserves capability-search compatibility.
 */
export const GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V7_MCP_HIDDEN_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V8_MESH_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V9_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V9_MESH_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V8_MESH_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V9_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V10_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V10_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V10_MESH_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V9_MESH_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V10_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V11_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V10_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V11_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V11_MESH_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V10_MESH_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V11_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V12_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V11_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V12_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V12_MESH_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V11_MESH_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V12_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

/**
 * Direct promotion does not mutate the hidden capability universe: await /
 * lane_result / scout_brief were already discoverable there, and staying on
 * the exact v12 array preserves capability-search compatibility (v8 Sketch
 * pattern). `delegate_wave` is birth-direct only for v13+.
 */
export const GATEWAY_V13_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V12_MCP_HIDDEN_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V13_MESH_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V12_MESH_MCP_HIDDEN_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V14_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V13_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V14_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V14_MESH_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V13_MESH_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V14_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V15_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V14_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V15_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V15_MESH_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V14_MESH_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V15_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V16_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V15_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V16_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V16_MESH_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V15_MESH_MCP_HIDDEN_TOOL_NAMES,
  ...GATEWAY_V16_ADDED_TOOL_NAMES
] as const satisfies readonly string[])

// image_view is birth-direct, so the v17 discovery universe remains the exact
// v16 universe (the same direct-only shape used by delegate_wave on v13).
export const GATEWAY_V17_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V16_MCP_HIDDEN_TOOL_NAMES
] as const satisfies readonly string[])

export const GATEWAY_V17_MESH_MCP_HIDDEN_TOOL_NAMES = Object.freeze([
  ...GATEWAY_V16_MESH_MCP_HIDDEN_TOOL_NAMES
] as const satisfies readonly string[])

export function isGatewayMcpAdvertisedTool(name: string): boolean {
  return GATEWAY_MCP_TOOL_SET.has(name)
}

/**
 * Resolve the hidden catalogue pinned to a gateway session. Missing, malformed,
 * and non-v2 ids deliberately fall back to v1 so an unfenced call cannot see a
 * capability that its provider session may never have observed.
 */
export function taskWraithGatewayHiddenToolNamesForProfile(
  profileId: TaskWraithMcpProfileId | null | undefined
): readonly string[] {
  if (profileId === 'taskwraith-gateway-v17-mesh') return GATEWAY_V17_MESH_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v17') return GATEWAY_V17_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v16-mesh') return GATEWAY_V16_MESH_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v16') return GATEWAY_V16_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v15-mesh') return GATEWAY_V15_MESH_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v15') return GATEWAY_V15_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v14-mesh') return GATEWAY_V14_MESH_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v14') return GATEWAY_V14_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v13-mesh') return GATEWAY_V13_MESH_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v13') return GATEWAY_V13_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v12-mesh') return GATEWAY_V12_MESH_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v12') return GATEWAY_V12_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v11-mesh') return GATEWAY_V11_MESH_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v11') return GATEWAY_V11_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v10-mesh') return GATEWAY_V10_MESH_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v10') return GATEWAY_V10_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v9-mesh') return GATEWAY_V9_MESH_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v9') return GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v8-mesh') return GATEWAY_V8_MESH_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v8') return GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v7' || profileId === 'taskwraith-gateway-v7-mesh') {
    return GATEWAY_V7_MCP_HIDDEN_TOOL_NAMES
  }
  if (profileId === 'taskwraith-gateway-v6') return GATEWAY_V6_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v5') return GATEWAY_V5_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v4') return GATEWAY_V4_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v3') return GATEWAY_V3_MCP_HIDDEN_TOOL_NAMES
  if (profileId === 'taskwraith-gateway-v2') return GATEWAY_V2_MCP_HIDDEN_TOOL_NAMES
  return GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES
}

/** Exact direct catalogue for a gateway profile; missing/legacy ids fail closed to v1. */
export function taskWraithGatewayDirectToolNamesForProfile(
  profileId: TaskWraithMcpProfileId | null | undefined
): readonly TaskWraithMcpToolName[] {
  if (profileId === 'taskwraith-gateway-v17-mesh') return GATEWAY_V17_MESH_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v17') return GATEWAY_V17_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v16-mesh') return GATEWAY_V16_MESH_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v16') return GATEWAY_V16_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v15-mesh') return GATEWAY_V15_MESH_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v15') return GATEWAY_V15_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v14-mesh') return GATEWAY_V14_MESH_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v14') return GATEWAY_V14_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v13-mesh') return GATEWAY_V13_MESH_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v13') return GATEWAY_V13_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v12-mesh') return GATEWAY_V12_MESH_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v12') return GATEWAY_V12_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v11-mesh') return GATEWAY_V11_MESH_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v11') return GATEWAY_V11_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v10-mesh') return GATEWAY_V10_MESH_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v10') return GATEWAY_V10_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v9-mesh') return GATEWAY_V9_MESH_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v9') return GATEWAY_V9_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v8-mesh') return GATEWAY_V8_MESH_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v8') return GATEWAY_V8_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v7-mesh') return GATEWAY_V7_MESH_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v7') return GATEWAY_V7_MCP_DIRECT_TOOLS
  if (profileId === 'taskwraith-gateway-v6') return GATEWAY_V6_MCP_DIRECT_TOOLS
  return GATEWAY_MCP_DIRECT_TOOLS
}

/**
 * Freeze canonical target validation to the union the provider session was
 * born with. Direct and discoverable names are separate transport concerns;
 * neither may be widened by later additions to the live global catalogue.
 */
export function filterTaskWraithMcpToolDefinitionsForProfile<
  TDefinition extends { readonly name: string }
>(
  profileId: TaskWraithMcpProfileId | null | undefined,
  definitions: readonly TDefinition[]
): TDefinition[] {
  const names = new Set<string>([
    ...taskWraithGatewayDirectToolNamesForProfile(profileId),
    ...taskWraithGatewayHiddenToolNamesForProfile(profileId)
  ])
  return definitions.filter((definition) => names.has(definition.name))
}

const MCP_ADVERTISE_TOOLS_BY_PROFILE = {
  'taskwraith-full-v1': FULL_MCP_ADVERTISE_TOOLS,
  'taskwraith-full-v2': FULL_V2_MCP_ADVERTISE_TOOLS,
  'taskwraith-core-v1': CORE_MCP_ADVERTISE_TOOLS,
  'taskwraith-core-v2': CORE_V2_MCP_ADVERTISE_TOOLS,
  'taskwraith-gateway-v1': GATEWAY_MCP_ADVERTISE_TOOLS,
  'taskwraith-gateway-v2': GATEWAY_MCP_ADVERTISE_TOOLS,
  // v3 advertises the same tiny direct surface as v1/v2 — only the hidden
  // universe behind capability_search grew.
  'taskwraith-gateway-v3': GATEWAY_MCP_ADVERTISE_TOOLS,
  // v4 likewise: direct surface unchanged; hidden universe adds the
  // await/lane-result graph primitives.
  'taskwraith-gateway-v4': GATEWAY_MCP_ADVERTISE_TOOLS,
  // v5 likewise: direct surface unchanged; hidden universe adds thread_message.
  'taskwraith-gateway-v5': GATEWAY_MCP_ADVERTISE_TOOLS,
  // v6 adds only the compact portable Ensemble control to the direct surface.
  'taskwraith-gateway-v6': GATEWAY_V6_MCP_ADVERTISE_TOOLS,
  // v7 keeps the normal direct surface compact and introduces Mesh Canvas
  // through capability discovery.
  'taskwraith-gateway-v7': GATEWAY_V7_MCP_ADVERTISE_TOOLS,
  // This is selected from a participant's current non-denied run posture. It
  // is a catalogue variant, not a permission class; `ask` still prompts.
  'taskwraith-gateway-v7-mesh': GATEWAY_V7_MESH_MCP_ADVERTISE_TOOLS,
  // v8 promotes Sketch to direct for every fresh seat; the mesh variant keeps
  // the current participant-posture-selected Mesh family direct as well.
  'taskwraith-gateway-v8': GATEWAY_V8_MCP_ADVERTISE_TOOLS,
  'taskwraith-gateway-v8-mesh': GATEWAY_V8_MESH_MCP_ADVERTISE_TOOLS,
  // v9 adds permission retry through discovery without growing either direct
  // catalogue.
  'taskwraith-gateway-v9': GATEWAY_V9_MCP_ADVERTISE_TOOLS,
  'taskwraith-gateway-v9-mesh': GATEWAY_V9_MESH_MCP_ADVERTISE_TOOLS,
  // v10 adds Canvas Browser navigation through discovery without growing
  // either direct catalogue.
  'taskwraith-gateway-v10': GATEWAY_V10_MCP_ADVERTISE_TOOLS,
  'taskwraith-gateway-v10-mesh': GATEWAY_V10_MESH_MCP_ADVERTISE_TOOLS,
  // v11 adds Simulator Canvas through discovery without growing either direct
  // catalogue (status auto-allowed; mutators stay on simulatorCanvas).
  'taskwraith-gateway-v11': GATEWAY_V11_MCP_ADVERTISE_TOOLS,
  'taskwraith-gateway-v11-mesh': GATEWAY_V11_MESH_MCP_ADVERTISE_TOOLS,
  // v12 adds project_reference_list through discovery without growing either
  // direct catalogue. ADDED is list-only — Skills surface growth minted v14.
  'taskwraith-gateway-v12': GATEWAY_V12_MCP_ADVERTISE_TOOLS,
  'taskwraith-gateway-v12-mesh': GATEWAY_V12_MESH_MCP_ADVERTISE_TOOLS,
  // v13 promotes scout_brief / ensemble_await / ensemble_lane_result /
  // delegate_wave to the fresh direct birth catalogue (compact transport).
  'taskwraith-gateway-v13': GATEWAY_V13_MCP_ADVERTISE_TOOLS,
  'taskwraith-gateway-v13-mesh': GATEWAY_V13_MESH_MCP_ADVERTISE_TOOLS,
  // v14 adds skill_list / skill_read through discovery without growing either
  // direct catalogue.
  'taskwraith-gateway-v14': GATEWAY_V14_MCP_ADVERTISE_TOOLS,
  'taskwraith-gateway-v14-mesh': GATEWAY_V14_MESH_MCP_ADVERTISE_TOOLS,
  'taskwraith-gateway-v15': GATEWAY_V15_MCP_ADVERTISE_TOOLS,
  'taskwraith-gateway-v15-mesh': GATEWAY_V15_MESH_MCP_ADVERTISE_TOOLS,
  // v16 adds canvas_render_chart through discovery without growing either
  // direct catalogue.
  'taskwraith-gateway-v16': GATEWAY_V16_MCP_ADVERTISE_TOOLS,
  'taskwraith-gateway-v16-mesh': GATEWAY_V16_MESH_MCP_ADVERTISE_TOOLS,
  // v17 adds the canonical Image View read tool directly.
  'taskwraith-gateway-v17': GATEWAY_V17_MCP_ADVERTISE_TOOLS,
  'taskwraith-gateway-v17-mesh': GATEWAY_V17_MESH_MCP_ADVERTISE_TOOLS
} as const satisfies Record<TaskWraithMcpProfileId, readonly TaskWraithMcpAdvertisedToolName[]>

/** Exact immutable membership for each receiptable profile id. */
export function taskWraithMcpAdvertisedToolNamesForProfile(
  profileId: TaskWraithMcpProfileId
): readonly TaskWraithMcpAdvertisedToolName[] {
  return MCP_ADVERTISE_TOOLS_BY_PROFILE[profileId]
}

/** Keep the historical Cursor-model mapping stable for pinned profile decoding. */
export function shouldUseCoreMcpProfile(
  provider: ProviderId,
  modelId: string | null | undefined
): boolean {
  if (provider === 'cursor') return isCursorGrokModelId(modelId)
  if (provider === 'grok') {
    if (!String(modelId || '').trim()) return true
    return isGrokReasoningModelId(modelId) || isCursorGrokModelId(modelId)
  }
  return false
}
