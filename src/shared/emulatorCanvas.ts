/**
 * Shared, node-free contracts for the Canvas emulator driver.
 *
 * This module deliberately describes only package-owned emulator data and
 * bounded agent input. It never accepts ROM paths, arbitrary RAM addresses,
 * JavaScript, or an Electron capability. Main resolves packaged assets and
 * invokes a renderer/runtime behind these validated DTOs.
 */

export const EMULATOR_PACKAGE_MANIFEST_SCHEMA_V1 = 1 as const
export const EMULATOR_PACKAGE_MANIFEST_SCHEMA_V2 = 2 as const
/** Legacy v1 export retained for existing descriptor consumers. */
export const EMULATOR_PACKAGE_MANIFEST_SCHEMA_VERSION = EMULATOR_PACKAGE_MANIFEST_SCHEMA_V1
export const EMULATOR_PACKAGE_MANIFEST_LATEST_SCHEMA_VERSION = EMULATOR_PACKAGE_MANIFEST_SCHEMA_V2
export const EMULATOR_STATE_ADAPTER_SCHEMA_V1 = 1 as const
export const EMULATOR_STATE_ADAPTER_SCHEMA_V2 = 2 as const
/** Legacy v1 export retained for existing descriptor consumers. */
export const EMULATOR_STATE_ADAPTER_SCHEMA_VERSION = EMULATOR_STATE_ADAPTER_SCHEMA_V1
export const EMULATOR_STATE_ADAPTER_LATEST_SCHEMA_VERSION = EMULATOR_STATE_ADAPTER_SCHEMA_V2
export const EMULATOR_OBSERVATION_SCHEMA_VERSION = 1 as const

export const EMULATOR_MAX_MANIFEST_BYTES = 64 * 1024
export const EMULATOR_MAX_STATE_ADAPTER_BYTES = 32 * 1024
export const EMULATOR_MAX_RAM_BYTES = 16 * 1024 * 1024
export const EMULATOR_MAX_STATE_FIELDS = 64
export const EMULATOR_MAX_STATE_READ_BYTES = 512
export const EMULATOR_MAX_STATE_BYTES = 16 * 1024
export const EMULATOR_MAX_FRAME_BYTES = 8 * 1024 * 1024
export const EMULATOR_MAX_FRAME_EDGE = 8192
export const EMULATOR_MAX_FRAME_PIXELS = 16_777_216
export const EMULATOR_MAX_DECODED_ABS_VALUE = 1_000_000_000_000

export const EMULATOR_STEP_MAX_SEGMENTS = 12
export const EMULATOR_STEP_MAX_FRAMES_PER_SEGMENT = 120
export const EMULATOR_STEP_MAX_TOTAL_FRAMES = 240

const MAX_ID_CHARS = 96
const MAX_REVISION_CHARS = 64
const MAX_FIELD_KEY_CHARS = 64
const MAX_UNIT_CHARS = 32
const MAX_ENUM_VALUES = 32
const MAX_ENUM_VALUE_CHARS = 64
const MAX_TRANSFORM_ABS_VALUE = 1_000_000

const CANONICAL_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
const CANONICAL_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const SHA256 = /^[a-f0-9]{64}$/

export const EMULATOR_BUTTONS = [
  'up',
  'down',
  'left',
  'right',
  'a',
  'b',
  'start',
  'select'
] as const

export type EmulatorButton = (typeof EMULATOR_BUTTONS)[number]

export const EMULATOR_RAM_ENCODINGS = [
  'u8',
  'i8',
  'u16le',
  'u16be',
  'i16le',
  'i16be',
  'u32le',
  'u32be',
  'i32le',
  'i32be',
  'bit'
] as const

export type EmulatorRamEncoding = (typeof EMULATOR_RAM_ENCODINGS)[number]
export type EmulatorMappedStateKind = 'integer' | 'boolean' | 'enum'

export type EmulatorValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string }

/** A package-owned instruction for reading one bounded scalar from an adapter buffer. */
export interface EmulatorRamRead {
  readonly address: number
  readonly encoding: EmulatorRamEncoding
  readonly bit?: number
  readonly scale?: number
  readonly offset?: number
}

export interface EmulatorStateAdapterFieldManifest {
  readonly key: string
  readonly kind: EmulatorMappedStateKind
  readonly read: EmulatorRamRead
  readonly unit?: string
  /** Required only for enum fields; raw integer values map to bounded labels. */
  readonly enumValues?: Readonly<Record<string, string>>
}

/**
 * Trusted state schema associated with one exact core + ROM hash pair.
 * It is never accepted from an MCP caller; package loading validates it before
 * the emulator becomes observable.
 */
interface EmulatorStateAdapterManifestBase {
  readonly adapterId: string
  readonly adapterRevision: string
  readonly schemaSha256: string
  readonly coreId: string
  readonly romSha256: string
  readonly memoryBytes: number
  readonly fields: readonly EmulatorStateAdapterFieldManifest[]
}

/** Legacy v1 adapters describe only their supplied bounded decoder buffer. */
export interface EmulatorStateAdapterManifestV1 extends EmulatorStateAdapterManifestBase {
  readonly schemaVersion: typeof EMULATOR_STATE_ADAPTER_SCHEMA_V1
}

/** Explicit source provenance for a bounded adapter buffer. */
export interface EmulatorStateWindow {
  readonly source: 'system_ram'
  readonly startAddress: number
  readonly byteLength: number
}

/** V2 adapters bind window-relative reads to one exact emulator memory window. */
export interface EmulatorStateAdapterManifestV2 extends EmulatorStateAdapterManifestBase {
  readonly schemaVersion: typeof EMULATOR_STATE_ADAPTER_SCHEMA_V2
  readonly stateWindow: EmulatorStateWindow
}

export type EmulatorStateAdapterManifest =
  | EmulatorStateAdapterManifestV1
  | EmulatorStateAdapterManifestV2

/**
 * One package the host is prepared to run. Asset locations intentionally stay
 * out of this cross-process contract; package resolution owns them in main.
 */
export interface EmulatorPackageManifestV1 {
  readonly schemaVersion: typeof EMULATOR_PACKAGE_MANIFEST_SCHEMA_V1
  readonly gameId: string
  readonly coreId: string
  /** Legacy v1 core identity; preserved exactly for existing descriptors. */
  readonly coreSha256: string
  readonly romSha256: string
  /** Explicitly null when the package has no verified mapped-state schema yet. */
  readonly stateAdapter: EmulatorStateAdapterManifestV1 | null
}

/** V2 separates pure core-object provenance from the combined browser runtime artifact. */
export interface EmulatorPackageManifestV2 {
  readonly schemaVersion: typeof EMULATOR_PACKAGE_MANIFEST_SCHEMA_V2
  readonly gameId: string
  readonly coreId: string
  /** Pure core-object identity, retained under the established package field name. */
  readonly coreSha256: string
  readonly runtimeWasmSha256: string
  readonly romSha256: string
  readonly stateAdapter: EmulatorStateAdapterManifestV2 | null
}

export type EmulatorPackageManifest = EmulatorPackageManifestV1 | EmulatorPackageManifestV2

/**
 * Internal driver identity. It is returned in observations, but MCP input must
 * carry only `expectedObservationId`; main resolves the remaining fields from
 * its cached trusted observation rather than accepting model-authored epochs.
 */
export interface EmulatorObservationToken {
  /** Main-minted opaque identity for one returned emulator observation. */
  readonly observationId: string
  /** Bumps when the emulation universe changes (core/ROM/reset/load-state). */
  readonly emulationGeneration: number
  /** Monotonic within one emulation generation. */
  readonly frameId: number
  /** Bumps only for human-originated emulator input. */
  readonly inputEpoch: number
}

/** Metadata for the exact PNG captured at the same frame boundary as state. */
export interface EmulatorFrameMetadata {
  readonly mimeType: 'image/png'
  readonly width: number
  readonly height: number
  readonly byteLength: number
  readonly hash: string
  readonly capturedAt: string
}

export type EmulatorMappedStateField =
  | {
      readonly key: string
      readonly kind: 'integer'
      readonly value: number
      readonly unit?: string
    }
  | { readonly key: string; readonly kind: 'boolean'; readonly value: boolean }
  | { readonly key: string; readonly kind: 'enum'; readonly value: string }

export interface EmulatorMappedState {
  readonly kind: 'mapped'
  readonly adapterId: string
  readonly adapterRevision: string
  readonly schemaSha256: string
  readonly fields: readonly EmulatorMappedStateField[]
  /** Reserved for a future explicitly bounded partial adapter result. */
  readonly truncated: boolean
}

export interface EmulatorMappedStateUnavailable {
  readonly kind: 'unavailable'
  readonly reason: 'no_verified_adapter'
}

export type EmulatorObservationState = EmulatorMappedState | EmulatorMappedStateUnavailable

/** Public, pixel-free observation projection; MCP delivers PNG bytes separately. */
export interface EmulatorObservation {
  readonly schemaVersion: typeof EMULATOR_OBSERVATION_SCHEMA_VERSION
  readonly token: EmulatorObservationToken
  readonly capturedAt: string
  /** True only while the trusted human Play loop owns frame advancement. */
  readonly humanActive: boolean
  readonly frame: EmulatorFrameMetadata
  readonly state: EmulatorObservationState
}

/** A single controller state held for a bounded number of emulated frames. */
export interface EmulatorInputSegment {
  readonly buttons: readonly EmulatorButton[]
  readonly frames: number
}

export interface EmulatorStepRequest {
  /** Internal-only resolved request; do not expose this full token in MCP input. */
  readonly expected: EmulatorObservationToken
  readonly segments: readonly EmulatorInputSegment[]
  readonly requireIndependentVerifier?: boolean
}

/** Public MCP input: only the opaque observation id crosses the model boundary. */
export interface EmulatorStepToolInput {
  readonly expectedObservationId: string
  readonly segments: readonly EmulatorInputSegment[]
  readonly requireIndependentVerifier?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function utf8ByteLength(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return null
  }
}

function finiteInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  )
}

function canonicalId(value: unknown, maxChars = MAX_ID_CHARS): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxChars &&
    value.trim() === value &&
    CANONICAL_ID.test(value)
  )
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function displayString(value: unknown, maxChars: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxChars &&
    value.trim() === value &&
    !containsAsciiControlCharacter(value)
  )
}

function canonicalTimestamp(value: unknown): value is string {
  if (!displayString(value, 64)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function fail<T>(reason: string): EmulatorValidation<T> {
  return { ok: false, reason }
}

function readWidth(encoding: EmulatorRamEncoding): number {
  if (encoding === 'u8' || encoding === 'i8' || encoding === 'bit') return 1
  if (
    encoding === 'u16le' ||
    encoding === 'u16be' ||
    encoding === 'i16le' ||
    encoding === 'i16be'
  ) {
    return 2
  }
  return 4
}

function isSignedEncoding(encoding: EmulatorRamEncoding): boolean {
  return (
    encoding === 'i8' ||
    encoding === 'i16le' ||
    encoding === 'i16be' ||
    encoding === 'i32le' ||
    encoding === 'i32be'
  )
}

function isLittleEndianEncoding(encoding: EmulatorRamEncoding): boolean {
  return (
    encoding === 'u16le' || encoding === 'i16le' || encoding === 'u32le' || encoding === 'i32le'
  )
}

function validateTransform(
  value: unknown,
  label: string,
  allowZero: boolean
): number | undefined | string {
  if (value === undefined) return undefined
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > MAX_TRANSFORM_ABS_VALUE
  ) {
    return `Adapter read ${label} must be a finite number within ±${MAX_TRANSFORM_ABS_VALUE}.`
  }
  if (!allowZero && value === 0) return `Adapter read ${label} must not be zero.`
  return value
}

function validateEnumValues(value: unknown): Readonly<Record<string, string>> | string {
  if (!isRecord(value)) return 'Enum adapter fields require an `enumValues` object.'
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > MAX_ENUM_VALUES) {
    return `Enum adapter fields need 1-${MAX_ENUM_VALUES} values.`
  }
  const normalized: Record<string, string> = {}
  for (const [rawKey, rawValue] of entries) {
    const numericKey = Number(rawKey)
    if (!Number.isSafeInteger(numericKey) || String(numericKey) !== rawKey) {
      return `Enum adapter value key "${rawKey}" must be a canonical safe integer.`
    }
    if (!displayString(rawValue, MAX_ENUM_VALUE_CHARS)) {
      return `Enum adapter value for "${rawKey}" must be a bounded display string.`
    }
    normalized[rawKey] = rawValue
  }
  return normalized
}

function validateRamRead(raw: unknown, memoryBytes: number): EmulatorValidation<EmulatorRamRead> {
  if (!isRecord(raw)) return fail('Adapter field `read` must be an object.')
  const encoding = raw.encoding
  if (
    typeof encoding !== 'string' ||
    !(EMULATOR_RAM_ENCODINGS as readonly string[]).includes(encoding)
  ) {
    return fail(`Unsupported RAM encoding "${String(encoding)}".`)
  }
  const typedEncoding = encoding as EmulatorRamEncoding
  const width = readWidth(typedEncoding)
  if (!finiteInteger(raw.address, 0, memoryBytes - width)) {
    return fail('Adapter RAM address is outside the declared memory range.')
  }
  if (typedEncoding === 'bit') {
    if (!finiteInteger(raw.bit, 0, 7)) return fail('Bit RAM reads require `bit` from 0 to 7.')
  } else if (raw.bit !== undefined) {
    return fail('Only `bit` RAM reads may include a `bit` index.')
  }
  const scale = validateTransform(raw.scale, 'scale', false)
  if (typeof scale === 'string') return fail(scale)
  const offset = validateTransform(raw.offset, 'offset', true)
  if (typeof offset === 'string') return fail(offset)
  return {
    ok: true,
    value: {
      address: raw.address,
      encoding: typedEncoding,
      ...(typedEncoding === 'bit' ? { bit: raw.bit as number } : {}),
      ...(scale !== undefined ? { scale } : {}),
      ...(offset !== undefined ? { offset } : {})
    }
  }
}

function validateAdapterField(
  raw: unknown,
  index: number,
  memoryBytes: number
): EmulatorValidation<EmulatorStateAdapterFieldManifest> {
  if (!isRecord(raw)) return fail(`Adapter field ${index} must be an object.`)
  if (!canonicalId(raw.key, MAX_FIELD_KEY_CHARS)) {
    return fail(`Adapter field ${index} needs a canonical bounded key.`)
  }
  if (raw.kind !== 'integer' && raw.kind !== 'boolean' && raw.kind !== 'enum') {
    return fail(`Adapter field "${raw.key}" has an unsupported kind.`)
  }
  const read = validateRamRead(raw.read, memoryBytes)
  if (!read.ok) return read
  const unit = raw.unit
  if (unit !== undefined && !displayString(unit, MAX_UNIT_CHARS)) {
    return fail(`Adapter field "${raw.key}" has an invalid unit.`)
  }
  if (raw.kind === 'integer') {
    if (raw.enumValues !== undefined) {
      return fail(`Integer adapter field "${raw.key}" must not include enumValues.`)
    }
    return {
      ok: true,
      value: {
        key: raw.key,
        kind: 'integer',
        read: read.value,
        ...(unit !== undefined ? { unit } : {})
      }
    }
  }
  if (raw.kind === 'boolean') {
    if (raw.enumValues !== undefined) {
      return fail(`Boolean adapter field "${raw.key}" must not include enumValues.`)
    }
    if (read.value.scale !== undefined || read.value.offset !== undefined) {
      return fail(`Boolean adapter field "${raw.key}" must not transform its RAM value.`)
    }
    if (unit !== undefined)
      return fail(`Boolean adapter field "${raw.key}" must not include a unit.`)
    return { ok: true, value: { key: raw.key, kind: 'boolean', read: read.value } }
  }
  if (read.value.scale !== undefined || read.value.offset !== undefined) {
    return fail(`Enum adapter field "${raw.key}" must not transform its RAM value.`)
  }
  if (unit !== undefined) return fail(`Enum adapter field "${raw.key}" must not include a unit.`)
  const enumValues = validateEnumValues(raw.enumValues)
  if (typeof enumValues === 'string') return fail(`Adapter field "${raw.key}": ${enumValues}`)
  return { ok: true, value: { key: raw.key, kind: 'enum', read: read.value, enumValues } }
}

function validateStateWindow(
  raw: unknown,
  memoryBytes: number
): EmulatorValidation<EmulatorStateWindow> {
  if (!isRecord(raw)) return fail('V2 adapter stateWindow must be an object.')
  if (raw.source !== 'system_ram') return fail('V2 adapter stateWindow source must be system_ram.')
  if (!finiteInteger(raw.startAddress, 0, 0xffffffff)) {
    return fail('V2 adapter stateWindow startAddress must be a non-negative 32-bit integer.')
  }
  if (!finiteInteger(raw.byteLength, 1, EMULATOR_MAX_RAM_BYTES)) {
    return fail('V2 adapter stateWindow byteLength is invalid.')
  }
  if (raw.byteLength !== memoryBytes) {
    return fail('V2 adapter memoryBytes must exactly match stateWindow byteLength.')
  }
  if (raw.startAddress + raw.byteLength > 0x1_0000_0000) {
    return fail('V2 adapter stateWindow exceeds the 32-bit system RAM address space.')
  }
  return {
    ok: true,
    value: {
      source: 'system_ram',
      startAddress: raw.startAddress,
      byteLength: raw.byteLength
    }
  }
}

export function isEmulatorButton(value: unknown): value is EmulatorButton {
  return typeof value === 'string' && (EMULATOR_BUTTONS as readonly string[]).includes(value)
}

export function isEmulatorSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

export function isCanonicalEmulatorId(value: unknown): value is string {
  return canonicalId(value)
}

export function validateEmulatorStateAdapterManifest(
  raw: unknown
): EmulatorValidation<EmulatorStateAdapterManifest> {
  if (!isRecord(raw)) return fail('Emulator state adapter manifest must be an object.')
  const encodedBytes = utf8ByteLength(raw)
  if (encodedBytes === null || encodedBytes > EMULATOR_MAX_STATE_ADAPTER_BYTES) {
    return fail(
      `Emulator state adapter manifest exceeds ${EMULATOR_MAX_STATE_ADAPTER_BYTES} bytes.`
    )
  }
  if (
    raw.schemaVersion !== EMULATOR_STATE_ADAPTER_SCHEMA_V1 &&
    raw.schemaVersion !== EMULATOR_STATE_ADAPTER_SCHEMA_V2
  ) {
    return fail(
      `Unsupported emulator adapter schemaVersion (expected ${EMULATOR_STATE_ADAPTER_SCHEMA_V1} or ${EMULATOR_STATE_ADAPTER_SCHEMA_V2}).`
    )
  }
  if (!canonicalId(raw.adapterId)) return fail('Adapter requires a canonical `adapterId`.')
  if (!canonicalId(raw.adapterRevision, MAX_REVISION_CHARS)) {
    return fail('Adapter requires a canonical bounded `adapterRevision`.')
  }
  if (!isEmulatorSha256(raw.schemaSha256))
    return fail('Adapter requires a lowercase SHA-256 `schemaSha256`.')
  if (!canonicalId(raw.coreId)) return fail('Adapter requires a canonical `coreId`.')
  if (!isEmulatorSha256(raw.romSha256))
    return fail('Adapter requires a lowercase SHA-256 `romSha256`.')
  if (!finiteInteger(raw.memoryBytes, 1, EMULATOR_MAX_RAM_BYTES)) {
    return fail(`Adapter memoryBytes must be an integer from 1 to ${EMULATOR_MAX_RAM_BYTES}.`)
  }
  if (
    !Array.isArray(raw.fields) ||
    raw.fields.length === 0 ||
    raw.fields.length > EMULATOR_MAX_STATE_FIELDS
  ) {
    return fail(`Adapter fields must contain 1-${EMULATOR_MAX_STATE_FIELDS} entries.`)
  }

  const fields: EmulatorStateAdapterFieldManifest[] = []
  const keys = new Set<string>()
  let totalReadBytes = 0
  for (let index = 0; index < raw.fields.length; index += 1) {
    const field = validateAdapterField(raw.fields[index], index, raw.memoryBytes)
    if (!field.ok) return field
    if (keys.has(field.value.key)) return fail(`Duplicate adapter field key "${field.value.key}".`)
    keys.add(field.value.key)
    totalReadBytes += readWidth(field.value.read.encoding)
    if (totalReadBytes > EMULATOR_MAX_STATE_READ_BYTES) {
      return fail(`Adapter reads exceed ${EMULATOR_MAX_STATE_READ_BYTES} bytes per observation.`)
    }
    fields.push(field.value)
  }

  if (raw.schemaVersion === EMULATOR_STATE_ADAPTER_SCHEMA_V1) {
    return {
      ok: true,
      value: {
        schemaVersion: EMULATOR_STATE_ADAPTER_SCHEMA_V1,
        adapterId: raw.adapterId,
        adapterRevision: raw.adapterRevision,
        schemaSha256: raw.schemaSha256,
        coreId: raw.coreId,
        romSha256: raw.romSha256,
        memoryBytes: raw.memoryBytes,
        fields
      }
    }
  }
  const stateWindow = validateStateWindow(raw.stateWindow, raw.memoryBytes)
  if (!stateWindow.ok) return stateWindow
  return {
    ok: true,
    value: {
      schemaVersion: EMULATOR_STATE_ADAPTER_SCHEMA_V2,
      adapterId: raw.adapterId,
      adapterRevision: raw.adapterRevision,
      schemaSha256: raw.schemaSha256,
      coreId: raw.coreId,
      romSha256: raw.romSha256,
      memoryBytes: raw.memoryBytes,
      fields,
      stateWindow: stateWindow.value
    }
  }
}

/**
 * Canonical UTF-8 JSON input for a package's `schemaSha256` calculation.
 *
 * The hash field itself is intentionally omitted, avoiding a self-referential
 * declaration. Package tooling hashes the UTF-8 bytes of this exact string;
 * this shared module stays synchronous and crypto-free.
 */
export function canonicalEmulatorStateAdapterSchemaJson(
  adapter: EmulatorStateAdapterManifest
): string {
  const fields = adapter.fields.map((field) => ({
    key: field.key,
    kind: field.kind,
    read: {
      address: field.read.address,
      encoding: field.read.encoding,
      ...(field.read.bit !== undefined ? { bit: field.read.bit } : {}),
      ...(field.read.scale !== undefined ? { scale: field.read.scale } : {}),
      ...(field.read.offset !== undefined ? { offset: field.read.offset } : {})
    },
    ...(field.unit !== undefined ? { unit: field.unit } : {}),
    ...(field.enumValues
      ? {
          enumValues: Object.fromEntries(
            Object.entries(field.enumValues).sort(([left], [right]) => Number(left) - Number(right))
          )
        }
      : {})
  }))
  return JSON.stringify({
    schemaVersion: adapter.schemaVersion,
    adapterId: adapter.adapterId,
    adapterRevision: adapter.adapterRevision,
    coreId: adapter.coreId,
    romSha256: adapter.romSha256,
    memoryBytes: adapter.memoryBytes,
    ...(adapter.schemaVersion === EMULATOR_STATE_ADAPTER_SCHEMA_V2
      ? { stateWindow: adapter.stateWindow }
      : {}),
    fields
  })
}

export function validateEmulatorPackageManifest(
  raw: unknown
): EmulatorValidation<EmulatorPackageManifest> {
  if (!isRecord(raw)) return fail('Emulator package manifest must be an object.')
  const encodedBytes = utf8ByteLength(raw)
  if (encodedBytes === null || encodedBytes > EMULATOR_MAX_MANIFEST_BYTES) {
    return fail(`Emulator package manifest exceeds ${EMULATOR_MAX_MANIFEST_BYTES} bytes.`)
  }
  if (
    raw.schemaVersion !== EMULATOR_PACKAGE_MANIFEST_SCHEMA_V1 &&
    raw.schemaVersion !== EMULATOR_PACKAGE_MANIFEST_SCHEMA_V2
  ) {
    return fail(
      `Unsupported emulator package schemaVersion (expected ${EMULATOR_PACKAGE_MANIFEST_SCHEMA_V1} or ${EMULATOR_PACKAGE_MANIFEST_SCHEMA_V2}).`
    )
  }
  if (!canonicalId(raw.gameId)) return fail('Package requires a canonical `gameId`.')
  if (!canonicalId(raw.coreId)) return fail('Package requires a canonical `coreId`.')
  if (!isEmulatorSha256(raw.romSha256))
    return fail('Package requires a lowercase SHA-256 `romSha256`.')
  if (raw.schemaVersion === EMULATOR_PACKAGE_MANIFEST_SCHEMA_V1) {
    if (!isEmulatorSha256(raw.coreSha256))
      return fail('Package requires a lowercase SHA-256 `coreSha256`.')
    if (raw.stateAdapter === null) {
      return {
        ok: true,
        value: {
          schemaVersion: EMULATOR_PACKAGE_MANIFEST_SCHEMA_V1,
          gameId: raw.gameId,
          coreId: raw.coreId,
          coreSha256: raw.coreSha256,
          romSha256: raw.romSha256,
          stateAdapter: null
        }
      }
    }
    const adapter = validateEmulatorStateAdapterManifest(raw.stateAdapter)
    if (!adapter.ok) return adapter
    if (adapter.value.schemaVersion !== EMULATOR_STATE_ADAPTER_SCHEMA_V1) {
      return fail('V1 package requires a v1 state adapter.')
    }
    if (adapter.value.coreId !== raw.coreId || adapter.value.romSha256 !== raw.romSha256) {
      return fail('State adapter coreId and romSha256 must match its package.')
    }
    return {
      ok: true,
      value: {
        schemaVersion: EMULATOR_PACKAGE_MANIFEST_SCHEMA_V1,
        gameId: raw.gameId,
        coreId: raw.coreId,
        coreSha256: raw.coreSha256,
        romSha256: raw.romSha256,
        stateAdapter: adapter.value
      }
    }
  }
  if (!isEmulatorSha256(raw.coreSha256)) {
    return fail('V2 package requires a lowercase SHA-256 `coreSha256`.')
  }
  if (!isEmulatorSha256(raw.runtimeWasmSha256)) {
    return fail('V2 package requires a lowercase SHA-256 `runtimeWasmSha256`.')
  }
  if (raw.stateAdapter === null) {
    return {
      ok: true,
      value: {
        schemaVersion: EMULATOR_PACKAGE_MANIFEST_SCHEMA_V2,
        gameId: raw.gameId,
        coreId: raw.coreId,
        coreSha256: raw.coreSha256,
        runtimeWasmSha256: raw.runtimeWasmSha256,
        romSha256: raw.romSha256,
        stateAdapter: null
      }
    }
  }
  const adapter = validateEmulatorStateAdapterManifest(raw.stateAdapter)
  if (!adapter.ok) return adapter
  if (adapter.value.schemaVersion !== EMULATOR_STATE_ADAPTER_SCHEMA_V2) {
    return fail('V2 package requires a v2 state adapter.')
  }
  if (adapter.value.coreId !== raw.coreId || adapter.value.romSha256 !== raw.romSha256) {
    return fail('State adapter coreId and romSha256 must match its package.')
  }
  return {
    ok: true,
    value: {
      schemaVersion: EMULATOR_PACKAGE_MANIFEST_SCHEMA_V2,
      gameId: raw.gameId,
      coreId: raw.coreId,
      coreSha256: raw.coreSha256,
      runtimeWasmSha256: raw.runtimeWasmSha256,
      romSha256: raw.romSha256,
      stateAdapter: adapter.value
    }
  }
}

export function validateEmulatorObservationToken(
  raw: unknown
): EmulatorValidation<EmulatorObservationToken> {
  if (!isRecord(raw)) return fail('Emulator observation token must be an object.')
  if (
    typeof raw.observationId !== 'string' ||
    raw.observationId.length === 0 ||
    raw.observationId.length > 128 ||
    raw.observationId.trim() !== raw.observationId ||
    !CANONICAL_OPAQUE_ID.test(raw.observationId)
  ) {
    return fail('Emulator observationId must be a bounded canonical opaque id.')
  }
  if (!finiteInteger(raw.emulationGeneration, 1, Number.MAX_SAFE_INTEGER)) {
    return fail('Emulator emulationGeneration must be a positive safe integer.')
  }
  if (!finiteInteger(raw.frameId, 0, Number.MAX_SAFE_INTEGER)) {
    return fail('Emulator frameId must be a non-negative safe integer.')
  }
  if (!finiteInteger(raw.inputEpoch, 0, Number.MAX_SAFE_INTEGER)) {
    return fail('Emulator inputEpoch must be a non-negative safe integer.')
  }
  return {
    ok: true,
    value: {
      observationId: raw.observationId,
      emulationGeneration: raw.emulationGeneration,
      frameId: raw.frameId,
      inputEpoch: raw.inputEpoch
    }
  }
}

export function validateEmulatorFrameMetadata(
  raw: unknown
): EmulatorValidation<EmulatorFrameMetadata> {
  // This validates a projection only. CanvasEmulatorDriver must independently
  // decode the actual PNG IHDR, compare its dimensions/byte length/hash to this
  // metadata, and enforce the same pixel ceiling before exposing a frame.
  if (!isRecord(raw)) return fail('Emulator frame metadata must be an object.')
  if (raw.mimeType !== 'image/png') return fail('Emulator frame mimeType must be image/png.')
  if (!finiteInteger(raw.width, 1, EMULATOR_MAX_FRAME_EDGE)) {
    return fail(`Emulator frame width must be 1-${EMULATOR_MAX_FRAME_EDGE}.`)
  }
  if (!finiteInteger(raw.height, 1, EMULATOR_MAX_FRAME_EDGE)) {
    return fail(`Emulator frame height must be 1-${EMULATOR_MAX_FRAME_EDGE}.`)
  }
  if (raw.width * raw.height > EMULATOR_MAX_FRAME_PIXELS) {
    return fail(`Emulator frame exceeds ${EMULATOR_MAX_FRAME_PIXELS} pixels.`)
  }
  if (!finiteInteger(raw.byteLength, 1, EMULATOR_MAX_FRAME_BYTES)) {
    return fail(`Emulator frame byteLength must be 1-${EMULATOR_MAX_FRAME_BYTES}.`)
  }
  if (!isEmulatorSha256(raw.hash)) return fail('Emulator frame requires a lowercase SHA-256 hash.')
  if (!canonicalTimestamp(raw.capturedAt))
    return fail('Emulator frame capturedAt must be canonical ISO-8601.')
  return {
    ok: true,
    value: {
      mimeType: 'image/png',
      width: raw.width,
      height: raw.height,
      byteLength: raw.byteLength,
      hash: raw.hash,
      capturedAt: raw.capturedAt
    }
  }
}

function validateMappedStateField(
  raw: unknown,
  index: number
): EmulatorValidation<EmulatorMappedStateField> {
  if (!isRecord(raw)) return fail(`Mapped state field ${index} must be an object.`)
  if (!canonicalId(raw.key, MAX_FIELD_KEY_CHARS)) {
    return fail(`Mapped state field ${index} needs a canonical bounded key.`)
  }
  if (raw.kind === 'integer') {
    if (
      typeof raw.value !== 'number' ||
      !Number.isFinite(raw.value) ||
      Math.abs(raw.value) > EMULATOR_MAX_DECODED_ABS_VALUE
    ) {
      return fail(`Mapped integer field "${raw.key}" has an invalid value.`)
    }
    if (raw.unit !== undefined && !displayString(raw.unit, MAX_UNIT_CHARS)) {
      return fail(`Mapped integer field "${raw.key}" has an invalid unit.`)
    }
    return {
      ok: true,
      value: {
        key: raw.key,
        kind: 'integer',
        value: raw.value,
        ...(raw.unit !== undefined ? { unit: raw.unit } : {})
      }
    }
  }
  if (raw.kind === 'boolean') {
    if (typeof raw.value !== 'boolean')
      return fail(`Mapped boolean field "${raw.key}" has an invalid value.`)
    return { ok: true, value: { key: raw.key, kind: 'boolean', value: raw.value } }
  }
  if (raw.kind === 'enum') {
    if (!displayString(raw.value, MAX_ENUM_VALUE_CHARS)) {
      return fail(`Mapped enum field "${raw.key}" has an invalid value.`)
    }
    return { ok: true, value: { key: raw.key, kind: 'enum', value: raw.value } }
  }
  return fail(`Mapped state field "${raw.key}" has an unsupported kind.`)
}

export function validateEmulatorMappedState(raw: unknown): EmulatorValidation<EmulatorMappedState> {
  if (!isRecord(raw)) return fail('Mapped emulator state must be an object.')
  const encodedBytes = utf8ByteLength(raw)
  if (encodedBytes === null || encodedBytes > EMULATOR_MAX_STATE_BYTES) {
    return fail(`Mapped emulator state exceeds ${EMULATOR_MAX_STATE_BYTES} bytes.`)
  }
  if (raw.kind !== 'mapped') return fail('Mapped emulator state kind must be mapped.')
  if (!canonicalId(raw.adapterId)) return fail('Mapped state requires a canonical adapterId.')
  if (!canonicalId(raw.adapterRevision, MAX_REVISION_CHARS)) {
    return fail('Mapped state requires a canonical adapterRevision.')
  }
  if (!isEmulatorSha256(raw.schemaSha256))
    return fail('Mapped state requires a lowercase schemaSha256.')
  if (!Array.isArray(raw.fields) || raw.fields.length > EMULATOR_MAX_STATE_FIELDS) {
    return fail(`Mapped state must contain at most ${EMULATOR_MAX_STATE_FIELDS} fields.`)
  }
  if (typeof raw.truncated !== 'boolean')
    return fail('Mapped state requires a boolean truncated flag.')
  const fields: EmulatorMappedStateField[] = []
  const keys = new Set<string>()
  for (let index = 0; index < raw.fields.length; index += 1) {
    const field = validateMappedStateField(raw.fields[index], index)
    if (!field.ok) return field
    if (keys.has(field.value.key))
      return fail(`Duplicate mapped state field key "${field.value.key}".`)
    keys.add(field.value.key)
    fields.push(field.value)
  }
  return {
    ok: true,
    value: {
      kind: 'mapped',
      adapterId: raw.adapterId,
      adapterRevision: raw.adapterRevision,
      schemaSha256: raw.schemaSha256,
      fields,
      truncated: raw.truncated
    }
  }
}

export function validateEmulatorObservationState(
  raw: unknown
): EmulatorValidation<EmulatorObservationState> {
  if (!isRecord(raw)) return fail('Emulator observation state must be an object.')
  if (raw.kind === 'mapped') return validateEmulatorMappedState(raw)
  if (raw.kind === 'unavailable' && raw.reason === 'no_verified_adapter') {
    return { ok: true, value: { kind: 'unavailable', reason: 'no_verified_adapter' } }
  }
  return fail('Emulator observation state must be mapped or explicitly unavailable.')
}

export function validateEmulatorObservation(raw: unknown): EmulatorValidation<EmulatorObservation> {
  if (!isRecord(raw)) return fail('Emulator observation must be an object.')
  if (raw.schemaVersion !== EMULATOR_OBSERVATION_SCHEMA_VERSION) {
    return fail(
      `Unsupported emulator observation schemaVersion (expected ${EMULATOR_OBSERVATION_SCHEMA_VERSION}).`
    )
  }
  const token = validateEmulatorObservationToken(raw.token)
  if (!token.ok) return token
  if (!canonicalTimestamp(raw.capturedAt))
    return fail('Emulator observation capturedAt must be canonical ISO-8601.')
  if (typeof raw.humanActive !== 'boolean') {
    return fail('Emulator observation requires a boolean humanActive flag.')
  }
  const frame = validateEmulatorFrameMetadata(raw.frame)
  if (!frame.ok) return frame
  if (raw.capturedAt !== frame.value.capturedAt) {
    return fail('Emulator observation capturedAt must exactly match its frame capturedAt.')
  }
  const state = validateEmulatorObservationState(raw.state)
  if (!state.ok) return state
  return {
    ok: true,
    value: {
      schemaVersion: EMULATOR_OBSERVATION_SCHEMA_VERSION,
      token: token.value,
      capturedAt: raw.capturedAt,
      humanActive: raw.humanActive,
      frame: frame.value,
      state: state.value
    }
  }
}

export function validateEmulatorInputSegment(
  raw: unknown,
  index = 0
): EmulatorValidation<EmulatorInputSegment> {
  if (!isRecord(raw)) return fail(`Emulator input segment ${index} must be an object.`)
  if (!Array.isArray(raw.buttons) || raw.buttons.length > EMULATOR_BUTTONS.length) {
    return fail(`Emulator input segment ${index} has an invalid buttons array.`)
  }
  const buttons: EmulatorButton[] = []
  const seen = new Set<EmulatorButton>()
  for (const value of raw.buttons) {
    if (!isEmulatorButton(value))
      return fail(`Emulator input segment ${index} has an unsupported button.`)
    if (seen.has(value))
      return fail(`Emulator input segment ${index} contains duplicate button "${value}".`)
    seen.add(value)
    buttons.push(value)
  }
  if ((seen.has('up') && seen.has('down')) || (seen.has('left') && seen.has('right'))) {
    return fail(`Emulator input segment ${index} contains opposite directions.`)
  }
  if (!finiteInteger(raw.frames, 1, EMULATOR_STEP_MAX_FRAMES_PER_SEGMENT)) {
    return fail(
      `Emulator input segment ${index} frames must be 1-${EMULATOR_STEP_MAX_FRAMES_PER_SEGMENT}.`
    )
  }
  return { ok: true, value: { buttons, frames: raw.frames } }
}

export function validateEmulatorStepRequest(raw: unknown): EmulatorValidation<EmulatorStepRequest> {
  if (!isRecord(raw)) return fail('Emulator step request must be an object.')
  const expected = validateEmulatorObservationToken(raw.expected)
  if (!expected.ok) return expected
  if (
    !Array.isArray(raw.segments) ||
    raw.segments.length === 0 ||
    raw.segments.length > EMULATOR_STEP_MAX_SEGMENTS
  ) {
    return fail(`Emulator step requires 1-${EMULATOR_STEP_MAX_SEGMENTS} input segments.`)
  }
  const segments: EmulatorInputSegment[] = []
  let totalFrames = 0
  for (let index = 0; index < raw.segments.length; index += 1) {
    const segment = validateEmulatorInputSegment(raw.segments[index], index)
    if (!segment.ok) return segment
    totalFrames += segment.value.frames
    if (totalFrames > EMULATOR_STEP_MAX_TOTAL_FRAMES) {
      return fail(`Emulator step may advance at most ${EMULATOR_STEP_MAX_TOTAL_FRAMES} frames.`)
    }
    segments.push(segment.value)
  }
  if (
    raw.requireIndependentVerifier !== undefined &&
    typeof raw.requireIndependentVerifier !== 'boolean'
  ) {
    return fail('Emulator step requireIndependentVerifier must be a boolean when provided.')
  }
  return {
    ok: true,
    value: {
      expected: expected.value,
      segments,
      ...(raw.requireIndependentVerifier === true ? { requireIndependentVerifier: true } : {})
    }
  }
}

export function validateEmulatorStepToolInput(
  raw: unknown
): EmulatorValidation<EmulatorStepToolInput> {
  if (!isRecord(raw)) return fail('Emulator step tool input must be an object.')
  const observationId = raw.expectedObservationId
  if (
    typeof observationId !== 'string' ||
    observationId.length === 0 ||
    observationId.length > 128 ||
    observationId.trim() !== observationId ||
    !CANONICAL_OPAQUE_ID.test(observationId)
  ) {
    return fail('Emulator step expectedObservationId must be a bounded canonical opaque id.')
  }
  const segmentsRequest = validateEmulatorStepRequest({
    expected: {
      observationId,
      emulationGeneration: 1,
      frameId: 0,
      inputEpoch: 0
    },
    segments: raw.segments,
    ...(raw.requireIndependentVerifier !== undefined
      ? { requireIndependentVerifier: raw.requireIndependentVerifier }
      : {})
  })
  if (!segmentsRequest.ok) return fail(segmentsRequest.reason)
  return {
    ok: true,
    value: {
      expectedObservationId: observationId,
      segments: segmentsRequest.value.segments,
      ...(segmentsRequest.value.requireIndependentVerifier
        ? { requireIndependentVerifier: true }
        : {})
    }
  }
}

function byteAt(memory: Uint8Array, offset: number): number {
  const value = memory[offset]
  if (value === undefined) throw new Error('Adapter RAM read escaped the supplied memory buffer.')
  return value
}

function decodeRamRead(memory: Uint8Array, read: EmulatorRamRead): number {
  if (read.encoding === 'bit') return (byteAt(memory, read.address) >>> (read.bit ?? 0)) & 1
  const width = readWidth(read.encoding)
  let value = 0
  if (isLittleEndianEncoding(read.encoding)) {
    for (let index = width - 1; index >= 0; index -= 1) {
      value = value * 256 + byteAt(memory, read.address + index)
    }
  } else {
    for (let index = 0; index < width; index += 1) {
      value = value * 256 + byteAt(memory, read.address + index)
    }
  }
  if (isSignedEncoding(read.encoding)) {
    const sign = 2 ** (width * 8 - 1)
    if (value >= sign) value -= sign * 2
  }
  return value
}

/**
 * Decode exactly the adapter's declared reads. This never returns raw RAM or
 * accepts a caller-provided address; an enum outside its manifest map becomes
 * the bounded literal `unknown` rather than leaking the underlying integer.
 */
export function decodeEmulatorMappedState(
  adapter: EmulatorStateAdapterManifest,
  memory: Uint8Array
): EmulatorValidation<EmulatorMappedState> {
  if (!(memory instanceof Uint8Array)) return fail('Emulator adapter memory must be a Uint8Array.')
  if (memory.byteLength !== adapter.memoryBytes || memory.byteLength > EMULATOR_MAX_RAM_BYTES) {
    return fail('Emulator adapter memory must exactly match the declared bounded memory range.')
  }
  const fields: EmulatorMappedStateField[] = []
  try {
    for (const field of adapter.fields) {
      const rawValue = decodeRamRead(memory, field.read)
      if (field.kind === 'boolean') {
        fields.push({ key: field.key, kind: 'boolean', value: rawValue !== 0 })
        continue
      }
      if (field.kind === 'enum') {
        fields.push({
          key: field.key,
          kind: 'enum',
          value: field.enumValues?.[String(rawValue)] ?? 'unknown'
        })
        continue
      }
      const value = rawValue * (field.read.scale ?? 1) + (field.read.offset ?? 0)
      if (!Number.isFinite(value) || Math.abs(value) > EMULATOR_MAX_DECODED_ABS_VALUE) {
        return fail(`Decoded emulator field "${field.key}" exceeded its numeric bound.`)
      }
      fields.push({
        key: field.key,
        kind: 'integer',
        value,
        ...(field.unit ? { unit: field.unit } : {})
      })
    }
  } catch {
    return fail('Emulator adapter could not read the supplied bounded memory.')
  }
  return validateEmulatorMappedState({
    kind: 'mapped',
    adapterId: adapter.adapterId,
    adapterRevision: adapter.adapterRevision,
    schemaSha256: adapter.schemaSha256,
    fields,
    truncated: false
  })
}
