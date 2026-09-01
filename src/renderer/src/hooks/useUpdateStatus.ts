import { useCallback, useEffect, useState } from 'react'
import type { UpdateStateSnapshot } from '../../../main/UpdateService'
import { shouldApplyUpdateSnapshot } from '../lib/updateStatusRefresh'

export function useUpdateStatus(): {
  snapshot: UpdateStateSnapshot | null
  busy: boolean
  refresh: () => Promise<UpdateStateSnapshot | null>
  checkForUpdates: () => Promise<UpdateStateSnapshot | null>
  downloadUpdate: () => Promise<UpdateStateSnapshot | null>
  downloadUpdateAndRestart: () => Promise<UpdateStateSnapshot | null>
  installUpdateNow: () => Promise<UpdateStateSnapshot | null>
} {
  const [snapshot, setSnapshot] = useState<UpdateStateSnapshot | null>(null)
  const [busy, setBusy] = useState(false)

  const commitSnapshot = useCallback((next: UpdateStateSnapshot | null, force = false) => {
    setSnapshot((prev) => (shouldApplyUpdateSnapshot(prev, next, { force }) ? next : prev))
  }, [])

  const refresh = useCallback(async (): Promise<UpdateStateSnapshot | null> => {
    try {
      const next = await window.api.updateSnapshot()
      commitSnapshot(next, true)
      return next
    } catch {
      return null
    }
  }, [commitSnapshot])

  useEffect(() => {
    void refresh()
    if (typeof window.api.onUpdateStatusChanged !== 'function') return
    return window.api.onUpdateStatusChanged((next) => commitSnapshot(next))
  }, [commitSnapshot, refresh])

  const runUpdateAction = useCallback(
    async (action: () => Promise<UpdateStateSnapshot>): Promise<UpdateStateSnapshot | null> => {
      setBusy(true)
      try {
        const next = await action()
        commitSnapshot(next, true)
        return next
      } finally {
        setBusy(false)
      }
    },
    [commitSnapshot]
  )

  const checkForUpdates = useCallback(
    () => runUpdateAction(() => window.api.checkForUpdates()),
    [runUpdateAction]
  )
  const downloadUpdate = useCallback(
    () => runUpdateAction(() => window.api.downloadUpdate()),
    [runUpdateAction]
  )
  const downloadUpdateAndRestart = useCallback(
    () => runUpdateAction(() => window.api.downloadUpdateAndRestart()),
    [runUpdateAction]
  )
  const installUpdateNow = useCallback(
    () => runUpdateAction(() => window.api.installUpdateNow()),
    [runUpdateAction]
  )

  return {
    snapshot,
    busy,
    refresh,
    checkForUpdates,
    downloadUpdate,
    downloadUpdateAndRestart,
    installUpdateNow
  }
}
