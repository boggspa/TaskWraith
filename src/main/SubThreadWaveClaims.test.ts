import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FLEET_WAVE_CLAIM_TTL_MS,
  MAX_FLEET_WAVE_CLAIMS,
  MAX_FLEET_WAVE_CLAIM_TTL_MS,
  MIN_FLEET_WAVE_CLAIM_TTL_MS,
  clampFleetWaveClaimTtlMs,
  claimFleetWave,
  pruneExpiredFleetWaveClaims,
  releaseFleetWave,
  resolveFleetWaveClaim,
  summarizeFleetWaveClaim,
  type FleetWaveClaimMap
} from './SubThreadWaveClaims'

const nowMs = Date.parse('2026-08-20T01:00:00.000Z')

function grant(
  waveId: string,
  participantId: string,
  options: { claims?: FleetWaveClaimMap; at?: number; ttlMs?: number; auto?: boolean } = {}
): FleetWaveClaimMap {
  const result = claimFleetWave({
    claims: options.claims,
    waveId,
    participantId,
    nowMs: options.at ?? nowMs,
    ttlMs: options.ttlMs,
    auto: options.auto
  })
  if (!result.ok) throw new Error(`expected grant, got ${result.code}`)
  return result.claims
}

describe('claimFleetWave', () => {
  it('grants an unclaimed wave and stamps the default lease', () => {
    const result = claimFleetWave({ claims: {}, waveId: 'wave-1', participantId: 'seat-a', nowMs })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claim.participantId).toBe('seat-a')
    expect(result.claim.claimedAt).toBe(nowMs)
    expect(result.claim.expiresAt).toBe(nowMs + DEFAULT_FLEET_WAVE_CLAIM_TTL_MS)
    expect(result.claim.takenFrom).toBeUndefined()
  })

  it('refuses a wave another seat holds, and names the holder', () => {
    const claims = grant('wave-1', 'seat-a')
    const result = claimFleetWave({ claims, waveId: 'wave-1', participantId: 'seat-b', nowMs })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('claim_held')
    if (result.code !== 'claim_held') return
    expect(result.holder.participantId).toBe('seat-a')
  })

  it('renews for the same seat without resetting claimedAt', () => {
    const claims = grant('wave-1', 'seat-a')
    const later = nowMs + 60_000
    const result = claimFleetWave({
      claims,
      waveId: 'wave-1',
      participantId: 'seat-a',
      nowMs: later
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claim.claimedAt).toBe(nowMs)
    expect(result.claim.expiresAt).toBe(later + DEFAULT_FLEET_WAVE_CLAIM_TTL_MS)
  })

  it('grants a lapsed claim to a new seat without takeover', () => {
    const claims = grant('wave-1', 'seat-a')
    const afterExpiry = nowMs + DEFAULT_FLEET_WAVE_CLAIM_TTL_MS + 1
    const result = claimFleetWave({
      claims,
      waveId: 'wave-1',
      participantId: 'seat-b',
      nowMs: afterExpiry
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claim.participantId).toBe('seat-b')
    // A lapsed claim is not a handoff — nothing was taken from anyone.
    expect(result.claim.takenFrom).toBeUndefined()
  })

  it('allows a deliberate takeover and records who it came from', () => {
    const claims = grant('wave-1', 'seat-a')
    const result = claimFleetWave({
      claims,
      waveId: 'wave-1',
      participantId: 'seat-b',
      nowMs,
      takeover: true
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claim.participantId).toBe('seat-b')
    expect(result.claim.takenFrom).toBe('seat-a')
    expect(result.claim.claimedAt).toBe(nowMs)
  })

  it('marks a host auto-claim so peers can tell it from a deliberate pick-up', () => {
    const claims = grant('wave-1', 'seat-a', { auto: true })
    expect(claims['wave-1'].auto).toBe(true)
    const manual = grant('wave-2', 'seat-a')
    expect(manual['wave-2'].auto).toBeUndefined()
  })

  it('evicts the oldest live claim past the cap but never the new one', () => {
    let claims: FleetWaveClaimMap = {}
    for (let index = 0; index < MAX_FLEET_WAVE_CLAIMS; index += 1) {
      claims = grant(`wave-${index}`, 'seat-a', { claims, at: nowMs + index })
    }
    expect(Object.keys(claims)).toHaveLength(MAX_FLEET_WAVE_CLAIMS)
    claims = grant('wave-new', 'seat-a', { claims, at: nowMs + MAX_FLEET_WAVE_CLAIMS })
    expect(Object.keys(claims)).toHaveLength(MAX_FLEET_WAVE_CLAIMS)
    expect(claims['wave-new']).toBeDefined()
    expect(claims['wave-0']).toBeUndefined()
    expect(claims['wave-1']).toBeDefined()
  })
})

describe('releaseFleetWave', () => {
  it('clears the holder’s own claim', () => {
    const claims = grant('wave-1', 'seat-a')
    const result = releaseFleetWave({ claims, waveId: 'wave-1', participantId: 'seat-a', nowMs })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claims['wave-1']).toBeUndefined()
  })

  it('refuses to let a peer clear someone else’s claim', () => {
    const claims = grant('wave-1', 'seat-a')
    const result = releaseFleetWave({ claims, waveId: 'wave-1', participantId: 'seat-b', nowMs })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('not_holder')
    if (result.code !== 'not_holder') return
    expect(result.holder.participantId).toBe('seat-a')
  })

  it('reports not_held for an unclaimed wave', () => {
    const result = releaseFleetWave({
      claims: {},
      waveId: 'wave-1',
      participantId: 'seat-a',
      nowMs
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('not_held')
  })
})

describe('expiry helpers', () => {
  it('resolves a live claim and hides a lapsed one', () => {
    const claims = grant('wave-1', 'seat-a')
    expect(resolveFleetWaveClaim(claims, 'wave-1', nowMs)?.participantId).toBe('seat-a')
    expect(
      resolveFleetWaveClaim(claims, 'wave-1', nowMs + DEFAULT_FLEET_WAVE_CLAIM_TTL_MS + 1)
    ).toBeUndefined()
  })

  it('prunes expired entries and keeps the same reference when nothing changed', () => {
    const claims = grant('wave-1', 'seat-a')
    expect(pruneExpiredFleetWaveClaims(claims, nowMs)).toBe(claims)
    const pruned = pruneExpiredFleetWaveClaims(claims, nowMs + DEFAULT_FLEET_WAVE_CLAIM_TTL_MS + 1)
    expect(pruned).not.toBe(claims)
    expect(Object.keys(pruned)).toHaveLength(0)
  })

  it('clamps the lease into range', () => {
    expect(clampFleetWaveClaimTtlMs(undefined)).toBe(DEFAULT_FLEET_WAVE_CLAIM_TTL_MS)
    expect(clampFleetWaveClaimTtlMs('nope')).toBe(DEFAULT_FLEET_WAVE_CLAIM_TTL_MS)
    expect(clampFleetWaveClaimTtlMs(1)).toBe(MIN_FLEET_WAVE_CLAIM_TTL_MS)
    expect(clampFleetWaveClaimTtlMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_FLEET_WAVE_CLAIM_TTL_MS)
  })
})

describe('summarizeFleetWaveClaim', () => {
  it('reports the remaining lease a seat would read', () => {
    const claims = grant('wave-1', 'seat-a', { auto: true })
    const summary = summarizeFleetWaveClaim(claims, 'wave-1', nowMs + 60_000)
    expect(summary).toEqual({
      participantId: 'seat-a',
      claimedAt: nowMs,
      expiresAt: nowMs + DEFAULT_FLEET_WAVE_CLAIM_TTL_MS,
      expiresInMs: DEFAULT_FLEET_WAVE_CLAIM_TTL_MS - 60_000,
      auto: true
    })
  })

  it('reports nothing once the lease lapses', () => {
    const claims = grant('wave-1', 'seat-a')
    expect(
      summarizeFleetWaveClaim(claims, 'wave-1', nowMs + DEFAULT_FLEET_WAVE_CLAIM_TTL_MS + 1)
    ).toBeUndefined()
  })
})
