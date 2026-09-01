import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasEmulatorAtomicObservation } from '../canvas/CanvasEmulatorDriver'
import {
  PACKAGE_EMULATOR_SMOKE_ARG,
  PACKAGE_EMULATOR_SMOKE_RESULT_ARG,
  PACKAGE_EMULATOR_SMOKE_RESULT_FILE,
  PACKAGE_EMULATOR_SMOKE_SESSION_ID,
  resolvePackagedEmulatorSmokeLaunch,
  runPackagedEmulatorSmoke,
  startPackagedEmulatorSmoke,
  writePackagedEmulatorSmokeResultAtomically,
  type PackagedEmulatorSmokeDriver,
  type PackagedEmulatorSmokeResultFileOps
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

function smokeArgs(profile: string): string[] {
  return [
    PACKAGE_EMULATOR_SMOKE_ARG,
    `${PACKAGE_EMULATOR_SMOKE_RESULT_ARG}${profile}/${PACKAGE_EMULATOR_SMOKE_RESULT_FILE}`
  ]
}

function smokePosture(profile: string) {
  return {
    kind: 'package-smoke' as const,
    isPackaged: true as const,
    isPrivateProfile: true as const,
    appName: 'TaskWraith Package Smoke' as const,
    userDataPath: profile
  }
}

function memoryFileOps(initial: Readonly<Record<string, string>> = {}) {
  const files = new Map(Object.entries(initial))
  const operations: string[] = []
  const writes: Array<{
    path: string
    data: string
    options: { encoding: 'utf8'; mode: number; flag: 'wx' }
  }> = []
  const fileOps: PackagedEmulatorSmokeResultFileOps = {
    unlink: vi.fn(async (filePath: string) => {
      operations.push(`unlink:${filePath}`)
      if (files.delete(filePath)) return
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }),
    writeFile: vi.fn(async (filePath: string, data: string, options) => {
      operations.push(`write:${filePath}`)
      writes.push({ path: filePath, data, options })
      files.set(filePath, data)
    }),
    rename: vi.fn(async (from: string, to: string) => {
      operations.push(`rename:${from}:${to}`)
      const data = files.get(from)
      if (data === undefined) throw new Error('temporary result is absent')
      files.delete(from)
      files.set(to, data)
    })
  }
  return { fileOps, files, operations, writes }
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

  it('is inert with no smoke flag and fails closed for invalid smoke posture/path', async () => {
    const profile = '/private/tmp/taskwraith-tui-package-smoke-inert'
    const memory = memoryFileOps()
    const exits: number[] = []
    const createDriver = vi.fn(() => driverFixture().driver)
    const common = {
      isPackaged: true,
      mainWindow: { isDestroyed: () => false, webContents: { id: 41 } },
      createDriver,
      isSurfaceLive: () => false,
      exit: (code: 0 | 1) => exits.push(code),
      fileOps: memory.fileOps,
      createTemporaryPath: (resultPath: string) =>
        path.join(path.dirname(resultPath), `.${path.basename(resultPath)}.unit.tmp`)
    }

    await expect(
      startPackagedEmulatorSmoke({ ...common, argv: [], posture: smokePosture(profile) })
    ).resolves.toBe(false)
    await expect(
      startPackagedEmulatorSmoke({
        ...common,
        argv: smokeArgs(profile),
        posture: { kind: 'production', isPackaged: true, isPrivateProfile: false }
      })
    ).resolves.toBe(true)
    await expect(
      startPackagedEmulatorSmoke({
        ...common,
        argv: [PACKAGE_EMULATOR_SMOKE_ARG],
        posture: smokePosture(profile)
      })
    ).resolves.toBe(true)
    await expect(
      startPackagedEmulatorSmoke({
        ...common,
        argv: [
          PACKAGE_EMULATOR_SMOKE_ARG,
          `${PACKAGE_EMULATOR_SMOKE_RESULT_ARG}${profile}/not-the-fixed-result.json`
        ],
        posture: smokePosture(profile)
      })
    ).resolves.toBe(true)
    await expect(
      startPackagedEmulatorSmoke({
        ...common,
        argv: smokeArgs(profile),
        posture: smokePosture(profile),
        isPackaged: false
      })
    ).resolves.toBe(true)

    expect(createDriver).not.toHaveBeenCalled()
    expect(exits).toEqual([1, 1, 1, 1])
    expect(memory.operations).toEqual([])
  })

  it('requires a live packaged main window before it constructs the driver', async () => {
    const profile = '/private/tmp/taskwraith-tui-package-smoke-unavailable'
    const resultPath = `${profile}/${PACKAGE_EMULATOR_SMOKE_RESULT_FILE}`
    const temporaryPath = `${profile}/.${PACKAGE_EMULATOR_SMOKE_RESULT_FILE}.unit.tmp`
    const memory = memoryFileOps()
    const exits: number[] = []
    const createDriver = vi.fn(() => driverFixture().driver)

    await expect(
      startPackagedEmulatorSmoke({
        argv: smokeArgs(profile),
        posture: smokePosture(profile),
        isPackaged: true,
        mainWindow: null,
        createDriver,
        isSurfaceLive: () => false,
        exit: (code) => exits.push(code),
        fileOps: memory.fileOps,
        createTemporaryPath: () => temporaryPath
      })
    ).resolves.toBe(true)

    expect(createDriver).not.toHaveBeenCalled()
    expect(exits).toEqual([1])
    expect(memory.files.get(resultPath)).toBe('{"ok":false,"error":"emulator_smoke_unavailable"}')
  })

  it('atomically publishes a safe success receipt, then exits zero', async () => {
    const profile = '/private/tmp/taskwraith-tui-package-smoke-success'
    const resultPath = `${profile}/${PACKAGE_EMULATOR_SMOKE_RESULT_FILE}`
    const temporaryPath = `${profile}/.${PACKAGE_EMULATOR_SMOKE_RESULT_FILE}.unit.tmp`
    const memory = memoryFileOps({ [resultPath]: '{"old":true}' })
    const fixture = driverFixture()
    const exits: number[] = []

    await expect(
      startPackagedEmulatorSmoke({
        argv: smokeArgs(profile),
        posture: smokePosture(profile),
        isPackaged: true,
        mainWindow: { isDestroyed: () => false, webContents: { id: 41 } },
        createDriver: vi.fn(() => fixture.driver),
        isSurfaceLive: () => false,
        exit: (code) => exits.push(code),
        fileOps: memory.fileOps,
        createTemporaryPath: () => temporaryPath
      })
    ).resolves.toBe(true)

    expect(exits).toEqual([0])
    expect(memory.operations).toEqual([
      `unlink:${resultPath}`,
      `write:${temporaryPath}`,
      `rename:${temporaryPath}:${resultPath}`
    ])
    expect(memory.writes).toEqual([
      expect.objectContaining({
        path: temporaryPath,
        options: { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      })
    ])
    expect(memory.files.has(temporaryPath)).toBe(false)
    const result = JSON.parse(memory.files.get(resultPath) ?? '') as Record<string, unknown>
    expect(result).toMatchObject({ ok: true, receipt: { resourceReleased: true } })
    expect(JSON.stringify(result)).not.toContain(PNG.toString('base64'))
  })

  it('publishes a bounded failure and exits one without persisting a raw runtime error', async () => {
    const profile = '/private/tmp/taskwraith-tui-package-smoke-failure'
    const resultPath = `${profile}/${PACKAGE_EMULATOR_SMOKE_RESULT_FILE}`
    const temporaryPath = `${profile}/.${PACKAGE_EMULATOR_SMOKE_RESULT_FILE}.unit.tmp`
    const memory = memoryFileOps()
    const exits: number[] = []

    await expect(
      startPackagedEmulatorSmoke({
        argv: smokeArgs(profile),
        posture: smokePosture(profile),
        isPackaged: true,
        mainWindow: { isDestroyed: () => false, webContents: { id: 41 } },
        createDriver: () => {
          throw new Error('private wasm failure: never persist this')
        },
        isSurfaceLive: () => false,
        exit: (code) => exits.push(code),
        fileOps: memory.fileOps,
        createTemporaryPath: () => temporaryPath
      })
    ).resolves.toBe(true)

    expect(exits).toEqual([1])
    expect(memory.files.get(resultPath)).toBe('{"ok":false,"error":"emulator_smoke_failed"}')
    expect(memory.files.get(resultPath)).not.toContain('private wasm failure')
  })

  it('logs a bounded failure line to the optional logger without widening the disk envelope', async () => {
    const profile = '/private/tmp/taskwraith-tui-package-smoke-logged'
    const resultPath = `${profile}/${PACKAGE_EMULATOR_SMOKE_RESULT_FILE}`
    const temporaryPath = `${profile}/.${PACKAGE_EMULATOR_SMOKE_RESULT_FILE}.unit.tmp`
    const memory = memoryFileOps()
    const exits: number[] = []
    const error = vi.fn()

    await expect(
      startPackagedEmulatorSmoke({
        argv: smokeArgs(profile),
        posture: smokePosture(profile),
        isPackaged: true,
        mainWindow: { isDestroyed: () => false, webContents: { id: 41 } },
        createDriver: () => {
          throw new Error('private wasm failure: never persist this')
        },
        isSurfaceLive: () => false,
        exit: (code) => exits.push(code),
        fileOps: memory.fileOps,
        createTemporaryPath: () => temporaryPath,
        logger: { error }
      })
    ).resolves.toBe(true)

    expect(exits).toEqual([1])
    expect(error).toHaveBeenCalledOnce()
    expect(String(error.mock.calls[0][0])).toContain('emulator smoke failed')
    expect(String(error.mock.calls[0][0])).toContain('private wasm failure: never persist this')
    expect(memory.files.get(resultPath)).toBe('{"ok":false,"error":"emulator_smoke_failed"}')
    expect(memory.files.get(resultPath)).not.toContain('private wasm failure')
  })

  it('names the failing lifecycle phase on a rejected smoke step', async () => {
    const fixture = driverFixture()
    let released = false
    fixture.close.mockImplementation(async () => {
      released = true
    })
    fixture.driver.open = vi.fn(async () => {
      throw new Error('wasm boot refused')
    })

    await expect(
      runPackagedEmulatorSmoke({
        createDriver: () => fixture.driver,
        isSurfaceLive: () => !released,
        surfaceHostId: 41
      })
    ).rejects.toThrow(/\[emulator-smoke\] phase=open: wasm boot refused/)
    expect(fixture.close).toHaveBeenCalledOnce()
  })

  it('cleans a temporary receipt when its exclusive write fails', async () => {
    const profile = '/private/tmp/taskwraith-tui-package-smoke-cleanup'
    const resultPath = `${profile}/${PACKAGE_EMULATOR_SMOKE_RESULT_FILE}`
    const temporaryPath = `${profile}/.${PACKAGE_EMULATOR_SMOKE_RESULT_FILE}.unit.tmp`
    const operations: string[] = []
    const fileOps: PackagedEmulatorSmokeResultFileOps = {
      unlink: vi.fn(async (filePath: string) => {
        operations.push(`unlink:${filePath}`)
      }),
      writeFile: vi.fn(async (filePath: string) => {
        operations.push(`write:${filePath}`)
        throw new Error('disk full')
      }),
      rename: vi.fn(async () => {
        throw new Error('must not rename after a failed write')
      })
    }

    await expect(
      writePackagedEmulatorSmokeResultAtomically({
        resultPath,
        result: { ok: false, error: 'emulator_smoke_failed' },
        fileOps,
        createTemporaryPath: () => temporaryPath
      })
    ).rejects.toThrow('disk full')
    expect(operations).toEqual([`write:${temporaryPath}`, `unlink:${temporaryPath}`])
  })

  it('refuses a temporary receipt path outside the admitted private result directory', async () => {
    const profile = '/private/tmp/taskwraith-tui-package-smoke-temp-path'
    const resultPath = `${profile}/${PACKAGE_EMULATOR_SMOKE_RESULT_FILE}`
    const memory = memoryFileOps()

    await expect(
      writePackagedEmulatorSmokeResultAtomically({
        resultPath,
        result: { ok: false, error: 'emulator_smoke_failed' },
        fileOps: memory.fileOps,
        createTemporaryPath: () => '/private/tmp/outside-emulator-smoke.tmp'
      })
    ).rejects.toThrow(/temporary receipt path is invalid/i)
    expect(memory.operations).toEqual([])
  })

  it('registers the sole extracted hook after createWindow and before normal scheduling', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
    const created = source.indexOf(
      'if (!openedForDeferredSecondInstance && !tuiHeadlessHostSession.isHeadless) createWindow()'
    )
    const hook = source.indexOf(
      'const packagedEmulatorSmokeHandled = await startPackagedEmulatorSmoke({'
    )
    const schedule = source.indexOf('scheduleNextTaskTimer()', hook)

    expect(created).toBeGreaterThan(-1)
    expect(hook).toBeGreaterThan(created)
    expect(schedule).toBeGreaterThan(hook)
    expect(source.match(/startPackagedEmulatorSmoke\(\{/g)).toHaveLength(1)
    expect(source).toContain('if (packagedEmulatorSmokeHandled) return')
    expect(source).not.toContain('resolvePackagedEmulatorSmokeLaunch')
    expect(source).toContain('isSurfaceLive: (canvasId) => canvasEmbedController.has(canvasId)')
  })
})
