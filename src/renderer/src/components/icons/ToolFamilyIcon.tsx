/*
 * ToolFamilyIcon — hand-drawn monoline SVG icon per tool family.
 *
 * Source of truth for the path geometry:
 * `design-assets/tool-call-icons/tool-call-icons.catalog.svg`. The
 * catalog is the designer-friendly file (all 16 icons on one canvas
 * for cohesion review); this component
 * inlines the same path data switched on a `family` prop so the
 * runtime never has to load 16 separate SVG files.
 *
 * Sized to ~13px by default to match the existing `ToolCategoryIcon`
 * footprint in the activity card header. All icons use `currentColor`
 * so they inherit text color and adapt to whichever theme is active.
 *
 * Tool-name → family mapping lives in `toolNameToFamily` below.
 * Unknown tools fall through to the caller's category fallback
 * (typically the legacy `ToolCategoryIcon`).
 */
import type { CSSProperties, ReactElement } from 'react'

export type ToolFamily =
  | 'file'
  | 'edit'
  | 'git'
  | 'shell'
  | 'search'
  | 'task'
  | 'mcp'
  | 'browser'
  | 'window-context'
  | 'delegate'
  | 'yield'
  | 'subthread'
  | 'diagnostic'
  | 'reasoning'
  | 'plan'
  | 'handoff'

interface ToolFamilyIconProps {
  family: ToolFamily | null | undefined
  size?: number
  className?: string
  style?: CSSProperties
  title?: string
}

/**
 * Map an MCP / Codex / Gemini tool name to its visual family. Covers
 * the TaskWraith MCP tool surface (see `TaskWraithMcpTools.ts`) plus
 * Codex-internal item types (`commandExecution`, `fileChange`,
 * `mcpToolCall`, `codex_reasoning`, `codex_plan`, `collabToolCall`).
 *
 * Returns `null` for unknown names so the caller can fall back to its
 * category-icon (legacy) treatment instead of rendering a wrong icon.
 *
 * The matching is case-insensitive and strips common MCP namespace
 * prefixes (`TaskWraith__`, `mcp__TaskWraith__`, `mcp__<server>__`) so the
 * function works regardless of which provider stamped the call.
 */
export function toolNameToFamily(name: string | undefined | null): ToolFamily | null {
  if (!name) return null
  let normalised = name.toLowerCase().trim()
  if (!normalised) return null

  // Strip MCP-namespacing — `mcp__TaskWraith__delegate_to_subthread` etc.
  if (normalised.startsWith('mcp__')) {
    const idx = normalised.indexOf('__', 5)
    if (idx > 5) normalised = normalised.slice(idx + 2)
  } else if (normalised.startsWith('mcp_')) {
    const knownServerPrefixes = ['mcp_taskwraith_']
    for (const prefix of knownServerPrefixes) {
      if (normalised.startsWith(prefix)) {
        normalised = normalised.slice(prefix.length)
        break
      }
    }
  } else if (normalised.startsWith('taskwraith__')) {
    normalised = normalised.slice('taskwraith__'.length)
  } else if (normalised.startsWith('taskwraith_')) {
    normalised = normalised.slice('taskwraith_'.length)
  }

  // Exact-name buckets (most specific first).
  switch (normalised) {
    case 'delegate_to_subthread':
      return 'delegate'
    case 'ensemble_yield':
      return 'yield'
    case 'list_subthreads':
    case 'read_subthread_result':
    case 'cancel_subthread':
    case 'collabtoolcall':
      return 'subthread'
    case 'attached_window_capture':
    case 'attached_window_status':
      return 'window-context'
    case 'create_handoff_card':
    case 'open_in_ide':
    case 'open_in_ide_at_position':
    case 'reveal_in_finder':
    case 'ide_app_status':
    case 'ide_app_capabilities':
    case 'list_running_ides':
      return 'handoff'
    case 'run_task':
    case 'list_active_runs':
    case 'cancel_active_run':
    case 'test_result_summary':
    case 'schedule_wakeup':
    case 'cancel_wakeup':
    case 'scout_brief':
    case 'blackboard_post':
    case 'launch_list_targets':
    case 'launch_start':
    case 'launch_stop':
    case 'launch_status':
      return 'task'
    case 'start_background_process':
    case 'list_background_processes':
    case 'read_background_process':
    case 'kill_background_process':
      return 'shell'
    case 'list_chat_attachments':
    case 'inspect_chat_attachment':
      return 'file'
    case 'workspace_search':
    case 'find_files':
    case 'findfiles':
      return 'search'
    case 'workspace_symbols':
      return 'search'
    case 'web_search':
      return 'search'
    case 'web_fetch':
      return 'browser'
    case 'codex_plan':
    case 'goal_read':
    case 'goal_update':
    case 'update_goal':
    case 'goal_complete':
    case 'goal_blocked':
    case 'todo_write':
    case 'todowrite':
    case 'update_todo_list':
    case 'updatetodolist':
    case 'plan':
    case 'exit_plan_mode':
    case 'exitplanmode':
    case 'exitplan_mode':
    case 'exit_planmode':
      return 'plan'
    case 'ask_user_question':
    case 'askuserquestion':
      return 'task'
    case 'reasoning':
    case 'thinking':
    case 'codex_reasoning':
      return 'reasoning'
    case 'approval_status':
    case 'provider_auth_status':
    case 'run_timeline':
    case 'raw_provider_events':
    case 'get_diagnostics':
    case 'switch_auth_profile':
    case 'agent_delegation_role':
    case 'creative_app_status':
    case 'creative_app_capabilities':
    case 'creative_project_snapshot':
    case 'creative_timeline_validate':
    case 'creative_timeline_ir':
    case 'creative_timeline_diff':
    case 'creative_timeline_import':
    case 'creative_applescript_dispatch':
    case 'creative_blender_python':
    case 'creative_midi_dispatch':
    case 'provider_usage_status':
    case 'video_probe':
      return 'diagnostic'
    case 'image_edit':
    case 'svg_rasterize':
    case 'image_generate':
    case 'audio_render_wav':
    case 'audio_analyze':
    case 'video_thumbnail':
    case 'video_decode_frame':
    case 'video_encode_clip':
    case 'video_concat_clips':
    case 'audio_mix':
    case 'audio_extract':
    case 'transcode_audio':
    case 'transcode_video':
    case 'inspect_video_frames':
    case 'inspect_audio_segment':
    case 'transcribe_audio':
      return 'edit'
    case 'mcp_tool':
    case 'dynamic_tool':
      return 'mcp'
  }

  // Pattern buckets — order matters (more-specific patterns first).
  if (normalised.endsWith('_thinking') || normalised.endsWith('_reasoning')) return 'reasoning'
  if (normalised.startsWith('git_') || normalised === 'git') return 'git'
  if (normalised.startsWith('browser_') || normalised.startsWith('canvas_')) return 'browser'
  if (normalised.startsWith('tw_recall_')) return 'search'
  if (normalised.startsWith('workspace_board_')) return 'plan'
  if (normalised.startsWith('appwatch_')) return 'window-context'
  if (normalised.startsWith('ensemble_') || normalised === 'list_ensemble_participants') {
    return 'yield'
  }
  if (normalised === 'run_shell_command' || normalised === 'shell') return 'shell'
  if (
    // 1.0.4-AA — handle no-separator variants alongside snake_case
    // canonicals. Kimi + some MCP wrappers strip underscores so
    // `writefile`/`editfile`/`createfile`/`deletefile`/`applypatch`/
    // `strreplace` were falling through to the null fallback and
    // showing the legacy category icon.
    normalised === 'write_file' ||
    normalised === 'writefile' ||
    normalised === 'replace' ||
    normalised === 'edit_file' ||
    normalised === 'editfile' ||
    normalised === 'edit' ||
    normalised === 'create_file' ||
    normalised === 'createfile' ||
    normalised === 'delete_file' ||
    normalised === 'deletefile' ||
    normalised === 'create_directory' ||
    normalised === 'createdirectory' ||
    normalised === 'delete_path' ||
    normalised === 'deletepath' ||
    normalised === 'move_path' ||
    normalised === 'movepath' ||
    normalised === 'rename_path' ||
    normalised === 'renamepath' ||
    normalised === 'apply_patch' ||
    normalised === 'applypatch' ||
    normalised === 'str_replace' ||
    normalised === 'strreplace' ||
    normalised === 'str_replace_editor' ||
    normalised === 'strreplaceeditor' ||
    normalised === 'multiedit' ||
    normalised === 'notebookedit'
  ) {
    return 'edit'
  }
  if (
    // 1.0.4-AA — mirror the read-category aliases now recognised
    // by ToolParser.getToolCategory (READ_LIKE_TOOL_NAMES). Without
    // these the activity row dropped back to the generic category
    // icon for `readfile` etc.
    normalised === 'read_file' ||
    normalised === 'readfile' ||
    normalised === 'read' ||
    normalised === 'list_directory' ||
    normalised === 'listdirectory' ||
    normalised === 'list_dir' ||
    normalised === 'listdir' ||
    normalised === 'open_workspace_file' ||
    normalised === 'openworkspacefile'
  ) {
    return 'file'
  }

  return null
}

/**
 * The 16 hand-drawn monoline icons. Paths are copy-pasted from
 * `design-assets/tool-call-icons/tool-call-icons.catalog.svg` (the
 * designer source of truth).
 *
 * Each branch returns a `<g>` of paths — the wrapping `<svg>` lives
 * in the component shell so size/title/aria props apply uniformly.
 *
 * Stroke width 1.65 matches the catalog. Inheriting `currentColor`
 * means a parent `color:` rule or a CSS variable on the activity row
 * (e.g. `--provider-color-codex`) flows through automatically.
 */
function FamilyPaths({ family }: { family: ToolFamily }): ReactElement {
  switch (family) {
    case 'file':
      return (
        <g>
          <path d="M7.2 3.3 15.7 3 20.2 7.4 20 20.8 6.7 20.5 6.3 4.2Z" />
          <path d="M15.4 3.2 15.8 7.7 20 7.4" />
          <path d="M4.2 6.1 4.5 21.4 16.6 21.1" />
          <path d="M9.1 10.1 17.1 9.8" />
          <path d="M9.2 13.3 16.4 13.2" />
          <path d="M9.1 16.5 14.2 16.7" />
        </g>
      )
    case 'edit':
      return (
        <g>
          <path d="M5 6.1 16.6 5.4 18.8 16.9 6.3 18.5Z" />
          <path d="M7.3 6.1 7.1 8.1" />
          <path d="M10.5 5.8 10.4 7.8" />
          <path d="M13.8 5.6 13.8 7.5" />
          <path d="M6.2 15.4 8.2 15.2" />
          <path d="M16.5 7.3 19.6 10.1 11.6 18.7 8.2 19.5 9.1 16.2Z" />
          <path d="M14.9 9.1 18 12.1" />
        </g>
      )
    case 'git':
      return (
        <g>
          <path d="M7.1 5.2C9.6 8 12 10.4 16.9 15.2" />
          <path d="M7.4 18.6C9.4 14.8 9.7 12.4 8 8.3" />
          <path d="M9.7 10.6C11.8 9.9 13.5 8.8 15.4 6.6" />
          <circle cx="6.4" cy="4.7" r="2.2" />
          <circle cx="16.4" cy="6.1" r="2.2" />
          <circle cx="17.8" cy="16.3" r="2.2" />
          <circle cx="6.5" cy="19" r="2.2" />
        </g>
      )
    case 'shell':
      return (
        <g>
          <path d="M3.7 5.1 20.4 4.8 20.9 18.7 3.2 19.1Z" />
          <path d="M4.2 8.2 20.3 8" />
          <path d="M7.1 11.1 10.4 13.5 7.2 15.9" />
          <path d="M12.8 16.2 17.4 16.1" />
          <path d="M6.2 6.6 6.2 6.7" />
          <path d="M8.4 6.5 8.5 6.6" />
        </g>
      )
    case 'search':
      return (
        <g>
          <path d="M4.2 5.2 14.6 4.9" />
          <path d="M4.1 8.4 11.4 8.2" />
          <path d="M4.4 11.8 9.6 11.6" />
          <circle cx="12.3" cy="12.4" r="4.7" />
          <path d="M15.8 15.9 20 20.3" />
          <path d="M10.7 12.1 13.8 11.9" />
        </g>
      )
    case 'task':
      return (
        <g>
          <path d="M5.2 4.1 18.8 4.5 18.4 19.5 5.4 19.1Z" />
          <path d="M8 8.2 9.5 9.7 12.1 7.1" />
          <path d="M13.8 8.5 16.5 8.4" />
          <path d="M8 13.9 9.4 15.2 12 12.6" />
          <path d="M13.5 14.1 16.8 14" />
          <path d="M8.1 17.1 10.5 17" />
          <path d="M13.4 17.1 16.1 17" />
          <path d="M7.1 4.2 7.3 2.8 16.3 3.1 16.5 4.4" />
        </g>
      )
    case 'mcp':
      return (
        <g>
          <path d="M9.3 8.5 14.9 8.6 14.8 14.1C14.7 16.3 13.3 17.6 11.6 17.6 9.8 17.5 8.7 16.1 8.8 14.2Z" />
          <path d="M10.1 4.5 10.1 8.2" />
          <path d="M14.1 4.4 13.9 8.3" />
          <path d="M11.8 17.6 11.7 20.5" />
          <path d="M6.3 12.1 8.8 12.1" />
          <path d="M15 12.1 17.8 12.2" />
          <circle cx="4.6" cy="12" r="1.4" />
          <circle cx="19.5" cy="12.3" r="1.4" />
        </g>
      )
    case 'browser':
      return (
        <g>
          <path d="M3.8 5.2 20.6 5 20.3 18.6 4 18.9Z" />
          <path d="M4.1 8.3 20.2 8.1" />
          <path d="M6.4 6.7 6.5 6.8" />
          <path d="M8.7 6.6 8.8 6.7" />
          <path d="M10.8 11.1 15.7 16.5 13.1 16 12.2 18.3 9.9 12.2Z" />
          <path d="M16.4 10.9 18.8 10.9 18.7 13.2" />
          <path d="M17.4 11.9 18.8 10.9" />
        </g>
      )
    case 'window-context':
      return (
        <g>
          <path d="M4 5.1 20.2 4.9 20 18.8 4.3 19.1Z" />
          <path d="M4.4 8.2 19.8 8" />
          <path d="M7.1 12.1 7.1 9.8 9.3 9.8" />
          <path d="M16.8 9.8 19 9.8 18.9 12" />
          <path d="M18.8 15.6 18.8 17.4 16.6 17.4" />
          <path d="M9.4 17.4 7.2 17.4 7.2 15.5" />
          <path d="M11.2 12.2 15.2 14.2 12.3 15.9Z" />
        </g>
      )
    case 'delegate':
      return (
        <g>
          <path d="M3.6 5.5 11.3 5.2 11.5 12.5 3.8 12.8Z" />
          <path d="M12.8 11.6 20.4 11.3 20.2 18.7 12.9 19Z" />
          <path d="M8.1 13.9C9.8 16.6 10.5 16.8 12.7 15.8" />
          <path d="M10.9 14.1 12.8 15.8 10.8 17.2" />
          <path d="M5.8 8 9.1 7.9" />
          <path d="M15 14.3 18.3 14.2" />
        </g>
      )
    case 'yield':
      return (
        <g>
          <path d="M4.1 5.7 12.5 5.4C15.9 5.4 18.8 7.7 19 11.1 19.3 15.1 16.2 18.4 12.2 18.4H7.4" />
          <path d="M8.4 3.5 4.2 5.8 8.6 8" />
          <path d="M7.1 18.4 9.6 15.8" />
          <path d="M7.1 18.4 9.8 20.9" />
          <path d="M11.3 10.3 15.4 10.2" />
          <path d="M11.2 13.4 14.2 13.3" />
        </g>
      )
    case 'subthread':
      return (
        <g>
          <path d="M4.4 4.8 15.3 4.5 15.4 10.6 5 10.9Z" />
          <path d="M7.3 10.8 6.1 12.9 9.2 10.8" />
          <path d="M7.6 7.6 12.6 7.4" />
          <path d="M8.5 12.9 19.5 12.6 19 18.7 8.9 19Z" />
          <path d="M12 18.9 10.5 21.1 14 18.9" />
          <path d="M11.3 15.8 16.7 15.6" />
          <path d="M3.2 7.2 2.7 7.2 2.9 16 6.2 16" />
        </g>
      )
    case 'diagnostic':
      return (
        <g>
          <path d="M4.3 15.8C4.8 9.8 8.1 6 12.1 6c4.2 0 7.1 3.7 7.6 9.6" />
          <path d="M6.7 16.6 17.3 16.5" />
          <path d="M12.2 14.8 15.8 10.4" />
          <path d="M7.2 13.3 8.7 12.7" />
          <path d="M11.8 8.4 11.8 10" />
          <path d="M16.8 13.3 15.3 12.7" />
          <path d="M7.8 19.5C7.8 21.2 10.2 21.2 10.2 19.5V16.6" />
          <path d="M16.1 16.6V19.5C16.1 21.3 18.7 21.2 18.7 19.4" />
        </g>
      )
    case 'reasoning':
      return (
        <g>
          <path d="M8.1 13.3C6.5 12.1 5.7 10.4 5.9 8.6 6.2 5.8 8.6 3.9 11.8 3.8 15.1 3.8 17.6 5.8 17.8 8.7 17.9 10.6 17 12.2 15.3 13.4 14.4 14.1 14.1 14.8 14 15.8L9.9 15.9C9.8 14.8 9.2 14.1 8.1 13.3Z" />
          <path d="M9.7 18 14.4 17.8" />
          <path d="M10.2 20.2 13.7 20.1" />
          <path d="M10.4 15.8 10.2 12.6 13.7 12.4 13.8 15.7" />
          <path d="M10.4 12.6C10.2 11.1 11.1 10.1 12.1 10.1 13.2 10.1 14 11 13.7 12.4" />
          <path d="M12 1.8 12 3" />
          <path d="M4.5 4.6 5.5 5.6" />
          <path d="M19.6 4.5 18.5 5.6" />
          <path d="M3.2 10.2 4.6 10.2" />
          <path d="M19.3 10.1 20.8 10" />
        </g>
      )
    case 'plan':
      return (
        <g>
          <path d="M4.2 5.3 9.3 3.9 14.7 5.4 19.8 4.2 19.3 18.5 14.2 19.9 9 18.3 4 19.5Z" />
          <path d="M9.3 3.9 9 18.3" />
          <path d="M14.7 5.4 14.2 19.9" />
          <path d="M16.4 8.1 16.4 13.9" />
          <path d="M16.4 8.1 19 9.3 16.4 10.7" />
          <path d="M6.3 9.4 8.1 9" />
          <path d="M5.9 13.2 7.7 12.8" />
        </g>
      )
    case 'handoff':
      return (
        <g>
          <path d="M4.9 5.5 19.2 5.2 19 18.6 5.2 18.9Z" />
          <circle cx="8.8" cy="9.3" r="1.25" />
          <path d="M6.9 12.4C7.7 11.2 9.8 11.1 10.8 12.2" />
          <circle cx="15.7" cy="9.2" r="1.25" />
          <path d="M13.8 12.3C14.7 11.2 16.6 11.1 17.6 12.1" />
          <path d="M8.3 15.6 14.9 15.5" />
          <path d="M13.3 14.1 15 15.5 13.3 17" />
          <path d="M3.1 13.9C4.1 13.3 4.7 13.1 5.5 13.2" />
          <path d="M20.8 10.8C20.1 11.6 19.6 12 18.9 12.2" />
        </g>
      )
  }
}

/**
 * Render the tool-family icon. Returns `null` when `family` is null
 * or undefined — caller should render its own fallback in that case
 * (typically the legacy category-based icon).
 */
export function ToolFamilyIcon({
  family,
  size = 13,
  className,
  style,
  title
}: ToolFamilyIconProps): ReactElement | null {
  if (!family) return null
  return (
    <svg
      className={className ?? 'tool-family-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      style={style}
    >
      {title ? <title>{title}</title> : null}
      <FamilyPaths family={family} />
    </svg>
  )
}
