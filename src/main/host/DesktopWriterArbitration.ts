import {
  clearHostProfileWriterFence,
  inspectProfileWriterPeers,
  ProfileWriterLivePeerError,
  type HostProfileWriterFenceOwnership,
  type InspectProfileWriterPeersOptions
} from '../../host-runtime/HostProfileWriterFence'
import type { LegacyStoreWriterGateSnapshot } from '../store/LegacyStoreWriterGate'

export { ProfileWriterLivePeerError }

export type DesktopWriterArbitrationDecision = 'open' | 'already-host-owned'

export interface DesktopWriterArbitrationGate {
  snapshot(): LegacyStoreWriterGateSnapshot
  hydrateFromDurable?(input: {
    state: 'draining' | 'host-owned' | 'closed'
    ownership?: HostProfileWriterFenceOwnership
  }): boolean
  reclaimStaleOwnership?(): boolean
}

export interface ArbitrateDesktopProfileWritersInput {
  readonly profilePath: string
  readonly gate: DesktopWriterArbitrationGate
  readonly intent: 'external-prepare' | 'in-process'
  readonly inspect?: InspectProfileWriterPeersOptions
}

function hydrateOwned(
  gate: DesktopWriterArbitrationGate,
  ownership?: HostProfileWriterFenceOwnership
): void {
  gate.hydrateFromDurable?.({
    state: 'host-owned',
    ...(ownership ? { ownership } : {})
  })
}

function reclaimStale(profilePath: string, gate: DesktopWriterArbitrationGate): void {
  gate.reclaimStaleOwnership?.()
  clearHostProfileWriterFence(profilePath)
}

/**
 * Read durable ownership before Desktop opens AppStore or in-process Host writers.
 * Live peers fail closed; stale records are reclaimed.
 */
export function arbitrateDesktopProfileWriters(
  input: ArbitrateDesktopProfileWritersInput
): DesktopWriterArbitrationDecision {
  if (!input || typeof input.profilePath !== 'string') {
    throw new Error('Writer arbitration requires a profile path.')
  }
  const peer = inspectProfileWriterPeers(input.profilePath, input.inspect)
  if (peer.status === 'unknown') {
    throw new ProfileWriterLivePeerError(`Refusing Desktop writers; ${peer.reason}.`, peer.reason)
  }
  if (peer.status === 'live-host') {
    if (input.intent === 'in-process') {
      throw new ProfileWriterLivePeerError(
        `A live Host pid ${peer.pid} already owns this profile.`,
        'live-host'
      )
    }
    hydrateOwned(input.gate, peer.ownership)
    return 'already-host-owned'
  }
  if (peer.status === 'live-in-process') {
    if (input.intent === 'in-process') {
      throw new ProfileWriterLivePeerError(
        `Another in-process Desktop Host pid ${peer.pid} already owns this profile.`,
        'live-in-process'
      )
    }
    throw new ProfileWriterLivePeerError(
      `In-process Desktop Host pid ${peer.pid} already owns this profile.`,
      'live-in-process'
    )
  }
  if (peer.status === 'self-in-process') {
    hydrateOwned(input.gate, peer.ownership)
    return 'already-host-owned'
  }
  if (peer.status === 'stale') {
    reclaimStale(input.profilePath, input.gate)
    return 'open'
  }
  return 'open'
}
