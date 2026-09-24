// Pure MCP tool-grouping helpers extracted from SettingsPanel.tsx.
//
// Architecture note: the catalog is imported from src/shared/taskWraithMcpCatalog
// directly (shared -> shared at runtime). Importing the src/main/TaskWraithMcpTools
// re-export shim here would mint a fresh renderer -> main runtime edge that
// scripts/architecture-guard.cjs rejects. Types from src/main/store/types are
// imported type-only, so they are erased at emit and add no runtime edge.
import {
  TASKWRAITH_MCP_TOOLS,
  type TaskWraithMcpToolName
} from '../../../../shared/taskWraithMcpCatalog'
import { catalogToolAgenticService } from '../../../../shared/canonicalToolCoalesce'
import { toolNameToFamily, type ToolFamily } from '../icons/ToolFamilyIcon'
import { AGENTIC_SERVICE_POLICY_OPTIONS, NETWORK_POLICY_OPTIONS } from '../../lib/policyPosture'
import type { AgenticServicesSettings, ProviderId } from '../../../../main/store/types'

export type McpToolGroup =
  | 'workspace'
  | 'git'
  | 'runtime'
  | 'web'
  | 'canvas'
  | 'ensemble'
  | 'goals'
  | 'memory'
  | 'media'
  | 'creative'
  | 'outlook'
  | 'ide'

export type McpToolPolicyKey = keyof AgenticServicesSettings

export const MCP_TOOL_GROUP_LABELS: Record<McpToolGroup, string> = {
  workspace: 'Workspace files and search',
  git: 'Git',
  runtime: 'Runtime and diagnostics',
  web: 'Web and window context',
  canvas: 'Canvas and launches',
  ensemble: 'Ensemble and collaboration',
  goals: 'Goals and evidence',
  memory: 'Recall and wakeups',
  media: 'Media tools',
  creative: 'Creative apps',
  outlook: 'Outlook mail and calendar',
  ide: 'IDE and provider status'
}

export const MCP_TOOL_GROUP_ORDER: McpToolGroup[] = [
  'workspace',
  'git',
  'runtime',
  'web',
  'canvas',
  'ensemble',
  'goals',
  'memory',
  'media',
  'creative',
  'outlook',
  'ide'
]

const MCP_TOOL_OVERRIDES: Partial<
  Record<
    TaskWraithMcpToolName,
    {
      label: string
      transcript: string
      group: McpToolGroup
      iconRef: string
      policyKey: McpToolPolicyKey
      description: string
    }
  >
> = {
  run_shell_command: {
    label: 'Run shell command',
    transcript: 'Ran shell command',
    group: 'runtime',
    iconRef: 'tool:terminal',
    policyKey: 'shellCommands',
    description: 'Executes workspace-scoped shell commands with approval and audit capture.'
  },
  write_file: {
    label: 'Write file',
    transcript: 'Wrote file',
    group: 'workspace',
    iconRef: 'tool:file-write',
    policyKey: 'fileChanges',
    description: 'Writes a workspace file and records the resulting change summary.'
  },
  replace: {
    label: 'Replace text',
    transcript: 'Edited file',
    group: 'workspace',
    iconRef: 'tool:replace',
    policyKey: 'fileChanges',
    description: 'Applies a targeted replacement inside a workspace file.'
  },
  create_directory: {
    label: 'Create directory',
    transcript: 'Created directory',
    group: 'workspace',
    iconRef: 'tool:folder',
    policyKey: 'fileChanges',
    description: 'Creates a workspace directory after file-change approval.'
  },
  delete_path: {
    label: 'Delete path',
    transcript: 'Deleted path',
    group: 'workspace',
    iconRef: 'tool:file-write',
    policyKey: 'fileChanges',
    description: 'Deletes a workspace file or empty directory after approval.'
  },
  move_path: {
    label: 'Move path',
    transcript: 'Moved path',
    group: 'workspace',
    iconRef: 'tool:file-write',
    policyKey: 'fileChanges',
    description: 'Moves a workspace file or directory after approval.'
  },
  rename_path: {
    label: 'Rename path',
    transcript: 'Renamed path',
    group: 'workspace',
    iconRef: 'tool:file-write',
    policyKey: 'fileChanges',
    description: 'Renames a workspace file or directory after approval.'
  },
  read_file: {
    label: 'Read file',
    transcript: 'Read file',
    group: 'workspace',
    iconRef: 'tool:file-read',
    policyKey: 'mcpTools',
    description: 'Reads a workspace file for provider context.'
  },
  list_directory: {
    label: 'List directory',
    transcript: 'Listed directory',
    group: 'workspace',
    iconRef: 'tool:folder',
    policyKey: 'mcpTools',
    description: 'Lists workspace folders without leaving the project boundary.'
  },
  workspace_search: {
    label: 'Workspace search',
    transcript: 'Searched workspace',
    group: 'workspace',
    iconRef: 'tool:search',
    policyKey: 'mcpTools',
    description: 'Searches project text and file names for provider grounding.'
  },
  web_search: {
    label: 'Web search',
    transcript: 'Searched web',
    group: 'web',
    iconRef: 'tool:search',
    policyKey: 'mcpTools',
    description: 'Searches the web for current information through TaskWraith policy.'
  },
  web_fetch: {
    label: 'Web fetch',
    transcript: 'Fetched web page',
    group: 'web',
    iconRef: 'tool:browser',
    policyKey: 'mcpTools',
    description: 'Fetches a live web page as read-only text through TaskWraith policy.'
  },
  apply_patch: {
    label: 'Apply patch',
    transcript: 'Applied patch',
    group: 'workspace',
    iconRef: 'tool:patch',
    policyKey: 'fileChanges',
    description: 'Applies a structured patch with file-change audit output.'
  },
  mesh_topology_convert: {
    label: 'Mesh Topology Convert',
    transcript: 'Converted mesh topology',
    group: 'canvas',
    iconRef: 'tool:mesh-convert',
    policyKey: 'meshCanvas',
    description: 'Converts a primitive or imported mesh node into revisioned editable topology.'
  },
  mesh_topology_inspect: {
    label: 'Mesh Topology Inspect',
    transcript: 'Inspected mesh topology',
    group: 'canvas',
    iconRef: 'tool:mesh-inspect',
    policyKey: 'meshCanvas',
    description: 'Reads bounded pages of mesh vertices, edges, faces, UV loops, bones, or summary.'
  },
  mesh_topology_edit: {
    label: 'Mesh Topology Edit',
    transcript: 'Edited mesh topology',
    group: 'canvas',
    iconRef: 'tool:mesh-edit',
    policyKey: 'meshCanvas',
    description: 'Applies an atomic CAS batch of topology, UV, sculpt, or rigging operations.'
  },
  delegate_to_subthread: {
    label: 'Delegate to sub-thread',
    transcript: 'Delegated sub-thread',
    group: 'ensemble',
    iconRef: 'tool:delegate',
    policyKey: 'subThreadDelegation',
    description: 'Starts or continues a linked provider sub-thread after policy checks.'
  },
  ensemble_yield: {
    label: 'Yield ensemble turn',
    transcript: 'Yielded ensemble turn',
    group: 'ensemble',
    iconRef: 'tool:yield',
    policyKey: 'mcpTools',
    description: 'Lets an Ensemble participant pass control to the next speaker.'
  },
  appwatch_latest_frame: {
    label: 'Latest Appwatch frame',
    transcript: 'Captured latest frame',
    group: 'web',
    iconRef: 'tool:image',
    policyKey: 'mcpTools',
    description: 'Returns metadata plus the newest attached-window image frame.'
  },
  appwatch_frames: {
    label: 'Appwatch frame batch',
    transcript: 'Captured frame batch',
    group: 'web',
    iconRef: 'tool:frames',
    policyKey: 'mcpTools',
    description: 'Returns a bounded batch of recent attached-window frames.'
  },
  get_diagnostics: {
    label: 'Get diagnostics',
    transcript: 'Checked diagnostics',
    group: 'runtime',
    iconRef: 'tool:diagnostics',
    policyKey: 'shellCommands',
    description: 'Runs fixed workspace diagnostic tools and returns structured problems.'
  },
  project_reference_propose: {
    label: 'Propose Project reference',
    transcript: 'Proposed Project reference',
    group: 'goals',
    iconRef: 'tool:plan',
    policyKey: 'mcpTools',
    description:
      'Adds an untrusted file, folder, or link suggestion to the human review inbox without reading it or granting access.'
  },
  project_reference_list: {
    label: 'List Project references',
    transcript: 'Listed Project references',
    group: 'goals',
    iconRef: 'tool:plan',
    policyKey: 'mcpTools',
    description:
      'Lists Project reference catalogue metadata for the active chat without fetching, statting, or probing locators.'
  },
  redeem_permission_opportunity: {
    label: 'Redeem permission opportunity',
    transcript: 'Redeemed permission opportunity',
    group: 'runtime',
    iconRef: 'tool:auth',
    policyKey: 'mcpTools',
    description:
      'Redeems one host-issued, run-bound permission opportunity; it never accepts model-authored target arguments.'
  },
  emulator_open: {
    label: 'Open homebrew emulator',
    transcript: 'Opened homebrew emulator',
    group: 'canvas',
    iconRef: 'tool:canvas',
    policyKey: 'mcpTools',
    description:
      'Opens only the fixed reviewed homebrew demo in the Canvas dock; no URL, ROM, or game override exists.'
  },
  emulator_observe: {
    label: 'Observe homebrew emulator',
    transcript: 'Observed homebrew emulator',
    group: 'canvas',
    iconRef: 'tool:canvas',
    policyKey: 'mcpTools',
    description:
      'Returns one governed PNG plus verified mapped state from the fixed demo; raw emulator memory is never exposed.'
  },
  emulator_step: {
    label: 'Step homebrew emulator',
    transcript: 'Stepped homebrew emulator',
    group: 'canvas',
    iconRef: 'tool:canvas',
    policyKey: 'canvasInteraction',
    description:
      'Advances the reviewed emulator surface through bounded input frames under its exact Canvas interaction/AppDrive grant.'
  }
}

function titleFromSnake(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** "1 tool" / "2 tools" — naive count + singular/plural noun. */
export function pluralizeCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

const MCP_TOOL_GROUPED_NAMES: Record<McpToolGroup, readonly TaskWraithMcpToolName[]> = {
  workspace: [
    'read_file',
    'list_directory',
    'find_files',
    'workspace_search',
    'workspace_symbols',
    'list_chat_attachments',
    'inspect_chat_attachment',
    'open_workspace_file',
    'write_file',
    'replace',
    'create_directory',
    'delete_path',
    'move_path',
    'rename_path',
    'apply_patch'
  ],
  git: [
    'git_status',
    'git_diff',
    'git_log',
    'git_show',
    'git_blame',
    'git_stage',
    'git_commit',
    'git_push',
    'git_create_pr',
    'github_ci_status'
  ],
  runtime: [
    'run_shell_command',
    'run_task',
    'start_background_process',
    'list_background_processes',
    'read_background_process',
    'kill_background_process',
    'get_diagnostics',
    'list_active_runs',
    'cancel_active_run',
    'test_result_summary',
    'run_timeline',
    'raw_provider_events',
    'request_tool_permission',
    'redeem_permission_opportunity',
    // Appearance of TaskWraith itself — an agent-accessed capability rather
    // than a workspace or canvas one, so it groups with the other tools that
    // act on the running app.
    'theme_tokens_get',
    'theme_tokens_set'
  ],
  web: [
    'web_search',
    'web_fetch',
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
    'appshots_status'
  ],
  canvas: [
    'launch_list_targets',
    'launch_start',
    'launch_adopt',
    'launch_stop',
    'launch_status',
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
    'canvas_drive_report',
    'canvas_drive_verify',
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
    'emulator_open',
    'emulator_observe',
    'emulator_step',
    'canvas_navigate',
    'canvas_close',
    'web_login_list',
    'web_login_open',
    'mesh_scene_create',
    'mesh_scene_list',
    'mesh_scene_inspect',
    'mesh_scene_import',
    'mesh_scene_apply',
    'mesh_scene_set_material',
    'mesh_scene_present',
    'mesh_scene_close',
    'mesh_scene_delete',
    'mesh_topology_convert',
    'mesh_topology_inspect',
    'mesh_topology_edit',
    'simulator_status',
    'simulator_open',
    'simulator_boot',
    'simulator_install',
    'simulator_launch',
    'simulator_screenshot',
    'simulator_terminate',
    'simulator_inspect',
    'simulator_button',
    'simulator_rotate',
    'simulator_tap',
    'simulator_type',
    'simulator_scroll'
  ],
  ensemble: [
    'delegate_to_subthread',
    'delegate_wave',
    'list_subthreads',
    'read_subthread_result',
    'cancel_subthread',
    'claim_fleet_wave',
    'ensemble_yield',
    'ensemble_send',
    'ensemble_fanout',
    'ensemble_fanout_all',
    'ensemble_await',
    'ensemble_lane_result',
    'thread_message',
    'ensemble_bossman_control',
    'ensemble_control',
    'ensemble_poll_response',
    'ensemble_propose_goal_complete',
    'ensemble_roster_edit',
    'ensemble_brief_update',
    'list_ensemble_participants',
    'scout_brief',
    'blackboard_post',
    'blackboard_read',
    'blackboard_delete',
    // Durable staged UltraTask graphs (scouts → workers → review → synthesis)
    // are ensemble orchestration, not runtime process control.
    'ultra_task',
    'ask_user_question'
  ],
  goals: [
    'goal_read',
    'goal_update',
    'update_goal',
    'goal_complete',
    'goal_blocked',
    'todo_write',
    'workspace_board_snapshot',
    'workspace_board_preview_plan',
    'workspace_board_apply_plan',
    'project_reference_propose',
    'project_reference_list',
    'prompt_task_normalize',
    'scope_radar',
    'repo_convention_scan',
    'coherence_gate_check',
    'evidence_pack_write',
    'completion_claim_check'
  ],
  memory: [
    'schedule_wakeup',
    'cancel_wakeup',
    'tw_recall_find',
    'tw_recall_read',
    'tw_recall_read_events',
    'tw_history_search',
    'tw_history_read',
    'tw_checkpoint',
    'tw_introspection_run',
    'tw_introspection_list',
    'tw_introspection_read',
    'tw_introspection_review',
    'skill_list',
    'skill_read'
  ],
  media: [
    'image_view',
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
    'document_extract_text',
    'document_ocr_image',
    'transcode_video'
  ],
  creative: [
    'creative_app_status',
    'creative_app_capabilities',
    'creative_project_snapshot',
    'creative_timeline_validate',
    'creative_timeline_ir',
    'creative_timeline_diff',
    'creative_timeline_import',
    'creative_applescript_dispatch',
    'creative_blender_python',
    'creative_midi_dispatch'
  ],
  outlook: [
    'outlook_list_messages',
    'outlook_search_messages',
    'outlook_get_message',
    'outlook_list_events',
    'outlook_create_draft',
    'outlook_create_event'
  ],
  ide: [
    'approval_status',
    'provider_auth_status',
    'provider_usage_status',
    'open_in_ide',
    'open_in_ide_at_position',
    'reveal_in_finder',
    'ide_app_status',
    'ide_app_capabilities',
    'list_running_ides',
    'create_handoff_card',
    'switch_auth_profile',
    'agent_delegation_role'
  ]
}

const MCP_TOOL_GROUP_LOOKUP = new Map<TaskWraithMcpToolName, McpToolGroup>(
  Object.entries(MCP_TOOL_GROUPED_NAMES).flatMap(([group, tools]) =>
    tools.map((tool) => [tool, group as McpToolGroup])
  )
)

export function uncategorizedMcpToolsForSettings(): TaskWraithMcpToolName[] {
  return TASKWRAITH_MCP_TOOLS.filter((tool) => !MCP_TOOL_GROUP_LOOKUP.has(tool))
}

function inferMcpToolGroup(tool: TaskWraithMcpToolName): McpToolGroup {
  return MCP_TOOL_GROUP_LOOKUP.get(tool) ?? 'workspace'
}

function inferMcpPolicyKey(tool: TaskWraithMcpToolName): McpToolPolicyKey {
  // WS-C: the per-tool Settings policy chip reads from the SAME shared canonical
  // ladder as the runtime approval gate (catalogToolAgenticService), so the
  // bucket shown here can never drift from the one actually enforced. Agentic
  // ServiceId is a subset of keyof AgenticServicesSettings (McpToolPolicyKey).
  return catalogToolAgenticService(tool)
}

export function getMcpToolMeta(tool: TaskWraithMcpToolName): {
  label: string
  transcript: string
  group: McpToolGroup
  iconRef: string
  policyKey: McpToolPolicyKey
  description: string
} {
  const override = MCP_TOOL_OVERRIDES[tool]
  if (override) return override
  const group = inferMcpToolGroup(tool)
  return {
    label: titleFromSnake(tool),
    transcript: titleFromSnake(tool.replace(/^creative_/, '').replace(/^appwatch_/, 'Appwatch ')),
    group,
    iconRef: `tool:${group}`,
    policyKey: inferMcpPolicyKey(tool),
    description: `${MCP_TOOL_GROUP_LABELS[group]} tool exposed through the TaskWraith MCP bridge.`
  }
}

const MCP_ICON_REF_FAMILIES: Record<string, ToolFamily> = {
  'tool:auth': 'diagnostic',
  'tool:browser': 'browser',
  'tool:canvas': 'canvas',
  'tool:creative': 'diagnostic',
  'tool:delegate': 'delegate',
  'tool:diagnostics': 'diagnostic',
  'tool:ensemble': 'roster',
  'tool:file-read': 'file',
  'tool:file-write': 'edit',
  'tool:files': 'edit',
  'tool:folder': 'file',
  'tool:frames': 'window-context',
  'tool:git': 'git',
  'tool:goals': 'plan',
  'tool:ide': 'handoff',
  'tool:image': 'image',
  'tool:media': 'video',
  'tool:mesh-convert': 'mesh-convert',
  'tool:mesh-inspect': 'mesh-inspect',
  'tool:mesh-edit': 'mesh-edit',
  'tool:memory': 'memory',
  'tool:patch': 'patch',
  'tool:replace': 'edit',
  'tool:runtime': 'process',
  'tool:search': 'search',
  'tool:subthreads': 'subthread',
  'tool:terminal': 'shell',
  'tool:web': 'browser',
  'tool:workspace': 'task',
  'tool:yield': 'yield'
}

export function resolveMcpToolIconFamily(tool: {
  name: TaskWraithMcpToolName
  iconRef: string
}): ToolFamily {
  return toolNameToFamily(tool.name) ?? MCP_ICON_REF_FAMILIES[tool.iconRef] ?? 'mcp'
}

export function formatMcpInvocation(provider: ProviderId, tool: TaskWraithMcpToolName): string {
  if (provider === 'claude') return `mcp__TaskWraith__${tool}`
  return `TaskWraith__${tool}`
}

export function getMcpPolicyLabel(
  agenticServices: AgenticServicesSettings,
  policyKey: McpToolPolicyKey
): string {
  const value = agenticServices[policyKey] ?? ''
  if (policyKey === 'networkAccess') {
    return NETWORK_POLICY_OPTIONS.find((option) => option.value === value)?.label ?? value
  }
  return AGENTIC_SERVICE_POLICY_OPTIONS.find((option) => option.value === value)?.label ?? value
}

export function countMcpStatusTools(status: any): number {
  if (!status) return 0
  if (Array.isArray(status.tools)) return status.tools.length
  if (status.tools && typeof status.tools === 'object') return Object.keys(status.tools).length
  if (Array.isArray(status.data)) {
    return status.data.reduce((total: number, server: any) => {
      if (Array.isArray(server?.tools)) return total + server.tools.length
      if (server?.tools && typeof server.tools === 'object')
        return total + Object.keys(server.tools).length
      return total
    }, 0)
  }
  return 0
}

export function countMcpStatusServers(status: any): number {
  return Array.isArray(status?.data) ? status.data.length : 0
}

export const MCP_TOOL_CATALOG = TASKWRAITH_MCP_TOOLS.map((name) => ({
  name,
  ...getMcpToolMeta(name)
})).sort((a, b) => {
  const groupDelta = MCP_TOOL_GROUP_ORDER.indexOf(a.group) - MCP_TOOL_GROUP_ORDER.indexOf(b.group)
  return groupDelta === 0 ? a.label.localeCompare(b.label) : groupDelta
})
