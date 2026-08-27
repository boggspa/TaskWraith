import { legacyStoreWriterGate } from '../store/LegacyStoreWriterGate'
import type { HostExternalPreparationWriterGate } from './HostExternalPreparation'
import { persistLegacyStoreWriterGate } from './LegacyStoreWriterGatePersistence'

export const LEGACY_IN_PROCESS_HOST_ID = 'electron-in-process-host'
export const LEGACY_IN_PROCESS_CUTOVER_ID = 'legacy-in-process'

export interface DrainLegacyStoreForInProcessHostInput {
  readonly profilePath: string
  readonly writerGate?: HostExternalPreparationWriterGate
}

/**
 * Single-writer cutover for the in-process Desktop Host path.
 * Drains AppStore chat/workspace writers and marks the in-process Host as owner.
 */
export async function drainLegacyStoreForInProcessHost(
  input: DrainLegacyStoreForInProcessHostInput
): Promise<void> {
  if (!input || typeof input.profilePath !== 'string') {
    throw new Error('In-process Host writer drain requires a profile path.')
  }
  const inner = input.writerGate ?? legacyStoreWriterGate
  const gate = persistLegacyStoreWriterGate(input.profilePath, inner)
  if (gate.snapshot().state === 'host-owned') return
  if (!gate.beginDrain()) {
    throw new Error('Legacy writer drain could not begin for in-process Host ownership.')
  }
  await gate.awaitDrained()
  if (
    !gate.markHostOwned({
      hostId: LEGACY_IN_PROCESS_HOST_ID,
      generation: 0,
      cutoverId: LEGACY_IN_PROCESS_CUTOVER_ID
    })
  ) {
    throw new Error('Legacy writer ownership could not transfer to the in-process Host.')
  }
}
