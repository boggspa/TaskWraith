import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitFileStatus, GitRepositorySnapshot } from '../../../main/services/GitService'
import type { DiffFileSummary } from '../../../main/store/types'
import { editorHighlightStyleRules } from './highlightCodeLines'
import {
  DiffDetail,
  diffDetailHeaderSummary,
  diffDetailPathDisplay,
  diffTextPreviewExcerpt,
  diffVirtualizationSummary
} from './DiffDetail'
import {
  buildDiffFileContextMenuItems,
  DiffFileList,
  diffFilePathDisplay,
  focusDiffFileContextMenuButton,
  resolveDiffFileListKeyboardAction
} from './DiffFileList'
import { DiffToolbar } from './DiffToolbar'
import {
  DiffViewer,
  diffStageGroupForSummary,
  diffStageGroupLabel,
  resolveNextDiffSelectedPath,
  resolveVisibleDiffSelection
} from './DiffViewer'

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

const makeGitStatus = (overrides: Partial<GitFileStatus> = {}): GitFileStatus => ({
  path: 'src/file.ts',
  index: ' ',
  workingTree: 'M',
  kind: 'modified',
  staged: false,
  unstaged: false,
  ...overrides
})

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

afterEach(() => {
  if (typeof document !== 'undefined') {
    document.body.innerHTML = ''
  }
})

const visibleDiffText = (html: string): string => html.replace(/<[^>]+>/g, '')

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
    expect(html).toContain('class="diff-lines-virtualization-note" role="note"')
    expect(html).toContain('Windowing 60 of 2,497 rows')
    expect(html).toContain('showing 1-60')
    expect(html).toContain('Showing first 2,500 lines')
    expect(html).toContain('504 more omitted')
    expect(html).toContain('Show 504 more')
    expect(html).not.toContain('+line 2499')
    expect(html).not.toContain('+line 2999')
    expect(html).not.toContain('diff --git')
    expect(html).toContain('class="diff-line-marker"')
    expect(visibleDiffText(html)).toContain('line 0000')
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
    expect(html).not.toContain('diff-lines-virtualization-note')
    expect(html).not.toContain('more omitted')
  })

  it('formats virtualization status only when row windowing is active', () => {
    expect(diffVirtualizationSummary(2501, { startIndex: 0, endIndex: 60 }, true)).toBe(
      'Windowing 60 of 2,501 rows · showing 1-60'
    )
    expect(diffVirtualizationSummary(2501, { startIndex: 1200, endIndex: 1260 }, true)).toBe(
      'Windowing 60 of 2,501 rows · showing 1,201-1,260'
    )
    expect(diffVirtualizationSummary(12, { startIndex: 0, endIndex: 12 }, false)).toBe('')
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

describe('DiffViewer editor-style presentation', () => {
  it('hides unified-diff chrome and syntax-highlights TypeScript source', () => {
    const rules = editorHighlightStyleRules()
    const keywordClass = rules.match(
      /\.([\w\u0370-\u03ff]+)\s*\{[^}]*color:\s*var\(--cm-keyword\)/
    )?.[1]
    expect(keywordClass).toBeTruthy()

    const html = renderToStaticMarkup(
      <DiffViewer
        diff={{
          type: 'changes',
          summaries: [
            makeSummary(
              [
                'diff --git a/src/example.ts b/src/example.ts',
                'index 1111111..2222222 100644',
                '--- a/src/example.ts',
                '+++ b/src/example.ts',
                '@@ -1,1 +1,2 @@',
                ' const keep = true',
                '+const added = "ok"'
              ].join('\n'),
              { path: 'src/example.ts', additions: 1, deletions: 0 }
            )
          ]
        }}
      />
    )

    expect(html).not.toContain('diff --git')
    expect(html).not.toContain('index 1111111')
    expect(html).not.toContain('+const added')
    expect(visibleDiffText(html)).toContain('const added')
    expect(html).toContain('class="diff-line-marker"')
    expect(html).not.toContain('class="diff-lines-column-header inline"')
    expect(html).not.toContain('class="diff-line-gutter old"')
    expect(html).toContain(`class="${keywordClass}">const</span>`)
  })
})

describe('DiffViewer visible selection resolution', () => {
  it('keeps selection on a visible file and falls back when filters hide it', () => {
    const first = makeChangedFileSummary('src/first.ts', 'first')
    const second = makeChangedFileSummary('src/second.ts', 'second')

    expect(resolveVisibleDiffSelection([first, second], 'src/second.ts')).toBe(second)
    expect(resolveVisibleDiffSelection([first, second], 'src/missing.ts')).toBe(first)
    expect(resolveVisibleDiffSelection([first, second], null)).toBe(first)
    expect(resolveVisibleDiffSelection([], 'src/second.ts')).toBeNull()
  })

  it('preserves requested paths while deep-linked diff data is still loading', () => {
    const first = makeChangedFileSummary('src/first.ts', 'first')
    const target = makeChangedFileSummary('src/target.ts', 'target')

    expect(resolveNextDiffSelectedPath(null, [], 'src/target.ts')).toBe('src/target.ts')
    expect(
      resolveNextDiffSelectedPath(
        { type: 'changes', summaries: [first, target] },
        [first, target],
        'src/target.ts'
      )
    ).toBe('src/target.ts')
    expect(
      resolveNextDiffSelectedPath({ type: 'changes', summaries: [first] }, [first], 'src/target.ts')
    ).toBe('src/first.ts')
    expect(resolveNextDiffSelectedPath({ type: 'no_changes' }, [], 'src/target.ts')).toBeNull()
  })

  it('classifies files into stage groups for toolbar filtering', () => {
    const summary = makeChangedFileSummary('src/file.ts', 'change')

    expect(diffStageGroupForSummary(summary, makeGitStatus({ staged: true, unstaged: true }))).toBe(
      'mixed'
    )
    expect(
      diffStageGroupForSummary(summary, makeGitStatus({ staged: false, unstaged: true }))
    ).toBe('unstaged')
    expect(
      diffStageGroupForSummary(summary, makeGitStatus({ staged: true, unstaged: false }))
    ).toBe('staged')
    expect(diffStageGroupForSummary({ ...summary, status: 'untracked' })).toBe('untracked')
    expect(diffStageGroupForSummary(summary)).toBe('other')
    expect(diffStageGroupLabel('untracked')).toBe('Untracked')
  })
})

describe('DiffToolbar', () => {
  it('renders counts, filtering, hide-noise state, and view-mode controls', () => {
    const html = renderToStaticMarkup(
      <DiffToolbar
        changedCount={3}
        totalCount={5}
        stageCounts={{ mixed: 1, other: 0, staged: 1, unstaged: 1, untracked: 0 }}
        activeStageGroup="unstaged"
        hideNoise={true}
        fileFilter="src"
        viewMode="split"
        onStageGroupChange={() => {}}
        onHideNoiseChange={() => {}}
        onFileFilterChange={() => {}}
        onViewModeChange={() => {}}
      />
    )

    expect(html).toContain('3 of 5 changed')
    expect(html).toContain('class="diff-toolbar-count"')
    expect(html).toContain('aria-label="Visible change groups"')
    expect(html).toContain('data-stage-group="mixed"')
    expect(html).toContain('data-stage-group="unstaged"')
    expect(html).toContain('data-active="true"')
    expect(html).toContain('data-stage-group="staged"')
    expect(html).not.toContain('data-stage-group="other"')
    expect(html).toContain('aria-label="Filter changed files"')
    expect(html).toContain('value="src"')
    expect(html).toContain('class="diff-noise-toggle"')
    expect(html).toContain('class="diff-noise-checkbox"')
    expect(html).toMatch(/type="checkbox"[^>]*checked/)
    expect(html).toContain('role="radiogroup" aria-label="Diff view mode"')
    expect(html).toContain('class="segmented-control segmented-control--compact diff-view-toggle"')
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('aria-checked="true"')
  })

  it('keeps the active stage group chip visible when its count reaches zero', () => {
    const html = renderToStaticMarkup(
      <DiffToolbar
        changedCount={0}
        totalCount={5}
        stageCounts={{ mixed: 0, other: 2, staged: 0, unstaged: 0, untracked: 0 }}
        activeStageGroup="staged"
        hideNoise={true}
        fileFilter="src"
        viewMode="inline"
        onStageGroupChange={() => {}}
        onHideNoiseChange={() => {}}
        onFileFilterChange={() => {}}
        onViewModeChange={() => {}}
      />
    )

    expect(html).toContain('data-stage-group="staged"')
    expect(html).toContain('data-active="true"')
    expect(html).toContain('<span>Staged</span><strong>0</strong>')
    expect(html).toContain('click to show all groups')
  })
})

describe('DiffFileList', () => {
  it('splits rail paths into primary filename and secondary parent folder', () => {
    expect(diffFilePathDisplay('src/renderer/App.tsx')).toEqual({
      name: 'App.tsx',
      parent: 'src/renderer'
    })
    expect(diffFilePathDisplay('README.md')).toEqual({ name: 'README.md', parent: '' })
  })

  it('renders grouped rail rows with selected state and git badges', () => {
    const summaries = [
      makeChangedFileSummary('src/unstaged.ts', 'unstaged'),
      makeChangedFileSummary('src/staged.ts', 'staged')
    ]
    const html = renderToStaticMarkup(
      <DiffFileList
        summaries={summaries}
        selectedPath="src/staged.ts"
        workspacePath="/repo"
        gitStatusByPath={
          new Map([
            [
              'src/unstaged.ts',
              {
                path: 'src/unstaged.ts',
                index: ' ',
                workingTree: 'M',
                kind: 'modified',
                staged: false,
                unstaged: true
              }
            ],
            [
              'src/staged.ts',
              {
                path: 'src/staged.ts',
                index: 'M',
                workingTree: ' ',
                kind: 'modified',
                staged: true,
                unstaged: false
              }
            ]
          ])
        }
        repoPathForSummary={(summary) => summary.path}
        onSelectPath={() => {}}
        onOpenFile={() => {}}
        onStageFile={() => {}}
        onUnstageFile={() => {}}
      />
    )

    expect(html).toContain('role="listbox"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-keyshortcuts="ContextMenu Shift+F10"')
    expect(html).toContain('class="diff-file-section-header" role="presentation"')
    expect(html).toContain('<span>Unstaged</span><small>1</small>')
    expect(html).toContain('<span>Staged</span><small>1</small>')
    expect(html).toContain('data-diff-file-path="src/staged.ts"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('class="diff-file-name"')
    expect(html).toContain('<strong>staged.ts</strong>')
    expect(html).toContain('<small>src</small>')
    expect(html).toContain('staged')
  })

  it('builds rail context menu items from git status and preview kind', () => {
    const summary = makeChangedFileSummary('src/context.ts', 'context menu')
    const items = buildDiffFileContextMenuItems({
      gitStatus: {
        path: 'src/context.ts',
        index: 'M',
        workingTree: 'M',
        kind: 'modified',
        staged: true,
        unstaged: true
      },
      onCopyPath: () => {},
      onOpenFile: () => {},
      onStageFile: () => {},
      onUnstageFile: () => {},
      summary
    })

    expect(items.map((item) => [item.id, item.disabled])).toEqual([
      ['open-editor', false],
      ['stage', false],
      ['unstage', false],
      ['copy-path', undefined]
    ])

    const hiddenItems = buildDiffFileContextMenuItems({
      onCopyPath: () => {},
      onOpenFile: () => {},
      summary: makeChangedFileSummary('secrets.env', 'redacted', {
        previewKind: 'hidden',
        status: 'hidden_sensitive'
      })
    })

    expect(hiddenItems.find((item) => item.id === 'open-editor')?.disabled).toBe(true)
    expect(hiddenItems.find((item) => item.id === 'stage')?.disabled).toBe(true)
  })

  it('resolves bounded rail keyboard navigation and activation', () => {
    const baseEvent = {
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      key: '',
      metaKey: false,
      shiftKey: false
    }
    const resolveKey = (key: string, currentIndex = 2) =>
      resolveDiffFileListKeyboardAction(
        { ...baseEvent, key },
        { currentIndex, fileCount: 5, pageSize: 3 }
      )

    expect(resolveKey('ArrowDown')).toEqual({ type: 'select', index: 3 })
    expect(resolveKey('ArrowRight', 4)).toEqual({ type: 'select', index: 4 })
    expect(resolveKey('ArrowUp')).toEqual({ type: 'select', index: 1 })
    expect(resolveKey('ArrowLeft', 0)).toEqual({ type: 'select', index: 0 })
    expect(resolveKey('Home')).toEqual({ type: 'select', index: 0 })
    expect(resolveKey('End')).toEqual({ type: 'select', index: 4 })
    expect(resolveKey('PageDown')).toEqual({ type: 'select', index: 4 })
    expect(resolveKey('PageUp')).toEqual({ type: 'select', index: 0 })
    expect(resolveKey('Enter')).toEqual({ type: 'activate', index: 2 })
    expect(resolveKey(' ')).toEqual({ type: 'activate', index: 2 })
    expect(resolveKey('Spacebar')).toEqual({ type: 'activate', index: 2 })
    expect(resolveKey('x')).toBeNull()
  })

  it('leaves rail keyboard shortcuts alone when modified or already handled', () => {
    const baseEvent = {
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      key: 'ArrowDown',
      metaKey: false,
      shiftKey: false
    }

    expect(
      resolveDiffFileListKeyboardAction(
        { ...baseEvent, defaultPrevented: true },
        { currentIndex: 0, fileCount: 3 }
      )
    ).toBeNull()
    expect(
      resolveDiffFileListKeyboardAction(
        { ...baseEvent, metaKey: true },
        { currentIndex: 0, fileCount: 3 }
      )
    ).toBeNull()
    expect(
      resolveDiffFileListKeyboardAction(
        { ...baseEvent, shiftKey: true },
        { currentIndex: 0, fileCount: 3 }
      )
    ).toBeNull()
    expect(
      resolveDiffFileListKeyboardAction(baseEvent, { currentIndex: 0, fileCount: 0 })
    ).toBeNull()
  })

  it('moves focus among enabled diff rail context menu items', () => {
    const previousDocument = globalThis.document
    const fakeDocument = { activeElement: null as unknown }
    const buttons = [
      {
        focus: () => {
          fakeDocument.activeElement = buttons[0]
        }
      },
      {
        focus: () => {
          fakeDocument.activeElement = buttons[1]
        }
      },
      {
        focus: () => {
          fakeDocument.activeElement = buttons[2]
        }
      }
    ]
    const menu = {
      querySelectorAll: () => [buttons[0], buttons[2]]
    } as unknown as HTMLDivElement

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: fakeDocument
    })

    try {
      focusDiffFileContextMenuButton(menu, 'first')
      expect(document.activeElement).toBe(buttons[0])

      focusDiffFileContextMenuButton(menu, 'next')
      expect(document.activeElement).toBe(buttons[2])

      focusDiffFileContextMenuButton(menu, 'next')
      expect(document.activeElement).toBe(buttons[0])

      focusDiffFileContextMenuButton(menu, 'last')
      expect(document.activeElement).toBe(buttons[2])

      focusDiffFileContextMenuButton(menu, 'previous')
      expect(document.activeElement).toBe(buttons[0])
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: previousDocument
      })
    }
  })
})

describe('DiffDetail', () => {
  it('splits detail header paths into primary filename and secondary parent folder', () => {
    expect(diffDetailPathDisplay('src/renderer/App.tsx')).toEqual({
      name: 'App.tsx',
      parent: 'src/renderer'
    })
    expect(diffDetailPathDisplay('README.md')).toEqual({ name: 'README.md', parent: '' })
  })

  it('bounds non-unified text previews before rendering', () => {
    const source = `${'a'.repeat(25)}\n${'b'.repeat(25)}\nTAIL`
    const excerpt = diffTextPreviewExcerpt(source, 32)

    expect(excerpt.truncated).toBe(true)
    expect(excerpt.text).toBe('a'.repeat(25))
    expect(excerpt.text).not.toContain('TAIL')
    expect(excerpt.omittedChars).toBe(source.length - 25)
  })

  it('formats compact file change summaries for the detail header', () => {
    expect(diffDetailHeaderSummary({ status: 'modified', additions: 12, deletions: 3 })).toBe(
      'modified +12 -3'
    )
    expect(diffDetailHeaderSummary({ status: 'hidden_sensitive' })).toBe('hidden')
    expect(diffDetailHeaderSummary({ status: 'too_large', deletions: 4 })).toBe('large +0 -4')
  })

  it('renders split diff rows and file actions for an unstaged file', () => {
    const summary = makeChangedFileSummary('src/detail.ts', 'detail line')
    const html = renderToStaticMarkup(
      <DiffDetail
        summary={summary}
        gitStatus={{
          path: 'src/detail.ts',
          index: ' ',
          workingTree: 'M',
          kind: 'modified',
          staged: false,
          unstaged: true
        }}
        viewMode="split"
        onOpenFile={() => {}}
        onStageFile={() => {}}
        onUnstageFile={() => {}}
      />
    )

    expect(html).toContain('class="diff-detail"')
    expect(html).toContain('src/detail.ts')
    expect(html).toContain('class="diff-detail-path"')
    expect(html).toContain('<strong>detail.ts</strong>')
    expect(html).toContain('<small>src</small>')
    expect(html).toContain('class="diff-detail-actions"')
    expect(html).toContain('class="diff-detail-stat-badge"')
    expect(html).toContain('aria-label="File change summary: modified +1 -1"')
    expect(html).toContain('modified +1 -1')
    expect(html).toContain('Stage')
    expect(html).toContain('Copy')
    expect(html).toContain('class="diff-lines-column-header split"')
    expect(html).toContain('Original')
    expect(html).toContain('Modified')
    expect(html).toContain('class="diff-line-split')
    expect(visibleDiffText(html)).toContain('detail line')
  })

  it('widens diff gutters for high line numbers', () => {
    const html = renderToStaticMarkup(
      <DiffDetail
        summary={makeSummary(
          [
            'diff --git a/src/high-lines.ts b/src/high-lines.ts',
            'index 1111111..2222222 100644',
            '--- a/src/high-lines.ts',
            '+++ b/src/high-lines.ts',
            '@@ -100000,1 +100000,1 @@',
            '-old high line',
            '+new high line'
          ].join('\n'),
          {
            path: 'src/high-lines.ts',
            additions: 1,
            deletions: 1
          }
        )}
        viewMode="inline"
      />
    )

    expect(html).toContain('--diff-gutter-width:8ch')
    expect(html).toContain('--diff-old-gutter-width:8ch')
    expect(html).toContain('--diff-new-gutter-width:8ch')
    expect(html).toContain('100000')
  })

  it('renders text previews with a cap notice instead of the full large body', () => {
    const largeText = `${'preview line\n'.repeat(2100)}unique-tail-marker`
    const html = renderToStaticMarkup(
      <DiffDetail
        summary={makeChangedFileSummary('docs/preview.md', 'preview', {
          diffText: largeText,
          previewKind: 'text_preview'
        })}
        viewMode="inline"
      />
    )

    expect(html).toContain('class="diff-text-preview"')
    expect(html).toContain('Preview capped before rendering.')
    expect(html).toContain('characters were omitted')
    expect(html).not.toContain('unique-tail-marker')
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
    expect(railMarkup).toContain('class="diff-file-list-floating-header"')
    expect(railMarkup).toContain('role="listbox"')
    expect(railMarkup).toContain('role="option"')
    expect(railMarkup).toContain('class="diff-file-list-virtual-note" role="presentation"')
    expect(railMarkup).toContain('class="diff-file-section-header" role="presentation"')
    expect(railMarkup).not.toContain('role="note"')
    expect(railMarkup).toContain('aria-selected="true"')
    expect(railMarkup).toContain('tabindex="0"')
    expect(railMarkup).toContain('tabindex="-1"')
    expect(railMarkup).toContain('data-diff-file-path="src/unstaged/file-000.ts"')
    expect(railMarkup).not.toContain('aria-pressed="true"')
    expect(railMarkup).toContain('Filter to narrow.')
    expect(railMarkup).toContain('<span>Unstaged</span><small>450</small>')
    expect(html).toContain('class="diff-detail"')
    expect(html).toContain('src/unstaged/file-000.ts')
    expect(visibleDiffText(html)).toContain('selected rail detail')
    expect(html).not.toContain('+selected rail detail')
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
    expect(html).toContain('aria-label="Visible change groups"')
    expect(html).toContain('data-stage-group="unstaged"')
    expect(html).toContain('>Unstaged</span><strong>1</strong>')
    expect(html).toContain('data-stage-group="staged"')
    expect(html).toContain('>Staged</span><strong>1</strong>')
    expect(html).toContain('data-stage-group="untracked"')
    expect(html).toContain('>Untracked</span><strong>1</strong>')
    expect(html).toContain('data-stage-group="other"')
    expect(html).toContain('>Other</span><strong>797</strong>')
    expect(html).toContain('aria-label="Filter changed files"')
    expect(html).toMatch(/type="checkbox"[^>]*checked/)
    expect(html).toContain('Hide noise')
    expect(html).toContain('role="radiogroup" aria-label="Diff view mode"')
    expect(html).toContain('<span>Unstaged</span><small>1</small>')
    expect(html).toContain('<span>Staged</span><small>1</small>')
    expect(html).toContain('<span>Untracked</span><small>1</small>')
    expect(html).toContain('<span>Other</span><small>797</small>')
    expect(html).not.toContain('src/noise/generated-000.ts')
  })
})
