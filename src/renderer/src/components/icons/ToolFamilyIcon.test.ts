import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TASKWRAITH_MCP_TOOLS } from '../../../../main/TaskWraithMcpTools'
import { ToolFamilyIcon, type ToolFamily, toolNameToFamily } from './ToolFamilyIcon'

/*
 * Pins the tool-name → icon-family mapping so a future tool addition
 * doesn't silently fall back to the legacy category icon. Each TaskWraith
 * MCP tool (and Codex-internal synthetic tool name) should resolve to
 * a recognisable family; unknown/empty names return null so the caller
 * can render its own fallback.
 */
describe('toolNameToFamily', () => {
  it('returns null for null / undefined / empty / whitespace input', () => {
    expect(toolNameToFamily(null)).toBeNull()
    expect(toolNameToFamily(undefined)).toBeNull()
    expect(toolNameToFamily('')).toBeNull()
    expect(toolNameToFamily('   ')).toBeNull()
  })

  it('maps file-reading tools to the file family', () => {
    expect(toolNameToFamily('read_file')).toBe('file')
    expect(toolNameToFamily('list_directory')).toBe('file')
    expect(toolNameToFamily('open_workspace_file')).toBe('file')
  })

  // 1.0.4-AA — no-separator variants emitted by Kimi + certain
  // MCP wrappers were falling through to the legacy category icon.
  it('maps no-separator readfile/listdirectory variants to file', () => {
    expect(toolNameToFamily('readfile')).toBe('file')
    expect(toolNameToFamily('listdirectory')).toBe('file')
    expect(toolNameToFamily('list_dir')).toBe('file')
    expect(toolNameToFamily('listdir')).toBe('file')
    expect(toolNameToFamily('openworkspacefile')).toBe('file')
  })

  it('maps edit / write tools to the edit family', () => {
    expect(toolNameToFamily('write_file')).toBe('edit')
    expect(toolNameToFamily('replace')).toBe('edit')
    expect(toolNameToFamily('edit_file')).toBe('edit')
    expect(toolNameToFamily('create_file')).toBe('edit')
    expect(toolNameToFamily('delete_file')).toBe('edit')
    expect(toolNameToFamily('create_directory')).toBe('edit')
    expect(toolNameToFamily('delete_path')).toBe('edit')
    expect(toolNameToFamily('move_path')).toBe('edit')
    expect(toolNameToFamily('rename_path')).toBe('edit')
    expect(toolNameToFamily('str_replace')).toBe('edit')
    expect(toolNameToFamily('multiedit')).toBe('edit')
  })

  // 1.0.4-AA — same coverage as file family above.
  it('maps no-separator writefile/editfile/createfile variants to edit', () => {
    expect(toolNameToFamily('writefile')).toBe('edit')
    expect(toolNameToFamily('editfile')).toBe('edit')
    expect(toolNameToFamily('createfile')).toBe('edit')
    expect(toolNameToFamily('deletefile')).toBe('edit')
    expect(toolNameToFamily('strreplace')).toBe('edit')
    expect(toolNameToFamily('strreplaceeditor')).toBe('edit')
  })

  it('maps patch tools to the patch family', () => {
    expect(toolNameToFamily('apply_patch')).toBe('patch')
    expect(toolNameToFamily('applypatch')).toBe('patch')
  })

  // 1.0.4-AA — Claude's plan-mode tool was rendering as
  // "Used exitplanmode" with no icon.
  it('maps exit_plan_mode + exitplanmode to the plan family', () => {
    expect(toolNameToFamily('exit_plan_mode')).toBe('plan')
    expect(toolNameToFamily('exitplanmode')).toBe('plan')
    expect(toolNameToFamily('ExitPlanMode')).toBe('plan')
  })

  it('maps ask_user_question + askuserquestion to the approval family', () => {
    expect(toolNameToFamily('ask_user_question')).toBe('approval')
    expect(toolNameToFamily('askuserquestion')).toBe('approval')
  })

  it('maps git_* tools to the git family', () => {
    expect(toolNameToFamily('git_status')).toBe('git')
    expect(toolNameToFamily('git_diff')).toBe('git')
    expect(toolNameToFamily('git_log')).toBe('git')
    expect(toolNameToFamily('git_show')).toBe('git')
    expect(toolNameToFamily('git_blame')).toBe('git')
    expect(toolNameToFamily('git_stage')).toBe('git')
    expect(toolNameToFamily('git_commit')).toBe('git')
    expect(toolNameToFamily('git_push')).toBe('git')
  })

  it('maps PR, merge, and CI tools to their semantic git-adjacent families', () => {
    expect(toolNameToFamily('git_create_pr')).toBe('pull-request')
    expect(toolNameToFamily('gitcreatepr')).toBe('pull-request')
    expect(toolNameToFamily('pull_request')).toBe('pull-request')
    expect(toolNameToFamily('git_merge')).toBe('merge')
    expect(toolNameToFamily('gitmerge')).toBe('merge')
    expect(toolNameToFamily('github_ci_status')).toBe('ci')
    expect(toolNameToFamily('ci_status')).toBe('ci')
  })

  it('maps shell-execution tools to the shell family', () => {
    expect(toolNameToFamily('run_shell_command')).toBe('shell')
    expect(toolNameToFamily('runshellcommand')).toBe('shell')
    expect(toolNameToFamily('shell')).toBe('shell')
    expect(toolNameToFamily('bash')).toBe('shell')
    expect(toolNameToFamily('run_terminal_command')).toBe('shell')
    expect(toolNameToFamily('terminal')).toBe('shell')
  })

  it('maps process and launch lifecycle tools to their own families', () => {
    expect(toolNameToFamily('start_background_process')).toBe('process')
    expect(toolNameToFamily('read_background_process')).toBe('process')
    expect(toolNameToFamily('kill_background_process')).toBe('process')
    expect(toolNameToFamily('launch_start')).toBe('launch')
    expect(toolNameToFamily('launch_status')).toBe('launch')
  })

  it('maps chat attachment tools to the file family', () => {
    expect(toolNameToFamily('list_chat_attachments')).toBe('file')
    expect(toolNameToFamily('inspect_chat_attachment')).toBe('file')
  })

  it('maps workspace search/symbols to the search family', () => {
    expect(toolNameToFamily('grep')).toBe('search')
    expect(toolNameToFamily('rg')).toBe('search')
    expect(toolNameToFamily('glob')).toBe('search')
    expect(toolNameToFamily('grep_search')).toBe('search')
    expect(toolNameToFamily('find_files')).toBe('search')
    expect(toolNameToFamily('findfiles')).toBe('search')
    expect(toolNameToFamily('workspace_search')).toBe('search')
    expect(toolNameToFamily('workspace_symbols')).toBe('search')
    expect(toolNameToFamily('file_search')).toBe('search')
  })

  it('maps task/test tools to the task family', () => {
    expect(toolNameToFamily('run_task')).toBe('task')
    expect(toolNameToFamily('list_active_runs')).toBe('task')
    expect(toolNameToFamily('cancel_active_run')).toBe('task')
    expect(toolNameToFamily('test_result_summary')).toBe('task')
  })

  it('maps browser_* tools to the browser family', () => {
    expect(toolNameToFamily('browser_open')).toBe('browser')
    expect(toolNameToFamily('browser_click')).toBe('browser')
    expect(toolNameToFamily('browser_screenshot')).toBe('browser')
    expect(toolNameToFamily('browser_console')).toBe('browser')
  })

  it('maps canvas tools to the canvas family', () => {
    expect(toolNameToFamily('canvas_open')).toBe('canvas')
    expect(toolNameToFamily('canvas_screenshot')).toBe('canvas')
    expect(toolNameToFamily('canvas_eval')).toBe('canvas')
  })

  it('maps media tools to image/audio/video families', () => {
    expect(toolNameToFamily('image_generate')).toBe('image')
    expect(toolNameToFamily('svg_rasterize')).toBe('image')
    expect(toolNameToFamily('audio_analyze')).toBe('audio')
    expect(toolNameToFamily('transcribe_audio')).toBe('audio')
    expect(toolNameToFamily('video_probe')).toBe('video')
    expect(toolNameToFamily('video_thumbnail')).toBe('video')
  })

  it('maps attached_window_* tools to window-context (Appshots)', () => {
    expect(toolNameToFamily('attached_window_capture')).toBe('window-context')
    expect(toolNameToFamily('attached_window_status')).toBe('window-context')
  })

  it('maps delegate_to_subthread to the delegate family', () => {
    expect(toolNameToFamily('delegate_to_subthread')).toBe('delegate')
  })

  it('maps ensemble_yield to its dedicated yield family', () => {
    expect(toolNameToFamily('ensemble_yield')).toBe('yield')
  })

  it('maps ensemble fan-out, roster, blackboard, and wakeup tools to semantic families', () => {
    expect(toolNameToFamily('ensemble_send')).toBe('fanout')
    expect(toolNameToFamily('ensemble_fanout')).toBe('fanout')
    expect(toolNameToFamily('list_ensemble_participants')).toBe('roster')
    expect(toolNameToFamily('ensemble_roster_edit')).toBe('roster')
    expect(toolNameToFamily('scout_brief')).toBe('roster')
    expect(toolNameToFamily('blackboard_post')).toBe('blackboard')
    expect(toolNameToFamily('blackboard_read')).toBe('blackboard')
    expect(toolNameToFamily('schedule_wakeup')).toBe('wakeup')
    expect(toolNameToFamily('cancel_wakeup')).toBe('wakeup')
  })

  it('maps subthread inspection tools to the subthread family', () => {
    expect(toolNameToFamily('list_subthreads')).toBe('subthread')
    expect(toolNameToFamily('read_subthread_result')).toBe('subthread')
    expect(toolNameToFamily('cancel_subthread')).toBe('subthread')
    expect(toolNameToFamily('collabToolCall')).toBe('subthread')
  })

  it('maps approval and status tools to their semantic families', () => {
    expect(toolNameToFamily('approval_status')).toBe('approval')
    expect(toolNameToFamily('provider_auth_status')).toBe('status')
    expect(toolNameToFamily('provider_usage_status')).toBe('status')
    expect(toolNameToFamily('get_diagnostics')).toBe('status')
    expect(toolNameToFamily('run_timeline')).toBe('status')
    expect(toolNameToFamily('raw_provider_events')).toBe('status')
    expect(toolNameToFamily('switch_auth_profile')).toBe('status')
    expect(toolNameToFamily('agent_delegation_role')).toBe('status')
    expect(toolNameToFamily('creative_app_status')).toBe('status')
    expect(toolNameToFamily('creative_app_capabilities')).toBe('status')
    expect(toolNameToFamily('creative_project_snapshot')).toBe('status')
  })

  it('maps creative timeline tools to the diagnostic family', () => {
    expect(toolNameToFamily('creative_timeline_validate')).toBe('diagnostic')
    expect(toolNameToFamily('creative_timeline_ir')).toBe('diagnostic')
    expect(toolNameToFamily('creative_timeline_diff')).toBe('diagnostic')
    expect(toolNameToFamily('creative_applescript_dispatch')).toBe('diagnostic')
  })

  it('maps memory and audit tools to their semantic families', () => {
    expect(toolNameToFamily('tw_recall_find')).toBe('memory')
    expect(toolNameToFamily('tw_recall_read')).toBe('memory')
    expect(toolNameToFamily('tw_introspection_run')).toBe('audit')
    expect(toolNameToFamily('tw_introspection_review')).toBe('audit')
    expect(toolNameToFamily('coherence_gate_check')).toBe('audit')
    expect(toolNameToFamily('completion_claim_check')).toBe('audit')
    expect(toolNameToFamily('evidence_pack_write')).toBe('audit')
  })

  it('maps Project reference proposals to the plan family', () => {
    expect(toolNameToFamily('project_reference_propose')).toBe('plan')
  })

  it('maps thinking/reasoning traces and codex_plan to their dedicated families', () => {
    expect(toolNameToFamily('codex_reasoning')).toBe('reasoning')
    expect(toolNameToFamily('thinking')).toBe('reasoning')
    expect(toolNameToFamily('kimi_thinking')).toBe('reasoning')
    expect(toolNameToFamily('grok_thinking')).toBe('reasoning')
    expect(toolNameToFamily('cursor_thinking')).toBe('reasoning')
    expect(toolNameToFamily('mcp__TaskWraith__gemini_reasoning')).toBe('reasoning')
    expect(toolNameToFamily('codex_plan')).toBe('plan')
  })

  it('maps todo_write goal-step tools to the plan family', () => {
    expect(toolNameToFamily('todo_write')).toBe('plan')
    expect(toolNameToFamily('update_todo_list')).toBe('plan')
    expect(toolNameToFamily('mcp__TaskWraith__todo_write')).toBe('plan')
  })

  it('maps create_handoff_card to the handoff family', () => {
    expect(toolNameToFamily('create_handoff_card')).toBe('handoff')
  })

  it('maps generic MCP/dynamic tool placeholders to the mcp family', () => {
    expect(toolNameToFamily('mcp_tool')).toBe('mcp')
    expect(toolNameToFamily('dynamic_tool')).toBe('mcp')
  })

  it('maps a bare `mcp` base + raw call wrappers to the mcp family', () => {
    // Cursor's brokered call can arrive with the inner tool name unstripped.
    expect(toolNameToFamily('mcp')).toBe('mcp')
    expect(toolNameToFamily('MCP')).toBe('mcp')
    expect(toolNameToFamily('callMcpTool')).toBe('mcp')
    expect(toolNameToFamily('use_tool')).toBe('mcp')
  })

  it('falls back to the mcp family for a namespaced-but-unmatched MCP tool', () => {
    // Was null (undecorated) — a brokered call reads better as an MCP plug icon.
    expect(toolNameToFamily('mcp__weird__nonsense')).toBe('mcp')
    expect(toolNameToFamily('mcp_taskwraith-broker-some_new_tool')).toBe('mcp')
    expect(toolNameToFamily('taskwraith__brand_new_tool')).toBe('mcp')
  })

  it('maps every TaskWraith MCP tool to a custom SVG family', () => {
    const unmapped = TASKWRAITH_MCP_TOOLS.filter((tool) => !toolNameToFamily(tool))

    expect(unmapped).toEqual([])
  })

  it('strips MCP namespace prefixes before matching', () => {
    expect(toolNameToFamily('mcp__TaskWraith__delegate_to_subthread')).toBe('delegate')
    expect(toolNameToFamily('mcp_TaskWraith_ensemble_yield')).toBe('yield')
    expect(toolNameToFamily('mcp__TaskWraith__creative_app_status')).toBe('status')
    expect(toolNameToFamily('mcp__TaskWraith__creative_timeline_validate')).toBe('diagnostic')
    expect(toolNameToFamily('mcp__TaskWraith__creative_timeline_ir')).toBe('diagnostic')
    expect(toolNameToFamily('mcp__TaskWraith__creative_timeline_diff')).toBe('diagnostic')
    expect(toolNameToFamily('mcp__server__write_file')).toBe('edit')
    expect(toolNameToFamily('TaskWraith__git_status')).toBe('git')
    expect(toolNameToFamily('taskwraith__read_file')).toBe('file')
    expect(toolNameToFamily('mcp_taskwraith-broker-read_file')).toBe('file')
    expect(toolNameToFamily('mcp_taskwraith-broker_write_file')).toBe('edit')
    expect(toolNameToFamily('mcp_taskwraith-run_shell_command')).toBe('shell')
    expect(toolNameToFamily('taskwraith-broker__git_status')).toBe('git')
  })

  it('renders every declared custom family as an inline SVG', () => {
    const families: ToolFamily[] = [
      'file',
      'edit',
      'patch',
      'git',
      'pull-request',
      'merge',
      'ci',
      'shell',
      'process',
      'launch',
      'search',
      'task',
      'mcp',
      'browser',
      'window-context',
      'canvas',
      'image',
      'audio',
      'video',
      'delegate',
      'yield',
      'fanout',
      'subthread',
      'roster',
      'blackboard',
      'wakeup',
      'diagnostic',
      'memory',
      'audit',
      'approval',
      'status',
      'reasoning',
      'plan',
      'handoff'
    ]

    for (const family of families) {
      const markup = renderToStaticMarkup(createElement(ToolFamilyIcon, { family }))
      expect(markup).toContain('<svg')
    }
  })

  it('is case-insensitive', () => {
    expect(toolNameToFamily('READ_FILE')).toBe('file')
    expect(toolNameToFamily('Git_Status')).toBe('git')
    expect(toolNameToFamily('MCP__TaskWraith__delegate_to_subthread')).toBe('delegate')
  })

  it('returns null for unknown, NON-namespaced tool names', () => {
    expect(toolNameToFamily('completely_unknown_tool')).toBeNull()
    expect(toolNameToFamily('xyzzy')).toBeNull()
  })
})
