import { describe, expect, it } from 'vitest'
import { PLAN_MCP_ADVERTISE_TOOLS, READ_ONLY_MCP_ADVERTISE_TOOLS } from '../mcp/McpAutoAllowedTools'
import { GATEWAY_V17_MCP_DIRECT_TOOLS } from '../mcp/McpToolProfiles'
import {
  OLLAMA_ADVERTISED_TOOL_NAMES,
  OLLAMA_EXCLUDED_SUBTHREAD_TOOL_NAMES,
  isOllamaToolControlTier,
  isOllamaAdvertisedTool,
  isOllamaExcludedSubthreadTool,
  normalizeOllamaToolControlTier,
  ollamaAdvertisedToolNames,
  ollamaCallableToolNames,
  ollamaToolNamesForTier,
  ollamaToolRequiresIntent
} from './OllamaToolTiers'

describe('Ollama tool surface governance', () => {
  it('uses the exact immutable fresh gateway-v17 direct membership as the catalog alias', () => {
    expect(OLLAMA_ADVERTISED_TOOL_NAMES).toBe(GATEWAY_V17_MCP_DIRECT_TOOLS)
    expect(OLLAMA_ADVERTISED_TOOL_NAMES).toHaveLength(GATEWAY_V17_MCP_DIRECT_TOOLS.length)
    for (const name of GATEWAY_V17_MCP_DIRECT_TOOLS) {
      expect(isOllamaAdvertisedTool(name)).toBe(true)
    }
    expect(OLLAMA_ADVERTISED_TOOL_NAMES).toEqual(
      expect.arrayContaining(['canvas_sketch_open', 'canvas_sketch_get', 'canvas_sketch_update'])
    )
    expect(OLLAMA_ADVERTISED_TOOL_NAMES).toContain('ensemble_control')
    expect(OLLAMA_ADVERTISED_TOOL_NAMES).toContain('delegate_wave')
    expect(OLLAMA_ADVERTISED_TOOL_NAMES).toContain('image_view')
    expect(OLLAMA_ADVERTISED_TOOL_NAMES).not.toContain('ensemble_bossman_control')
    expect(isOllamaAdvertisedTool('video_thumbnail')).toBe(false)
    expect(isOllamaAdvertisedTool('simulator_status')).toBe(false)
    expect(isOllamaAdvertisedTool('project_reference_list')).toBe(false)
    expect(isOllamaAdvertisedTool('canvas_render_chart')).toBe(false)
  })

  it('hard-excludes sub-thread tools from the live Ollama advertise/callable surface', () => {
    const advertised = ollamaAdvertisedToolNames()
    const excludedDirectCount = OLLAMA_EXCLUDED_SUBTHREAD_TOOL_NAMES.filter((name) =>
      (GATEWAY_V17_MCP_DIRECT_TOOLS as readonly string[]).includes(name)
    ).length
    expect(advertised).not.toContain('delegate_to_subthread')
    expect(advertised).not.toContain('delegate_wave')
    expect(advertised).not.toContain('list_subthreads')
    expect(advertised).not.toContain('read_subthread_result')
    expect(advertised).not.toContain('cancel_subthread')
    expect(advertised).toHaveLength(GATEWAY_V17_MCP_DIRECT_TOOLS.length - excludedDirectCount)
    expect(isOllamaExcludedSubthreadTool('delegate_to_subthread')).toBe(true)
    expect(isOllamaExcludedSubthreadTool('delegate_wave')).toBe(true)
    expect(ollamaCallableToolNames()).not.toContain('delegate_to_subthread')
    expect(ollamaCallableToolNames()).not.toContain('delegate_wave')
  })

  it('does not drift a pinned v7 Ollama receipt when v8 promotes Sketch', () => {
    const v7 = ollamaAdvertisedToolNames({
      taskWraithMcpProfileId: 'taskwraith-gateway-v7'
    })
    const v8 = ollamaAdvertisedToolNames({
      taskWraithMcpProfileId: 'taskwraith-gateway-v8'
    })
    const v8Mesh = ollamaAdvertisedToolNames({
      taskWraithMcpProfileId: 'taskwraith-gateway-v8-mesh'
    })
    const v9Mesh = ollamaAdvertisedToolNames({
      taskWraithMcpProfileId: 'taskwraith-gateway-v9-mesh'
    })
    const v15Mesh = ollamaAdvertisedToolNames({
      taskWraithMcpProfileId: 'taskwraith-gateway-v15-mesh'
    })
    for (const tool of ['canvas_sketch_open', 'canvas_sketch_get', 'canvas_sketch_update']) {
      expect(v7).not.toContain(tool)
      expect(v8).toContain(tool)
      expect(v8Mesh).toContain(tool)
      expect(v9Mesh).toContain(tool)
    }
    expect(v8Mesh).not.toContain('mesh_scene_present')
    expect(v9Mesh).not.toContain('mesh_scene_present')
    expect(v15Mesh).not.toContain('mesh_scene_present')
    expect(v15Mesh).not.toContain('mesh_topology_edit')
  })

  it('intersects the gateway set with the shared safe set for read-only runs', () => {
    const safeNames = new Set(READ_ONLY_MCP_ADVERTISE_TOOLS)
    const expected = GATEWAY_V17_MCP_DIRECT_TOOLS.filter(
      (name) => safeNames.has(name) && !isOllamaExcludedSubthreadTool(name)
    )
    const actual = ollamaAdvertisedToolNames({ readOnly: true })
    expect(actual).toEqual(expected)
    expect(actual).toContain('read_file')
    expect(actual).toContain('image_view')
    expect(actual).toContain('ask_user_question')
    expect(actual).toContain('blackboard_read')
    expect(actual).not.toContain('write_file')
    expect(actual).not.toContain('run_shell_command')
    expect(actual).not.toContain('ensemble_bossman_control')
    expect(actual).not.toContain('delegate_to_subthread')
    expect(actual).not.toContain('delegate_wave')
    expect(actual).toContain('canvas_sketch_open')
    expect(actual).toContain('canvas_sketch_get')
    expect(actual).not.toContain('canvas_sketch_update')
  })

  it('adds approval-gated Sketch mutation for Plan without exposing general writes', () => {
    const planNames = new Set(PLAN_MCP_ADVERTISE_TOOLS)
    const expected = GATEWAY_V17_MCP_DIRECT_TOOLS.filter(
      (name) => planNames.has(name) && !isOllamaExcludedSubthreadTool(name)
    )
    const actual = ollamaAdvertisedToolNames({ readOnly: true, plan: true })
    expect(actual).toEqual(expected)
    expect(actual).toContain('canvas_sketch_open')
    expect(actual).toContain('canvas_sketch_get')
    expect(actual).toContain('canvas_sketch_update')
    expect(actual).not.toContain('write_file')
    expect(actual).not.toContain('run_shell_command')
    expect(actual).not.toContain('delegate_to_subthread')
    expect(actual).not.toContain('delegate_wave')
  })

  it('keeps the legacy tier parser tolerant for compatibility', () => {
    expect(normalizeOllamaToolControlTier('approved_edits')).toBe('approved_edits')
    expect(normalizeOllamaToolControlTier('approved_shell')).toBe('approved_shell')
    expect(normalizeOllamaToolControlTier('provider_parity')).toBe('provider_parity')
    expect(normalizeOllamaToolControlTier('bad-tier')).toBe('read_only')
  })

  it('recognizes the legacy tier ids without using them as the safety boundary', () => {
    for (const value of ['read_only', 'approved_edits', 'approved_shell', 'provider_parity']) {
      expect(isOllamaToolControlTier(value)).toBe(true)
    }
    for (const value of ['', 'bogus', null, undefined, 5, {}, 'plan']) {
      expect(isOllamaToolControlTier(value)).toBe(false)
    }
  })

  it('advertises the gateway direct surface for every legacy tier value', () => {
    const readOnly = ollamaToolNamesForTier('read_only')
    const edits = ollamaToolNamesForTier('approved_edits')
    const shell = ollamaToolNamesForTier('approved_shell')
    const parity = ollamaToolNamesForTier('provider_parity')
    const expected = GATEWAY_V17_MCP_DIRECT_TOOLS.filter(
      (name) => !isOllamaExcludedSubthreadTool(name)
    )

    expect(edits).toEqual(readOnly)
    expect(shell).toEqual(readOnly)
    expect(parity).toEqual(readOnly)
    expect(readOnly).toEqual(expected)
    expect(readOnly).not.toContain('delegate_to_subthread')
    expect(readOnly).not.toContain('delegate_wave')
    expect(readOnly).not.toContain('web_search')
    expect(readOnly).not.toContain('git_push')
  })

  it('does not widen the direct profile when the run posture denies network access', () => {
    const names = ollamaToolNamesForTier('provider_parity', { networkAccess: 'deny' })
    expect(names).toContain('read_file')
    expect(names).toContain('write_file')
    expect(names).toContain('run_shell_command')
    expect(names).not.toContain('web_search')
    expect(names).not.toContain('web_fetch')
    expect(names).not.toContain('github_ci_status')
  })

  it('still requires explicit intent for mutating or publishing tools', () => {
    for (const tool of [
      'write_file',
      'move_path',
      'delete_path',
      'run_shell_command',
      'get_diagnostics',
      'git_push',
      'git_create_pr',
      'cancel_active_run'
    ] as const) {
      expect(ollamaToolRequiresIntent(tool)).toBe(true)
    }
    expect(ollamaToolRequiresIntent('read_file')).toBe(false)
  })
})
