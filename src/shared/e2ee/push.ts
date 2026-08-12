import type { KeyObject } from 'node:crypto'
import { createHash } from 'node:crypto'
import {
  b64,
  exportRawEd25519PublicKey,
  importRawEd25519PublicKey,
  signEd25519,
  verifyEd25519,
  type KeyPair
} from './keys'

/*
 * Tier-2 push gateway protocol (docs/ios-push-gateway-design.md P3): the
 * phone-signed APNs register/deregister requests and the Mac-signed push
 * trigger, modeled byte-for-byte on resolve.ts. Everything here is
 * keyless — this module sits inside relay/src/server.ts's import graph via
 * the gateway, so it must never touch apnsSendCore or any credential.
 *
 * LOCKED DECISIONS (2026-08-11, this implementation — the design doc left
 * them open; golden vectors in crossImplVectors.test.ts + Swift
 * InteropVectorsTests pin every one):
 * - ONE module. The doc names pushTrigger.ts in §5.2 and push.ts in §6.1;
 *   its own P3 phase row lumps all three signing strings together.
 * - PUSH_PROTOCOL = 'taskwraith-push-trigger-v1', NOT the doc's
 *   'taskwraith-push-v1': that literal is already pushSeal.ts's AAD/HKDF
 *   domain-separation prefix, and two protocols must not share one.
 *   Nothing has shipped, so the rename costs nothing.
 * - Signing-string byte layout follows resolveSigningString mechanically;
 *   booleans encode as String(boolean) ('true'/'false'), which is also
 *   what Swift's String(Bool) yields.
 * - The register string signs env AND notifyFinishedTurns: outside the
 *   signature a MITM could flip a device onto the wrong Apple gateway or
 *   silently re-enable a disabled opt-out.
 * - No client-asserted pairID anywhere — the relay derives it from the
 *   signed iphoneIdentityPubKey (design §5.3).
 */
export const PUSH_PROTOCOL = 'taskwraith-push-trigger-v1'

export type TriggerReason = 'runComplete' | 'runFailed'

export interface TriggerRequest {
  v: 1
  /** b64 raw32 — signer/principal (the Mac). */
  macIdentityPubKey: string
  /** b64 raw32 — push target (the phone). */
  targetIphoneIdentityPubKey: string
  reason: TriggerReason
  threadId?: string
  runId?: string
  taskId?: string
  /** == apns-collapse-id; the cross-tier dedup key (sharedApnsCollapseId). */
  collapseId: string
  generatedAt?: string
  issuedAt: number
  /** b64, ≥8 decoded bytes, single-use within the freshness window. */
  nonce: string
  /** Ed25519 over triggerSigningString. */
  sig: string
}

export interface ApnsRegisterRequest {
  v: 1
  /** The host this token is for (multi-host). */
  macIdentityPubKey: string
  /** The principal (signer). */
  iphoneIdentityPubKey: string
  /** APNs routing handle (not a secret and not content). */
  deviceTokenHex: string
  /** From iOS #if DEBUG; validated exactly. */
  env: 'production' | 'sandbox'
  /** Opt-out, self-asserted by the phone. Canonical default: true. */
  notifyFinishedTurns: boolean
  issuedAt: number
  nonce: string
  /** Ed25519 over apnsRegisterSigningString (signed by the PHONE). */
  sig: string
}

export interface ApnsDeregisterRequest {
  v: 1
  macIdentityPubKey: string
  iphoneIdentityPubKey: string
  issuedAt: number
  nonce: string
  sig: string
}

export function triggerSigningString(input: {
  macIdentityPubKey: string
  targetIphoneIdentityPubKey: string
  reason: TriggerReason
  threadId?: string
  runId?: string
  taskId?: string
  collapseId: string
  issuedAt: number
  nonce: string
}): string {
  return [
    PUSH_PROTOCOL,
    'trigger',
    input.macIdentityPubKey,
    input.targetIphoneIdentityPubKey,
    input.reason,
    input.threadId ?? '',
    input.runId ?? '',
    input.taskId ?? '',
    input.collapseId,
    String(input.issuedAt),
    input.nonce
  ].join('|')
}

export function apnsRegisterSigningString(input: {
  macIdentityPubKey: string
  iphoneIdentityPubKey: string
  deviceTokenHex: string
  env: 'production' | 'sandbox'
  notifyFinishedTurns: boolean
  issuedAt: number
  nonce: string
}): string {
  return [
    PUSH_PROTOCOL,
    'apns-register',
    input.macIdentityPubKey,
    input.iphoneIdentityPubKey,
    input.deviceTokenHex,
    input.env,
    String(input.notifyFinishedTurns),
    String(input.issuedAt),
    input.nonce
  ].join('|')
}

export function apnsDeregisterSigningString(input: {
  macIdentityPubKey: string
  iphoneIdentityPubKey: string
  issuedAt: number
  nonce: string
}): string {
  return [
    PUSH_PROTOCOL,
    'apns-deregister',
    input.macIdentityPubKey,
    input.iphoneIdentityPubKey,
    String(input.issuedAt),
    input.nonce
  ].join('|')
}

export function signTriggerRequest(
  macIdentity: KeyPair,
  input: {
    targetIphoneIdentityPubKey: string
    reason: TriggerReason
    threadId?: string
    runId?: string
    taskId?: string
    collapseId: string
    generatedAt?: string
    issuedAt: number
    nonce: string
  }
): TriggerRequest {
  const macIdentityPubKey = b64.encode(exportRawEd25519PublicKey(macIdentity.publicKey))
  const sig = signEd25519(
    macIdentity.privateKey,
    Buffer.from(triggerSigningString({ ...input, macIdentityPubKey }), 'utf8')
  )
  return {
    v: 1,
    macIdentityPubKey,
    targetIphoneIdentityPubKey: input.targetIphoneIdentityPubKey,
    reason: input.reason,
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    collapseId: input.collapseId,
    ...(input.generatedAt !== undefined ? { generatedAt: input.generatedAt } : {}),
    issuedAt: input.issuedAt,
    nonce: input.nonce,
    sig: b64.encode(sig)
  }
}

export function signApnsRegisterRequest(
  iphoneIdentity: KeyPair,
  input: {
    macIdentityPubKey: string
    deviceTokenHex: string
    env: 'production' | 'sandbox'
    notifyFinishedTurns: boolean
    issuedAt: number
    nonce: string
  }
): ApnsRegisterRequest {
  const iphoneIdentityPubKey = b64.encode(exportRawEd25519PublicKey(iphoneIdentity.publicKey))
  const sig = signEd25519(
    iphoneIdentity.privateKey,
    Buffer.from(apnsRegisterSigningString({ ...input, iphoneIdentityPubKey }), 'utf8')
  )
  return {
    v: 1,
    macIdentityPubKey: input.macIdentityPubKey,
    iphoneIdentityPubKey,
    deviceTokenHex: input.deviceTokenHex,
    env: input.env,
    notifyFinishedTurns: input.notifyFinishedTurns,
    issuedAt: input.issuedAt,
    nonce: input.nonce,
    sig: b64.encode(sig)
  }
}

export function signApnsDeregisterRequest(
  iphoneIdentity: KeyPair,
  input: { macIdentityPubKey: string; issuedAt: number; nonce: string }
): ApnsDeregisterRequest {
  const iphoneIdentityPubKey = b64.encode(exportRawEd25519PublicKey(iphoneIdentity.publicKey))
  const sig = signEd25519(
    iphoneIdentity.privateKey,
    Buffer.from(apnsDeregisterSigningString({ ...input, iphoneIdentityPubKey }), 'utf8')
  )
  return {
    v: 1,
    macIdentityPubKey: input.macIdentityPubKey,
    iphoneIdentityPubKey,
    issuedAt: input.issuedAt,
    nonce: input.nonce,
    sig: b64.encode(sig)
  }
}

function isRawKeyB64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false
  try {
    return b64.decode(value).length === 32
  } catch {
    return false
  }
}

function isNonce(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false
  try {
    return b64.decode(value).length >= 8
  } catch {
    return false
  }
}

function isFiniteIssuedAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

const DEVICE_TOKEN_HEX_PATTERN = /^[0-9a-f]{16,512}$/i
/** Apple caps apns-collapse-id at 64 bytes; ours is ASCII by construction. */
const COLLAPSE_ID_MAX = 64
const TRIGGER_STRING_FIELD_MAX = 200

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

export function isTriggerRequest(value: unknown): value is TriggerRequest {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.v === 1 &&
    isRawKeyB64(v.macIdentityPubKey) &&
    isRawKeyB64(v.targetIphoneIdentityPubKey) &&
    (v.reason === 'runComplete' || v.reason === 'runFailed') &&
    (v.threadId === undefined || isBoundedString(v.threadId, TRIGGER_STRING_FIELD_MAX)) &&
    (v.runId === undefined || isBoundedString(v.runId, TRIGGER_STRING_FIELD_MAX)) &&
    (v.taskId === undefined || isBoundedString(v.taskId, TRIGGER_STRING_FIELD_MAX)) &&
    isBoundedString(v.collapseId, COLLAPSE_ID_MAX) &&
    (v.generatedAt === undefined || isBoundedString(v.generatedAt, 40)) &&
    isFiniteIssuedAt(v.issuedAt) &&
    isNonce(v.nonce) &&
    typeof v.sig === 'string'
  )
}

export function isApnsRegisterRequest(value: unknown): value is ApnsRegisterRequest {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.v === 1 &&
    isRawKeyB64(v.macIdentityPubKey) &&
    isRawKeyB64(v.iphoneIdentityPubKey) &&
    typeof v.deviceTokenHex === 'string' &&
    DEVICE_TOKEN_HEX_PATTERN.test(v.deviceTokenHex) &&
    (v.env === 'production' || v.env === 'sandbox') &&
    typeof v.notifyFinishedTurns === 'boolean' &&
    isFiniteIssuedAt(v.issuedAt) &&
    isNonce(v.nonce) &&
    typeof v.sig === 'string'
  )
}

export function isApnsDeregisterRequest(value: unknown): value is ApnsDeregisterRequest {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.v === 1 &&
    isRawKeyB64(v.macIdentityPubKey) &&
    isRawKeyB64(v.iphoneIdentityPubKey) &&
    isFiniteIssuedAt(v.issuedAt) &&
    isNonce(v.nonce) &&
    typeof v.sig === 'string'
  )
}

function verifyWith(rawKeyB64: string, message: string, sigB64: string): boolean {
  let publicKey: KeyObject
  try {
    publicKey = importRawEd25519PublicKey(b64.decode(rawKeyB64))
  } catch {
    return false
  }
  let sig: Buffer
  try {
    sig = b64.decode(sigB64)
  } catch {
    return false
  }
  return verifyEd25519(publicKey, Buffer.from(message, 'utf8'), sig)
}

/** Signed by the MAC. */
export function verifyTriggerRequest(request: TriggerRequest): boolean {
  return verifyWith(request.macIdentityPubKey, triggerSigningString(request), request.sig)
}

/** Signed by the PHONE (the in-body iphoneIdentityPubKey). */
export function verifyApnsRegisterRequest(request: ApnsRegisterRequest): boolean {
  return verifyWith(request.iphoneIdentityPubKey, apnsRegisterSigningString(request), request.sig)
}

export function verifyApnsDeregisterRequest(request: ApnsDeregisterRequest): boolean {
  return verifyWith(request.iphoneIdentityPubKey, apnsDeregisterSigningString(request), request.sig)
}

/**
 * The one pairID derivation, shared by the Mac bridge and the relay gateway
 * (RemoteBridgeRuntime re-exports this). One-way: the relay stores hashes,
 * never phone identity keys, and a pairID cannot be reversed to a device.
 */
export function pairIdFromIdentityPubKey(iphoneIdentityPubKey: string): string {
  const raw = b64.decode(iphoneIdentityPubKey)
  return `iphone-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
}

/**
 * One signed trigger per target device — the Mac-side P6 helper. Pure so the
 * XOR site's frames are unit-testable without a bridge runtime; the collapse
 * id is derived ONCE (all targets share it, which is exactly what lets two
 * devices' banners collapse against each other's Macs too).
 */
export function signTriggerRequestsForTargets(
  macIdentity: KeyPair,
  targetIphoneIdentityPubKeys: readonly string[],
  input: {
    reason: TriggerReason
    threadId?: string
    runId?: string
    taskId?: string
    issuedAt: number
    makeNonce: () => string
  }
): TriggerRequest[] {
  const collapseId = sharedApnsCollapseId({
    reason: input.reason,
    threadId: input.threadId,
    runId: input.runId
  })
  return targetIphoneIdentityPubKeys.map((target) =>
    signTriggerRequest(macIdentity, {
      targetIphoneIdentityPubKey: target,
      reason: input.reason,
      threadId: input.threadId,
      runId: input.runId,
      taskId: input.taskId,
      collapseId,
      issuedAt: input.issuedAt,
      nonce: input.makeNonce()
    })
  )
}

/**
 * The cross-tier collapse id (design §7.3): byte-identical on Tier-1
 * (direct APNs), Tier-2 (relay trigger), and the relay's coalesce key, so
 * two Macs or two tiers reporting the same terminal event collapse to one
 * banner. Hashed so no thread/run identifier rides in an APNs header, and
 * sized for Apple's 64-byte apns-collapse-id cap.
 */
export function sharedApnsCollapseId(input: {
  reason: string
  threadId?: string
  runId?: string
}): string {
  const digest = createHash('sha256')
    .update([input.reason, input.threadId ?? '', input.runId ?? ''].join('|'))
    .digest('hex')
  return `tw1-${digest.slice(0, 56)}`
}
