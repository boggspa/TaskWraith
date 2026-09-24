import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  CanvasEmulatorDriver,
  CanvasEmulatorInputEpochStaleError,
  CanvasEmulatorObservationStaleError,
  CanvasEmulatorUserActiveError,
  type CanvasEmulatorAtomicObservation,
  type CanvasEmulatorObservationRuntimeBridge,
  type CanvasEmulatorRuntimeBridge
} from './CanvasEmulatorDriver'
import type { CanvasHostSurface } from './CanvasHostSurface'
import type { CanvasDriver } from './canvasTypes'

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x03
])

function fakeSurface(title = 'Homebrew Demo') {
  let destroyed = false
  let onClosed: (() => void) | null = null
  const capturePage = vi.fn(async () => ({ toPNG: () => PNG }))
  const surface: CanvasHostSurface = {
    webContents: { capturePage } as unknown as CanvasHostSurface['webContents'],
    getTitle: vi.fn(() => title),
    setContentSize: vi.fn(),
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {
      destroyed = true
    }),
    onClosed: (listener) => {
      onClosed = listener
    }
  }
  return {
    surface,
    capturePage,
    fireHostClose: () => {
      destroyed = true
      onClosed?.()
    }
  }
}

function runtime(): CanvasEmulatorRuntimeBridge & {
  boot: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
} {
  return {
    boot: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {})
  }
}

function atomicObservation(
  overrides: Partial<CanvasEmulatorAtomicObservation> = {}
): CanvasEmulatorAtomicObservation {
  const capturedAt = '2026-08-31T19:00:00.000Z'
  return {
    schemaVersion: 1,
    observationId: 'obs:canvas:1',
    emulationGeneration: 1,
    frameId: 9,
    inputEpoch: 4,
    humanActive: false,
    capturedAt,
    frame: {
      mimeType: 'image/png',
      data: PNG.toString('base64'),
      width: 4,
      height: 3,
      byteLength: PNG.byteLength,
      hash: createHash('sha256').update(PNG).digest('hex'),
      capturedAt
    },
    mappedState: {
      kind: 'mapped',
      adapterId: 'twgb-state-window',
      adapterRevision: 'v1',
      schemaSha256: 'a'.repeat(64),
      fields: [
        { key: 'x', kind: 'integer', value: 12, unit: 'px' },
        { key: 'y', kind: 'integer', value: 8, unit: 'px' },
        { key: 'input', kind: 'integer', value: 0, unit: 'mask' },
        { key: 'frame-counter', kind: 'integer', value: 9, unit: 'frames' }
      ],
      truncated: false
    },
    ...overrides
  }
}

function observationRuntime(): CanvasEmulatorObservationRuntimeBridge & {
  boot: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  observe: ReturnType<typeof vi.fn>
  step: ReturnType<typeof vi.fn>
} {
  return {
    boot: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    observe: vi.fn(async () => atomicObservation()),
    step: vi.fn(async () => atomicObservation({ frameId: 10, inputEpoch: 4 }))
  }
}

describe('CanvasEmulatorDriver', () => {
  it('is a real internal CanvasDriver that boots a fixed entry URL in an injected live surface', async () => {
    const host = fakeSurface()
    const bridge = runtime()
    const createSurface = vi.fn(() => host.surface)
    const driver: CanvasDriver = new CanvasEmulatorDriver('canvas-1', {
      createSurface,
      runtime: bridge,
      now: () => '2026-08-31T16:00:00.000Z'
    })

    const opened = await driver.open({ driver: 'emulator', gameId: 'homebrew-demo' })

    expect(driver.kind).toBe('emulator')
    expect(createSurface).toHaveBeenCalledWith({
      partition: 'canvas-emulator-canvas-1',
      kind: 'emulator',
      width: 1280,
      height: 800
    })
    expect(bridge.boot).toHaveBeenCalledWith({
      gameId: 'homebrew-demo',
      url: 'twemu://app/homebrew-demo/index.html',
      surface: host.surface
    })
    expect(opened).toEqual({
      url: 'twemu://app/homebrew-demo/index.html',
      title: 'Homebrew Demo',
      viewport: { width: 1280, height: 800 }
    })
  })

  it('captures PNG pixels from its same live surface and closes both bridge and host once', async () => {
    const host = fakeSurface()
    const bridge = runtime()
    const driver = new CanvasEmulatorDriver('canvas-2', {
      createSurface: () => host.surface,
      runtime: bridge,
      now: () => '2026-08-31T16:01:00.000Z'
    })
    await driver.open({ driver: 'emulator' })

    const frame = await driver.screenshot()
    expect(host.capturePage).toHaveBeenCalledOnce()
    expect(frame).toMatchObject({
      mimeType: 'image/png',
      width: 4,
      height: 3,
      byteLength: PNG.byteLength,
      hash: createHash('sha256').update(PNG).digest('hex'),
      capturedAt: '2026-08-31T16:01:00.000Z'
    })
    expect(frame.data).toBe(PNG.toString('base64'))

    await driver.resize({ width: 640, height: 480 })
    expect(host.surface.setContentSize).toHaveBeenCalledWith(640, 480)
    await driver.close()
    await driver.close()
    expect(bridge.shutdown).toHaveBeenCalledTimes(1)
    expect(host.surface.destroy).toHaveBeenCalledTimes(1)
  })

  it('keeps internal observation and one-frame input behind a guarded runtime extension', async () => {
    const host = fakeSurface()
    const bridge = observationRuntime()
    const driver = new CanvasEmulatorDriver('canvas-observe', {
      createSurface: () => host.surface,
      runtime: bridge
    })
    await driver.open({ driver: 'emulator' })

    await expect(driver.stepEmulator(['right'])).rejects.toThrow(/Observe the emulator/i)
    const observed = await driver.observeEmulator()
    const stepped = await driver.stepEmulator(['right'])

    expect(observed.observationId).toBe('obs:canvas:1')
    expect(observed.mappedState).toMatchObject({ kind: 'mapped' })
    expect(observed).not.toHaveProperty('state')
    expect(observed).not.toHaveProperty('abiWindow')
    expect(bridge.observe).toHaveBeenCalledWith({ gameId: 'homebrew-demo', surface: host.surface })
    expect(bridge.step).toHaveBeenCalledWith({
      gameId: 'homebrew-demo',
      surface: host.surface,
      buttons: ['right'],
      expectedFrameId: 9,
      expectedInputEpoch: 4,
      expectedFixtureCounter: 9
    })
    expect(stepped.frameId).toBe(10)
    await expect(driver.stepEmulator(['right'], 'other-observation')).rejects.toBeInstanceOf(
      CanvasEmulatorObservationStaleError
    )
  })

  it('preserves a typed stale human-input refusal from the runtime extension', async () => {
    const host = fakeSurface()
    const bridge = observationRuntime()
    const refreshed = atomicObservation({
      observationId: 'obs:canvas:refreshed',
      frameId: 10,
      inputEpoch: 5
    })
    bridge.step.mockRejectedValueOnce(new CanvasEmulatorInputEpochStaleError(refreshed, 1))
    const driver = new CanvasEmulatorDriver('canvas-stale-input', {
      createSurface: () => host.surface,
      runtime: bridge
    })
    await driver.open({ driver: 'emulator' })
    await driver.observeEmulator()

    await expect(driver.stepEmulator(['right'])).rejects.toMatchObject({
      code: 'stale_input_epoch',
      framesAdvanced: 1
    })
    await driver.stepEmulator(['right'])
    expect(bridge.step).toHaveBeenLastCalledWith({
      gameId: 'homebrew-demo',
      surface: host.surface,
      buttons: ['right'],
      expectedFrameId: 10,
      expectedInputEpoch: 5,
      expectedFixtureCounter: 9
    })
  })

  it('caches the current observation returned with a typed active-human refusal', async () => {
    const host = fakeSurface()
    const bridge = observationRuntime()
    const activeObservation = atomicObservation({
      observationId: 'obs:canvas:human-active',
      frameId: 10,
      inputEpoch: 5,
      humanActive: true
    })
    bridge.step.mockRejectedValueOnce(new CanvasEmulatorUserActiveError(activeObservation, 0))
    const driver = new CanvasEmulatorDriver('canvas-human-active', {
      createSurface: () => host.surface,
      runtime: bridge
    })
    await driver.open({ driver: 'emulator' })
    await driver.observeEmulator()

    await expect(driver.stepEmulator(['right'])).rejects.toMatchObject({
      code: 'user_active',
      framesAdvanced: 0
    })
    await driver.stepEmulator(['right'])
    expect(bridge.step).toHaveBeenLastCalledWith({
      gameId: 'homebrew-demo',
      surface: host.surface,
      buttons: ['right'],
      expectedFrameId: 10,
      expectedInputEpoch: 5,
      expectedFixtureCounter: 9
    })
  })

  it('cleans up a partially booted runtime when opening fails', async () => {
    const host = fakeSurface()
    const bridge = runtime()
    bridge.boot.mockRejectedValueOnce(new Error('WASM boot failed'))
    const driver = new CanvasEmulatorDriver('canvas-3', {
      createSurface: () => host.surface,
      runtime: bridge
    })

    await expect(driver.open({ driver: 'emulator' })).rejects.toThrow('WASM boot failed')
    expect(bridge.shutdown).toHaveBeenCalledWith({ gameId: 'homebrew-demo', surface: host.surface })
    expect(host.surface.destroy).toHaveBeenCalledOnce()
    await expect(driver.screenshot()).rejects.toThrow(/not open/i)
  })

  it('waits for bridge cleanup when the host close immediately asks the driver to close', async () => {
    const host = fakeSurface()
    const bridge = runtime()
    let releaseShutdown!: () => void
    const shutdown = new Promise<void>((resolve) => {
      releaseShutdown = resolve
    })
    bridge.shutdown.mockImplementationOnce(() => shutdown)
    let closeFromHost: Promise<void> | null = null
    const onSurfaceClosed = vi.fn(() => {
      closeFromHost = driver.close()
    })
    const driver = new CanvasEmulatorDriver('canvas-4', {
      createSurface: () => host.surface,
      runtime: bridge,
      onSurfaceClosed
    })
    await driver.open({ driver: 'emulator' })

    host.fireHostClose()
    expect(bridge.shutdown).toHaveBeenCalledOnce()
    expect(onSurfaceClosed).toHaveBeenCalledOnce()
    expect(closeFromHost).not.toBeNull()
    let settled = false
    void closeFromHost!.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseShutdown()
    await closeFromHost
    expect(host.surface.destroy).not.toHaveBeenCalled()
    await expect(driver.open({ driver: 'emulator' })).rejects.toThrow(/was closed/i)
  })

  it('contains the view and resolves close when optional bridge shutdown fails', async () => {
    const host = fakeSurface()
    const bridge = runtime()
    bridge.shutdown.mockRejectedValueOnce(new Error('bridge cleanup failed'))
    const driver = new CanvasEmulatorDriver('canvas-4b', {
      createSurface: () => host.surface,
      runtime: bridge
    })
    await driver.open({ driver: 'emulator' })

    await expect(driver.close()).resolves.toBeUndefined()
    await expect(driver.close()).resolves.toBeUndefined()
    expect(host.surface.destroy).toHaveBeenCalledOnce()
    expect(bridge.shutdown).toHaveBeenCalledOnce()
  })

  it('refuses arbitrary URLs, mismatched games, and generic DOM/eval verbs', async () => {
    const host = fakeSurface()
    const driver = new CanvasEmulatorDriver('canvas-5', {
      createSurface: () => host.surface,
      runtime: runtime()
    })

    await expect(driver.open({ driver: 'emulator', url: 'https://example.test' })).rejects.toThrow(
      /never accepts a URL/i
    )
    await expect(
      driver.open({ driver: 'emulator', gameId: 'other-game' as never })
    ).rejects.toThrow(/unsupported game id/i)

    await driver.open({ driver: 'emulator' })
    await expect(driver.snapshot()).rejects.toThrow(/not available/i)
    await expect(driver.evaluate({ script: '1 + 1' })).rejects.toThrow(/not available/i)
    await expect(driver.act({ kind: 'click', x: 1, y: 1 })).rejects.toThrow(/not available/i)
  })
})
