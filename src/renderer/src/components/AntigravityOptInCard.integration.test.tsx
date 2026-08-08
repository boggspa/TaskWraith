import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_PROTOCOL_VERSION,
  type HostSnapshot
} from '../../../shared/hostProtocol'
import { HostProjectionStore } from '../lib/host/HostProjectionStore'
import { AntigravityOptInCard } from './AntigravityOptInCard'
import { HostProjectionProvider } from './HostProjectionProvider'
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
    return this.childNodes
      .map((child) =>
        child instanceof TestText ? child.nodeValue : (child as TestElement).textContent
      )
      .join('')
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
  for (const name of [
    'window',
    'document',
    'Node',
    'Element',
    'HTMLElement',
    'IS_REACT_ACT_ENVIRONMENT'
  ]) {
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
    const pendingReloads: Array<(value: HostSnapshot) => void> = []
    let renderedSnapshot: ConfiguredProviderSnapshot = { ready: false, providerIds: [] }
    const antigravityHostSnapshot = {
      protocolVersion: HOST_PROTOCOL_VERSION,
      projectionVersion: 1,
      generatedAt: '2026-08-07T12:00:00.000Z',
      generation: 1,
      cursor: 1,
      freshness: 'live',
      health: {
        hostStatus: 'ok',
        connectionPhase: 'live',
        supervised: true,
        freshness: 'live'
      },
      workspaces: [],
      threads: [],
      runs: [],
      missions: [],
      rounds: [],
      participants: [],
      providers: [
        {
          providerId: 'antigravity',
          displayProvider: 'AntiGravity',
          shortCode: 'AG',
          available: true,
          modelId: 'agy-model',
          modelLabel: 'AGY model'
        }
      ],
      questions: [],
      approvals: [],
      schedules: [],
      usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
      artifacts: [],
      warnings: [],
      recovery: {}
    } as unknown as HostSnapshot
    const store = new HostProjectionStore({
      fetchSnapshot: () => {
        // Pre-mutation: always resolve live Host providers. Post-mutation:
        // pend so the leaf withdraws until Cap/Host refresh settles.
        if (mutationEvents.length === 0) {
          return Promise.resolve(antigravityHostSnapshot)
        }
        return new Promise((resolve) => pendingReloads.push(resolve))
      }
    })
    const api = {
      getAntigravityGeminiApiSecretStatus: async () => ({
        configured: false,
        encryptionAvailable: true
      }),
      setAntigravityGeminiApiSecret: vi.fn(async () => ({
        ok: true as const,
        status: { configured: true, encryptionAvailable: true }
      })),
      clearAntigravityGeminiApiSecret: vi.fn(async () => ({
        ok: true as const,
        status: { configured: false, encryptionAvailable: true }
      }))
    }
    Object.assign(window, { api })
    window.addEventListener('taskwraith-antigravity-gemini-api-secret-mutated', (event) =>
      mutationEvents.push(event)
    )

    function Harness(): ReactNode {
      const identity = useAntigravityGeminiApiSecretRefreshIdentity()
      renderedSnapshot = useConfiguredProviderSnapshot(identity)
      return createElement(AntigravityOptInCard, {
        enabled: false,
        acceptedAt: null,
        geminiApiDisclosureAcceptedAt: 2,
        onChange: () => undefined
      })
    }

    await act(async () => {
      mountedRoot = createRoot(container as unknown as Element)
      mountedRoot.render(
        // eslint-disable-next-line react/no-children-prop -- props.children required by HostProjectionProviderProps for tsc
        createElement(HostProjectionProvider, {
          store,
          children: createElement(Harness)
        })
      )
    })
    // useHostProjection refreshes on mount; settle the Host fetch.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
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
      pendingReloads.shift()?.(antigravityHostSnapshot)
      await Promise.resolve()
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
      pendingReloads.shift()?.(antigravityHostSnapshot)
      await Promise.resolve()
    })
    expect(renderedSnapshot.providerIds).toEqual(['antigravity'])
  })
})

describe('AntigravityOptInCard header/status lane awareness', () => {
  it('reflects a configured Gemini API key neutrally, with no AGY risk framing, even without AGY consent', async () => {
    const { document, container } = installDom()
    document.body.appendChild(container)
    const api = {
      getAntigravityGeminiApiSecretStatus: async () => ({
        configured: true,
        encryptionAvailable: true
      }),
      setAntigravityGeminiApiSecret: vi.fn(),
      clearAntigravityGeminiApiSecret: vi.fn(),
      getConfiguredProviderSnapshot: () =>
        Promise.resolve({ ready: true, providerIds: ['antigravity'], modelsByProvider: {} })
    }
    Object.assign(window, { api })

    await act(async () => {
      mountedRoot = createRoot(container as unknown as Element)
      mountedRoot.render(
        createElement(AntigravityOptInCard, {
          enabled: false,
          acceptedAt: null,
          onChange: () => undefined
        })
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const badge = container.querySelector('[data-testid="antigravity-card-badge"]')
    const status = container.querySelector('[data-testid="antigravity-card-status"]')
    expect(badge?.textContent).toBe('BYO key')
    expect(status?.textContent).toBe('Gemini API key configured')

    const text = container.textContent
    // The AGY/CLI ban-risk consent lane itself remains fully intact and explicitly scoped,
    // even though the card-level header/status no longer describe it as disabled/experimental.
    expect(text).toContain('Official')
    expect(text).toContain('ban-risk; requires explicit consent')
    expect(text).toContain('Accept risk and enable')
    expect(text).toContain('ban-safe')
  })

  it('keeps the AGY-only default state exactly as before when no Gemini API key is configured', async () => {
    const { document, container } = installDom()
    document.body.appendChild(container)
    const api = {
      getAntigravityGeminiApiSecretStatus: async () => ({
        configured: false,
        encryptionAvailable: true
      }),
      setAntigravityGeminiApiSecret: vi.fn(),
      clearAntigravityGeminiApiSecret: vi.fn(),
      getConfiguredProviderSnapshot: () =>
        Promise.resolve({ ready: false, providerIds: [], modelsByProvider: {} })
    }
    Object.assign(window, { api })

    await act(async () => {
      mountedRoot = createRoot(container as unknown as Element)
      mountedRoot.render(
        createElement(AntigravityOptInCard, {
          enabled: false,
          acceptedAt: null,
          onChange: () => undefined
        })
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const badge = container.querySelector('[data-testid="antigravity-card-badge"]')
    const status = container.querySelector('[data-testid="antigravity-card-status"]')
    expect(badge?.textContent).toBe('Experimental')
    expect(status?.textContent).toBe('Disabled — explicit consent required')
  })
})

describe('AntigravityOptInCard Gemini API discovery outcome line', () => {
  async function renderWithOutcome(
    outcome: unknown,
    options: { configured?: boolean; omitBridge?: boolean } = {}
  ): Promise<TestElement> {
    const { document, container } = installDom()
    document.body.appendChild(container)
    const api: Record<string, unknown> = {
      getAntigravityGeminiApiSecretStatus: async () => ({
        configured: options.configured ?? true,
        encryptionAvailable: true
      }),
      setAntigravityGeminiApiSecret: vi.fn(),
      clearAntigravityGeminiApiSecret: vi.fn(),
      getConfiguredProviderSnapshot: () =>
        Promise.resolve({ ready: true, providerIds: [], modelsByProvider: {} })
    }
    if (!options.omitBridge) {
      api.getAntigravityGeminiApiDiscoveryOutcome = async () => outcome
    }
    Object.assign(window, { api })

    await act(async () => {
      mountedRoot = createRoot(container as unknown as Element)
      mountedRoot.render(
        createElement(AntigravityOptInCard, {
          enabled: false,
          acceptedAt: null,
          geminiApiDisclosureAcceptedAt: 2,
          onChange: () => undefined
        })
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    return container
  }

  const at = '2026-07-24T12:00:00.000Z'

  function discoveryTone(container: TestElement): string | undefined {
    return container
      .querySelector('[data-testid="antigravity-gemini-api-discovery"]')
      ?.attributes.get('data-tone')
  }

  it.each([
    [{ status: 'ok', modelCount: 12, checkedAt: at }, '12 Gemini API models available'],
    [{ status: 'ok', modelCount: 1, checkedAt: at }, '1 Gemini API model available'],
    [{ status: 'unauthorized', modelCount: 0, checkedAt: at }, 'Google rejected this API key'],
    [{ status: 'rateLimited', modelCount: 0, checkedAt: at }, 'Rate limited — retrying'],
    [
      { status: 'timedOut', modelCount: 0, checkedAt: at },
      'Discovery timed out within the 1s startup probe budget; showing the built-in model list'
    ],
    [
      { status: 'unavailable', modelCount: 0, checkedAt: at },
      'Could not reach the Gemini API; showing the built-in model list'
    ],
    [
      { status: 'empty', modelCount: 0, checkedAt: at },
      'This key returned no usable Gemini models'
    ],
    // A successful pass whose rows were all curated away is not "0 available".
    [{ status: 'ok', modelCount: 0, checkedAt: at }, 'This key returned no usable Gemini models'],
    [null, 'Checking this key against the Gemini API…']
  ])('renders one honest line for %j', async (outcome, expected) => {
    const container = await renderWithOutcome(outcome)
    expect(
      container.querySelector('[data-testid="antigravity-gemini-api-discovery"]')?.textContent
    ).toBe(expected)
  })

  it('no longer lets a stored-but-rejected key read as simply working', async () => {
    // The regression this closes: the envelope existing on disk drove a green
    // "API key configured" with no other signal anywhere, so a key Google was
    // rejecting on every probe looked healthy.
    const container = await renderWithOutcome({
      status: 'unauthorized',
      modelCount: 0,
      checkedAt: at
    })
    expect(container.textContent).toContain('API key configured')
    expect(container.textContent).toContain('Google rejected this API key')
    expect(discoveryTone(container)).toBe('not-available')
  })

  it('marks a verified catalogue connected and an unverified one as degraded', async () => {
    const connected = await renderWithOutcome({ status: 'ok', modelCount: 4, checkedAt: at })
    expect(discoveryTone(connected)).toBe('connected')

    act(() => mountedRoot?.unmount())
    mountedRoot = null

    // A timeout is not a bad key, so it must not read as a hard failure.
    const degraded = await renderWithOutcome({ status: 'timedOut', modelCount: 0, checkedAt: at })
    expect(discoveryTone(degraded)).toBe('partial')
  })

  it('says nothing about discovery when no key is configured', async () => {
    const container = await renderWithOutcome(
      { status: 'unauthorized', modelCount: 0, checkedAt: at },
      { configured: false }
    )
    expect(container.querySelector('[data-testid="antigravity-gemini-api-discovery"]')).toBeNull()
    expect(container.textContent).toContain('No API key configured')
  })

  it('renders unchanged when the preload bridge does not expose the channel', async () => {
    const container = await renderWithOutcome(null, { omitBridge: true })
    expect(
      container.querySelector('[data-testid="antigravity-gemini-api-discovery"]')?.textContent
    ).toBe('Checking this key against the Gemini API…')
  })

  it('never renders provider error text, a project id, or the key itself', async () => {
    const container = await renderWithOutcome({
      status: 'unauthorized',
      modelCount: 0,
      checkedAt: at,
      error: 'API key not valid. project=leaky-project',
      apiKey: 'AIza-secret'
    })
    expect(container.textContent).not.toContain('AIza-secret')
    expect(container.textContent).not.toContain('leaky-project')
    expect(container.textContent).not.toContain('API key not valid')
  })
})
