import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AntigravityOptInCard } from './AntigravityOptInCard'
import {
  useAntigravityGeminiApiSecretRefreshIdentity,
  useConfiguredProviderSnapshot,
  type ConfiguredProviderSnapshot
} from '../hooks/useConfiguredProviderSnapshot'

class TestNode extends EventTarget {
  readonly nodeType: number
  parentNode: TestNode | null = null
  childNodes: TestNode[] = []
  ownerDocument: TestDocument

  constructor(nodeType: number, ownerDocument: TestDocument) {
    super()
    this.nodeType = nodeType
    this.ownerDocument = ownerDocument
  }

  appendChild<T extends TestNode>(node: T): T {
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }

  removeChild<T extends TestNode>(node: T): T {
    const index = this.childNodes.indexOf(node)
    if (index >= 0) this.childNodes.splice(index, 1)
    node.parentNode = null
    return node
  }

  dispatchEvent(event: Event): boolean {
    const accepted = super.dispatchEvent(event)
    if (event.bubbles && !event.cancelBubble && this.parentNode) {
      this.parentNode.dispatchEvent(event)
    }
    return accepted
  }

  insertBefore<T extends TestNode>(node: T, before: TestNode | null): T {
    if (!before) return this.appendChild(node)
    const index = this.childNodes.indexOf(before)
    node.parentNode = this
    this.childNodes.splice(Math.max(0, index), 0, node)
    return node
  }
}

class TestText extends TestNode {
  nodeValue: string

  constructor(value: string, ownerDocument: TestDocument) {
    super(3, ownerDocument)
    this.nodeValue = value
  }
}

class TestElement extends TestNode {
  readonly nodeName: string
  readonly tagName: string
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml'
  readonly style: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  private _value = ''
  disabled = false
  checked = false
  type = ''

  get value(): string {
    return this._value
  }

  set value(value: string) {
    this._value = value
  }

  constructor(tagName: string, ownerDocument: TestDocument) {
    super(1, ownerDocument)
    this.tagName = tagName.toUpperCase()
    this.nodeName = this.tagName
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
    if (name === 'data-testid') this.dataset.testid = value
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  readonly dataset: Record<string, string> = {}

  get textContent(): string {
    return this.childNodes.map((child) =>
      child instanceof TestText ? child.nodeValue : (child as TestElement).textContent
    ).join('')
  }

  set textContent(value: string) {
    this.childNodes = [new TestText(value, this.ownerDocument)]
  }

  querySelector(selector: string): TestElement | null {
    const match = selector.match(/^\[data-testid="([^"]+)"\]$/)
    for (const child of this.childNodes) {
      if (child instanceof TestElement) {
        if (match && child.attributes.get('data-testid') === match[1]) return child
        const nested = child.querySelector(selector)
        if (nested) return nested
      }
    }
    return null
  }
}

class TestDocument extends EventTarget {
  readonly nodeType = 9
  readonly documentElement: TestElement
  readonly body: TestElement
  activeElement: TestElement | null = null
  defaultView: Record<string, unknown> | null = null

  constructor() {
    super()
    this.documentElement = new TestElement('html', this)
    this.body = new TestElement('body', this)
  }

  createElement(tagName: string): TestElement {
    return new TestElement(tagName, this)
  }

  createElementNS(_namespace: string, tagName: string): TestElement {
    return this.createElement(tagName)
  }

  createTextNode(value: string): TestText {
    return new TestText(value, this)
  }
}

function reactProps(node: TestElement): Record<string, unknown> {
  const key = Object.keys(node).find((candidate) => candidate.startsWith('__reactProps$'))
  if (!key) throw new Error('React props were not attached to mounted test node')
  return node[key as keyof TestElement] as unknown as Record<string, unknown>
}

let mountedRoot: Root | null = null
let originalDescriptors: Record<string, PropertyDescriptor | undefined> = {}

function installDom(): { document: TestDocument; container: TestElement } {
  const document = new TestDocument()
  const windowTarget = new EventTarget() as EventTarget & Record<string, unknown>
  windowTarget.document = document
  windowTarget.Node = TestNode
  windowTarget.Element = TestElement
  windowTarget.HTMLElement = TestElement
  windowTarget.HTMLIFrameElement = TestElement
  windowTarget.setTimeout = globalThis.setTimeout
  windowTarget.clearTimeout = globalThis.clearTimeout
  document.defaultView = windowTarget
  for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT']) {
    originalDescriptors[name] = Object.getOwnPropertyDescriptor(globalThis, name)
  }
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowTarget },
    document: { configurable: true, value: document },
    Node: { configurable: true, value: TestNode },
    Element: { configurable: true, value: TestElement },
    HTMLElement: { configurable: true, value: TestElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true }
  })
  return { document, container: document.createElement('div') }
}

afterEach(() => {
  act(() => mountedRoot?.unmount())
  mountedRoot = null
  for (const [name, descriptor] of Object.entries(originalDescriptors)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  originalDescriptors = {}
})

describe('AntigravityOptInCard successful mutation integration', () => {
  it('drives real set and clear IPC handlers and immediately withdraws/reloads rows', async () => {
    const { document, container } = installDom()
    document.body.appendChild(container)
    const mutationEvents: Event[] = []
    const pendingReloads: Array<(value: unknown) => void> = []
    let renderedSnapshot: ConfiguredProviderSnapshot = { ready: false, providerIds: [] }
    const api = {
      getAntigravityGeminiApiSecretStatus: async () => ({ configured: false, encryptionAvailable: true }),
      setAntigravityGeminiApiSecret: vi.fn(async () => ({
        ok: true as const,
        status: { configured: true, encryptionAvailable: true }
      })),
      clearAntigravityGeminiApiSecret: vi.fn(async () => ({
        ok: true as const,
        status: { configured: false, encryptionAvailable: true }
      })),
      getConfiguredProviderSnapshot: () => {
        if (mutationEvents.length === 0) {
          return Promise.resolve({
            ready: true,
            providerIds: ['antigravity'],
            modelsByProvider: { antigravity: [{ id: 'agy-model', label: 'AGY model' }] }
          })
        }
        return new Promise((resolve) => pendingReloads.push(resolve))
      }
    }
    Object.assign(window, { api })
    window.addEventListener(
      'taskwraith-antigravity-gemini-api-secret-mutated',
      (event) => mutationEvents.push(event)
    )

    function Harness(): ReactNode {
      const identity = useAntigravityGeminiApiSecretRefreshIdentity()
      renderedSnapshot = useConfiguredProviderSnapshot(identity)
      return createElement(AntigravityOptInCard, {
        enabled: true,
        acceptedAt: 1,
        geminiApiDisclosureAcceptedAt: 2,
        onChange: () => undefined
      })
    }

    await act(async () => {
      mountedRoot = createRoot(container as unknown as Element)
      mountedRoot.render(createElement(Harness))
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(renderedSnapshot.providerIds).toEqual(['antigravity'])

    const input = container.querySelector('[data-testid="antigravity-gemini-api-key"]')
    const save = container.querySelector('[data-testid="antigravity-gemini-api-save"]')
    expect(input).not.toBeNull()
    expect(save).not.toBeNull()
    await act(async () => {
      ;(reactProps(input!).onChange as (event: { target: { value: string } }) => void)({
        target: { value: 'explicit-project-key' }
      })
      await Promise.resolve()
    })
    expect(reactProps(save!).disabled).toBe(false)
    await act(async () => {
      ;(reactProps(save!).onClick as () => void)()
      await Promise.resolve()
    })
    expect(api.setAntigravityGeminiApiSecret).toHaveBeenCalledWith('explicit-project-key')
    expect(mutationEvents).toHaveLength(1)
    expect(renderedSnapshot.providerIds).toEqual([])
    await act(async () => {
      pendingReloads.shift()?.({
        ready: true,
        providerIds: ['antigravity'],
        modelsByProvider: { antigravity: [{ id: 'agy-model', label: 'AGY model' }] }
      })
    })
    expect(renderedSnapshot.providerIds).toEqual(['antigravity'])

    const clear = container.querySelector('[data-testid="antigravity-gemini-api-clear"]')
    expect(clear).not.toBeNull()
    await act(async () => {
      ;(reactProps(clear!).onClick as () => void)()
      await Promise.resolve()
    })
    expect(api.clearAntigravityGeminiApiSecret).toHaveBeenCalledTimes(1)
    expect(mutationEvents).toHaveLength(2)
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
