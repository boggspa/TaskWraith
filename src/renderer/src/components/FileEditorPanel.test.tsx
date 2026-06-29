import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FileEditorGitActions } from './FileEditorGitActions'
import { FileEditorStatusBar } from './FileEditorStatusBar'
import { EditorTabStrip } from './FileEditorPanel'

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
    expect(html).toContain('aria-selected="false" tabindex="-1"')
    expect(html).toContain('aria-selected="true" tabindex="0"')
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
