import { describe, expect, it } from 'vitest'
import {
  isOllamaToolControlTier,
  normalizeOllamaToolControlTier,
  ollamaToolNamesForTier,
  ollamaToolRequiresIntent
} from './OllamaToolTiers'

describe('Ollama tool surface governance', () => {
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

  it('advertises the full surface for every legacy tier value', () => {
    const readOnly = ollamaToolNamesForTier('read_only')
    const edits = ollamaToolNamesForTier('approved_edits')
    const shell = ollamaToolNamesForTier('approved_shell')
    const parity = ollamaToolNamesForTier('provider_parity')

    expect(edits).toEqual(readOnly)
    expect(shell).toEqual(readOnly)
    expect(parity).toEqual(readOnly)
    for (const tool of [
      'read_file',
      'web_search',
      'web_fetch',
      'github_ci_status',
      'write_file',
      'apply_patch',
      'run_shell_command',
      'git_push',
      'git_create_pr',
      'delegate_to_subthread'
    ] as const) {
      expect(readOnly).toContain(tool)
    }
  })

  it('filters only network tools when the resolved run posture denies network access', () => {
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
