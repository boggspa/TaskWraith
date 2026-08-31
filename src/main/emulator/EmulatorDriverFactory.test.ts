import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasHostSurface, CanvasSurfaceOptions } from '../canvas/CanvasHostSurface'
import type { CanvasEmulatorRuntimeBridge } from '../canvas/CanvasEmulatorDriver'
import {
  canonicalEmulatorStateAdapterSchemaJson,
  validateEmulatorPackageManifest,
  validateEmulatorStateAdapterManifest,
  type EmulatorPackageManifest
} from '../../shared/emulatorCanvas'
import {
  BUILT_IN_EMULATOR_GAME_ID,
  createEmulatorCanvasDriverFactory
} from './EmulatorDriverFactory'
import type { EmulatorAssetBundle } from './EmulatorAssetManifest'
import type { ElectronEmulatorRuntimeBridgeDeps } from './ElectronEmulatorRuntimeBridge'
import {
  TWGB_CORE_SHA256,
  TWGB_PACKAGE_CORE_ID,
  TWGB_ROM_SHA256,
  TWGB_RUNTIME_WASM_SHA256
} from './EmulatorPackageManifest'

const HASH = 'a'.repeat(64)

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function packageManifest(): EmulatorPackageManifest {
  const untrustedAdapter = {
    schemaVersion: 2,
    adapterId: 'twgb-state-window',
    adapterRevision: 'v1',
    schemaSha256: '0'.repeat(64),
    coreId: TWGB_PACKAGE_CORE_ID,
    romSha256: TWGB_ROM_SHA256,
    memoryBytes: 13,
    stateWindow: { source: 'system_ram', startAddress: 0xc100, byteLength: 13 },
    fields: [
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
  }
  const validatedAdapter = validateEmulatorStateAdapterManifest(untrustedAdapter)
  if (!validatedAdapter.ok) throw new Error(validatedAdapter.reason)
  const validated = validateEmulatorPackageManifest({
    schemaVersion: 2,
    gameId: 'homebrew-demo',
    coreId: TWGB_PACKAGE_CORE_ID,
    coreSha256: TWGB_CORE_SHA256,
    runtimeWasmSha256: TWGB_RUNTIME_WASM_SHA256,
    romSha256: TWGB_ROM_SHA256,
    stateAdapter: {
      ...untrustedAdapter,
      schemaSha256: hash(canonicalEmulatorStateAdapterSchemaJson(validatedAdapter.value))
    }
  })
  if (!validated.ok) throw new Error(validated.reason)
  return validated.value
}

function bundle(rootPath: string): EmulatorAssetBundle {
  return {
    rootPath,
    manifest: {
      schemaVersion: 1,
      gameId: 'homebrew-demo',
      entryPath: 'index.html',
      assets: [
        {
          path: 'index.html',
          sha256: HASH,
          byteLength: 1,
          mimeType: 'text/html'
        },
        {
          path: 'twgb.wasm',
          sha256: TWGB_RUNTIME_WASM_SHA256,
          byteLength: 1,
          mimeType: 'application/wasm'
        }
      ]
    }
  }
}

function fakeSurface(): CanvasHostSurface {
  return {
    webContents: { capturePage: vi.fn() } as never,
    getTitle: () => 'Fixture',
    setContentSize: vi.fn(),
    isDestroyed: () => false,
    destroy: vi.fn(),
    onClosed: vi.fn()
  }
}

describe('createEmulatorCanvasDriverFactory', () => {
  it('loads the reviewed bundle lazily once and creates a real emulator driver', () => {
    const loadBundle = vi.fn((rootPath: string) => bundle(rootPath))
    const loadPackage = vi.fn((_rootPath: string) => packageManifest())
    const instantiateSurface = vi.fn((_options: CanvasSurfaceOptions) => fakeSurface())
    const createSurface = vi.fn(() => instantiateSurface)
    const createDriver = createEmulatorCanvasDriverFactory({
      appPath: '/repo',
      resourcesPath: '/Applications/TaskWraith.app/Contents/Resources',
      isPackaged: false,
      createSurface,
      loadBundle,
      loadPackage
    })

    const first = createDriver({
      sessionId: 'canvas-a',
      embedded: true,
      surfaceHostId: 42,
      gameId: BUILT_IN_EMULATOR_GAME_ID
    })
    const second = createDriver({ sessionId: 'canvas-b', embedded: true })

    expect(first.kind).toBe('emulator')
    expect(second.kind).toBe('emulator')
    expect(loadBundle).toHaveBeenCalledTimes(1)
    expect(loadBundle).toHaveBeenCalledWith('/repo/resources/emulator/homebrew-demo')
    expect(loadPackage).toHaveBeenCalledWith('/repo/resources/emulator/homebrew-demo')
    expect(createSurface).toHaveBeenNthCalledWith(1, 'canvas-a', 42)
    expect(createSurface).toHaveBeenNthCalledWith(2, 'canvas-b', undefined)
    expect(instantiateSurface).not.toHaveBeenCalled()
  })

  it('uses the explicit packaged extraResources root', () => {
    const loadBundle = vi.fn((rootPath: string) => bundle(rootPath))
    const loadPackage = vi.fn((_rootPath: string) => packageManifest())
    const createDriver = createEmulatorCanvasDriverFactory({
      appPath: '/Applications/TaskWraith.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/TaskWraith.app/Contents/Resources',
      isPackaged: true,
      createSurface: () => () => fakeSurface(),
      loadBundle,
      loadPackage
    })

    createDriver({ sessionId: 'canvas-packaged', embedded: true })
    expect(loadBundle).toHaveBeenCalledWith(
      '/Applications/TaskWraith.app/Contents/Resources/emulator/homebrew-demo'
    )
    expect(loadPackage).toHaveBeenCalledWith(
      '/Applications/TaskWraith.app/Contents/Resources/emulator/homebrew-demo'
    )
  })

  it('rejects floating and unreviewed-game requests before loading assets', () => {
    const loadBundle = vi.fn((rootPath: string) => bundle(rootPath))
    const createDriver = createEmulatorCanvasDriverFactory({
      appPath: '/repo',
      resourcesPath: '/resources',
      isPackaged: false,
      createSurface: () => () => fakeSurface(),
      loadBundle,
      loadPackage: () => packageManifest()
    })

    expect(() => createDriver({ sessionId: 'floating', embedded: false })).toThrow(/embedded/i)
    expect(() =>
      createDriver({ sessionId: 'foreign', embedded: true, gameId: 'foreign' as never })
    ).toThrow(/unreviewed/i)
    expect(loadBundle).not.toHaveBeenCalled()
  })

  it('does not cache a failed bundle load', () => {
    const loadBundle = vi
      .fn<(rootPath: string) => EmulatorAssetBundle>()
      .mockImplementationOnce(() => {
        throw new Error('bundle unavailable')
      })
      .mockImplementation((rootPath) => bundle(rootPath))
    const createDriver = createEmulatorCanvasDriverFactory({
      appPath: '/repo',
      resourcesPath: '/resources',
      isPackaged: false,
      createSurface: () => () => fakeSurface(),
      loadBundle,
      loadPackage: () => packageManifest()
    })

    expect(() => createDriver({ sessionId: 'first', embedded: true })).toThrow('bundle unavailable')
    expect(createDriver({ sessionId: 'second', embedded: true }).kind).toBe('emulator')
    expect(loadBundle).toHaveBeenCalledTimes(2)
  })

  it('rejects a bundle whose manifest does not match the built-in game', () => {
    const createDriver = createEmulatorCanvasDriverFactory({
      appPath: '/repo',
      resourcesPath: '/resources',
      isPackaged: false,
      createSurface: () => () => fakeSurface(),
      loadPackage: () => packageManifest(),
      loadBundle: (rootPath) => ({
        ...bundle(rootPath),
        manifest: { ...bundle(rootPath).manifest, gameId: 'foreign' as never }
      })
    })

    expect(() => createDriver({ sessionId: 'mismatch', embedded: true })).toThrow(/does not match/i)
  })

  it('retires a crashed surface once when fatal and host-close signals race', async () => {
    let onFatal: ElectronEmulatorRuntimeBridgeDeps['onFatal']
    const onSurfaceClosed = vi.fn()
    const surface = {
      ...fakeSurface(),
      onClosed: vi.fn((_listener: () => void) => {})
    }
    const runtime: CanvasEmulatorRuntimeBridge = {
      boot: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {})
    }
    const createDriver = createEmulatorCanvasDriverFactory({
      appPath: '/repo',
      resourcesPath: '/resources',
      isPackaged: false,
      createSurface: () => () => surface,
      loadBundle: (rootPath) => bundle(rootPath),
      loadPackage: () => packageManifest(),
      createRuntime: (deps) => {
        onFatal = deps.onFatal
        return runtime
      }
    })
    const driver = createDriver({ sessionId: 'fatal', embedded: true, onSurfaceClosed })
    await driver.open({
      driver: 'emulator',
      gameId: 'homebrew-demo',
      embed: true,
      presentation: 'dock'
    })

    onFatal?.({ surface, reason: new Error('renderer gone') })
    const hostClosed = surface.onClosed.mock.calls[0]?.[0]
    if (!hostClosed) throw new Error('Driver did not subscribe to host close.')
    hostClosed()
    onFatal?.({ surface, reason: new Error('duplicate') })

    expect(onSurfaceClosed).toHaveBeenCalledTimes(1)
  })

  it('does not cache a rejected package descriptor', () => {
    const loadPackage = vi
      .fn<() => EmulatorPackageManifest>()
      .mockImplementationOnce(() => ({ ...packageManifest(), runtimeWasmSha256: HASH }))
      .mockImplementation(() => packageManifest())
    const createDriver = createEmulatorCanvasDriverFactory({
      appPath: '/repo',
      resourcesPath: '/resources',
      isPackaged: false,
      createSurface: () => () => fakeSurface(),
      loadBundle: (rootPath) => bundle(rootPath),
      loadPackage
    })

    expect(() => createDriver({ sessionId: 'bad-package', embedded: true })).toThrow(
      /runtimeWasmSha256/
    )
    expect(createDriver({ sessionId: 'repaired-package', embedded: true }).kind).toBe('emulator')
    expect(loadPackage).toHaveBeenCalledTimes(2)
  })
})
