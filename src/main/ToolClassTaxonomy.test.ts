import { describe, expect, it } from 'vitest'
import {
  classifyTool,
  groupToolsByClass,
  isReadOnlyBlockedTool,
  READ_ONLY_TOOL_PRESET,
  TOOL_CLASS_LABELS,
  TOOL_CLASS_ORDER
} from './ToolClassTaxonomy'
import { TASKWRAITH_MCP_TOOLS } from './TaskWraithMcpTools'
import { MCP_APP_STATE_MUTATION_TOOLS, MCP_AUTO_ALLOWED_TOOLS } from './mcp/McpAutoAllowedTools'

describe('classifyTool', () => {
  it('classifies each non-write class', () => {
    expect(classifyTool('read_file')).toBe('workspace_read')
    expect(classifyTool('grep')).toBe('workspace_read')
    expect(classifyTool('web_search')).toBe('web_read')
    expect(classifyTool('web_fetch')).toBe('web_read')
    expect(classifyTool('ask_user_question')).toBe('ui_elicitation')
    expect(classifyTool('ensemble_yield')).toBe('orchestration')
    expect(classifyTool('provider_usage_status')).toBe('orchestration')
  })

  it('defaults unknown / mutating tools to workspace_write', () => {
    expect(classifyTool('write_file')).toBe('workspace_write')
    expect(classifyTool('apply_patch')).toBe('workspace_write')
    expect(classifyTool('run_shell_command')).toBe('workspace_write')
    expect(classifyTool('something_brand_new')).toBe('workspace_write')
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
      'web_search',
      'ask_user_question',
      'ensemble_yield',
      'write_file'
    ])
    expect(grouped.workspace_read).toEqual(['read_file'])
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
        'audio_render_wav',
        'browser_click',
        'browser_open',
        'browser_screenshot',
        'canvas_click',
        'canvas_eval',
        'canvas_fill',
        'canvas_open',
        'creative_applescript_dispatch',
        'creative_blender_python',
        'creative_midi_dispatch',
        'creative_timeline_import',
        'delegate_to_subthread',
        'git_commit',
        'git_stage',
        'image_edit',
        'image_generate',
        'replace',
        'run_shell_command',
        'run_task',
        'svg_rasterize',
        'switch_auth_profile',
        'write_file'
      ].sort()
    )
  })

  it('never classifies a read / coordination tool as workspace_write', () => {
    for (const tool of [
      'read_file',
      'web_search',
      'web_fetch',
      'git_status',
      'git_diff',
      'test_result_summary',
      'read_subthread_result',
      'creative_timeline_validate',
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
    for (const tool of MCP_APP_STATE_MUTATION_TOOLS) {
      expect(isReadOnlyBlockedTool(tool, ro)).toBe(true)
    }
  })

  it('never blocks reads / coordination, or anything when not read-only', () => {
    expect(isReadOnlyBlockedTool('read_file', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('web_search', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('ensemble_yield', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('ask_user_question', ro)).toBe(false)
    expect(isReadOnlyBlockedTool('write_file', { readOnly: false })).toBe(false)
    expect(isReadOnlyBlockedTool('write_file', undefined)).toBe(false)
  })
})
