import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CanvasService, type CanvasServiceDeps } from './CanvasService'
import { CanvasStore } from './CanvasStore'
import { createCanvasEvalApprovalReceipt } from './CanvasEvalAudit'
import type {
  CanvasActionInput,
  CanvasActResult,
  CanvasConsoleEntry,
  CanvasDriver,
  CanvasElementDetail,
  CanvasElementTree,
  CanvasEvalResult,
  CanvasEventRecord,
  CanvasFrame,
  CanvasMark,
  CanvasNetworkEntry,
  CanvasOpenInput,
  CanvasSessionHandle,
  CanvasSketchDocument,
  CanvasSketchUpdateInput,
  CanvasViewport
} from './canvasTypes'

const IMAGE_SHA = 'a'.repeat(43)

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class FakeDriver implements CanvasDriver {
  readonly kind = 'web' as const
  opened = false
  closed = false
  failOpen = false
  closeCalls = 0
  closeFailuresRemaining = 0

  async open(input: CanvasOpenInput): Promise<CanvasSessionHandle> {
    if (this.failOpen) throw new Error('boom')
    this.opened = true
    if (input.initialSketchDocument) this.sketchDoc = input.initialSketchDocument
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
    const found = action.ref !== 'missing'
    return {
      ok: found,
      action: action.kind,
      found,
      executed: found,
      verified: found ? 'changed' : 'unknown',
      ...(found ? {} : { refusalReason: 'not_found' as const }),
      ref: action.ref,
      selector: action.selector
    }
  }
  async annotate(marks: CanvasMark[]): Promise<{ count: number }> {
    return { count: marks.length }
  }
  sketchDoc: CanvasSketchDocument = {
    schemaVersion: 1,
    title: 'Sketch Canvas',
    viewport: { width: 1280, height: 800 },
    elements: [],
    updatedAt: 'x'
  }
  async sketchDocument(): Promise<CanvasSketchDocument> {
    return this.sketchDoc
  }
  async sketchUpdate(update: CanvasSketchUpdateInput): Promise<CanvasSketchDocument> {
    this.sketchDoc = {
      ...this.sketchDoc,
      title: update.title || this.sketchDoc.title,
      elements:
        update.mode === 'clear'
          ? []
          : update.mode === 'replace'
            ? update.elements || []
            : [...this.sketchDoc.elements, ...(update.elements || [])],
      updatedAt: 'x2'
    }
    return this.sketchDoc
  }
  lastScript?: string
  evalResult?: CanvasEvalResult
  evalError?: Error
  async evaluate(args: { script: string }): Promise<CanvasEvalResult> {
    this.lastScript = args.script
    if (this.evalError) throw this.evalError
    return (
      this.evalResult || {
        ok: true,
        valueType: 'string',
        value: 'EVAL-RESULT-SENTINEL',
        truncated: false
      }
    )
  }
  reloaded = false
  async reload(): Promise<void> {
    this.reloaded = true
  }
  async close(): Promise<void> {
    this.closeCalls += 1
    if (this.closeFailuresRemaining > 0) {
      this.closeFailuresRemaining -= 1
      throw new Error('close failed')
    }
    this.closed = true
  }
}

describe('CanvasService', () => {
  let dir: string
  let store: CanvasStore
  let fake: FakeDriver
  let events: CanvasEventRecord[]
  let service: CanvasService
  let lastDriverOpts: Parameters<CanvasServiceDeps['createDriver']>[2]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canvas-svc-'))
    store = new CanvasStore(dir)
    fake = new FakeDriver()
    events = []
    lastDriverOpts = undefined
    let seq = 0
    service = new CanvasService({
      createDriver: (_kind, _sessionId, opts) => {
        lastDriverOpts = opts
        if (opts?.initialSketchDocument) fake.sketchDoc = opts.initialSketchDocument
        return fake
      },
      store,
      uuid: () => `id-${++seq}`,
      now: () => '2026-06-21T00:00:00.000Z',
      broadcast: (event) => events.push(event),
      maxInteractionsPerSession: 3,
      maxEvalsPerSession: 3
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
    await expect(service.open({ driver: 'window', url: 'http://localhost:3000' }, {})).rejects.toThrow(
      /not available/
    )
  })

  it('rejects a bad url before spawning a window', async () => {
    await expect(service.open({ url: 'file:///etc/passwd' }, {})).rejects.toThrow()
    expect(fake.opened).toBe(false)
  })

  it('requires canonical chat authority for image canvases and binds it into the driver', async () => {
    const imageInput: CanvasOpenInput = {
      driver: 'image',
      mediaSha256: IMAGE_SHA,
      mediaMimeType: 'image/png'
    }
    await expect(service.open(imageInput, {})).rejects.toThrow(/canonical chat authority/)
    await expect(service.open(imageInput, { chatId: ' chat-a ' })).rejects.toThrow(
      /canonical chat authority/
    )
    expect(fake.opened).toBe(false)
    expect(lastDriverOpts).toBeUndefined()

    const opened = await service.open(imageInput, { chatId: 'chat-a' })
    expect(opened.canvasId).toBeTruthy()
    expect(lastDriverOpts?.appChatId).toBe('chat-a')
    expect(store.getSession(opened.canvasId)?.chatId).toBe('chat-a')
  })

  it('embeds only the surface-hosting drivers (web + sketch), never surface-less ones', async () => {
    await service.open({ url: 'http://localhost:3000', embed: true }, { chatId: 'chat-a' })
    expect(lastDriverOpts?.embedded).toBe(true)

    await service.open({ driver: 'sketch', embed: true }, { chatId: 'chat-a' })
    expect(lastDriverOpts?.embedded).toBe(true)

    // html renders offscreen (no live surface) — the embed flag must not leak in.
    await service.open({ driver: 'html', html: '<p>x</p>', embed: true }, { chatId: 'chat-a' })
    expect(lastDriverOpts?.embedded).toBe(false)
  })

  it('device open requires a valid bundleId, rejected before the driver runs', async () => {
    await expect(service.open({ driver: 'device' }, {})).rejects.toThrow(/bundleId/)
    await expect(service.open({ driver: 'device', bundleId: 'com.x; rm -rf /' }, {})).rejects.toThrow(
      /bundleId/
    )
    expect(fake.opened).toBe(false)
  })

  it('device open routes to the device driver and records the device kind', async () => {
    const opened = await service.open({ driver: 'device', bundleId: 'com.example.App' }, {})
    expect(opened.canvasId).toBeTruthy()
    expect(fake.opened).toBe(true)
    expect(service.status(opened.canvasId, {})?.driver).toBe('device')
  })

  it('sketch open records the sketch driver and sketch updates emit redacted metadata', async () => {
    const opened = await service.open({ driver: 'sketch' }, { provider: 'codex' })
    expect(service.status(opened.canvasId, {})?.driver).toBe('sketch')
    const document = await service.sketchUpdate(
      opened.canvasId,
      {
        mode: 'append',
        elements: [{ kind: 'text', id: 'label1', x: 10, y: 20, text: 'SECRET-LABEL' }]
      },
      { provider: 'codex' }
    )
    expect(document.elements).toHaveLength(1)
    expect(events.map((e) => e.kind)).toContain('sketch.update')
    expect(JSON.stringify(events)).not.toContain('SECRET-LABEL')
  })

  it('rehydrates sketch documents from the same chat scope on the next sketch open', async () => {
    const first = await service.open({ driver: 'sketch' }, { chatId: 'chat-a' })
    await service.sketchUpdate(
      first.canvasId,
      {
        mode: 'append',
        elements: [{ kind: 'text', id: 'saved-label', x: 10, y: 20, text: 'persisted' }]
      },
      { chatId: 'chat-a' }
    )
    await service.close(first.canvasId, { chatId: 'chat-a' })

    fake.sketchDoc = {
      schemaVersion: 1,
      title: 'Sketch Canvas',
      viewport: { width: 1280, height: 800 },
      elements: [],
      updatedAt: 'fresh'
    }
    const second = await service.open({ driver: 'sketch' }, { chatId: 'chat-a' })
    const document = await service.sketchDocument(second.canvasId, { chatId: 'chat-a' })
    expect(document.elements).toMatchObject([{ id: 'saved-label', kind: 'text', text: 'persisted' }])
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

  it('does not publish a live session when active-record persistence fails', async () => {
    const upsert = store.upsertSession.bind(store)
    vi.spyOn(store, 'upsertSession').mockImplementation((record) => {
      if (record.status === 'active') throw new Error('active session fsync failed')
      return upsert(record)
    })

    await expect(service.open({ url: 'http://localhost:3000' }, {})).rejects.toThrow(
      'active session fsync failed'
    )
    expect(fake.closed).toBe(true)
    expect(service.list({})).toEqual([])
    await expect(service.snapshot('id-1', {})).rejects.toThrow(/No open canvas/)
    expect(store.getSession('id-1')?.status).toBe('error')
  })

  it('retires the generation when initial opening-record persistence fails', async () => {
    vi.spyOn(store, 'upsertSession').mockImplementation(() => {
      throw new Error('opening session fsync failed')
    })

    await expect(service.open({ url: 'http://localhost:3000' }, {})).rejects.toThrow(
      'opening session fsync failed'
    )
    expect(fake.opened).toBe(false)
    expect(service.list({})).toEqual([])
    expect(service.openChatIds()).toEqual(new Set())
    await expect(service.snapshot('id-1', {})).rejects.toThrow(/No open canvas/)
  })

  it('retires the generation and replaces opening state when driver construction throws', async () => {
    service = new CanvasService({
      createDriver: () => {
        throw new Error('driver construction failed')
      },
      store,
      uuid: () => 'id-1',
      now: () => '2026-06-21T00:00:00.000Z'
    })

    await expect(service.open({ url: 'http://localhost:3000' }, {})).rejects.toThrow(
      'driver construction failed'
    )
    expect(service.list({})).toEqual([])
    await expect(service.snapshot('id-1', {})).rejects.toThrow(/No open canvas/)
    expect(store.getSession('id-1')?.status).toBe('error')
  })

  it('keeps the active registry coherent when best-effort opened-event sinks throw', async () => {
    vi.spyOn(store, 'appendEvent').mockImplementation(() => {
      throw new Error('event append failed')
    })
    service = new CanvasService({
      createDriver: () => fake,
      store,
      uuid: (() => {
        let seq = 0
        return () => `id-${++seq}`
      })(),
      now: () => '2026-06-21T00:00:00.000Z',
      broadcast: () => {
        throw new Error('renderer disappeared')
      }
    })

    const opened = await service.open({ url: 'http://localhost:3000' }, {})
    expect(service.list({})).toHaveLength(1)
    expect(service.status(opened.canvasId, {})?.status).toBe('active')
    await service.close(opened.canvasId, {})
    expect(service.list({})).toEqual([])
  })

  it('retains a failed-open driver whose cleanup failed so history clear retries it', async () => {
    fake.failOpen = true
    fake.closeFailuresRemaining = 1

    await expect(
      service.open(
        { url: 'http://localhost:3000' },
        { chatId: 'chat-failed-open', workspacePath: '/workspace/a' }
      )
    ).rejects.toThrow('boom')

    expect(fake.closeCalls).toBe(1)
    expect(service.openChatIds()).toContain('chat-failed-open')

    const authority = {
      chatIds: ['chat-failed-open'],
      workspacePaths: ['/workspace/a']
    }
    try {
      await service.beginAuthorityHistoryClear(authority)
    } finally {
      service.endAuthorityHistoryClear(authority)
    }

    expect(fake.closeCalls).toBe(2)
    expect(fake.closed).toBe(true)
    expect(service.openChatIds()).not.toContain('chat-failed-open')
    expect(store.listSessions()).toEqual([])
  })

  it('click/fill emit interaction events; the typed value never enters the audit', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    await service.click(c.canvasId, { kind: 'click', ref: 'e1' }, {})
    await service.fill(c.canvasId, { kind: 'fill', ref: 'e2', value: 'SECRET-VALUE' }, {})
    expect(events.map((e) => e.kind)).toContain('interaction')
    expect(JSON.stringify(events)).not.toContain('SECRET-VALUE')
  })

  it('serializes concurrent interactions so nothing runs between check and dispatch', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    const order: string[] = []
    const firstGate = deferred<void>()
    let calls = 0
    vi.spyOn(fake, 'act').mockImplementation(async (action) => {
      calls += 1
      const tag = String(action.ref)
      order.push(`enter:${tag}`)
      if (calls === 1) await firstGate.promise
      order.push(`exit:${tag}`)
      return {
        ok: true,
        action: action.kind,
        found: true,
        executed: true,
        verified: 'changed' as const
      }
    })

    const first = service.click(c.canvasId, { kind: 'click', ref: 'a' }, {})
    const second = service.click(c.canvasId, { kind: 'click', ref: 'b' }, {})
    await Promise.resolve()
    await Promise.resolve()
    // The second interaction must not have touched the page yet.
    expect(order).toEqual(['enter:a'])

    firstGate.resolve(undefined)
    await Promise.all([first, second])
    expect(order).toEqual(['enter:a', 'exit:a', 'enter:b', 'exit:b'])
  })

  it('refuses to touch the page once a history clear is in flight', async () => {
    // The pre-flight half of the audit reorder: an interaction that arrives
    // while a clear is in progress must never reach the driver at all.
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    const actSpy = vi.spyOn(fake, 'act')
    const clearing = service.beginHistoryClear()

    await expect(service.click(c.canvasId, { kind: 'click', ref: 'e1' }, {})).rejects.toThrow(
      /history (is being|was) cleared/
    )
    expect(actSpy).not.toHaveBeenCalled()

    await clearing
    service.endHistoryClear()
  })

  it('caps interactions per session (click/fill/annotate share the budget)', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    for (let i = 0; i < 3; i++) {
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

  it('eval persists approval-bound pre/post receipts — never the script text or result', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    const script = 'document.cookie + "SECRET-SCRIPT"'
    const approval = createCanvasEvalApprovalReceipt(script, 'approval-1')
    const res = await service.evaluate(
      c.canvasId,
      { script },
      { canvasEvalApproval: approval }
    )
    expect(res.ok).toBe(true)
    // The driver did receive the real script…
    expect(fake.lastScript).toContain('SECRET-SCRIPT')
    const evalEvents = events.filter((event) => event.kind.startsWith('eval.'))
    expect(evalEvents.map((event) => event.kind)).toEqual(['eval.started', 'eval.completed'])
    expect(evalEvents[0]).toMatchObject({
      approvalId: 'approval-1',
      detail: {
        approvalId: 'approval-1',
        scriptHash: approval.scriptHash,
        scriptLength: script.length,
        scriptByteLength: Buffer.byteLength(script, 'utf8')
      }
    })
    expect(evalEvents[1]).toMatchObject({
      approvalId: 'approval-1',
      detail: { outcome: 'success', ok: true }
    })
    // …but neither the script text NOR the returned value ever enters the audit.
    expect(JSON.stringify(events)).not.toContain('SECRET-SCRIPT')
    expect(JSON.stringify(events)).not.toContain('EVAL-RESULT-SENTINEL')
    const reopened = new CanvasStore(dir).listEvents(c.canvasId).filter((event) =>
      event.kind.startsWith('eval.')
    )
    expect(reopened).toHaveLength(2)
    expect(JSON.stringify(reopened)).not.toContain('SECRET-SCRIPT')
    expect(JSON.stringify(reopened)).not.toContain('EVAL-RESULT-SENTINEL')
  })

  it('records script and host failure outcomes without persisting error text', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    const scriptErrorScript = 'throw new Error("SCRIPT-ERROR-SECRET")'
    fake.evalResult = { ok: false, error: 'SCRIPT-ERROR-SECRET' }
    await service.evaluate(c.canvasId, { script: scriptErrorScript }, {
      canvasEvalApproval: createCanvasEvalApprovalReceipt(scriptErrorScript, 'approval-script-error')
    })

    const hostErrorScript = 'location.reload()'
    fake.evalResult = undefined
    fake.evalError = new Error('HOST-ERROR-SECRET')
    await expect(
      service.evaluate(c.canvasId, { script: hostErrorScript }, {
        canvasEvalApproval: createCanvasEvalApprovalReceipt(hostErrorScript, 'approval-host-error')
      })
    ).rejects.toThrow('HOST-ERROR-SECRET')

    const completed = events.filter((event) => event.kind === 'eval.completed')
    expect(completed.map((event) => event.detail?.outcome)).toEqual([
      'script_error',
      'host_error'
    ])
    expect(JSON.stringify(events)).not.toContain('SCRIPT-ERROR-SECRET')
    expect(JSON.stringify(events)).not.toContain('HOST-ERROR-SECRET')
  })

  it('fails closed before driver execution when the receipt is absent, mismatched, or cannot persist', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    await expect(service.evaluate(c.canvasId, { script: '1' }, {})).rejects.toThrow(
      /bound approval receipt/
    )
    await expect(
      service.evaluate(c.canvasId, { script: '2' }, {
        canvasEvalApproval: createCanvasEvalApprovalReceipt('different', 'approval-mismatch')
      })
    ).rejects.toThrow(/does not match/)
    expect(fake.lastScript).toBeUndefined()

    vi.spyOn(store, 'appendEventStrict').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    await expect(
      service.evaluate(c.canvasId, { script: '3' }, {
        canvasEvalApproval: createCanvasEvalApprovalReceipt('3', 'approval-disk-full')
      })
    ).rejects.toThrow(/blocked.*pre-execution audit receipt/)
    expect(fake.lastScript).toBeUndefined()
  })

  it.each(['resolve', 'reject'] as const)(
    'purgeHistory fences a deferred eval that later %ss from recreating files or events',
    async (outcome) => {
      const c = await service.open({ url: 'http://localhost:3000' }, {})
      const script = 'globalThis.__late_canvas_eval = "PURGE-SENTINEL"'
      const evaluationGate = deferred<CanvasEvalResult>()
      vi.spyOn(fake, 'evaluate').mockImplementationOnce(() => evaluationGate.promise)

      const evaluation = service.evaluate(c.canvasId, { script }, {
        canvasEvalApproval: createCanvasEvalApprovalReceipt(script, 'approval-late-eval')
      })
      expect(store.listEvents(c.canvasId).map((event) => event.kind)).toContain('eval.started')

      await service.purgeHistory()
      expect(existsSync(dir)).toBe(true)
      expect(store.listSessions()).toEqual([])
      expect(store.listEvents()).toEqual([])
      const broadcastCountAfterPurge = events.length

      if (outcome === 'resolve') {
        evaluationGate.resolve({ ok: true, valueType: 'undefined', truncated: false })
      } else {
        evaluationGate.reject(new Error('PURGE-SENTINEL-HOST-ERROR'))
      }

      await expect(evaluation).rejects.toThrow(/discarded because history was cleared/)
      expect(store.listEvents()).toEqual([])
      expect(events).toHaveLength(broadcastCountAfterPurge)
    }
  )

  it('purgeHistory fences an open that began in the retired generation', async () => {
    const openGate = deferred<CanvasSessionHandle>()
    vi.spyOn(fake, 'open').mockImplementationOnce(() => openGate.promise)

    const opening = service.open({ url: 'http://localhost:3000' }, {})
    expect(store.listSessions()).toHaveLength(1)

    const purge = service.purgeHistory()
    const openingRejected = expect(opening).rejects.toThrow(/history was cleared/)
    openGate.resolve({
      url: 'http://localhost:3000',
      title: 'Late open',
      viewport: { width: 1280, height: 800 }
    })
    await openingRejected
    await purge
    const broadcastCountAfterPurge = events.length
    expect(fake.closed).toBe(true)
    expect(existsSync(dir)).toBe(true)
    expect(store.listSessions()).toEqual([])
    expect(store.listEvents()).toEqual([])
    expect(events).toHaveLength(broadcastCountAfterPurge)
  })

  it('purgeHistory fences deferred direct writes from resize, annotate, and sketch update', async () => {
    const c = await service.open({ driver: 'sketch' }, {})
    const resizeGate = deferred<CanvasViewport>()
    const annotateGate = deferred<{ count: number }>()
    const sketchGate = deferred<CanvasSketchDocument>()
    vi.spyOn(fake, 'resize').mockImplementationOnce(() => resizeGate.promise)
    vi.spyOn(fake, 'annotate').mockImplementationOnce(() => annotateGate.promise)
    vi.spyOn(fake, 'sketchUpdate').mockImplementationOnce(() => sketchGate.promise)

    const resizing = service.resize(c.canvasId, { width: 900, height: 600 }, {})
    const annotating = service.annotate(c.canvasId, [{ ref: 'e1', label: 'late' }], {})
    const sketching = service.sketchUpdate(c.canvasId, { mode: 'clear' }, {})

    await service.purgeHistory()
    expect(existsSync(dir)).toBe(true)
    expect(store.listSessions()).toEqual([])
    expect(store.listEvents()).toEqual([])
    const broadcastCountAfterPurge = events.length
    // annotate and sketchUpdate now enter through the per-canvas interaction
    // lock, which costs them a microtask — long enough for purgeHistory's
    // synchronous prefix to raise the clear flag. They are therefore fenced
    // EARLIER than before, by their own `require` on the way in, instead of by
    // the post-await liveness assert once the driver had already run. Both
    // messages are fences and neither write reaches the store, so accept either:
    // the invariant under test is that deferred writes are discarded, not which
    // fence caught them. resize is not serialized and still takes the old path.
    const discarded = [
      expect(resizing).rejects.toThrow(/history was cleared/),
      expect(annotating).rejects.toThrow(/history (was cleared|is being cleared)/),
      expect(sketching).rejects.toThrow(/history (was cleared|is being cleared)/)
    ]

    resizeGate.resolve({ width: 900, height: 600 })
    annotateGate.resolve({ count: 1 })
    sketchGate.resolve({
      schemaVersion: 1,
      title: 'Late sketch',
      viewport: { width: 1280, height: 800 },
      elements: [],
      updatedAt: 'late'
    })
    await Promise.all(discarded)

    expect(store.listEvents()).toEqual([])
    expect(store.getSketchDocument('global')).toBeNull()
    expect(events).toHaveLength(broadcastCountAfterPurge)
  })

  it('rejects canvas_open during an in-flight purge and preserves a new post-purge canvas', async () => {
    await service.open({ driver: 'sketch' }, {})
    const staleSketchCallback = lastDriverOpts?.onSketchDocumentChange
    expect(staleSketchCallback).toBeTypeOf('function')
    const closeGate = deferred<void>()
    vi.spyOn(fake, 'close').mockImplementationOnce(() => closeGate.promise)

    const purge = service.purgeHistory()
    const concurrentPurge = service.purgeHistory()
    await expect(service.open({ url: 'http://localhost:3000/during-purge' }, {})).rejects.toThrow(
      /history is being cleared/
    )

    closeGate.resolve()
    await Promise.all([purge, concurrentPurge])
    expect(existsSync(dir)).toBe(true)
    expect(store.listSessions()).toEqual([])
    expect(store.listEvents()).toEqual([])

    const fresh = await service.open({ url: 'http://localhost:3000/fresh' }, {})
    staleSketchCallback?.({
      schemaVersion: 1,
      title: 'Stale callback',
      viewport: { width: 1280, height: 800 },
      elements: [{ kind: 'text', text: 'MUST-NOT-PERSIST' }],
      updatedAt: 'late'
    })
    expect(store.listSessions()).toMatchObject([
      { id: fresh.canvasId, status: 'active', url: 'http://localhost:3000/fresh' }
    ])
    expect(store.listEvents().map((event) => event.canvasId)).toEqual([fresh.canvasId])
    expect(store.getSketchDocument('global')).toBeNull()

    // Both callers observed the same completed purge; no delayed cleanup may
    // race this new generation and delete its newly persisted records.
    await Promise.resolve()
    expect(store.getSession(fresh.canvasId)?.status).toBe('active')
    expect(store.listEvents(fresh.canvasId).map((event) => event.kind)).toEqual(['session.opened'])
  })

  it('caps eval per session with its own (separate) budget', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    for (let i = 0; i < 3; i++) {
      await service.evaluate(c.canvasId, { script: '1' }, {
        canvasEvalApproval: createCanvasEvalApprovalReceipt('1', `approval-${i}`)
      })
    }
    await expect(
      service.evaluate(c.canvasId, { script: '1' }, {
        canvasEvalApproval: createCanvasEvalApprovalReceipt('1', 'approval-over-budget')
      })
    ).rejects.toThrow(/budget/)
  })

  it('reload re-navigates the driver and emits a reload event (chat-scoped)', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, { chatId: 'A' })
    await service.reload(c.canvasId, { chatId: 'A' })
    expect(fake.reloaded).toBe(true)
    expect(events.map((e) => e.kind)).toContain('reload')
    // A different chat cannot reload it.
    fake.reloaded = false
    await expect(service.reload(c.canvasId, { chatId: 'B' })).rejects.toThrow(/No open canvas/)
    expect(fake.reloaded).toBe(false)
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

  it('a chat-only history clear preserves sibling Canvas state in the same workspace', async () => {
    const a = await service.open(
      { url: 'http://localhost:3000/a' },
      { chatId: 'A', workspacePath: '/shared-workspace' }
    )
    const b = await service.open(
      { url: 'http://localhost:3000/b' },
      { chatId: 'B', workspacePath: '/shared-workspace' }
    )
    const authority = { chatIds: ['A'] }

    try {
      await service.beginAuthorityHistoryClear(authority)
    } finally {
      service.endAuthorityHistoryClear(authority)
    }

    expect(service.status(a.canvasId, { chatId: 'A' })).toBeNull()
    expect(service.status(b.canvasId, { chatId: 'B' })?.status).toBe('active')
    expect(store.getSession(a.canvasId)).toBeNull()
    expect(store.getSession(b.canvasId)?.chatId).toBe('B')
    expect(store.listEvents(a.canvasId)).toEqual([])
    expect(store.listEvents(b.canvasId).map((entry) => entry.kind)).toContain('session.opened')
  })
})
