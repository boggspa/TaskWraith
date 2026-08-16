import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PopoutApp,
  popoutKindReceivesOpenFileBroadcast,
  resolvePopoutOpenFileView,
  resolvePopoutWorkspaceIpcTarget
} from './PopoutApp'
import {
  popoutAllowsGitMutations,
  refreshPopoutGitMutationCapability
} from './lib/workspacePopoutCapabilities'

const diffViewerCapture = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>
}))

const revisionDiffStudioCapture = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>
}))

const fileEditorCapture = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>
}))

vi.mock('./hooks/useAppearance', () => ({
  useAppearance: () => undefined
}))

vi.mock('./components/DiffViewer', () => ({
  DiffViewer: (props: Record<string, unknown>) => {
    diffViewerCapture.calls.push(props)
    return null
  }
}))

vi.mock('./components/RevisionDiffStudio', () => ({
  RevisionDiffStudio: (props: Record<string, unknown>) => {
    revisionDiffStudioCapture.calls.push(props)
    return null
  }
}))

vi.mock('./components/FileEditorPanel', () => ({
  FileEditorPanel: (props: Record<string, unknown>) => {
    fileEditorCapture.calls.push(props)
    return null
  }
}))

vi.mock('./components/TaskWraithWorkbench', () => ({
  TaskWraithWorkbench: () => null
}))

describe('PopoutApp Diff Studio', () => {
  beforeEach(() => {
    diffViewerCapture.calls = []
    revisionDiffStudioCapture.calls = []
    vi.stubGlobal('window', {
      location: {
        search: '?popout=diff-studio&workspace=%2Frepo&file=src%2FApp.tsx'
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('wires the standalone Diff Studio window into its revision sidebar', () => {
    renderToStaticMarkup(<PopoutApp />)

    const props = revisionDiffStudioCapture.calls.at(-1)
    expect(props).toMatchObject({
      workspacePath: '/repo',
      ipcTarget: { workspacePath: '/repo' },
      busyPath: '',
      selectionRequest: {
        path: 'src/App.tsx',
        nonce: 1,
        view: 'diff'
      }
    })
    expect(typeof props?.onOpenFile).toBe('function')
    expect(typeof props?.onStageFile).toBe('function')
    expect(typeof props?.onUnstageFile).toBe('function')
  })

  it('keeps a read-only external Diff Studio bound to its chat without Git mutations', () => {
    vi.stubGlobal('window', {
      location: {
        search: '?popout=diff-studio&workspace=%2Fexternal%2Frepo&chat=chat-2&write=0'
      }
    })

    renderToStaticMarkup(<PopoutApp />)

    const props = revisionDiffStudioCapture.calls.at(-1)
    expect(props?.workspacePath).toBe('/external/repo')
    expect(props?.ipcTarget).toEqual({ repoPath: '/external/repo', chatId: 'chat-2' })
    expect(props?.onOpenFile).toBeUndefined()
    expect(props?.onStageFile).toBeUndefined()
    expect(props?.onUnstageFile).toBeUndefined()
    expect(resolvePopoutWorkspaceIpcTarget('/external/repo', 'chat-2')).toEqual({
      repoPath: '/external/repo',
      chatId: 'chat-2'
    })
  })

  it('exposes Git mutations only when main marks the external popout writable', () => {
    vi.stubGlobal('window', {
      location: {
        search: '?popout=diff-studio&workspace=%2Fexternal%2Frepo&chat=chat-2&write=1'
      }
    })

    renderToStaticMarkup(<PopoutApp />)

    const props = revisionDiffStudioCapture.calls.at(-1)
    expect(props?.onOpenFile).toBeUndefined()
    expect(typeof props?.onStageFile).toBe('function')
    expect(typeof props?.onUnstageFile).toBe('function')
  })

  it('uses registered-workspace IPC shape when no chat scope is present', () => {
    expect(resolvePopoutWorkspaceIpcTarget('/repo', '')).toEqual({ workspacePath: '/repo' })
  })
})

describe('PopoutApp File Editor', () => {
  beforeEach(() => {
    fileEditorCapture.calls = []
    vi.stubGlobal('window', {
      location: {
        search: '?popout=file-editor&workspace=%2Frepo&file=src%2FApp.tsx'
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('wires standalone File Editor callbacks into FileEditorPanel', () => {
    renderToStaticMarkup(<PopoutApp />)

    const props = fileEditorCapture.calls.at(-1)
    expect(props).toMatchObject({
      workspacePath: '/repo',
      openRequest: {
        path: 'src/App.tsx',
        nonce: 1,
        view: 'editor'
      }
    })
    expect(typeof props?.onShowInDiff).toBe('function')
    expect(typeof props?.onDirtyChange).toBe('function')
  })
})

describe('PopoutApp open-file broadcast routing', () => {
  it('subscribes workspace popouts that can target files', () => {
    expect(popoutKindReceivesOpenFileBroadcast('file-editor')).toBe(true)
    expect(popoutKindReceivesOpenFileBroadcast('diff-studio')).toBe(true)
    expect(popoutKindReceivesOpenFileBroadcast('workbench')).toBe(true)
    expect(popoutKindReceivesOpenFileBroadcast(null)).toBe(false)
  })

  it('keeps standalone editors and diff studios in their native target views', () => {
    expect(resolvePopoutOpenFileView('file-editor', 'diff')).toBe('editor')
    expect(resolvePopoutOpenFileView('diff-studio', 'editor')).toBe('diff')
    expect(resolvePopoutOpenFileView('workbench', 'diff')).toBe('diff')
    expect(resolvePopoutOpenFileView('workbench', 'editor')).toBe('editor')
    expect(resolvePopoutOpenFileView('workbench', undefined)).toBe('editor')
  })
})

describe('PopoutApp external Git capability refresh', () => {
  it('adopts targeted main capability events for revoke and elevation', () => {
    expect(
      refreshPopoutGitMutationCapability('chat-2', true, {
        externalWriteAllowed: false
      })
    ).toBe(false)
    expect(
      refreshPopoutGitMutationCapability('chat-2', false, {
        externalWriteAllowed: true
      })
    ).toBe(true)
    expect(refreshPopoutGitMutationCapability('chat-2', false, {})).toBe(false)
  })

  it('keeps registered workspace popouts writable without an external capability', () => {
    expect(popoutAllowsGitMutations('', '0')).toBe(true)
    expect(
      refreshPopoutGitMutationCapability('', false, { externalWriteAllowed: false })
    ).toBe(true)
  })
})
