import { useCallback, useEffect, useState } from 'react'
import type { LaunchTargetsSnapshot } from '../../../main/launchTargets/types'

export function useLaunchTargets(workspacePath: string | null | undefined): {
  snapshot: LaunchTargetsSnapshot | null
  targets: LaunchTargetsSnapshot['targets']
  busy: boolean
  refresh: () => Promise<LaunchTargetsSnapshot | null>
} {
  const [snapshot, setSnapshot] = useState<LaunchTargetsSnapshot | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<LaunchTargetsSnapshot | null> => {
    if (!workspacePath || typeof window.api.launchTargetsSnapshot !== 'function') {
      setSnapshot(null)
      return null
    }
    setBusy(true)
    try {
      const next = await window.api.launchTargetsSnapshot(workspacePath)
      setSnapshot(next)
      return next
    } catch {
      setSnapshot(null)
      return null
    } finally {
      setBusy(false)
    }
  }, [workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return {
    snapshot,
    targets: snapshot?.targets ?? [],
    busy,
    refresh
  }
}
