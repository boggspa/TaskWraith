import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgenticServiceId } from '../../../main/store/types'

export type ToolGrantToggleResult = boolean | void | Promise<boolean | void>

export type ToolGrantToggleHandler = (
  service: AgenticServiceId,
  enabled: boolean
) => ToolGrantToggleResult

interface UseOptimisticToolGrantsOptions {
  enabledGrantIds: Set<AgenticServiceId>
  onToggleGrant: ToolGrantToggleHandler
}

/**
 * Keeps a grant row responsive while the durable workspace-grant write travels
 * through Electron main. Calls for the same service are serialized: rapid
 * clicks only dispatch the final desired state after the in-flight write
 * settles, rather than repeating a stale checkbox value.
 */
export function useOptimisticToolGrants({
  enabledGrantIds,
  onToggleGrant
}: UseOptimisticToolGrantsOptions): {
  effectiveEnabledGrantIds: Set<AgenticServiceId>
  isGrantPending: (service: AgenticServiceId) => boolean
  toggleGrant: (service: AgenticServiceId) => void
} {
  const [revision, setRevision] = useState(0)
  const desiredByServiceRef = useRef(new Map<AgenticServiceId, boolean>())
  const inFlightByServiceRef = useRef(new Map<AgenticServiceId, boolean>())
  const enabledGrantIdsRef = useRef(enabledGrantIds)
  const onToggleGrantRef = useRef(onToggleGrant)
  const mountedRef = useRef(true)

  enabledGrantIdsRef.current = enabledGrantIds
  onToggleGrantRef.current = onToggleGrant

  const refresh = useCallback(() => {
    if (mountedRef.current) setRevision((value) => value + 1)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Once the parent has accepted an optimistic value, stop shadowing it. The
  // normal workspace route does this after its IPC round-trip; participant
  // patches normally reconcile on the next React render.
  useEffect(() => {
    let changed = false
    for (const [service, desired] of desiredByServiceRef.current) {
      if (
        !inFlightByServiceRef.current.has(service) &&
        enabledGrantIdsRef.current.has(service) === desired
      ) {
        desiredByServiceRef.current.delete(service)
        changed = true
      }
    }
    if (changed) refresh()
  }, [enabledGrantIds, refresh])

  const dispatchRef = useRef<(service: AgenticServiceId) => void>(() => undefined)
  dispatchRef.current = (service: AgenticServiceId): void => {
    if (inFlightByServiceRef.current.has(service)) return
    const desired = desiredByServiceRef.current.get(service)
    if (desired === undefined) return

    inFlightByServiceRef.current.set(service, desired)
    refresh()

    let result: ToolGrantToggleResult
    try {
      result = onToggleGrantRef.current(service, desired)
    } catch {
      result = false
    }

    void Promise.resolve(result)
      .then((succeeded) => {
        if (inFlightByServiceRef.current.get(service) !== desired) return
        inFlightByServiceRef.current.delete(service)

        const latestDesired = desiredByServiceRef.current.get(service)
        if (succeeded === false) {
          // A failed write means main did not accept this request. If the user
          // changed their mind while it was in flight, preserve that newer
          // desire only when it still differs from the authoritative parent.
          if (
            latestDesired !== undefined &&
            enabledGrantIdsRef.current.has(service) === latestDesired
          ) {
            desiredByServiceRef.current.delete(service)
          } else if (latestDesired === desired) {
            desiredByServiceRef.current.delete(service)
          }
          refresh()
          if (
            latestDesired !== undefined &&
            latestDesired !== desired &&
            enabledGrantIdsRef.current.has(service) !== latestDesired
          ) {
            dispatchRef.current(service)
          }
          return
        }

        // A quick second click is deliberately issued only after the first
        // durable mutation completes, so the main process cannot receive two
        // writes derived from the same stale rendered checkbox value.
        if (latestDesired !== undefined && latestDesired !== desired) {
          refresh()
          dispatchRef.current(service)
          return
        }

        if (
          latestDesired !== undefined &&
          enabledGrantIdsRef.current.has(service) === latestDesired
        ) {
          desiredByServiceRef.current.delete(service)
        }
        refresh()
      })
      .catch(() => {
        if (inFlightByServiceRef.current.get(service) !== desired) return
        inFlightByServiceRef.current.delete(service)
        const latestDesired = desiredByServiceRef.current.get(service)
        if (latestDesired === desired) {
          desiredByServiceRef.current.delete(service)
        } else if (
          latestDesired !== undefined &&
          enabledGrantIdsRef.current.has(service) === latestDesired
        ) {
          desiredByServiceRef.current.delete(service)
        }
        refresh()
        if (
          latestDesired !== undefined &&
          latestDesired !== desired &&
          enabledGrantIdsRef.current.has(service) !== latestDesired
        ) {
          dispatchRef.current(service)
        }
      })
  }

  const toggleGrant = useCallback(
    (service: AgenticServiceId): void => {
      const current =
        desiredByServiceRef.current.get(service) ?? enabledGrantIdsRef.current.has(service)
      desiredByServiceRef.current.set(service, !current)
      refresh()
      dispatchRef.current(service)
    },
    [refresh]
  )

  const effectiveEnabledGrantIds = useMemo(() => {
    const effective = new Set(enabledGrantIds)
    for (const [service, desired] of desiredByServiceRef.current) {
      if (desired) effective.add(service)
      else effective.delete(service)
    }
    return effective
  }, [enabledGrantIds, revision])

  const isGrantPending = useCallback(
    (service: AgenticServiceId): boolean => inFlightByServiceRef.current.has(service),
    [revision]
  )

  return { effectiveEnabledGrantIds, isGrantPending, toggleGrant }
}
