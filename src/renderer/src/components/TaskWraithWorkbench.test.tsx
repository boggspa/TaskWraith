import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  buildDiffWorkbenchNavMeta,
  buildEditorWorkbenchNavMeta,
  buildInitialWorkbenchOpenState,
  buildWorkbenchBreadcrumbs,
  clampWorkbenchSplitRatio,
  isWorkbenchPaneHidden,
  resolveWorkbenchSplitResizeRatio,
  resolveInitialWorkbenchView,
  resolveWorkbenchKeyboardCommand,
  startWorkbenchSplitResizeSession,
  TaskWraithWorkbench,
  WORKBENCH_SPLIT_DEFAULT_RATIO,
  WORKBENCH_SPLIT_MAX_RATIO,
  WORKBENCH_SPLIT_MIN_RATIO,
  workbenchOpenRequestTargets,
  workbenchOpenRequestKey
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
    expect(html).toContain('Reveal')
    expect(html).toContain('Wrap')
    expect(html).toContain('Show in Diff')
    expect(html).toContain('aria-label="Reveal selected file in file tree"')
    expect(html).toContain('aria-label="Show selected file in Diff Studio"')
    expect(html).toContain('Select a file to show its diff')
    expect(html).toContain('Split')
    expect(html).toContain('Editor + diff')
    expect(html).toContain('No open files')
    expect(html).toContain('No wrap')
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="Workbench views"')
    expect(html).toContain('<nav class="workbench-breadcrumbs" aria-label="Workbench breadcrumbs"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('aria-controls="workbench-editor-panel"')
    expect(html).toContain('role="tabpanel"')
    expect(html).toContain('aria-keyshortcuts="Meta+P Control+P"')
    expect(html).toContain('aria-keyshortcuts="Meta+1 Control+1"')
    expect(html).toContain('aria-keyshortcuts="Meta+2 Control+2"')
    expect(html).toContain('aria-keyshortcuts="Meta+3 Control+3"')
    expect(html).toContain('aria-keyshortcuts="Meta+Shift+J Control+Shift+J"')
    expect(html).toContain('aria-keyshortcuts="Alt+Z"')
    expect(html).toContain('aria-keyshortcuts="Meta+Shift+D Control+Shift+D"')
  })

  it('renders deep-linked diff targets with a direct editor handoff', () => {
    expect(resolveInitialWorkbenchView('diff')).toBe('diff')
    expect(resolveInitialWorkbenchView('split')).toBe('split')
    expect(resolveInitialWorkbenchView()).toBe('editor')
    expect(workbenchOpenRequestTargets()).toEqual({ editor: true, diff: false })
    expect(workbenchOpenRequestTargets('diff')).toEqual({ editor: false, diff: true })
    expect(workbenchOpenRequestTargets('split')).toEqual({ editor: true, diff: true })
    expect(workbenchOpenRequestKey(null)).toBe('')
    expect(workbenchOpenRequestKey({ path: 'src/main/index.ts', nonce: 1, view: 'diff' })).toBe(
      '1\u0000diff\u0000src/main/index.ts'
    )
    expect(workbenchOpenRequestKey({ path: 'src/main/index.ts', nonce: 2, view: 'diff' })).not.toBe(
      workbenchOpenRequestKey({ path: 'src/main/index.ts', nonce: 1, view: 'diff' })
    )
    expect(
      buildInitialWorkbenchOpenState({
        path: 'src/main/index.ts',
        nonce: 1,
        view: 'diff'
      })
    ).toEqual({
      activeView: 'diff',
      diffSelectedPath: 'src/main/index.ts',
      diffSelectionRequest: { path: 'src/main/index.ts', nonce: 1 },
      editorOpenRequest: null,
      handledOpenRequestKey: '1\u0000diff\u0000src/main/index.ts'
    })

    const html = renderToStaticMarkup(
      <TaskWraithWorkbench
        workspacePath="/repo"
        workspaceName="Repo"
        refreshTick={0}
        openFileRequest={{ path: 'src/main/index.ts', nonce: 1, view: 'diff' }}
        onDirtyChange={() => {}}
      />
    )

    expect(html).toContain('Diff Studio')
    expect(html).toContain('src/main/index.ts')
    expect(html).toContain('Open in Editor')
    expect(html).toContain('aria-label="Open src/main/index.ts in editor"')
    expect(html).toContain('aria-keyshortcuts="Meta+Shift+E Control+Shift+E"')
    expect(html).toContain('id="workbench-diff-tab"')
    expect(html).toContain('aria-selected="true"')
  })

  it('renders split deep links as a two-pane editor and diff target', () => {
    expect(
      buildInitialWorkbenchOpenState({
        path: 'src/main/index.ts',
        nonce: 1,
        view: 'split'
      })
    ).toEqual({
      activeView: 'split',
      diffSelectedPath: 'src/main/index.ts',
      diffSelectionRequest: { path: 'src/main/index.ts', nonce: 1 },
      editorOpenRequest: { path: 'src/main/index.ts', nonce: 1 },
      handledOpenRequestKey: '1\u0000split\u0000src/main/index.ts'
    })

    const html = renderToStaticMarkup(
      <TaskWraithWorkbench
        workspacePath="/repo"
        workspaceName="Repo"
        refreshTick={0}
        openFileRequest={{ path: 'src/main/index.ts', nonce: 1, view: 'split' }}
        onDirtyChange={() => {}}
      />
    )

    expect(html).toContain('class="workbench-stage split"')
    expect(html).toContain('style="--workbench-editor-split:52%"')
    expect(html).toContain('class="workbench-split-resizer"')
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-label="Resize editor and diff panes"')
    expect(html).toContain('aria-orientation="vertical"')
    expect(html).toContain(`aria-valuemin="${WORKBENCH_SPLIT_MIN_RATIO}"`)
    expect(html).toContain(`aria-valuemax="${WORKBENCH_SPLIT_MAX_RATIO}"`)
    expect(html).toContain(`aria-valuenow="${WORKBENCH_SPLIT_DEFAULT_RATIO}"`)
    expect(html).toContain('id="workbench-split-tab"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('aria-labelledby="workbench-split-tab"')
    expect(html).toContain('Split View')
    expect(html).toContain('src/main/index.ts')
    expect(html).toContain('Open in Editor')
    expect(html).toContain('aria-label="Open src/main/index.ts in editor"')
    expect(html).not.toContain('workbench-editor-pane" role="tabpanel" id="workbench-editor-panel" hidden')
    expect(html).not.toContain('workbench-diff-pane" role="tabpanel" id="workbench-diff-panel" hidden')
  })

  it('bounds Workbench split pane ratios', () => {
    expect(clampWorkbenchSplitRatio(Number.NaN)).toBe(WORKBENCH_SPLIT_DEFAULT_RATIO)
    expect(clampWorkbenchSplitRatio(10)).toBe(WORKBENCH_SPLIT_MIN_RATIO)
    expect(clampWorkbenchSplitRatio(52.4)).toBe(52)
    expect(clampWorkbenchSplitRatio(52.6)).toBe(53)
    expect(clampWorkbenchSplitRatio(90)).toBe(WORKBENCH_SPLIT_MAX_RATIO)
  })

  it('maps split separator keyboard controls to bounded ratios', () => {
    const baseEvent = {
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      key: '',
      metaKey: false,
      shiftKey: false
    }

    expect(resolveWorkbenchSplitResizeRatio({ ...baseEvent, key: 'ArrowLeft' }, 52)).toBe(48)
    expect(resolveWorkbenchSplitResizeRatio({ ...baseEvent, key: 'ArrowRight' }, 52)).toBe(56)
    expect(
      resolveWorkbenchSplitResizeRatio({ ...baseEvent, key: 'ArrowRight', shiftKey: true }, 52)
    ).toBe(62)
    expect(resolveWorkbenchSplitResizeRatio({ ...baseEvent, key: 'Home' }, 52)).toBe(
      WORKBENCH_SPLIT_MIN_RATIO
    )
    expect(resolveWorkbenchSplitResizeRatio({ ...baseEvent, key: 'End' }, 52)).toBe(
      WORKBENCH_SPLIT_MAX_RATIO
    )
    expect(resolveWorkbenchSplitResizeRatio({ ...baseEvent, key: 'ArrowLeft' }, 10)).toBe(
      WORKBENCH_SPLIT_MIN_RATIO
    )
    expect(resolveWorkbenchSplitResizeRatio({ ...baseEvent, key: 'ArrowRight' }, 90)).toBe(
      WORKBENCH_SPLIT_MAX_RATIO
    )
    expect(resolveWorkbenchSplitResizeRatio({ ...baseEvent, key: 'x' }, 52)).toBeNull()
    expect(
      resolveWorkbenchSplitResizeRatio({ ...baseEvent, key: 'ArrowRight', metaKey: true }, 52)
    ).toBeNull()
    expect(
      resolveWorkbenchSplitResizeRatio(
        { ...baseEvent, key: 'ArrowRight', defaultPrevented: true },
        52
      )
    ).toBeNull()
  })

  it('cleans up split pointer resize listeners and capture idempotently', () => {
    const listeners = new Map<string, (event: PointerEvent) => void>()
    const addEventListener = vi.fn((type: string, listener: (event: PointerEvent) => void) => {
      listeners.set(type, listener)
    })
    const removeEventListener = vi.fn()
    const releasePointerCapture = vi.fn()
    const onFinish = vi.fn()
    const onPointerMove = vi.fn()
    const cleanup = startWorkbenchSplitResizeSession({
      onFinish,
      onPointerMove,
      pointerId: 42,
      resizerElement: {
        hasPointerCapture: () => true,
        releasePointerCapture
      },
      windowTarget: {
        addEventListener,
        removeEventListener
      }
    })

    expect(addEventListener).toHaveBeenCalledTimes(3)
    expect(addEventListener).toHaveBeenCalledWith('pointermove', onPointerMove)
    expect(addEventListener).toHaveBeenCalledWith('pointerup', listeners.get('pointerup'))
    expect(addEventListener).toHaveBeenCalledWith(
      'pointercancel',
      listeners.get('pointercancel')
    )

    listeners.get('pointerup')?.({} as PointerEvent)
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledTimes(3)
    expect(removeEventListener).toHaveBeenCalledWith('pointermove', onPointerMove)
    expect(removeEventListener).toHaveBeenCalledWith('pointerup', listeners.get('pointerup'))
    expect(removeEventListener).toHaveBeenCalledWith(
      'pointercancel',
      listeners.get('pointercancel')
    )
    expect(releasePointerCapture).toHaveBeenCalledWith(42)

    cleanup()
    listeners.get('pointercancel')?.({} as PointerEvent)
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledTimes(3)
    expect(releasePointerCapture).toHaveBeenCalledTimes(1)
  })

  it('maps Workbench keyboard shortcuts to scoped commands', () => {
    const baseEvent = {
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      key: '',
      metaKey: true,
      shiftKey: false
    }

    expect(
      resolveWorkbenchKeyboardCommand(
        { ...baseEvent, key: 'p' },
        { hasDiffEditorTarget: false, hasEditorDiffTarget: false, hasEditorSelection: false }
      )
    ).toEqual({ type: 'editor-command', kind: 'quick-open' })

    expect(
      resolveWorkbenchKeyboardCommand(
        { ...baseEvent, key: 'p', shiftKey: true },
        { hasDiffEditorTarget: false, hasEditorDiffTarget: false, hasEditorSelection: false }
      )
    ).toBeNull()

    expect(
      resolveWorkbenchKeyboardCommand(
        { ...baseEvent, key: 's', shiftKey: true },
        { hasDiffEditorTarget: false, hasEditorDiffTarget: false, hasEditorSelection: false }
      )
    ).toEqual({ type: 'editor-command', kind: 'save-all' })

    expect(
      resolveWorkbenchKeyboardCommand(
        { ...baseEvent, key: 'w' },
        { hasDiffEditorTarget: false, hasEditorDiffTarget: false, hasEditorSelection: true }
      )
    ).toEqual({ type: 'editor-command', kind: 'close-current' })

    expect(
      resolveWorkbenchKeyboardCommand(
        { ...baseEvent, key: 'j', shiftKey: true },
        { hasDiffEditorTarget: false, hasEditorDiffTarget: false, hasEditorSelection: true }
      )
    ).toEqual({ type: 'editor-command', kind: 'reveal-selected' })

    expect(
      resolveWorkbenchKeyboardCommand(
        { ...baseEvent, key: 'd', shiftKey: true },
        { hasDiffEditorTarget: false, hasEditorDiffTarget: true, hasEditorSelection: true }
      )
    ).toEqual({ type: 'show-in-diff' })

    expect(
      resolveWorkbenchKeyboardCommand(
        { ...baseEvent, key: 'e', shiftKey: true },
        { hasDiffEditorTarget: true, hasEditorDiffTarget: false, hasEditorSelection: false }
      )
    ).toEqual({ type: 'open-in-editor' })

    expect(
      resolveWorkbenchKeyboardCommand(
        {
          ...baseEvent,
          altKey: true,
          key: 'z',
          metaKey: false
        },
        { hasDiffEditorTarget: false, hasEditorDiffTarget: false, hasEditorSelection: false }
      )
    ).toEqual({ type: 'editor-command', kind: 'toggle-wrap' })

    expect(
      resolveWorkbenchKeyboardCommand(
        { ...baseEvent, key: 'd', shiftKey: true },
        { hasDiffEditorTarget: false, hasEditorDiffTarget: false, hasEditorSelection: false }
      )
    ).toBeNull()

    expect(
      resolveWorkbenchKeyboardCommand(
        { ...baseEvent, key: '2' },
        { hasDiffEditorTarget: false, hasEditorDiffTarget: false, hasEditorSelection: false }
      )
    ).toEqual({ type: 'select-view', view: 'diff', status: 'Showing Diff Studio' })
  })
})
