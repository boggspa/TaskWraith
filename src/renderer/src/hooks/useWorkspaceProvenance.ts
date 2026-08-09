import { useCallback, useEffect, useState } from 'react'
import type { WorkProvenanceSnapshot } from '../../../shared/workProvenance'

export interface WorkspaceProvenanceQuery {
  baseWorkspacePath: string
  workspacePath: string
  chatId: string
}

export interface WorkspaceProvenanceState {
  snapshot: WorkProvenanceSnapshot | null
  loading: boolean
  error: string | null
  refresh: () => void
}

type WorkspaceProvenanceRequestState = {
  requestKey: string
  loading: boolean
  snapshot: WorkProvenanceSnapshot | null
  error: string | null
}

/**
 * Provenance sampling fingerprints dirty paths in a utility process. Run one
 * query for each visible mount/context and require an explicit user refresh;
 * this hook intentionally owns no timer or background retry loop.
 */
export function useWorkspaceProvenance(query: WorkspaceProvenanceQuery): WorkspaceProvenanceState {
  const requestKey = `${query.chatId}\u0000${query.baseWorkspacePath}\u0000${query.workspacePath}`
  const [refreshToken, setRefreshToken] = useState(0)
  const [state, setState] = useState<WorkspaceProvenanceRequestState>({
    requestKey: '',
    loading: true,
    snapshot: null,
    error: null
  })

  useEffect(() => {
    let active = true
    const readProvenance = window.api.gitWorkProvenance
    setState((current) => ({
      requestKey,
      loading: true,
      snapshot: current.requestKey === requestKey ? current.snapshot : null,
      error: null
    }))
    void Promise.resolve()
      .then(() => {
        if (typeof readProvenance !== 'function') {
          throw new Error('Local work provenance is unavailable in this build.')
        }
        return readProvenance({
          repoPath: query.baseWorkspacePath,
          worktreePath: query.workspacePath,
          chatId: query.chatId
        })
      })
      .then((result) => {
        if (!active) return
        if (!result.ok) {
          setState((current) => ({
            requestKey,
            loading: false,
            snapshot: current.requestKey === requestKey ? current.snapshot : null,
            error: result.error
          }))
          return
        }
        setState({
          requestKey,
          loading: false,
          snapshot: result.data,
          error: null
        })
      })
      .catch((error) => {
        if (!active) return
        setState((current) => ({
          requestKey,
          loading: false,
          snapshot: current.requestKey === requestKey ? current.snapshot : null,
          error: error instanceof Error ? error.message : 'Local work provenance is unavailable.'
        }))
      })
    return () => {
      active = false
    }
  }, [query.baseWorkspacePath, query.chatId, query.workspacePath, refreshToken, requestKey])

  const refresh = useCallback(() => setRefreshToken((current) => current + 1), [])
  const currentState = state.requestKey === requestKey ? state : null
  return {
    snapshot: currentState?.snapshot || null,
    loading: currentState?.loading ?? true,
    error: currentState?.error || null,
    refresh
  }
}
