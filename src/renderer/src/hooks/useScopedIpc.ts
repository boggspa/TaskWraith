import { useEffect } from 'react'

/**
 * IpcUnsubscribe — returned by every scoped preload listener.
 * Falsy entries (false / null / undefined) are tolerated for existence-guarded regs.
 */
export type IpcUnsubscribe = () => void

/**
 * collectIpcSubscriptions — pure helper that filters falsy entries and
 * produces a deterministic unsubscribe-all function that runs cleanups in
 * reverse registration order.
 *
 * This is intentionally NOT a React hook — it is unit-testable in a node env
 * with no jsdom / no Electron imports.
 *
 * @param entries — array of unsubscribes or falsy values
 * @returns { count, unsubscribeAll }
 */
export function collectIpcSubscriptions(
  entries: Array<IpcUnsubscribe | false | null | undefined>
): {
  count: number
  unsubscribeAll: () => void
} {
  const unsubs: IpcUnsubscribe[] = []
  for (const entry of entries) {
    if (typeof entry === 'function') {
      unsubs.push(entry)
    } else if (entry !== false && entry != null) {
      // eslint-disable-next-line no-console
      console.error(
        '[collectIpcSubscriptions] non-function entry encountered — expected IpcUnsubscribe or falsy, got:',
        entry
      )
    }
  }
  return {
    count: unsubs.length,
    unsubscribeAll: () => {
      // Reverse order: last-registered listener is cleaned up first.
      // This matches the typical mount/unmount symmetry expectation.
      for (let i = unsubs.length - 1; i >= 0; i--) {
        try {
          unsubs[i]()
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[collectIpcSubscriptions] unsubscribe threw:', err)
        }
      }
    },
  }
}

/**
 * useScopedIpc — mount-once-by-construction hook for renderer IPC subscriptions.
 *
 * - NO deps param.  Re-registration is a design smell; escalate to Design/Boss
 *   rather than adding a dependency array.
 * - The `register` callback allocates fresh wrappers each run (StrictMode-safe).
 * - Falsy entries are silently dropped (supports existence-guarded listeners).
 * - Cleanup runs unsubs in reverse order on unmount.
 *
 * @param register — called once inside useEffect; must return an array of
 *   unsubscribes / falsy values for every window.api.on* registration.
 */
export function useScopedIpc(
  register: () => Array<IpcUnsubscribe | false | null | undefined>
): void {
  useEffect(() => {
    const { unsubscribeAll } = collectIpcSubscriptions(register())
    return unsubscribeAll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
