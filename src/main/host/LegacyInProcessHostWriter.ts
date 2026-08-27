import {
  HostProfileAuthorityLease,
  HostProfileAuthorityLeaseBusyError
} from '../../host-runtime/HostProfileAuthorityLease'
import {
  IN_PROCESS_DESKTOP_HOST_ID,
  type InspectProfileWriterPeersOptions
} from '../../host-runtime/HostProfileWriterFence'
import { legacyStoreWriterGate } from '../store/LegacyStoreWriterGate'
import {
  arbitrateDesktopProfileWriters,
  ProfileWriterLivePeerError
} from './DesktopWriterArbitration'
import type { HostExternalPreparationWriterGate } from './HostExternalPreparation'
import { persistLegacyStoreWriterGate } from './LegacyStoreWriterGatePersistence'

export const LEGACY_IN_PROCESS_HOST_ID = IN_PROCESS_DESKTOP_HOST_ID
export const LEGACY_IN_PROCESS_CUTOVER_ID = 'legacy-in-process'

export interface DrainLegacyStoreForInProcessHostInput {
  readonly profilePath: string
  readonly writerGate?: HostExternalPreparationWriterGate
  readonly inspect?: InspectProfileWriterPeersOptions
  readonly acquireLease?: (profilePath: string) => HostProfileAuthorityLease
  /** Test-only deterministic interleaving seam, invoked after arbitration and before acquire. */
  readonly onBeforeAcquire?: () => void | Promise<void>
}

/**
 * Single-writer cutover for the in-process Desktop Host path.
 * Reads durable ownership first, then acquires the same atomic authority lease
 * the Node Host uses before opening writers. Refuses to overwrite a live peer.
 */
export async function drainLegacyStoreForInProcessHost(
  input: DrainLegacyStoreForInProcessHostInput
): Promise<HostProfileAuthorityLease | null> {
  if (!input || typeof input.profilePath !== 'string') {
    throw new Error('In-process Host writer drain requires a profile path.')
  }
  const inner = input.writerGate ?? legacyStoreWriterGate
  const gate = persistLegacyStoreWriterGate(input.profilePath, inner)
  const decision = arbitrateDesktopProfileWriters({
    profilePath: input.profilePath,
    gate,
    intent: 'in-process',
    ...(input.inspect ? { inspect: input.inspect } : {})
  })
  if (decision === 'already-host-owned') return null
  if (gate.snapshot().state === 'host-owned') return null

  if (input.onBeforeAcquire) await input.onBeforeAcquire()

  const acquire = input.acquireLease ?? acquireInProcessHostAuthorityLease
  const lease = acquire(input.profilePath)
  try {
    if (!gate.beginDrain()) {
      throw new Error('Legacy writer drain could not begin for in-process Host ownership.')
    }
    await gate.awaitDrained()
    if (
      !gate.markHostOwned({
        hostId: LEGACY_IN_PROCESS_HOST_ID,
        generation: 0,
        cutoverId: LEGACY_IN_PROCESS_CUTOVER_ID,
        pid: process.pid
      })
    ) {
      throw new Error('Legacy writer ownership could not transfer to the in-process Host.')
    }
    lease.assertHeld()
    return lease
  } catch (error) {
    gate.rollbackDrain()
    lease.release()
    throw error
  }
}

export function acquireInProcessHostAuthorityLease(profilePath: string): HostProfileAuthorityLease {
  try {
    return HostProfileAuthorityLease.acquire({ profilePath })
  } catch (error) {
    if (error instanceof HostProfileAuthorityLeaseBusyError) {
      throw new ProfileWriterLivePeerError(
        `A live profile authority owner pid ${error.owner.pid} already owns this profile.`,
        error.liveness === 'live' ? 'live-host' : 'unknown'
      )
    }
    throw error
  }
}
