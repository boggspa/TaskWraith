import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PopoutApp,
  popoutKindReceivesOpenFileBroadcast,
  resolvePopoutOpenFileView
} from './PopoutApp'

const diffViewerCapture = vi.hoisted(() => ({
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
    vi.stubGlobal('window', {
      location: {
        search: '?popout=diff-studio&workspace=%2Frepo&file=src%2FApp.tsx'
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('wires standalone Diff Studio action callbacks into DiffViewer', () => {
    renderToStaticMarkup(<PopoutApp />)

    const props = diffViewerCapture.calls.at(-1)
    expect(props).toMatchObject({
      workspacePath: '/repo',
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
