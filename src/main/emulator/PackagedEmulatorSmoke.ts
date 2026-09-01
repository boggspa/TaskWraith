import { createHash } from 'node:crypto'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { InstanceLaunchPosture } from '../InstanceLaunchPosture'
import type { CanvasEmulatorAtomicObservation } from '../canvas/CanvasEmulatorDriver'
import type { CanvasSessionHandle } from '../canvas/canvasTypes'

/** Opt-in argv understood only by the packaged private-profile smoke path. */
export const PACKAGE_EMULATOR_SMOKE_ARG = '--taskwraith-package-emulator-smoke'
export const PACKAGE_EMULATOR_SMOKE_RESULT_ARG = '--taskwraith-package-emulator-smoke-result='
export const PACKAGE_EMULATOR_SMOKE_RESULT_FILE = 'emulator-package-smoke.json'
export const PACKAGE_EMULATOR_SMOKE_SESSION_ID = 'package-emulator-smoke'

export interface PackagedEmulatorSmokeLaunch {
  readonly resultPath: string
}

export interface PackagedEmulatorSmokeFrameReceipt {
  readonly mimeType: 'image/png'
  readonly width: 160
  readonly height: 144
  readonly byteLength: number
  readonly hash: string
}

export interface PackagedEmulatorSmokeObservationReceipt {
  readonly frameId: number
  readonly emulationGeneration: number
  readonly inputEpoch: number
  readonly x: number
  readonly y: number
  readonly input: number
  readonly frameCounter: number
  readonly frame: PackagedEmulatorSmokeFrameReceipt
}

/** Disk-safe success record; deliberate omission of PNG bytes and RAM windows. */
export interface PackagedEmulatorSmokeReceipt {
  readonly schemaVersion: 1
  readonly sessionId: typeof PACKAGE_EMULATOR_SMOKE_SESSION_ID
  readonly entryUrl: 'twemu://app/homebrew-demo/index.html'
  readonly before: PackagedEmulatorSmokeObservationReceipt
  readonly after: PackagedEmulatorSmokeObservationReceipt
  readonly resourceReleased: true
}

export interface PackagedEmulatorSmokeDriver {
  open(input: {
    driver: 'emulator'
    gameId: 'homebrew-demo'
    embed: true
    presentation: 'dock'
  }): Promise<CanvasSessionHandle>
  observeEmulator(): Promise<CanvasEmulatorAtomicObservation>
  stepEmulator(
    buttons: readonly ['right'],
    expectedObservationId: string
  ): Promise<CanvasEmulatorAtomicObservation>
  close(): Promise<void>
}

export interface RunPackagedEmulatorSmokeInput {
  readonly createDriver: (input: {
    sessionId: typeof PACKAGE_EMULATOR_SMOKE_SESSION_ID
    embedded: true
    gameId: 'homebrew-demo'
    surfaceHostId: number
  }) => PackagedEmulatorSmokeDriver
  /** The main-owned embed controller proves close detached the WebContentsView. */
  readonly isSurfaceLive: (sessionId: string) => boolean
  readonly surfaceHostId: number
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate)
  return (
    Boolean(relation) &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  )
}

/**
 * Admit the private smoke result path only when it is the exact fixed filename
 * under the already-admitted package-smoke profile. No argv can redirect a
 * package launch into writing arbitrary user files.
 */
export function resolvePackagedEmulatorSmokeLaunch(
  argv: readonly string[],
  posture: InstanceLaunchPosture
): PackagedEmulatorSmokeLaunch | null {
  if (posture.kind !== 'package-smoke') return null
  const flagCount = argv.filter((value) => value === PACKAGE_EMULATOR_SMOKE_ARG).length
  const resultArgs = argv.filter(
    (value) => typeof value === 'string' && value.startsWith(PACKAGE_EMULATOR_SMOKE_RESULT_ARG)
  )
  if (flagCount !== 1 || resultArgs.length !== 1) return null

  const resultPath = resultArgs[0].slice(PACKAGE_EMULATOR_SMOKE_RESULT_ARG.length)
  if (!resultPath || basename(resultPath) !== PACKAGE_EMULATOR_SMOKE_RESULT_FILE) return null
  const profileRoot = resolve(posture.userDataPath)
  const candidate = resolve(resultPath)
  if (!isStrictDescendant(profileRoot, candidate)) return null
  if (candidate !== resolve(profileRoot, PACKAGE_EMULATOR_SMOKE_RESULT_FILE)) return null
  return { resultPath: candidate }
}

function requireMappedInteger(
  observation: CanvasEmulatorAtomicObservation,
  key: 'x' | 'y' | 'input' | 'frame-counter'
): number {
  if (observation.mappedState.kind !== 'mapped') {
    throw new Error('Packaged emulator smoke expected the reviewed TWGB state adapter.')
  }
  const matches = observation.mappedState.fields.filter((field) => field.key === key)
  if (matches.length !== 1 || matches[0].kind !== 'integer') {
    throw new Error(`Packaged emulator smoke expected exactly one integer ${key} field.`)
  }
  const value = matches[0].value
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Packaged emulator smoke received an invalid ${key} field.`)
  }
  return value
}

function receiptFor(
  observation: CanvasEmulatorAtomicObservation,
  label: 'before' | 'after'
): PackagedEmulatorSmokeObservationReceipt {
  const frame = observation.frame
  let png: Buffer | null = null
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) {
      throw new Error('not canonical base64')
    }
    png = Buffer.from(frame.data, 'base64')
    if (png.toString('base64') !== frame.data) throw new Error('not a canonical base64 encoding')
  } catch {
    throw new Error(`Packaged emulator smoke received invalid ${label} PNG bytes.`)
  }
  if (
    observation.schemaVersion !== 1 ||
    observation.humanActive ||
    !Number.isSafeInteger(observation.frameId) ||
    observation.frameId <= 0 ||
    !Number.isSafeInteger(observation.emulationGeneration) ||
    observation.emulationGeneration <= 0 ||
    !Number.isSafeInteger(observation.inputEpoch) ||
    observation.inputEpoch < 0 ||
    frame.mimeType !== 'image/png' ||
    frame.width !== 160 ||
    frame.height !== 144 ||
    !Number.isSafeInteger(frame.byteLength) ||
    frame.byteLength <= 24 ||
    !/^[a-f0-9]{64}$/.test(frame.hash) ||
    !png ||
    png.byteLength !== frame.byteLength ||
    !png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    png.subarray(12, 16).toString('ascii') !== 'IHDR' ||
    png.readUInt32BE(16) !== 160 ||
    png.readUInt32BE(20) !== 144 ||
    createHash('sha256').update(png).digest('hex') !== frame.hash
  ) {
    throw new Error(`Packaged emulator smoke received an invalid atomic ${label} observation.`)
  }
  return {
    frameId: observation.frameId,
    emulationGeneration: observation.emulationGeneration,
    inputEpoch: observation.inputEpoch,
    x: requireMappedInteger(observation, 'x'),
    y: requireMappedInteger(observation, 'y'),
    input: requireMappedInteger(observation, 'input'),
    frameCounter: requireMappedInteger(observation, 'frame-counter'),
    frame: {
      mimeType: 'image/png',
      width: 160,
      height: 144,
      byteLength: frame.byteLength,
      hash: frame.hash
    }
  }
}

/**
 * Exercise the production factory, verified `twemu://` assets, real Electron
 * runtime bridge, and SameBoy WASM without involving renderer selectors.
 *
 * The final composition-root hook invokes this only after app readiness and
 * only when `resolvePackagedEmulatorSmokeLaunch` admitted the private profile.
 */
export async function runPackagedEmulatorSmoke(
  input: RunPackagedEmulatorSmokeInput
): Promise<PackagedEmulatorSmokeReceipt> {
  const driver = input.createDriver({
    sessionId: PACKAGE_EMULATOR_SMOKE_SESSION_ID,
    embedded: true,
    gameId: 'homebrew-demo',
    surfaceHostId: input.surfaceHostId
  })
  let receipt: PackagedEmulatorSmokeReceipt | null = null
  let operationError: unknown = null

  try {
    const opened = await driver.open({
      driver: 'emulator',
      gameId: 'homebrew-demo',
      embed: true,
      presentation: 'dock'
    })
    if (opened.url !== 'twemu://app/homebrew-demo/index.html') {
      throw new Error('Packaged emulator smoke opened an unexpected entry URL.')
    }

    const before = await driver.observeEmulator()
    const stepped = await driver.stepEmulator(['right'], before.observationId)
    const beforeReceipt = receiptFor(before, 'before')
    const afterReceipt = receiptFor(stepped, 'after')
    if (
      beforeReceipt.x !== 80 ||
      beforeReceipt.y !== 72 ||
      beforeReceipt.input !== 0 ||
      afterReceipt.x !== 81 ||
      afterReceipt.y !== 72 ||
      afterReceipt.input !== 0x10 ||
      afterReceipt.emulationGeneration !== beforeReceipt.emulationGeneration ||
      afterReceipt.inputEpoch !== beforeReceipt.inputEpoch ||
      afterReceipt.frameId !== beforeReceipt.frameId + 1 ||
      afterReceipt.frameCounter !== beforeReceipt.frameCounter + 1 ||
      afterReceipt.frame.hash === beforeReceipt.frame.hash
    ) {
      throw new Error(
        'Packaged emulator smoke Right step did not advance the fixed fixture exactly once.'
      )
    }
    receipt = {
      schemaVersion: 1,
      sessionId: PACKAGE_EMULATOR_SMOKE_SESSION_ID,
      entryUrl: 'twemu://app/homebrew-demo/index.html',
      before: beforeReceipt,
      after: afterReceipt,
      resourceReleased: true
    }
  } catch (error) {
    operationError = error
  }

  let releaseError: Error | null = null
  try {
    await driver.close()
  } catch (error) {
    releaseError = error instanceof Error ? error : new Error(String(error))
  }
  if (input.isSurfaceLive(PACKAGE_EMULATOR_SMOKE_SESSION_ID)) {
    releaseError = new Error('Packaged emulator smoke close left a live embedded surface.')
  }
  if (operationError && releaseError) {
    throw new AggregateError(
      [operationError, releaseError],
      'Packaged emulator smoke failed and did not cleanly release its surface.'
    )
  }
  if (releaseError) throw releaseError
  if (operationError) throw operationError

  if (!receipt) throw new Error('Packaged emulator smoke completed without a receipt.')
  return receipt
}
