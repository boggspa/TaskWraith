import { useCallback, useEffect, useState } from 'react'
import type {
  LaunchSnapshot,
  LaunchStartInput,
  LaunchStartResult,
  LaunchStopInput,
  LaunchStopResult
} from '../../../main/launch/types'

export function useLaunchAttempts(): {
  snapshot: LaunchSnapshot | null
  attempts: LaunchSnapshot['attempts']
  busy: boolean
  refresh: () => Promise<LaunchSnapshot | null>
  start: (input: LaunchStartInput) => Promise<LaunchStartResult | null>
  stop: (input: LaunchStopInput) => Promise<LaunchStopResult | null>
} {
  const [snapshot, setSnapshot] = useState<LaunchSnapshot | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<LaunchSnapshot | null> => {
    if (typeof window.api.launchAttemptsSnapshot !== 'function') return null
    try {
      const next = await window.api.launchAttemptsSnapshot()
      setSnapshot(next)
      return next
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
    if (typeof window.api.onLaunchAttemptsChanged !== 'function') return
    return window.api.onLaunchAttemptsChanged((next) => setSnapshot(next))
  }, [refresh])

  const start = useCallback(
    async (input: LaunchStartInput): Promise<LaunchStartResult | null> => {
      if (typeof window.api.launchStart !== 'function') return null
      setBusy(true)
      try {
        const result = await window.api.launchStart(input)
        await refresh()
        return result
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  const stop = useCallback(
    async (input: LaunchStopInput): Promise<LaunchStopResult | null> => {
      if (typeof window.api.launchStop !== 'function') return null
      setBusy(true)
      try {
        const result = await window.api.launchStop(input)
        await refresh()
        return result
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  return {
    snapshot,
    attempts: snapshot?.attempts ?? [],
    busy,
    refresh,
    start,
    stop
  }
}
