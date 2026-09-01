import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasEmulatorAtomicObservation } from '../canvas/CanvasEmulatorDriver'
import {
  PACKAGE_EMULATOR_SMOKE_ARG,
  PACKAGE_EMULATOR_SMOKE_RESULT_ARG,
  PACKAGE_EMULATOR_SMOKE_RESULT_FILE,
  PACKAGE_EMULATOR_SMOKE_SESSION_ID,
  resolvePackagedEmulatorSmokeLaunch,
  runPackagedEmulatorSmoke,
  type PackagedEmulatorSmokeDriver
} from './PackagedEmulatorSmoke'

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0xa0, 0x00, 0x00, 0x00, 0x90, 0x08
])
const PNG_AFTER = Buffer.concat([PNG, Buffer.from([1])])

function observation(input: {
  observationId: string
  frameId: number
  x: number
  input: number
  frameCounter: number
  png?: Buffer
}): CanvasEmulatorAtomicObservation {
  const png = input.png ?? PNG
  return {
    schemaVersion: 1,
    observationId: input.observationId,
    emulationGeneration: 4,
    frameId: input.frameId,
    inputEpoch: 0,
    humanActive: false,
    capturedAt: '2026-09-01T00:00:00.000Z',
    frame: {
      mimeType: 'image/png',
      data: png.toString('base64'),
      width: 160,
      height: 144,
      byteLength: png.byteLength,
      hash: createHash('sha256').update(png).digest('hex'),
      capturedAt: '2026-09-01T00:00:00.000Z'
    },
    mappedState: {
      kind: 'mapped',
      adapterId: 'twgb-state-window',
      adapterRevision: 'v1',
      schemaSha256: 'b'.repeat(64),
      fields: [
        { key: 'x', kind: 'integer', value: input.x, unit: 'px' },
        { key: 'y', kind: 'integer', value: 72, unit: 'px' },
        { key: 'input', kind: 'integer', value: input.input, unit: 'mask' },
        { key: 'frame-counter', kind: 'integer', value: input.frameCounter, unit: 'frames' }
      ],
      truncated: false
    }
  }
}

function driverFixture(): { driver: PackagedEmulatorSmokeDriver; close: ReturnType<typeof vi.fn> } {
  const before = observation({
    observationId: 'obs:before',
    frameId: 9,
    x: 80,
    input: 0,
    frameCounter: 9
  })
  const after = observation({
    observationId: 'obs:after',
    frameId: 10,
    x: 81,
    input: 0x10,
    frameCounter: 10,
    png: PNG_AFTER
  })
  const close = vi.fn(async () => {})
  return {
    close,
    driver: {
      open: vi.fn(async () => ({
        url: 'twemu://app/homebrew-demo/index.html',
        title: 'Homebrew emulator',
        viewport: { width: 1280, height: 800 }
      })),
      observeEmulator: vi.fn(async () => before),
      stepEmulator: vi.fn(async () => after),
      close
    }
  }
}

describe('PackagedEmulatorSmoke', () => {
  it('admits only the exact result filename inside the already-private smoke profile', () => {
    const profile = '/private/tmp/taskwraith-tui-package-smoke-unit'
    const argv = [
      PACKAGE_EMULATOR_SMOKE_ARG,
      `${PACKAGE_EMULATOR_SMOKE_RESULT_ARG}${profile}/${PACKAGE_EMULATOR_SMOKE_RESULT_FILE}`
    ]
    expect(
      resolvePackagedEmulatorSmokeLaunch(argv, {
        kind: 'package-smoke',
        isPackaged: true,
        isPrivateProfile: true,
        appName: 'TaskWraith Package Smoke',
        userDataPath: profile
      })
    ).toEqual({ resultPath: `${profile}/${PACKAGE_EMULATOR_SMOKE_RESULT_FILE}` })
    expect(
      resolvePackagedEmulatorSmokeLaunch(
        [PACKAGE_EMULATOR_SMOKE_ARG, `${PACKAGE_EMULATOR_SMOKE_RESULT_ARG}${profile}/other.json`],
        {
          kind: 'package-smoke',
          isPackaged: true,
          isPrivateProfile: true,
          appName: 'TaskWraith Package Smoke',
          userDataPath: profile
        }
      )
    ).toBeNull()
    expect(
      resolvePackagedEmulatorSmokeLaunch(argv, {
        kind: 'production',
        isPackaged: true,
        isPrivateProfile: false
      })
    ).toBeNull()
  })

  it('observes the real fixed contract, performs one Right frame, and releases the surface', async () => {
    const fixture = driverFixture()
    let released = false
    fixture.close.mockImplementation(async () => {
      released = true
    })
    const createDriver = vi.fn(() => fixture.driver)

    const receipt = await runPackagedEmulatorSmoke({
      createDriver,
      isSurfaceLive: () => !released,
      surfaceHostId: 41
    })

    expect(createDriver).toHaveBeenCalledWith({
      sessionId: PACKAGE_EMULATOR_SMOKE_SESSION_ID,
      embedded: true,
      gameId: 'homebrew-demo',
      surfaceHostId: 41
    })
    expect(fixture.driver.open).toHaveBeenCalledWith({
      driver: 'emulator',
      gameId: 'homebrew-demo',
      embed: true,
      presentation: 'dock'
    })
    expect(fixture.driver.stepEmulator).toHaveBeenCalledWith(['right'], 'obs:before')
    expect(fixture.close).toHaveBeenCalledOnce()
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      sessionId: PACKAGE_EMULATOR_SMOKE_SESSION_ID,
      entryUrl: 'twemu://app/homebrew-demo/index.html',
      before: { frameId: 9, x: 80, frameCounter: 9, frame: { width: 160, height: 144 } },
      after: { frameId: 10, x: 81, frameCounter: 10, frame: { width: 160, height: 144 } },
      resourceReleased: true
    })
    expect(receipt).not.toHaveProperty('data')
    expect(JSON.stringify(receipt)).not.toContain(PNG.toString('base64'))
  })

  it('hash-binds canonical PNG bytes and still tears down a forged atomic receipt', async () => {
    const fixture = driverFixture()
    let released = false
    fixture.close.mockImplementation(async () => {
      released = true
    })
    fixture.driver.observeEmulator = vi.fn(async () =>
      observation({ observationId: 'obs:bad', frameId: 9, x: 80, input: 0, frameCounter: 9 })
    )
    const malformed = await fixture.driver.observeEmulator()
    Object.assign(malformed.frame, { hash: 'f'.repeat(64) })
    fixture.driver.observeEmulator = vi.fn(async () => malformed)

    await expect(
      runPackagedEmulatorSmoke({
        createDriver: () => fixture.driver,
        isSurfaceLive: () => !released,
        surfaceHostId: 41
      })
    ).rejects.toThrow(/invalid atomic before observation/i)
    expect(fixture.close).toHaveBeenCalledOnce()
  })
})
