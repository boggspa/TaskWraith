import { describe, expect, it } from 'vitest'
import {
  MCP_AUTO_ALLOWED_TOOLS,
  MCP_APP_STATE_MUTATION_TOOLS,
  READ_ONLY_MCP_ADVERTISE_TOOLS,
  isReadOnlyAdvertisedTool
} from './McpAutoAllowedTools'

describe('MCP_AUTO_ALLOWED_TOOLS', () => {
  const autoAllowedTools = MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>

  it('auto-allows the workspace read tools (1.0.71+ read parity)', () => {
    for (const tool of [
      'read_file',
      'list_directory',
      'find_files',
      'workspace_search',
      'workspace_symbols',
      'list_chat_attachments',
      'inspect_chat_attachment',
      'workspace_board_snapshot',
      'workspace_board_preview_plan',
      'list_active_runs'
    ] as const) {
      expect(autoAllowedTools.has(tool)).toBe(true)
    }
  })

  it('SAFETY INVARIANT: never auto-allows a mutating / shell / patch tool', () => {
    // Membership SKIPS the host approval gate, so any of these in the set would
    // execute even under the read_only preset. They must always stay gated.
    for (const tool of [
      'write_file',
      'replace',
      'create_directory',
      'delete_path',
      'move_path',
      'rename_path',
      'apply_patch',
      'run_shell_command',
      'git_stage',
      'git_commit',
      'git_push',
      'git_create_pr',
      'run_task',
      'get_diagnostics',
      'cancel_active_run',
      'ensemble_bossman_control',
      'web_search',
      'web_fetch',
      'workspace_board_apply_plan',
      ...MCP_APP_STATE_MUTATION_TOOLS
    ]) {
      expect(autoAllowedTools.has(tool)).toBe(false)
    }
  })

  it('does not auto-allow git history reads that can expose repository history', () => {
    for (const tool of ['git_log', 'git_show', 'git_blame'] as const) {
      expect(autoAllowedTools.has(tool)).toBe(false)
    }
  })
})

describe('READ_ONLY_MCP_ADVERTISE_TOOLS', () => {
  it('advertises the safe coordination + read tools to a read-only seat', () => {
    for (const tool of [
      'ask_user_question',
      'ensemble_yield',
      'read_file',
      'find_files',
      'list_chat_attachments',
      'inspect_chat_attachment',
      'workspace_board_snapshot',
      'workspace_board_preview_plan',
      'list_active_runs'
    ] as const) {
      expect(READ_ONLY_MCP_ADVERTISE_TOOLS).toContain(tool)
    }
  })

  it('SAFETY INVARIANT: advertises NONE of the mutating floor', () => {
    for (const tool of [
      'write_file',
      'replace',
      'create_directory',
      'delete_path',
      'move_path',
      'rename_path',
      'apply_patch',
      'run_shell_command',
      'git_stage',
      'git_commit',
      'git_push',
      'git_create_pr',
      'run_task',
      'get_diagnostics',
      'cancel_active_run',
      'web_search',
      'web_fetch',
      'workspace_board_apply_plan',
      ...MCP_APP_STATE_MUTATION_TOOLS
    ]) {
      expect(READ_ONLY_MCP_ADVERTISE_TOOLS).not.toContain(tool)
    }
  })

  it('does not advertise git history reads to read-only gate-skipping seats', () => {
    for (const tool of ['git_log', 'git_show', 'git_blame'] as const) {
      expect(READ_ONLY_MCP_ADVERTISE_TOOLS).not.toContain(tool)
    }
  })

  it('is a strict subset of the gate-skip set (every advertised tool is auto-allowed)', () => {
    const autoAllowedTools = MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>
    for (const tool of READ_ONLY_MCP_ADVERTISE_TOOLS) {
      expect(autoAllowedTools.has(tool)).toBe(true)
    }
  })
})

describe('isReadOnlyAdvertisedTool (bridge scope guard)', () => {
  it('matches the safe coordination + read tools', () => {
    for (const tool of [
      'ask_user_question',
      'ensemble_yield',
      'read_file',
      'list_directory',
      'find_files',
      'list_chat_attachments',
      'inspect_chat_attachment',
      'workspace_board_snapshot',
      'workspace_board_preview_plan',
      'list_active_runs'
    ]) {
      expect(isReadOnlyAdvertisedTool(tool)).toBe(true)
    }
  })

  it('SAFETY: rejects every mutating-floor tool + unknown tools (the call-gate boundary)', () => {
    for (const tool of [
      'write_file',
      'replace',
      'create_directory',
      'delete_path',
      'move_path',
      'rename_path',
      'apply_patch',
      'run_shell_command',
      'git_stage',
      'git_commit',
      'git_push',
      'git_create_pr',
      'run_task',
      'get_diagnostics',
      'ensemble_send',
      'ensemble_fanout',
      'ensemble_bossman_control',
      'schedule_wakeup',
      'cancel_wakeup',
      'blackboard_post',
      'delegate_to_subthread',
      'cancel_active_run',
      'workspace_board_apply_plan',
      'web_search',
      'web_fetch',
      'totally_unknown_future_tool'
    ]) {
      expect(isReadOnlyAdvertisedTool(tool)).toBe(false)
    }
  })
})
