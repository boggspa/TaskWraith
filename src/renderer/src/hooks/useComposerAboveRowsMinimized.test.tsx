import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useComposerAboveRowsMinimized } from './useComposerAboveRowsMinimized'

type Input = Parameters<typeof useComposerAboveRowsMinimized>[0]
type Controls = ReturnType<typeof useComposerAboveRowsMinimized>

let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  vi.unstubAllGlobals()
})

// The hook renders no DOM. Use the same minimal React root environment as the
// composer suggestion hook tests, so transitions exercise real effects/state.
function createContainer(): Element {
  class MinimalNode extends EventTarget {
    readonly nodeType: number = 0
  }
  class MinimalHTMLElement extends MinimalNode {
    override readonly nodeType: number = 1
  }
  class MinimalHTMLIFrameElement extends MinimalHTMLElement {}
  const document = Object.assign(new EventTarget(), {
    nodeType: 9,
    activeElement: null,
    body: null,
    documentElement: {}
  })
  const window = Object.assign(new EventTarget(), {
    document,
    Node: MinimalNode,
    HTMLElement: MinimalHTMLElement,
    HTMLIFrameElement: MinimalHTMLIFrameElement
  })
  Object.assign(document, { defaultView: window })
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  vi.stubGlobal('Node', MinimalNode)
  vi.stubGlobal('HTMLElement', MinimalHTMLElement)
  vi.stubGlobal('Element', MinimalHTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return Object.assign(new MinimalHTMLElement(), {
    ownerDocument: document,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    firstChild: null,
    appendChild: () => undefined,
    removeChild: () => undefined
  }) as unknown as Element
}

function mount(initial: Input) {
  let input = initial
  let controls: Controls
  function Harness(): null {
    controls = useComposerAboveRowsMinimized(input)
    return null
  }
  function render(): void {
    act(() => root!.render(createElement(StrictMode, null, createElement(Harness))))
  }
  root = createRoot(createContainer())
  render()
  return {
    minimized: (): boolean => controls[0],
    toggle: (minimized: boolean): void => {
      act(() => controls[1](minimized))
    },
    update: (patch: Partial<Input>): void => {
      input = { ...input, ...patch }
      render()
    }
  }
}

const welcome: Input = {
  chatId: 'ensemble-new',
  isEnsemble: true,
  isWelcome: true,
  messages: []
}

describe('useComposerAboveRowsMinimized', () => {
  it('keeps welcome configuration visible until the first user prompt arrives', () => {
    const composer = mount(welcome)
    expect(composer.minimized()).toBe(false)

    // Changing Max handoff turns and other roster controls writes system rows.
    composer.update({ messages: [{ role: 'system' }, { role: 'system' }] })
    expect(composer.minimized()).toBe(false)

    composer.update({
      isWelcome: false,
      messages: [{ role: 'system' }, { role: 'user' }]
    })
    expect(composer.minimized()).toBe(true)
  })

  it('waits through a rejected send and minimises when a retry reaches the thread', () => {
    const composer = mount(welcome)
    composer.update({ isWelcome: false, messages: [{ role: 'error' }] })
    expect(composer.minimized()).toBe(false)

    composer.update({ messages: [{ role: 'error' }, { role: 'user' }] })
    expect(composer.minimized()).toBe(true)
  })

  it('honours Show rows during streaming, later prompts, and welcome-state changes', () => {
    const composer = mount(welcome)
    composer.update({ isWelcome: false, messages: [{ role: 'user' }] })
    composer.toggle(false)
    expect(composer.minimized()).toBe(false)

    composer.update({ messages: [{ role: 'user' }, { role: 'assistant' }] })
    composer.update({
      messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }]
    })
    expect(composer.minimized()).toBe(false)

    // Even a cleared/rewound transcript must not re-arm the automatic action.
    composer.update({ isWelcome: true, messages: [] })
    composer.update({ isWelcome: false, messages: [{ role: 'user' }] })
    expect(composer.minimized()).toBe(false)
  })

  it('keeps a fresh thread expanded and restores each thread’s manual choice', () => {
    const composer = mount(welcome)
    composer.update({ isWelcome: false, messages: [{ role: 'user' }] })
    expect(composer.minimized()).toBe(true)

    composer.update({ ...welcome, chatId: 'ensemble-next' })
    expect(composer.minimized()).toBe(false)
    composer.update({ isWelcome: false, messages: [{ role: 'user' }] })
    expect(composer.minimized()).toBe(true)
    composer.toggle(false)

    composer.update({ chatId: 'ensemble-new' })
    expect(composer.minimized()).toBe(true)
    composer.update({ chatId: 'ensemble-next' })
    expect(composer.minimized()).toBe(false)
  })

  it('leaves solo first prompts and already-started ensemble threads expanded', () => {
    const composer = mount({ ...welcome, isEnsemble: false })
    composer.update({ isWelcome: false, messages: [{ role: 'user' }] })
    expect(composer.minimized()).toBe(false)
    composer.update({ isEnsemble: true })
    expect(composer.minimized()).toBe(false)

    composer.update({ chatId: 'existing-ensemble' })
    expect(composer.minimized()).toBe(false)
    composer.update({ messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }] })
    expect(composer.minimized()).toBe(false)
    composer.toggle(true)
    expect(composer.minimized()).toBe(true)
  })

  it('uses Ensemble ON at submission even if the welcome draft began as solo', () => {
    const composer = mount({ ...welcome, isEnsemble: false })
    composer.update({ isEnsemble: true })
    expect(composer.minimized()).toBe(false)
    composer.update({ isWelcome: false, messages: [{ role: 'user' }] })
    expect(composer.minimized()).toBe(true)
  })
})
