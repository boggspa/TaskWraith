import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Script } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalEmulatorStateAdapterSchemaJson,
  validateEmulatorStateAdapterManifest,
  type EmulatorStateAdapterManifestV2
} from '../../shared/emulatorCanvas'
import {
  CanvasEmulatorInputEpochStaleError,
  CanvasEmulatorObservationStaleError,
  CanvasEmulatorUserActiveError,
  type CanvasEmulatorAtomicObservation
} from '../canvas/CanvasEmulatorDriver'
import type { CanvasHostSurface } from '../canvas/CanvasHostSurface'
import { createEmulatorAssetRegistry, emulatorEntryUrl } from './EmulatorAssetManifest'
import {
  ElectronEmulatorRuntimeBridge,
  type ElectronEmulatorSession,
  type ElectronEmulatorWebContents
} from './ElectronEmulatorRuntimeBridge'
import type { EmulatorAssetProtocolHandler, EmulatorSessionProtocol } from './EmulatorAssetProtocol'

const READY = {
  frozen: true,
  facadeKeys: ['observe', 'ready', 'shutdown', 'step'],
  moduleGlobal: 'undefined',
  heapGlobal: 'undefined',
  requireGlobal: 'undefined',
  frameId: 88,
  frameHash: 'a'.repeat(64),
  width: 160,
  height: 144,
  magic: [0x54, 0x57, 0x47, 0x42],
  schema: 1,
  status: 3,
  x: 80,
  y: 72,
  input: 0,
  frameCounter: 1
}

const ATOMIC_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0xa0, 0x00, 0x00, 0x00, 0x90
])

function twgbWindow(input: {
  x: number
  y: number
  input: number
  frameCounter: number
}): number[] {
  return [
    0x54,
    0x57,
    0x47,
    0x42,
    1,
    3,
    input.x,
    input.y,
    input.input,
    input.frameCounter & 0xff,
    (input.frameCounter >>> 8) & 0xff,
    (input.frameCounter >>> 16) & 0xff,
    (input.frameCounter >>> 24) & 0xff
  ]
}

function atomicProjection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const direct = {
    facadeFrozen: true,
    facadeKeys: ['observe', 'ready', 'shutdown', 'step'],
    resultFrozen: true,
    observationFrozen: true,
    abiWindowFrozen: true,
    outcome: 'observation',
    refusalCode: null,
    moduleGlobal: 'undefined',
    heapGlobal: 'undefined',
    requireGlobal: 'undefined',
    frameId: 89,
    frameHash: 'b'.repeat(64),
    pngDataUrl: `data:image/png;base64,${ATOMIC_PNG.toString('base64')}`,
    width: 160,
    height: 144,
    magic: [0x54, 0x57, 0x47, 0x42],
    schema: 1,
    status: 3,
    x: 81,
    y: 72,
    input: 0,
    inputEpoch: 4,
    humanActive: false,
    frameCounter: 2
  }
  const projection = { ...direct, ...overrides }
  return {
    ...projection,
    abiWindow:
      overrides.abiWindow ??
      twgbWindow({
        x: projection.x as number,
        y: projection.y as number,
        input: projection.input as number,
        frameCounter: projection.frameCounter as number
      })
  }
}

function atomicRefusal(
  code: 'stale_observation' | 'stale_input_epoch' | 'user_active',
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return atomicProjection({
    outcome: 'refusal',
    refusalCode: code,
    refusalFramesAdvanced: 0,
    ...overrides
  })
}

function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function freezeStateAdapter(
  adapter: EmulatorStateAdapterManifestV2
): EmulatorStateAdapterManifestV2 {
  return Object.freeze({
    ...adapter,
    stateWindow: Object.freeze({ ...adapter.stateWindow }),
    fields: Object.freeze(
      adapter.fields.map((field) =>
        Object.freeze({
          ...field,
          read: Object.freeze({ ...field.read }),
          ...(field.enumValues ? { enumValues: Object.freeze({ ...field.enumValues }) } : {})
        })
      )
    )
  })
}

function stateAdapter(
  fields: readonly Record<string, unknown>[] = [
    { key: 'x', kind: 'integer', read: { address: 6, encoding: 'u8' }, unit: 'px' },
    { key: 'y', kind: 'integer', read: { address: 7, encoding: 'u8' }, unit: 'px' },
    { key: 'input', kind: 'integer', read: { address: 8, encoding: 'u8' }, unit: 'mask' },
    {
      key: 'frame-counter',
      kind: 'integer',
      read: { address: 9, encoding: 'u32le' },
      unit: 'frames'
    }
  ]
): EmulatorStateAdapterManifestV2 {
  const raw = {
    schemaVersion: 2,
    adapterId: 'twgb-state-window',
    adapterRevision: 'v1',
    schemaSha256: '0'.repeat(64),
    coreId: 'sameboy-libretro',
    romSha256: 'a'.repeat(64),
    memoryBytes: 13,
    stateWindow: { source: 'system_ram', startAddress: 0xc100, byteLength: 13 },
    fields
  }
  const validated = validateEmulatorStateAdapterManifest(raw)
  if (!validated.ok || validated.value.schemaVersion !== 2) {
    throw new Error(validated.ok ? 'Expected v2 adapter.' : validated.reason)
  }
  return freezeStateAdapter({
    ...validated.value,
    schemaSha256: hash(canonicalEmulatorStateAdapterSchemaJson(validated.value))
  })
}

function decodeFailingStateAdapter(): EmulatorStateAdapterManifestV2 {
  return stateAdapter([
    {
      key: 'frame-counter',
      kind: 'integer',
      read: { address: 9, encoding: 'u32le', scale: 1_000_000 },
      unit: 'frames'
    }
  ])
}

function rehashedFrozenAdapter(
  candidate: Omit<EmulatorStateAdapterManifestV2, 'schemaSha256'>
): EmulatorStateAdapterManifestV2 {
  return freezeStateAdapter({
    ...candidate,
    schemaSha256: hash(canonicalEmulatorStateAdapterSchemaJson(candidate))
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function makeFakeSession() {
  let assetHandler: EmulatorAssetProtocolHandler | null = null
  let requestListener:
    | ((details: { url: string }, callback: (result: { cancel: boolean }) => void) => void)
    | null = null
  const session = {
    protocol: {
      handle: vi.fn(async (_scheme: string, handler: EmulatorAssetProtocolHandler) => {
        assetHandler = handler
      }),
      unhandle: vi.fn(async () => {
        assetHandler = null
      })
    } satisfies EmulatorSessionProtocol,
    webRequest: {
      onBeforeRequest: vi.fn(
        (
          _filter: { urls: string[] },
          listener:
            | ((details: { url: string }, callback: (result: { cancel: boolean }) => void) => void)
            | null
        ) => {
          requestListener = listener
        }
      )
    },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  } satisfies ElectronEmulatorSession
  return {
    session,
    assetHandler: () => assetHandler,
    requestListener: () => requestListener
  }
}

function makeFakeContents(session: ElectronEmulatorSession) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let windowOpenHandler: ((details: unknown) => { action: 'deny' }) | null = null
  let destroyed = false
  const executeJavaScript = vi.fn<(code: string, userGesture?: boolean) => Promise<unknown>>(
    async (code: string) => (code.includes('shutdown') ? { closed: true } : READY)
  )
  const contents = {
    session,
    isDestroyed: () => destroyed,
    loadURL: vi.fn(async () => {}),
    executeJavaScript,
    setWindowOpenHandler: vi.fn((handler: (details: unknown) => { action: 'deny' }) => {
      windowOpenHandler = handler
    }),
    setWebRTCIPHandlingPolicy: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const values = listeners.get(event) ?? new Set()
      values.add(listener)
      listeners.set(event, values)
    }),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener)
    })
  } satisfies ElectronEmulatorWebContents
  return {
    contents,
    destroy: () => {
      destroyed = true
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    windowOpen: () => windowOpenHandler
  }
}

function makeFakeSurface(contents: ElectronEmulatorWebContents, onDestroy: () => void = () => {}) {
  let destroyed = false
  return {
    surface: {
      webContents: contents as unknown as CanvasHostSurface['webContents'],
      getTitle: () => 'Homebrew',
      setContentSize: vi.fn(),
      isDestroyed: () => destroyed,
      destroy: () => {
        destroyed = true
        onDestroy()
      },
      onClosed: vi.fn()
    } satisfies CanvasHostSurface,
    destroy: () => {
      destroyed = true
    }
  }
}

describe('ElectronEmulatorRuntimeBridge', () => {
  let root: string
  let registry: ReturnType<typeof createEmulatorAssetRegistry>

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-electron-twemu-'))
    const index = Buffer.from('<!doctype html><title>Homebrew</title>')
    fs.writeFileSync(path.join(root, 'index.html'), index)
    registry = createEmulatorAssetRegistry([
      {
        rootPath: root,
        manifest: {
          schemaVersion: 1,
          gameId: 'homebrew-demo',
          entryPath: 'index.html',
          assets: [
            {
              path: 'index.html',
              sha256: hash(index),
              byteLength: index.byteLength,
              mimeType: 'text/html'
            }
          ]
        }
      }
    ])
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('installs the manifest handler and every deny policy on the exact Canvas session', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const entryUrl = emulatorEntryUrl('homebrew-demo')

    await bridge.boot({ gameId: 'homebrew-demo', url: entryUrl, surface: fakeSurface.surface })

    expect(fakeSession.session.protocol.handle).toHaveBeenCalledWith('twemu', expect.any(Function))
    expect(fakeContents.contents.loadURL).toHaveBeenCalledWith(entryUrl)
    expect(fakeContents.contents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith(
      'disable_non_proxied_udp'
    )
    expect(fakeContents.windowOpen()?.({})).toEqual({ action: 'deny' })
    expect(fakeContents.listenerCount('will-navigate')).toBe(1)
    expect(fakeContents.listenerCount('did-fail-load')).toBe(1)
    expect(fakeContents.listenerCount('render-process-gone')).toBe(1)

    const beforeRequest = fakeSession.requestListener()
    expect(beforeRequest).toBeTypeOf('function')
    let allowed: { cancel: boolean } | null = null
    beforeRequest?.({ url: entryUrl }, (result) => {
      allowed = result
    })
    expect(allowed).toEqual({ cancel: false })
    beforeRequest?.({ url: 'https://example.test/escape' }, (result) => {
      allowed = result
    })
    expect(allowed).toEqual({ cancel: true })
    beforeRequest?.({ url: 'twemu://app/homebrew-demo/missing.wasm' }, (result) => {
      allowed = result
    })
    expect(allowed).toEqual({ cancel: true })

    const permissionCheck = fakeSession.session.setPermissionCheckHandler.mock.calls.at(-1)?.[0]
    expect(permissionCheck?.()).toBe(false)
    const permissionRequest = fakeSession.session.setPermissionRequestHandler.mock.calls.at(-1)?.[0]
    const permissionResult = vi.fn()
    permissionRequest?.({}, 'geolocation', permissionResult, {
      requestingUrl: 'twemu://app/index.html'
    })
    expect(permissionResult).toHaveBeenCalledWith(false)
    expect(
      fakeContents.contents.executeJavaScript.mock.calls.every((call) => call[1] !== true)
    ).toBe(true)
  })

  it('loads only the canonical entry and rejects a foreign boot URL before session registration', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })

    await expect(
      bridge.boot({
        gameId: 'homebrew-demo',
        url: 'https://example.test/escape',
        surface: fakeSurface.surface
      })
    ).rejects.toThrow(/non-canonical/i)
    expect(fakeSession.session.protocol.handle).not.toHaveBeenCalled()
    expect(fakeContents.contents.loadURL).not.toHaveBeenCalled()
  })

  it('preserves Electron event receivers while denying navigation and downloads', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)

    let navigationReceiverWasEvent = false
    const navigationEvent = {
      preventDefault(this: unknown) {
        navigationReceiverWasEvent = this === navigationEvent
      }
    }
    fakeContents.emit('will-navigate', navigationEvent, 'https://example.test/escape')
    expect(navigationReceiverWasEvent).toBe(true)

    const downloadListener = fakeSession.session.on.mock.calls.find(
      ([event]) => event === 'will-download'
    )?.[1]
    expect(downloadListener).toBeTypeOf('function')
    let downloadReceiverWasEvent = false
    const downloadEvent = {
      preventDefault(this: unknown) {
        downloadReceiverWasEvent = this === downloadEvent
      }
    }
    if (typeof downloadListener !== 'function')
      throw new Error('Expected download denial listener.')
    downloadListener(downloadEvent)
    expect(downloadReceiverWasEvent).toBe(true)
  })

  it('cleans protocol, policies, and only its own listeners on shutdown', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const entryUrl = emulatorEntryUrl('homebrew-demo')
    await bridge.boot({ gameId: 'homebrew-demo', url: entryUrl, surface: fakeSurface.surface })

    await bridge.shutdown({ gameId: 'homebrew-demo', surface: fakeSurface.surface })
    await bridge.shutdown({ gameId: 'homebrew-demo', surface: fakeSurface.surface })

    expect(fakeSession.session.protocol.unhandle).toHaveBeenCalledTimes(1)
    expect(fakeContents.listenerCount('will-navigate')).toBe(0)
    expect(fakeContents.listenerCount('did-fail-load')).toBe(0)
    expect(fakeContents.listenerCount('render-process-gone')).toBe(0)
    expect(fakeSession.session.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(
      { urls: ['*://*/*'] },
      null
    )
    expect(fakeSession.session.setPermissionCheckHandler).toHaveBeenLastCalledWith(null)
    expect(fakeSession.session.setPermissionRequestHandler).toHaveBeenLastCalledWith(null)
    expect(
      fakeContents.contents.executeJavaScript.mock.calls.every((call) => call[1] !== true)
    ).toBe(true)
  })

  it('returns one main-stamped atomic PNG/ABI observation and routes a guarded RIGHT step', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({
      registry,
      capturedAt: () => '2026-08-31T19:00:00.000Z',
      createObservationId: vi.fn(() => 'obs:1')
    })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)

    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(atomicProjection())
    const observed = await bridge.observe(input)
    expect(observed).toMatchObject({
      schemaVersion: 1,
      observationId: 'obs:1',
      emulationGeneration: 1,
      frameId: 89,
      inputEpoch: 4,
      capturedAt: '2026-08-31T19:00:00.000Z',
      frame: {
        mimeType: 'image/png',
        width: 160,
        height: 144,
        byteLength: ATOMIC_PNG.byteLength,
        hash: hash(ATOMIC_PNG),
        capturedAt: '2026-08-31T19:00:00.000Z'
      },
      mappedState: { kind: 'unavailable', reason: 'no_verified_adapter' }
    })
    expect(Object.isFrozen(observed)).toBe(true)
    expect(Object.isFrozen(observed.frame)).toBe(true)
    expect(Object.isFrozen(observed.mappedState)).toBe(true)
    expect(observed).not.toHaveProperty('abiWindow')
    expect(observed).not.toHaveProperty('state')

    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(
      atomicProjection({ frameId: 90, input: 16, inputEpoch: 4, frameCounter: 3, x: 82 })
    )
    const stepped = await bridge.step({
      gameId: 'homebrew-demo',
      surface: fakeSurface.surface,
      buttons: ['right'],
      expectedFrameId: 89,
      expectedInputEpoch: 4,
      expectedFixtureCounter: 2
    })
    expect(stepped.frameId).toBe(90)
    expect(stepped.mappedState).toEqual({ kind: 'unavailable', reason: 'no_verified_adapter' })
    const stepCode = fakeContents.contents.executeJavaScript.mock.calls
      .map(([code]) => code)
      .find((code) => code.includes('api.step(["right"], 89, 4)'))
    expect(stepCode).toBeTypeOf('string')
    if (typeof stepCode !== 'string') throw new Error('Expected fixed internal step probe.')
    expect(() => new Script(stepCode)).not.toThrow()
  })

  it('decodes the exact fixed ABI window into deeply frozen mapped state without retaining raw ABI data', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({
      registry,
      stateAdapter: stateAdapter(),
      createObservationId: vi.fn(() => 'obs:mapped')
    })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)

    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(atomicProjection())
    const observed = await bridge.observe(input)
    expect(observed.mappedState).toEqual({
      kind: 'mapped',
      adapterId: 'twgb-state-window',
      adapterRevision: 'v1',
      schemaSha256: stateAdapter().schemaSha256,
      truncated: false,
      fields: [
        { key: 'x', kind: 'integer', value: 81, unit: 'px' },
        { key: 'y', kind: 'integer', value: 72, unit: 'px' },
        { key: 'input', kind: 'integer', value: 0, unit: 'mask' },
        { key: 'frame-counter', kind: 'integer', value: 2, unit: 'frames' }
      ]
    })
    expect(Object.isFrozen(observed.mappedState)).toBe(true)
    if (observed.mappedState.kind !== 'mapped') throw new Error('Expected mapped state.')
    expect(Object.isFrozen(observed.mappedState.fields)).toBe(true)
    expect(observed.mappedState.fields.every(Object.isFrozen)).toBe(true)
    for (const forbidden of [
      'abiWindow',
      'magic',
      'schema',
      'status',
      'x',
      'y',
      'input',
      'frameCounter',
      'rgbaHash',
      'HEAPU8',
      'systemRam'
    ]) {
      expect(observed).not.toHaveProperty(forbidden)
    }

    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(
      atomicProjection({ frameId: 90, input: 16, frameCounter: 3, x: 82 })
    )
    const stepped = await bridge.step({
      gameId: 'homebrew-demo',
      surface: fakeSurface.surface,
      buttons: ['right'],
      expectedFrameId: 89,
      expectedInputEpoch: 4,
      expectedFixtureCounter: 2
    })
    expect(stepped.mappedState).toMatchObject({
      kind: 'mapped',
      fields: [
        { key: 'x', value: 82 },
        { key: 'y', value: 72 },
        { key: 'input', value: 16 },
        { key: 'frame-counter', value: 3 }
      ]
    })
  })

  it('rejects mutable, semantically invalid, wrong-window, and bad-hash adapters before page boot', () => {
    const valid = stateAdapter()
    const mutable = { ...valid }
    const wrongWindow = rehashedFrozenAdapter({
      ...valid,
      stateWindow: { ...valid.stateWindow, startAddress: 0xc101 }
    })
    const wrongField = rehashedFrozenAdapter({
      ...valid,
      fields: [
        {
          key: 'past-end',
          kind: 'integer',
          read: { address: 13, encoding: 'u8' },
          unit: 'bytes'
        }
      ]
    } as Omit<EmulatorStateAdapterManifestV2, 'schemaSha256'>)
    const badHash = freezeStateAdapter({ ...valid, schemaSha256: 'f'.repeat(64) })
    for (const adapter of [mutable, wrongWindow, wrongField, badHash]) {
      expect(() => new ElectronEmulatorRuntimeBridge({ registry, stateAdapter: adapter })).toThrow(
        /adapter|schemaSha256/i
      )
    }
  })

  it('binds successful and one-frame-refusal results to the expected frame and fixture-counter deltas', async () => {
    const positiveCases: Array<{
      result: Record<string, unknown>
      code?: 'stale_observation' | 'stale_input_epoch' | 'user_active'
      framesAdvanced?: 0 | 1
    }> = [
      { result: atomicProjection({ frameId: 90, frameCounter: 3, x: 82, input: 16 }) },
      {
        code: 'stale_observation',
        framesAdvanced: 0,
        result: atomicRefusal('stale_observation', { frameId: 96, frameCounter: 9 })
      },
      {
        code: 'stale_input_epoch',
        framesAdvanced: 1,
        result: atomicRefusal('stale_input_epoch', {
          refusalFramesAdvanced: 1,
          frameId: 90,
          frameCounter: 3,
          inputEpoch: 5
        })
      },
      {
        code: 'user_active',
        framesAdvanced: 1,
        result: atomicRefusal('user_active', {
          refusalFramesAdvanced: 1,
          frameId: 90,
          frameCounter: 3,
          humanActive: true,
          inputEpoch: 5
        })
      }
    ]
    for (const { result, code, framesAdvanced } of positiveCases) {
      const fakeSession = makeFakeSession()
      const fakeContents = makeFakeContents(fakeSession.session)
      const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
      const bridge = new ElectronEmulatorRuntimeBridge({ registry, stateAdapter: stateAdapter() })
      const input = {
        gameId: 'homebrew-demo' as const,
        url: emulatorEntryUrl('homebrew-demo'),
        surface: fakeSurface.surface
      }
      await bridge.boot(input)
      fakeContents.contents.executeJavaScript.mockResolvedValueOnce(result)
      const stepped = bridge.step({
        gameId: 'homebrew-demo',
        surface: fakeSurface.surface,
        buttons: ['right'],
        expectedFrameId: 89,
        expectedInputEpoch: 4,
        expectedFixtureCounter: 2
      })
      if (code) {
        await expect(stepped).rejects.toMatchObject({ code, framesAdvanced })
      } else {
        await expect(stepped).resolves.toMatchObject({ frameId: 90 })
      }
      expect(fakeSurface.surface.isDestroyed()).toBe(false)
    }

    const negativeCases: Array<[string, Record<string, unknown>]> = [
      ['same success frame', atomicProjection({ frameId: 89, frameCounter: 3 })],
      ['skipped success frame', atomicProjection({ frameId: 91, frameCounter: 3 })],
      ['unchanged success counter', atomicProjection({ frameId: 90, frameCounter: 2 })],
      [
        'human-active success',
        atomicProjection({ frameId: 90, frameCounter: 3, humanActive: true })
      ],
      ['human-epoch success', atomicProjection({ frameId: 90, frameCounter: 3, inputEpoch: 5 })],
      [
        'unchanged zero-frame stale-input epoch',
        atomicRefusal('stale_input_epoch', { inputEpoch: 4 })
      ],
      [
        'same one-frame refusal',
        atomicRefusal('stale_input_epoch', {
          refusalFramesAdvanced: 1,
          frameId: 89,
          frameCounter: 3,
          inputEpoch: 5
        })
      ],
      [
        'skipped one-frame refusal',
        atomicRefusal('stale_input_epoch', {
          refusalFramesAdvanced: 1,
          frameId: 91,
          frameCounter: 3,
          inputEpoch: 5
        })
      ],
      [
        'unchanged one-frame counter',
        atomicRefusal('stale_input_epoch', {
          refusalFramesAdvanced: 1,
          frameId: 90,
          frameCounter: 2,
          inputEpoch: 5
        })
      ],
      [
        'unchanged one-frame stale-input epoch',
        atomicRefusal('stale_input_epoch', {
          refusalFramesAdvanced: 1,
          frameId: 90,
          frameCounter: 3,
          inputEpoch: 4
        })
      ],
      [
        'unchanged one-frame user-active epoch',
        atomicRefusal('user_active', {
          refusalFramesAdvanced: 1,
          frameId: 90,
          frameCounter: 3,
          humanActive: true,
          inputEpoch: 4
        })
      ],
      [
        'unchanged stale-observation frame',
        atomicRefusal('stale_observation', { frameId: 89, frameCounter: 3 })
      ]
    ]
    for (const [label, result] of negativeCases) {
      const fakeSession = makeFakeSession()
      const fakeContents = makeFakeContents(fakeSession.session)
      const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
      const bridge = new ElectronEmulatorRuntimeBridge({ registry, stateAdapter: stateAdapter() })
      const input = {
        gameId: 'homebrew-demo' as const,
        url: emulatorEntryUrl('homebrew-demo'),
        surface: fakeSurface.surface
      }
      await bridge.boot(input)
      fakeContents.contents.executeJavaScript.mockResolvedValueOnce(result)
      await expect(
        bridge.step({
          gameId: 'homebrew-demo',
          surface: fakeSurface.surface,
          buttons: ['right'],
          expectedFrameId: 89,
          expectedInputEpoch: 4,
          expectedFixtureCounter: 2
        }),
        label
      ).rejects.toThrow(
        /step result|human input transition|changed.*epoch|stale-(?:input|observation)/i
      )
      await vi.waitFor(() => expect(fakeSurface.surface.isDestroyed(), label).toBe(true))
    }
  })

  it('rejects non-PNG, oversized, or untrusted page observation projections before minting a frame', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const createObservationId = vi.fn(() => 'obs:rejected')
    const onFatal = vi.fn()
    const bridge = new ElectronEmulatorRuntimeBridge({ registry, createObservationId, onFatal })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)

    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(
      atomicProjection({ pngDataUrl: 'data:image/png;base64,AAAA' })
    )
    await expect(bridge.observe(input)).rejects.toThrow(/PNG/i)
    expect(createObservationId).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(fakeSurface.surface.isDestroyed()).toBe(true))
    expect(onFatal).toHaveBeenCalledOnce()
    await expect(bridge.observe(input)).rejects.toThrow(/binding is absent/i)
  })

  it('fatal-retires every malformed fixed ABI window/direct-field boundary before materializing', async () => {
    const canonical = twgbWindow({ x: 81, y: 72, input: 0, frameCounter: 2 })
    const cases: Array<[string, Record<string, unknown>]> = [
      ['unfrozen window', { abiWindowFrozen: false }],
      ['short window', { abiWindow: canonical.slice(0, 12) }],
      ['non-byte window', { abiWindow: [...canonical.slice(0, 12), 256] }],
      ['window magic mismatch', { abiWindow: [0, ...canonical.slice(1)] }],
      ['direct magic mismatch', { magic: [0, 0x57, 0x47, 0x42] }],
      ['direct schema mismatch', { schema: 2 }],
      ['direct status mismatch', { status: 2 }],
      ['direct x mismatch', { x: 82, abiWindow: canonical }],
      ['direct y mismatch', { y: 71, abiWindow: canonical }],
      ['direct input mismatch', { input: 16, abiWindow: canonical }],
      ['direct counter mismatch', { frameCounter: 3, abiWindow: canonical }]
    ]
    for (const [label, overrides] of cases) {
      const fakeSession = makeFakeSession()
      const fakeContents = makeFakeContents(fakeSession.session)
      const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
      const bridge = new ElectronEmulatorRuntimeBridge({ registry })
      const input = {
        gameId: 'homebrew-demo' as const,
        url: emulatorEntryUrl('homebrew-demo'),
        surface: fakeSurface.surface
      }
      await bridge.boot(input)
      fakeContents.contents.executeJavaScript.mockResolvedValueOnce(atomicProjection(overrides))

      await expect(bridge.observe(input), label).rejects.toThrow()
      await vi.waitFor(() => expect(fakeSurface.surface.isDestroyed(), label).toBe(true))
    }
  })

  it('fatal-retires a bounded window when the supplied adapter cannot decode it', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({
      registry,
      stateAdapter: decodeFailingStateAdapter()
    })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)
    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(
      atomicProjection({ frameCounter: 0xffff_ffff })
    )

    await expect(bridge.observe(input)).rejects.toThrow(/failed to decode/i)
    await vi.waitFor(() => expect(fakeSurface.surface.isDestroyed()).toBe(true))
  })

  it('translates the fixed page stale-input sentinel into a typed main-side refusal', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)
    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(
      atomicRefusal('stale_input_epoch', { inputEpoch: 5 })
    )

    const rejected = bridge.step({
      gameId: 'homebrew-demo',
      surface: fakeSurface.surface,
      buttons: ['right'],
      expectedFrameId: 89,
      expectedInputEpoch: 4
    })
    await expect(rejected).rejects.toBeInstanceOf(CanvasEmulatorInputEpochStaleError)
    await expect(rejected).rejects.toMatchObject({
      framesAdvanced: 0,
      observation: expect.objectContaining({ frameId: 89, inputEpoch: 5 })
    })
    expect(fakeSurface.surface.isDestroyed()).toBe(false)
  })

  it('preserves a post-dispatch human interruption as one honestly advanced frame', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)
    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(
      atomicRefusal('stale_input_epoch', {
        frameId: 90,
        frameCounter: 3,
        inputEpoch: 5,
        refusalFramesAdvanced: 1
      })
    )

    await expect(
      bridge.step({
        gameId: 'homebrew-demo',
        surface: fakeSurface.surface,
        buttons: ['right'],
        expectedFrameId: 89,
        expectedInputEpoch: 4
      })
    ).rejects.toMatchObject({
      code: 'stale_input_epoch',
      framesAdvanced: 1,
      observation: expect.objectContaining({ frameId: 90, inputEpoch: 5 })
    })
    expect(fakeSurface.surface.isDestroyed()).toBe(false)
  })

  it('translates a stale frame envelope without retiring a still-live surface', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)
    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(
      atomicRefusal('stale_observation', { frameId: 90, frameCounter: 3 })
    )

    const rejected = bridge.step({
      gameId: 'homebrew-demo',
      surface: fakeSurface.surface,
      buttons: ['right'],
      expectedFrameId: 89,
      expectedInputEpoch: 4
    })
    await expect(rejected).rejects.toBeInstanceOf(CanvasEmulatorObservationStaleError)
    await expect(rejected).rejects.toMatchObject({
      observation: expect.objectContaining({ frameId: 90, inputEpoch: 4 })
    })
    expect(fakeSurface.surface.isDestroyed()).toBe(false)

    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(atomicProjection())
    await expect(bridge.observe(input)).resolves.toMatchObject({ frameId: 89 })
  })

  it('maps a structured human-play refusal to a typed current observation without retiring', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)
    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(
      atomicRefusal('user_active', {
        humanActive: true,
        refusalFramesAdvanced: 1,
        frameId: 90,
        inputEpoch: 5
      })
    )

    const rejected = bridge.step({
      gameId: 'homebrew-demo',
      surface: fakeSurface.surface,
      buttons: ['right'],
      expectedFrameId: 89,
      expectedInputEpoch: 4
    })
    await expect(rejected).rejects.toBeInstanceOf(CanvasEmulatorUserActiveError)
    await expect(rejected).rejects.toMatchObject({
      framesAdvanced: 1,
      observation: expect.objectContaining({ frameId: 90, humanActive: true })
    })
    expect(fakeSurface.surface.isDestroyed()).toBe(false)
  })

  it('retains deeply frozen mapped state on every nonfatal refusal for driver cache refresh', async () => {
    const cases: Array<{
      code: 'stale_observation' | 'stale_input_epoch' | 'user_active'
      overrides?: Record<string, unknown>
    }> = [
      { code: 'stale_observation', overrides: { frameId: 90, frameCounter: 3 } },
      { code: 'stale_input_epoch', overrides: { inputEpoch: 5 } },
      { code: 'user_active', overrides: { humanActive: true } }
    ]
    for (const { code, overrides } of cases) {
      const fakeSession = makeFakeSession()
      const fakeContents = makeFakeContents(fakeSession.session)
      const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
      const bridge = new ElectronEmulatorRuntimeBridge({ registry, stateAdapter: stateAdapter() })
      const input = {
        gameId: 'homebrew-demo' as const,
        url: emulatorEntryUrl('homebrew-demo'),
        surface: fakeSurface.surface
      }
      await bridge.boot(input)
      fakeContents.contents.executeJavaScript.mockResolvedValueOnce(atomicRefusal(code, overrides))

      const error = await bridge
        .step({
          gameId: 'homebrew-demo',
          surface: fakeSurface.surface,
          buttons: ['right'],
          expectedFrameId: 89,
          expectedInputEpoch: 4,
          expectedFixtureCounter: 2
        })
        .catch((reason: unknown) => reason)
      expect(error).toMatchObject({ code, observation: expect.any(Object) })
      const observation = (error as { observation: CanvasEmulatorAtomicObservation }).observation
      expect(observation.mappedState).toMatchObject({ kind: 'mapped' })
      if (observation.mappedState.kind !== 'mapped') throw new Error('Expected mapped state.')
      expect(Object.isFrozen(observation.mappedState)).toBe(true)
      expect(Object.isFrozen(observation.mappedState.fields)).toBe(true)
      expect(observation).not.toHaveProperty('abiWindow')
      expect(observation).not.toHaveProperty('state')
      expect(fakeSurface.surface.isDestroyed()).toBe(false)
    }
  })

  it('fatal-retires a stale observation envelope that dishonestly claims a dispatched frame', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)
    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(
      atomicRefusal('stale_observation', { refusalFramesAdvanced: 1 })
    )

    await expect(
      bridge.step({
        gameId: 'homebrew-demo',
        surface: fakeSurface.surface,
        buttons: ['right'],
        expectedFrameId: 89,
        expectedInputEpoch: 4
      })
    ).rejects.toThrow(/invalid atomic refusal/i)
    await vi.waitFor(() => expect(fakeSurface.surface.isDestroyed()).toBe(true))
  })

  it('fatal-retires a stale-input envelope with an unsupported dispatch count', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)
    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(
      atomicRefusal('stale_input_epoch', { refusalFramesAdvanced: 2 })
    )

    await expect(
      bridge.step({
        gameId: 'homebrew-demo',
        surface: fakeSurface.surface,
        buttons: ['right'],
        expectedFrameId: 89,
        expectedInputEpoch: 4
      })
    ).rejects.toThrow(/invalid atomic refusal/i)
    await vi.waitFor(() => expect(fakeSurface.surface.isDestroyed()).toBe(true))
  })

  it('fatal-retires a user-active envelope without a human-active current observation', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)
    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(atomicRefusal('user_active'))

    await expect(
      bridge.step({
        gameId: 'homebrew-demo',
        surface: fakeSurface.surface,
        buttons: ['right'],
        expectedFrameId: 89,
        expectedInputEpoch: 4
      })
    ).rejects.toThrow(/invalid atomic refusal/i)
    await vi.waitFor(() => expect(fakeSurface.surface.isDestroyed()).toBe(true))
  })

  it('allows exactly one of two same-observation steps and returns a typed stale frame with a current observation', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const createObservationId = vi
      .fn<() => string>()
      .mockReturnValueOnce('obs:first')
      .mockReturnValueOnce('obs:stale')
    const bridge = new ElectronEmulatorRuntimeBridge({ registry, createObservationId })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)
    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(
      atomicProjection({ frameId: 90, frameCounter: 3 })
    )
    fakeContents.contents.executeJavaScript.mockResolvedValueOnce(
      atomicRefusal('stale_observation', { frameId: 90, frameCounter: 3 })
    )

    const first = bridge.step({
      gameId: 'homebrew-demo',
      surface: fakeSurface.surface,
      buttons: ['right'],
      expectedFrameId: 89,
      expectedInputEpoch: 4
    })
    const second = bridge.step({
      gameId: 'homebrew-demo',
      surface: fakeSurface.surface,
      buttons: ['right'],
      expectedFrameId: 89,
      expectedInputEpoch: 4
    })

    await expect(first).resolves.toMatchObject({ observationId: 'obs:first', frameId: 90 })
    await expect(second).rejects.toMatchObject({
      code: 'stale_observation',
      observation: expect.objectContaining({ observationId: 'obs:stale', frameId: 90 })
    })
  })

  it('fatal-retires an unrelated page error that merely contains a stale sentinel string', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)
    fakeContents.contents.executeJavaScript.mockRejectedValueOnce(
      new Error('unexpected text TWEMU_INPUT_EPOCH_STALE is not an envelope')
    )

    await expect(
      bridge.step({
        gameId: 'homebrew-demo',
        surface: fakeSurface.surface,
        buttons: ['right'],
        expectedFrameId: 89,
        expectedInputEpoch: 4
      })
    ).rejects.toThrow(/unexpected text/i)
    await vi.waitFor(() => expect(fakeSurface.surface.isDestroyed()).toBe(true))
  })

  it('retires a timed-out atomic operation and refuses later calls on that surface', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry, operationTimeoutMs: 100 })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)
    fakeContents.contents.executeJavaScript.mockImplementationOnce(
      () => new Promise<unknown>(() => {})
    )

    await expect(bridge.observe(input)).rejects.toThrow(/timed out/i)
    await vi.waitFor(() => expect(fakeSurface.surface.isDestroyed()).toBe(true))
    await expect(bridge.observe(input)).rejects.toThrow(/binding is absent/i)
  })

  it('cleans after a malformed ready projection rather than leaving a session handler behind', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    fakeContents.contents.executeJavaScript.mockResolvedValue({ frozen: false })
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    let now = 0
    const bridge = new ElectronEmulatorRuntimeBridge({
      registry,
      readyTimeoutMs: 100,
      now: () => now,
      delay: async () => {
        now += 50
      }
    })

    await expect(
      bridge.boot({
        gameId: 'homebrew-demo',
        url: emulatorEntryUrl('homebrew-demo'),
        surface: fakeSurface.surface
      })
    ).rejects.toThrow(/stable ready/i)
    expect(fakeSession.session.protocol.unhandle).toHaveBeenCalledTimes(1)
    expect(fakeContents.listenerCount('will-navigate')).toBe(0)
  })

  it('times out a hung ready promise, destroys the surface, and releases its session handler', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const hung = deferred<unknown>()
    fakeContents.contents.executeJavaScript.mockImplementation(() => hung.promise)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({
      registry,
      readyTimeoutMs: 1_000,
      operationTimeoutMs: 100
    })

    await expect(
      bridge.boot({
        gameId: 'homebrew-demo',
        url: emulatorEntryUrl('homebrew-demo'),
        surface: fakeSurface.surface
      })
    ).rejects.toThrow(/ready probe timed out/i)
    expect(fakeSurface.surface.isDestroyed()).toBe(true)
    expect(fakeContents.contents.isDestroyed()).toBe(true)
    expect(fakeSession.session.protocol.unhandle).toHaveBeenCalledTimes(1)
  })

  it('times out a hung loadURL, destroys the surface, and releases its session handler', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const hung = deferred<void>()
    fakeContents.contents.loadURL.mockImplementationOnce(() => hung.promise)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry, operationTimeoutMs: 100 })

    await expect(
      bridge.boot({
        gameId: 'homebrew-demo',
        url: emulatorEntryUrl('homebrew-demo'),
        surface: fakeSurface.surface
      })
    ).rejects.toThrow(/page load timed out/i)
    expect(fakeSurface.surface.isDestroyed()).toBe(true)
    expect(fakeContents.contents.isDestroyed()).toBe(true)
    expect(fakeSession.session.protocol.unhandle).toHaveBeenCalledTimes(1)
  })

  it('bounds a hung page-shutdown facade call and still contains the surface', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const hung = deferred<unknown>()
    fakeContents.contents.executeJavaScript.mockImplementation((code: string) =>
      code.includes('shutdown') ? hung.promise : Promise.resolve(READY)
    )
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry, operationTimeoutMs: 100 })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)

    await expect(bridge.shutdown(input)).resolves.toBeUndefined()
    expect(fakeSurface.surface.isDestroyed()).toBe(true)
    expect(fakeContents.contents.isDestroyed()).toBe(true)
    expect(fakeSession.session.protocol.unhandle).toHaveBeenCalledTimes(1)
  })

  it('continues protocol cleanup when one listener-removal call throws', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)
    fakeContents.contents.removeListener.mockImplementationOnce(() => {
      throw new Error('destroyed listener host')
    })

    await expect(bridge.shutdown(input)).resolves.toBeUndefined()
    expect(fakeSession.session.protocol.unhandle).toHaveBeenCalledTimes(1)
    expect(fakeSession.session.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(
      { urls: ['*://*/*'] },
      null
    )
    expect(fakeSession.session.setPermissionCheckHandler).toHaveBeenLastCalledWith(null)
  })

  it('releases session resources on a main-frame load failure during boot', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const load = deferred<void>()
    fakeContents.contents.loadURL.mockImplementationOnce(() => load.promise)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const onFatal = vi.fn()
    const bridge = new ElectronEmulatorRuntimeBridge({ registry, onFatal })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }

    const boot = bridge.boot(input)
    await vi.waitFor(() => expect(fakeContents.listenerCount('did-fail-load')).toBe(1))
    fakeContents.emit('did-fail-load', {}, -2, 'ERR_FAILED', input.url, true)
    load.resolve(undefined)

    await expect(boot).rejects.toThrow(/cancelled|load failed/i)
    await vi.waitFor(() => expect(fakeSession.session.protocol.unhandle).toHaveBeenCalledOnce())
    expect(fakeContents.listenerCount('did-fail-load')).toBe(0)
    expect(fakeSurface.surface.isDestroyed()).toBe(true)
    expect(onFatal).toHaveBeenCalledOnce()
  })

  it('releases protocol and listeners after a post-ready renderer-process loss', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const onFatal = vi.fn()
    const bridge = new ElectronEmulatorRuntimeBridge({ registry, onFatal })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)

    fakeContents.emit('render-process-gone', {})
    await vi.waitFor(() => expect(fakeSession.session.protocol.unhandle).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(fakeSurface.surface.isDestroyed()).toBe(true))
    expect(fakeContents.listenerCount('will-navigate')).toBe(0)
    expect(fakeContents.listenerCount('render-process-gone')).toBe(0)
    expect(onFatal).toHaveBeenCalledOnce()
  })

  it('coalesces shutdown with an in-flight boot and releases the session once', async () => {
    const fakeSession = makeFakeSession()
    const fakeContents = makeFakeContents(fakeSession.session)
    const load = deferred<void>()
    fakeContents.contents.loadURL.mockImplementationOnce(() => load.promise)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }

    const boot = bridge.boot(input)
    await vi.waitFor(() => expect(fakeSession.session.protocol.handle).toHaveBeenCalledOnce())
    const shutdown = bridge.shutdown(input)
    load.resolve(undefined)

    await expect(boot).rejects.toThrow(/cancelled/i)
    await expect(shutdown).resolves.toBeUndefined()
    expect(fakeSession.session.protocol.unhandle).toHaveBeenCalledTimes(1)
    expect(fakeContents.listenerCount('will-navigate')).toBe(0)
  })

  it('retries a transient protocol-unhandle failure during strict bridge cleanup', async () => {
    const fakeSession = makeFakeSession()
    fakeSession.session.protocol.unhandle.mockRejectedValueOnce(new Error('busy'))
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)

    await expect(bridge.shutdown(input)).resolves.toBeUndefined()
    expect(fakeSession.session.protocol.unhandle).toHaveBeenCalledTimes(2)
  })

  it('retains a twice-failed protocol unhandle for a later successful shutdown retry', async () => {
    const fakeSession = makeFakeSession()
    fakeSession.session.protocol.unhandle
      .mockRejectedValueOnce(new Error('busy-one'))
      .mockRejectedValueOnce(new Error('busy-two'))
    const fakeContents = makeFakeContents(fakeSession.session)
    const fakeSurface = makeFakeSurface(fakeContents.contents, fakeContents.destroy)
    const bridge = new ElectronEmulatorRuntimeBridge({ registry })
    const input = {
      gameId: 'homebrew-demo' as const,
      url: emulatorEntryUrl('homebrew-demo'),
      surface: fakeSurface.surface
    }
    await bridge.boot(input)

    await expect(bridge.shutdown(input)).rejects.toThrow('busy-two')
    await expect(bridge.shutdown(input)).resolves.toBeUndefined()
    expect(fakeSession.session.protocol.unhandle).toHaveBeenCalledTimes(3)
  })
})
