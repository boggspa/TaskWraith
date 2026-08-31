import { describe, expect, it } from 'vitest'
import { MEDIA_EDITING_TOOLS, MESH_MCP_TOOL_NAMES } from '../TaskWraithMcpTools'
import { TASKWRAITH_TOOL_ACTIONS } from '../../shared/providerActionTaxonomy'
import {
  MCP_AUTO_ALLOWED_TOOLS,
  MCP_APP_STATE_MUTATION_TOOLS,
  MCP_ENSEMBLE_PARTICIPATION_TOOLS,
  PLAN_INSTRUMENT_ADVERTISE_TOOLS,
  READ_ONLY_MCP_ADVERTISE_TOOLS,
  RECON_INSTRUMENT_ADVERTISE_TOOLS,
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
      'project_reference_list',
      'completion_claim_check',
      'web_search',
      'web_fetch',
      'github_ci_status',
      'blackboard_post',
      'blackboard_read',
      'scout_brief'
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

  it('lets read-only Scouts return their bounded fan-out brief without approval', () => {
    // Runtime validation remains in ScoutBrief: callers outside the active
    // Scout pass receive a structured rejection rather than mutating state.
    expect(autoAllowedTools.has('scout_brief')).toBe(true)
    expect(READ_ONLY_MCP_ADVERTISE_TOOLS).toContain('scout_brief')
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

  it('lets every posture reach legacy and host-issued permission elicitation without auto-running a target', () => {
    expect(autoAllowedTools.has('request_tool_permission')).toBe(true)
    expect(READ_ONLY_MCP_ADVERTISE_TOOLS).toContain('request_tool_permission')
    expect(
      (MCP_APP_STATE_MUTATION_TOOLS as ReadonlySet<string>).has('request_tool_permission')
    ).toBe(false)
    expect(autoAllowedTools.has('redeem_permission_opportunity')).toBe(true)
    expect(READ_ONLY_MCP_ADVERTISE_TOOLS).toContain('redeem_permission_opportunity')
    expect(
      (MCP_APP_STATE_MUTATION_TOOLS as ReadonlySet<string>).has('redeem_permission_opportunity')
    ).toBe(false)
  })
})

describe('READ_ONLY_MCP_ADVERTISE_TOOLS', () => {
  it('advertises the safe coordination + read tools to a read-only seat', () => {
    for (const tool of [
      'ask_user_question',
      'request_tool_permission',
      'redeem_permission_opportunity',
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
      'project_reference_list',
      'completion_claim_check',
      'web_search',
      'web_fetch',
      'github_ci_status',
      'blackboard_post',
      'scout_brief',
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

  it('every advertised tool is auto-allowed OR a declared recon instrument (nothing else)', () => {
    const autoAllowedTools = MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>
    const reconInstruments = new Set<string>(RECON_INSTRUMENT_ADVERTISE_TOOLS)
    for (const tool of READ_ONLY_MCP_ADVERTISE_TOOLS) {
      expect(autoAllowedTools.has(tool) || reconInstruments.has(tool)).toBe(true)
    }
  })

  it('RECON INSTRUMENT INVARIANT: declared Ask instruments are never auto-allowed', () => {
    // Growing this tier is a capability-governance decision, not a convenience.
    expect([...RECON_INSTRUMENT_ADVERTISE_TOOLS].sort()).toEqual(
      [
        'cancel_subthread',
        'canvas_navigate',
        'canvas_render_chart',
        'delegate_to_subthread',
        'delegate_wave',
        'ultra_task',
        ...MESH_MCP_TOOL_NAMES,
        'simulator_boot',
        'simulator_button',
        'simulator_install',
        'simulator_launch',
        'simulator_open',
        'simulator_rotate',
        'simulator_screenshot',
        'simulator_scroll',
        'simulator_tap',
        'simulator_terminate',
        'simulator_type'
      ].sort()
    )
    const autoAllowedTools = MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>
    expect(TASKWRAITH_TOOL_ACTIONS.canvas_navigate.service).toBe('webBrowsing')
    expect(TASKWRAITH_TOOL_ACTIONS.canvas_render_chart.service).toBe('mcpTools')
    expect(TASKWRAITH_TOOL_ACTIONS.delegate_to_subthread.service).toBe('subThreadDelegation')
    expect(TASKWRAITH_TOOL_ACTIONS.delegate_wave.service).toBe('subThreadDelegation')
    expect(TASKWRAITH_TOOL_ACTIONS.ultra_task.service).toBe('subThreadDelegation')
    expect(TASKWRAITH_TOOL_ACTIONS.cancel_subthread.service).toBe('subThreadDelegation')
    for (const tool of [
      'simulator_open',
      'simulator_boot',
      'simulator_install',
      'simulator_launch',
      'simulator_screenshot',
      'simulator_terminate',
      'simulator_button',
      'simulator_rotate',
      'simulator_tap',
      'simulator_type',
      'simulator_scroll'
    ] as const) {
      expect(TASKWRAITH_TOOL_ACTIONS[tool].service).toBe('simulatorCanvas')
    }
    for (const tool of RECON_INSTRUMENT_ADVERTISE_TOOLS) {
      expect(autoAllowedTools.has(tool)).toBe(false)
    }
  })

  it('auto-allows simulator_status / simulator_inspect and keeps mutating simulator tools gated', () => {
    const autoAllowed = MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>
    expect(autoAllowed.has('simulator_status')).toBe(true)
    expect(autoAllowed.has('simulator_inspect')).toBe(true)
    expect(TASKWRAITH_TOOL_ACTIONS.simulator_status.service).toBe('mcpTools')
    expect(TASKWRAITH_TOOL_ACTIONS.simulator_inspect.service).toBe('mcpTools')
    for (const tool of [
      'simulator_open',
      'simulator_boot',
      'simulator_install',
      'simulator_launch',
      'simulator_screenshot',
      'simulator_terminate',
      'simulator_button',
      'simulator_rotate',
      'simulator_tap',
      'simulator_type',
      'simulator_scroll'
    ] as const) {
      expect(autoAllowed.has(tool)).toBe(false)
      expect(isReadOnlyAdvertisedTool(tool)).toBe(true)
      expect(isPlanAdvertisedTool(tool)).toBe(true)
      expect(PLAN_INSTRUMENT_ADVERTISE_TOOLS).toContain(tool)
    }
  })
})

describe('isReadOnlyAdvertisedTool (bridge scope guard)', () => {
  it('matches the safe coordination + read tools', () => {
    for (const tool of [
      'ask_user_question',
      'request_tool_permission',
      'redeem_permission_opportunity',
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
      'project_reference_list',
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
      'cancel_active_run',
      'workspace_board_apply_plan',
      'totally_unknown_future_tool'
    ]) {
      expect(isReadOnlyAdvertisedTool(tool)).toBe(false)
    }
  })

  it('advertises sub-thread delegation as an approval-queued Ask instrument', () => {
    expect(isReadOnlyAdvertisedTool('delegate_to_subthread')).toBe(true)
    expect(isReadOnlyAdvertisedTool('delegate_wave')).toBe(true)
    expect(isReadOnlyAdvertisedTool('ultra_task')).toBe(true)
    expect(isReadOnlyAdvertisedTool('cancel_subthread')).toBe(true)
    expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has('delegate_to_subthread')).toBe(false)
    expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has('delegate_wave')).toBe(false)
    expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has('ultra_task')).toBe(false)
    expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has('cancel_subthread')).toBe(false)
    expect(RECON_INSTRUMENT_ADVERTISE_TOOLS).toEqual(
      expect.arrayContaining([
        'delegate_to_subthread',
        'delegate_wave',
        'ultra_task',
        'cancel_subthread',
        'canvas_navigate'
      ])
    )
  })

  it('does NOT advertise the plan instruments to a read_only seat', () => {
    // canvas actuation + media are the plan tier — a read_only seat must not see them.
    expect(isReadOnlyAdvertisedTool('canvas_click')).toBe(false)
    expect(isReadOnlyAdvertisedTool('canvas_fill')).toBe(false)
    expect(isReadOnlyAdvertisedTool('canvas_key')).toBe(false)
    expect(isReadOnlyAdvertisedTool('canvas_scroll')).toBe(false)
    expect(isReadOnlyAdvertisedTool('canvas_hover')).toBe(false)
    expect(isReadOnlyAdvertisedTool('canvas_select')).toBe(false)
    expect(isReadOnlyAdvertisedTool('canvas_wait_for')).toBe(true)
    expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has('canvas_wait_for')).toBe(true)
    expect(isReadOnlyAdvertisedTool('canvas_drive_report')).toBe(true)
    expect(isReadOnlyAdvertisedTool('canvas_drive_verify')).toBe(true)
    expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has('canvas_drive_report')).toBe(true)
    expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has('canvas_drive_verify')).toBe(true)
    expect(isReadOnlyAdvertisedTool('canvas_sketch_update')).toBe(false)
    for (const tool of MEDIA_EDITING_TOOLS) {
      expect(isReadOnlyAdvertisedTool(tool)).toBe(false)
    }
  })

  it('advertises Canvas Browser navigation to read_only as an approval-queued instrument', () => {
    expect(isReadOnlyAdvertisedTool('canvas_navigate')).toBe(true)
    // Reaching it is not running it: it must never join the gate-skip set.
    expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has('canvas_navigate')).toBe(false)
    // Opening/closing surfaces and screenshots stay off the recon surface.
    expect(isReadOnlyAdvertisedTool('canvas_open')).toBe(false)
    expect(isReadOnlyAdvertisedTool('canvas_screenshot')).toBe(false)
    expect(isReadOnlyAdvertisedTool('canvas_close')).toBe(false)
  })

  it('advertises canvas_render_chart to Ask/Plan as an approval-queued recon instrument', () => {
    // Dock charts must be reachable on every tier: Ask/Plan get a modal ask
    // (never hard-deny / never auto-allow); Accept Edits+ follow mcpTools allow.
    expect(isReadOnlyAdvertisedTool('canvas_render_chart')).toBe(true)
    expect(isPlanAdvertisedTool('canvas_render_chart')).toBe(true)
    expect(RECON_INSTRUMENT_ADVERTISE_TOOLS).toContain('canvas_render_chart')
    expect(PLAN_INSTRUMENT_ADVERTISE_TOOLS).toContain('canvas_render_chart')
    expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has('canvas_render_chart')).toBe(false)
    expect(TASKWRAITH_TOOL_ACTIONS.canvas_render_chart.service).toBe('mcpTools')
    expect(TASKWRAITH_TOOL_ACTIONS.canvas_render_chart.toolClass).toBe('orchestration')
  })

  it('advertises every Mesh Canvas action to Ask as an approval-queued instrument', () => {
    for (const tool of MESH_MCP_TOOL_NAMES) {
      expect(isReadOnlyAdvertisedTool(tool)).toBe(true)
      expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has(tool)).toBe(false)
    }
  })

  it('advertises Sketch open/get to read_only while keeping updates gated', () => {
    expect(isReadOnlyAdvertisedTool('canvas_sketch_open')).toBe(true)
    expect(isReadOnlyAdvertisedTool('canvas_sketch_get')).toBe(true)
    expect(isReadOnlyAdvertisedTool('canvas_sketch_update')).toBe(false)
  })
})

describe('PLAN_MCP_ADVERTISE_TOOLS / isPlanAdvertisedTool (plan-seat bridge scope)', () => {
  const autoAllowedTools = MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>

  it('advertises canvas actuation + every media-editing tool to a plan seat', () => {
    expect(isPlanAdvertisedTool('canvas_click')).toBe(true)
    expect(isPlanAdvertisedTool('canvas_fill')).toBe(true)
    expect(isPlanAdvertisedTool('canvas_key')).toBe(true)
    expect(isPlanAdvertisedTool('canvas_scroll')).toBe(true)
    expect(isPlanAdvertisedTool('canvas_hover')).toBe(true)
    expect(isPlanAdvertisedTool('canvas_select')).toBe(true)
    expect(isPlanAdvertisedTool('canvas_wait_for')).toBe(true)
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
      'workspace_board_apply_plan',
      'totally_unknown_future_tool'
    ]) {
      expect(isPlanAdvertisedTool(tool)).toBe(false)
    }
  })

  it('inherits Ask sub-thread instruments on plan seats (modal-gated, not auto-allowed)', () => {
    expect(isPlanAdvertisedTool('delegate_to_subthread')).toBe(true)
    expect(isPlanAdvertisedTool('delegate_wave')).toBe(true)
    expect(isPlanAdvertisedTool('ultra_task')).toBe(true)
    expect(isPlanAdvertisedTool('cancel_subthread')).toBe(true)
    expect(autoAllowedTools.has('delegate_to_subthread')).toBe(false)
    expect(autoAllowedTools.has('delegate_wave')).toBe(false)
    expect(autoAllowedTools.has('ultra_task')).toBe(false)
  })
})
