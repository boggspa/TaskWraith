import type { AgyModel } from './AntigravityCli'
import { ANTIGRAVITY_AGY_STATIC_MODEL_IDS as STATIC_AGY_MODEL_IDS } from '../../shared/antigravityStaticModelIds'

/**
 * Catalogue namespace for the official-ACP AntiGravity lane (Google's own
 * published `agy_acp_server`, registry id `antigravity-acp`).
 *
 * WHY THIS EXISTS: the transport switch (`antigravityUseAcp`) selects which
 * binary runs a turn, but dispatch quarantines lanes by MODEL NAMESPACE
 * (`isAntigravityAcpModelCandidate` in AntigravityCombinedModeDispatch).
 * Without a namespaced id nothing a user can pick ever matches that
 * predicate, so the whole official-ACP lane is unreachable and flipping the
 * switch changes nothing. This module owns the one id shape that makes the
 * two halves meet.
 *
 * The separator is load-bearing. `isAntigravityAcpModelCandidate` reserves
 * the token `antigravity-acp` only when the next character is NOT `[a-z0-9-]`,
 * so `antigravity-acp:<model>` is a candidate while `antigravity-acpx` stays
 * on the legacy agy lane. Do not switch this to `-` or an alphanumeric joiner.
 */
export const ANTIGRAVITY_ACP_MODEL_NAMESPACE = 'antigravity-acp'

/** The exact emitted prefix. Kept derived so the namespace has one source. */
export const ANTIGRAVITY_ACP_MODEL_ID_PREFIX = `${ANTIGRAVITY_ACP_MODEL_NAMESPACE}:` as const

/**
 * Is this catalogue row an official-ACP row?
 *
 * Normalizes exactly like the dispatch predicate (trim + case-fold) so the
 * catalogue's classification and the lane's routing can never disagree about
 * the same string. Callers use this to keep legacy-agy-only behaviour away
 * from ACP rows, so over-matching fails CLOSED and is the safe direction.
 */
export function isAntigravityAcpCatalogModelId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return value.trim().toLowerCase().startsWith(ANTIGRAVITY_ACP_MODEL_ID_PREFIX)
}

/**
 * Project a bare AntiGravity model id onto the official-ACP namespace.
 *
 * IDEMPOTENT by contract: an already-namespaced id is returned unchanged, so
 * a row that passes through both the static-floor projection and the row
 * assembly loop can never become `antigravity-acp:antigravity-acp:...`.
 */
export function toAntigravityAcpModelId(modelId: string): string {
  if (isAntigravityAcpCatalogModelId(modelId)) return modelId
  return `${ANTIGRAVITY_ACP_MODEL_ID_PREFIX}${modelId}`
}

/**
 * The consented static floor for the official-ACP lane, mirroring
 * `antigravityAgyStaticModels()` and used for the same reason: a timed-out or
 * failed discovery must not delete the provider from every surface.
 *
 * HONESTY NOTE — these are ASSUMED, not advertised. The ACP registry entry
 * for `antigravity-acp` 1.0.0 does not enumerate models, and the ACP
 * handshake this app performs does not ask for a model list either. Reusing
 * the agy catalogue's ids is a pragmatic v1 assumption that the same Google
 * account reaches the same models over either transport. It is NOT a claim
 * that the ACP server advertised them. If a floor id turns out to be
 * unsupported it fails at dispatch with the server's own error, which is the
 * same trade the agy floor already accepts (a loud failure beats a provider
 * that silently vanishes).
 *
 * Labels equal the bare model id, exactly like the agy floor, so the shared
 * picker grouping derives the same family label and effort ladder.
 */
export function antigravityAcpStaticModels(): AgyModel[] {
  return STATIC_AGY_MODEL_IDS.map((id) => ({ id: toAntigravityAcpModelId(id), label: id }))
}
