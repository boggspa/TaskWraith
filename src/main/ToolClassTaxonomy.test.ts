import { describe, expect, it } from 'vitest'
import {
  classifyCatalogTool,
  classifyHistoricalToolForDisplay,
  classifyTool,
  groupToolsByClass,
  isReadOnlyBlockedTool,
  isNetworkAccessBlockedTool,
  READ_ONLY_TOOL_PRESET,
  resolveToolClassStrict,
  TOOL_CLASS_LABELS,
  TOOL_CLASS_ORDER
} from './ToolClassTaxonomy'
import { TASKWRAITH_MCP_TOOLS } from './TaskWraithMcpTools'
import { TASKWRAITH_TOOL_ACTIONS } from '../shared/providerActionTaxonomy'
import {
  MCP_APP_STATE_MUTATION_TOOLS,
  MCP_AUTO_ALLOWED_TOOLS,
  MCP_ENSEMBLE_PARTICIPATION_TOOLS
} from './mcp/McpAutoAllowedTools'

describe('classifyTool', () => {
  it('projects every exact catalog class from the exhaustive shared metadata', () => {
    for (const toolName of TASKWRAITH_MCP_TOOLS) {
      expect(classifyCatalogTool(toolName)).toBe(TASKWRAITH_TOOL_ACTIONS[toolName].toolClass)
      expect(resolveToolClassStrict(toolName)).toMatchObject({
        ok: true,
        toolClass: TASKWRAITH_TOOL_ACTIONS[toolName].toolClass
      })
    }
  })

  it('separates strict unknown denial from conservative historical display', () => {
    expect(resolveToolClassStrict('something_brand_new')).toMatchObject({
      ok: false,
      denied: true,
      code: 'unmapped_catalog_action'
    })
    expect(classifyHistoricalToolForDisplay('something_brand_new')).toBe('workspace_write')
    expect(classifyHistoricalToolForDisplay('Grep')).toBe('workspace_read')
    expect(isReadOnlyBlockedTool('something_brand_new', { readOnly: true })).toBe(true)
    expect(isNetworkAccessBlockedTool('something_brand_new', { networkAccess: 'deny' })).toBe(true)
  })

  it('inherits gateway class and read-only policy from the concrete target', () => {
    expect(resolveToolClassStrict('capability_search')).toMatchObject({
      ok: true,
      toolName: 'capability_search',
      toolClass: 'orchestration'
    })
    expect(
      resolveToolClassStrict('capability_invoke', {
        name: 'write_file',
        arguments: { path: 'x', content: 'body' }
      })
    ).toMatchObject({
      ok: true,
      toolName: 'write_file',
      toolClass: 'workspace_write'
    })
    expect(
      isReadOnlyBlockedTool(
        'capability_invoke',
        { readOnly: true },
        { name: 'write_file', arguments: { path: 'x', content: 'body' } }
      )
    ).toBe(true)
    expect(
      isReadOnlyBlockedTool(
        'capability_invoke',
        { readOnly: true },
        { name: 'read_file', arguments: { path: 'x' } }
      )
    ).toBe(false)
    expect(
      isNetworkAccessBlockedTool('capability_invoke', { networkAccess: 'deny' }, undefined, {
        name: 'web_search',
        arguments: { query: 'release' }
      })
    ).toBe(true)
  })

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
    expect(classifyTool('project_reference_propose')).toBe('orchestration')
    expect(classifyTool('project_reference_list')).toBe('orchestration')
    expect(classifyTool('list_background_processes')).toBe('orchestration')
    expect(classifyTool('read_background_process')).toBe('orchestration')
    expect(classifyTool('web_search')).toBe('web_read')
    expect(classifyTool('web_fetch')).toBe('web_read')
    expect(classifyTool('github_ci_status')).toBe('web_read')
    expect(classifyTool('ask_user_question')).toBe('ui_elicitation')
    expect(classifyTool('request_tool_permission')).toBe('ui_elicitation')
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

  it('blocks every Outlook tool under a network deny, writes included', () => {
    const denied = { networkAccess: 'deny' }
    for (const toolName of [
      'outlook_list_messages',
      'outlook_search_messages',
      'outlook_get_message',
      'outlook_list_events',
      // The writes are `workspace_write` by class — correct, so a read-only
      // seat cannot run them — but they still reach a cloud mailbox, and a run
      // whose posture says the network is off must not write one.
      'outlook_create_draft',
      'outlook_create_event'
    ]) {
      expect(isNetworkAccessBlockedTool(toolName, denied)).toBe(true)
    }
    expect(isNetworkAccessBlockedTool('outlook_create_draft', { networkAccess: 'allow' })).toBe(
      false
    )
  })

  it('derives external publish blocking from canonical action metadata', () => {
    const denied = { networkAccess: 'deny' }
    expect(isNetworkAccessBlockedTool('git_push', denied)).toBe(true)
    expect(isNetworkAccessBlockedTool('git_create_pr', denied)).toBe(true)
    expect(isNetworkAccessBlockedTool('git_commit', denied)).toBe(false)
    expect(
      isNetworkAccessBlockedTool('capability_invoke', denied, undefined, {
        name: 'git_push',
        arguments: {}
      })
    ).toBe(true)
  })

  it('blocks declared network egress even when the primary operation is media or application mutation', () => {
    const denied = { networkAccess: 'deny' }
    expect(isNetworkAccessBlockedTool('image_generate', denied, undefined, { prompt: 'cat' })).toBe(
      true
    )
    expect(
      isNetworkAccessBlockedTool('browser_open', denied, undefined, {
        url: 'https://example.com/demo'
      })
    ).toBe(true)
    expect(
      isNetworkAccessBlockedTool('canvas_open', denied, undefined, {
        url: 'http://192.168.1.20:4173'
      })
    ).toBe(true)
  })

  it('preserves local browser and canvas use under a network deny', () => {
    const denied = { networkAccess: 'deny' }
    for (const args of [
      { path: 'docs/report.html' },
      { url: 'file:///tmp/report.html' },
      { url: 'http://localhost:4173' },
      { href: '127.0.0.1:3000/status' },
      { url: 'http://127.42.7.9:8080' },
      { url: 'http://[::1]:4173' }
    ]) {
      expect(
        isNetworkAccessBlockedTool('browser_open', denied, undefined, args),
        JSON.stringify(args)
      ).toBe(false)
    }
    expect(
      isNetworkAccessBlockedTool('canvas_open', denied, undefined, {
        url: 'http://localhost:3000'
      })
    ).toBe(false)
    expect(
      isNetworkAccessBlockedTool('canvas_open', denied, undefined, {
        driver: 'device',
        bundleId: 'com.example.App'
      })
    ).toBe(false)
  })

  it('derives network egress and URL arguments through capability_invoke', () => {
    const denied = { networkAccess: 'deny' }
    expect(
      isNetworkAccessBlockedTool('capability_invoke', denied, undefined, {
        name: 'image_generate',
        arguments: { prompt: 'cat' }
      })
    ).toBe(true)
    expect(
      isNetworkAccessBlockedTool('capability_invoke', denied, undefined, {
        name: 'browser_open',
        arguments: { url: 'https://example.com' }
      })
    ).toBe(true)
    expect(
      isNetworkAccessBlockedTool('capability_invoke', denied, undefined, {
        name: 'canvas_open',
        arguments: { url: 'https://example.com/canvas' }
      })
    ).toBe(true)
    expect(
      isNetworkAccessBlockedTool('capability_invoke', denied, undefined, {
        name: 'browser_open',
        arguments: { path: 'docs/report.html' }
      })
    ).toBe(false)
    expect(
      isNetworkAccessBlockedTool('capability_invoke', denied, undefined, {
        name: 'canvas_open',
        arguments: { url: 'http://localhost:4173' }
      })
    ).toBe(false)
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
    expect(
      isNetworkAccessBlockedTool('browser_open', { networkAccess: 'allow' }, undefined, {
        url: 'https://example.com'
      })
    ).toBe(false)
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
      'request_tool_permission',
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
    expect(grouped.ui_elicitation).toEqual(['ask_user_question', 'request_tool_permission'])
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
        'canvas_sketch_update',
        'create_directory',
        'creative_applescript_dispatch',
        'creative_blender_python',
        'creative_midi_dispatch',
        'creative_timeline_import',
        'delete_path',
        'get_diagnostics',
        'git_commit',
        'git_create_pr',
        'git_push',
        'git_stage',
        'image_edit',
        'image_generate',
        'launch_adopt',
        'launch_start',
        'launch_stop',
        'mesh_scene_apply',
        'mesh_scene_close',
        'mesh_scene_create',
        'mesh_scene_delete',
        'mesh_scene_import',
        'mesh_scene_present',
        'mesh_scene_set_material',
        'mesh_topology_convert',
        'mesh_topology_edit',
        'move_path',
        // Draft creation mutates the mailbox, so read_only seats deny it.
        // The four Outlook READ tools classify as web_read instead.
        'outlook_create_draft',
        'outlook_create_event',
        'rename_path',
        'replace',
        'run_shell_command',
        'run_task',
        'start_background_process',
        'svg_rasterize',
        'switch_auth_profile',
        // Mutates persisted appearance settings, so it belongs in the
        // read-only DENY set. `theme_tokens_get` is classified
        // workspace_read and deliberately stays out of this array.
        'theme_tokens_set',
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
      'ask_user_question',
      'request_tool_permission'
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
    expect(
      (MCP_APP_STATE_MUTATION_TOOLS as ReadonlySet<string>).has('ensemble_poll_response')
    ).toBe(true)
    expect(
      (MCP_APP_STATE_MUTATION_TOOLS as ReadonlySet<string>).has('ensemble_propose_goal_complete')
    ).toBe(true)
    // …and every other app-state mutation + the fs/shell/workspace-write floor stays blocked.
    expect(isReadOnlyBlockedTool('ensemble_bossman_control', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('ensemble_roster_edit', ro)).toBe(true)
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
    expect(isReadOnlyBlockedTool('blackboard_delete', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('todo_write', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('goal_update', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('list_active_runs', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('launch_list_targets', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('launch_status', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('list_background_processes', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('read_background_process', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('ensemble_yield', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('ask_user_question', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('request_tool_permission', ro)).toBe(false)
    // Sub-thread delegation is orchestration + dedicated service so Ask/Plan can
    // modal-approve it rather than hard-deny before the gate.
    expect(isReadOnlyBlockedTool('delegate_to_subthread', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('cancel_subthread', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('simulator_status', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('simulator_open', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('simulator_boot', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('simulator_screenshot', ro)).toBe(false)
    expect(classifyTool('canvas_sketch_open')).toBe('orchestration')
    expect(isReadOnlyBlockedTool('canvas_sketch_open', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('canvas_sketch_get', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('canvas_sketch_update', ro)).toBe(true)
    expect(isReadOnlyBlockedTool('write_file', { readOnly: false })).toBe(false)
    expect(isReadOnlyBlockedTool('write_file', undefined)).toBe(false)
  })

  it('read-only REVIEWER-VERDICT exception is argument-scoped, never a whole-tool exemption (C2-v4 / G-SINGLE)', () => {
    const verdict = (v: 'passed' | 'failed') => ({
      action: 'submit_review_verdict',
      gateId: 'g1',
      verdict: v
    })
    // The EXACT nested reviewer-verdict invocation is read-only-callable so a gate's
    // OWN reviewer (which may be a read_only seat) can reconcile it — routed through
    // the ONE shared isExactReviewerVerdictInvocation classifier (G-SINGLE).
    expect(isReadOnlyBlockedTool('ensemble_bossman_control', ro, verdict('passed'))).toBe(false)
    expect(isReadOnlyBlockedTool('ensemble_bossman_control', ro, verdict('failed'))).toBe(false)

    // …but this is NOT a whole-tool exemption. EVERY other shape on the same tool stays
    // blocked (fail-closed), so no privileged Bossman action is ever reachable read-only:
    expect(isReadOnlyBlockedTool('ensemble_bossman_control', ro)).toBe(true) // no args → fail-closed
    expect(isReadOnlyBlockedTool('ensemble_bossman_control', ro, undefined)).toBe(true)
    // any extra key (strict set-equality reject):
    expect(
      isReadOnlyBlockedTool('ensemble_bossman_control', ro, { ...verdict('passed'), reason: 'x' })
    ).toBe(true)
    // a wrong / privileged action carrying the same key-set:
    for (const action of ['quarantine_participant', 'set_review_gate', 'set_goal', 'assign_work']) {
      expect(
        isReadOnlyBlockedTool('ensemble_bossman_control', ro, {
          action,
          gateId: 'g1',
          verdict: 'passed'
        })
      ).toBe(true)
    }
    // a missing key, a blank gateId, a bad verdict enum:
    expect(
      isReadOnlyBlockedTool('ensemble_bossman_control', ro, {
        action: 'submit_review_verdict',
        verdict: 'passed'
      })
    ).toBe(true)
    expect(
      isReadOnlyBlockedTool('ensemble_bossman_control', ro, {
        action: 'submit_review_verdict',
        gateId: '   ',
        verdict: 'passed'
      })
    ).toBe(true)
    expect(
      isReadOnlyBlockedTool('ensemble_bossman_control', ro, {
        action: 'submit_review_verdict',
        gateId: 'g1',
        verdict: 'waived'
      })
    ).toBe(true)

    // Tool-scoped: the identical exact payload on a DIFFERENT tool name is still blocked
    // (the classifier requires the canonical ensemble_bossman_control name).
    expect(isReadOnlyBlockedTool('ensemble_roster_edit', ro, verdict('passed'))).toBe(true)

    // Route/lineage invariant preserved: the tool REMAINS an app-state mutation — the
    // exception relaxes ONLY the read-only mutation-deny, exactly like the poll tools.
    expect(
      (MCP_APP_STATE_MUTATION_TOOLS as ReadonlySet<string>).has('ensemble_bossman_control')
    ).toBe(true)
  })
})
