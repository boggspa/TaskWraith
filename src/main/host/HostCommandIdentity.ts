/**
 * Host command identity minting + migration ID aliases (Wave 2D-1 Lane C).
 *
 * Responsibilities:
 * - Document and resolve the migration alias contract:
 *   Host `approvalId` === legacy remote `toolCallId`
 *   Host `questionId` === legacy remote `promptId`
 * - Mint UUID `commandId` values and bounded idempotency keys of the form
 *   `clientClass:clientId:uuid`
 * - Construct `HostActorIdentity` only from an explicitly typed,
 *   transport-verified authenticated client context supplied by a binding
 *
 * Non-goals (fail closed / never implemented here):
 * - Authentication or credential verification
 * - Accepting wire-asserted actor claims
 * - Opening listeners or widening remote access
 * - Persisting secrets, receipts, or domain state
 * - command() integration (later session)
 */

import { randomUUID } from 'node:crypto'

import {
  HOST_PROTOCOL_MAX_ID,
  type HostActorIdentity,
  type HostClientClass,
  type HostDecodeResult
} from '../../shared/hostProtocol'

/** Host field name for approvals on host.command targets. */
export const HOST_APPROVAL_ID_FIELD = 'approvalId' as const
/** Legacy remote/iOS field that is byte-equal to Host approvalId. */
export const HOST_APPROVAL_ID_LEGACY_ALIAS = 'toolCallId' as const

/** Host field name for questions on host.command targets. */
export const HOST_QUESTION_ID_FIELD = 'questionId' as const
/** Legacy remote/iOS field that is byte-equal to Host questionId. */
export const HOST_QUESTION_ID_LEGACY_ALIAS = 'promptId' as const

/**
 * Frozen migration alias contract. Host protocol uses the canonical names;
 * remote cards historically used toolCallId / promptId for the same bytes.
 */
export const HOST_APPROVAL_ID_MIGRATION_ALIAS = {
  hostField: HOST_APPROVAL_ID_FIELD,
  legacyField: HOST_APPROVAL_ID_LEGACY_ALIAS
} as const

export const HOST_QUESTION_ID_MIGRATION_ALIAS = {
  hostField: HOST_QUESTION_ID_FIELD,
  legacyField: HOST_QUESTION_ID_LEGACY_ALIAS
} as const

const HOST_CLIENT_CLASSES: ReadonlySet<HostClientClass> = new Set([
  'desktop',
  'tui',
  'ios',
  'test'
])

/** RFC 4122 UUID shape (hex + hyphens). Case-insensitive. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** ASCII C0 controls + DEL — never allowed inside Host identity material. */
const UNSAFE_CONTROL_RE = /[\u0000-\u001f\u007f]/

export type HostUuidFactory = () => string

/**
 * Explicit transport-verified authenticated client context.
 *
 * Bindings (Desktop-local Host connection, authenticated TUI Host connection,
 * paired remote iOS) supply this only after their own authentication succeeds.
 * This module never authenticates, never opens a listener, and never treats a
 * client-supplied wire `actor` object as authoritative.
 */
export interface HostTransportVerifiedClientContext {
  readonly clientClass: HostClientClass
  readonly clientId: string
  /**
   * Stable actor key from the binding (local desktop session, TUI session
   * subject, or paired-device subject). Never taken from a wire actor claim.
   */
  readonly actorId: string
  /**
   * Optional pairing/session subject retained for binding diagnostics only.
   * Not copied onto HostActorIdentity; still fail-closed when unsafe.
   */
  readonly subjectId?: string
}

export interface HostMintedCommandIdentity {
  readonly commandId: string
  readonly idempotencyKey: string
  readonly actor: HostActorIdentity
}

export interface HostParsedIdempotencyKey {
  readonly clientClass: HostClientClass
  readonly clientId: string
  readonly uuid: string
}

function fail(error: string): HostDecodeResult<never> {
  return { ok: false, error }
}

function isHostClientClass(value: unknown): value is HostClientClass {
  return typeof value === 'string' && HOST_CLIENT_CLASSES.has(value as HostClientClass)
}

/**
 * Fail-closed identifier safety: non-empty, bounded, no leading/trailing
 * whitespace, no ASCII control characters. Does not silently trim.
 */
export function isSafeHostIdentifier(
  value: unknown,
  max: number = HOST_PROTOCOL_MAX_ID
): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > max) return false
  if (value.trim() !== value) return false
  if (UNSAFE_CONTROL_RE.test(value)) return false
  return true
}

export function isHostUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * Resolve the approval migration alias.
 * `approvalId` and `toolCallId` name the same identifier bytes.
 * Both present and unequal ⇒ conflict (fail closed).
 */
export function resolveHostApprovalId(input: {
  approvalId?: unknown
  toolCallId?: unknown
}): HostDecodeResult<string> {
  return resolveMigrationAliasId(
    { canonical: input.approvalId, alias: input.toolCallId },
    HOST_APPROVAL_ID_FIELD,
    HOST_APPROVAL_ID_LEGACY_ALIAS
  )
}

/**
 * Resolve the question migration alias.
 * `questionId` and `promptId` name the same identifier bytes.
 * Both present and unequal ⇒ conflict (fail closed).
 */
export function resolveHostQuestionId(input: {
  questionId?: unknown
  promptId?: unknown
}): HostDecodeResult<string> {
  return resolveMigrationAliasId(
    { canonical: input.questionId, alias: input.promptId },
    HOST_QUESTION_ID_FIELD,
    HOST_QUESTION_ID_LEGACY_ALIAS
  )
}

function resolveMigrationAliasId(
  input: { canonical?: unknown; alias?: unknown },
  canonicalName: string,
  aliasName: string
): HostDecodeResult<string> {
  const hasCanonical = input.canonical !== undefined && input.canonical !== null
  const hasAlias = input.alias !== undefined && input.alias !== null

  if (!hasCanonical && !hasAlias) {
    return fail(`${canonicalName} (alias ${aliasName}) is required`)
  }

  if (hasCanonical && hasAlias) {
    if (typeof input.canonical !== 'string' || typeof input.alias !== 'string') {
      return fail(`${canonicalName}/${aliasName} must be strings`)
    }
    if (input.canonical !== input.alias) {
      return fail(`${canonicalName} and ${aliasName} conflict`)
    }
  }

  const raw = hasCanonical ? input.canonical : input.alias
  if (!isSafeHostIdentifier(raw)) {
    return fail(`${canonicalName} is empty, oversized, or unsafe`)
  }
  return { ok: true, value: raw }
}

/**
 * Construct HostActorIdentity only from a binding-supplied verified context.
 * Never trusts a nested wire `actor` claim; only copies the three exact fields.
 */
export function hostActorIdentityFromVerifiedContext(
  context: HostTransportVerifiedClientContext
): HostDecodeResult<HostActorIdentity> {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return fail('verified client context must be an object')
  }
  if (!isHostClientClass(context.clientClass)) {
    return fail('clientClass is invalid')
  }
  if (!isSafeHostIdentifier(context.clientId)) {
    return fail('clientId is empty, oversized, or unsafe')
  }
  if (!isSafeHostIdentifier(context.actorId)) {
    return fail('actorId is empty, oversized, or unsafe')
  }
  if (context.subjectId !== undefined && !isSafeHostIdentifier(context.subjectId)) {
    return fail('subjectId is empty, oversized, or unsafe')
  }

  return {
    ok: true,
    value: {
      actorId: context.actorId,
      clientId: context.clientId,
      clientClass: context.clientClass
    }
  }
}

/**
 * Mint a UUID commandId. Inject `uuid` only in tests.
 */
export function mintHostCommandId(
  uuid: HostUuidFactory = randomUUID
): HostDecodeResult<string> {
  let raw: string
  try {
    raw = uuid()
  } catch {
    return fail('commandId mint failed')
  }
  if (!isSafeHostIdentifier(raw) || !isHostUuid(raw)) {
    return fail('commandId mint produced an unsafe or non-UUID value')
  }
  return { ok: true, value: raw }
}

/**
 * Mint a bounded idempotency key: `clientClass:clientId:uuid`.
 * Fails when any segment is unsafe or the compound key exceeds HOST_PROTOCOL_MAX_ID.
 */
export function mintHostIdempotencyKey(
  context: Pick<HostTransportVerifiedClientContext, 'clientClass' | 'clientId'>,
  uuid: HostUuidFactory = randomUUID
): HostDecodeResult<string> {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return fail('verified client context must be an object')
  }
  if (!isHostClientClass(context.clientClass)) {
    return fail('clientClass is invalid')
  }
  if (!isSafeHostIdentifier(context.clientId)) {
    return fail('clientId is empty, oversized, or unsafe')
  }

  let idPart: string
  try {
    idPart = uuid()
  } catch {
    return fail('idempotencyKey mint failed')
  }
  if (!isSafeHostIdentifier(idPart) || !isHostUuid(idPart)) {
    return fail('idempotencyKey mint produced an unsafe or non-UUID value')
  }

  const key = `${context.clientClass}:${context.clientId}:${idPart}`
  if (key.length > HOST_PROTOCOL_MAX_ID) {
    return fail('idempotencyKey exceeds protocol bound')
  }
  if (!isSafeHostIdentifier(key)) {
    return fail('idempotencyKey is empty, oversized, or unsafe')
  }
  return { ok: true, value: key }
}

/**
 * Parse a minted idempotency key back into segments.
 * clientClass is the first colon segment; uuid is the last; clientId is the middle
 * (may itself contain colons).
 */
export function parseHostIdempotencyKey(
  key: unknown
): HostDecodeResult<HostParsedIdempotencyKey> {
  if (!isSafeHostIdentifier(key)) {
    return fail('idempotencyKey is empty, oversized, or unsafe')
  }
  const first = key.indexOf(':')
  const last = key.lastIndexOf(':')
  if (first <= 0 || last <= first) {
    return fail('idempotencyKey format is invalid')
  }
  const clientClassRaw = key.slice(0, first)
  const clientId = key.slice(first + 1, last)
  const uuidPart = key.slice(last + 1)
  if (!isHostClientClass(clientClassRaw)) {
    return fail('idempotencyKey clientClass is invalid')
  }
  if (!isSafeHostIdentifier(clientId)) {
    return fail('idempotencyKey clientId is empty, oversized, or unsafe')
  }
  if (!isHostUuid(uuidPart)) {
    return fail('idempotencyKey uuid is invalid')
  }
  return {
    ok: true,
    value: {
      clientClass: clientClassRaw,
      clientId,
      uuid: uuidPart
    }
  }
}

/**
 * Mint a full command identity package from a transport-verified context.
 * commandId and the idempotency uuid are independent UUIDs.
 */
export function mintHostCommandIdentity(
  context: HostTransportVerifiedClientContext,
  options?: {
    commandIdUuid?: HostUuidFactory
    idempotencyUuid?: HostUuidFactory
  }
): HostDecodeResult<HostMintedCommandIdentity> {
  const actor = hostActorIdentityFromVerifiedContext(context)
  if (!actor.ok) return actor

  const commandId = mintHostCommandId(options?.commandIdUuid ?? randomUUID)
  if (!commandId.ok) return commandId

  const idempotencyKey = mintHostIdempotencyKey(
    context,
    options?.idempotencyUuid ?? randomUUID
  )
  if (!idempotencyKey.ok) return idempotencyKey

  return {
    ok: true,
    value: {
      commandId: commandId.value,
      idempotencyKey: idempotencyKey.value,
      actor: actor.value
    }
  }
}
