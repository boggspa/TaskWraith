/**
 * Wire envelope for the human-collaboration TRANSPORT (L5-2).
 *
 * Collaboration rides the existing dumb relay (one `/v1/session/<roomId>` room
 * per collaborator: host = `mac` seat, collaborator = `iphone` seat; the relay
 * forwards every frame verbatim and holds no key material). Collaboration has
 * its OWN end-to-end crypto (HumanCollaborationCipher), so unlike the owner
 * bridge it does NOT wrap an E2eeSession — it speaks these messages directly:
 *
 *   - `collab.req`  — a handshake REQUEST (begin / confirm). The handshake runs
 *     BEFORE session keys exist, so it is plaintext; every field it carries
 *     (pubkeys, nonces, the SAS confirm code, transcript signatures) is public
 *     by the SAS design — secrecy comes from the out-of-band human compare, not
 *     from hiding these on the wire.
 *   - `collab.res`  — the host's response to a request, correlated by `reqId`.
 *   - `humanCollaboration.enc` — a SEALED application frame (subscribe / append
 *     comment / projection update) once the session is established. This is the
 *     existing HumanCollaborationEncryptedFrame, unchanged.
 *
 * This module is node-free (shared) so both the main-process host transport and
 * the collaborator client validate inbound bytes the same way.
 */
import type { HumanCollaborationEncryptedFrame } from './HumanCollaborationProtocol'
import { HUMAN_COLLABORATION_PROTOCOL } from './HumanCollaborationProtocol'

export const HUMAN_COLLABORATION_TRANSPORT_PROTOCOL =
  'taskwraith-human-collaboration-transport-v1'

export type HumanCollaborationTransportMethod = 'begin' | 'confirm'

export interface HumanCollaborationTransportRequest {
  t: 'collab.req'
  protocol: typeof HUMAN_COLLABORATION_TRANSPORT_PROTOCOL
  reqId: string
  method: HumanCollaborationTransportMethod
  params: unknown
}

export interface HumanCollaborationTransportResponse {
  t: 'collab.res'
  protocol: typeof HUMAN_COLLABORATION_TRANSPORT_PROTOCOL
  reqId: string
  ok: boolean
  result?: unknown
  error?: string
}

export type HumanCollaborationTransportMessage =
  | HumanCollaborationTransportRequest
  | HumanCollaborationTransportResponse
  | HumanCollaborationEncryptedFrame

/** Coordinates a collaborator needs to reach the host's room over the relay. */
export interface HumanCollaborationTransportCoordinates {
  protocol: typeof HUMAN_COLLABORATION_PROTOCOL
  relayUrl: string
  roomId: string
}

export function makeTransportRequest(
  reqId: string,
  method: HumanCollaborationTransportMethod,
  params: unknown
): HumanCollaborationTransportRequest {
  return { t: 'collab.req', protocol: HUMAN_COLLABORATION_TRANSPORT_PROTOCOL, reqId, method, params }
}

export function makeTransportResponse(
  reqId: string,
  outcome: { ok: true; result: unknown } | { ok: false; error: string }
): HumanCollaborationTransportResponse {
  return outcome.ok
    ? { t: 'collab.res', protocol: HUMAN_COLLABORATION_TRANSPORT_PROTOCOL, reqId, ok: true, result: outcome.result }
    : { t: 'collab.res', protocol: HUMAN_COLLABORATION_TRANSPORT_PROTOCOL, reqId, ok: false, error: outcome.error }
}

/**
 * Parse + shape-validate an inbound transport frame. Returns null for anything
 * unrecognized (the caller drops it) — never throws, so a hostile peer can't
 * crash the transport with malformed JSON. Bounds reqId length and requires the
 * transport protocol tag on req/res so cross-protocol confusion is rejected.
 */
export function parseTransportMessage(data: string): HumanCollaborationTransportMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const candidate = parsed as Record<string, unknown>
  if (candidate.t === 'humanCollaboration.enc') {
    return isEncryptedFrame(candidate) ? (candidate as unknown as HumanCollaborationEncryptedFrame) : null
  }
  if (candidate.protocol !== HUMAN_COLLABORATION_TRANSPORT_PROTOCOL) return null
  if (candidate.t === 'collab.req') {
    if (!isReqId(candidate.reqId)) return null
    if (candidate.method !== 'begin' && candidate.method !== 'confirm') return null
    return {
      t: 'collab.req',
      protocol: HUMAN_COLLABORATION_TRANSPORT_PROTOCOL,
      reqId: candidate.reqId,
      method: candidate.method,
      params: candidate.params
    }
  }
  if (candidate.t === 'collab.res') {
    if (!isReqId(candidate.reqId) || typeof candidate.ok !== 'boolean') return null
    return {
      t: 'collab.res',
      protocol: HUMAN_COLLABORATION_TRANSPORT_PROTOCOL,
      reqId: candidate.reqId,
      ok: candidate.ok,
      ...(candidate.result !== undefined ? { result: candidate.result } : {}),
      ...(typeof candidate.error === 'string' ? { error: candidate.error } : {})
    }
  }
  return null
}

function isReqId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

function isEncryptedFrame(candidate: Record<string, unknown>): boolean {
  return (
    candidate.protocol === HUMAN_COLLABORATION_PROTOCOL &&
    typeof candidate.sessionId === 'string' &&
    (candidate.direction === 'hostToCollaborator' || candidate.direction === 'collaboratorToHost') &&
    typeof candidate.seq === 'number' &&
    typeof candidate.nonce === 'string' &&
    typeof candidate.ct === 'string' &&
    typeof candidate.tag === 'string'
  )
}
