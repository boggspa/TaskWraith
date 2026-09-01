import { createHash, randomUUID } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

/** The small main-window seam the packaged private smoke needs after startup. */
export interface PackagedEmulatorSmokeHostWindow {
  isDestroyed(): boolean
  readonly webContents: { readonly id: number }
}

export interface PackagedEmulatorSmokeResultFileOps {
  unlink(path: string): Promise<void>
  writeFile(
    path: string,
    data: string,
    options: { encoding: 'utf8'; mode: number; flag: 'wx' }
  ): Promise<void>
  rename(from: string, to: string): Promise<void>
}

export type PackagedEmulatorSmokeProcessResult =
  | { readonly ok: true; readonly receipt: PackagedEmulatorSmokeReceipt }
  | {
      readonly ok: false
      /** Deliberately bounded: never persist a raw Electron/runtime exception. */
      readonly error: 'emulator_smoke_failed' | 'emulator_smoke_unavailable'
    }

export interface StartPackagedEmulatorSmokeInput {
  readonly argv: readonly string[]
  readonly posture: InstanceLaunchPosture
  readonly isPackaged: boolean
  readonly mainWindow: PackagedEmulatorSmokeHostWindow | null
  readonly createDriver: RunPackagedEmulatorSmokeInput['createDriver']
  readonly isSurfaceLive: RunPackagedEmulatorSmokeInput['isSurfaceLive']
  readonly exit: (code: 0 | 1) => void
  readonly fileOps?: PackagedEmulatorSmokeResultFileOps
  /** Test seam; production keeps the temporary sibling private and unpredictable. */
  readonly createTemporaryPath?: (resultPath: string) => string
  /** Optional bounded logger for smoke diagnostics; never receives raw RAM/PNG. */
  readonly logger?: Pick<Console, 'error'>
}

const RESULT_FILE_OPS: PackagedEmulatorSmokeResultFileOps = { unlink, writeFile, rename }

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

function hasPackagedEmulatorSmokeIntent(argv: readonly string[]): boolean {
  return argv.some(
    (value) =>
      value === PACKAGE_EMULATOR_SMOKE_ARG || value.startsWith(PACKAGE_EMULATOR_SMOKE_RESULT_ARG)
  )
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function defaultTemporaryResultPath(resultPath: string): string {
  return join(dirname(resultPath), `.${basename(resultPath)}.${process.pid}.${randomUUID()}.tmp`)
}

function isSafeTemporaryResultPath(resultPath: string, temporaryPath: string): boolean {
  const result = resolve(resultPath)
  const temporary = resolve(temporaryPath)
  const resultDirectory = dirname(result)
  const resultName = basename(result)
  return (
    dirname(temporary) === resultDirectory &&
    basename(temporary).startsWith(`.${resultName}.`) &&
    basename(temporary).endsWith('.tmp')
  )
}

async function removePriorResult(
  resultPath: string,
  fileOps: PackagedEmulatorSmokeResultFileOps
): Promise<void> {
  try {
    await fileOps.unlink(resultPath)
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
}

/**
 * Publish only a completed, disk-safe result. The caller never observes a
 * partially written JSON file: the temporary sibling is renamed only after a
 * successful exclusive write, and every failed path removes that sibling.
 */
export async function writePackagedEmulatorSmokeResultAtomically(input: {
  readonly resultPath: string
  readonly result: PackagedEmulatorSmokeProcessResult
  readonly fileOps?: PackagedEmulatorSmokeResultFileOps
  readonly createTemporaryPath?: (resultPath: string) => string
}): Promise<void> {
  const fileOps = input.fileOps ?? RESULT_FILE_OPS
  const temporaryPath = (input.createTemporaryPath ?? defaultTemporaryResultPath)(input.resultPath)
  if (!isSafeTemporaryResultPath(input.resultPath, temporaryPath)) {
    throw new Error('Packaged emulator smoke temporary receipt path is invalid.')
  }
  let published = false
  try {
    await fileOps.writeFile(temporaryPath, JSON.stringify(input.result), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await fileOps.rename(temporaryPath, input.resultPath)
    published = true
  } finally {
    if (!published) {
      try {
        await fileOps.unlink(temporaryPath)
      } catch {
        // A failed private smoke must not turn cleanup noise into raw output.
      }
    }
  }
}

function liveHostWindow(
  mainWindow: PackagedEmulatorSmokeHostWindow | null
): PackagedEmulatorSmokeHostWindow | null {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !Number.isSafeInteger(mainWindow.webContents.id) ||
    mainWindow.webContents.id <= 0
  ) {
    return null
  }
  return mainWindow
}

/**
 * Main-process composition seam for the opt-in packaged smoke. It is inert on
 * normal launches, fails closed on malformed explicit smoke intent, and emits
 * at most one atomically published private-profile result envelope.
 */
export async function startPackagedEmulatorSmoke(
  input: StartPackagedEmulatorSmokeInput
): Promise<boolean> {
  const explicitIntent = hasPackagedEmulatorSmokeIntent(input.argv)
  if (!explicitIntent) return false
  if (!input.isPackaged) {
    input.exit(1)
    return true
  }
  const launch = resolvePackagedEmulatorSmokeLaunch(input.argv, input.posture)
  if (!launch) {
    input.exit(1)
    return true
  }

  const fileOps = input.fileOps ?? RESULT_FILE_OPS
  const publish = (result: PackagedEmulatorSmokeProcessResult) =>
    writePackagedEmulatorSmokeResultAtomically({
      resultPath: launch.resultPath,
      result,
      fileOps,
      createTemporaryPath: input.createTemporaryPath
    })

  try {
    // The external harness polls this path, so clear any stale file before a
    // real driver can start; otherwise an old success could mask a new crash.
    await removePriorResult(launch.resultPath, fileOps)
    const mainWindow = liveHostWindow(input.mainWindow)
    if (!mainWindow) {
      await publish({ ok: false, error: 'emulator_smoke_unavailable' })
      input.exit(1)
      return true
    }
    const receipt = await runPackagedEmulatorSmoke({
      createDriver: input.createDriver,
      isSurfaceLive: input.isSurfaceLive,
      surfaceHostId: mainWindow.webContents.id
    })
    await publish({ ok: true, receipt })
    input.exit(0)
  } catch (error) {
    const message = error instanceof Error ? `: ${error.message}` : ''
    try {
      input.logger?.error(`[emulator-smoke] packaged emulator smoke failed${message}`)
    } catch {
      // A logging throw must neither escape this catch nor skip the bounded
      // disk envelope below; the harness must still observe the failure.
    }
    try {
      await publish({ ok: false, error: 'emulator_smoke_failed' })
    } catch {
      // The harness sees a bounded process failure if its private result path
      // itself cannot be published; do not leak an Electron/runtime exception.
    }
    input.exit(1)
  }
  return true
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
 * Preserve the failing lifecycle phase on a smoke error so the composition-root
 * logger names which step failed without persisting any raw detail to disk.
 */
async function withSmokePhase<T>(
  phase: 'open' | 'observe' | 'step' | 'close',
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw new Error(
      `[emulator-smoke] phase=${phase}: ${error instanceof Error ? error.message : String(error)}`
    )
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
    const opened = await withSmokePhase('open', () =>
      driver.open({
        driver: 'emulator',
        gameId: 'homebrew-demo',
        embed: true,
        presentation: 'dock'
      })
    )
    if (opened.url !== 'twemu://app/homebrew-demo/index.html') {
      throw new Error('Packaged emulator smoke opened an unexpected entry URL.')
    }

    const before = await withSmokePhase('observe', () => driver.observeEmulator())
    const stepped = await withSmokePhase('step', () =>
      driver.stepEmulator(['right'], before.observationId)
    )
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
    await withSmokePhase('close', () => driver.close())
  } catch (error) {
    releaseError = error instanceof Error ? error : new Error(String(error))
  }
  if (input.isSurfaceLive(PACKAGE_EMULATOR_SMOKE_SESSION_ID)) {
    releaseError = new Error('Packaged emulator smoke close left a live embedded surface.')
  }
  if (operationError && releaseError) {
    throw new AggregateError(
      [operationError, releaseError],
      `Packaged emulator smoke failed and did not cleanly release its surface: ${
        operationError instanceof Error ? operationError.message : String(operationError)
      }`
    )
  }
  if (releaseError) throw releaseError
  if (operationError) throw operationError

  if (!receipt) throw new Error('Packaged emulator smoke completed without a receipt.')
  return receipt
}
