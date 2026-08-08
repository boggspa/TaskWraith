import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CanvasDockPanel,
  canvasDockSessionStore,
  canvasSummaryLabel,
  reconcileDockSessions,
  selectAgentCanvases,
  toCanvasDockSummary,
  type CanvasDockChatState
} from './CanvasDockPanel'
import { isHostOccluded } from './CanvasPane'

describe('reconcileDockSessions', () => {
  const state: CanvasDockChatState = {
    sessions: [
      { canvasId: 'a', kind: 'web' },
      { canvasId: 'b', kind: 'sketch' }
    ],
    activeCanvasId: 'b'
  }

  it('returns the same reference when every session is still live', () => {
    expect(reconcileDockSessions(state, new Set(['a', 'b', 'other']))).toBe(state)
  })

  it('drops dead sessions and repairs the active id', () => {
    expect(reconcileDockSessions(state, new Set(['a']))).toEqual({
      sessions: [{ canvasId: 'a', kind: 'web' }],
      activeCanvasId: 'a'
    })
    expect(reconcileDockSessions(state, new Set())).toEqual({
      sessions: [],
      activeCanvasId: null
    })
  })

  it('keeps the active id when it survives the sweep', () => {
    expect(reconcileDockSessions(state, new Set(['b']))).toEqual({
      sessions: [{ canvasId: 'b', kind: 'sketch' }],
      activeCanvasId: 'b'
    })
  })
})

describe('toCanvasDockSummary', () => {
  it('decodes a summary defensively', () => {
    expect(
      toCanvasDockSummary({
        canvasId: 'c1',
        driver: 'web',
        url: 'http://localhost:3000/',
        title: 'App',
        status: 'active',
        viewport: { width: 1, height: 1 }
      })
    ).toEqual({
      canvasId: 'c1',
      driver: 'web',
      url: 'http://localhost:3000/',
      title: 'App',
      status: 'active'
    })
  })

  it('rejects junk and fills missing fields', () => {
    expect(toCanvasDockSummary(null)).toBeNull()
    expect(toCanvasDockSummary('x')).toBeNull()
    expect(toCanvasDockSummary({})).toBeNull()
    expect(toCanvasDockSummary({ canvasId: 'c2', driver: 42 })).toEqual({
      canvasId: 'c2',
      driver: 'web',
      url: '',
      title: '',
      status: ''
    })
  })
})

describe('selectAgentCanvases', () => {
  it('keeps only live canvases this renderer does not host', () => {
    const summaries = [
      { canvasId: 'dock', driver: 'web', url: '', title: '', status: 'active' },
      { canvasId: 'agent', driver: 'web', url: '', title: '', status: 'active' },
      { canvasId: 'render', driver: 'html', url: 'html://abc', title: '', status: 'active' },
      { canvasId: 'gone', driver: 'web', url: '', title: '', status: 'closed' }
    ]
    expect(selectAgentCanvases(summaries, new Set(['dock'])).map((s) => s.canvasId)).toEqual([
      'agent',
      'render'
    ])
  })
})

describe('canvasSummaryLabel', () => {
  it('prefers title, then url host, then the raw url, then a driver default', () => {
    expect(canvasSummaryLabel({ title: 'My App', url: 'http://localhost:3000' })).toBe('My App')
    expect(canvasSummaryLabel({ url: 'http://localhost:3000/deep/path' })).toBe('localhost:3000')
    expect(canvasSummaryLabel({ url: 'html://abc123' })).toBe('html://abc123')
    expect(canvasSummaryLabel({ driver: 'sketch' })).toBe('Sketch canvas')
    expect(canvasSummaryLabel({})).toBe('Canvas')
  })

  it('never labels a sketch with its internal sketch:// url', () => {
    expect(canvasSummaryLabel({ driver: 'sketch', url: 'sketch://abc-def' })).toBe('Sketch canvas')
    expect(
      canvasSummaryLabel({ driver: 'sketch', title: 'Sketch Canvas', url: 'sketch://x' })
    ).toBe('Sketch Canvas')
  })
})

describe('isHostOccluded', () => {
  const host = {
    getBoundingClientRect: () => ({
      left: 100,
      top: 100,
      right: 300,
      bottom: 300,
      width: 200,
      height: 200
    }),
    contains: (node: Node | null) => node === ownChild
  } as unknown as Parameters<typeof isHostOccluded>[0]
  const hostElement = host as unknown as Element
  const ownChild = { name: 'own-child' } as unknown as Element
  const overlay = { name: 'overlay' } as unknown as Element

  it('is clear when every sampled point hits the host or its children', () => {
    expect(isHostOccluded(host, () => hostElement)).toBe(false)
    expect(isHostOccluded(host, () => ownChild)).toBe(false)
    expect(isHostOccluded(host, () => null)).toBe(false)
  })

  it('is occluded when any sampled point hits foreign DOM', () => {
    expect(isHostOccluded(host, (x, y) => (x < 200 && y < 200 ? overlay : hostElement))).toBe(true)
    expect(isHostOccluded(host, () => overlay)).toBe(true)
  })

  it('catches an overlay inset from the host edges via edge-midpoint samples', () => {
    // Mirrors the dock switcher popover: covers the host's top strip but sits a
    // few px inside both vertical edges, so corners and center all miss it.
    const insetOverlay = (x: number, y: number): Element =>
      x >= 110 && x <= 290 && y >= 90 && y <= 180 ? overlay : hostElement
    expect(isHostOccluded(host, insetOverlay)).toBe(true)
  })

  it('ignores collapsed hosts', () => {
    const collapsed = {
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 4, bottom: 4, width: 4, height: 4 }),
      contains: () => false
    } as unknown as Parameters<typeof isHostOccluded>[0]
    expect(isHostOccluded(collapsed, () => overlay)).toBe(false)
  })
})

describe('CanvasDockPanel mesh/simulator surface races', () => {
  it('listForChat mesh rehydrate consults the simulator override guard before openMeshSurface', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/CanvasDockPanel.tsx'),
      'utf8'
    )
    expect(source).toContain('shouldOpenMeshFromChatRehydrate')
    expect(source).toContain('getPendingSimulatorCanvasOpenRequest()?.chatId')
    // Rehydrate must not open Mesh when Simulator is already showing or pending.
    const rehydrateBlock = source.slice(
      source.indexOf('listForChat(chatId)'),
      source.indexOf('// The composer can explicitly open Mesh Canvas')
    )
    expect(rehydrateBlock).toContain('shouldOpenMeshFromChatRehydrate')
    expect(rehydrateBlock).toContain('openMeshSurface()')
  })
})

describe('CanvasDockPanel (static render)', () => {
  it('renders both launchers when the chat has no dock sessions', () => {
    const html = renderToStaticMarkup(<CanvasDockPanel chatId="chat-empty" />)
    expect(html).toContain('Browser')
    expect(html).toContain('Open a website, your dev server, or a running app in a sandboxed pane.')
    expect(html).toContain('Sketch canvas')
    expect(html).toContain('Open sketch canvas')
    expect(html).toContain('aria-label="Browser URL"')
    // No sessions → no pill strip, no embedded pane host, no + toggle.
    expect(html).not.toContain('canvas-dock-tab ')
    expect(html).not.toContain('canvas-pane-host')
    expect(html).not.toContain('canvas-dock-new')
  })

  it('renders the session pill, the embedded pane, and the pop-out affordance', () => {
    canvasDockSessionStore.add('chat-static', { canvasId: 'c-web', kind: 'web' })
    canvasDockSessionStore.add('chat-static', { canvasId: 'c-sketch', kind: 'sketch' })
    try {
      const html = renderToStaticMarkup(<CanvasDockPanel chatId="chat-static" />)
      expect(html).toContain('role="tablist"')
      expect(html.match(/role="tab"/g)).toHaveLength(2)
      // The sketch session was added last → active; labels fall back per kind.
      expect(html).toContain('Sketch canvas')
      expect(html).toContain('canvas-pane-host')
      expect(html).toContain('aria-label="Move canvas to a floating window"')
      expect(html).toContain('aria-label="Close canvas pane"')
      expect(html).toContain('aria-label="Open a new canvas"')
      // Sessions exist → the launcher is collapsed behind the + toggle.
      expect(html).not.toContain('Open sketch canvas')
    } finally {
      canvasDockSessionStore.remove('chat-static', 'c-web')
      canvasDockSessionStore.remove('chat-static', 'c-sketch')
    }
  })

  it('keeps per-chat session state isolated', () => {
    canvasDockSessionStore.add('chat-a', { canvasId: 'c1', kind: 'web' })
    try {
      const other = renderToStaticMarkup(<CanvasDockPanel chatId="chat-b" />)
      expect(other).toContain('Open sketch canvas')
      expect(other).not.toContain('role="tablist"')
    } finally {
      canvasDockSessionStore.remove('chat-a', 'c1')
    }
  })
})
