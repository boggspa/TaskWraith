import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import type { HostActorIdentity, HostClientClass } from '../shared/hostProtocol'

export const HOST_PERMISSION_CONSENT_SCHEMA_VERSION = 1 as const
export const HOST_PERMISSION_CONSENT_PURPOSE = 'taskwraith:host-permission-consent:v1' as const
const KEY_BYTES = 32
const MAX_PROOF_AGE_MS = 5 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 30 * 1000
const SHA256_HEX = /^[a-f0-9]{64}$/
const CLIENT_CLASSES: ReadonlySet<HostClientClass> = new Set([
  'desktop',
  'tui',
  'ios',
  'test',
  'host-cli'
])

export type HostConsentPostureId = 'workspace_write' | 'full_access'

/**
 * Exact, Host-minted evidence for one authenticated configure command.
 *
 * The client may request acknowledgement with `postureConsent: true`, but it
 * cannot supply this record or its signature on the wire. The standalone Host
 * derives every field from the authenticated call context plus the validated
 * configure command and signs the complete binding before profile persistence.
 */
export interface HostPermissionConsentProvenance {
  readonly schemaVersion: typeof HOST_PERMISSION_CONSENT_SCHEMA_VERSION
  readonly purpose: typeof HOST_PERMISSION_CONSENT_PURPOSE
  readonly commandId: string
  readonly commandFingerprint: string
  readonly actor: HostActorIdentity
  readonly threadId: string
  readonly providerId: string
  readonly workspaceId: string
  readonly workspacePath: string
  readonly modelId: string
  readonly postureId: HostConsentPostureId
  readonly offerRevision: string
  readonly issuedAt: string
  readonly acknowledgedAt: string
  readonly keyEpoch: string
}

export interface HostPermissionConsentEnvelope {
  readonly provenance: HostPermissionConsentProvenance
  readonly signature: string
}

export interface HostPermissionConsentRequest {
  readonly commandId: string
  readonly commandFingerprint: string
  readonly actor: HostActorIdentity
  readonly threadId: string
  readonly providerId: string
  readonly modelId: string
  readonly postureId: HostConsentPostureId
  readonly offerRevision: string
  readonly issuedAt: string
}

export type HostPermissionConsentProofRequest = Omit<
  HostPermissionConsentRequest,
  'commandFingerprint'
>

export interface HostPermissionConsentIssueInput extends HostPermissionConsentRequest {
  readonly workspaceId: string
  readonly workspacePath: string
}

export interface HostPermissionConsentExpectedSelection {
  readonly threadId: string
  readonly providerId: string
  readonly workspaceId: string
  readonly workspacePath: string
  readonly modelId: string
  readonly postureId: HostConsentPostureId
  readonly offerRevision: string
}

export interface HostPermissionConsentAuthorityPort {
  verifyRequestProof(request: HostPermissionConsentProofRequest, proof: unknown): boolean
  issue(input: HostPermissionConsentIssueInput): HostPermissionConsentEnvelope
  verify(
    envelope: unknown,
    expected: HostPermissionConsentExpectedSelection
  ): HostPermissionConsentProvenance | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index])
}

function canonicalText(value: unknown, max = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- authority ids reject C0 controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function canonicalPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 16_000 &&
    value.trim() === value &&
    isAbsolute(value) &&
    resolve(value) === value &&
    // eslint-disable-next-line no-control-regex -- canonical paths reject C0 controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function canonicalActor(value: unknown): HostActorIdentity | null {
  if (!isRecord(value) || !exactKeys(value, ['actorId', 'clientId', 'clientClass'])) return null
  if (
    !canonicalText(value.actorId) ||
    !canonicalText(value.clientId) ||
    typeof value.clientClass !== 'string' ||
    !CLIENT_CLASSES.has(value.clientClass as HostClientClass)
  ) {
    return null
  }
  return {
    actorId: value.actorId,
    clientId: value.clientId,
    clientClass: value.clientClass as HostClientClass
  }
}

function cloneProvenance(value: HostPermissionConsentProvenance): HostPermissionConsentProvenance {
  return { ...value, actor: { ...value.actor } }
}

/** Shape validation only. Authenticity still requires authority.verify(). */
export function decodeHostPermissionConsentEnvelope(
  value: unknown
): HostPermissionConsentEnvelope | null {
  if (!isRecord(value) || !exactKeys(value, ['provenance', 'signature'])) return null
  if (typeof value.signature !== 'string' || !SHA256_HEX.test(value.signature)) return null
  const raw = value.provenance
  if (
    !isRecord(raw) ||
    !exactKeys(raw, [
      'schemaVersion',
      'purpose',
      'commandId',
      'commandFingerprint',
      'actor',
      'threadId',
      'providerId',
      'workspaceId',
      'workspacePath',
      'modelId',
      'postureId',
      'offerRevision',
      'issuedAt',
      'acknowledgedAt',
      'keyEpoch'
    ]) ||
    raw.schemaVersion !== HOST_PERMISSION_CONSENT_SCHEMA_VERSION ||
    raw.purpose !== HOST_PERMISSION_CONSENT_PURPOSE ||
    !canonicalText(raw.commandId) ||
    typeof raw.commandFingerprint !== 'string' ||
    !SHA256_HEX.test(raw.commandFingerprint) ||
    !canonicalText(raw.threadId) ||
    !canonicalText(raw.providerId) ||
    !canonicalText(raw.workspaceId) ||
    !canonicalPath(raw.workspacePath) ||
    !canonicalText(raw.modelId) ||
    (raw.postureId !== 'workspace_write' && raw.postureId !== 'full_access') ||
    !canonicalText(raw.offerRevision) ||
    !canonicalIso(raw.issuedAt) ||
    !canonicalIso(raw.acknowledgedAt) ||
    typeof raw.keyEpoch !== 'string' ||
    !SHA256_HEX.test(raw.keyEpoch)
  ) {
    return null
  }
  const actor = canonicalActor(raw.actor)
  if (!actor) return null
  return {
    provenance: {
      schemaVersion: HOST_PERMISSION_CONSENT_SCHEMA_VERSION,
      purpose: HOST_PERMISSION_CONSENT_PURPOSE,
      commandId: raw.commandId,
      commandFingerprint: raw.commandFingerprint,
      actor,
      threadId: raw.threadId,
      providerId: raw.providerId,
      workspaceId: raw.workspaceId,
      workspacePath: raw.workspacePath,
      modelId: raw.modelId,
      postureId: raw.postureId,
      offerRevision: raw.offerRevision,
      issuedAt: raw.issuedAt,
      acknowledgedAt: raw.acknowledgedAt,
      keyEpoch: raw.keyEpoch
    },
    signature: value.signature
  }
}

function canonicalPayload(value: HostPermissionConsentProvenance): string {
  return JSON.stringify([
    value.schemaVersion,
    value.purpose,
    value.commandId,
    value.commandFingerprint,
    value.actor.actorId,
    value.actor.clientId,
    value.actor.clientClass,
    value.threadId,
    value.providerId,
    value.workspaceId,
    value.workspacePath,
    value.modelId,
    value.postureId,
    value.offerRevision,
    value.issuedAt,
    value.acknowledgedAt,
    value.keyEpoch
  ])
}

function expectedSelectionIsValid(value: HostPermissionConsentExpectedSelection): boolean {
  return (
    canonicalText(value.threadId) &&
    canonicalText(value.providerId) &&
    canonicalText(value.workspaceId) &&
    canonicalPath(value.workspacePath) &&
    canonicalText(value.modelId) &&
    (value.postureId === 'workspace_write' || value.postureId === 'full_access') &&
    canonicalText(value.offerRevision)
  )
}

function proofRequestIsValid(value: HostPermissionConsentProofRequest): boolean {
  return (
    canonicalText(value.commandId) &&
    canonicalActor(value.actor) !== null &&
    canonicalText(value.threadId) &&
    canonicalText(value.providerId) &&
    canonicalText(value.modelId) &&
    value.postureId === 'full_access' &&
    canonicalText(value.offerRevision) &&
    canonicalIso(value.issuedAt)
  )
}

function canonicalProofPayload(value: HostPermissionConsentProofRequest): string {
  return JSON.stringify([
    HOST_PERMISSION_CONSENT_PURPOSE,
    'user-presence-proof',
    value.commandId,
    value.actor.actorId,
    value.actor.clientId,
    value.actor.clientClass,
    value.threadId,
    value.providerId,
    value.modelId,
    value.postureId,
    value.offerRevision,
    value.issuedAt
  ])
}

/** Shared TUI/Host proof primitive. The 32-byte launch secret stays memory-only. */
export function createHostPermissionConsentProof(
  secret: Buffer,
  request: HostPermissionConsentProofRequest
): string {
  if (
    !Buffer.isBuffer(secret) ||
    secret.byteLength !== KEY_BYTES ||
    !proofRequestIsValid(request)
  ) {
    throw new TypeError('Host permission consent proof input is invalid.')
  }
  return createHmac('sha256', secret).update(canonicalProofPayload(request), 'utf8').digest('hex')
}

interface ActiveFullAccessGrant {
  readonly signature: string
  readonly provenance: HostPermissionConsentProvenance
}

/** Process-local revocation authority. It deliberately starts empty on restart. */
export class HostFullAccessGrantRegistry {
  private readonly grants = new Map<string, ActiveFullAccessGrant>()

  activateVerified(
    envelope: HostPermissionConsentEnvelope,
    provenance: HostPermissionConsentProvenance
  ): void {
    const decoded = decodeHostPermissionConsentEnvelope(envelope)
    if (
      !decoded ||
      provenance.postureId !== 'full_access' ||
      decoded.signature !== envelope.signature ||
      canonicalPayload(decoded.provenance) !== canonicalPayload(provenance)
    ) {
      throw new TypeError('Only verified Full Access consent may activate a grant.')
    }
    this.grants.set(provenance.threadId, {
      signature: envelope.signature,
      provenance: cloneProvenance(provenance)
    })
  }

  matches(
    envelope: unknown,
    provenance: HostPermissionConsentProvenance,
    expected: HostPermissionConsentExpectedSelection
  ): boolean {
    const decoded = decodeHostPermissionConsentEnvelope(envelope)
    const active = this.grants.get(expected.threadId)
    return Boolean(
      decoded &&
      active &&
      active.signature === decoded.signature &&
      canonicalPayload(active.provenance) === canonicalPayload(provenance) &&
      provenance.threadId === expected.threadId &&
      provenance.providerId === expected.providerId &&
      provenance.workspaceId === expected.workspaceId &&
      provenance.workspacePath === expected.workspacePath &&
      provenance.modelId === expected.modelId &&
      provenance.postureId === expected.postureId &&
      provenance.offerRevision === expected.offerRevision
    )
  }

  revokeThread(threadId: string): void {
    this.grants.delete(threadId)
  }

  clear(): void {
    this.grants.clear()
  }
}

/**
 * In-memory proof verifier plus independent Host signer. The launch-client
 * proof key can never mint provenance; dispose() zeroes both process-only keys.
 */
export class HostPermissionConsentAuthority implements HostPermissionConsentAuthorityPort {
  private proofKey: Buffer | null
  private signingKey: Buffer | null
  private readonly keyEpoch: string
  private readonly consumedProofCommandIds = new Set<string>()

  constructor(
    proofSecret: Buffer,
    private readonly now: () => string = () => new Date().toISOString(),
    signingSecret: Buffer = randomBytes(KEY_BYTES)
  ) {
    if (
      !Buffer.isBuffer(proofSecret) ||
      proofSecret.byteLength !== KEY_BYTES ||
      !Buffer.isBuffer(signingSecret) ||
      signingSecret.byteLength !== KEY_BYTES
    ) {
      throw new TypeError('Host permission consent authority requires two 32-byte keys.')
    }
    this.proofKey = Buffer.from(proofSecret)
    this.signingKey = Buffer.from(signingSecret)
    this.keyEpoch = createHash('sha256').update(signingSecret).digest('hex')
  }

  verifyRequestProof(request: HostPermissionConsentProofRequest, proof: unknown): boolean {
    const key = this.proofKey
    if (
      !key ||
      !proofRequestIsValid(request) ||
      typeof proof !== 'string' ||
      !SHA256_HEX.test(proof)
    ) {
      return false
    }
    const expected = createHmac('sha256', key)
      .update(canonicalProofPayload(request), 'utf8')
      .digest()
    const supplied = Buffer.from(proof, 'hex')
    if (
      supplied.byteLength !== expected.byteLength ||
      !timingSafeEqual(supplied, expected) ||
      this.consumedProofCommandIds.has(request.commandId)
    ) {
      return false
    }
    this.consumedProofCommandIds.add(request.commandId)
    return true
  }

  issue(input: HostPermissionConsentIssueInput): HostPermissionConsentEnvelope {
    const key = this.signingKey
    if (!key) throw new Error('Host permission consent authority is disposed.')
    const actor = canonicalActor(input.actor)
    const acknowledgedAt = this.now()
    const issuedMs = Date.parse(input.issuedAt)
    const acknowledgedMs = Date.parse(acknowledgedAt)
    if (
      !canonicalText(input.commandId) ||
      !SHA256_HEX.test(input.commandFingerprint) ||
      !actor ||
      !expectedSelectionIsValid(input) ||
      !canonicalIso(input.issuedAt) ||
      !canonicalIso(acknowledgedAt) ||
      issuedMs < acknowledgedMs - MAX_PROOF_AGE_MS ||
      issuedMs > acknowledgedMs + MAX_FUTURE_SKEW_MS
    ) {
      throw new TypeError('Host permission consent binding is invalid.')
    }
    const provenance: HostPermissionConsentProvenance = {
      schemaVersion: HOST_PERMISSION_CONSENT_SCHEMA_VERSION,
      purpose: HOST_PERMISSION_CONSENT_PURPOSE,
      commandId: input.commandId,
      commandFingerprint: input.commandFingerprint,
      actor,
      threadId: input.threadId,
      providerId: input.providerId,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      modelId: input.modelId,
      postureId: input.postureId,
      offerRevision: input.offerRevision,
      issuedAt: input.issuedAt,
      acknowledgedAt,
      keyEpoch: this.keyEpoch
    }
    return {
      provenance: cloneProvenance(provenance),
      signature: createHmac('sha256', key)
        .update(canonicalPayload(provenance), 'utf8')
        .digest('hex')
    }
  }

  verify(
    envelope: unknown,
    expected: HostPermissionConsentExpectedSelection
  ): HostPermissionConsentProvenance | null {
    const key = this.signingKey
    if (!key || !expectedSelectionIsValid(expected)) return null
    const decoded = decodeHostPermissionConsentEnvelope(envelope)
    if (!decoded) return null
    const provenance = decoded.provenance
    if (
      provenance.threadId !== expected.threadId ||
      provenance.providerId !== expected.providerId ||
      provenance.workspaceId !== expected.workspaceId ||
      provenance.workspacePath !== expected.workspacePath ||
      provenance.modelId !== expected.modelId ||
      provenance.postureId !== expected.postureId ||
      provenance.offerRevision !== expected.offerRevision ||
      provenance.keyEpoch !== this.keyEpoch
    ) {
      return null
    }
    const expectedSignature = createHmac('sha256', key)
      .update(canonicalPayload(provenance), 'utf8')
      .digest()
    const suppliedSignature = Buffer.from(decoded.signature, 'hex')
    if (
      suppliedSignature.byteLength !== expectedSignature.byteLength ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      return null
    }
    return cloneProvenance(provenance)
  }

  dispose(): void {
    this.proofKey?.fill(0)
    this.signingKey?.fill(0)
    this.proofKey = null
    this.signingKey = null
    this.consumedProofCommandIds.clear()
  }
}
