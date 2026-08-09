import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unavailableWorkProvenanceSnapshot } from '../../../shared/workProvenance'
import { useWorkspaceProvenance, type WorkspaceProvenanceState } from './useWorkspaceProvenance'

let mountedRoot: Root | null = null
let savedWindow: PropertyDescriptor | undefined
let savedDocument: PropertyDescriptor | undefined
let savedNode: PropertyDescriptor | undefined
let savedHTMLElement: PropertyDescriptor | undefined
let savedElement: PropertyDescriptor | undefined
let savedActEnvironment: PropertyDescriptor | undefined

afterEach(() => {
  vi.useRealTimers()
  act(() => mountedRoot?.unmount())
  mountedRoot = null
  if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow)
  if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument)
  if (savedNode) Object.defineProperty(globalThis, 'Node', savedNode)
  if (savedHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', savedHTMLElement)
  if (savedElement) Object.defineProperty(globalThis, 'Element', savedElement)
  else delete (globalThis as Record<string, unknown>).Element
  if (savedActEnvironment) {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', savedActEnvironment)
  } else {
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
  }
})

function installMinimalRendererDom(): Element {
  savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  savedNode = Object.getOwnPropertyDescriptor(globalThis, 'Node')
  savedHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
  savedElement = Object.getOwnPropertyDescriptor(globalThis, 'Element')
  savedActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  class MinimalNode extends EventTarget {
    readonly nodeType: number = 0
  }
  class MinimalHTMLElement extends MinimalNode {
    override readonly nodeType: number = 1
  }
  class MinimalHTMLIFrameElement extends MinimalHTMLElement {}
  const documentTarget = new EventTarget() as EventTarget & Record<string, unknown>
  documentTarget.nodeType = 9
  documentTarget.activeElement = null
  documentTarget.body = null
  documentTarget.documentElement = {}
  const windowTarget = new EventTarget() as EventTarget & Record<string, unknown>
  windowTarget.document = documentTarget
  windowTarget.Node = MinimalNode
  windowTarget.HTMLElement = MinimalHTMLElement
  windowTarget.HTMLIFrameElement = MinimalHTMLIFrameElement
  windowTarget.setTimeout = globalThis.setTimeout
  windowTarget.clearTimeout = globalThis.clearTimeout
  documentTarget.defaultView = windowTarget
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowTarget },
    document: { configurable: true, value: documentTarget },
    Node: { configurable: true, value: MinimalNode },
    HTMLElement: { configurable: true, value: MinimalHTMLElement },
    Element: { configurable: true, value: MinimalHTMLElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true }
  })
  return Object.assign(new MinimalHTMLElement(), {
    ownerDocument: documentTarget,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    firstChild: null,
    appendChild: () => undefined,
    removeChild: () => undefined
  }) as unknown as Element
}

async function settleEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useWorkspaceProvenance', () => {
  it('queries once while visible and retries only after an explicit refresh', async () => {
    vi.useFakeTimers()
    const container = installMinimalRendererDom()
    const snapshot = {
      ...unavailableWorkProvenanceSnapshot('fixture'),
      available: true,
      stale: false,
      reason: undefined
    }
    const readProvenance = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'probe failed' })
      .mockResolvedValueOnce({ ok: true, data: snapshot })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { gitWorkProvenance: readProvenance }
    })
    let current: WorkspaceProvenanceState | null = null

    function Harness(): null {
      current = useWorkspaceProvenance({
        baseWorkspacePath: '/repo',
        workspacePath: '/repo',
        chatId: 'chat-1'
      })
      return null
    }

    function readCurrent(): WorkspaceProvenanceState {
      if (!current) throw new Error('Workspace provenance hook did not render')
      return current
    }

    await act(async () => {
      mountedRoot = createRoot(container)
      mountedRoot.render(createElement(Harness))
    })
    await settleEffects()
    expect(readProvenance).toHaveBeenCalledTimes(1)
    expect(readCurrent().error).toBe('probe failed')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(readProvenance).toHaveBeenCalledTimes(1)

    act(() => readCurrent().refresh())
    await settleEffects()
    expect(readProvenance).toHaveBeenCalledTimes(2)
    expect(readCurrent().snapshot).toEqual(snapshot)
    expect(readCurrent().error).toBeNull()
  })
})
