import { describe, expect, it } from 'vitest'
import { actScript, CLEAR_SECRET_REDACTION_SCRIPT, REDACT_SECRETS_SCRIPT } from './CanvasWebDriver'
import type { CanvasActionInput } from './canvasTypes'

/**
 * The canvas actuation preconditions live inside the injected page script, so
 * asserting on TypeScript alone would prove nothing. There is no jsdom in this
 * project, so these tests evaluate the REAL generated source against a minimal
 * DOM stub.
 *
 * The bug being pinned (2026-07-26): a ref resolved out of the frozen snapshot
 * registry is not proof the element is still real. `el.click()` on a detached
 * node does not throw and `scrollIntoView` no-ops, so the old script returned
 * `{ ok: true, found: true }` for an element that had been re-rendered away.
 * The agent then re-observed, saw no change, and escalated — a silent-empty-
 * success loop against a live application.
 */

interface StubElement {
  nodeType: 1
  tagName: string
  attrs: Record<string, string>
  isConnected: boolean
  parentElement: StubElement | null
  children: StubElement[]
  className: string
  value?: string
  checked?: boolean
  clicks: number
  focuses: number
  scrolls: number
  dispatched: string[]
  rect: { left: number; top: number; width: number; height: number }
  readonly childElementCount: number
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  contains(other: unknown): boolean
  getBoundingClientRect(): {
    left: number
    top: number
    width: number
    height: number
    right: number
    bottom: number
  }
  click(): void
  focus(): void
  scrollIntoView(): void
  dispatchEvent(event: { type: string }): boolean
}

function makeElement(
  tagName: string,
  opts: {
    attrs?: Record<string, string>
    isConnected?: boolean
    className?: string
    value?: string
    checked?: boolean
    rect?: { left: number; top: number; width: number; height: number }
  } = {}
): StubElement {
  const el: StubElement = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    attrs: opts.attrs || {},
    isConnected: opts.isConnected !== false,
    parentElement: null,
    children: [],
    className: opts.className || '',
    clicks: 0,
    focuses: 0,
    scrolls: 0,
    dispatched: [],
    rect: opts.rect || { left: 10, top: 10, width: 100, height: 40 },
    get childElementCount() {
      return el.children.length
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name)
    },
    contains(other) {
      if (other === el) return true
      return el.children.some((child) => child.contains(other))
    },
    getBoundingClientRect() {
      return {
        left: el.rect.left,
        top: el.rect.top,
        width: el.rect.width,
        height: el.rect.height,
        right: el.rect.left + el.rect.width,
        bottom: el.rect.top + el.rect.height
      }
    },
    click() {
      el.clicks += 1
    },
    focus() {
      el.focuses += 1
    },
    scrollIntoView() {
      el.scrolls += 1
    },
    dispatchEvent(event) {
      el.dispatched.push(event.type)
      return true
    }
  }
  if (opts.value !== undefined) el.value = opts.value
  if (opts.checked !== undefined) el.checked = opts.checked
  return el
}

function appendChild(parent: StubElement, child: StubElement): StubElement {
  parent.children.push(child)
  child.parentElement = parent
  return child
}

interface ActOutcome {
  ok: boolean
  found: boolean
  action: string
  executed: boolean
  verified: 'changed' | 'unchanged' | 'unknown'
  refusalReason?: string
  message?: string
}

interface HarnessOptions {
  /** Element registered under the ref, if any. */
  refElement?: StubElement
  /** Identity string recorded for the ref at snapshot time. */
  recordedIdentity?: string
  /** What document.elementFromPoint returns; defaults to the target itself. */
  hitTest?: StubElement | null
  selectorElement?: StubElement
  /**
   * Runs during dispatch so a test can simulate the page reacting. Receives the
   * live document stub so the mutation is one the script can actually observe.
   */
  onInteract?: (doc: { title: string }) => void
}

/**
 * Evaluates the real generated script. `window`/`document`/`location` and the
 * event constructors are passed as parameters so they shadow the Node globals.
 */
function runAct(action: CanvasActionInput, opts: HarnessOptions): ActOutcome {
  const body = makeElement('body')
  const doc = {
    title: 'Start',
    body,
    querySelector: (_selector: string) => opts.selectorElement || null,
    elementFromPoint: (_x: number, _y: number) =>
      opts.hitTest === undefined ? opts.refElement || null : opts.hitTest
  }
  const loc = { href: 'http://localhost:5173/app' }
  const win: Record<string, unknown> = {
    innerWidth: 1280,
    innerHeight: 800,
    __twCanvas__: {
      refs: opts.refElement && action.ref ? { [action.ref]: opts.refElement } : {},
      ids:
        opts.recordedIdentity !== undefined && action.ref
          ? { [action.ref]: opts.recordedIdentity }
          : {}
    }
  }

  class StubEvent {
    type: string
    constructor(type: string) {
      this.type = type
      if (opts.onInteract) opts.onInteract(doc)
    }
  }

  const source = actScript(action)
  const evaluate = new Function(
    'window',
    'document',
    'location',
    'MouseEvent',
    'Event',
    `return ${source}`
  )
  return evaluate(win, doc, loc, StubEvent, StubEvent) as ActOutcome
}

/** Mirrors the __twIdentity digest for a stub element. */
function identityOf(el: StubElement): string {
  const label = (
    el.getAttribute('aria-label') ||
    el.getAttribute('alt') ||
    el.getAttribute('title') ||
    el.getAttribute('placeholder') ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  let path = ''
  let node: StubElement | null = el
  let depth = 0
  while (node && node.nodeType === 1 && depth < 6) {
    const parent: StubElement | null = node.parentElement
    let index = 0
    if (parent) {
      for (const sibling of parent.children) {
        if (sibling === node) break
        if (sibling.tagName === node.tagName) index += 1
      }
    }
    path = `/${node.tagName}[${index}]${path}`
    node = parent
    depth += 1
  }
  return `${el.tagName}|${el.getAttribute('role') || ''}|${el.getAttribute('type') || ''}|${label}|${path}`
}

describe('canvas actuation preconditions', () => {
  it('refuses a detached target instead of reporting a phantom success', () => {
    // The D1 regression. Before the fix this returned { ok: true, found: true }.
    const button = makeElement('button', { isConnected: false })
    const result = runAct({ kind: 'click', ref: 'e4' }, { refElement: button })

    expect(result.ok).toBe(false)
    expect(result.executed).toBe(false)
    expect(result.refusalReason).toBe('stale_target')
    expect(button.clicks).toBe(0)
    expect(button.dispatched).toEqual([])
  })

  it('refuses when the ref now points at a different element than the snapshot saw', () => {
    const root = makeElement('div')
    const button = appendChild(root, makeElement('button', { attrs: { 'aria-label': 'Save' } }))
    const staleIdentity = identityOf(button).replace('Save', 'Delete everything')

    const result = runAct(
      { kind: 'click', ref: 'e9' },
      { refElement: button, recordedIdentity: staleIdentity }
    )

    expect(result.executed).toBe(false)
    expect(result.refusalReason).toBe('stale_target')
    expect(button.clicks).toBe(0)
  })

  it('accepts a ref whose recomputed identity still matches', () => {
    const root = makeElement('div')
    const button = appendChild(root, makeElement('button', { attrs: { 'aria-label': 'Save' } }))

    const result = runAct(
      { kind: 'click', ref: 'e9' },
      { refElement: button, recordedIdentity: identityOf(button) }
    )

    expect(result.executed).toBe(true)
    expect(result.refusalReason).toBeUndefined()
    expect(button.clicks).toBe(1)
  })

  it('refuses when the target centre is covered by an unrelated element', () => {
    const button = makeElement('button')
    const overlay = makeElement('div')

    const result = runAct({ kind: 'click', ref: 'e1' }, { refElement: button, hitTest: overlay })

    expect(result.executed).toBe(false)
    expect(result.found).toBe(true)
    expect(result.refusalReason).toBe('occluded')
    expect(button.clicks).toBe(0)
  })

  it('still acts when the hit-test lands on a descendant of the target', () => {
    const button = makeElement('button')
    const label = appendChild(button, makeElement('span'))

    const result = runAct({ kind: 'click', ref: 'e1' }, { refElement: button, hitTest: label })

    expect(result.executed).toBe(true)
    expect(button.clicks).toBe(1)
  })

  it('reports not_found without executing when nothing resolves', () => {
    const result = runAct({ kind: 'click', selector: '#gone' }, {})

    expect(result.ok).toBe(false)
    expect(result.found).toBe(false)
    expect(result.executed).toBe(false)
    expect(result.refusalReason).toBe('not_found')
  })

  it('reports verified:changed when the page reacts synchronously', () => {
    const button = makeElement('button')
    const result = runAct(
      { kind: 'click', ref: 'e1' },
      {
        refElement: button,
        onInteract: (doc) => {
          doc.title = 'Saved'
        }
      }
    )

    expect(result.executed).toBe(true)
    expect(result.verified).toBe('changed')
  })

  it('reports verified:unchanged — never a bare success — when nothing moves', () => {
    const button = makeElement('button')
    const result = runAct({ kind: 'click', ref: 'e1' }, { refElement: button })

    expect(result.executed).toBe(true)
    expect(result.verified).toBe('unchanged')
  })

  describe('credential fields', () => {
    // Canvas partitions are ephemeral, so the user re-authenticates INSIDE the
    // agent-drivable surface, and frames leave the machine when a hosted provider
    // is driving. The agent must not be the thing that handles secrets.
    const cases: Array<[string, Record<string, string>]> = [
      ['type=password', { type: 'password' }],
      ['revealed password (autocomplete)', { type: 'text', autocomplete: 'current-password' }],
      ['new-password', { type: 'text', autocomplete: 'new-password' }],
      ['one-time-code', { type: 'text', autocomplete: 'one-time-code' }],
      ['author opt-out marker', { type: 'text', 'data-tw-secret': '' }]
    ]

    for (const [label, attrs] of cases) {
      it(`refuses to fill ${label}`, () => {
        const input = makeElement('input', { attrs, value: '' })
        const result = runAct({ kind: 'fill', ref: 'e1', value: 'hunter2' }, { refElement: input })

        expect(result.ok).toBe(false)
        expect(result.executed).toBe(false)
        expect(result.refusalReason).toBe('secret_field')
        // Neither written nor focused — no keystroke path at all.
        expect(input.value).toBe('')
        expect(input.focuses).toBe(0)
      })
    }

    it('still fills an ordinary text field', () => {
      const input = makeElement('input', { attrs: { type: 'text' }, value: '' })
      const result = runAct({ kind: 'fill', ref: 'e1', value: 'hello' }, { refElement: input })

      expect(result.executed).toBe(true)
      expect(input.value).toBe('hello')
    })

    it('does not refuse a username field just because it sits next to a password', () => {
      const input = makeElement('input', {
        attrs: { type: 'text', autocomplete: 'username' },
        value: ''
      })
      const result = runAct({ kind: 'fill', ref: 'e1', value: 'ada' }, { refElement: input })

      expect(result.executed).toBe(true)
      expect(input.value).toBe('ada')
    })
  })

  it('detects a change when the interaction mutates the target', () => {
    const input = makeElement('input', { attrs: { type: 'text' }, value: '' })
    const result = runAct({ kind: 'fill', ref: 'e2', value: 'hello' }, { refElement: input })

    expect(result.executed).toBe(true)
    expect(result.verified).toBe('changed')
    expect(input.value).toBe('hello')
  })

  it('refuses a fill against a non-field without executing', () => {
    const div = makeElement('div')
    const result = runAct({ kind: 'fill', ref: 'e3', value: 'x' }, { refElement: div })

    expect(result.executed).toBe(false)
    expect(result.refusalReason).toBe('not_fillable')
  })

  it('does not scroll a target that is already in view', () => {
    const button = makeElement('button', { rect: { left: 40, top: 40, width: 80, height: 30 } })
    runAct({ kind: 'click', ref: 'e1' }, { refElement: button })

    expect(button.scrolls).toBe(0)
  })

  it('scrolls a target that is outside the viewport', () => {
    const button = makeElement('button', { rect: { left: 40, top: 4000, width: 80, height: 30 } })
    runAct({ kind: 'click', ref: 'e1' }, { refElement: button })

    expect(button.scrolls).toBe(1)
  })
})

/**
 * Screenshot-side credential protection. Snapshots already redact secret input
 * VALUES, but a screenshot captures the rendered field, so it needs its own
 * guard — and frames leave the machine whenever a hosted provider is driving.
 */
describe('screenshot secret redaction', () => {
  interface FakeNode {
    tagName: string
    style: { cssText: string }
    id: string
    children: FakeNode[]
    removed?: boolean
    appendChild(child: FakeNode): FakeNode
    remove(): void
  }

  function node(tagName = 'div'): FakeNode {
    const n: FakeNode = {
      tagName,
      style: { cssText: '' },
      id: '',
      children: [],
      appendChild(child) {
        n.children.push(child)
        return child
      },
      remove() {
        n.removed = true
      }
    } as FakeNode & { removed?: boolean }
    return n
  }

  function runRedaction(fields: Array<{ width: number; height: number }>): {
    count: number
    layer: FakeNode | null
    selector: string
  } {
    let selector = ''
    const root = node('html')
    const byId = new Map<string, FakeNode>()
    const doc = {
      querySelectorAll: (sel: string) => {
        selector = sel
        return fields.map((f) => ({
          getBoundingClientRect: () => ({
            left: 10,
            top: 20,
            width: f.width,
            height: f.height
          })
        }))
      },
      getElementById: (id: string) => byId.get(id) ?? null,
      createElement: (tagName: string) => node(tagName),
      documentElement: root
    }
    const evaluate = new Function('document', `return ${REDACT_SECRETS_SCRIPT}`)
    const count = evaluate(doc) as number
    const layer = root.children[0] ?? null
    if (layer) byId.set('__twSecretRedaction', layer)
    return { count, layer, selector }
  }

  it('paints one opaque box per visible secret field', () => {
    const { count, layer } = runRedaction([
      { width: 200, height: 30 },
      { width: 160, height: 30 }
    ])

    expect(count).toBe(2)
    expect(layer?.children).toHaveLength(2)
    // Opaque fill, not merely a blur or an outline.
    expect(layer?.children[0]?.style.cssText).toContain('background:#111827')
    expect(layer?.children[0]?.style.cssText).toContain('left:10px')
  })

  it('matches revealed and one-time-code fields, not just type=password', () => {
    const { selector } = runRedaction([{ width: 10, height: 10 }])

    expect(selector).toContain('input[type=password]')
    expect(selector).toContain('autocomplete*="password"')
    expect(selector).toContain('one-time-code')
    expect(selector).toContain('data-tw-secret')
  })

  it('touches nothing when the page has no secret fields', () => {
    // No overlay means no flicker on the overwhelmingly common screenshot.
    const { count, layer } = runRedaction([])

    expect(count).toBe(0)
    expect(layer).toBeNull()
  })

  it('ignores zero-size fields so a hidden input cannot inflate the count', () => {
    const { count } = runRedaction([{ width: 0, height: 0 }])

    expect(count).toBe(0)
  })

  it('the teardown script removes the overlay by id', () => {
    const layer = node('div')
    const doc = { getElementById: (id: string) => (id === '__twSecretRedaction' ? layer : null) }
    const evaluate = new Function('document', `return ${CLEAR_SECRET_REDACTION_SCRIPT}`)

    expect(evaluate(doc)).toBe(true)
    expect((layer as FakeNode & { removed?: boolean }).removed).toBe(true)
  })
})
