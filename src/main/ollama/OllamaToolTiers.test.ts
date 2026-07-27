import { describe, expect, it } from 'vitest'
import { READ_ONLY_MCP_ADVERTISE_TOOLS } from '../mcp/McpAutoAllowedTools'
import { GATEWAY_V6_MCP_DIRECT_TOOLS } from '../mcp/McpToolProfiles'
import {
  OLLAMA_ADVERTISED_TOOL_NAMES,
  isOllamaToolControlTier,
  isOllamaAdvertisedTool,
  normalizeOllamaToolControlTier,
  ollamaAdvertisedToolNames,
  ollamaToolNamesForTier,
  ollamaToolRequiresIntent
} from './OllamaToolTiers'

describe('Ollama tool surface governance', () => {
  it('uses the exact immutable fresh gateway-v6 direct membership', () => {
    expect(OLLAMA_ADVERTISED_TOOL_NAMES).toBe(GATEWAY_V6_MCP_DIRECT_TOOLS)
    expect(OLLAMA_ADVERTISED_TOOL_NAMES).toHaveLength(38)
    expect(ollamaAdvertisedToolNames()).toEqual([...GATEWAY_V6_MCP_DIRECT_TOOLS])
    for (const name of GATEWAY_V6_MCP_DIRECT_TOOLS) {
      expect(isOllamaAdvertisedTool(name)).toBe(true)
    }
    expect(OLLAMA_ADVERTISED_TOOL_NAMES).toContain('ensemble_control')
    expect(OLLAMA_ADVERTISED_TOOL_NAMES).not.toContain('ensemble_bossman_control')
    expect(isOllamaAdvertisedTool('video_thumbnail')).toBe(false)
  })

  it('intersects the gateway set with the shared safe set for read-only runs', () => {
    const safeNames = new Set(READ_ONLY_MCP_ADVERTISE_TOOLS)
    const expected = GATEWAY_V6_MCP_DIRECT_TOOLS.filter((name) => safeNames.has(name))
    const actual = ollamaAdvertisedToolNames({ readOnly: true })
    expect(actual).toEqual(expected)
    expect(actual).toContain('read_file')
    expect(actual).toContain('ask_user_question')
    expect(actual).toContain('blackboard_read')
    expect(actual).not.toContain('write_file')
    expect(actual).not.toContain('run_shell_command')
    expect(actual).not.toContain('ensemble_bossman_control')
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

    expect(edits).toEqual(readOnly)
    expect(shell).toEqual(readOnly)
    expect(parity).toEqual(readOnly)
    expect(readOnly).toEqual([...GATEWAY_V6_MCP_DIRECT_TOOLS])
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
