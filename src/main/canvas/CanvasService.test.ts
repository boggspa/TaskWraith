import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CanvasService,
  type CanvasConsequentialConfirmRequest,
  type CanvasServiceDeps
} from './CanvasService'
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
  CanvasNavigateInput,
  CanvasNavState,
  CanvasNetworkEntry,
  CanvasOpenInput,
  CanvasSessionHandle,
  CanvasSketchDocument,
  CanvasSketchUpdateInput,
  CanvasTargetDescription,
  CanvasViewport
} from './canvasTypes'
import { AppDriveLeaseRegistry } from '../appDrive/AppDriveLease'

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
  lastOpenInput?: CanvasOpenInput

  async open(input: CanvasOpenInput): Promise<CanvasSessionHandle> {
    if (this.failOpen) throw new Error('boom')
    this.opened = true
    this.lastOpenInput = input
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
  targetLabel: string | null = null
  targetInputEpoch = 0
  lastAction?: CanvasActionInput
  describeTarget?: (action: CanvasActionInput) => Promise<CanvasTargetDescription> = async (
    action
  ) => ({
    found: action.ref !== 'missing',
    label: this.targetLabel,
    inputEpoch: this.targetInputEpoch
  })
  async act(action: CanvasActionInput): Promise<CanvasActResult> {
    this.lastAction = action
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
  currentNav: CanvasNavState = {
    url: 'http://localhost:3000/?token=secret',
    title: 'Fake',
    isLoading: false,
    canGoBack: false,
    canGoForward: false
  }
  navigateCalls: CanvasNavigateInput[] = []
  async navigate(input: CanvasNavigateInput): Promise<CanvasNavState> {
    this.navigateCalls.push(input)
    if (input.url) {
      this.currentNav = { ...this.currentNav, url: input.url, canGoBack: true }
    } else if (input.action === 'back') {
      this.currentNav = { ...this.currentNav, canGoBack: false, canGoForward: true }
    }
    return this.currentNav
  }
  navState(): CanvasNavState {
    return this.currentNav
  }
  chartDocument() {
    return this.lastOpenInput?.chartDocument ?? null
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
    await expect(service.open({ driver: 'future-driver' as never }, {})).rejects.toThrow(
      /not available/
    )
  })

  it('enables the window driver only for an internal target and canonical chat+run', async () => {
    await expect(
      service.open({ driver: 'window', windowTarget: { leaseId: 'lease-1' } }, { chatId: 'chat-a' })
    ).rejects.toThrow(/canonical chat and run/)
    await expect(
      service.open(
        { driver: 'window', windowTarget: { leaseId: 'lease-1' } },
        { chatId: ' chat-a ', runId: 'run-a' }
      )
    ).rejects.toThrow(/canonical chat and run/)
    await expect(
      service.open({ driver: 'window' }, { chatId: 'chat-a', runId: 'run-a' })
    ).rejects.toThrow(/internal native-window lease target/)
    expect(fake.opened).toBe(false)
    expect(lastDriverOpts).toBeUndefined()
  })

  it('passes only the opaque window target to the factory and persists a digest URL', async () => {
    const leaseId = 'private-main-owned-lease'
    const opened = await service.open(
      {
        driver: 'window',
        windowTarget: { leaseId, extra: 'must-be-dropped' } as never
      },
      { chatId: 'chat-a', runId: 'run-a' }
    )

    expect(lastDriverOpts?.windowTarget).toEqual({ leaseId })
    expect(Object.isFrozen(lastDriverOpts?.windowTarget)).toBe(true)
    expect(fake.lastOpenInput).toEqual({
      driver: 'window',
      viewport: { width: 1280, height: 800 }
    })
    expect(JSON.stringify(fake.lastOpenInput)).not.toContain(leaseId)
    expect(opened.url).toMatch(/^window:\/\/managed\/[a-f0-9]{20}$/)
    expect(opened.url).not.toContain(leaseId)
    expect(store.getSession(opened.canvasId)).toMatchObject({
      driver: 'window',
      url: opened.url,
      chatId: 'chat-a',
      runId: 'run-a'
    })
    expect(JSON.stringify(store.listEvents(opened.canvasId))).not.toContain(leaseId)
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
    const rendererWeb = await service.open(
      { url: 'http://localhost:3000', embed: true },
      { chatId: 'chat-a' }
    )
    expect(lastDriverOpts?.embedded).toBe(true)
    expect(service.status(rendererWeb.canvasId, { chatId: 'chat-a' })?.presentation).toBeUndefined()
    expect(
      events.find(
        (event) => event.canvasId === rendererWeb.canvasId && event.kind === 'session.opened'
      )
    ).not.toHaveProperty('detail.presentation')

    const web = await service.open(
      { url: 'http://localhost:3000', embed: true, presentation: 'dock' },
      { chatId: 'chat-a' }
    )
    expect(lastDriverOpts?.embedded).toBe(true)
    expect(service.status(web.canvasId, { chatId: 'chat-a' })?.presentation).toBe('dock')
    expect(
      events.find((event) => event.canvasId === web.canvasId && event.kind === 'session.opened')
    ).toMatchObject({ detail: { presentation: 'dock' } })

    await service.open({ driver: 'sketch', embed: true }, { chatId: 'chat-a' })
    expect(lastDriverOpts?.embedded).toBe(true)

    // html renders offscreen (no live surface) — the embed flag must not leak in.
    await service.open({ driver: 'html', html: '<p>x</p>', embed: true }, { chatId: 'chat-a' })
    expect(lastDriverOpts?.embedded).toBe(false)
  })

  it('chart docks via presentation:"dock" without WebContentsView embed', async () => {
    const chartDocument = {
      schemaVersion: 1 as const,
      title: 'Latency',
      kind: 'line' as const,
      series: [
        {
          id: 'p50',
          label: 'p50',
          points: [
            { x: 0, y: 10 },
            { x: 1, y: 12 }
          ]
        }
      ]
    }
    const chart = await service.open(
      { driver: 'chart', chartDocument, presentation: 'dock' },
      { chatId: 'chat-a' }
    )
    // Chart is a native dock surface — never a WebContentsView embed.
    expect(lastDriverOpts?.embedded).toBe(false)
    expect(service.status(chart.canvasId, { chatId: 'chat-a' })?.presentation).toBe('dock')
    expect(service.status(chart.canvasId, { chatId: 'chat-a' })?.driver).toBe('chart')
    // Dock TelemetryPane paints from list/status chartDocument — must be attached.
    expect(service.status(chart.canvasId, { chatId: 'chat-a' })?.chartDocument).toEqual(
      chartDocument
    )
    expect(
      service.list({ chatId: 'chat-a' }).find((row) => row.canvasId === chart.canvasId)
        ?.chartDocument
    ).toEqual(chartDocument)
    expect(
      events.find((event) => event.canvasId === chart.canvasId && event.kind === 'session.opened')
    ).toMatchObject({ detail: { presentation: 'dock', driver: 'chart' } })

    // Without presentation:"dock", chart must not claim dock focus.
    const undocked = await service.open({ driver: 'chart', chartDocument }, { chatId: 'chat-a' })
    expect(service.status(undocked.canvasId, { chatId: 'chat-a' })?.presentation).toBeUndefined()
    expect(service.status(undocked.canvasId, { chatId: 'chat-a' })?.driver).toBe('chart')
    expect(service.status(undocked.canvasId, { chatId: 'chat-a' })?.chartDocument).toEqual(
      chartDocument
    )
    expect(service.getChartDocument(chart.canvasId, { chatId: 'chat-a' })).toEqual(chartDocument)
    expect(service.getChartDocument(chart.canvasId, { chatId: 'chat-b' })).toBeNull()
    expect(service.getChartDocument('missing', { chatId: 'chat-a' })).toBeNull()
  })

  it('device open requires canonical chat+run and a valid bundleId before the driver runs', async () => {
    await expect(
      service.open({ driver: 'device', bundleId: 'com.example.App' }, {})
    ).rejects.toThrow(/canonical chat and run/)
    await expect(
      service.open({ driver: 'device' }, { chatId: 'chat-a', runId: 'run-a' })
    ).rejects.toThrow(/bundleId/)
    await expect(
      service.open(
        { driver: 'device', bundleId: 'com.x; rm -rf /' },
        { chatId: 'chat-a', runId: 'run-a' }
      )
    ).rejects.toThrow(/bundleId/)
    expect(fake.opened).toBe(false)
  })

  it('device open routes to the device driver with chat/run authority and records the device kind', async () => {
    const opened = await service.open(
      { driver: 'device', bundleId: 'com.example.App' },
      { chatId: 'chat-a', runId: 'run-a' }
    )
    expect(opened.canvasId).toBeTruthy()
    expect(fake.opened).toBe(true)
    expect(lastDriverOpts?.appChatId).toBe('chat-a')
    expect(lastDriverOpts?.appRunId).toBe('run-a')
    expect(service.status(opened.canvasId, { chatId: 'chat-a', runId: 'run-a' })?.driver).toBe(
      'device'
    )
  })

  it('device open forwards ensemble ownerParticipantId into createDriver opts', async () => {
    await service.open(
      { driver: 'device', bundleId: 'com.example.App' },
      { chatId: 'chat-a', runId: 'run-a', participantId: 'seat-boss' }
    )
    expect(lastDriverOpts?.appChatId).toBe('chat-a')
    expect(lastDriverOpts?.appRunId).toBe('run-a')
    expect(lastDriverOpts?.ownerParticipantId).toBe('seat-boss')
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
    expect(document.elements).toMatchObject([
      { id: 'saved-label', kind: 'text', text: 'persisted' }
    ])
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

  it('clears the Browser profile only after closing every web surface', async () => {
    const drivers: Array<{ kind: string; driver: FakeDriver }> = []
    const clearBrowserProfileData = vi.fn(async () => {
      expect(
        drivers.filter(({ kind }) => kind === 'web').every(({ driver }) => driver.closed)
      ).toBe(true)
    })
    let seq = 0
    service = new CanvasService({
      createDriver: (kind) => {
        const driver = new FakeDriver()
        drivers.push({ kind, driver })
        return driver
      },
      store,
      uuid: () => `profile-${++seq}`,
      now: () => '2026-06-21T00:00:00.000Z',
      clearBrowserProfileData
    })

    const firstWeb = await service.open({ driver: 'web', url: 'https://example.com' }, {})
    const sketch = await service.open({ driver: 'sketch' }, {})
    const secondWeb = await service.open({ driver: 'web', url: 'https://example.org' }, {})

    await expect(service.clearBrowserProfile()).resolves.toEqual({
      closedCanvasIds: [firstWeb.canvasId, secondWeb.canvasId],
      closedSurfaceCount: 2
    })
    expect(clearBrowserProfileData).toHaveBeenCalledTimes(1)
    expect(drivers.filter(({ kind }) => kind === 'web').every(({ driver }) => driver.closed)).toBe(
      true
    )
    expect(drivers.find(({ kind }) => kind === 'sketch')?.driver.closed).toBe(false)
    expect(service.list({}).map((entry) => entry.canvasId)).toEqual([sketch.canvasId])
    expect(store.getSession(firstWeb.canvasId)?.status).toBe('closed')
    expect(store.getSession(secondWeb.canvasId)?.status).toBe('closed')
    expect(store.getSession(sketch.canvasId)?.status).toBe('active')
  })

  it('shares concurrent Browser-profile resets and fences only new web opens', async () => {
    const clearGate = deferred<void>()
    const clearBrowserProfileData = vi.fn(() => clearGate.promise)
    let seq = 0
    service = new CanvasService({
      createDriver: () => new FakeDriver(),
      store,
      uuid: () => `profile-fence-${++seq}`,
      now: () => '2026-06-21T00:00:00.000Z',
      clearBrowserProfileData
    })
    await service.open({ driver: 'web', url: 'https://example.com' }, {})

    const firstReset = service.clearBrowserProfile()
    const secondReset = service.clearBrowserProfile()
    await vi.waitFor(() => expect(clearBrowserProfileData).toHaveBeenCalledTimes(1))

    await expect(service.open({ driver: 'web', url: 'https://example.org' }, {})).rejects.toThrow(
      /data is being cleared/
    )
    await expect(service.open({ driver: 'sketch' }, {})).resolves.toMatchObject({
      url: 'http://localhost:3000'
    })

    clearGate.resolve(undefined)
    await expect(Promise.all([firstReset, secondReset])).resolves.toEqual([
      { closedCanvasIds: ['profile-fence-1'], closedSurfaceCount: 1 },
      { closedCanvasIds: ['profile-fence-1'], closedSurfaceCount: 1 }
    ])
    await expect(
      service.open({ driver: 'web', url: 'https://example.net' }, {})
    ).resolves.toMatchObject({ url: 'https://example.net' })
  })

  it('does not clear profile data when a web surface cannot be contained', async () => {
    const failingDriver = new FakeDriver()
    failingDriver.closeFailuresRemaining = 1
    const clearBrowserProfileData = vi.fn(async () => {})
    let seq = 0
    service = new CanvasService({
      createDriver: () => failingDriver,
      store,
      uuid: () => `profile-failure-${++seq}`,
      now: () => '2026-06-21T00:00:00.000Z',
      clearBrowserProfileData
    })
    await service.open({ driver: 'web', url: 'https://example.com' }, {})

    await expect(service.clearBrowserProfile()).rejects.toThrow(/browsing data was not cleared/)
    expect(clearBrowserProfileData).not.toHaveBeenCalled()

    await expect(service.clearBrowserProfile()).resolves.toMatchObject({
      closedCanvasIds: ['profile-failure-1'],
      closedSurfaceCount: 1
    })
    expect(clearBrowserProfileData).toHaveBeenCalledTimes(1)
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

  it('emits each interaction intent before dispatch; typed values never enter the audit', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    const dispatches: string[] = []
    vi.spyOn(fake, 'act').mockImplementation(async (action) => {
      const intents = store
        .listEvents(c.canvasId)
        .filter((event) => event.kind === 'interaction' && event.detail?.phase === 'intent')
      expect(intents.at(-1)?.detail).toMatchObject({
        phase: 'intent',
        action: action.kind,
        targetKind: action.ref ? 'ref' : action.selector ? 'selector' : 'none'
      })
      dispatches.push(action.kind)
      return {
        ok: true,
        action: action.kind,
        found: true,
        executed: true,
        verified: 'changed'
      }
    })

    await service.click(c.canvasId, { kind: 'click', ref: 'e1' }, {})
    await service.fill(c.canvasId, { kind: 'fill', ref: 'e2', value: 'SECRET-VALUE' }, {})

    const interactions = events.filter((event) => event.kind === 'interaction')
    expect(dispatches).toEqual(['click', 'fill'])
    expect(interactions.map((event) => event.detail?.phase)).toEqual(['intent', 'intent'])
    expect(JSON.stringify(events)).not.toContain('SECRET-VALUE')
  })

  it('adds an outcome audit only when dispatch is refused or unverified', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    vi.spyOn(fake, 'act').mockResolvedValue({
      ok: true,
      action: 'click',
      found: true,
      executed: true,
      verified: 'unchanged'
    })

    await service.click(c.canvasId, { kind: 'click', ref: 'e1' }, {})

    const interactions = events.filter((event) => event.kind === 'interaction')
    expect(interactions.map((event) => event.detail?.phase)).toEqual(['intent', 'outcome'])
    expect(interactions[1]?.detail).toMatchObject({
      action: 'click',
      executed: true,
      verified: 'unchanged'
    })
  })

  it('retains intent and records an unknown-dispatch outcome when the driver throws', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    vi.spyOn(fake, 'act').mockRejectedValue(new Error('driver failed'))

    await expect(service.click(c.canvasId, { kind: 'click', ref: 'e1' }, {})).rejects.toThrow(
      'driver failed'
    )

    const interactions = events.filter((event) => event.kind === 'interaction')
    expect(interactions.map((event) => event.detail?.phase)).toEqual(['intent', 'outcome'])
    expect(interactions[1]?.detail).toMatchObject({
      outcome: 'driver_error',
      dispatchStatus: 'unknown',
      verified: 'unknown'
    })
  })

  it('blocks native-window actuation when its strict intent cannot persist', async () => {
    const c = await service.open(
      { driver: 'window', windowTarget: { leaseId: 'lease-strict-audit' } },
      { chatId: 'chat-a', runId: 'run-a' }
    )
    const act = vi.spyOn(fake, 'act')
    vi.spyOn(store, 'appendEventStrict').mockImplementation(() => {
      throw new Error('disk unavailable')
    })

    await expect(
      service.fill(
        c.canvasId,
        { kind: 'fill', ref: 'ax2', value: 'SECRET-VALUE' },
        { chatId: 'chat-a', runId: 'run-a' }
      )
    ).rejects.toThrow(/blocked.*pre-dispatch audit intent/)

    expect(act).not.toHaveBeenCalled()
    expect(JSON.stringify(events)).not.toContain('SECRET-VALUE')
    expect(JSON.stringify(store.listEvents(c.canvasId))).not.toContain('SECRET-VALUE')
  })

  it('records exact native observation preconditions in the strict intent without the fill value', async () => {
    const c = await service.open(
      { driver: 'window', windowTarget: { leaseId: 'lease-audit-preconditions' } },
      { chatId: 'chat-a', runId: 'run-a' }
    )

    await service.fill(
      c.canvasId,
      {
        kind: 'fill',
        ref: 'ax2',
        value: 'SECRET-VALUE',
        expectedObservationId: 'observation-42',
        expectedInputEpoch: 9
      },
      { chatId: 'chat-a', runId: 'run-a' }
    )

    const intent = store
      .listEvents(c.canvasId)
      .find((event) => event.kind === 'interaction' && event.detail?.phase === 'intent')
    expect(intent?.detail).toMatchObject({
      action: 'fill',
      expectedObservationId: 'observation-42',
      expectedInputEpoch: 9
    })
    expect(JSON.stringify(intent)).not.toContain('SECRET-VALUE')
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
    // Wait for the invariant's precondition rather than a fixed number of
    // microtasks: the pre-dispatch path legitimately awaits (target probe,
    // audit), and counting ticks tests the implementation's shape instead of
    // its guarantee. This still fails loudly if serialization breaks.
    await vi.waitFor(() => expect(order).toContain('enter:a'))
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

  it('carries scoped and global clears through registered durable history participants', async () => {
    const calls: string[] = []
    const participant = {
      beginAuthorityHistoryClear: vi.fn(async () => {
        calls.push('scoped-begin')
      }),
      endAuthorityHistoryClear: vi.fn(() => {
        calls.push('scoped-end')
      }),
      beginHistoryClear: vi.fn(async () => {
        calls.push('global-begin')
      }),
      endHistoryClear: vi.fn(() => {
        calls.push('global-end')
      })
    }
    service = new CanvasService({
      createDriver: () => fake,
      store,
      uuid: () => 'participant-canvas',
      now: () => '2026-06-21T00:00:00.000Z',
      historyParticipants: [participant]
    })
    const authority = { chatIds: ['chat-a'], workspacePaths: ['/workspace/a'] }
    try {
      await service.beginAuthorityHistoryClear(authority)
    } finally {
      service.endAuthorityHistoryClear(authority)
    }
    try {
      await service.beginHistoryClear()
    } finally {
      service.endHistoryClear()
    }
    expect(calls).toEqual(['scoped-begin', 'scoped-end', 'global-begin', 'global-end'])
    expect(participant.beginAuthorityHistoryClear).toHaveBeenCalledWith({
      chatIds: new Set(['chat-a']),
      workspacePaths: new Set(['/workspace/a'])
    })
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
    await expect(service.annotate(c.canvasId, [{ ref: 'e1', label: 'x' }], {})).rejects.toThrow(
      /budget/
    )
  })

  it('eval persists approval-bound pre/post receipts — never the script text or result', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    const script = 'document.cookie + "SECRET-SCRIPT"'
    const approval = createCanvasEvalApprovalReceipt(script, 'approval-1')
    const res = await service.evaluate(c.canvasId, { script }, { canvasEvalApproval: approval })
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
    const reopened = new CanvasStore(dir)
      .listEvents(c.canvasId)
      .filter((event) => event.kind.startsWith('eval.'))
    expect(reopened).toHaveLength(2)
    expect(JSON.stringify(reopened)).not.toContain('SECRET-SCRIPT')
    expect(JSON.stringify(reopened)).not.toContain('EVAL-RESULT-SENTINEL')
  })

  it('records script and host failure outcomes without persisting error text', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    const scriptErrorScript = 'throw new Error("SCRIPT-ERROR-SECRET")'
    fake.evalResult = { ok: false, error: 'SCRIPT-ERROR-SECRET' }
    await service.evaluate(
      c.canvasId,
      { script: scriptErrorScript },
      {
        canvasEvalApproval: createCanvasEvalApprovalReceipt(
          scriptErrorScript,
          'approval-script-error'
        )
      }
    )

    const hostErrorScript = 'location.reload()'
    fake.evalResult = undefined
    fake.evalError = new Error('HOST-ERROR-SECRET')
    await expect(
      service.evaluate(
        c.canvasId,
        { script: hostErrorScript },
        {
          canvasEvalApproval: createCanvasEvalApprovalReceipt(
            hostErrorScript,
            'approval-host-error'
          )
        }
      )
    ).rejects.toThrow('HOST-ERROR-SECRET')

    const completed = events.filter((event) => event.kind === 'eval.completed')
    expect(completed.map((event) => event.detail?.outcome)).toEqual(['script_error', 'host_error'])
    expect(JSON.stringify(events)).not.toContain('SCRIPT-ERROR-SECRET')
    expect(JSON.stringify(events)).not.toContain('HOST-ERROR-SECRET')
  })

  it('fails closed before driver execution when the receipt is absent, mismatched, or cannot persist', async () => {
    const c = await service.open({ url: 'http://localhost:3000' }, {})
    await expect(service.evaluate(c.canvasId, { script: '1' }, {})).rejects.toThrow(
      /bound approval receipt/
    )
    await expect(
      service.evaluate(
        c.canvasId,
        { script: '2' },
        {
          canvasEvalApproval: createCanvasEvalApprovalReceipt('different', 'approval-mismatch')
        }
      )
    ).rejects.toThrow(/does not match/)
    expect(fake.lastScript).toBeUndefined()

    vi.spyOn(store, 'appendEventStrict').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    await expect(
      service.evaluate(
        c.canvasId,
        { script: '3' },
        {
          canvasEvalApproval: createCanvasEvalApprovalReceipt('3', 'approval-disk-full')
        }
      )
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

      const evaluation = service.evaluate(
        c.canvasId,
        { script },
        {
          canvasEvalApproval: createCanvasEvalApprovalReceipt(script, 'approval-late-eval')
        }
      )
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
      await service.evaluate(
        c.canvasId,
        { script: '1' },
        {
          canvasEvalApproval: createCanvasEvalApprovalReceipt('1', `approval-${i}`)
        }
      )
    }
    await expect(
      service.evaluate(
        c.canvasId,
        { script: '1' },
        {
          canvasEvalApproval: createCanvasEvalApprovalReceipt('1', 'approval-over-budget')
        }
      )
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

  it('scopes native windows to exact chat+run while existing drivers remain chat-only', async () => {
    const windowCanvas = await service.open(
      { driver: 'window', windowTarget: { leaseId: 'lease-run-a' } },
      { chatId: 'A', runId: 'run-a' }
    )

    expect(service.list({ chatId: 'A', runId: 'run-b' })).toEqual([])
    expect(service.status(windowCanvas.canvasId, { chatId: 'A', runId: 'run-b' })).toBeNull()
    await expect(
      service.snapshot(windowCanvas.canvasId, { chatId: 'A', runId: 'run-b' })
    ).rejects.toThrow(/No open canvas/)
    await service.close(windowCanvas.canvasId, { chatId: 'A', runId: 'run-b' })
    expect(fake.closed).toBe(false)
    expect(service.status(windowCanvas.canvasId, { chatId: 'A', runId: 'run-a' })?.driver).toBe(
      'window'
    )

    const webCanvas = await service.open(
      { url: 'http://localhost:3000/run-compatible' },
      { chatId: 'A', runId: 'run-a' }
    )
    expect(service.status(webCanvas.canvasId, { chatId: 'A', runId: 'run-b' })?.driver).toBe('web')
    await expect(
      service.snapshot(webCanvas.canvasId, { chatId: 'A', runId: 'run-b' })
    ).resolves.toMatchObject({ title: 'Fake' })
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

describe('CanvasService AppDrive web lease', () => {
  const ctx = {
    provider: 'codex',
    chatId: 'chat-lease',
    runId: 'run-lease',
    participantId: 'seat-lease'
  }

  function leaseHarness() {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-appdrive-'))
    const driver = new FakeDriver()
    const leases = new AppDriveLeaseRegistry({
      now: () => 1_000,
      createLeaseId: () => 'lease-web'
    })
    const invalidated = vi.fn(
      (input: { canvasId: string; reason: 'navigation' | 'surface-closed' | 'human-takeover' }) => {
        leases.revokeSurface(input.canvasId, input.reason)
      }
    )
    const service = new CanvasService({
      createDriver: () => driver,
      store: new CanvasStore(dir),
      uuid: () => 'canvas-lease',
      now: () => '2026-08-20T00:00:00.000Z',
      appDriveLeases: leases,
      onSurfaceAuthorityInvalidated: invalidated
    })
    return { dir, driver, leases, invalidated, service }
  }

  function authorize(leases: AppDriveLeaseRegistry, stepBudget = 2): void {
    leases.authorizeUserLease({
      surfaceId: 'canvas-lease',
      surfaceKind: 'web',
      chatId: ctx.chatId,
      runId: ctx.runId,
      provider: ctx.provider,
      participantId: ctx.participantId,
      approvedBy: 'user',
      allowedVerbs: ['click', 'fill', 'key', 'scroll', 'hover', 'select'],
      target: { canvasId: 'canvas-lease', origin: 'http://localhost:3000' },
      stepBudget,
      expiresAt: 10_000
    })
  }

  it('refuses dispatch without a user-minted exact surface lease', async () => {
    const h = leaseHarness()
    try {
      await h.service.open({ url: 'http://localhost:3000' }, ctx)
      const result = await h.service.click('canvas-lease', { kind: 'click', ref: 'e1' }, ctx)
      expect(result).toMatchObject({
        ok: false,
        executed: false,
        refusalReason: 'appdrive_lease_required'
      })
      expect(h.driver.lastAction).toBeUndefined()
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('consumes the approved step budget and refuses the next action', async () => {
    const h = leaseHarness()
    try {
      await h.service.open({ url: 'http://localhost:3000' }, ctx)
      authorize(h.leases, 1)
      expect((await h.service.click('canvas-lease', { kind: 'click', ref: 'e1' }, ctx)).ok).toBe(
        true
      )
      expect(
        await h.service.fill('canvas-lease', { kind: 'fill', ref: 'e2', value: 'value' }, ctx)
      ).toMatchObject({
        ok: false,
        refusalReason: 'appdrive_step_budget_exhausted'
      })
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('revokes web authority on navigation and close', async () => {
    const h = leaseHarness()
    try {
      await h.service.open({ url: 'http://localhost:3000' }, ctx)
      authorize(h.leases)
      await h.service.navigate('canvas-lease', { url: 'https://example.test' }, ctx)
      expect(h.invalidated).toHaveBeenCalledWith(
        expect.objectContaining({ canvasId: 'canvas-lease', reason: 'navigation' })
      )
      expect(h.leases.peek('canvas-lease')).toMatchObject({ status: 'revoked' })

      authorize(h.leases)
      await h.service.close('canvas-lease', ctx)
      expect(h.invalidated).toHaveBeenCalledWith(
        expect.objectContaining({ canvasId: 'canvas-lease', reason: 'surface-closed' })
      )
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('revokes the lease when the web driver reports human takeover', async () => {
    const h = leaseHarness()
    h.driver.act = vi.fn(async () => ({
      ok: false,
      action: 'click' as const,
      found: true,
      executed: false,
      verified: 'unknown' as const,
      refusalReason: 'user_active' as const
    }))
    try {
      await h.service.open({ url: 'http://localhost:3000' }, ctx)
      authorize(h.leases)
      await h.service.click('canvas-lease', { kind: 'click', ref: 'e1' }, ctx)
      expect(h.invalidated).toHaveBeenCalledWith(
        expect.objectContaining({ canvasId: 'canvas-lease', reason: 'human-takeover' })
      )
      expect(h.leases.peek('canvas-lease')).toMatchObject({ status: 'revoked' })
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('routes richer control verbs through the same lease while wait_for stays read-only', async () => {
    const h = leaseHarness()
    try {
      await h.service.open({ url: 'http://localhost:3000' }, ctx)
      const waited = await h.service.act(
        'canvas-lease',
        { kind: 'wait_for', selector: '[data-ready]', timeoutMs: 100 },
        ctx
      )
      expect(waited.action).toBe('wait_for')
      expect(h.leases.peek('canvas-lease')).toBeNull()

      authorize(h.leases)
      const hovered = await h.service.act('canvas-lease', { kind: 'hover', selector: '#menu' }, ctx)
      expect(hovered).toMatchObject({ ok: true, action: 'hover' })
      expect(h.leases.peek('canvas-lease')).toMatchObject({ stepsUsed: 1 })
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('keeps an Ensemble action pending until a different participant verifies it', async () => {
    const h = leaseHarness()
    try {
      await h.service.open({ url: 'http://localhost:3000' }, ctx)
      authorize(h.leases)
      const action = await h.service.click(
        'canvas-lease',
        { kind: 'click', ref: 'e1', requireIndependentVerifier: true },
        ctx
      )
      expect(action).toMatchObject({
        ok: true,
        independentVerificationRequired: true,
        driveReportId: expect.any(String),
        driveActionId: expect.any(String)
      })
      expect(h.service.driveReports({}, ctx)[0]).toMatchObject({
        counts: { total: 1, awaitingVerification: 1 },
        actions: [
          expect.objectContaining({
            actor: expect.objectContaining({ participantId: 'seat-lease' }),
            status: 'awaiting-verification'
          })
        ]
      })

      const actorObservation = await h.service.snapshot('canvas-lease', ctx)
      expect(actorObservation.driveObservation).toMatchObject({
        reportId: action.driveReportId,
        actionId: action.driveActionId,
        surfaceId: 'canvas-lease'
      })

      expect(() =>
        h.service.verifyDriveAction(
          {
            reportId: action.driveReportId!,
            actionId: action.driveActionId!,
            surfaceId: 'canvas-lease',
            observationId: actorObservation.driveObservation!.observationId,
            verdict: 'confirmed'
          },
          ctx
        )
      ).toThrow(/different Ensemble participant/i)

      const reviewerContext = {
        ...ctx,
        runId: 'run-review',
        provider: 'claude',
        participantId: 'seat-review'
      }
      const reviewerObservation = await h.service.snapshot('canvas-lease', reviewerContext)
      expect(
        h.service.verifyDriveAction(
          {
            reportId: action.driveReportId!,
            actionId: action.driveActionId!,
            surfaceId: 'canvas-lease',
            observationId: reviewerObservation.driveObservation!.observationId,
            verdict: 'confirmed'
          },
          reviewerContext
        )
      ).toMatchObject({
        status: 'verified',
        participantVerifier: { participantId: 'seat-review', verdict: 'confirmed' }
      })
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

describe('CanvasService browser navigation', () => {
  let dir: string
  let store: CanvasStore
  let fake: FakeDriver
  let events: CanvasEventRecord[]
  let navBroadcasts: Array<{ canvasId: string; chatId?: string; state: CanvasNavState }>
  let service: CanvasService
  let lastDriverOpts: Parameters<CanvasServiceDeps['createDriver']>[2]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canvas-nav-'))
    store = new CanvasStore(dir)
    fake = new FakeDriver()
    events = []
    navBroadcasts = []
    lastDriverOpts = undefined
    let seq = 0
    service = new CanvasService({
      createDriver: (_kind, _sessionId, opts) => {
        lastDriverOpts = opts
        return fake
      },
      store,
      uuid: () => `id-${++seq}`,
      now: () => '2026-08-04T00:00:00.000Z',
      broadcast: (event) => events.push(event),
      broadcastNavState: (payload) => navBroadcasts.push(payload),
      maxInteractionsPerSession: 3
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('navigates a web canvas, audits the redacted settled URL, and returns chrome state', async () => {
    const opened = await service.open({ url: 'http://localhost:3000' }, { chatId: 'A' })
    const state = await service.navigate(
      opened.canvasId,
      { url: 'https://example.test/page?session=SECRET' },
      { chatId: 'A', provider: 'claude' }
    )
    expect(fake.navigateCalls).toEqual([{ url: 'https://example.test/page?session=SECRET' }])
    expect(state.canGoBack).toBe(true)
    const nav = events.find((event) => event.kind === 'navigation')
    expect(nav?.detail?.via).toBe('goto')
    // Audit records the settled URL with the query REDACTED.
    expect(nav?.detail?.url).toBe('https://example.test/page')
    expect(String(nav?.detail?.url)).not.toContain('SECRET')
  })

  it('routes history actions through the driver and audits the action verb', async () => {
    const opened = await service.open({ url: 'http://localhost:3000' }, { chatId: 'A' })
    await service.navigate(opened.canvasId, { action: 'back' }, { chatId: 'A' })
    expect(fake.navigateCalls).toEqual([{ action: 'back' }])
    const nav = events.filter((event) => event.kind === 'navigation').at(-1)
    expect(nav?.detail?.via).toBe('back')
  })

  it('refuses navigation for a driver without a navigable page', async () => {
    // Simulate a non-web driver surface (html/image/sketch/device/window):
    // shadow the prototype method with an own undefined property.
    Object.defineProperty(fake, 'navigate', { value: undefined, configurable: true })
    const opened = await service.open({ url: 'http://localhost:3000' }, { chatId: 'A' })
    await expect(
      service.navigate(opened.canvasId, { url: 'https://example.test' }, { chatId: 'A' })
    ).rejects.toThrow(/Only web canvases/)
  })

  it('charges the shared interaction budget (navigation cannot bypass the actuation cap)', async () => {
    const opened = await service.open({ url: 'http://localhost:3000' }, { chatId: 'A' })
    await service.navigate(opened.canvasId, { url: 'https://a.test' }, { chatId: 'A' })
    await service.navigate(opened.canvasId, { url: 'https://b.test' }, { chatId: 'A' })
    await service.navigate(opened.canvasId, { url: 'https://c.test' }, { chatId: 'A' })
    await expect(
      service.navigate(opened.canvasId, { url: 'https://d.test' }, { chatId: 'A' })
    ).rejects.toThrow(/interaction budget/)
  })

  it('keeps the durable record truthful on committed navigation — query-redacted, change-only', async () => {
    const opened = await service.open({ url: 'http://localhost:3000' }, { chatId: 'A' })
    lastDriverOpts?.onNavigationCommitted?.({
      url: 'https://example.test/docs?token=SECRET',
      title: 'Docs',
      isLoading: false,
      canGoBack: true,
      canGoForward: false
    })
    const record = store.getSession(opened.canvasId)
    expect(record?.url).toBe('https://example.test/docs')
    expect(record?.title).toBe('Docs')
    expect(JSON.stringify(record)).not.toContain('SECRET')
  })

  it('broadcasts ephemeral chrome state with chat attribution and enriches live summaries', async () => {
    const opened = await service.open({ url: 'http://localhost:3000' }, { chatId: 'A' })
    lastDriverOpts?.onNavState?.({
      url: 'https://example.test/loading',
      title: 'Loading…',
      isLoading: true,
      canGoBack: true,
      canGoForward: false
    })
    expect(navBroadcasts).toHaveLength(1)
    expect(navBroadcasts[0]).toMatchObject({
      canvasId: opened.canvasId,
      chatId: 'A',
      state: { isLoading: true, canGoBack: true }
    })

    fake.currentNav = {
      url: 'https://example.test/loading',
      title: 'Loading…',
      isLoading: true,
      canGoBack: true,
      canGoForward: false
    }
    const summary = service.status(opened.canvasId, { chatId: 'A' })
    expect(summary?.isLoading).toBe(true)
    expect(summary?.canGoBack).toBe(true)
    expect(summary?.canGoForward).toBe(false)
  })

  it('stops broadcasting and recording after the chat history is cleared', async () => {
    const opened = await service.open({ url: 'http://localhost:3000' }, { chatId: 'A' })
    const authority = { chatIds: ['A'] }
    try {
      await service.beginAuthorityHistoryClear(authority)
    } finally {
      service.endAuthorityHistoryClear(authority)
    }
    lastDriverOpts?.onNavState?.({
      url: 'https://late.test',
      title: 'Late',
      isLoading: false,
      canGoBack: false,
      canGoForward: false
    })
    lastDriverOpts?.onNavigationCommitted?.({
      url: 'https://late.test',
      title: 'Late',
      isLoading: false,
      canGoBack: false,
      canGoForward: false
    })
    expect(navBroadcasts).toHaveLength(0)
    expect(store.getSession(opened.canvasId)).toBeNull()
  })

  // Design §7 / slice S12. Under Accept Edits and above canvas_click is
  // authorized for the run, and since 1.9.5 the Browser is any-origin with a
  // durable signed-in profile — so an irreversible control needs one human
  // decision even when the tier would otherwise auto-run it.
  describe('consequential-action confirmation', () => {
    function serviceWith(
      confirm: CanvasServiceDeps['confirmConsequentialAction'],
      driver: FakeDriver = fake
    ): CanvasService {
      let seq = 0
      return new CanvasService({
        createDriver: () => driver,
        store,
        uuid: () => `conseq-${++seq}`,
        now: () => '2026-06-21T00:00:00.000Z',
        broadcast: (event) => events.push(event),
        confirmConsequentialAction: confirm
      })
    }

    it('asks once for a destructive control, then dispatches with the probe epoch pinned', async () => {
      const confirm = vi.fn(async (_request: CanvasConsequentialConfirmRequest) => true)
      fake.targetLabel = 'Delete account'
      fake.targetInputEpoch = 7
      service = serviceWith(confirm)
      const opened = await service.open({ url: 'https://example.com' }, {})

      const result = await service.click(opened.canvasId, { kind: 'click', ref: 'e9' }, {})

      expect(result.executed).toBe(true)
      expect(confirm).toHaveBeenCalledTimes(1)
      // TaskWraith's own words, built from the matched term — never page prose.
      expect(confirm.mock.calls[0][0]).toMatchObject({
        summary: 'a destructive control (“delete account”)',
        category: 'destructive'
      })
      // The human can take time. Pinning the probe's epoch means an action is
      // refused rather than dispatched if they touched the page while deciding.
      expect(fake.lastAction?.expectedInputEpoch).toBe(7)
    })

    it('refuses without dispatching when the human declines', async () => {
      const confirm = vi.fn(async () => false)
      fake.targetLabel = 'Delete account'
      service = serviceWith(confirm)
      const opened = await service.open({ url: 'https://example.com' }, {})

      const result = await service.click(opened.canvasId, { kind: 'click', ref: 'e9' }, {})

      expect(result.ok).toBe(false)
      expect(result.executed).toBe(false)
      expect(result.refusalReason).toBe('consequential_confirmation_required')
      expect(fake.lastAction).toBeUndefined()
    })

    it('fails closed when no confirmation route exists', async () => {
      // A consequential target with nobody to ask must not silently proceed.
      fake.targetLabel = 'Pay now'
      service = serviceWith(undefined)
      const opened = await service.open({ url: 'https://example.com' }, {})

      const result = await service.click(opened.canvasId, { kind: 'click', ref: 'e9' }, {})

      expect(result.refusalReason).toBe('consequential_confirmation_required')
      expect(fake.lastAction).toBeUndefined()
    })

    it('leaves ordinary controls alone', async () => {
      const confirm = vi.fn(async () => true)
      fake.targetLabel = 'Continue'
      service = serviceWith(confirm)
      const opened = await service.open({ url: 'https://example.com' }, {})

      const result = await service.click(opened.canvasId, { kind: 'click', ref: 'e9' }, {})

      expect(result.executed).toBe(true)
      expect(confirm).not.toHaveBeenCalled()
    })

    it('does not gate a driver that cannot describe its targets', async () => {
      // Sketch/chart/image surfaces have no page labels to judge. Gating them
      // on an absent probe would refuse every action on those drivers.
      const confirm = vi.fn(async () => true)
      const blind = new FakeDriver()
      delete blind.describeTarget
      service = serviceWith(confirm, blind)
      const opened = await service.open({ url: 'https://example.com' }, {})

      const result = await service.click(opened.canvasId, { kind: 'click', ref: 'e9' }, {})

      expect(result.executed).toBe(true)
      expect(confirm).not.toHaveBeenCalled()
    })
  })
})
