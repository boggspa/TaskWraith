import { describe, expect, it } from 'vitest'
import { MEDIA_EDITING_TOOLS } from '../TaskWraithMcpTools'
import {
  MCP_AUTO_ALLOWED_TOOLS,
  MCP_APP_STATE_MUTATION_TOOLS,
  MCP_ENSEMBLE_PARTICIPATION_TOOLS,
  PLAN_INSTRUMENT_ADVERTISE_TOOLS,
  READ_ONLY_MCP_ADVERTISE_TOOLS,
  isPlanAdvertisedTool,
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
      'git_status',
      'list_chat_attachments',
      'inspect_chat_attachment',
      'workspace_board_snapshot',
      'workspace_board_preview_plan',
      'canvas_sketch_get',
      'list_background_processes',
      'read_background_process',
      'list_active_runs',
      'prompt_task_normalize',
      'scope_radar',
      'repo_convention_scan',
      'coherence_gate_check',
      'evidence_pack_write',
      'project_reference_propose',
      'completion_claim_check',
      'web_search',
      'web_fetch',
      'github_ci_status',
      'blackboard_post',
      'blackboard_read'
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
      'start_background_process',
      'kill_background_process',
      'git_stage',
      'git_commit',
      'git_push',
      'git_create_pr',
      'run_task',
      'get_diagnostics',
      'cancel_active_run',
      'ensemble_bossman_control',
      'ensemble_roster_edit',
      'ensemble_brief_update',
      'workspace_board_apply_plan',
      // The two audited participation tools (vote/propose) ARE auto-allowed +
      // read-only advertised by ratification — exempt them from this floor loop.
      ...[...MCP_APP_STATE_MUTATION_TOOLS].filter(
        (t) => !(MCP_ENSEMBLE_PARTICIPATION_TOOLS as ReadonlySet<string>).has(t)
      )
    ]) {
      expect(autoAllowedTools.has(tool)).toBe(false)
    }
  })

  it('auto-allows the ensemble participation tools (ratified read-only vote/propose/send)', () => {
    // The audited exception: prompt-free + read-only advertised, yet STILL an
    // app-state mutation (route/workspace-lineage guard input preserved).
    // 2026-07 efficiency audit adds ensemble_send: visible chat-local notes are
    // strictly weaker than the binding-quorum vote already ratified here.
    expect((MCP_ENSEMBLE_PARTICIPATION_TOOLS as ReadonlySet<string>).has('ensemble_send')).toBe(
      true
    )
    for (const tool of MCP_ENSEMBLE_PARTICIPATION_TOOLS) {
      expect(autoAllowedTools.has(tool)).toBe(true)
      expect(READ_ONLY_MCP_ADVERTISE_TOOLS).toContain(tool)
      expect((MCP_APP_STATE_MUTATION_TOOLS as ReadonlySet<string>).has(tool)).toBe(true)
    }
  })

  it('auto-allows the fixed-argv repo reads (git_diff / git_log) but keeps show/blame gated', () => {
    // 2026-07-25 user decision: diff + log join status (bounded, fixed-argv
    // executors). git_show (arbitrary-object reads) and git_blame stay gated.
    for (const tool of ['git_diff', 'git_log'] as const) {
      expect(autoAllowedTools.has(tool)).toBe(true)
    }
    for (const tool of ['git_show', 'git_blame'] as const) {
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
      'git_status',
      'list_chat_attachments',
      'inspect_chat_attachment',
      'workspace_board_snapshot',
      'workspace_board_preview_plan',
      'list_background_processes',
      'read_background_process',
      'list_active_runs',
      'prompt_task_normalize',
      'scope_radar',
      'repo_convention_scan',
      'coherence_gate_check',
      'evidence_pack_write',
      'project_reference_propose',
      'completion_claim_check',
      'web_search',
      'web_fetch',
      'github_ci_status',
      'blackboard_post',
      'blackboard_read'
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
      'start_background_process',
      'kill_background_process',
      'git_stage',
      'git_commit',
      'git_push',
      'git_create_pr',
      'run_task',
      'get_diagnostics',
      'cancel_active_run',
      'workspace_board_apply_plan',
      // The two audited participation tools (vote/propose) ARE auto-allowed +
      // read-only advertised by ratification — exempt them from this floor loop.
      ...[...MCP_APP_STATE_MUTATION_TOOLS].filter(
        (t) => !(MCP_ENSEMBLE_PARTICIPATION_TOOLS as ReadonlySet<string>).has(t)
      )
    ]) {
      expect(READ_ONLY_MCP_ADVERTISE_TOOLS).not.toContain(tool)
    }
  })

  it('advertises diff/log to read-only seats but never show/blame', () => {
    for (const tool of ['git_diff', 'git_log'] as const) {
      expect(READ_ONLY_MCP_ADVERTISE_TOOLS).toContain(tool)
    }
    for (const tool of ['git_show', 'git_blame'] as const) {
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
      'ensemble_send',
      'read_file',
      'list_directory',
      'find_files',
      'list_chat_attachments',
      'inspect_chat_attachment',
      'git_status',
      'workspace_board_snapshot',
      'workspace_board_preview_plan',
      'list_background_processes',
      'read_background_process',
      'list_active_runs',
      'prompt_task_normalize',
      'scope_radar',
      'repo_convention_scan',
      'coherence_gate_check',
      'evidence_pack_write',
      'project_reference_propose',
      'completion_claim_check',
      'web_search',
      'web_fetch',
      'github_ci_status',
      'blackboard_post',
      'blackboard_read'
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
      'start_background_process',
      'kill_background_process',
      'git_stage',
      'git_commit',
      'git_push',
      'git_create_pr',
      'run_task',
      'get_diagnostics',
      'ensemble_fanout',
      'ensemble_bossman_control',
      'ensemble_roster_edit',
      'ensemble_brief_update',
      'schedule_wakeup',
      'cancel_wakeup',
      'blackboard_delete',
      'delegate_to_subthread',
      'cancel_active_run',
      'workspace_board_apply_plan',
      'totally_unknown_future_tool'
    ]) {
      expect(isReadOnlyAdvertisedTool(tool)).toBe(false)
    }
  })

  it('does NOT advertise the plan instruments to a read_only seat', () => {
    // canvas actuation + media are the plan tier — a read_only seat must not see them.
    expect(isReadOnlyAdvertisedTool('canvas_click')).toBe(false)
    expect(isReadOnlyAdvertisedTool('canvas_fill')).toBe(false)
    expect(isReadOnlyAdvertisedTool('canvas_sketch_update')).toBe(false)
    for (const tool of MEDIA_EDITING_TOOLS) {
      expect(isReadOnlyAdvertisedTool(tool)).toBe(false)
    }
  })
})

describe('PLAN_MCP_ADVERTISE_TOOLS / isPlanAdvertisedTool (plan-seat bridge scope)', () => {
  const autoAllowedTools = MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>

  it('advertises canvas actuation + every media-editing tool to a plan seat', () => {
    expect(isPlanAdvertisedTool('canvas_click')).toBe(true)
    expect(isPlanAdvertisedTool('canvas_fill')).toBe(true)
    expect(isPlanAdvertisedTool('canvas_sketch_update')).toBe(true)
    for (const tool of MEDIA_EDITING_TOOLS) {
      expect(isPlanAdvertisedTool(tool)).toBe(true)
    }
  })

  it('is a strict superset of the read-only advertise set', () => {
    for (const tool of READ_ONLY_MCP_ADVERTISE_TOOLS) {
      expect(isPlanAdvertisedTool(tool)).toBe(true)
    }
  })

  it('SAFETY INVARIANT: every plan instrument is NOT auto-allowed (stays host-gated)', () => {
    // If any plan instrument were also in MCP_AUTO_ALLOWED_TOOLS it would EXECUTE
    // on a plan bridge seat with NO approval — defeating per-invocation approval.
    // They must all route through the main-side host gate.
    expect(PLAN_INSTRUMENT_ADVERTISE_TOOLS.length).toBeGreaterThan(0)
    for (const tool of PLAN_INSTRUMENT_ADVERTISE_TOOLS) {
      expect(autoAllowedTools.has(tool)).toBe(false)
    }
  })

  it('SAFETY: still rejects the write/shell floor, RCE, and non-instrument gated tools', () => {
    for (const tool of [
      'write_file',
      'replace',
      'apply_patch',
      'run_shell_command',
      'git_stage',
      'git_commit',
      'git_push',
      'git_create_pr',
      'delete_path',
      'move_path',
      'rename_path',
      'start_background_process',
      'kill_background_process',
      'run_task',
      // canvas_eval (RCE) + canvas window lifecycle are NOT plan instruments.
      'canvas_eval',
      'canvas_open',
      // subthread delegation is a plan capability but deliberately out of the
      // bridge-parity scope (canvas + media only); it keeps its own gate.
      'delegate_to_subthread',
      'workspace_board_apply_plan',
      'totally_unknown_future_tool'
    ]) {
      expect(isPlanAdvertisedTool(tool)).toBe(false)
    }
  })
})
