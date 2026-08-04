import { createHash } from 'node:crypto'
import { isAbsolute, parse, resolve } from 'node:path'
import { types as utilTypes } from 'node:util'
import {
  verifyRunPermissionPosture,
  type RunPermissionPostureContext
} from './RunPermissionPosture'
import type {
  AgenticServiceId,
  AgenticServicePolicy,
  EffectiveRunPermissions,
  ExternalPathGrant,
  PermissionPresetId,
  ProviderId
} from './store/types'

const ROOT_ID = /^twso-root-v1:[0-9a-f]{64}$/
const LOWER_HEX_256 = /^[0-9a-f]{64}$/
const MAX_TEXT_LENGTH = 4_096
const MAX_PROMPT_LENGTH = 1_048_576

const PROVIDERS = [
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral'
] as const satisfies readonly ProviderId[]

const PRESET_IDS = [
  'read_only',
  'plan',
  'default',
  'workspace_write',
  'full_access',
  'custom'
] as const satisfies readonly PermissionPresetId[]

export const SCHEDULED_OCCURRENCE_POSTURE_AGENTIC_SERVICE_IDS = [
  'shellCommands',
  'fileChanges',
  'externalPublish',
  'mcpTools',
  'subThreadDelegation',
  'canvasInteraction',
  'sketchCanvas',
  'meshCanvas',
  'canvasEval',
  'crossThreadRead',
  'threadMessage',
  'mediaEditing',
  'mediaRecording',
  'webBrowsing'
] as const satisfies readonly AgenticServiceId[]

const POSTURE_CONTEXT_KEYS = [
  'provider',
  'scope',
  'appRunId',
  'appChatId',
  'prompt',
  'workflowMode',
  'runtimeProfileId',
  'ensembleParticipantId',
  'ensembleLaneId'
] as const

const EFFECTIVE_PERMISSION_KEYS = [
  'presetId',
  'approvalMode',
  'agenticServices',
  'networkAccess',
  'externalPathGrants',
  'workspaceGrantServiceIds',
  'readOnly'
] as const

const EXTERNAL_GRANT_KEYS = [
  'id',
  'provider',
  'bindingVersion',
  'workspaceId',
  'chatId',
  'appRunId',
  'path',
  'kind',
  'access',
  'duration',
  'securityScopedBookmark',
  'issuedBy',
  'signature',
  'createdAt',
  'order'
] as const

const EXTERNAL_GRANT_REQUIRED_KEYS = [
  'id',
  'provider',
  'path',
  'kind',
  'access',
  'duration',
  'createdAt'
] as const

declare const scheduledOccurrencePostureCapabilityBrand: unique symbol

/** Opaque proof issued only after the main posture HMAC has verified. */
export interface ScheduledOccurrencePostureCapability {
  readonly [scheduledOccurrencePostureCapabilityBrand]: never
}

export interface ScheduledOccurrencePostureIssueInput {
  readonly rootId: string
  readonly workspaceId: string
  readonly workspaceRealPath: string
  readonly approvalMode: string
  readonly effectivePermissions: EffectiveRunPermissions
  readonly signature: string
  readonly context: RunPermissionPostureContext
}

export interface ScheduledOccurrenceCanonicalPostureContext {
  readonly provider: ProviderId
  readonly scope: 'workspace'
  readonly appRunId: string
  readonly appChatId: string
  readonly prompt: string
  readonly workflowMode: 'normal' | 'plan'
  readonly runtimeProfileId: string | null
  readonly ensembleParticipantId: string | null
  readonly ensembleLaneId: string | null
}

export interface ScheduledOccurrencePostureAuthority {
  readonly schemaVersion: 1
  readonly rootId: string
  readonly workspaceId: string
  readonly workspaceRealPath: string
  readonly promptSha256: string
  readonly sourceSignature: string
  readonly signedPosture: Readonly<{
    approvalMode: string
    effectivePermissions: EffectiveRunPermissions
    context: ScheduledOccurrenceCanonicalPostureContext
  }>
}

/** Trusted, verifier-instance-bound authority reader supplied to seal checks. */
export interface ScheduledOccurrencePostureResolver {
  consume(
    capability: ScheduledOccurrencePostureCapability
  ): ScheduledOccurrencePostureAuthority | null
}

export interface ScheduledOccurrencePostureVerifier {
  readonly resolver: ScheduledOccurrencePostureResolver
  issue(input: ScheduledOccurrencePostureIssueInput): ScheduledOccurrencePostureCapability | null
  dispose(): void
}

type SnapshotValue =
  | null
  | boolean
  | number
  | string
  | SnapshotValue[]
  | { [key: string]: SnapshotValue }

/**
 * Create one scheduler posture-capability issuer. Capability storage belongs to
 * this verifier instance: another verifier cannot resolve its capabilities,
 * and disposing the issuer revokes every capability it previously returned.
 */
export function createScheduledOccurrencePostureVerifier(
  mainPostureSecret: Buffer | string
): ScheduledOccurrencePostureVerifier {
  const secret = copyStrongSecret(mainPostureSecret)
  let disposed = false
  let authorityByCapability = new WeakMap<object, ScheduledOccurrencePostureAuthority>()

  const resolver: ScheduledOccurrencePostureResolver = Object.freeze({
    consume: (
      capability: ScheduledOccurrencePostureCapability
    ): ScheduledOccurrencePostureAuthority | null => {
      if (disposed || !capability || typeof capability !== 'object') return null
      const authority = authorityByCapability.get(capability as object) ?? null
      authorityByCapability.delete(capability as object)
      return authority
    }
  })

  return Object.freeze({
    resolver,
    issue: (
      input: ScheduledOccurrencePostureIssueInput
    ): ScheduledOccurrencePostureCapability | null => {
      if (disposed) throw new Error('The scheduled occurrence posture verifier is disposed.')
      try {
        const snapshot = snapshotPostureIssueInput(input)
        const rootId = requireRootId(snapshot.rootId)
        const workspaceId = requireTrimmedText(snapshot.workspaceId, 'workspace id')
        const workspaceRealPath = requireCanonicalWorkspacePath(
          snapshot.workspaceRealPath
        )
        const approvalMode = approvalModeValue(snapshot.approvalMode)
        const signature = requireLowerHex(snapshot.signature, 'posture signature')
        const effectivePermissions = canonicalEffectivePermissions(
          snapshot.effectivePermissions
        )
        const context = canonicalContextAuthority(snapshot.context)
        if (effectivePermissions.approvalMode !== approvalMode) return null
        if (
          effectivePermissions.readOnly !==
          (approvalMode === 'plan' || effectivePermissions.presetId === 'read_only')
        ) {
          return null
        }
        if (
          !externalGrantBindingsMatch(
            effectivePermissions.externalPathGrants,
            context,
            workspaceId
          )
        ) {
          return null
        }
        if (
          !verifyRunPermissionPosture(
            secret,
            approvalMode,
            effectivePermissions,
            signature,
            context
          )
        ) {
          return null
        }

        const signedPosture = deepFreeze({
          approvalMode,
          effectivePermissions,
          context
        })
        const authority = deepFreeze({
          schemaVersion: 1 as const,
          rootId,
          workspaceId,
          workspaceRealPath,
          promptSha256: createHash('sha256').update(context.prompt).digest('hex'),
          sourceSignature: signature,
          signedPosture
        })
        const capability = Object.freeze({}) as ScheduledOccurrencePostureCapability
        authorityByCapability.set(capability, authority)
        return capability
      } catch {
        return null
      }
    },
    dispose: (): void => {
      if (disposed) return
      disposed = true
      authorityByCapability = new WeakMap()
      secret.fill(0)
    }
  })
}

function snapshotPostureIssueInput(
  input: ScheduledOccurrencePostureIssueInput
): Record<string, SnapshotValue> {
  const snapshot = strictDataSnapshot(input, 'posture issue input')
  if (!isSnapshotRecord(snapshot)) throw new TypeError('Posture issue input must be an object.')
  assertExactKeys(
    snapshot,
    [
      'rootId',
      'workspaceId',
      'workspaceRealPath',
      'approvalMode',
      'effectivePermissions',
      'signature',
      'context'
    ],
    'posture issue input'
  )
  return deepFreeze(snapshot)
}

function canonicalEffectivePermissions(value: SnapshotValue): EffectiveRunPermissions {
  if (!isSnapshotRecord(value)) throw new TypeError('Effective permissions must be an object.')
  assertExactKeys(value, EFFECTIVE_PERMISSION_KEYS, 'effective permissions')
  const presetId = oneOf(value.presetId, PRESET_IDS, 'permission preset')
  const approvalMode = approvalModeValue(value.approvalMode)
  const agenticServices = canonicalAgenticServices(value.agenticServices)
  const networkAccess = oneOf(
    value.networkAccess,
    ['allow', 'deny'] as const,
    'network access'
  )
  const externalPathGrants = canonicalExternalPathGrants(value.externalPathGrants)
  const workspaceGrantServiceIds = canonicalWorkspaceGrantServiceIds(
    value.workspaceGrantServiceIds
  )
  if (typeof value.readOnly !== 'boolean') {
    throw new TypeError('Effective permission readOnly must be boolean.')
  }
  return deepFreeze({
    presetId,
    approvalMode,
    agenticServices,
    networkAccess,
    externalPathGrants,
    workspaceGrantServiceIds,
    readOnly: value.readOnly
  })
}

function canonicalAgenticServices(
  value: SnapshotValue
): Record<AgenticServiceId, AgenticServicePolicy> {
  if (!isSnapshotRecord(value)) throw new TypeError('Agentic services must be an object.')
  assertExactKeys(value, SCHEDULED_OCCURRENCE_POSTURE_AGENTIC_SERVICE_IDS, 'agentic services')
  const result = Object.create(null) as Record<AgenticServiceId, AgenticServicePolicy>
  for (const service of SCHEDULED_OCCURRENCE_POSTURE_AGENTIC_SERVICE_IDS) {
    result[service] = oneOf(
      value[service],
      ['ask', 'workspace', 'allow', 'deny'] as const,
      `agentic service ${service}`
    )
  }
  return deepFreeze(result)
}

function canonicalExternalPathGrants(value: SnapshotValue): ExternalPathGrant[] {
  if (!Array.isArray(value)) throw new TypeError('External path grants must be an array.')
  const ids = new Set<string>()
  return deepFreeze(
    value.map((entry, index) => {
      if (!isSnapshotRecord(entry)) {
        throw new TypeError(`External path grant ${index} must be an object.`)
      }
      assertKnownKeys(entry, EXTERNAL_GRANT_KEYS, `external path grant ${index}`)
      assertRequiredKeys(entry, EXTERNAL_GRANT_REQUIRED_KEYS, `external path grant ${index}`)
      const id = requireTrimmedText(entry.id, 'external path grant id')
      if (ids.has(id)) throw new TypeError('External path grant ids must be unique.')
      ids.add(id)
      const provider = oneOf(entry.provider, PROVIDERS, 'external path grant provider')
      const path = requireCanonicalAbsolutePath(entry.path, 'external path grant path')
      const kind = oneOf(entry.kind, ['file', 'directory'] as const, 'external path grant kind')
      const access = oneOf(entry.access, ['read', 'write'] as const, 'external path grant access')
      const duration = oneOf(
        entry.duration,
        ['thisRun', 'thisThread', 'workspace'] as const,
        'external path grant duration'
      )
      const createdAt = requireCanonicalIso(entry.createdAt, 'external path grant createdAt')
      const grant: ExternalPathGrant = {
        id,
        provider,
        path,
        kind,
        access,
        duration,
        createdAt
      }
      if (hasOwn(entry, 'bindingVersion')) {
        if (entry.bindingVersion !== 2) throw new TypeError('External path grant version is invalid.')
        grant.bindingVersion = 2
      }
      for (const key of ['workspaceId', 'chatId', 'appRunId'] as const) {
        if (hasOwn(entry, key)) grant[key] = requireTrimmedText(entry[key], `grant ${key}`)
      }
      if (hasOwn(entry, 'securityScopedBookmark')) {
        grant.securityScopedBookmark = requireText(
          entry.securityScopedBookmark,
          'security-scoped bookmark',
          MAX_PROMPT_LENGTH
        )
      }
      if (hasOwn(entry, 'issuedBy')) {
        if (entry.issuedBy !== 'main') throw new TypeError('External grant issuer is invalid.')
        grant.issuedBy = 'main'
      }
      if (hasOwn(entry, 'signature')) {
        grant.signature = requireLowerHex(entry.signature, 'external grant signature')
      }
      if (hasOwn(entry, 'order')) {
        if (!Number.isSafeInteger(entry.order) || (entry.order as number) < 0) {
          throw new TypeError('External grant order is invalid.')
        }
        grant.order = entry.order as number
      }
      return deepFreeze(grant)
    })
  )
}

function canonicalWorkspaceGrantServiceIds(value: SnapshotValue): AgenticServiceId[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Workspace grant service ids must be an array.')
  }
  const seen = new Set<AgenticServiceId>()
  return deepFreeze(
    value.map((entry) => {
      const service = oneOf(
        entry,
        SCHEDULED_OCCURRENCE_POSTURE_AGENTIC_SERVICE_IDS,
        'workspace grant service id'
      )
      if (seen.has(service)) throw new TypeError('Workspace grant service ids must be unique.')
      seen.add(service)
      return service
    })
  )
}

function canonicalContextAuthority(
  value: SnapshotValue
): ScheduledOccurrenceCanonicalPostureContext {
  if (!isSnapshotRecord(value)) throw new TypeError('Posture context must be an object.')
  assertExactKeys(value, POSTURE_CONTEXT_KEYS, 'posture context')
  return deepFreeze({
    provider: oneOf(value.provider, PROVIDERS, 'posture provider'),
    scope: oneOf(value.scope, ['workspace'] as const, 'posture scope'),
    appRunId: requireTrimmedText(value.appRunId, 'posture run id'),
    appChatId: requireTrimmedText(value.appChatId, 'posture chat id'),
    prompt: requireText(value.prompt, 'posture prompt', MAX_PROMPT_LENGTH),
    workflowMode: oneOf(
      value.workflowMode,
      ['normal', 'plan'] as const,
      'posture workflow mode'
    ),
    runtimeProfileId: nullableTrimmedText(value.runtimeProfileId, 'runtime profile id'),
    ensembleParticipantId: nullableTrimmedText(
      value.ensembleParticipantId,
      'ensemble participant id'
    ),
    ensembleLaneId: nullableTrimmedText(value.ensembleLaneId, 'ensemble lane id')
  })
}

function externalGrantBindingsMatch(
  grants: readonly ExternalPathGrant[],
  context: ScheduledOccurrenceCanonicalPostureContext,
  workspaceId: string
): boolean {
  return grants.every(
    (grant) =>
      grant.provider === context.provider &&
      grant.bindingVersion === 2 &&
      grant.workspaceId === workspaceId &&
      grant.chatId === context.appChatId &&
      grant.issuedBy === 'main' &&
      typeof grant.signature === 'string' &&
      (grant.appRunId === undefined || grant.appRunId === context.appRunId) &&
      (grant.duration !== 'thisRun' || grant.appRunId === context.appRunId)
  )
}

/**
 * Descriptor-only deep snapshot. No property value is fetched through normal
 * access, so a getter cannot change the bytes verified versus the bytes sealed.
 */
function strictDataSnapshot(
  value: unknown,
  label: string,
  ancestors: Set<object> = new Set()
): SnapshotValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`${label} contains a noncanonical number.`)
    }
    return value
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${label} contains unsupported ${typeof value} data.`)
  }
  // Reject proxies before any reflective operation can invoke a hostile trap.
  // `util.types.isProxy` inspects the VM object identity without consulting the
  // proxy's own traps, unlike Object.getPrototypeOf/ownKeys/descriptors.
  if (utilTypes.isProxy(value)) throw new TypeError(`${label} cannot contain proxies.`)
  if (ancestors.has(value)) throw new TypeError(`${label} cannot be cyclic.`)
  const prototype = Object.getPrototypeOf(value)
  const isArray = Array.isArray(value)
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must use standard data prototypes.`)
  }
  ancestors.add(value)
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => typeof key !== 'string')) {
      throw new TypeError(`${label} cannot contain symbol keys.`)
    }
    if (isArray) {
      const lengthDescriptor = descriptors.length
      if (!lengthDescriptor || !('value' in lengthDescriptor)) {
        throw new TypeError(`${label} has an invalid array length.`)
      }
      const length = lengthDescriptor.value
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new TypeError(`${label} has an invalid array length.`)
      }
      const expectedKeys = Array.from({ length }, (_, index) => String(index)).concat('length')
      if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !(key in descriptors))) {
        throw new TypeError(`${label} must be dense and cannot have extra properties.`)
      }
      const output: SnapshotValue[] = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new TypeError(`${label} must contain enumerable data elements.`)
        }
        output.push(strictDataSnapshot(descriptor.value, `${label}[${index}]`, ancestors))
      }
      return output
    }
    const output = Object.create(null) as Record<string, SnapshotValue>
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${label} must contain only enumerable data properties.`)
      }
      output[key] = strictDataSnapshot(descriptor.value, `${label}.${key}`, ancestors)
    }
    return output
  } finally {
    ancestors.delete(value)
  }
}

function copyStrongSecret(value: Buffer | string): Buffer {
  const secret = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : typeof value === 'string'
      ? Buffer.from(value, 'utf8')
      : Buffer.alloc(0)
  if (secret.byteLength < 32) {
    secret.fill(0)
    throw new TypeError('The main posture secret must contain at least 32 bytes.')
  }
  return secret
}

function requireRootId(value: SnapshotValue): string {
  if (typeof value !== 'string' || !ROOT_ID.test(value)) {
    throw new TypeError('A canonical scheduled occurrence root id is required.')
  }
  return value
}

function requireLowerHex(value: SnapshotValue, label: string): string {
  if (typeof value !== 'string' || !LOWER_HEX_256.test(value)) {
    throw new TypeError(`${label} must be canonical SHA-256 hex.`)
  }
  return value
}

function requireTrimmedText(value: SnapshotValue, label: string): string {
  const text = requireText(value, label, MAX_TEXT_LENGTH)
  if (text !== text.trim()) throw new TypeError(`${label} must be trimmed text.`)
  return text
}

function nullableTrimmedText(value: SnapshotValue, label: string): string | null {
  return value === null ? null : requireTrimmedText(value, label)
}

function requireText(value: SnapshotValue, label: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes('\0')
  ) {
    throw new TypeError(`${label} must be bounded non-empty text.`)
  }
  return value
}

function requireCanonicalAbsolutePath(value: SnapshotValue, label: string): string {
  const path = requireTrimmedText(value, label)
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(`${label} must be a canonical absolute path.`)
  }
  return path
}

function requireCanonicalWorkspacePath(value: SnapshotValue): string {
  const path = requireCanonicalAbsolutePath(value, 'workspace real path')
  if (parse(path).root === path) {
    throw new TypeError('Workspace real path cannot be a filesystem root.')
  }
  return path
}

function requireCanonicalIso(value: SnapshotValue, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a timestamp.`)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`)
  }
  return value
}

function approvalModeValue(value: SnapshotValue): string {
  return oneOf(value, ['plan', 'default', 'auto_edit'] as const, 'approval mode')
}

function oneOf<const T extends string>(
  value: SnapshotValue,
  allowed: readonly T[],
  label: string
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${label} is invalid.`)
  }
  return value as T
}

function hasOwn(value: Record<string, SnapshotValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function assertExactKeys(
  value: Record<string, SnapshotValue>,
  keys: readonly string[],
  label: string
): void {
  const ownKeys = Object.keys(value)
  if (
    ownKeys.length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new TypeError(`${label} has an invalid field set.`)
  }
}

function assertKnownKeys(
  value: Record<string, SnapshotValue>,
  keys: readonly string[],
  label: string
): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new TypeError(`${label} has an invalid field set.`)
  }
}

function assertRequiredKeys(
  value: Record<string, SnapshotValue>,
  keys: readonly string[],
  label: string
): void {
  if (keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError(`${label} is missing required fields.`)
  }
}

function isSnapshotRecord(value: SnapshotValue): value is Record<string, SnapshotValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}
