import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PopoutApp } from './PopoutApp'

const diffViewerCapture = vi.hoisted(() => ({
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
  FileEditorPanel: () => null
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
