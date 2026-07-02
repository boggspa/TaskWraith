/**
 * Tool-class taxonomy — the single source of truth that buckets every agent
 * tool into one of four classes for permission-posture display:
 *
 *   - workspace_read   non-mutating file / code reads (read_file, grep, …)
 *   - workspace_write  mutating tools (write_file, apply_patch, run_shell, …)
 *   - web_read         read-only network lookups (web_search, web_fetch)
 *   - orchestration    non-mutating control / status / focus (status reads,
 *                      ensemble yield, scheduling, open-in-IDE focus changes)
 *   - ui_elicitation   asking the user (ask_user_question)
 *
 * Why a dedicated module (1.0.72): the read-only / plan posture UI needs to
 * show *which classes* a posture permits (panel feedback). The non-write class
 * lists are cross-checked against the canonical read-only sets —
 * READ_ONLY_TOOL_PRESET (defined below) and MCP_AUTO_ALLOWED_TOOLS
 * (McpAutoAllowedTools) — by a test that asserts every member of those
 * non-mutating sets classifies as non-write, so this taxonomy can't silently
 * drift from the safety invariant.
 *
 * classifyTool defaults the UNKNOWN tool to workspace_write — the safe default
 * (an unrecognised tool is treated as mutating, never surfaced as "safe").
 */

import { MCP_APP_STATE_MUTATION_TOOLS } from './mcp/McpAutoAllowedTools'

export type ToolClass =
  | 'workspace_read'
  | 'web_read'
  | 'workspace_write'
  | 'orchestration'
  | 'ui_elicitation'

/** Display order: the allowed-under-read-only classes first, writes last. */
export const TOOL_CLASS_ORDER: readonly ToolClass[] = [
  'workspace_read',
  'web_read',
  'orchestration',
  'ui_elicitation',
  'workspace_write'
]

export const TOOL_CLASS_LABELS: Record<ToolClass, string> = {
  workspace_read: 'Workspace reads',
  web_read: 'Web reads',
  workspace_write: 'Workspace writes',
  orchestration: 'Orchestration',
  ui_elicitation: 'User prompts'
}

/**
 * The canonical "read-only" tool preset — the non-mutating reads /
 * searches / status checks a posture-restricted run may call. Anything
 * mutating (`write_file`, `apply_patch`, `run_shell`, `git_commit`, …)
 * is excluded by omission.
 *
 * Consumed by the read-only posture breakdown UI (`ToolClassBreakdown`)
 * and cross-checked by `ToolClassTaxonomy.test.ts`, which asserts every
 * member classifies as non-write so this preset can't drift from the
 * taxonomy's safety invariant.
 */
export const READ_ONLY_TOOL_PRESET: ReadonlyArray<string> = Object.freeze([
  'read_file',
  'list_directory',
  'find_files',
  'list_chat_attachments',
  'inspect_chat_attachment',
  'grep',
  'glob',
  'attached_window_status',
  'appwatch_status',
  'ide_app_status',
  'ide_app_capabilities',
  'list_running_ides',
  'provider_auth_status',
  'list_active_runs',
  'list_background_processes',
  'read_background_process',
  'creative_app_status',
  'creative_app_capabilities',
  'approval_status',
  'list_ensemble_participants',
  'provider_usage_status',
  // 1.0.72 — asking the user a clarifying question is non-mutating (no fs /
  // shell / network), so a read-only run may do it. Mirrors the main-
  // participant behaviour for Codex / Claude / Kimi.
  'ask_user_question',
  'goal_read',
  'goal_update',
  'update_goal',
  'goal_complete',
  'goal_blocked',
  // 1.4.2 — read-only runs may publish goal-step checklists.
  'todo_write'
])

const WORKSPACE_READ_TOOLS = new Set<string>([
  'read_file',
  'list_directory',
  'grep',
  'glob',
  'find_files',
  'list_chat_attachments',
  'inspect_chat_attachment',
  'workspace_search',
  'workspace_symbols',
  // git state + file surfacing — read-only repo / file reads
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_blame',
  'open_workspace_file'
])

const UI_ELICITATION_TOOLS = new Set<string>(['ask_user_question'])

const WEB_READ_TOOLS = new Set<string>(['web_search', 'web_fetch'])

const ORCHESTRATION_TOOLS = new Set<string>([
  'approval_status',
  'provider_auth_status',
  'provider_usage_status',
  'list_active_runs',
  'list_background_processes',
  'read_background_process',
  'browser_console',
  'creative_app_status',
  'creative_app_capabilities',
  'attached_window_status',
  'appwatch_status',
  'open_in_ide',
  'open_in_ide_at_position',
  'reveal_in_finder',
  'ide_app_status',
  'ide_app_capabilities',
  'list_running_ides',
  'ensemble_yield',
  'ensemble_send',
  'ensemble_fanout',
  'list_ensemble_participants',
  'schedule_wakeup',
  'cancel_wakeup',
  // diagnostics / run + test reads (non-mutating)
  'test_result_summary',
  'run_timeline',
  'raw_provider_events',
  // Run-Button reads. These expose discovered target/status metadata only; the
  // process-spawning/terminating tools (launch_start/launch_stop) stay write.
  'launch_list_targets',
  'launch_status',
  // sub-thread coordination (read + control; no workspace mutation)
  'list_subthreads',
  'read_subthread_result',
  'cancel_subthread',
  // window-capture control + reads (no workspace mutation)
  'attached_window_capture',
  'appwatch_start',
  'appwatch_stop',
  'appwatch_latest_frame',
  'appwatch_frames',
  // S2 — native VideoToolbox single-frame decode: a daemon-backed capture that
  // returns an image (like appwatch_latest_frame / canvas_screenshot), no
  // workspace mutation and no external binary → allowed under read-only.
  'video_decode_frame',
  // Multi-frame read-only scrub: loops the same native VideoToolbox decode to
  // return up to 8 frames at once. No workspace mutation, no external binary →
  // allowed under read-only, exactly like video_decode_frame.
  'inspect_video_frames',
  // Windowed audio clip: cut a [startMs,endMs] slice into a PLAYABLE content-addressed
  // WAV (+ peaks + best-effort transcript). Content-addresses the INTERNAL asset store
  // only — NO workspace mutation, no external binary, no network → allowed under
  // read-only, exactly like inspect_video_frames (which likewise persists image refs).
  'inspect_audio_segment',
  // On-device speech-to-text (native Speech framework). No workspace mutation, no
  // external binary, no file output, no network (on-device ONLY) → allowed under
  // read-only. The OS permission grant is enforced at runtime by the daemon.
  'transcribe_audio',
  // creative reads / validation — the *import* / applescript / blender / midi
  // mutators stay workspace_write (caught by the default below)
  'creative_project_snapshot',
  'creative_timeline_validate',
  'creative_timeline_ir',
  'creative_timeline_diff',
  // ensemble coordination artifacts (non-workspace-mutating)
  'create_handoff_card',
  'agent_delegation_role',
  'ensemble_continue',
  'ensemble_bossman_control',
  'ensemble_roster_edit',
  'scout_brief',
  'blackboard_post',
  'workspace_board_snapshot',
  'workspace_board_preview_plan',
  'workspace_board_apply_plan',
  // Persistent thread goal lifecycle (no workspace mutation).
  'goal_read',
  'goal_update',
  'update_goal',
  'goal_complete',
  'goal_blocked',
  // 1.4.2 — structured goal-step checklist (no workspace mutation).
  'todo_write',
  // TaskWraith Canvas — non-mutating preview verbs. list/status are metadata;
  // snapshot/inspect run fixed inspection scripts; network/console are read
  // buffers; screenshot is a capture (like appwatch_latest_frame); resize/close
  // are window control. canvas_open is the navigation/SSRF surface and stays
  // workspace_write (the default below) — denied under read-only, like
  // browser_open.
  'canvas_list',
  'canvas_status',
  'canvas_snapshot',
  'canvas_inspect',
  'canvas_network',
  'canvas_console',
  'canvas_screenshot',
  'canvas_resize',
  'canvas_close',
  // P1: annotate overlays a Set-of-Mark layer for the human — authoring, not an
  // app mutation. canvas_click / canvas_fill DO mutate the app and fall through
  // to workspace_write (read-only-DENY) by the default below.
  'canvas_annotate',
  // Cross-thread recall — read-only retrospection over OTHER runs. Non-
  // workspace-mutating reads; cross-workspace exposure is enforced by the
  // crossThreadRead approval service (Slice 3), not by the tool class.
  'tw_recall_find',
  'tw_recall_read',
  'tw_recall_read_events',
  // Evidence-pack / run-observability tools. These read the prompt/workspace/
  // diff and persist their output to the INTERNAL evidence-pack store
  // (userData/evidence-packs.json), never the workspace — the same observe-class
  // artifact sink as the transcript. They are members of MCP_AUTO_ALLOWED_TOOLS
  // (read-only agents must still leave auditable evidence), so they MUST classify
  // as non-write or the auto-allow safety invariant fails. Verified non-mutating
  // (no fs writes to workspace, no spawn, no network).
  'prompt_task_normalize',
  'scope_radar',
  'repo_convention_scan',
  'coherence_gate_check',
  'evidence_pack_write',
  'completion_claim_check'
])

/** Bucket a single tool name. Unknown → workspace_write (safe default). */
export function classifyTool(name: string): ToolClass {
  if (UI_ELICITATION_TOOLS.has(name)) return 'ui_elicitation'
  if (WORKSPACE_READ_TOOLS.has(name)) return 'workspace_read'
  if (WEB_READ_TOOLS.has(name)) return 'web_read'
  if (ORCHESTRATION_TOOLS.has(name)) return 'orchestration'
  return 'workspace_write'
}

/**
 * Is this tool BLOCKED for a read-only / plan participant? True when the run is
 * read-only AND the tool is mutating / side-effecting. Unknown tools default to
 * workspace_write; app-state mutation tools are denied explicitly even though
 * they remain grouped as orchestration for display.
 *
 * The host gate already hard-denies the file/shell-classified mutators under
 * read-only; this is what lets the dispatchers also hard-deny the side-effecting
 * fall-through tools (creative_blender_python, browser_open/click, switch_auth_
 * profile, …) that would otherwise only PROMPT because they classify as the
 * generic mcpTools service.
 */
export function isReadOnlyBlockedTool(
  toolName: string,
  effectivePermissions?: { readOnly?: boolean }
): boolean {
  return (
    Boolean(effectivePermissions?.readOnly) &&
    (classifyTool(toolName) === 'workspace_write' ||
      (MCP_APP_STATE_MUTATION_TOOLS as ReadonlySet<string>).has(toolName))
  )
}

/**
 * Group a list of tool names by class. Every class key is present (empty array
 * when none) so callers can render a stable layout; per-class order follows the
 * input order.
 */
export function groupToolsByClass(names: readonly string[]): Record<ToolClass, string[]> {
  const out: Record<ToolClass, string[]> = {
    workspace_read: [],
    web_read: [],
    orchestration: [],
    ui_elicitation: [],
    workspace_write: []
  }
  for (const name of names) out[classifyTool(name)].push(name)
  return out
}
