import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  antigravityGeminiApiSecretRefreshIdentity,
  ANTIGRAVITY_GEMINI_API_SECRET_MUTATION_EVENT,
  notifyAntigravityGeminiApiSecretMutation,
  sanitizeConfiguredProviderSnapshot,
  useConfiguredProviderSnapshot,
  useAntigravityGeminiApiSecretRefreshIdentity,
  type ConfiguredProviderSnapshot
} from './useConfiguredProviderSnapshot'

let mountedRoot: Root | null = null
let savedWindow: PropertyDescriptor | undefined
let savedDocument: PropertyDescriptor | undefined
let savedNode: PropertyDescriptor | undefined
let savedHTMLElement: PropertyDescriptor | undefined
let savedElement: PropertyDescriptor | undefined
let savedActEnvironment: PropertyDescriptor | undefined

afterEach(() => {
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
    lastChild: null,
    appendChild: () => undefined,
    removeChild: () => undefined
  }) as unknown as Element
}

describe('successful Gemini API mutation refresh signal', () => {
  it('emits the same nonsecret event for successful set and clear paths', () => {
    const originalWindow = globalThis.window
    const eventTarget = new EventTarget()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: eventTarget
    })
    const received: Event[] = []
    eventTarget.addEventListener(ANTIGRAVITY_GEMINI_API_SECRET_MUTATION_EVENT, (event) => {
      received.push(event)
    })

    try {
      notifyAntigravityGeminiApiSecretMutation()
      notifyAntigravityGeminiApiSecretMutation()
      expect(received).toHaveLength(2)
      expect(JSON.stringify(received)).not.toContain('secret')
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow
      })
    }
  })

  it('updates the mounted snapshot refresh identity immediately for set and clear events', async () => {
    const container = installMinimalRendererDom()
    let renderedIdentity = ''
    function Harness(): null {
      renderedIdentity = useAntigravityGeminiApiSecretRefreshIdentity()
      return null
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getAntigravityGeminiApiSecretStatus: () => new Promise(() => undefined)
      }
    })
    await act(async () => {
      mountedRoot = createRoot(container)
      mountedRoot.render(createElement(Harness))
    })
    expect(renderedIdentity).toBe(':mutation-0')
    act(() => notifyAntigravityGeminiApiSecretMutation())
    expect(renderedIdentity).toBe(':mutation-1')
    act(() => notifyAntigravityGeminiApiSecretMutation())
    expect(renderedIdentity).toBe(':mutation-2')
  })

  it('withdraws and reloads mounted provider rows immediately for both mutations', async () => {
    const container = installMinimalRendererDom()
    let renderedSnapshot: ConfiguredProviderSnapshot = { ready: false, providerIds: [] }
    const pendingReloads: Array<(value: unknown) => void> = []
    let snapshotCalls = 0
    function Harness(): null {
      const identity = useAntigravityGeminiApiSecretRefreshIdentity()
      const snapshot = useConfiguredProviderSnapshot(identity)
      renderedSnapshot = snapshot
      return null
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getAntigravityGeminiApiSecretStatus: () => new Promise(() => undefined),
        getConfiguredProviderSnapshot: () => {
          snapshotCalls += 1
          if (snapshotCalls === 1) {
            return Promise.resolve({
              ready: true,
              providerIds: ['antigravity'],
              modelsByProvider: { antigravity: [{ id: 'agy-model', label: 'AGY model' }] }
            })
          }
          return new Promise((resolve) => pendingReloads.push(resolve))
        }
      }
    })
    await act(async () => {
      mountedRoot = createRoot(container)
      mountedRoot.render(createElement(Harness))
    })
    expect(renderedSnapshot.providerIds).toEqual(['antigravity'])

    act(() => notifyAntigravityGeminiApiSecretMutation())
    expect(renderedSnapshot.providerIds).toEqual([])
    await act(async () => {
      pendingReloads.shift()?.({
        ready: true,
        providerIds: ['antigravity'],
        modelsByProvider: { antigravity: [{ id: 'agy-model', label: 'AGY model' }] }
      })
    })
    expect(renderedSnapshot.providerIds).toEqual(['antigravity'])

    act(() => notifyAntigravityGeminiApiSecretMutation())
    expect(renderedSnapshot.providerIds).toEqual([])
    await act(async () => {
      pendingReloads.shift()?.({
        ready: true,
        providerIds: ['antigravity'],
        modelsByProvider: { antigravity: [{ id: 'agy-model', label: 'AGY model' }] }
      })
    })
    expect(renderedSnapshot.providerIds).toEqual(['antigravity'])
  })
})

describe('antigravityGeminiApiSecretRefreshIdentity', () => {
  it('projects only nonsecret configured and generation state', () => {
    expect(antigravityGeminiApiSecretRefreshIdentity({
      configured: true,
      updatedAt: '2026-07-23T15:00:00.000Z',
      apiKey: 'secret'
    })).toBe('configured:2026-07-23T15:00:00.000Z')
    expect(antigravityGeminiApiSecretRefreshIdentity({
      configured: false,
      ciphertext: 'secret'
    })).toBe('unconfigured:')
  })
})

describe('sanitizeConfiguredProviderSnapshot', () => {
  it('keeps unique live providers in discovery order', () => {
    expect(
      sanitizeConfiguredProviderSnapshot({
        ready: true,
        providerIds: ['claude', 'gemini', 'claude', 'cursor', 'unknown']
      })
    ).toEqual({ ready: true, providerIds: ['claude', 'cursor'] })
  })

  it('returns a pending empty snapshot for malformed input', () => {
    expect(sanitizeConfiguredProviderSnapshot(null)).toEqual({
      ready: false,
      providerIds: []
    })
    expect(sanitizeConfiguredProviderSnapshot({ ready: 'yes', providerIds: 'codex' })).toEqual({
      ready: false,
      providerIds: []
    })
  })

  it('admits AntiGravity only with a nonempty validated cached model list', () => {
    expect(
      sanitizeConfiguredProviderSnapshot({
        ready: true,
        providerIds: ['antigravity']
      })
    ).toEqual({ ready: true, providerIds: [] })

    expect(
      sanitizeConfiguredProviderSnapshot({
        ready: true,
        providerIds: ['antigravity'],
        modelsByProvider: {
          antigravity: [
            { id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' },
            { id: 'gemini-3.5-pro', label: 'Duplicate is ignored' },
            { id: '', label: 'Ignored' }
          ]
        }
      })
    ).toEqual({
      ready: true,
      providerIds: ['antigravity'],
      modelsByProvider: {
        antigravity: [{ id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' }]
      }
    })
  })
})
