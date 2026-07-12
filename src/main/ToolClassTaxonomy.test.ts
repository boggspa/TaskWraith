import { describe, expect, it } from 'vitest'
import {
  classifyTool,
  groupToolsByClass,
  isReadOnlyBlockedTool,
  isNetworkAccessBlockedTool,
  READ_ONLY_TOOL_PRESET,
  TOOL_CLASS_LABELS,
  TOOL_CLASS_ORDER
} from './ToolClassTaxonomy'
import { TASKWRAITH_MCP_TOOLS } from './TaskWraithMcpTools'
import {
  MCP_APP_STATE_MUTATION_TOOLS,
  MCP_AUTO_ALLOWED_TOOLS,
  MCP_ENSEMBLE_PARTICIPATION_TOOLS
} from './mcp/McpAutoAllowedTools'

describe('classifyTool', () => {
  it('classifies each non-write class', () => {
    expect(classifyTool('read_file')).toBe('workspace_read')
    expect(classifyTool('find_files')).toBe('workspace_read')
    expect(classifyTool('list_chat_attachments')).toBe('workspace_read')
    expect(classifyTool('inspect_chat_attachment')).toBe('workspace_read')
    expect(classifyTool('grep')).toBe('workspace_read')
    expect(classifyTool('git_log')).toBe('workspace_read')
    expect(classifyTool('git_show')).toBe('workspace_read')
    expect(classifyTool('git_blame')).toBe('workspace_read')
    expect(classifyTool('workspace_board_snapshot')).toBe('orchestration')
    expect(classifyTool('workspace_board_preview_plan')).toBe('orchestration')
    expect(classifyTool('workspace_board_apply_plan')).toBe('orchestration')
    expect(classifyTool('list_background_processes')).toBe('orchestration')
    expect(classifyTool('read_background_process')).toBe('orchestration')
    expect(classifyTool('web_search')).toBe('web_read')
    expect(classifyTool('web_fetch')).toBe('web_read')
    expect(classifyTool('github_ci_status')).toBe('web_read')
    expect(classifyTool('ask_user_question')).toBe('ui_elicitation')
    expect(classifyTool('ensemble_yield')).toBe('orchestration')
    expect(classifyTool('provider_usage_status')).toBe('orchestration')
    expect(classifyTool('launch_list_targets')).toBe('orchestration')
    expect(classifyTool('launch_status')).toBe('orchestration')
    expect(classifyTool('blackboard_post')).toBe('orchestration')
    expect(classifyTool('blackboard_delete')).toBe('orchestration')
    // 1.0.4-AN — ensemble participation (vote/propose) is orchestration-class.
    expect(classifyTool('ensemble_poll_response')).toBe('orchestration')
    expect(classifyTool('ensemble_propose_goal_complete')).toBe('orchestration')
    // video_decode_frame = native daemon capture (like appwatch_latest_frame /
    // canvas_screenshot), non-mutating → orchestration, allowed under read-only.
    expect(classifyTool('video_decode_frame')).toBe('orchestration')
  })

  it('defaults unknown / mutating tools to workspace_write', () => {
    expect(classifyTool('write_file')).toBe('workspace_write')
    expect(classifyTool('apply_patch')).toBe('workspace_write')
    expect(classifyTool('run_shell_command')).toBe('workspace_write')
    expect(classifyTool('start_background_process')).toBe('workspace_write')
    expect(classifyTool('kill_background_process')).toBe('workspace_write')
    expect(classifyTool('get_diagnostics')).toBe('workspace_write')
    expect(classifyTool('something_brand_new')).toBe('workspace_write')
  })
})

describe('isNetworkAccessBlockedTool', () => {
  it('blocks web-read tools when the effective run posture denies network access', () => {
    const denied = { networkAccess: 'deny' }
    expect(isNetworkAccessBlockedTool('web_search', denied)).toBe(true)
    expect(isNetworkAccessBlockedTool('web_fetch', denied)).toBe(true)
    expect(isNetworkAccessBlockedTool('read_file', denied)).toBe(false)
    expect(isNetworkAccessBlockedTool('write_file', denied)).toBe(false)
  })

  it('treats the global network deny setting as stronger than a run-level allow', () => {
    expect(
      isNetworkAccessBlockedTool(
        'web_search',
        { networkAccess: 'allow' },
        { agenticServices: { networkAccess: 'deny' } }
      )
    ).toBe(true)
  })

  it('does not block web reads when network access is allowed', () => {
    expect(isNetworkAccessBlockedTool('web_search', { networkAccess: 'allow' })).toBe(false)
    expect(isNetworkAccessBlockedTool('web_fetch')).toBe(false)
  })
})

describe('tool-class safety invariant', () => {
  it('classifies every read-only preset tool as non-write', () => {
    for (const tool of READ_ONLY_TOOL_PRESET) {
      expect(classifyTool(tool)).not.toBe('workspace_write')
    }
  })

  it('classifies every auto-allowed (gate-skipping) tool as non-write', () => {
    for (const tool of MCP_AUTO_ALLOWED_TOOLS) {
      expect(classifyTool(tool)).not.toBe('workspace_write')
    }
  })
})

describe('groupToolsByClass', () => {
  it('groups names into every class key', () => {
    const grouped = groupToolsByClass([
      'read_file',
      'find_files',
      'list_chat_attachments',
      'inspect_chat_attachment',
      'web_search',
      'ask_user_question',
      'ensemble_yield',
      'write_file'
    ])
    expect(grouped.workspace_read).toEqual([
      'read_file',
      'find_files',
      'list_chat_attachments',
      'inspect_chat_attachment'
    ])
    expect(grouped.web_read).toEqual(['web_search'])
    expect(grouped.ui_elicitation).toEqual(['ask_user_question'])
    expect(grouped.orchestration).toEqual(['ensemble_yield'])
    expect(grouped.workspace_write).toEqual(['write_file'])
  })

  it('keeps labels + order in sync (every class has a label)', () => {
    expect(Object.keys(TOOL_CLASS_LABELS).sort()).toEqual([...TOOL_CLASS_ORDER].sort())
  })
})

describe('workspace_write is exactly the read-only deny set', () => {
  it('classifies precisely the mutating / side-effecting tools as workspace_write', () => {
    const writeTools = TASKWRAITH_MCP_TOOLS.filter((t) => classifyTool(t) === 'workspace_write')
    expect([...writeTools].sort()).toEqual(
      [
        'apply_patch',
        'audio_analyze',
        'audio_extract',
        'audio_mix',
        'audio_render_wav',
        'browser_click',
        'browser_open',
        'browser_screenshot',
        'cancel_active_run',
        'canvas_click',
        'canvas_eval',
        'canvas_fill',
        'canvas_open',
        'canvas_open_attachment',
        'canvas_open_launch',
        'canvas_render_html',
        'canvas_sketch_open',
        'canvas_sketch_update',
        'create_directory',
        'creative_applescript_dispatch',
        'creative_blender_python',
        'creative_midi_dispatch',
        'creative_timeline_import',
        'delete_path',
        'delegate_to_subthread',
        'get_diagnostics',
        'git_commit',
        'git_create_pr',
        'git_push',
        'git_stage',
        'image_edit',
        'image_generate',
        'launch_start',
        'launch_stop',
        'move_path',
        'rename_path',
        'replace',
        'run_shell_command',
        'run_task',
        'start_background_process',
        'svg_rasterize',
        'switch_auth_profile',
        'transcode_audio',
        'transcode_video',
        'video_concat_clips',
        'video_encode_clip',
        'video_probe',
        'video_thumbnail',
        'write_file',
        'kill_background_process'
      ].sort()
    )
  })

  it('never classifies a read / coordination tool as workspace_write', () => {
    for (const tool of [
      'read_file',
      'find_files',
      'list_chat_attachments',
      'inspect_chat_attachment',
      'web_search',
      'web_fetch',
      'github_ci_status',
      'git_status',
      'git_diff',
      'git_log',
      'git_show',
      'git_blame',
      'workspace_board_snapshot',
      'workspace_board_preview_plan',
      'workspace_board_apply_plan',
      'blackboard_post',
      'list_active_runs',
      'launch_list_targets',
      'launch_status',
      'canvas_sketch_get',
      'list_background_processes',
      'read_background_process',
      'test_result_summary',
      'read_subthread_result',
      'creative_timeline_validate',
      'video_decode_frame',
      'ensemble_yield',
      'ask_user_question'
    ]) {
      expect(classifyTool(tool)).not.toBe('workspace_write')
    }
  })
})

describe('isReadOnlyBlockedTool', () => {
  const ro = { readOnly: true }
  it('blocks mutating / side-effecting tools under read-only', () => {
    expect(isReadOnlyBlockedTool('creative_blender_python', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('write_file', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('switch_auth_profile', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('browser_open', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('workspace_board_apply_plan', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('blackboard_delete', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('cancel_active_run', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('start_background_process', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('kill_background_process', ro)).toBe(true)
    // Every app-state mutation tool stays blocked under read-only EXCEPT the two
    // audited participation tools (vote/propose) — the ratified read-only exception.
    for (const tool of MCP_APP_STATE_MUTATION_TOOLS) {
      if ((MCP_ENSEMBLE_PARTICIPATION_TOOLS as ReadonlySet<string>).has(tool)) continue
      expect(isReadOnlyBlockedTool(tool, ro)).toBe(true)
    }
  })

  it('exempts ONLY the two ensemble participation tools from the read-only deny (floor unchanged)', () => {
    // Read-only seats can vote / propose without a block (the all-participants ratification)…
    expect(isReadOnlyBlockedTool('ensemble_poll_response', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('ensemble_propose_goal_complete', ro)).toBe(false)
    // …but they REMAIN app-state mutations (route/workspace-lineage guard input preserved)…
    expect((MCP_APP_STATE_MUTATION_TOOLS as ReadonlySet<string>).has('ensemble_poll_response')).toBe(
      true
    )
    expect(
      (MCP_APP_STATE_MUTATION_TOOLS as ReadonlySet<string>).has('ensemble_propose_goal_complete')
    ).toBe(true)
    // …and every other app-state mutation + the fs/shell/workspace-write floor stays blocked.
    expect(isReadOnlyBlockedTool('ensemble_bossman_control', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('ensemble_roster_edit', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('blackboard_delete', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('write_file', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('run_shell_command', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('apply_patch', ro)).toBe(true)
  })

  it('never blocks reads / coordination, or anything when not read-only', () => {
    expect(isReadOnlyBlockedTool('read_file', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('find_files', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('web_search', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('workspace_board_snapshot', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('workspace_board_preview_plan', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('blackboard_post', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('todo_write', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('goal_update', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('list_active_runs', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('launch_list_targets', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('launch_status', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('list_background_processes', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('read_background_process', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('ensemble_yield', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('ask_user_question', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('write_file', { readOnly: false })).toBe(false)
    expect(isReadOnlyBlockedTool('write_file', undefined)).toBe(false)
  })
})
