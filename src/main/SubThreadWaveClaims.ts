/*
 * SubThreadWaveClaims — per-wave claim arbitration for fleet coordination.
 *
 * A wave has no record of its own: `list_subthreads` derives one by grouping
 * children on `delegationContext.joinPolicy.groupId`. Claims therefore live in
 * their own map keyed by waveId on the PARENT chat, deliberately NOT inside
 * `delegationContext` — that field sits in `WORKSPACE_IDENTITY_FIELDS`
 * (src/preload/SerializedChatPersistence.ts), a merge group the persistence
 * layer refuses to synthesize when both sides changed. Mutable claim writes in
 * there would be lost exactly when two seats race, which is the one case a
 * claim exists to arbitrate.
 *
 * ADVISORY BY DESIGN. A claim records which panel seat is acting on a wave's
 * results so peers do not double-adopt them. Nothing reads a claim to deny an
 * operation: a stale or mistaken claim must never wedge a seat out of work it
 * needs to do. Enforcement, if it is ever wanted, belongs at the call sites —
 * not here.
 *
 * Pure: no AppStore, no IPC, no clock of its own (callers pass `nowMs`).
 */

/** Default claim lease. Renewed by re-claiming; expiry is the only decay. */
export const DEFAULT_FLEET_WAVE_CLAIM_TTL_MS = 30 * 60 * 1000
export const MIN_FLEET_WAVE_CLAIM_TTL_MS = 60 * 1000
export const MAX_FLEET_WAVE_CLAIM_TTL_MS = 24 * 60 * 60 * 1000
/**
 * Structural cap on retained claims per parent chat. Expired entries are
 * pruned on every write, so this only bounds a chat that keeps many waves
 * claimed at once; the oldest live claim is evicted first.
 */
export const MAX_FLEET_WAVE_CLAIMS = 100

export interface FleetWaveClaim {
  waveId: string
  /** Ensemble participant id of the holder. */
  participantId: string
  claimedAt: number
  expiresAt: number
  /**
   * True when the host wrote this claim at spawn time rather than a seat
   * asking for it. Surfaced so a peer can tell "nobody has actively picked
   * this up" from "a seat deliberately took it".
   */
  auto?: boolean
  /** Participant the claim was taken from, when this was a takeover. */
  takenFrom?: string
}

export type FleetWaveClaimMap = Record<string, FleetWaveClaim>

export type FleetWaveClaimResult =
  | { ok: true; claims: FleetWaveClaimMap; claim: FleetWaveClaim }
  | { ok: false; code: 'claim_held'; holder: FleetWaveClaim }
  | { ok: false; code: 'not_held' }
  | { ok: false; code: 'not_holder'; holder: FleetWaveClaim }

export function clampFleetWaveClaimTtlMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_FLEET_WAVE_CLAIM_TTL_MS
  }
  return Math.max(
    MIN_FLEET_WAVE_CLAIM_TTL_MS,
    Math.min(MAX_FLEET_WAVE_CLAIM_TTL_MS, Math.floor(value))
  )
}

function isLive(claim: FleetWaveClaim | undefined, nowMs: number): claim is FleetWaveClaim {
  return Boolean(claim) && (claim as FleetWaveClaim).expiresAt > nowMs
}

/** Drop expired claims. Returns the SAME object when nothing changed. */
export function pruneExpiredFleetWaveClaims(
  claims: FleetWaveClaimMap | undefined,
  nowMs: number
): FleetWaveClaimMap {
  const source = claims || {}
  const live = Object.entries(source).filter(([, claim]) => isLive(claim, nowMs))
  if (live.length === Object.keys(source).length) return source
  return Object.fromEntries(live)
}

/** The live claim on a wave, or undefined when unclaimed / expired. */
export function resolveFleetWaveClaim(
  claims: FleetWaveClaimMap | undefined,
  waveId: string,
  nowMs: number
): FleetWaveClaim | undefined {
  const claim = (claims || {})[waveId.trim()]
  return isLive(claim, nowMs) ? claim : undefined
}

/**
 * Evict down to MAX_FLEET_WAVE_CLAIMS, oldest `claimedAt` first. `keepWaveId`
 * is never evicted — a write must not drop the entry it just made.
 */
function boundClaims(claims: FleetWaveClaimMap, keepWaveId: string): FleetWaveClaimMap {
  const keys = Object.keys(claims)
  if (keys.length <= MAX_FLEET_WAVE_CLAIMS) return claims
  const evictable = keys
    .filter((key) => key !== keepWaveId)
    .sort((a, b) => claims[a].claimedAt - claims[b].claimedAt)
  const removeCount = keys.length - MAX_FLEET_WAVE_CLAIMS
  const removed = new Set(evictable.slice(0, removeCount))
  return Object.fromEntries(Object.entries(claims).filter(([key]) => !removed.has(key)))
}

export interface ClaimFleetWaveInput {
  claims: FleetWaveClaimMap | undefined
  waveId: string
  participantId: string
  nowMs: number
  ttlMs?: number
  /** Host auto-claim at spawn time rather than a seat asking. */
  auto?: boolean
  /**
   * Take a wave that another seat currently holds. Deliberate handoff is
   * always allowed and recorded via `takenFrom`; the compare-and-set exists to
   * catch ACCIDENTAL double-adoption, not to lock a peer out.
   */
  takeover?: boolean
}

/**
 * Compare-and-set a wave claim.
 *
 * - unclaimed / expired      → granted
 * - held by the same seat    → renewed (lease re-stamped)
 * - held by another seat     → refused, unless `takeover`
 */
export function claimFleetWave(input: ClaimFleetWaveInput): FleetWaveClaimResult {
  const waveId = input.waveId.trim()
  const participantId = input.participantId.trim()
  const pruned = pruneExpiredFleetWaveClaims(input.claims, input.nowMs)
  const existing = resolveFleetWaveClaim(pruned, waveId, input.nowMs)

  if (existing && existing.participantId !== participantId && !input.takeover) {
    return { ok: false, code: 'claim_held', holder: existing }
  }

  const ttlMs = clampFleetWaveClaimTtlMs(input.ttlMs)
  const isTakeover = Boolean(existing && existing.participantId !== participantId)
  const claim: FleetWaveClaim = {
    waveId,
    participantId,
    // A renewal keeps the original acquisition time; only the lease moves.
    claimedAt: existing && !isTakeover ? existing.claimedAt : input.nowMs,
    expiresAt: input.nowMs + ttlMs,
    ...(input.auto ? { auto: true } : {}),
    ...(isTakeover && existing ? { takenFrom: existing.participantId } : {})
  }
  const next = boundClaims({ ...pruned, [waveId]: claim }, waveId)
  return { ok: true, claims: next, claim }
}

export interface ReleaseFleetWaveInput {
  claims: FleetWaveClaimMap | undefined
  waveId: string
  participantId: string
  nowMs: number
}

/**
 * Release a claim. Only the holder may release: a peer that wants the wave
 * takes it over (which is recorded) rather than silently clearing someone
 * else's claim to look unclaimed.
 */
export function releaseFleetWave(input: ReleaseFleetWaveInput): FleetWaveClaimResult {
  const waveId = input.waveId.trim()
  const pruned = pruneExpiredFleetWaveClaims(input.claims, input.nowMs)
  const existing = resolveFleetWaveClaim(pruned, waveId, input.nowMs)
  if (!existing) return { ok: false, code: 'not_held' }
  if (existing.participantId !== input.participantId.trim()) {
    return { ok: false, code: 'not_holder', holder: existing }
  }
  const next = { ...pruned }
  delete next[waveId]
  return { ok: true, claims: next, claim: existing }
}

/** Compact per-wave claim view for `list_subthreads`. */
export function summarizeFleetWaveClaim(
  claims: FleetWaveClaimMap | undefined,
  waveId: string,
  nowMs: number
):
  | {
      participantId: string
      claimedAt: number
      expiresAt: number
      expiresInMs: number
      auto: boolean
      takenFrom?: string
    }
  | undefined {
  const claim = resolveFleetWaveClaim(claims, waveId, nowMs)
  if (!claim) return undefined
  return {
    participantId: claim.participantId,
    claimedAt: claim.claimedAt,
    expiresAt: claim.expiresAt,
    expiresInMs: Math.max(0, claim.expiresAt - nowMs),
    auto: claim.auto === true,
    ...(claim.takenFrom ? { takenFrom: claim.takenFrom } : {})
  }
}
