import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import type { ExternalPathGrant } from '../../../main/store/types'
import { buildExternalPathOriginTooltip, ExternalPathAboveRow } from './ExternalPathAboveRow'

// 1.0.5-EW42b — Pure-helper coverage for the banner origin
// tooltip. Verifies each grant-id prefix maps to the correct
// origin phrase, the provider name is human-readable, and the
// ISO `createdAt` is formatted via `Date.toLocaleString` (the
// exact format is locale-specific so we only check that the year
// digits appear somewhere — that's enough to confirm the path
// took the parse-then-format branch, not the raw-string
// fallback).
function makeGrant(overrides: Partial<ExternalPathGrant> = {}): ExternalPathGrant {
  return {
    id: 'runtime-1700000000000-abcd',
    provider: 'codex',
    chatId: 'chat-1',
    path: '/repo/sibling',
    kind: 'directory',
    access: 'read',
    duration: 'thisThread',
    createdAt: '2026-05-27T22:00:00.000Z',
    ...overrides
  }
}

function makeSnapshot(overrides: Partial<GitRepositorySnapshot> = {}): GitRepositorySnapshot {
  return {
    requestedPath: '/Users/me/Documents/AGBench',
    repoRoot: '/Users/me/Documents/AGBench',
    branch: 'master',
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    detached: false,
    upstream: 'origin/master',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/boggspa/TaskWraith.git',
    ahead: 0,
    behind: 0,
    files: [],
    counts: { changed: 0, staged: 0, unstaged: 0, untracked: 0 },
    clean: true,
    mergeState: null,
    conflicts: 0,
    lineStats: { additions: 0, deletions: 0 },
    ...overrides
  }
}

function renderWorkspaceRow(
  overrides: {
    workspaceDisplayName?: string
    snapshot?: GitRepositorySnapshot
  } = {}
): string {
  const props = {
    grant: makeGrant({ path: '/Users/me/Documents/AGBench', kind: 'directory' }),
    repoMetadata: {
      isRepo: true,
      repoRoot: '/Users/me/Documents/AGBench',
      branch: 'master'
    },
    snapshot: overrides.snapshot ?? makeSnapshot(),
    workspaceDisplayName: overrides.workspaceDisplayName
  }
  return renderToStaticMarkup(createElement(ExternalPathAboveRow, props))
}

describe('buildExternalPathOriginTooltip', () => {
  it('returns the proactive phrase for proactive-prefixed ids (EW42a-issued)', () => {
    const tooltip = buildExternalPathOriginTooltip(
      makeGrant({ id: 'proactive-1700000000000-codex-abcd' })
    )
    expect(tooltip).toMatch(/You granted this via the composer workspace switcher\./)
    // Provider name + secondary-workspace scope still appear in the header line.
    expect(tooltip).toMatch(/Codex/)
    expect(tooltip).toMatch(/secondary workspace/)
  })

  it('returns the runtime/approval phrase for runtime-prefixed ids', () => {
    const tooltip = buildExternalPathOriginTooltip(
      makeGrant({ id: 'runtime-1700000000000-abcd', provider: 'claude' })
    )
    expect(tooltip).toMatch(/Claude requested access during a tool call/)
    expect(tooltip).toMatch(/you approved it/)
  })

  it('returns a manual-picker phrase for legacy ids (numeric prefix, no known marker)', () => {
    const tooltip = buildExternalPathOriginTooltip(makeGrant({ id: '1700000000000-abcd' }))
    expect(tooltip).toMatch(/Granted manually via an older picker\./)
  })

  it('uses the provider label, secondary scope, and a parsed timestamp in the header line', () => {
    const tooltip = buildExternalPathOriginTooltip(
      makeGrant({
        id: 'proactive-x',
        provider: 'gemini',
        access: 'write',
        createdAt: '2026-05-27T22:00:00.000Z'
      })
    )
    // First line: "<Provider> · secondary workspace · <when>".
    const [header] = tooltip.split('\n')
    expect(header).toMatch(/Gemini/)
    expect(header).toMatch(/secondary workspace/)
    // Some locale-formatted date appears — at minimum the year
    // shows up after toLocaleString parses the ISO timestamp.
    expect(header).toMatch(/2026/)
  })

  it('falls back to the raw createdAt string when parsing yields NaN', () => {
    const tooltip = buildExternalPathOriginTooltip(makeGrant({ createdAt: 'not-a-date' }))
    const [header] = tooltip.split('\n')
    expect(header).toMatch(/not-a-date/)
  })

  it('does not surface read/write access wording in the header line', () => {
    const tooltip = buildExternalPathOriginTooltip(makeGrant({ access: 'write' }))
    expect(tooltip.split('\n')[0]).toMatch(/secondary workspace/)
    expect(tooltip.split('\n')[0]).not.toMatch(/edit access/)
    expect(tooltip.split('\n')[0]).not.toMatch(/read access/)
  })

  it('runtime-prefixed write grants combine the verb + provider name correctly', () => {
    const tooltip = buildExternalPathOriginTooltip(
      makeGrant({
        id: 'runtime-1700000000000-abcd',
        provider: 'kimi',
        access: 'write'
      })
    )
    expect(tooltip).toMatch(/Kimi requested access during a tool call/)
    expect(tooltip.split('\n')[0]).toMatch(/secondary workspace/)
  })
})

describe('ExternalPathAboveRow workspace name', () => {
  it('uses the git remote project instead of a default folder-derived label', () => {
    const html = renderWorkspaceRow()

    expect(html).toContain('>TaskWraith · <button')
    expect(html).not.toContain('>AGBench · <button')
  })

  it('preserves a registered custom workspace label over the git project name', () => {
    const html = renderWorkspaceRow({ workspaceDisplayName: 'Client demo' })

    expect(html).toContain('>Client demo · <button')
    expect(html).not.toContain('>TaskWraith · <button')
  })

  it('uses the same direct three-pill contract as the primary workspace row', () => {
    const html = renderToStaticMarkup(
      createElement(ExternalPathAboveRow, {
        grant: makeGrant({ path: '/Users/me/Documents/AGBench', kind: 'directory' }),
        repoMetadata: {
          isRepo: true,
          repoRoot: '/Users/me/Documents/AGBench',
          branch: 'master'
        },
        snapshot: makeSnapshot(),
        diffStats: { filesChanged: 2, additions: 7, deletions: 3 },
        createPrState: { status: 'idle' },
        onCreatePr: () => undefined,
        onOpenDiffStudio: () => undefined,
        composerStyle: 'cursor'
      })
    )

    expect(html).toContain('composer-workspace-above-row')
    expect(html).not.toContain('composer-above-bar-center-cluster')
    expect(html).not.toContain('composer-above-bar-trailing-cluster')

    const gitPill = html.indexOf('composer-above-bar-pill--git')
    const changesPill = html.indexOf('composer-above-bar-pill--changes')
    const actionPill = html.indexOf('composer-above-bar-pill--action')
    expect(gitPill).toBeGreaterThan(-1)
    expect(changesPill).toBeGreaterThan(gitPill)
    expect(actionPill).toBeGreaterThan(changesPill)
    expect(html).toContain('composer-above-bar-stat-clickable')
    expect(html).toContain('Open Diff Studio for 2 changed files in TaskWraith')
  })

  it('surfaces a diverged secondary workspace through the shared Git sync chip', () => {
    const html = renderToStaticMarkup(
      createElement(ExternalPathAboveRow, {
        grant: makeGrant({ path: '/Users/me/Documents/AGBench', kind: 'directory' }),
        repoMetadata: {
          isRepo: true,
          repoRoot: '/Users/me/Documents/AGBench',
          branch: 'master'
        },
        snapshot: makeSnapshot({ ahead: 3, behind: 2 }),
        onOpenCommits: () => undefined
      })
    )

    expect(html).toContain('git-sync-diverged')
    expect(html).toContain('git-status-push-clickable')
    expect(html).toContain('role="button"')
    expect(html).toContain('git-status-drift-glyph')
    expect(html).toContain('<span class="sr-only">3 ahead</span>')
    expect(html).toContain('<span class="sr-only">2 behind</span>')
    expect(html).toContain('local tracking ref origin/master')
  })
})
