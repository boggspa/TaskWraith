import { useCallback, useEffect, useState } from 'react'
import type { UpdateStateSnapshot } from '../../../main/UpdateService'

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

  const refresh = useCallback(async (): Promise<UpdateStateSnapshot | null> => {
    try {
      const next = await window.api.updateSnapshot()
      setSnapshot(next)
      return next
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
    if (typeof window.api.onUpdateStatusChanged !== 'function') return
    return window.api.onUpdateStatusChanged((next) => setSnapshot(next))
  }, [refresh])

  const runUpdateAction = useCallback(
    async (
      action: () => Promise<UpdateStateSnapshot>
    ): Promise<UpdateStateSnapshot | null> => {
      setBusy(true)
      try {
        const next = await action()
        setSnapshot(next)
        return next
      } finally {
        setBusy(false)
      }
    },
    []
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
