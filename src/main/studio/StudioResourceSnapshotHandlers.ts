import type { StudioResourceSnapshotOutcome } from '../../shared/studioResourceSnapshot'

export const STUDIO_RESOURCE_SNAPSHOT_CHANNEL = 'studio:resource-snapshot'

export interface StudioResourceSnapshotHandlerDeps {
  getLifecycle: () => { getResourceSnapshot(): Promise<StudioResourceSnapshotOutcome> } | null
}

/** Pathless and processless: the lifecycle alone selects its already-running child. */
export function registerStudioResourceSnapshotHandlers(
  ipc: { handle(channel: string, listener: (...args: unknown[]) => unknown): void },
  deps: StudioResourceSnapshotHandlerDeps
): void {
  ipc.handle(STUDIO_RESOURCE_SNAPSHOT_CHANNEL, async (): Promise<StudioResourceSnapshotOutcome> => {
    const lifecycle = deps.getLifecycle()
    if (!lifecycle)
      return { ok: false, code: 'studio_unavailable', message: 'Studio is not running.' }
    try {
      return await lifecycle.getResourceSnapshot()
    } catch {
      return {
        ok: false,
        code: 'resource_snapshot_unavailable',
        message: 'Studio resource snapshot failed.'
      }
    }
  })
}
