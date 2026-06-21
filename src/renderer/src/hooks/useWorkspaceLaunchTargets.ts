import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LaunchTargetsSnapshot } from '../../../main/launchTargets/types'

export interface WorkspaceLaunchTargetState {
  snapshots: Record<string, LaunchTargetsSnapshot>
  errors: Record<string, string>
  busy: boolean
  refresh: (workspacePath?: string | null) => Promise<LaunchTargetsSnapshot | null>
  targetsForWorkspace: (workspacePath: string | null | undefined) => LaunchTargetsSnapshot['targets']
  snapshotForWorkspace: (workspacePath: string | null | undefined) => LaunchTargetsSnapshot | null
  errorForWorkspace: (workspacePath: string | null | undefined) => string | null
}

function normalizeWorkspacePath(value: string | null | undefined): string {
  if (!value) return ''
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-z]:/i.test(normalized)) return normalized.toLowerCase()
  return normalized
}

function workspacePathListKey(paths: Array<string | null | undefined>): string {
  return paths.map(normalizeWorkspacePath).filter(Boolean).sort().join('\n')
}

export function normalizeLaunchWorkspacePaths(
  workspacePaths: Array<string | null | undefined>
): string[] {
  const byKey = new Map<string, string>()
  for (const workspacePath of workspacePaths) {
    const key = normalizeWorkspacePath(workspacePath)
    if (key && !byKey.has(key)) byKey.set(key, workspacePath as string)
  }
  return [...byKey.values()]
}

export function useWorkspaceLaunchTargets(
  workspacePaths: Array<string | null | undefined>
): WorkspaceLaunchTargetState {
  const workspacePathKey = workspacePathListKey(workspacePaths)
  const normalizedWorkspacePaths = useMemo(
    () => normalizeLaunchWorkspacePaths(workspacePaths),
    [workspacePathKey]
  )
  const workspacePathsRef = useRef(normalizedWorkspacePaths)
  const requestSeqRef = useRef(0)
  const [snapshots, setSnapshots] = useState<Record<string, LaunchTargetsSnapshot>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    workspacePathsRef.current = normalizedWorkspacePaths
  }, [normalizedWorkspacePaths])

  const refreshOne = useCallback(
    async (workspacePath: string, seq: number): Promise<LaunchTargetsSnapshot | null> => {
      if (typeof window.api.launchTargetsSnapshot !== 'function') return null
      const key = normalizeWorkspacePath(workspacePath)
      try {
        const next = await window.api.launchTargetsSnapshot(workspacePath)
        if (seq !== requestSeqRef.current) return next
        setSnapshots((current) => ({ ...current, [key]: next }))
        setErrors((current) => {
          if (!current[key]) return current
          const { [key]: _removed, ...rest } = current
          return rest
        })
        return next
      } catch (err) {
        if (seq === requestSeqRef.current) {
          setErrors((current) => ({
            ...current,
            [key]: err instanceof Error ? err.message : String(err)
          }))
        }
        return null
      }
    },
    []
  )

  const refresh = useCallback(
    async (workspacePath?: string | null): Promise<LaunchTargetsSnapshot | null> => {
      const paths = workspacePath ? [workspacePath] : workspacePathsRef.current
      if (paths.length === 0) return null
      const seq = requestSeqRef.current + 1
      requestSeqRef.current = seq
      setBusy(true)
      try {
        const results = await Promise.all(paths.map((path) => refreshOne(path, seq)))
        return results.find((result): result is LaunchTargetsSnapshot => Boolean(result)) || null
      } finally {
        if (seq === requestSeqRef.current) setBusy(false)
      }
    },
    [refreshOne]
  )

  useEffect(() => {
    void refresh()
  }, [normalizedWorkspacePaths, refresh])

  useEffect(() => {
    const refreshCurrent = (): void => {
      void refresh()
    }
    const disposers: Array<() => void> = []
    if (typeof window.api.onLocalServersChanged === 'function') {
      disposers.push(window.api.onLocalServersChanged(refreshCurrent))
    }
    if (typeof window.api.onLaunchAttemptsChanged === 'function') {
      disposers.push(window.api.onLaunchAttemptsChanged(refreshCurrent))
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [refresh])

  const snapshotForWorkspace = useCallback(
    (workspacePath: string | null | undefined): LaunchTargetsSnapshot | null => {
      const key = normalizeWorkspacePath(workspacePath)
      return key ? snapshots[key] || null : null
    },
    [snapshots]
  )

  const targetsForWorkspace = useCallback(
    (workspacePath: string | null | undefined): LaunchTargetsSnapshot['targets'] => {
      return snapshotForWorkspace(workspacePath)?.targets ?? []
    },
    [snapshotForWorkspace]
  )

  const errorForWorkspace = useCallback(
    (workspacePath: string | null | undefined): string | null => {
      const key = normalizeWorkspacePath(workspacePath)
      return key ? errors[key] || null : null
    },
    [errors]
  )

  return {
    snapshots,
    errors,
    busy,
    refresh,
    targetsForWorkspace,
    snapshotForWorkspace,
    errorForWorkspace
  }
}
