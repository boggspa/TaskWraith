import { IN_PROCESS_DESKTOP_HOST_ID } from '../../host-runtime/HostProfileWriterFence'
import type { InspectProfileWriterPeersOptions } from '../../host-runtime/HostProfileWriterFence'
import { legacyStoreWriterGate } from '../store/LegacyStoreWriterGate'
import { arbitrateDesktopProfileWriters } from './DesktopWriterArbitration'
import type { HostExternalPreparationWriterGate } from './HostExternalPreparation'
import { persistLegacyStoreWriterGate } from './LegacyStoreWriterGatePersistence'

export const LEGACY_IN_PROCESS_HOST_ID = IN_PROCESS_DESKTOP_HOST_ID
export const LEGACY_IN_PROCESS_CUTOVER_ID = 'legacy-in-process'

export interface DrainLegacyStoreForInProcessHostInput {
  readonly profilePath: string
  readonly writerGate?: HostExternalPreparationWriterGate
  readonly inspect?: InspectProfileWriterPeersOptions
}

/**
 * Single-writer cutover for the in-process Desktop Host path.
 * Reads durable ownership first and refuses to overwrite a live peer.
 */
export async function drainLegacyStoreForInProcessHost(
  input: DrainLegacyStoreForInProcessHostInput
): Promise<void> {
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
  if (decision === 'already-host-owned') return
  if (gate.snapshot().state === 'host-owned') return
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
}
