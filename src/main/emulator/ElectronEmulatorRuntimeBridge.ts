/**
 * ElectronEmulatorRuntimeBridge — the main-owned, session-scoped loader for one
 * fixed packaged emulator surface.
 *
 * It owns boot/shutdown plus the internal atomic observation/one-frame seam.
 * There is still no public Canvas, MCP, AppDrive, or generic eval path. The
 * renderer receives only its bundle's frozen `__twemu` facade; this bridge
 * never exports raw Module, HEAP, preload, IPC authority, or arbitrary RAM.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  CanvasEmulatorInputEpochStaleError,
  CanvasEmulatorObservationStaleError,
  CanvasEmulatorUserActiveError,
  type CanvasEmulatorAtomicObservation,
  type CanvasEmulatorObservationRuntimeBridge
} from '../canvas/CanvasEmulatorDriver'
import type { CanvasHostSurface } from '../canvas/CanvasHostSurface'
import type { CanvasEmulatorGameId } from '../canvas/canvasTypes'
import {
  canonicalEmulatorStateAdapterSchemaJson,
  decodeEmulatorMappedState,
  isEmulatorButton,
  validateEmulatorStateAdapterManifest,
  type EmulatorButton,
  type EmulatorMappedState,
  type EmulatorObservationState,
  type EmulatorStateAdapterManifestV2
} from '../../shared/emulatorCanvas'
import {
  emulatorEntryUrl,
  resolveEmulatorAsset,
  type EmulatorAssetRegistry
} from './EmulatorAssetManifest'
import {
  registerEmulatorAssetProtocol,
  type EmulatorAssetProtocolRegistration,
  type EmulatorSessionProtocol
} from './EmulatorAssetProtocol'

const READY_TIMEOUT_MS = 10_000
const OPERATION_TIMEOUT_MS = 2_000
const READY_POLL_MS = 25
const EXPECTED_FACADE_KEYS = ['observe', 'ready', 'shutdown', 'step']
const TWGB_MAGIC = [0x54, 0x57, 0x47, 0x42] as const
const TWGB_ABI_WINDOW_BYTES = 13
const TWGB_SCHEMA = 1
const TWGB_READY_STATUS = 0x03
const EXTERNAL_REQUEST_FILTER = { urls: ['*://*/*'] }
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
const MAX_OBSERVATION_PNG_BYTES = 512 * 1024
const MAX_OBSERVATION_BASE64_CHARS = Math.ceil((MAX_OBSERVATION_PNG_BYTES * 4) / 3) + 4
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

class EmulatorOperationTimeout extends Error {}

export interface ElectronEmulatorWebRequest {
  onBeforeRequest(
    filter: { urls: string[] },
    listener:
      | ((details: { url: string }, callback: (result: { cancel: boolean }) => void) => void)
      | null
  ): void
}

export interface ElectronEmulatorSession {
  protocol: EmulatorSessionProtocol
  webRequest: ElectronEmulatorWebRequest
  setPermissionCheckHandler(handler: ((...args: unknown[]) => boolean) | null): void
  setPermissionRequestHandler(
    handler:
      | ((
          webContents: unknown,
          permission: unknown,
          callback: (allowed: boolean) => void,
          details: unknown
        ) => void)
      | null
  ): void
  on(event: 'will-download', listener: (...args: unknown[]) => void): void
  removeListener(event: 'will-download', listener: (...args: unknown[]) => void): void
}

export interface ElectronEmulatorWebContents {
  session: ElectronEmulatorSession
  isDestroyed(): boolean
  loadURL(url: string): Promise<void>
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  setWindowOpenHandler(handler: (details: unknown) => { action: 'deny' }): void
  setWebRTCIPHandlingPolicy?(policy: 'disable_non_proxied_udp'): void
  on(
    event: 'will-navigate' | 'did-fail-load' | 'render-process-gone',
    listener: (...args: unknown[]) => void
  ): void
  removeListener(
    event: 'will-navigate' | 'did-fail-load' | 'render-process-gone',
    listener: (...args: unknown[]) => void
  ): void
}

export interface EmulatorStableReadyState {
  readonly frameId: number
  readonly frameHash: string
  readonly width: 160
  readonly height: 144
  readonly magic: readonly [number, number, number, number]
  readonly schema: 1
  readonly status: 3
  readonly x: number
  readonly y: number
  readonly input: 0
  readonly frameCounter: number
}

export interface ElectronEmulatorRuntimeBridgeDeps {
  registry: EmulatorAssetRegistry
  /** Factory-supplied, package-validated adapter; never a filesystem descriptor. */
  stateAdapter?: EmulatorStateAdapterManifestV2 | null
  readyTimeoutMs?: number
  operationTimeoutMs?: number
  now?: () => number
  /** One main-owned timestamp is stamped onto both the observation and its PNG frame. */
  capturedAt?: () => string
  /** Main-owned opaque observation identity; injectable for deterministic tests. */
  createObservationId?: () => string
  delay?: (milliseconds: number) => Promise<void>
  /** Main-owned notification for a post-ready load/process fatality. */
  onFatal?: (input: { surface: CanvasHostSurface; reason: Error }) => void
}

interface LiveRuntime {
  readonly surface: CanvasHostSurface
  readonly contents: ElectronEmulatorWebContents
  readonly session: ElectronEmulatorSession
  readonly gameId: CanvasEmulatorGameId
  readonly entryUrl: string
  readonly emulationGeneration: number
  readonly stateAdapter: EmulatorStateAdapterManifestV2 | null
  registration: EmulatorAssetProtocolRegistration | null
  cancelled: boolean
  loadFailure: Error | null
  cleanup: Promise<void> | null
  readonly onNavigate: (...args: unknown[]) => void
  readonly onLoadFailure: (...args: unknown[]) => void
  readonly onProcessGone: (...args: unknown[]) => void
  readonly onDownload: (...args: unknown[]) => void
  readonly onBeforeRequest: (
    details: { url: string },
    callback: (result: { cancel: boolean }) => void
  ) => void
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new EmulatorOperationTimeout(`${label} timed out after ${timeoutMs}ms.`)),
      timeoutMs
    )
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function hasPreventDefault(value: unknown): value is { preventDefault(): void } {
  return typeof asRecord(value)?.preventDefault === 'function'
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function isExactMagic(value: unknown): value is readonly [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === TWGB_MAGIC.length &&
    value.every((item, index) => item === TWGB_MAGIC[index])
  )
}

/** Main-side validation of the page-owned ready projection; never trust a string alone. */
export function validateEmulatorStableReady(value: unknown): EmulatorStableReadyState {
  const input = asRecord(value)
  const frameId = safeInteger(input?.frameId)
  const frameCounter = safeInteger(input?.frameCounter)
  const x = safeInteger(input?.x)
  const y = safeInteger(input?.y)
  if (
    !input ||
    input.frozen !== true ||
    input.moduleGlobal !== 'undefined' ||
    input.heapGlobal !== 'undefined' ||
    input.requireGlobal !== 'undefined' ||
    JSON.stringify(input.facadeKeys) !== JSON.stringify(EXPECTED_FACADE_KEYS) ||
    !isExactMagic(input.magic) ||
    input.schema !== 1 ||
    input.status !== 3 ||
    input.input !== 0 ||
    input.width !== 160 ||
    input.height !== 144 ||
    frameId === null ||
    frameId <= 0 ||
    frameCounter === null ||
    frameCounter <= 0 ||
    x === null ||
    x > 159 ||
    y === null ||
    y > 143 ||
    typeof input.frameHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.frameHash)
  ) {
    throw new Error('Emulator page did not provide a stable, bounded TWGB ready state.')
  }
  return Object.freeze({
    frameId,
    frameHash: input.frameHash,
    width: 160,
    height: 144,
    magic: TWGB_MAGIC,
    schema: 1,
    status: 3,
    x,
    y,
    input: 0,
    frameCounter
  })
}

interface ValidatedPageObservation {
  readonly frameId: number
  readonly inputEpoch: number
  readonly humanActive: boolean
  readonly png: Buffer
  /** A copied fixed C100..C10C window; never propagated beyond materialization. */
  readonly abiWindow: Uint8Array
}

type ValidatedPageAtomicResult =
  | { readonly kind: 'observation'; readonly observation: ValidatedPageObservation }
  | {
      readonly kind: 'refusal'
      readonly code: 'stale_observation' | 'stale_input_epoch' | 'user_active'
      readonly framesAdvanced: 0 | 1
      readonly observation: ValidatedPageObservation
    }

function positiveSafeInteger(value: unknown): number | null {
  const parsed = safeInteger(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

function decodeObservationPng(value: unknown): Buffer {
  if (typeof value !== 'string' || !value.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error('Emulator observation did not provide a PNG data URL.')
  }
  const encoded = value.slice(PNG_DATA_URL_PREFIX.length)
  if (
    !encoded ||
    encoded.length > MAX_OBSERVATION_BASE64_CHARS ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new Error('Emulator observation PNG base64 is malformed or exceeds its cap.')
  }
  const png = Buffer.from(encoded, 'base64')
  if (
    png.byteLength === 0 ||
    png.byteLength > MAX_OBSERVATION_PNG_BYTES ||
    png.toString('base64') !== encoded
  ) {
    throw new Error('Emulator observation PNG is non-canonical or exceeds its cap.')
  }
  if (
    png.byteLength < 24 ||
    PNG_SIGNATURE.some((byte, index) => png[index] !== byte) ||
    png.readUInt32BE(8) !== 13 ||
    png.toString('ascii', 12, 16) !== 'IHDR' ||
    png.readUInt32BE(16) !== 160 ||
    png.readUInt32BE(20) !== 144
  ) {
    throw new Error('Emulator observation PNG is not the exact 160×144 framebuffer.')
  }
  return png
}

function readWindowU32le(window: Uint8Array, offset: number): number {
  return (
    (window[offset] |
      (window[offset + 1] << 8) |
      (window[offset + 2] << 16) |
      (window[offset + 3] << 24)) >>>
    0
  )
}

function validateTwgbAbiWindow(value: unknown): Uint8Array {
  if (
    !Array.isArray(value) ||
    value.length !== TWGB_ABI_WINDOW_BYTES ||
    value.some((byte) => !Number.isSafeInteger(byte) || byte < 0 || byte > 0xff)
  ) {
    throw new Error('Emulator observation ABI window must be exactly 13 frozen bytes.')
  }
  const window = Uint8Array.from(value)
  if (
    window[0] !== TWGB_MAGIC[0] ||
    window[1] !== TWGB_MAGIC[1] ||
    window[2] !== TWGB_MAGIC[2] ||
    window[3] !== TWGB_MAGIC[3] ||
    window[4] !== TWGB_SCHEMA ||
    window[5] !== TWGB_READY_STATUS
  ) {
    throw new Error('Emulator observation ABI window does not contain ready TWGB identity.')
  }
  return window
}

function validatePageObservationFields(input: Record<string, unknown>): ValidatedPageObservation {
  const magic = input.magic
  const schema = input.schema
  const status = input.status
  const frameId = positiveSafeInteger(input.frameId)
  const inputEpoch = safeInteger(input.inputEpoch)
  const humanActive = input.humanActive
  const frameCounter = positiveSafeInteger(input.frameCounter)
  const x = safeInteger(input.x)
  const y = safeInteger(input.y)
  const inputMask = safeInteger(input.input)
  if (
    !isExactMagic(magic) ||
    schema !== TWGB_SCHEMA ||
    status !== TWGB_READY_STATUS ||
    input.width !== 160 ||
    input.height !== 144 ||
    frameId === null ||
    inputEpoch === null ||
    typeof humanActive !== 'boolean' ||
    frameCounter === null ||
    x === null ||
    x > 159 ||
    y === null ||
    y > 143 ||
    inputMask === null ||
    (inputMask & ~0x1fd) !== 0 ||
    typeof input.frameHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.frameHash)
  ) {
    throw new Error('Emulator page did not provide a bounded atomic observation.')
  }
  const abiWindow = validateTwgbAbiWindow(input.abiWindow)
  if (
    abiWindow[0] !== magic[0] ||
    abiWindow[1] !== magic[1] ||
    abiWindow[2] !== magic[2] ||
    abiWindow[3] !== magic[3] ||
    abiWindow[4] !== schema ||
    abiWindow[5] !== status ||
    abiWindow[6] !== x ||
    abiWindow[7] !== y ||
    abiWindow[8] !== inputMask ||
    readWindowU32le(abiWindow, 9) !== frameCounter
  ) {
    throw new Error('Emulator observation ABI window does not exactly match direct TWGB fields.')
  }
  const png = decodeObservationPng(input.pngDataUrl)
  return {
    frameId,
    inputEpoch,
    humanActive,
    png,
    abiWindow
  }
}

/** Validate the fixed facade's bounded atomic result, never the page object itself. */
function validatePageObservation(value: unknown): ValidatedPageAtomicResult {
  const input = asRecord(value)
  if (
    !input ||
    input.facadeFrozen !== true ||
    input.resultFrozen !== true ||
    input.observationFrozen !== true ||
    input.abiWindowFrozen !== true ||
    input.moduleGlobal !== 'undefined' ||
    input.heapGlobal !== 'undefined' ||
    input.requireGlobal !== 'undefined' ||
    JSON.stringify(input.facadeKeys) !== JSON.stringify(EXPECTED_FACADE_KEYS)
  ) {
    throw new Error('Emulator page did not provide a bounded atomic result.')
  }
  const observation = validatePageObservationFields(input)
  if (input.outcome === 'refusal') {
    const framesAdvanced = input.refusalFramesAdvanced
    if (
      input.refusalCode === 'user_active' &&
      observation.humanActive === true &&
      (framesAdvanced === 0 || framesAdvanced === 1)
    ) {
      return { kind: 'refusal', code: input.refusalCode, framesAdvanced, observation }
    }
    if (
      input.refusalCode === 'stale_observation' &&
      observation.humanActive === false &&
      framesAdvanced === 0
    ) {
      return { kind: 'refusal', code: input.refusalCode, framesAdvanced, observation }
    }
    if (
      input.refusalCode === 'stale_input_epoch' &&
      (framesAdvanced === 0 || framesAdvanced === 1) &&
      observation.humanActive === false
    ) {
      return { kind: 'refusal', code: input.refusalCode, framesAdvanced, observation }
    }
    throw new Error('Emulator page returned an invalid atomic refusal.')
  }
  if (input.outcome !== 'observation') {
    throw new Error('Emulator page returned an invalid atomic outcome.')
  }
  return { kind: 'observation', observation }
}

function isDeepFrozenStateAdapter(adapter: EmulatorStateAdapterManifestV2): boolean {
  return (
    Object.isFrozen(adapter) &&
    Object.isFrozen(adapter.stateWindow) &&
    Object.isFrozen(adapter.fields) &&
    adapter.fields.every(
      (field) =>
        Object.isFrozen(field) &&
        Object.isFrozen(field.read) &&
        (field.enumValues === undefined || Object.isFrozen(field.enumValues))
    )
  )
}

function validateRuntimeStateAdapter(
  adapter: EmulatorStateAdapterManifestV2 | null
): EmulatorStateAdapterManifestV2 | null {
  if (adapter === null) return null
  const validated = validateEmulatorStateAdapterManifest(adapter)
  if (
    !validated.ok ||
    validated.value.schemaVersion !== 2 ||
    !isDeepFrozenStateAdapter(adapter) ||
    adapter.schemaVersion !== 2 ||
    adapter.memoryBytes !== TWGB_ABI_WINDOW_BYTES ||
    adapter.stateWindow.source !== 'system_ram' ||
    adapter.stateWindow.startAddress !== 0xc100 ||
    adapter.stateWindow.byteLength !== TWGB_ABI_WINDOW_BYTES
  ) {
    throw new Error('Emulator runtime requires a deep-frozen exact v2 TWGB state adapter.')
  }
  const canonical = canonicalEmulatorStateAdapterSchemaJson(adapter)
  const schemaSha256 = createHash('sha256').update(canonical, 'utf8').digest('hex')
  if (schemaSha256 !== adapter.schemaSha256) {
    throw new Error(
      'Emulator runtime state adapter schemaSha256 does not match its canonical schema.'
    )
  }
  return adapter
}

function freezeMappedState(state: EmulatorMappedState): EmulatorMappedState {
  return Object.freeze({
    ...state,
    fields: Object.freeze(state.fields.map((field) => Object.freeze({ ...field })))
  })
}

function mappedStateFor(
  adapter: EmulatorStateAdapterManifestV2 | null,
  abiWindow: Uint8Array
): EmulatorObservationState {
  if (adapter === null) {
    return Object.freeze({ kind: 'unavailable' as const, reason: 'no_verified_adapter' as const })
  }
  const decoded = decodeEmulatorMappedState(adapter, abiWindow)
  if (!decoded.ok) {
    throw new Error(
      `Emulator state adapter failed to decode the fixed ABI window: ${decoded.reason}`
    )
  }
  return freezeMappedState(decoded.value)
}

const READY_PROBE = `(() => {
  const api = globalThis.__twemu;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, '__twemu');
  if (!api || typeof api.ready !== 'function' || !Object.isFrozen(api) ||
      !descriptor || descriptor.writable !== false || descriptor.configurable !== false) {
    throw new Error('twemu facade is unavailable');
  }
  const facadeKeys = Object.keys(api).sort();
  return Promise.resolve(api.ready()).then((ready) => ({
    frozen: Object.isFrozen(api), facadeKeys,
    moduleGlobal: typeof globalThis.Module,
    heapGlobal: typeof globalThis.HEAPU8,
    requireGlobal: typeof globalThis.require,
    frameId: ready && ready.frameId,
    frameHash: ready && ready.frameHash,
    width: ready && ready.width,
    height: ready && ready.height,
    magic: ready && ready.magic,
    schema: ready && ready.schema,
    status: ready && ready.status,
    x: ready && ready.x,
    y: ready && ready.y,
    input: ready && ready.input,
    frameCounter: ready && ready.frameCounter
  }));
})()`

function facadeObservationProbe(invocation: string): string {
  return `(() => {
  const api = globalThis.__twemu;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, '__twemu');
  if (!api || typeof api.observe !== 'function' || typeof api.step !== 'function' ||
      !Object.isFrozen(api) || !descriptor || descriptor.writable !== false ||
      descriptor.configurable !== false) {
    throw new Error('twemu facade is unavailable');
  }
  return Promise.resolve(${invocation}).then((result) => {
    const refusal = result && result.kind === 'refusal' ? result : null;
    const observation = result && result.kind === 'observation' ? result.observation :
      refusal ? refusal.observation : result;
    return {
      facadeFrozen: Object.isFrozen(api),
      facadeKeys: Object.keys(api).sort(),
      resultFrozen: Object.isFrozen(result),
      observationFrozen: Object.isFrozen(observation),
      abiWindowFrozen: Object.isFrozen(observation && observation.abiWindow),
      outcome: refusal ? 'refusal' : 'observation',
      refusalCode: refusal && refusal.code,
      refusalFramesAdvanced: refusal && refusal.framesAdvanced,
      moduleGlobal: typeof globalThis.Module,
      heapGlobal: typeof globalThis.HEAPU8,
      requireGlobal: typeof globalThis.require,
      frameId: observation && observation.frameId,
      frameHash: observation && observation.frameHash,
      pngDataUrl: observation && observation.pngDataUrl,
      width: observation && observation.width,
      height: observation && observation.height,
      magic: observation && observation.magic,
      schema: observation && observation.schema,
      status: observation && observation.status,
      x: observation && observation.x,
      y: observation && observation.y,
      input: observation && observation.input,
      inputEpoch: observation && observation.inputEpoch,
      humanActive: observation && observation.humanActive,
      frameCounter: observation && observation.frameCounter,
      abiWindow: observation && observation.abiWindow
    };
  });
})()`
}

const OBSERVE_PROBE = facadeObservationProbe('api.observe()')

function stepProbe(
  buttons: readonly EmulatorButton[],
  expectedFrameId: number,
  expectedInputEpoch: number
): string {
  return facadeObservationProbe(
    `api.step(${JSON.stringify(buttons)}, ${JSON.stringify(expectedFrameId)}, ${JSON.stringify(expectedInputEpoch)})`
  )
}

const SHUTDOWN_PROBE = `(() => {
  const api = globalThis.__twemu;
  if (!api || typeof api.shutdown !== 'function') return Promise.resolve(null);
  return Promise.resolve(api.shutdown()).catch(() => null);
})()`

function bridgeContents(surface: CanvasHostSurface): ElectronEmulatorWebContents {
  return surface.webContents as unknown as ElectronEmulatorWebContents
}

export class ElectronEmulatorRuntimeBridge implements CanvasEmulatorObservationRuntimeBridge {
  private live: LiveRuntime | null = null
  private readonly readyTimeoutMs: number
  private readonly operationTimeoutMs: number
  private readonly now: () => number
  private readonly capturedAt: () => string
  private readonly createObservationId: () => string
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly stateAdapter: EmulatorStateAdapterManifestV2 | null
  private nextEmulationGeneration = 0

  constructor(private readonly deps: ElectronEmulatorRuntimeBridgeDeps) {
    this.readyTimeoutMs = Math.max(100, Math.min(30_000, deps.readyTimeoutMs ?? READY_TIMEOUT_MS))
    this.operationTimeoutMs = Math.max(
      100,
      Math.min(10_000, deps.operationTimeoutMs ?? OPERATION_TIMEOUT_MS)
    )
    this.now = deps.now ?? Date.now
    this.capturedAt = deps.capturedAt ?? (() => new Date(this.now()).toISOString())
    this.createObservationId = deps.createObservationId ?? randomUUID
    this.sleep = deps.delay ?? delay
    this.stateAdapter = validateRuntimeStateAdapter(deps.stateAdapter ?? null)
  }

  async boot(input: {
    gameId: CanvasEmulatorGameId
    url: string
    surface: CanvasHostSurface
  }): Promise<void> {
    if (this.live) throw new Error('An emulator runtime is already bound to this bridge.')
    if (input.surface.isDestroyed()) throw new Error('Emulator surface was destroyed before boot.')
    const entryUrl = emulatorEntryUrl(input.gameId)
    if (input.url !== entryUrl)
      throw new Error('Emulator runtime refused a non-canonical entry URL.')
    const contents = bridgeContents(input.surface)
    if (contents.isDestroyed()) throw new Error('Emulator WebContents was destroyed before boot.')
    const session = contents.session
    const live = this.createLive(
      input.surface,
      contents,
      session,
      input.gameId,
      entryUrl,
      ++this.nextEmulationGeneration,
      this.stateAdapter
    )
    this.live = live

    try {
      live.registration = await registerEmulatorAssetProtocol(session.protocol, this.deps.registry)
      this.installPolicies(live)
      await withTimeout(contents.loadURL(entryUrl), this.operationTimeoutMs, 'Emulator page load')
      await this.waitForStableReady(live)
      this.assertCurrent(live)
    } catch (error) {
      try {
        await this.cleanup(live, true, true)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Emulator boot and cleanup both failed.')
      }
      throw error
    }
  }

  async shutdown(input: {
    gameId: CanvasEmulatorGameId
    surface: CanvasHostSurface
  }): Promise<void> {
    const live = this.live
    if (!live || live.surface !== input.surface) return
    if (live.gameId !== input.gameId) throw new Error('Emulator shutdown game binding mismatch.')
    await this.cleanup(live, true)
  }

  async observe(input: {
    gameId: CanvasEmulatorGameId
    surface: CanvasHostSurface
  }): Promise<CanvasEmulatorAtomicObservation> {
    return this.runAtomicObservation(input, OBSERVE_PROBE, 'Emulator observation')
  }

  async step(input: {
    gameId: CanvasEmulatorGameId
    surface: CanvasHostSurface
    buttons: readonly EmulatorButton[]
    expectedFrameId: number
    expectedInputEpoch: number
    /** Main-derived from the driver cache; never supplied by the page or MCP caller. */
    expectedFixtureCounter?: number
  }): Promise<CanvasEmulatorAtomicObservation> {
    if (
      !Array.isArray(input.buttons) ||
      input.buttons.length > 8 ||
      input.buttons.some((button) => !isEmulatorButton(button)) ||
      new Set(input.buttons).size !== input.buttons.length ||
      (input.buttons.includes('up') && input.buttons.includes('down')) ||
      (input.buttons.includes('left') && input.buttons.includes('right'))
    ) {
      throw new Error('Emulator step requires a bounded non-conflicting button set.')
    }
    if (
      !Number.isSafeInteger(input.expectedFrameId) ||
      input.expectedFrameId <= 0 ||
      input.expectedFrameId >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(input.expectedInputEpoch) ||
      input.expectedInputEpoch < 0
    ) {
      throw new Error('Emulator step requires trusted frame and input epochs.')
    }
    if (
      input.expectedFixtureCounter !== undefined &&
      (!Number.isSafeInteger(input.expectedFixtureCounter) ||
        input.expectedFixtureCounter <= 0 ||
        input.expectedFixtureCounter >= 0xffff_ffff)
    ) {
      throw new Error('Emulator step requires a positive main-owned fixture frame counter.')
    }
    if (this.stateAdapter !== null && input.expectedFixtureCounter === undefined) {
      throw new Error('Mapped emulator steps require a cached main-owned fixture frame counter.')
    }
    return this.runAtomicObservation(
      input,
      stepProbe(input.buttons, input.expectedFrameId, input.expectedInputEpoch),
      'Emulator one-frame step',
      {
        expectedFrameId: input.expectedFrameId,
        expectedInputEpoch: input.expectedInputEpoch,
        ...(input.expectedFixtureCounter === undefined
          ? {}
          : { expectedFixtureCounter: input.expectedFixtureCounter })
      }
    )
  }

  private requireLive(input: {
    gameId: CanvasEmulatorGameId
    surface: CanvasHostSurface
  }): LiveRuntime {
    const live = this.live
    if (!live || live.surface !== input.surface || live.gameId !== input.gameId) {
      throw new Error('Emulator observation binding is absent or belongs to another surface.')
    }
    this.assertCurrent(live)
    return live
  }

  private async runAtomicObservation(
    input: { gameId: CanvasEmulatorGameId; surface: CanvasHostSurface },
    probe: string,
    label: string,
    stepExpectation?: {
      readonly expectedFrameId: number
      readonly expectedInputEpoch: number
      readonly expectedFixtureCounter?: number
    }
  ): Promise<CanvasEmulatorAtomicObservation> {
    const live = this.requireLive(input)
    try {
      const raw = await withTimeout(
        live.contents.executeJavaScript(probe),
        this.operationTimeoutMs,
        label
      )
      this.assertCurrent(live)
      const pageResult = validatePageObservation(raw)
      this.validateStepResult(live, pageResult, stepExpectation)
      if (pageResult.kind === 'refusal') {
        const observation = this.materializeAtomicObservation(live, pageResult.observation)
        if (pageResult.code === 'stale_input_epoch') {
          throw new CanvasEmulatorInputEpochStaleError(observation, pageResult.framesAdvanced)
        }
        if (pageResult.code === 'user_active') {
          throw new CanvasEmulatorUserActiveError(observation, pageResult.framesAdvanced)
        }
        throw new CanvasEmulatorObservationStaleError(observation)
      }
      return this.materializeAtomicObservation(live, pageResult.observation)
    } catch (error) {
      if (
        error instanceof CanvasEmulatorInputEpochStaleError ||
        error instanceof CanvasEmulatorObservationStaleError ||
        error instanceof CanvasEmulatorUserActiveError
      ) {
        throw error
      }
      const reason = error instanceof Error ? error : new Error(String(error))
      await this.handleFatal(live, reason)
      throw reason
    }
  }

  private validateStepResult(
    live: LiveRuntime,
    result: ValidatedPageAtomicResult,
    expectation:
      | {
          readonly expectedFrameId: number
          readonly expectedInputEpoch: number
          readonly expectedFixtureCounter?: number
        }
      | undefined
  ): void {
    if (!expectation) return
    if (result.kind === 'refusal') {
      if (
        result.code === 'stale_observation' &&
        result.observation.frameId === expectation.expectedFrameId
      ) {
        throw new Error('Emulator stale-observation refusal did not report a changed frame.')
      }
      if (
        result.code === 'stale_input_epoch' &&
        result.observation.inputEpoch === expectation.expectedInputEpoch
      ) {
        throw new Error('Emulator stale-input refusal did not report a changed human input epoch.')
      }
      if (
        result.code === 'user_active' &&
        result.framesAdvanced === 1 &&
        result.observation.inputEpoch === expectation.expectedInputEpoch
      ) {
        throw new Error(
          'Emulator post-dispatch user-active refusal did not report a changed epoch.'
        )
      }
    }
    const advancedOne = result.kind === 'observation' || result.framesAdvanced === 1
    if (!advancedOne) return
    const observation = result.observation
    if (observation.frameId !== expectation.expectedFrameId + 1) {
      throw new Error('Emulator step result did not advance exactly one expected frame.')
    }
    if (result.kind === 'observation') {
      if (observation.humanActive || observation.inputEpoch !== expectation.expectedInputEpoch) {
        throw new Error('Emulator step reported success after a human input transition.')
      }
    }
    if (live.stateAdapter === null) return
    const expectedCounter = expectation.expectedFixtureCounter
    if (
      expectedCounter === undefined ||
      expectedCounter >= 0xffff_ffff ||
      readWindowU32le(observation.abiWindow, 9) !== expectedCounter + 1
    ) {
      throw new Error('Emulator step result did not advance exactly one expected fixture counter.')
    }
  }

  private materializeAtomicObservation(
    live: LiveRuntime,
    page: ValidatedPageObservation
  ): CanvasEmulatorAtomicObservation {
    const mappedState = mappedStateFor(live.stateAdapter, page.abiWindow)
    const observationId = this.createObservationId()
    if (
      typeof observationId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(observationId)
    ) {
      throw new Error('Emulator observation id factory returned an invalid opaque id.')
    }
    const capturedAt = this.capturedAt()
    if (
      typeof capturedAt !== 'string' ||
      !Number.isFinite(new Date(capturedAt).getTime()) ||
      new Date(capturedAt).toISOString() !== capturedAt
    ) {
      throw new Error('Emulator observation timestamp factory returned invalid ISO-8601.')
    }
    const frame = Object.freeze({
      mimeType: 'image/png' as const,
      data: page.png.toString('base64'),
      width: 160,
      height: 144,
      byteLength: page.png.byteLength,
      hash: createHash('sha256').update(page.png).digest('hex'),
      capturedAt
    })
    return Object.freeze({
      schemaVersion: 1 as const,
      observationId,
      emulationGeneration: live.emulationGeneration,
      frameId: page.frameId,
      inputEpoch: page.inputEpoch,
      humanActive: page.humanActive,
      capturedAt,
      frame,
      mappedState
    })
  }

  private createLive(
    surface: CanvasHostSurface,
    contents: ElectronEmulatorWebContents,
    session: ElectronEmulatorSession,
    gameId: CanvasEmulatorGameId,
    entryUrl: string,
    emulationGeneration: number,
    stateAdapter: EmulatorStateAdapterManifestV2 | null
  ): LiveRuntime {
    const onNavigate: LiveRuntime['onNavigate'] = (...args) => {
      const [event, target] = args
      if (target === entryUrl) return
      if (hasPreventDefault(event)) event.preventDefault()
    }
    const onLoadFailure = (
      _event: unknown,
      code: unknown,
      description: unknown,
      url: unknown,
      isMainFrame: unknown
    ) => {
      if (isMainFrame === false) return
      const reason = new Error(
        `Emulator load failed (${String(code)}): ${String(description)} [${String(url)}]`
      )
      live.loadFailure = reason
      void this.handleFatal(live, reason)
    }
    const onProcessGone = () => {
      const reason = new Error('Emulator renderer process exited.')
      live.loadFailure = reason
      void this.handleFatal(live, reason)
    }
    const onDownload: LiveRuntime['onDownload'] = (...args) => {
      if (hasPreventDefault(args[0])) args[0].preventDefault()
    }
    const onBeforeRequest = (
      details: { url: string },
      callback: (result: { cancel: boolean }) => void
    ) => {
      let allowed = false
      try {
        allowed = resolveEmulatorAsset(this.deps.registry, details.url) !== null
      } catch {
        allowed = false
      }
      callback({ cancel: !allowed })
    }
    const live: LiveRuntime = {
      surface,
      contents,
      session,
      gameId,
      entryUrl,
      emulationGeneration,
      stateAdapter,
      registration: null,
      cancelled: false,
      loadFailure: null,
      cleanup: null,
      onNavigate,
      onLoadFailure,
      onProcessGone,
      onDownload,
      onBeforeRequest
    }
    return live
  }

  private installPolicies(live: LiveRuntime): void {
    const { contents, session } = live
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    try {
      contents.setWebRTCIPHandlingPolicy?.('disable_non_proxied_udp')
    } catch {
      // Older Electron paths may lack the optional WebRTC policy hook.
    }
    contents.on('will-navigate', live.onNavigate)
    contents.on('did-fail-load', live.onLoadFailure)
    contents.on('render-process-gone', live.onProcessGone)
    session.webRequest.onBeforeRequest(EXTERNAL_REQUEST_FILTER, live.onBeforeRequest)
    session.setPermissionCheckHandler(() => false)
    session.setPermissionRequestHandler((_webContents, _permission, callback, _details) =>
      callback(false)
    )
    session.on('will-download', live.onDownload)
  }

  private async waitForStableReady(live: LiveRuntime): Promise<EmulatorStableReadyState> {
    const deadline = this.now() + this.readyTimeoutMs
    let lastError: unknown = null
    while (this.now() < deadline) {
      this.assertCurrent(live)
      if (live.loadFailure) throw live.loadFailure
      try {
        const value = await withTimeout(
          live.contents.executeJavaScript(READY_PROBE),
          this.operationTimeoutMs,
          'Emulator ready probe'
        )
        return validateEmulatorStableReady(value)
      } catch (error) {
        if (error instanceof EmulatorOperationTimeout) throw error
        lastError = error
      }
      await this.sleep(READY_POLL_MS)
    }
    throw new Error(
      `Emulator page did not reach stable ready state before timeout${
        lastError ? `: ${String(lastError)}` : ''
      }`
    )
  }

  private assertCurrent(live: LiveRuntime): void {
    if (
      this.live !== live ||
      live.cancelled ||
      live.surface.isDestroyed() ||
      live.contents.isDestroyed()
    ) {
      throw new Error('Emulator boot was cancelled because its surface closed.')
    }
  }

  private async handleFatal(live: LiveRuntime, reason: Error): Promise<void> {
    if (this.live !== live) return
    try {
      await this.cleanup(live, false, true)
    } catch {
      // The surface is still retired below; a retry remains available to callers.
    }
    try {
      this.deps.onFatal?.({ surface: live.surface, reason })
    } catch {
      // A diagnostic/retirement callback cannot retain this session's resources.
    }
  }

  private async cleanup(
    live: LiveRuntime,
    invokePageShutdown: boolean,
    forceDestroySurface = false
  ): Promise<void> {
    if (live.cleanup) return live.cleanup
    live.cancelled = true
    const operation = (async () => {
      let strictError: unknown = null
      let pageShutdownTimedOut = false
      try {
        if (invokePageShutdown && !live.contents.isDestroyed()) {
          try {
            await withTimeout(
              live.contents.executeJavaScript(SHUTDOWN_PROBE),
              this.operationTimeoutMs,
              'Emulator page shutdown'
            )
          } catch (error) {
            pageShutdownTimedOut = error instanceof EmulatorOperationTimeout
          }
        }
      } finally {
        try {
          live.contents.removeListener('will-navigate', live.onNavigate)
        } catch {
          // The renderer may have destroyed its event host already.
        }
        try {
          live.contents.removeListener('did-fail-load', live.onLoadFailure)
        } catch {
          // The renderer may have destroyed its event host already.
        }
        try {
          live.contents.removeListener('render-process-gone', live.onProcessGone)
        } catch {
          // The renderer may have destroyed its event host already.
        }
        // The driver supplies a unique in-memory partition, so clearing this
        // WebRequest slot removes only the bridge's own session policy.
        try {
          live.session.webRequest.onBeforeRequest(EXTERNAL_REQUEST_FILTER, null)
        } catch {
          // The unique session may already be disposed.
        }
        try {
          live.session.removeListener('will-download', live.onDownload)
        } catch {
          // The unique session may already be disposed.
        }
        try {
          live.session.setPermissionCheckHandler(null)
        } catch {
          // The unique session may already be disposed.
        }
        try {
          live.session.setPermissionRequestHandler(null)
        } catch {
          // The unique session may already be disposed.
        }
        if (live.registration) {
          try {
            await live.registration.unregister()
          } catch {
            try {
              await live.registration.unregister()
            } catch (error) {
              strictError = error
            }
          }
        }
        if ((forceDestroySurface || pageShutdownTimedOut) && !live.surface.isDestroyed()) {
          try {
            live.surface.destroy()
          } catch {
            // A racing renderer close already supplied containment.
          }
        }
      }
      if (strictError) throw strictError
      if (this.live === live) this.live = null
    })()
    live.cleanup = operation
    void operation.catch(() => {
      if (live.cleanup === operation) live.cleanup = null
    })
    return operation
  }
}
