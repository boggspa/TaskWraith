import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { EditorPane } from './FileEditorPane'
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
    expect(html).toContain('aria-selected="false"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('Close src/Editor.tsx')
    expect(html).toContain('file-editor-dirty-dot')
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
      />
    )

    expect(html).toContain('Reload')
    expect(html).toContain('aria-label="Reload editor file from disk"')
    expect(html).toContain('Reload from disk and discard unsaved changes')
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
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-keyshortcuts="ContextMenu Shift+F10"')
    expect(html).toContain('App.tsx')
    expect(html).toContain('2 KB')
  })
})

describe('EditorPane', () => {
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
