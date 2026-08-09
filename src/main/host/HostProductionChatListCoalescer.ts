/**
 * Coalesce the production Host's repeated chat-list family reads within one
 * JavaScript turn.
 *
 * A Host snapshot derives threads/workspaces, missions, rounds and participant
 * families from the same AppStore chat-list view. Reading that view once per
 * family multiplies the expensive donor work and can also mix revisions inside
 * one snapshot. This Electron-free adapter gives every synchronous family read
 * the same array, then releases it at the next microtask boundary. Before/after
 * mutation captures therefore remain distinct because command execution crosses
 * an await boundary.
 */

export interface HostProductionChatListReadPort<Entry> {
  getChatList(workspaceId?: string): Entry[]
}

export interface HostProductionChatListCoalescerOptions {
  /** Test seam; production uses the platform microtask queue. */
  scheduleRelease?: (release: () => void) => void
}

export function createHostProductionChatListCoalescer<Entry>(
  source: HostProductionChatListReadPort<Entry>,
  options: HostProductionChatListCoalescerOptions = {}
): HostProductionChatListReadPort<Entry> {
  if (!source || typeof source.getChatList !== 'function') {
    throw new Error('HostProductionChatListCoalescer requires source.getChatList')
  }
  if (options.scheduleRelease !== undefined && typeof options.scheduleRelease !== 'function') {
    throw new Error('HostProductionChatListCoalescer scheduleRelease must be a function')
  }

  const scheduleRelease = options.scheduleRelease ?? queueMicrotask
  const cache = new Map<string | undefined, Entry[]>()
  let releaseScheduled = false

  const release = (): void => {
    cache.clear()
    releaseScheduled = false
  }

  return {
    getChatList(workspaceId?: string): Entry[] {
      const cached = cache.get(workspaceId)
      if (cached) return cached

      const entries = source.getChatList(workspaceId)
      cache.set(workspaceId, entries)
      if (!releaseScheduled) {
        releaseScheduled = true
        try {
          scheduleRelease(release)
        } catch (error) {
          release()
          throw error
        }
      }
      return entries
    }
  }
}
