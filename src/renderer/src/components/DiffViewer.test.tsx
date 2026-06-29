import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import type { DiffFileSummary } from '../../../main/store/types'
import { DiffViewer } from './DiffViewer'

const makeLargeUnifiedDiff = (lineCount: number): string => {
  const lines = [
    'diff --git a/src/large.ts b/src/large.ts',
    'index 1111111..2222222 100644',
    '--- a/src/large.ts',
    '+++ b/src/large.ts',
    `@@ -1,0 +1,${lineCount} @@`
  ]
  for (let index = 0; index < lineCount; index += 1) {
    lines.push(`+line ${String(index).padStart(4, '0')}`)
  }
  return lines.join('\n')
}

const makeSummary = (
  diffText: string,
  overrides: Partial<DiffFileSummary> = {}
): DiffFileSummary => ({
  path: 'src/large.ts',
  status: 'modified',
  additions: 3000,
  deletions: 0,
  previewKind: 'git_diff',
  diffText,
  ...overrides
})

const makeSmallUnifiedDiff = (path: string, addedLine: string): string =>
  [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,1 @@',
    '-old',
    `+${addedLine}`
  ].join('\n')

const makeChangedFileSummary = (
  path: string,
  addedLine: string,
  overrides: Partial<DiffFileSummary> = {}
): DiffFileSummary =>
  makeSummary(makeSmallUnifiedDiff(path, addedLine), {
    additions: 1,
    deletions: 1,
    path,
    status: 'modified',
    ...overrides
  })

const makeLargeChangedFileFixture = (
  options: Partial<{
    noiseCount: number
    otherCount: number
    stagedCount: number
    unstagedCount: number
    untrackedCount: number
  }> = {}
): {
  gitSnapshot: GitRepositorySnapshot
  summaries: DiffFileSummary[]
} => {
  const {
    noiseCount = 100,
    otherCount = 0,
    stagedCount = 250,
    unstagedCount = 450,
    untrackedCount = 100
  } = options
  const summaries: DiffFileSummary[] = []
  const gitFiles: GitRepositorySnapshot['files'] = []

  for (let index = 0; index < unstagedCount; index += 1) {
    const path = `src/unstaged/file-${String(index).padStart(3, '0')}.ts`
    summaries.push(
      makeChangedFileSummary(
        path,
        index === 0 ? 'selected rail detail' : `unstaged rail file ${index}`
      )
    )
    gitFiles.push({
      path,
      index: ' ',
      workingTree: 'M',
      kind: 'modified',
      staged: false,
      unstaged: true
    })
  }

  for (let index = 0; index < stagedCount; index += 1) {
    const path = `src/staged/file-${String(index).padStart(3, '0')}.ts`
    summaries.push(makeChangedFileSummary(path, `staged rail file ${index}`))
    gitFiles.push({
      path,
      index: 'M',
      workingTree: ' ',
      kind: 'modified',
      staged: true,
      unstaged: false
    })
  }

  for (let index = 0; index < untrackedCount; index += 1) {
    const path = `src/untracked/file-${String(index).padStart(3, '0')}.ts`
    summaries.push(
      makeChangedFileSummary(path, `untracked rail file ${index}`, {
        status: 'untracked'
      })
    )
  }

  for (let index = 0; index < otherCount; index += 1) {
    const path = `src/other/file-${String(index).padStart(3, '0')}.ts`
    summaries.push(makeChangedFileSummary(path, `other rail file ${index}`))
  }

  for (let index = 0; index < noiseCount; index += 1) {
    const path = `src/noise/generated-${String(index).padStart(3, '0')}.ts`
    summaries.push(
      makeChangedFileSummary(path, `noise rail file ${index}`, {
        isNoise: true,
        status: 'noise'
      })
    )
  }

  return {
    summaries,
    gitSnapshot: {
      requestedPath: '/repo',
      repoRoot: '/repo',
      detached: false,
      ahead: 0,
      behind: 0,
      files: gitFiles,
      counts: {
        changed: summaries.length,
        staged: stagedCount,
        unstaged: unstagedCount,
        untracked: untrackedCount
      },
      clean: false,
      mergeState: null,
      conflicts: 0,
      lineStats: { additions: summaries.length, deletions: summaries.length }
    }
  }
}

describe('DiffViewer large diff safety', () => {
  it('server-renders only the initial virtual window and shows truncation controls', () => {
    const html = renderToStaticMarkup(
      <DiffViewer
        diff={{
          type: 'changes',
          summaries: [makeSummary(makeLargeUnifiedDiff(3000))]
        }}
      />
    )

    const renderedAddRows = html.match(/class="diff-line add"/g)?.length ?? 0
    expect(renderedAddRows).toBeGreaterThan(0)
    expect(renderedAddRows).toBeLessThan(100)
    expect(html).toContain('class="diff-lines-stack virtualized"')
    expect(html).toContain('class="diff-lines-truncated"')
    expect(html).toContain('role="note"')
    expect(html).toContain('Showing first 2,500 lines')
    expect(html).toContain('504 more omitted')
    expect(html).toContain('Show 504 more')
    expect(html).not.toContain('+line 2499')
    expect(html).not.toContain('+line 2999')
  })

  it('does not show renderer truncation for a complete small diff', () => {
    const html = renderToStaticMarkup(
      <DiffViewer
        diff={{
          type: 'changes',
          summaries: [makeSummary(['@@ -1,1 +1,1 @@', '-old', '+new'].join('\n'))]
        }}
      />
    )

    expect(html).not.toContain('class="diff-lines-truncated"')
    expect(html).not.toContain('more omitted')
  })

  it('labels source-capped previews separately from renderer truncation', () => {
    const html = renderToStaticMarkup(
      <DiffViewer
        diff={{
          type: 'changes',
          summaries: [
            makeSummary(['@@ -1,1 +1,1 @@', '-old', '+new'].join('\n'), {
              diffTextOmittedLines: 42,
              diffTextTruncated: true
            })
          ]
        }}
      />
    )

    expect(html).toContain('diff-lines-source-truncated')
    expect(html).toContain('Preview capped before rendering.')
    expect(html).toContain('42 source lines were omitted.')
    expect(html).not.toContain('Showing first')
  })
})

describe('DiffViewer changed-file rail virtualization', () => {
  it('server-renders only a bounded rail window for a large changed-file list while keeping selected detail', () => {
    const { gitSnapshot, summaries } = makeLargeChangedFileFixture()
    const html = renderToStaticMarkup(
      <DiffViewer
        diff={{
          type: 'changes',
          summaries
        }}
        gitSnapshot={gitSnapshot}
        workspacePath="/repo"
      />
    )

    const renderedRailRows = html.match(/class="diff-file-row/g)?.length ?? 0
    const railMarkup =
      html.match(/<div class="diff-file-list virtualized"[\s\S]*?<div class="diff-detail"/)?.[0] ??
      ''
    expect(renderedRailRows).toBeGreaterThan(0)
    expect(renderedRailRows).toBeLessThan(160)
    expect(railMarkup).toContain('class="diff-file-list virtualized"')
    expect(railMarkup).toContain('role="listbox"')
    expect(railMarkup).toContain('role="option"')
    expect(railMarkup).toContain('aria-selected="true"')
    expect(railMarkup).toContain('tabindex="0"')
    expect(railMarkup).toContain('tabindex="-1"')
    expect(railMarkup).toContain('data-diff-file-path="src/unstaged/file-000.ts"')
    expect(railMarkup).not.toContain('aria-pressed="true"')
    expect(railMarkup).toContain('Filter to narrow.')
    expect(html).toContain('class="diff-detail"')
    expect(html).toContain('src/unstaged/file-000.ts')
    expect(html).toContain('+selected rail detail')
    expect(html).not.toContain('src/unstaged/file-449.ts')
    expect(html).not.toContain('src/staged/file-249.ts')
  })

  it('keeps grouping and filter affordances visible around the virtualized rail', () => {
    const { gitSnapshot, summaries } = makeLargeChangedFileFixture({
      otherCount: 797,
      stagedCount: 1,
      unstagedCount: 1,
      untrackedCount: 1
    })
    const html = renderToStaticMarkup(
      <DiffViewer
        diff={{
          type: 'changes',
          summaries
        }}
        gitSnapshot={gitSnapshot}
        workspacePath="/repo"
      />
    )

    expect(html).toContain('800 of 900 changed')
    expect(html).toContain('aria-label="Filter changed files"')
    expect(html).toMatch(/type="checkbox"[^>]*checked/)
    expect(html).toContain('Hide noise')
    expect(html).toContain('role="group" aria-label="Diff view mode"')
    expect(html).toContain('<span>Unstaged</span><small>1</small>')
    expect(html).toContain('<span>Staged</span><small>1</small>')
    expect(html).toContain('<span>Untracked</span><small>1</small>')
    expect(html).toContain('<span>Other</span><small>797</small>')
    expect(html).not.toContain('src/noise/generated-000.ts')
  })
})
