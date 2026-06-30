import { describe, expect, it } from 'vitest'
import type { AppSettings } from '../store/types'
import {
  canonicalizeOllamaWorkspacePath,
  chatOllamaToolControlTier,
  effectiveOllamaToolControlTier,
  isOllamaToolControlTier,
  ollamaProviderParityWorkspaceGranted,
  ollamaToolNamesForTier,
  ollamaToolRequiresIntent
} from './OllamaToolTiers'

function settingsWith(
  tier: AppSettings['ollamaToolControlTier'],
  grants: Record<string, string> = {}
): Pick<AppSettings, 'ollamaToolControlTier' | 'ollamaProviderParityWorkspaceGrants'> {
  return { ollamaToolControlTier: tier, ollamaProviderParityWorkspaceGrants: grants }
}

describe('canonicalizeOllamaWorkspacePath', () => {
  it('strips trailing slashes and normalizes . / .. segments', () => {
    expect(canonicalizeOllamaWorkspacePath('/tmp/proj/')).toBe('/tmp/proj')
    expect(canonicalizeOllamaWorkspacePath('/tmp/proj/./')).toBe('/tmp/proj')
    expect(canonicalizeOllamaWorkspacePath('/tmp/proj/sub/..')).toBe('/tmp/proj')
  })

  it('collapses duplicate slashes and leaves ~ untouched (pure / browser-safe)', () => {
    expect(canonicalizeOllamaWorkspacePath('/tmp//proj///sub')).toBe('/tmp/proj/sub')
    // ~ is a literal segment here — node-side callers expand it before lookup.
    expect(canonicalizeOllamaWorkspacePath('~/code/app')).toBe('~/code/app')
    expect(canonicalizeOllamaWorkspacePath('/')).toBe('/')
  })

  it('returns empty string for blank input', () => {
    expect(canonicalizeOllamaWorkspacePath('')).toBe('')
    expect(canonicalizeOllamaWorkspacePath('   ')).toBe('')
    expect(canonicalizeOllamaWorkspacePath(null)).toBe('')
    expect(canonicalizeOllamaWorkspacePath(undefined)).toBe('')
  })
})

describe('ollamaProviderParityWorkspaceGranted', () => {
  it('matches an exact grant (legacy behavior preserved)', () => {
    const settings = settingsWith('provider_parity', { '/tmp/granted': '2026-01-01T00:00:00Z' })
    expect(ollamaProviderParityWorkspaceGranted(settings, '/tmp/granted')).toBe(true)
    expect(ollamaProviderParityWorkspaceGranted(settings, '/tmp/other')).toBe(false)
  })

  it('matches when the stored key has a trailing slash but the lookup does not', () => {
    const settings = settingsWith('provider_parity', { '/tmp/granted/': '2026-01-01T00:00:00Z' })
    expect(ollamaProviderParityWorkspaceGranted(settings, '/tmp/granted')).toBe(true)
  })

  it('matches when the lookup has a trailing slash but the stored key does not', () => {
    const settings = settingsWith('provider_parity', { '/tmp/granted': '2026-01-01T00:00:00Z' })
    expect(ollamaProviderParityWorkspaceGranted(settings, '/tmp/granted/')).toBe(true)
  })

  it('matches across . / .. segments between key and lookup', () => {
    const settings = settingsWith('provider_parity', { '/tmp/granted': '2026-01-01T00:00:00Z' })
    expect(ollamaProviderParityWorkspaceGranted(settings, '/tmp/sub/../granted')).toBe(true)
    expect(ollamaProviderParityWorkspaceGranted(settings, '/tmp/./granted/')).toBe(true)
  })

  it('ignores grants with empty timestamps', () => {
    const settings = settingsWith('provider_parity', { '/tmp/granted': '' })
    expect(ollamaProviderParityWorkspaceGranted(settings, '/tmp/granted')).toBe(false)
  })

  it('returns false for a blank workspace path', () => {
    const settings = settingsWith('provider_parity', { '/tmp/granted': '2026-01-01T00:00:00Z' })
    expect(ollamaProviderParityWorkspaceGranted(settings, '')).toBe(false)
    expect(ollamaProviderParityWorkspaceGranted(settings, undefined)).toBe(false)
  })
})

describe('effectiveOllamaToolControlTier', () => {
  it('keeps provider_parity when the workspace is granted (path-form tolerant)', () => {
    const settings = settingsWith('provider_parity', { '/tmp/granted/': '2026-01-01T00:00:00Z' })
    expect(effectiveOllamaToolControlTier(settings, '/tmp/granted')).toBe('provider_parity')
  })

  it('silently downgrades provider_parity to read_only when ungranted', () => {
    const settings = settingsWith('provider_parity', {})
    expect(effectiveOllamaToolControlTier(settings, '/tmp/ungranted')).toBe('read_only')
  })

  it('downgrades provider_parity to read_only for a global run (no workspace path)', () => {
    const settings = settingsWith('provider_parity', { '/tmp/granted': '2026-01-01T00:00:00Z' })
    expect(effectiveOllamaToolControlTier(settings, undefined)).toBe('read_only')
  })

  it('does not require a grant for approved_edits / approved_shell', () => {
    expect(effectiveOllamaToolControlTier(settingsWith('approved_edits'), '/tmp/x')).toBe(
      'approved_edits'
    )
    expect(effectiveOllamaToolControlTier(settingsWith('approved_shell'), '/tmp/x')).toBe(
      'approved_shell'
    )
  })

  describe('per-chat tier override', () => {
    it('a per-chat tier wins over the global setting', () => {
      const settings = settingsWith('read_only')
      expect(effectiveOllamaToolControlTier(settings, '/tmp/x', 'approved_shell')).toBe(
        'approved_shell'
      )
    })

    it('falls back to the global tier when the chat tier is absent', () => {
      const settings = settingsWith('approved_edits')
      expect(effectiveOllamaToolControlTier(settings, '/tmp/x', undefined)).toBe('approved_edits')
      expect(effectiveOllamaToolControlTier(settings, '/tmp/x', null)).toBe('approved_edits')
    })

    it('falls back to the global tier when the chat tier is unrecognised (NOT read_only)', () => {
      const settings = settingsWith('approved_shell')
      expect(effectiveOllamaToolControlTier(settings, '/tmp/x', 'bogus')).toBe('approved_shell')
      expect(effectiveOllamaToolControlTier(settings, '/tmp/x', '')).toBe('approved_shell')
    })

    it('a per-chat provider_parity is STILL gated by the per-workspace grant', () => {
      const settings = settingsWith('read_only', { '/tmp/granted': '2026-01-01T00:00:00Z' })
      // Chat picks Tier 4; granted workspace → parity, ungranted → read_only.
      expect(effectiveOllamaToolControlTier(settings, '/tmp/granted', 'provider_parity')).toBe(
        'provider_parity'
      )
      expect(effectiveOllamaToolControlTier(settings, '/tmp/ungranted', 'provider_parity')).toBe(
        'read_only'
      )
    })

    it('a per-chat tier can DOWNGRADE below the global tier', () => {
      const settings = settingsWith('provider_parity', { '/tmp/granted': '2026-01-01T00:00:00Z' })
      expect(effectiveOllamaToolControlTier(settings, '/tmp/granted', 'read_only')).toBe('read_only')
    })
  })
})

describe('isOllamaToolControlTier', () => {
  it('accepts the 4 tier values and rejects everything else', () => {
    for (const v of ['read_only', 'approved_edits', 'approved_shell', 'provider_parity']) {
      expect(isOllamaToolControlTier(v)).toBe(true)
    }
    for (const v of ['', 'bogus', null, undefined, 5, {}, 'plan']) {
      expect(isOllamaToolControlTier(v)).toBe(false)
    }
  })
})

describe('chatOllamaToolControlTier (mid-run gate reader)', () => {
  it('returns the per-chat tier when providerMetadata holds a valid tier', () => {
    expect(chatOllamaToolControlTier({ ollamaToolControlTier: 'approved_shell' })).toBe(
      'approved_shell'
    )
    expect(chatOllamaToolControlTier({ ollamaToolControlTier: 'provider_parity' })).toBe(
      'provider_parity'
    )
  })

  it('returns undefined (→ global fallback) for absent, empty, or invalid metadata', () => {
    expect(chatOllamaToolControlTier(undefined)).toBeUndefined()
    expect(chatOllamaToolControlTier(null)).toBeUndefined()
    expect(chatOllamaToolControlTier({})).toBeUndefined()
    expect(chatOllamaToolControlTier({ ollamaToolControlTier: 'bogus' })).toBeUndefined()
    expect(chatOllamaToolControlTier({ ollamaToolControlTier: '' })).toBeUndefined()
    expect(chatOllamaToolControlTier({ ollamaToolControlTier: 5 })).toBeUndefined()
    // an unrelated metadata key must not be mistaken for the tier
    expect(chatOllamaToolControlTier({ approvalMode: 'plan' })).toBeUndefined()
  })

  it('composes with effectiveOllamaToolControlTier — chat tier wins, invalid falls back', () => {
    const settings = settingsWith('read_only')
    expect(
      effectiveOllamaToolControlTier(
        settings,
        '/tmp/x',
        chatOllamaToolControlTier({ ollamaToolControlTier: 'approved_shell' })
      )
    ).toBe('approved_shell')
    expect(
      effectiveOllamaToolControlTier(
        settingsWith('approved_edits'),
        '/tmp/x',
        chatOllamaToolControlTier({ ollamaToolControlTier: 'bogus' })
      )
    ).toBe('approved_edits')
  })
})

describe('ollamaToolNamesForTier (edit-tool gating sanity)', () => {
  it('excludes file-edit tools at read_only', () => {
    const names = ollamaToolNamesForTier('read_only')
    expect(names).toEqual(expect.arrayContaining(['git_log', 'git_show', 'git_blame']))
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('replace')
    expect(names).not.toContain('create_directory')
    expect(names).not.toContain('delete_path')
    expect(names).not.toContain('move_path')
    expect(names).not.toContain('rename_path')
    expect(names).not.toContain('apply_patch')
    expect(names).not.toContain('get_diagnostics')
    expect(names).not.toContain('git_push')
    expect(names).not.toContain('git_create_pr')
    expect(names).toContain('list_active_runs')
    expect(names).not.toContain('cancel_active_run')
  })

  it('includes file-edit tools at approved_edits and provider_parity', () => {
    for (const tier of ['approved_edits', 'approved_shell', 'provider_parity'] as const) {
      const names = ollamaToolNamesForTier(tier)
      expect(names).toContain('write_file')
      expect(names).toContain('replace')
      expect(names).toContain('create_directory')
      expect(names).toContain('delete_path')
      expect(names).toContain('move_path')
      expect(names).toContain('rename_path')
      expect(names).toContain('apply_patch')
    }
    expect(ollamaToolRequiresIntent('move_path')).toBe(true)
    expect(ollamaToolRequiresIntent('delete_path')).toBe(true)
    expect(ollamaToolNamesForTier('approved_shell')).toContain('get_diagnostics')
    expect(ollamaToolRequiresIntent('get_diagnostics')).toBe(true)
    expect(ollamaToolNamesForTier('approved_shell')).not.toContain('git_push')
    expect(ollamaToolNamesForTier('approved_shell')).not.toContain('cancel_active_run')
    expect(ollamaToolNamesForTier('provider_parity')).toContain('git_push')
    expect(ollamaToolNamesForTier('provider_parity')).toContain('git_create_pr')
    expect(ollamaToolNamesForTier('provider_parity')).toContain('cancel_active_run')
    expect(ollamaToolRequiresIntent('git_push')).toBe(true)
    expect(ollamaToolRequiresIntent('git_create_pr')).toBe(true)
    expect(ollamaToolRequiresIntent('cancel_active_run')).toBe(true)
  })
})
