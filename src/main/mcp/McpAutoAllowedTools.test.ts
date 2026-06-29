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
      'workspace_board_snapshot',
      'workspace_board_preview_plan'
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
      'apply_patch',
      'run_shell_command',
      'git_stage',
      'git_commit',
      'run_task',
      'ensemble_bossman_control',
      'web_search',
      'web_fetch',
      'workspace_board_apply_plan',
      ...MCP_APP_STATE_MUTATION_TOOLS
    ]) {
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
      'workspace_board_snapshot',
      'workspace_board_preview_plan'
    ] as const) {
      expect(READ_ONLY_MCP_ADVERTISE_TOOLS).toContain(tool)
    }
  })

  it('SAFETY INVARIANT: advertises NONE of the mutating floor', () => {
    for (const tool of [
      'write_file',
      'replace',
      'apply_patch',
      'run_shell_command',
      'git_stage',
      'git_commit',
      'run_task',
      'web_search',
      'web_fetch',
      'workspace_board_apply_plan',
      ...MCP_APP_STATE_MUTATION_TOOLS
    ]) {
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
      'workspace_board_snapshot',
      'workspace_board_preview_plan'
    ]) {
      expect(isReadOnlyAdvertisedTool(tool)).toBe(true)
    }
  })

  it('SAFETY: rejects every mutating-floor tool + unknown tools (the call-gate boundary)', () => {
    for (const tool of [
      'write_file',
      'replace',
      'apply_patch',
      'run_shell_command',
      'git_stage',
      'git_commit',
      'run_task',
      'ensemble_send',
      'ensemble_fanout',
      'ensemble_bossman_control',
      'schedule_wakeup',
      'cancel_wakeup',
      'blackboard_post',
      'delegate_to_subthread',
      'workspace_board_apply_plan',
      'web_search',
      'web_fetch',
      'totally_unknown_future_tool'
    ]) {
      expect(isReadOnlyAdvertisedTool(tool)).toBe(false)
    }
  })
})
