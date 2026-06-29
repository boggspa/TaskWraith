import { describe, expect, it } from 'vitest'
import { TASKWRAITH_MCP_TOOLS } from '../../../../main/TaskWraithMcpTools'
import { toolNameToFamily } from './ToolFamilyIcon'

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
    expect(toolNameToFamily('apply_patch')).toBe('edit')
    expect(toolNameToFamily('str_replace')).toBe('edit')
    expect(toolNameToFamily('multiedit')).toBe('edit')
  })

  // 1.0.4-AA — same coverage as file family above.
  it('maps no-separator writefile/editfile/createfile variants to edit', () => {
    expect(toolNameToFamily('writefile')).toBe('edit')
    expect(toolNameToFamily('editfile')).toBe('edit')
    expect(toolNameToFamily('createfile')).toBe('edit')
    expect(toolNameToFamily('deletefile')).toBe('edit')
    expect(toolNameToFamily('applypatch')).toBe('edit')
    expect(toolNameToFamily('strreplace')).toBe('edit')
    expect(toolNameToFamily('strreplaceeditor')).toBe('edit')
  })

  // 1.0.4-AA — Claude's plan-mode tool was rendering as
  // "Used exitplanmode" with no icon.
  it('maps exit_plan_mode + exitplanmode to the plan family', () => {
    expect(toolNameToFamily('exit_plan_mode')).toBe('plan')
    expect(toolNameToFamily('exitplanmode')).toBe('plan')
    expect(toolNameToFamily('ExitPlanMode')).toBe('plan')
  })

  it('maps ask_user_question + askuserquestion to the task family', () => {
    expect(toolNameToFamily('ask_user_question')).toBe('task')
    expect(toolNameToFamily('askuserquestion')).toBe('task')
  })

  it('maps git_* tools to the git family', () => {
    expect(toolNameToFamily('git_status')).toBe('git')
    expect(toolNameToFamily('git_diff')).toBe('git')
    expect(toolNameToFamily('git_log')).toBe('git')
    expect(toolNameToFamily('git_show')).toBe('git')
    expect(toolNameToFamily('git_blame')).toBe('git')
    expect(toolNameToFamily('git_stage')).toBe('git')
    expect(toolNameToFamily('git_commit')).toBe('git')
  })

  it('maps shell-execution tools to the shell family', () => {
    expect(toolNameToFamily('run_shell_command')).toBe('shell')
    expect(toolNameToFamily('shell')).toBe('shell')
  })

  it('maps workspace search/symbols to the search family', () => {
    expect(toolNameToFamily('find_files')).toBe('search')
    expect(toolNameToFamily('findfiles')).toBe('search')
    expect(toolNameToFamily('workspace_search')).toBe('search')
    expect(toolNameToFamily('workspace_symbols')).toBe('search')
  })

  it('maps task/test tools to the task family', () => {
    expect(toolNameToFamily('run_task')).toBe('task')
    expect(toolNameToFamily('test_result_summary')).toBe('task')
  })

  it('maps browser_* tools to the browser family', () => {
    expect(toolNameToFamily('browser_open')).toBe('browser')
    expect(toolNameToFamily('browser_click')).toBe('browser')
    expect(toolNameToFamily('browser_screenshot')).toBe('browser')
    expect(toolNameToFamily('browser_console')).toBe('browser')
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

  it('maps subthread inspection tools to the subthread family', () => {
    expect(toolNameToFamily('list_subthreads')).toBe('subthread')
    expect(toolNameToFamily('read_subthread_result')).toBe('subthread')
    expect(toolNameToFamily('cancel_subthread')).toBe('subthread')
    expect(toolNameToFamily('collabToolCall')).toBe('subthread')
  })

  it('maps diagnostic / status tools to the diagnostic family', () => {
    expect(toolNameToFamily('approval_status')).toBe('diagnostic')
    expect(toolNameToFamily('provider_auth_status')).toBe('diagnostic')
    expect(toolNameToFamily('get_diagnostics')).toBe('diagnostic')
    expect(toolNameToFamily('run_timeline')).toBe('diagnostic')
    expect(toolNameToFamily('raw_provider_events')).toBe('diagnostic')
    expect(toolNameToFamily('switch_auth_profile')).toBe('diagnostic')
    expect(toolNameToFamily('agent_delegation_role')).toBe('diagnostic')
    expect(toolNameToFamily('creative_app_status')).toBe('diagnostic')
    expect(toolNameToFamily('creative_app_capabilities')).toBe('diagnostic')
    expect(toolNameToFamily('creative_project_snapshot')).toBe('diagnostic')
    expect(toolNameToFamily('creative_timeline_validate')).toBe('diagnostic')
    expect(toolNameToFamily('creative_timeline_ir')).toBe('diagnostic')
    expect(toolNameToFamily('creative_timeline_diff')).toBe('diagnostic')
  })

  it('maps codex_reasoning / codex_plan to their dedicated families', () => {
    expect(toolNameToFamily('codex_reasoning')).toBe('reasoning')
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

  it('maps every TaskWraith MCP tool to a custom SVG family', () => {
    const unmapped = TASKWRAITH_MCP_TOOLS.filter((tool) => !toolNameToFamily(tool))

    expect(unmapped).toEqual([])
  })

  it('strips MCP namespace prefixes before matching', () => {
    expect(toolNameToFamily('mcp__TaskWraith__delegate_to_subthread')).toBe('delegate')
    expect(toolNameToFamily('mcp_TaskWraith_ensemble_yield')).toBe('yield')
    expect(toolNameToFamily('mcp__TaskWraith__creative_app_status')).toBe('diagnostic')
    expect(toolNameToFamily('mcp__TaskWraith__creative_timeline_validate')).toBe('diagnostic')
    expect(toolNameToFamily('mcp__TaskWraith__creative_timeline_ir')).toBe('diagnostic')
    expect(toolNameToFamily('mcp__TaskWraith__creative_timeline_diff')).toBe('diagnostic')
    expect(toolNameToFamily('mcp__server__write_file')).toBe('edit')
    expect(toolNameToFamily('TaskWraith__git_status')).toBe('git')
    expect(toolNameToFamily('taskwraith__read_file')).toBe('file')
  })

  it('is case-insensitive', () => {
    expect(toolNameToFamily('READ_FILE')).toBe('file')
    expect(toolNameToFamily('Git_Status')).toBe('git')
    expect(toolNameToFamily('MCP__TaskWraith__delegate_to_subthread')).toBe('delegate')
  })

  it('returns null for unknown tool names', () => {
    expect(toolNameToFamily('completely_unknown_tool')).toBeNull()
    expect(toolNameToFamily('xyzzy')).toBeNull()
    expect(toolNameToFamily('mcp__weird__nonsense')).toBeNull()
  })
})
