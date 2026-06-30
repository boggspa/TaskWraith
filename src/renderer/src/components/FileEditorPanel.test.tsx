import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  explicitOnlyCompletionSource,
  fileEditorBreadcrumbParts,
  fileEditorDirtyActionCopy,
  isFileEditorPromptDismissKey,
  QuickOpenPalette,
  quickOpenOptionId,
  resolveFileEditorKeyboardCommand
} from './FileEditorPanel'
import { EditorPane, FILE_EDITOR_BASIC_SETUP } from './FileEditorPane'
import { FileEditorGitActions } from './FileEditorGitActions'
import { FileEditorStatusBar } from './FileEditorStatusBar'
import { EditorTabStrip } from './FileEditorTabStrip'
import {
  contextMenuAnchorFromRect,
  isFileEditorContextMenuKey
} from './FileEditorUtils'
import { WorkspaceFileTree } from './WorkspaceFileTree'

describe('EditorTabStrip', () => {
  it('renders a roving tablist with the active tab as the only tab stop', () => {
    const html = renderToStaticMarkup(
      <EditorTabStrip
        buffers={[
          {
            path: 'src/App.tsx',
            content: '',
            savedContent: '',
            savedEtag: null,
            sizeBytes: 128
          },
          {
            path: 'src/Editor.tsx',
            content: 'draft',
            savedContent: '',
            savedEtag: null,
            sizeBytes: 256
          }
        ]}
        selectedPath="src/Editor.tsx"
        workspacePath="/repo"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onContextMenuTab={vi.fn()}
      />
    )

    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="Open editor files"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-keyshortcuts="ContextMenu Shift+F10"')
    expect(html).toContain('Meta+W Control+W')
    expect(html).toContain('aria-selected="false"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('Close src/Editor.tsx (Cmd/Ctrl+W)')
    expect(html).toContain('file-editor-dirty-dot')
  })
})

describe('file editor breadcrumbs', () => {
  it('splits workspace-relative paths into compact breadcrumb parts', () => {
    expect(fileEditorBreadcrumbParts('src/renderer/src/App.tsx')).toEqual([
      'src',
      'renderer',
      'src',
      'App.tsx'
    ])
    expect(fileEditorBreadcrumbParts('README.md')).toEqual(['README.md'])
    expect(fileEditorBreadcrumbParts('')).toEqual([])
  })
})

describe('FileEditorGitActions', () => {
  it('renders reload-from-disk recovery for the selected file', () => {
    const html = renderToStaticMarkup(
      <FileEditorGitActions
        workspacePath="/repo"
        selectedPath="src/App.tsx"
        isDirty={true}
        isLoading={false}
        selectedHasUnstagedChanges={false}
        selectedHasStagedChanges={false}
        stagedCount={0}
        outOfScopeStagedCount={0}
        dirtyBufferCount={1}
        lineWrapEnabled={false}
        onDeleteRequest={vi.fn()}
        onStage={vi.fn()}
        onUnstage={vi.fn()}
        onCommitRequest={vi.fn()}
        onSaveAll={vi.fn()}
        onSave={vi.fn()}
        onReloadSelected={vi.fn()}
        onToggleLineWrap={vi.fn()}
        onOpenQuickOpen={vi.fn()}
        onRevealInTree={vi.fn()}
        onShowInDiff={vi.fn()}
      />
    )

    expect(html).toContain('Reload')
    expect(html).toContain('aria-label="Reload editor file from disk"')
    expect(html).toContain('Reload from disk and discard unsaved changes')
    expect(html).toContain('aria-keyshortcuts="Meta+P Control+P"')
    expect(html).toContain('aria-keyshortcuts="Meta+S Control+S"')
    expect(html).toContain('aria-keyshortcuts="Meta+Shift+S Control+Shift+S"')
    expect(html).toContain('aria-keyshortcuts="Meta+Shift+J Control+Shift+J"')
    expect(html).toContain('aria-keyshortcuts="Meta+Shift+D Control+Shift+D"')
    expect(html).toContain('aria-keyshortcuts="Alt+Z"')
    expect(html).toContain('Show in Diff')
  })
})

describe('WorkspaceFileTree', () => {
  it('renders the workspace navigator with expanded, selected, and sized rows', () => {
    const html = renderToStaticMarkup(
      <WorkspaceFileTree
        workspacePath="/repo"
        filter=""
        fileListStatus="2 items in root"
        displayedFiles={[
          {
            path: 'src',
            name: 'src',
            isDirectory: true,
            depth: 0,
            hasChildren: true
          },
          {
            path: 'src/App.tsx',
            name: 'App.tsx',
            isDirectory: false,
            depth: 1,
            sizeBytes: 2048
          }
        ]}
        expandedDirectories={new Set(['src'])}
        selectedPath="src/App.tsx"
        isFiltering={false}
        isLoading={false}
        isListLoading={false}
        onFilterChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenEntry={vi.fn()}
        onContextMenuEntry={vi.fn()}
      />
    )

    expect(html).toContain('aria-label="Workspace file navigator"')
    expect(html).toContain('role="tree"')
    expect(html).toContain('role="treeitem"')
    expect(html).toContain('role="presentation"')
    expect(html).toContain('aria-level="1"')
    expect(html).toContain('aria-level="2"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-keyshortcuts="ContextMenu Shift+F10"')
    expect(html).toContain('App.tsx')
    expect(html).toContain('2 KB')
  })

  it('server-renders only a bounded virtual window for very large navigators', () => {
    const displayedFiles = Array.from({ length: 900 }, (_, index) => ({
      path: `src/file-${String(index).padStart(3, '0')}.ts`,
      name: `file-${String(index).padStart(3, '0')}.ts`,
      isDirectory: false,
      depth: 1,
      sizeBytes: 128
    }))
    const html = renderToStaticMarkup(
      <WorkspaceFileTree
        workspacePath="/repo"
        filter=""
        fileListStatus="900 files"
        displayedFiles={displayedFiles}
        expandedDirectories={new Set(['src'])}
        selectedPath="src/file-000.ts"
        isFiltering={false}
        isLoading={false}
        isListLoading={false}
        onFilterChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenEntry={vi.fn()}
        onContextMenuEntry={vi.fn()}
      />
    )

    const renderedRows = html.match(/class="file-editor-row/g)?.length ?? 0
    expect(renderedRows).toBeGreaterThan(0)
    expect(renderedRows).toBeLessThan(90)
    expect(html).toContain('class="file-editor-list virtualized"')
    expect(html).toContain('data-total-rows="900"')
    expect(html).toContain('data-file-editor-index="0"')
    expect(html).toContain('src/file-000.ts')
    expect(html).not.toContain('src/file-899.ts')
  })
})

describe('EditorPane', () => {
  it('keeps CodeMirror fold controls enabled while owning autocomplete separately', () => {
    expect(FILE_EDITOR_BASIC_SETUP).toMatchObject({
      lineNumbers: true,
      foldGutter: true,
      autocompletion: false
    })
  })

  it('renders the empty editor placeholder before a file is selected', () => {
    const html = renderToStaticMarkup(
      <EditorPane
        selectedPath=""
        content=""
        isLoading={false}
        editorExtensions={[]}
        onContentChange={vi.fn()}
      />
    )

    expect(html).toContain('file-editor-code-surface')
    expect(html).toContain('Select a text file')
  })
})

describe('QuickOpenPalette', () => {
  it('renders an accessible combobox with a selected result option', () => {
    const html = renderToStaticMarkup(
      <QuickOpenPalette
        workspacePath="/repo"
        query="app"
        results={[
          {
            path: 'src/App.tsx',
            name: 'App.tsx',
            isDirectory: false,
            depth: 1,
            sizeBytes: 2048
          },
          {
            path: 'src/App.test.tsx',
            name: 'App.test.tsx',
            isDirectory: false,
            depth: 1,
            sizeBytes: 4096
          }
        ]}
        status="2 matches"
        isLoading={false}
        selectedIndex={1}
        onQueryChange={vi.fn()}
        onSelectedIndexChange={vi.fn()}
        onOpenPath={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-controls="file-editor-quick-open-results"')
    expect(html).toContain(`aria-activedescendant="${quickOpenOptionId(1)}"`)
    expect(html).toContain('role="listbox"')
    expect(html).toContain('role="option"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('file-editor-quick-open-label')
    expect(html).toContain('<strong>App.test.tsx</strong>')
    expect(html).toContain('src/App.test.tsx')
  })
})

describe('FileEditorStatusBar', () => {
  it('renders cursor, selection, wrap, size, and git state summaries', () => {
    const html = renderToStaticMarkup(
      <FileEditorStatusBar
        activeBuffer={{
          path: 'src/App.tsx',
          sizeBytes: 2048
        }}
        isDirty={false}
        status="Ready"
        gitMessage=""
        cursorStatus={{ line: 12, column: 4, selectedChars: 9 }}
        selectedGitFile={{
          path: 'src/App.tsx',
          index: 'M',
          workingTree: 'M',
          kind: 'modified',
          staged: true,
          unstaged: true
        }}
        selectedHasStagedChanges={true}
        selectedHasUnstagedChanges={true}
        lineWrapEnabled={true}
      />
    )

    expect(html).toContain('Ready')
    expect(html).toContain('src/App.tsx')
    expect(html).toContain('2 KB')
    expect(html).toContain('Ln 12, Col 4 · 9 selected')
    expect(html).toContain('Wrap')
    expect(html).toContain('staged + unstaged')
  })
})

describe('file editor keyboard context menu utilities', () => {
  it('recognizes platform context-menu shortcuts without taking plain F10', () => {
    expect(isFileEditorContextMenuKey('ContextMenu', false)).toBe(true)
    expect(isFileEditorContextMenuKey('F10', true)).toBe(true)
    expect(isFileEditorContextMenuKey('F10', false)).toBe(false)
    expect(isFileEditorContextMenuKey('Enter', false)).toBe(false)
  })

  it('places keyboard-opened menus near the focused row or tab', () => {
    expect(contextMenuAnchorFromRect({ left: 100, top: 40, width: 180, height: 36 })).toEqual({
      x: 128,
      y: 64
    })
    expect(contextMenuAnchorFromRect({ left: 12, top: 8, width: 6, height: 3 })).toEqual({
      x: 12,
      y: 8
    })
  })
})

describe('file editor completion sources', () => {
  it('keeps local word completions explicit-only', () => {
    const source = vi.fn(() => ({ from: 0, options: [{ label: 'workspaceWord' }] }))
    const wrapped = explicitOnlyCompletionSource(source)
    const implicitContext = { explicit: false } as Parameters<typeof wrapped>[0]
    const explicitContext = { explicit: true } as Parameters<typeof wrapped>[0]

    expect(wrapped(implicitContext)).toBeNull()
    expect(source).not.toHaveBeenCalled()
    expect(wrapped(explicitContext)).toEqual({
      from: 0,
      options: [{ label: 'workspaceWord' }]
    })
    expect(source).toHaveBeenCalledWith(explicitContext)
  })
})

describe('file editor keyboard commands', () => {
  it('maps standalone editor shortcuts to scoped commands', () => {
    const baseEvent = {
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      key: '',
      metaKey: true,
      shiftKey: false
    }

    expect(
      resolveFileEditorKeyboardCommand(
        { ...baseEvent, key: 'p' },
        { canRevealSelected: false, canShowInDiff: false }
      )
    ).toEqual({ type: 'editor-command', kind: 'quick-open' })

    expect(
      resolveFileEditorKeyboardCommand(
        { ...baseEvent, key: 'p', shiftKey: true },
        { canRevealSelected: false, canShowInDiff: false }
      )
    ).toBeNull()

    expect(
      resolveFileEditorKeyboardCommand(
        { ...baseEvent, key: 's' },
        { canRevealSelected: false, canShowInDiff: false }
      )
    ).toEqual({ type: 'editor-command', kind: 'save-current' })

    expect(
      resolveFileEditorKeyboardCommand(
        { ...baseEvent, key: 'w' },
        { canRevealSelected: false, canShowInDiff: false }
      )
    ).toEqual({ type: 'editor-command', kind: 'close-current' })

    expect(
      resolveFileEditorKeyboardCommand(
        { ...baseEvent, key: 's', shiftKey: true },
        { canRevealSelected: false, canShowInDiff: false }
      )
    ).toEqual({ type: 'editor-command', kind: 'save-all' })

    expect(
      resolveFileEditorKeyboardCommand(
        { ...baseEvent, key: 'j', shiftKey: true },
        { canRevealSelected: true, canShowInDiff: false }
      )
    ).toEqual({ type: 'editor-command', kind: 'reveal-selected' })

    expect(
      resolveFileEditorKeyboardCommand(
        { ...baseEvent, key: 'd', shiftKey: true },
        { canRevealSelected: true, canShowInDiff: true }
      )
    ).toEqual({ type: 'show-in-diff' })

    expect(
      resolveFileEditorKeyboardCommand(
        { ...baseEvent, altKey: true, key: 'z', metaKey: false },
        { canRevealSelected: false, canShowInDiff: false }
      )
    ).toEqual({ type: 'editor-command', kind: 'toggle-wrap' })

    expect(
      resolveFileEditorKeyboardCommand(
        { ...baseEvent, key: 'd', shiftKey: true },
        { canRevealSelected: true, canShowInDiff: false }
      )
    ).toBeNull()
  })
})

describe('file editor dirty action prompts', () => {
  it('warns before replacing dirty buffers from disk', () => {
    expect(fileEditorDirtyActionCopy('reload', 'src/App.tsx')).toEqual({
      title: 'Reload from disk?',
      body: 'Reloading src/App.tsx will replace your unsaved edits with the file on disk.',
      confirmLabel: 'Reload',
      danger: false
    })
  })

  it('marks discard as destructive', () => {
    expect(fileEditorDirtyActionCopy('discard', 'src/App.tsx')).toEqual({
      title: 'Discard changes?',
      body: 'Discard unsaved edits in src/App.tsx?',
      confirmLabel: 'Discard',
      danger: true
    })
  })

  it('limits prompt keyboard dismissal to Escape', () => {
    expect(isFileEditorPromptDismissKey('Escape')).toBe(true)
    expect(isFileEditorPromptDismissKey('Enter')).toBe(false)
    expect(isFileEditorPromptDismissKey('F10')).toBe(false)
  })
})
