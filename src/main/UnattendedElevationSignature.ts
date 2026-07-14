// MAIN-process HMAC signer for an unattended-elevation ACK (P2 opt-in). A
// WorkflowDefinition.unattendedElevation lets a user authorize a scheduled
// (unattended) workflow to run at Default or Full-Workspace-Access permissions
// instead of the safe-by-default 'plan' clamp. The ack is a plain JSON blob on
// the definition — untrusted when read from workflows.json — so it is bound by
// an HMAC over the canonical {workflowId, workspacePath, level,
// acknowledgedApprovalMode, authorityDigest} tuple. The ack is MINTED server-side only (a
// dedicated IPC) and RE-VERIFIED at every dispatch (ComposerService / the
// ensemble orchestrator) before its level is honored; an unsigned / tampered /
// stale ack fails verification and falls back to the safe 'plan' posture. This
// is a renderer/persistence integrity boundary, not a defense against an attacker
// who can execute MAIN-process code or extract its in-memory signing secret.
//
// Mirrors src/main/RunPermissionPosture.ts exactly (same key, same
// deterministic serialization style, same constant-time hex-guarded verify) and
// is bound to the same `externalGrantSigningSecret` by the impure caller in
// index.ts. The caller canonicalizes `workspacePath` (mirror canonicalPath used
// by the external-path-grant signer) BEFORE signing/verifying so a path that
// differs only in trailing-slash/case does not change the signature.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { UnattendedElevationLevel } from './UnattendedPostureGate'

export interface UnattendedElevationTuple {
  workflowId: string
  /** Already canonicalized by the caller (mirror the external-path-grant signer). */
  workspacePath: string
  level: UnattendedElevationLevel
  /** The template approvalMode the ack authorizes — server-derived at sign time. */
  acknowledgedApprovalMode: string
  /** SHA-256 of the normalized execution-authority envelope. */
  authorityDigest: string
}

/**
 * Deterministic serialization: recursively sorts object keys so two
 * semantically-equal tuples sign identically regardless of property order.
 * (Copied from RunPermissionPosture's stableStringify — kept local so this
 * module has no coupling beyond the shared secret.)
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`
}

export function canonicalUnattendedElevation(tuple: UnattendedElevationTuple): string {
  return stableStringify({
    workflowId: tuple.workflowId,
    workspacePath: tuple.workspacePath,
    level: tuple.level,
    acknowledgedApprovalMode: tuple.acknowledgedApprovalMode,
    authorityDigest: tuple.authorityDigest
  })
}

/** Sign an unattended-elevation tuple. */
export function signUnattendedElevation(secret: Buffer | string, tuple: UnattendedElevationTuple): string {
  return createHmac('sha256', secret).update(canonicalUnattendedElevation(tuple)).digest('hex')
}

/** Constant-time verification. Rejects a non-hex / empty / wrong-length signature. */
export function verifyUnattendedElevation(
  secret: Buffer | string,
  tuple: UnattendedElevationTuple,
  signature: string | null | undefined
): boolean {
  if (typeof signature !== 'string' || !/^[0-9a-f]+$/i.test(signature)) return false
  try {
    const expected = Buffer.from(signUnattendedElevation(secret, tuple), 'hex')
    const actual = Buffer.from(signature, 'hex')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}
