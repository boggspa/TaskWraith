import { useEffect, useMemo, useRef, useState } from 'react'
import {
  workLockProjectionQueryKey,
  workLockProjectionUpdateIsStale,
  type WorkLockProjectionQuery,
  type WorkLockProjectionSnapshot,
  type WorkLockProjectionUpdate
} from '../../../shared/workLockProjection'

export interface WorkspaceLocksState {
  snapshot: WorkLockProjectionSnapshot | null
  loading: boolean
}

export function useWorkspaceLocks(query: WorkLockProjectionQuery): WorkspaceLocksState {
  const queryKey = workLockProjectionQueryKey(query)
  const [state, setState] = useState<
    WorkspaceLocksState & {
      queryKey: string
    }
  >({
    queryKey: '',
    snapshot: null,
    loading: true
  })
  const latestGenerationRef = useRef(-1)
  const stableQuery = useMemo(
    () => ({
      ...(query.workspacePath ? { workspacePath: query.workspacePath } : {}),
      ...(query.chatId ? { chatId: query.chatId } : {})
    }),
    [query.chatId, query.workspacePath]
  )

  useEffect(() => {
    let active = true
    latestGenerationRef.current = -1

    const apply = (update: WorkLockProjectionUpdate): void => {
      if (
        !active ||
        workLockProjectionUpdateIsStale(
          latestGenerationRef.current,
          update.snapshot.generation
        )
      ) {
        return
      }
      latestGenerationRef.current = update.snapshot.generation
      setState({
        queryKey,
        snapshot: update.snapshot,
        loading: false
      })
    }

    let unsubscribe = (): void => undefined
    try {
      unsubscribe = window.api.subscribeWorkLocks(stableQuery, apply)
    } catch {
      // The one-shot list below remains a useful fallback during startup.
    }
    void window.api
      .listWorkLocks(stableQuery)
      .then((next) => apply({ reason: 'initial', snapshot: next }))
      .catch(() => {
        if (active && latestGenerationRef.current < 0) {
          setState({
            queryKey,
            snapshot: null,
            loading: false
          })
        }
      })

    return () => {
      active = false
      unsubscribe()
    }
  }, [queryKey, stableQuery])

  const snapshotMatchesQuery = state.queryKey === queryKey
  return {
    snapshot: snapshotMatchesQuery ? state.snapshot : null,
    loading: snapshotMatchesQuery ? state.loading : true
  }
}
