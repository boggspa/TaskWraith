import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const composerSource = readFileSync(new URL('../components/Composer.tsx', import.meta.url), 'utf8')
const inspectorSource = readFileSync(
  new URL('../components/Inspector.tsx', import.meta.url),
  'utf8'
)
const layoutSource = readFileSync(
  new URL('../app/views/MainAppLayout.tsx', import.meta.url),
  'utf8'
)

function sourceSlice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('composer changed-files Diff Studio interaction', () => {
  it('makes the whole primary diff summary interactive without absorbing adjacent Git controls', () => {
    const primaryWorkspaceRow = sourceSlice(
      composerSource,
      'const primaryWorkspaceAboveBar =',
      'const externalWorkspaceAboveRows ='
    )

    expect(primaryWorkspaceRow).toContain('<ComposerBranchWorktreePopover')
    expect(primaryWorkspaceRow).toContain('<GitSyncChip snapshot={primaryGitSnapshot} />')
    expect(primaryWorkspaceRow).toContain('<WorkspaceDiffStatsButton')
    expect(primaryWorkspaceRow).toContain(
      'onOpen={() => openWorkspaceDiffInInspector(primaryGitActionPath)}'
    )
    expect(primaryWorkspaceRow).toContain('onClick={() => setDiffActionMenuOpen((open) => !open)}')
    expect(primaryWorkspaceRow).toContain(
      '{useGitIconAction ? <GitCommitSymbolIcon /> : primaryLabel}'
    )
  })

  it('keeps the secondary commit-menu review route separate from the new inspector click', () => {
    const secondaryWorkspaceRows = sourceSlice(
      composerSource,
      'const externalWorkspaceAboveRows =',
      'return (\n                  <>'
    )

    expect(secondaryWorkspaceRows).toContain("kind: 'diff-studio'")
    expect(secondaryWorkspaceRows).toContain('workspacePath: group.path')
    expect(secondaryWorkspaceRows).toContain(
      'onOpenDiffStudio={() => openWorkspaceDiffInInspector(group.path)}'
    )
  })

  it('gives the inspector the workspace path carried by the freshly loaded diff', () => {
    expect(layoutSource).toContain(
      '(activeDiff as { workspacePath?: string } | null)?.workspacePath ||'
    )
    expect(inspectorSource).toContain('props.refreshDiff(effectiveWorkspacePath)')
    expect(inspectorSource).toContain('onClick={() => props.refreshDiff(effectiveWorkspacePath)}')
  })
})
