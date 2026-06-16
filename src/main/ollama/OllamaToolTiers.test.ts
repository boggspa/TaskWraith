import os from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { AppSettings } from '../store/types'
import {
  canonicalizeOllamaWorkspacePath,
  effectiveOllamaToolControlTier,
  ollamaProviderParityWorkspaceGranted,
  ollamaToolNamesForTier
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

  it('expands a leading ~', () => {
    expect(canonicalizeOllamaWorkspacePath('~')).toBe(os.homedir())
    expect(canonicalizeOllamaWorkspacePath('~/code/app')).toBe(join(os.homedir(), 'code/app'))
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

  it('matches across ~ expansion vs absolute home path', () => {
    const abs = join(os.homedir(), 'code/app')
    const settings = settingsWith('provider_parity', { [abs]: '2026-01-01T00:00:00Z' })
    expect(ollamaProviderParityWorkspaceGranted(settings, '~/code/app')).toBe(true)
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
})

describe('ollamaToolNamesForTier (edit-tool gating sanity)', () => {
  it('excludes file-edit tools at read_only', () => {
    const names = ollamaToolNamesForTier('read_only')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('replace')
    expect(names).not.toContain('apply_patch')
  })

  it('includes file-edit tools at approved_edits and provider_parity', () => {
    for (const tier of ['approved_edits', 'approved_shell', 'provider_parity'] as const) {
      const names = ollamaToolNamesForTier(tier)
      expect(names).toContain('write_file')
      expect(names).toContain('replace')
      expect(names).toContain('apply_patch')
    }
  })
})
