import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  MemoryProposalSupersedeReview,
  supersedeCandidates,
  verifiedSupersedeReceipt
} from './MemoryProposalSupersedeReview'
import type { MemoryProposal, MemoryProposalPack } from '../../../main/store/types'

const proposal = (id: string, status: MemoryProposal['status'] = 'proposed'): MemoryProposal =>
  ({
    id,
    status,
    title: '<script>unsafe</script>',
    lesson: 'Lesson',
    confidence: 0.8,
    dedupKey: id,
    requiresReview: true,
    createdAt: '2026-07-05T18:00:00.000Z',
    updatedAt: '2026-07-05T18:00:00.000Z',
    evidenceRefs: [],
    kind: 'repo_convention',
    scope: 'workspace'
  }) as MemoryProposal
const pack = {
  id: 'p',
  workspaceId: 'w',
  proposals: [proposal('old', 'approved'), proposal('new')]
} as MemoryProposalPack

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
  selected = false
  get options(): TestElement[] {
    return this.childNodes.filter(
      (node): node is TestElement => node instanceof TestElement && node.tagName === 'OPTION'
    )
  }

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
    if (name === 'disabled') this.disabled = true
    if (name === 'data-testid') this.dataset.testid = value
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
    if (name === 'disabled') this.disabled = false
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

describe('reviewed supersede UI contract', () => {
  it.each(['valid', 'workspace', 'status'] as const)(
    'mounts selection and confirmation with %s receipt',
    async (mode) => {
      const { container } = installDom()
      let resolve!: (value: any) => void
      const onSupersede = vi.fn(
        () =>
          new Promise<any>((done) => {
            resolve = done
          })
      )
      const onCommitted = vi.fn()
      mountedRoot = createRoot(container as unknown as Element)
      await act(async () =>
        mountedRoot!.render(
          createElement(MemoryProposalSupersedeReview, {
            pack,
            successor: pack.proposals[1]!,
            onSupersede,
            onCommitted
          })
        )
      )
      const find = (tag: string): TestElement | undefined => {
        const walk = (node: TestNode): TestElement | undefined => {
          if (node instanceof TestElement && node.tagName === tag) return node
          for (const child of node.childNodes) {
            const result = walk(child)
            if (result) return result
          }
          return undefined
        }
        return walk(container)
      }
      expect(find('BUTTON')).toBeUndefined()
      await act(async () =>
        (reactProps(find('SELECT')!).onChange as Function)({ target: { value: 'old' } })
      )
      expect(container.textContent).toContain('Pack: p')
      expect(container.textContent).toContain('old — approved')
      await act(async () => (reactProps(find('BUTTON')!).onClick as Function)())
      expect(onSupersede).toHaveBeenCalledWith('p', 'new', 'old')
      expect(find('BUTTON')!.disabled).toBe(true)
      await act(async () => (reactProps(find('BUTTON')!).onClick as Function)())
      expect(onSupersede).toHaveBeenCalledTimes(1)
      expect(onCommitted).not.toHaveBeenCalled()
      const updated = {
        ...pack,
        workspaceId: mode === 'workspace' ? 'wrong' : 'w',
        proposals: [
          { ...pack.proposals[0]!, status: 'superseded' as const, supersededById: 'new' },
          {
            ...pack.proposals[1]!,
            status: mode === 'status' ? ('approved' as const) : ('proposed' as const),
            supersedesId: 'old'
          }
        ]
      }
      await act(async () => resolve({ ok: true, predecessorPack: updated, successorPack: updated }))
      if (mode === 'valid') expect(onCommitted).toHaveBeenCalledWith(updated)
      else {
        expect(onCommitted).not.toHaveBeenCalled()
        expect(container.textContent).toContain('could not be confirmed')
      }
    }
  )
  it('offers only eligible distinct unlinked records in a workspace pack', () => {
    expect(supersedeCandidates(pack, pack.proposals[1]!)).toEqual([pack.proposals[0]])
    expect(supersedeCandidates({ ...pack, workspaceId: undefined }, pack.proposals[1]!)).toEqual([])
    expect(supersedeCandidates(pack, proposal('new', 'applied'))).toEqual([])
    expect(
      supersedeCandidates(
        { ...pack, proposals: [{ ...pack.proposals[0]!, supersedesId: 'older' }] },
        pack.proposals[1]!
      )
    ).toEqual([])
  })
  it('requires exact reciprocal persisted records before accepting success', () => {
    const updated = {
      ...pack,
      proposals: [
        { ...pack.proposals[0]!, status: 'superseded' as const, supersededById: 'new' },
        { ...pack.proposals[1]!, supersedesId: 'old' }
      ]
    }
    const result = { ok: true, predecessorPack: updated, successorPack: updated }
    expect(verifiedSupersedeReceipt(result, 'p', 'old', 'new')).toBe(true)
    expect(verifiedSupersedeReceipt({ ...result, ok: false }, 'p', 'old', 'new')).toBe(false)
    expect(verifiedSupersedeReceipt({ ok: true }, 'p', 'old', 'new')).toBe(false)
    expect(verifiedSupersedeReceipt(result, 'other', 'old', 'new')).toBe(false)
    expect(verifiedSupersedeReceipt({ ...result, successorPack: pack }, 'p', 'old', 'new')).toBe(
      false
    )
  })
  it('escapes titles and requires explicit selection before confirmation', () => {
    const html = renderToStaticMarkup(
      <MemoryProposalSupersedeReview
        pack={pack}
        successor={pack.proposals[1]!}
        onSupersede={async () => ({ ok: false })}
        onCommitted={() => undefined}
      />
    )
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('Confirm supersede')
  })
})
