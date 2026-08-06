/**
 * Host Arc Wave 4.3a — React binding for the Desktop Host projection.
 *
 * DELIBERATELY TRIVIAL. Every decision worth testing lives in
 * `HostProjectionStore` and `hostSnapshotProjection`, which are pure and
 * covered. This hook only subscribes and re-renders.
 *
 * That split is not a preference: this repo has no jsdom environment for
 * renderer tests, so anything expressed as hook behaviour would be untestable.
 * Keeping the hook logic-free is what keeps the slice provable — the same
 * pure-logic / thin-view split the sidebar work established.
 *
 * READ-ONLY. There is no command surface here. Desktop command cutover is
 * Wave 4.3b and is hard-gated on exact approvalId correlation (Wave 4.2c).
 */

import { useEffect, useState } from 'react'

import type { HostProjectionState, HostProjectionStore } from '../lib/host/HostProjectionStore'

/**
 * Subscribe to a Host projection store.
 *
 * @param store   The store to observe. Pass `null` before one exists (for
 *                example while the transport is unavailable) — the hook then
 *                reports `idle` rather than inventing a projection.
 * @param refreshOnMount Fetch once on mount. Default true: a renderer reload
 *                destroys the store but not the Host mission behind it, so the
 *                correct recovery is simply to ask Host again.
 */
export function useHostProjection(
  store: HostProjectionStore | null,
  refreshOnMount = true
): HostProjectionState {
  const [state, setState] = useState<HostProjectionState>(
    () => store?.getState() ?? { status: 'idle' }
  )

  useEffect(() => {
    if (!store) {
      setState({ status: 'idle' })
      return
    }

    // Adopt current state immediately: the store may already hold a
    // projection fetched before this component mounted.
    setState(store.getState())
    const unsubscribe = store.subscribe(setState)

    if (refreshOnMount) {
      // The store records the failure in its own state; a rejection here would
      // be an unhandled promise, so it is swallowed deliberately rather than
      // by omission.
      void store.refresh().catch(() => undefined)
    }

    return unsubscribe
  }, [store, refreshOnMount])

  return state
}
