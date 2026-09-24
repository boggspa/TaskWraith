import {
  clearHostProfileWriterFence,
  HOST_PROFILE_WRITER_FENCE_FILENAME,
  HOST_PROFILE_WRITER_FENCE_PURPOSE,
  readHostProfileWriterFence,
  writeHostProfileWriterFence,
  type HostProfileWriterFenceOwnership
} from '../../host-runtime/HostProfileWriterFence'
import type { HostExternalPreparationWriterGate } from './HostExternalPreparation'

export const DESKTOP_WRITER_FENCE_FILENAME = HOST_PROFILE_WRITER_FENCE_FILENAME
export const DESKTOP_WRITER_FENCE_PURPOSE = HOST_PROFILE_WRITER_FENCE_PURPOSE
export type DesktopWriterFenceOwnership = HostProfileWriterFenceOwnership

export const writeDesktopWriterFence = writeHostProfileWriterFence
export const readDesktopWriterFence = readHostProfileWriterFence
export const clearDesktopWriterFence = clearHostProfileWriterFence

/** Mirror in-memory gate transitions to a durable fence file both writers consult. */
export function persistLegacyStoreWriterGate(
  profilePath: string,
  gate: HostExternalPreparationWriterGate
): HostExternalPreparationWriterGate {
  const sync = (): void => {
    const snapshot = gate.snapshot()
    if (snapshot.state === 'open') {
      clearDesktopWriterFence(profilePath)
      return
    }
    if (
      snapshot.state === 'draining' ||
      snapshot.state === 'host-owned' ||
      snapshot.state === 'closed'
    ) {
      writeDesktopWriterFence(profilePath, {
        state: snapshot.state,
        ...(snapshot.ownership ? { ownership: snapshot.ownership } : {})
      })
    }
  }
  return {
    beginDrain(): boolean {
      const ok = gate.beginDrain()
      if (ok) sync()
      return ok
    },
    awaitDrained(): Promise<void> {
      return gate.awaitDrained()
    },
    markHostOwned(input: {
      hostId: string
      generation: number
      cutoverId: string
      pid?: number
    }): boolean {
      const ok = gate.markHostOwned(input)
      if (ok) sync()
      return ok
    },
    rollbackDrain(): boolean {
      const ok = gate.rollbackDrain()
      if (ok) sync()
      return ok
    },
    hydrateFromDurable(input: {
      state: 'draining' | 'host-owned' | 'closed'
      ownership?: HostProfileWriterFenceOwnership
    }): boolean {
      return gate.hydrateFromDurable?.(input) === true
    },
    reclaimStaleOwnership(): boolean {
      const ok = gate.reclaimStaleOwnership?.() === true
      if (ok) sync()
      return ok
    },
    snapshot() {
      return gate.snapshot()
    }
  }
}
