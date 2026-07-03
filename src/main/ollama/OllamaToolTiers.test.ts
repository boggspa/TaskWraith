import { describe, expect, it } from 'vitest'
import type { AppSettings } from '../store/types'
import {
  canonicalizeOllamaWorkspacePath,
  chatOllamaToolControlTier,
  effectiveOllamaToolControlTier,
  isOllamaToolControlTier,
  ollamaProviderParityWorkspaceGranted,
  ollamaToolNamesForTier,
  ollamaToolRequiresIntent,
  resolveOllamaExecutionToolControlTier
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

describe('resolveOllamaExecutionToolControlTier', () => {
  it('uses the carried run-start tier instead of mutable current settings', () => {
    const settings = settingsWith('read_only')

    expect(
      resolveOllamaExecutionToolControlTier(
        settings,
        '/tmp/x',
        'approved_shell',
        'read_only'
      )
    ).toBe('approved_shell')
  })

  it('does not revalidate a carried provider-parity tier after grant revocation', () => {
    const settingsAfterRevocation = settingsWith('provider_parity', {})

    expect(
      resolveOllamaExecutionToolControlTier(
        settingsAfterRevocation,
        '/tmp/granted-at-run-start',
        'provider_parity',
        'read_only'
      )
    ).toBe('provider_parity')
  })

  it('falls back to live settings/chat metadata when no run-start tier is carried', () => {
    expect(
      resolveOllamaExecutionToolControlTier(
        settingsWith('read_only'),
        '/tmp/x',
        undefined,
        'approved_edits'
      )
    ).toBe('approved_edits')

    expect(
      resolveOllamaExecutionToolControlTier(
        settingsWith('approved_shell'),
        '/tmp/x',
        'bogus',
        undefined
      )
    ).toBe('approved_shell')
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

describe('ollamaToolNamesForTier (tier retirement: full surface)', () => {
  // Tier retirement (2026-07): the tier arg no longer narrows the surface. Every
  // value resolves to the SAME full provider-parity list — governance moved to the
  // standard permission ROLE at the approval gate. read_only/plan DENY writes+shell
  // there; they no longer hide the tools from the advertised surface (parity with
  // every other provider, which advertises the full surface and denies at the gate).
  it('advertises the full surface for every tier value', () => {
    const readOnly = ollamaToolNamesForTier('read_only')
    const parity = ollamaToolNamesForTier('provider_parity')
    expect(readOnly).toEqual(parity)
    for (const tool of [
      'read_file',
      'git_log',
      'git_show',
      'git_blame',
      'list_active_runs',
      'write_file',
      'replace',
      'create_directory',
      'delete_path',
      'move_path',
      'rename_path',
      'apply_patch',
      'get_diagnostics',
      'run_shell_command',
      'run_task',
      'git_push',
      'git_create_pr',
      'cancel_active_run',
      'todo_write'
    ] as const) {
      expect(readOnly).toContain(tool)
    }
  })

  it('still flags mutating / remote-git / process-control tools as intent-required', () => {
    // Defense-in-depth is tier-independent: the mutation-intent assert survives the
    // tier retirement even though the surface is no longer tier-narrowed.
    expect(ollamaToolRequiresIntent('move_path')).toBe(true)
    expect(ollamaToolRequiresIntent('delete_path')).toBe(true)
    expect(ollamaToolRequiresIntent('get_diagnostics')).toBe(true)
    expect(ollamaToolRequiresIntent('git_push')).toBe(true)
    expect(ollamaToolRequiresIntent('git_create_pr')).toBe(true)
    expect(ollamaToolRequiresIntent('cancel_active_run')).toBe(true)
  })

  it('filters only network tools when the resolved run posture denies network access', () => {
    const names = ollamaToolNamesForTier('provider_parity', { networkAccess: 'deny' })
    expect(names).toContain('read_file')
    expect(names).toContain('write_file')
    expect(names).toContain('run_shell_command')
    expect(names).not.toContain('web_search')
    expect(names).not.toContain('web_fetch')
  })
})
