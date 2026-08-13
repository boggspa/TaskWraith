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
        presentation: 'dock',
        viewport: { width: 1, height: 1 }
      })
    ).toEqual({
      canvasId: 'c1',
      driver: 'web',
      url: 'http://localhost:3000/',
      title: 'App',
      status: 'active',
      presentation: 'dock'
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
    expect(canvasSummaryLabel({ driver: 'chart' })).toBe('Chart')
    expect(canvasSummaryLabel({})).toBe('Canvas')
  })

  it('never labels a sketch with its internal sketch:// url', () => {
    expect(canvasSummaryLabel({ driver: 'sketch', url: 'sketch://abc-def' })).toBe('Sketch canvas')
    expect(
      canvasSummaryLabel({ driver: 'sketch', title: 'Sketch Canvas', url: 'sketch://x' })
    ).toBe('Sketch Canvas')
  })

  it('never labels a chart with its internal chart:// url', () => {
    expect(canvasSummaryLabel({ driver: 'chart', url: 'chart://abc12345' })).toBe('Chart')
    expect(
      canvasSummaryLabel({ driver: 'chart', title: 'Latency p95', url: 'chart://deadbeef' })
    ).toBe('Latency p95')
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
  it('lets the Mesh Canvas toolbar dismiss its non-destructive surface', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/CanvasDockPanel.tsx'),
      'utf8'
    )
    expect(source).toContain('const dismissMeshSurface = useCallback')
    expect(source).toContain('setShowMesh(false)')
    expect(source).toContain('<MeshCanvasPanel chatId={chatId} onDismiss={dismissMeshSurface} />')
  })

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

  it('switches to Simulator Canvas for chat-scoped agent presentation events', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/CanvasDockPanel.tsx'),
      'utf8'
    )
    expect(source).toContain('window.api?.simulatorCanvas')
    expect(source).toContain('isSimulatorCanvasPresentationEvent(event, chatId)')
    expect(source).toContain('openSimulatorSurface()')
  })
})

describe('CanvasDockPanel (static render)', () => {
  it('renders a calm browser-first empty state with compact surface controls', () => {
    const html = renderToStaticMarkup(<CanvasDockPanel chatId="chat-empty" />)
    expect(html).toContain('New tab')
    expect(html).toContain('Start browsing')
    expect(html).toContain('Enter a URL to open a page')
    expect(html).toContain('aria-label="Browser URL"')
    expect(html).toContain('Sign-ins stay in TaskWraith')
    expect(html).toContain('aria-label="Choose canvas surface"')
    expect(html).toContain('aria-label="Browser profile and privacy"')
    // Secondary surfaces stay behind the compact + menu until requested.
    expect(html).not.toContain('Open sketch canvas')
    expect(html).not.toContain('Open Simulator Canvas')
    // No sessions → no pill strip or embedded pane host.
    expect(html).not.toContain('canvas-dock-tab ')
    expect(html).not.toContain('canvas-pane-host')
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
      expect(html).toContain('aria-label="Choose canvas surface"')
      expect(html).toContain('aria-label="Browser profile and privacy"')
      // Sessions exist → the launcher is collapsed behind the + toggle.
      expect(html).not.toContain('Start browsing')
    } finally {
      canvasDockSessionStore.remove('chat-static', 'c-web')
      canvasDockSessionStore.remove('chat-static', 'c-sketch')
    }
  })

  it('keeps per-chat session state isolated', () => {
    canvasDockSessionStore.add('chat-a', { canvasId: 'c1', kind: 'web' })
    try {
      const other = renderToStaticMarkup(<CanvasDockPanel chatId="chat-b" />)
      expect(other).toContain('Start browsing')
      expect(other).not.toContain('role="tablist"')
    } finally {
      canvasDockSessionStore.remove('chat-a', 'c1')
    }
  })

  it('keeps persistent-profile controls human-facing and explicit about credential handoff', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/CanvasDockPanel.tsx'),
      'utf8'
    )
    expect(source).toContain('api.clearBrowserProfile()')
    expect(source).toContain('Cookies and sign-ins stay inside TaskWraith')
    expect(source).toContain('cannot type passwords or verification codes')
    expect(source).toContain('Close browser tabs across all tasks')
    expect(source).toContain('Sketch, 3D, and Simulator canvases stay open')
  })

  it('hosts chart sessions as TelemetryCanvasPanel tabs without pop-out or CanvasPane', () => {
    canvasDockSessionStore.add('chat-chart', { canvasId: 'c-chart', kind: 'chart' })
    try {
      const html = renderToStaticMarkup(<CanvasDockPanel chatId="chat-chart" />)
      expect(html).toContain('role="tablist"')
      expect(html).toContain('canvas-dock-tab')
      expect(html).toContain('canvas-dock-telemetry')
      expect(html).toContain('aria-label="Telemetry chart"')
      // Native pane — never a WebContentsView host or floating-window pop-out.
      expect(html).not.toContain('canvas-pane-host')
      expect(html).not.toContain('aria-label="Move canvas to a floating window"')
      expect(html).not.toContain('canvas-browser-chrome')
    } finally {
      canvasDockSessionStore.remove('chat-chart', 'c-chart')
    }
  })

  it('adopts chart dock presentations without adoptEmbedded (native pane path)', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/CanvasDockPanel.tsx'),
      'utf8'
    )
    expect(source).toContain("'web' | 'sketch' | 'chart'")
    expect(source).toContain("driver === 'chart'")
    expect(source).toContain('TelemetryCanvasPanel')
    expect(source).toContain('dockSessionKindFromDriver')
    // Chart must not share the WebContentsView adoption path.
    const adoptBlock = source.slice(
      source.indexOf('selectUnownedDockPresentations'),
      source.indexOf('canvasDockSessionStore.reconcile')
    )
    expect(adoptBlock).toMatch(/driver === ['"]chart['"]/)
    expect(adoptBlock).toContain('continue')
  })
})

describe('toCanvasDockSummary chart document', () => {
  it('forwards a validated chartDocument when list/status includes one', () => {
    const chartDocument = {
      schemaVersion: 1 as const,
      title: 'Latency p95',
      kind: 'line' as const,
      series: [{ id: 'p95', label: 'p95', points: [{ x: 0, y: 1 }] }]
    }
    expect(
      toCanvasDockSummary({
        canvasId: 'c-chart',
        driver: 'chart',
        url: 'chart://abc',
        title: 'Latency p95',
        status: 'active',
        presentation: 'dock',
        chartDocument
      })
    ).toEqual({
      canvasId: 'c-chart',
      driver: 'chart',
      url: 'chart://abc',
      title: 'Latency p95',
      status: 'active',
      presentation: 'dock',
      chartDocument
    })
  })
})
