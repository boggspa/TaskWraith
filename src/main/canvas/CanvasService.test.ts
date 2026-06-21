import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CanvasService } from './CanvasService'
import { CanvasStore } from './CanvasStore'
import type {
  CanvasActionInput,
  CanvasActResult,
  CanvasConsoleEntry,
  CanvasDriver,
  CanvasElementDetail,
  CanvasElementTree,
  CanvasEventRecord,
  CanvasFrame,
  CanvasMark,
  CanvasNetworkEntry,
  CanvasOpenInput,
  CanvasSessionHandle,
  CanvasViewport
} from './canvasTypes'

class FakeDriver implements CanvasDriver {
  readonly kind = 'web' as const
  opened = false
  closed = false
  failOpen = false

  async open(input: CanvasOpenInput): Promise<CanvasSessionHandle> {
    if (this.failOpen) throw new Error('boom')
    this.opened = true
    return {
      url: input.url || 'http://localhost:3000',
      title: 'Fake',
      viewport: input.viewport || { width: 1280, height: 800 }
    }
  }
  async snapshot(): Promise<CanvasElementTree> {
    return {
      url: 'http://localhost:3000',
      title: 'Fake',
      viewport: { width: 1280, height: 800 },
      capturedAt: 'x',
      root: { ref: 'e1', role: 'document', tag: 'body' },
      nodeCount: 1,
      truncated: false
    }
  }
  async screenshot(): Promise<CanvasFrame> {
    return {
      mimeType: 'image/png',
      data: 'BASE64PNGBYTES',
      width: 1280,
      height: 800,
      byteLength: 14,
      hash: 'deadbeef',
      capturedAt: 'x'
    }
  }
  async inspect(args: { ref?: string; selector?: string }): Promise<CanvasElementDetail> {
    return { found: true, tag: 'div', role: 'generic', ref: args.ref, selector: args.selector }
  }
  async network(): Promise<CanvasNetworkEntry[]> {
    return []
  }
  async console(): Promise<CanvasConsoleEntry[]> {
    return []
  }
  async resize(viewport: CanvasViewport): Promise<CanvasViewport> {
    return viewport
  }
  async act(action: CanvasActionInput): Promise<CanvasActResult> {
    return {
      ok: action.ref !== 'missing',
      action: action.kind,
      found: action.ref !== 'missing',
      ref: action.ref,
      selector: action.selector
    }
  }
  async annotate(marks: CanvasMark[]): Promise<{ count: number }> {
    return { count: marks.length }
  }
  async close(): Promise<void> {
    this.closed = true
  }
}

describe('CanvasService', () => {
  let dir: string
  let store: CanvasStore
  let fake: FakeDriver
  let events: CanvasEventRecord[]
  let service: CanvasService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canvas-svc-'))
    store = new CanvasStore(dir)
    fake = new FakeDriver()
    events = []
    let seq = 0
    service = new CanvasService({
      createDriver: () => fake,
      store,
      uuid: () => `id-${++seq}`,
      now: () => '2026-06-21T00:00:00.000Z',
      broadcast: (event) => events.push(event)
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('opens a web canvas → active + persisted + session.opened', async () => {
    const opened = await service.open({ url: 'http://localhost:3000' }, { provider: 'claude' })
    expect(opened.canvasId).toBeTruthy()
    expect(fake.opened).toBe(true)
    expect(service.status(opened.canvasId, {})?.status).toBe('active')
    expect(store.getSession(opened.canvasId)?.status).toBe('active')
    expect(events.map((e) => e.kind)).toContain('session.opened')
  })

  it('rejects an unsupported driver', async () => {
    await expect(service.open({ driver: 'device', url: 'http://localhost:3000' }, {})).rejects.toThrow(
      /not available/
    )
  })

  it('rejects a bad url before spawning a window', async () => {
    await expect(service.open({ url: 'file:///etc/passwd' }, {})).rejects.toThrow()
    expect(fake.opened).toBe(false)
  })

  it('snapshot/screenshot emit redacted events — base64 never enters the audit', async () => {
    const opened = await service.open({ url: 'http://localhost:3000' }, {})
    await service.snapshot(opened.canvasId, {})
    const frame = await service.screenshot(opened.canvasId, {})
    expect(frame.data).toBe('BASE64PNGBYTES')
    const shot = events.find((e) => e.kind === 'screenshot')
    expect(shot?.detail?.frameHash).toBe('deadbeef')
    expect(JSON.stringify(events)).not.toContain('BASE64PNGBYTES')
  })

  it('throws on an unknown canvas id', async () => {
    await expect(service.snapshot('nope', {})).rejects.toThrow(/No open canvas/)
  })

  it('closes → closed status + session.closed + removed from live list', async () => {
    const opened = await service.open({ url: 'http://localhost:3000' }, {})
    await service.close(opened.canvasId, {})
    expect(fake.closed).toBe(true)
    expect(store.getSession(opened.canvasId)?.status).toBe('closed')
    expect(events.map((e) => e.kind)).toContain('session.closed')
    expect(service.list({})).toHaveLength(0)
  })

  it('records open failure as error + session.error and tears the driver down', async () => {
    fake.failOpen = true
    await expect(service.open({ url: 'http://localhost:3000' }, {})).rejects.toThrow('boom')
    expect(events.map((e) => e.kind)).toContain('session.error')
    expect(fake.closed).toBe(true)
  })

  it('click/fill emit interaction events; the typed value never enters the audit', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    await service.click(c.canvasId, { kind: 'click', ref: 'e1' }, {})
    await service.fill(c.canvasId, { kind: 'fill', ref: 'e2', value: 'SECRET-VALUE' }, {})
    expect(events.map((e) => e.kind)).toContain('interaction')
    expect(JSON.stringify(events)).not.toContain('SECRET-VALUE')
  })

  it('caps interactions per session (click/fill/annotate share the budget)', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    for (let i = 0; i < 200; i++) {
      await service.click(c.canvasId, { kind: 'click', ref: 'e1' }, {})
    }
    await expect(service.click(c.canvasId, { kind: 'click', ref: 'e1' }, {})).rejects.toThrow(
      /budget/
    )
    // annotate is now charged against the same budget → also rejected when full.
    await expect(
      service.annotate(c.canvasId, [{ ref: 'e1', label: 'x' }], {})
    ).rejects.toThrow(/budget/)
  })

  it('annotate persists an annotation + emits an annotation event', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    const ann = await service.annotate(
      c.canvasId,
      [{ ref: 'e1', label: 'misaligned', severity: 'warn' }],
      {}
    )
    expect(ann.id).toBeTruthy()
    expect(store.listAnnotations(c.canvasId)).toHaveLength(1)
    expect(events.map((e) => e.kind)).toContain('annotation')
  })

  it('scopes sessions by chat — chat B cannot see, read, or close chat A canvas', async () => {
    const a = await service.open({ url: 'http://localhost:3000' }, { chatId: 'A' })
    expect(service.list({ chatId: 'B' })).toHaveLength(0)
    expect(service.status(a.canvasId, { chatId: 'B' })).toBeNull()
    await expect(service.snapshot(a.canvasId, { chatId: 'B' })).rejects.toThrow(/No open canvas/)
    await service.close(a.canvasId, { chatId: 'B' }) // no-op for the wrong chat
    expect(fake.closed).toBe(false)
    // Chat A still owns it.
    expect(service.list({ chatId: 'A' })).toHaveLength(1)
    expect(service.status(a.canvasId, { chatId: 'A' })?.status).toBe('active')
  })
})
