import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  buildDiffWorkbenchNavMeta,
  buildEditorWorkbenchNavMeta,
  buildWorkbenchBreadcrumbs,
  isWorkbenchPaneHidden,
  TaskWraithWorkbench
} from './TaskWraithWorkbench'

describe('TaskWraithWorkbench nav metadata', () => {
  it('summarizes editor tab and dirty state for the navigator', () => {
    expect(buildEditorWorkbenchNavMeta({ dirtyBufferCount: 2, openBufferCount: 4 })).toBe(
      '2 dirty'
    )
    expect(buildEditorWorkbenchNavMeta({ dirtyBufferCount: 0, openBufferCount: 3 })).toBe(
      '3 open'
    )
    expect(buildEditorWorkbenchNavMeta({ dirtyBufferCount: 0, openBufferCount: 0 })).toBe(
      'Editor'
    )
  })

  it('summarizes diff load and changed-file state for the navigator', () => {
    expect(buildDiffWorkbenchNavMeta(null)).toBe('Review')
    expect(
      buildDiffWorkbenchNavMeta({
        counts: { changed: 0, staged: 0, unstaged: 0, untracked: 0 }
      })
    ).toBe('Clean')
    expect(
      buildDiffWorkbenchNavMeta({
        counts: { changed: 7, staged: 2, unstaged: 5, untracked: 0 }
      })
    ).toBe('7 changed')
  })

  it('builds targeted breadcrumbs for editor and Diff Studio selections', () => {
    expect(
      buildWorkbenchBreadcrumbs({
        activeView: 'editor',
        editorSelectedPath: 'src/renderer/App.tsx',
        workspaceName: 'AGBench'
      })
    ).toEqual(['AGBench', 'src', 'renderer', 'App.tsx'])

    expect(
      buildWorkbenchBreadcrumbs({
        activeView: 'diff',
        diffSelectedPath: 'src/main/index.ts',
        workspaceName: 'AGBench'
      })
    ).toEqual(['AGBench', 'Diff Studio', 'src', 'main', 'index.ts'])

    expect(
      buildWorkbenchBreadcrumbs({
        activeView: 'split',
        diffSelectedPath: 'src/main/index.ts',
        workspaceName: 'AGBench'
      })
    ).toEqual(['AGBench', 'Split View', 'src', 'main', 'index.ts'])
  })
})

describe('TaskWraithWorkbench shell', () => {
  it('keeps both editor and diff panes visible in split mode', () => {
    expect(isWorkbenchPaneHidden('editor', 'editor')).toBe(false)
    expect(isWorkbenchPaneHidden('editor', 'diff')).toBe(true)
    expect(isWorkbenchPaneHidden('diff', 'editor')).toBe(true)
    expect(isWorkbenchPaneHidden('diff', 'diff')).toBe(false)
    expect(isWorkbenchPaneHidden('split', 'editor')).toBe(false)
    expect(isWorkbenchPaneHidden('split', 'diff')).toBe(false)
  })

  it('renders editor command controls and lifted status summary', () => {
    const html = renderToStaticMarkup(
      <TaskWraithWorkbench
        workspacePath="/repo"
        workspaceName="Repo"
        refreshTick={0}
        onDirtyChange={() => {}}
      />
    )

    expect(html).toContain('TaskWraith Workbench')
    expect(html).toContain('Quick Open')
    expect(html).toContain('Save All')
    expect(html).toContain('Split')
    expect(html).toContain('Editor + diff')
    expect(html).toContain('No open files')
    expect(html).toContain('No wrap')
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="Workbench views"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('aria-controls="workbench-editor-panel"')
    expect(html).toContain('role="tabpanel"')
    expect(html).toContain('aria-keyshortcuts="Meta+P Control+P"')
    expect(html).toContain('aria-keyshortcuts="Meta+1 Control+1"')
    expect(html).toContain('aria-keyshortcuts="Meta+2 Control+2"')
    expect(html).toContain('aria-keyshortcuts="Meta+3 Control+3"')
  })
})
