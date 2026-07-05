import React, { useCallback, useMemo, useState } from 'react'
import type {
  MemoryProposal,
  MemoryProposalPack,
  MemoryProposalStatus
} from '../../../main/store/types'
import { MemoryProposalReviewPanel } from './MemoryProposalReviewPanel'
import './ThreadIntrospectionSettingsPanel.css'

/**
 * Settings host for Thread Introspection — wires MemoryProposalReviewPanel
 * to the preload IPC surface. Falls back to a clear hint when api methods
 * are absent (e.g. static test render).
 */

export interface RunManualIntrospectionRequest {
  windowStart: string
  windowEnd: string
  workspaceId?: string
  workspacePath?: string
}

export interface RunManualIntrospectionResponse {
  pack: MemoryProposalPack
  evidenceCount: number
  proposalCount: number
}

interface ThreadIntrospectionApi {
  getMemoryProposalPacks?: (workspaceId?: string | null) => Promise<MemoryProposalPack[]>
  updateMemoryProposal?: (
    packId: string,
    proposalId: string,
    partial: Partial<MemoryProposal>
  ) => Promise<MemoryProposalPack | null>
  runManualIntrospection?: (
    input: RunManualIntrospectionRequest
  ) => Promise<RunManualIntrospectionResponse>
}

export interface ThreadIntrospectionSettingsPanelProps {
  workspaceId?: string | null
  workspacePath?: string | null
}

function introspectionApi(): ThreadIntrospectionApi | undefined {
  if (typeof window === 'undefined') return undefined
  return window.api as ThreadIntrospectionApi | undefined
}

function hasIntrospectionIpc(api: ThreadIntrospectionApi | undefined): boolean {
  return (
    typeof api?.getMemoryProposalPacks === 'function' &&
    typeof api?.updateMemoryProposal === 'function'
  )
}

function last24hWindow(): { windowStart: string; windowEnd: string } {
  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000)
  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString()
  }
}

export function ThreadIntrospectionSettingsPanel({
  workspaceId = null,
  workspacePath = null
}: ThreadIntrospectionSettingsPanelProps): React.JSX.Element {
  const api = useMemo(() => introspectionApi(), [])
  const ipcReady = hasIntrospectionIpc(api)
  const canRun = typeof api?.runManualIntrospection === 'function'

  const [runLoading, setRunLoading] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [runNotice, setRunNotice] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  const bumpRefresh = useCallback(() => {
    setRefreshToken((value) => value + 1)
  }, [])

  const fetchPacks = useCallback(
    async (scopedWorkspaceId?: string | null) => {
      if (!api?.getMemoryProposalPacks) {
        throw new Error('Thread Introspection IPC is not wired yet.')
      }
      return api.getMemoryProposalPacks(scopedWorkspaceId ?? workspaceId ?? undefined)
    },
    [api, workspaceId]
  )

  const onUpdateProposalStatus = useCallback(
    async (
      packId: string,
      proposalId: string,
      status: Extract<MemoryProposalStatus, 'approved' | 'rejected'>
    ) => {
      if (!api?.updateMemoryProposal) {
        throw new Error('Thread Introspection IPC is not wired yet.')
      }
      const updated = await api.updateMemoryProposal(packId, proposalId, { status })
      if (!updated) {
        throw new Error('Proposal update failed — pack or proposal not found.')
      }
    },
    [api]
  )

  const handleRunLast24h = useCallback(async () => {
    if (!api?.runManualIntrospection) {
      setRunError('Manual introspection IPC is not wired yet.')
      return
    }
    try {
      setRunLoading(true)
      setRunError(null)
      setRunNotice(null)
      const window = last24hWindow()
      const result = await api.runManualIntrospection({
        ...window,
        workspaceId: workspaceId ?? undefined,
        workspacePath: workspacePath ?? undefined
      })
      setRunNotice(
        `Collected ${result.evidenceCount} evidence signal${result.evidenceCount === 1 ? '' : 's'} and distilled ${result.proposalCount} proposal${result.proposalCount === 1 ? '' : 's'}.`
      )
      bumpRefresh()
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunLoading(false)
    }
  }, [api, bumpRefresh, workspaceId, workspacePath])

  return (
    <div className="thread-introspection-settings-panel">
      <div className="thread-introspection-settings-toolbar">
        <div className="thread-introspection-settings-toolbar-copy">
          <div className="thread-introspection-settings-toolbar-title">Daily retrospective</div>
          <p className="settings-hint">
            Scan the last 24 hours of runs and threads, then review distilled lessons before anything
            durable is promoted.
          </p>
        </div>
        <button
          type="button"
          className="thread-introspection-settings-run-button"
          onClick={() => void handleRunLast24h()}
          disabled={!canRun || runLoading}
          title={
            canRun
              ? 'Harvest evidence from the last 24 hours and generate a proposal pack'
              : 'Waiting for Main IPC wiring'
          }
        >
          {runLoading ? 'Running…' : 'Run introspection (24h)'}
        </button>
      </div>

      {!ipcReady && (
        <p className="thread-introspection-settings-ipc-hint" role="status">
          Thread Introspection API methods are unavailable in this context. Reload the app or check
          that preload exposed getMemoryProposalPacks and updateMemoryProposal.
        </p>
      )}

      {runError && <div className="settings-error thread-introspection-settings-run-error">{runError}</div>}
      {runNotice && (
        <p className="thread-introspection-settings-run-notice" role="status">
          {runNotice}
        </p>
      )}

      <MemoryProposalReviewPanel
        key={refreshToken}
        workspaceId={workspaceId}
        fetchPacks={ipcReady ? fetchPacks : undefined}
        onUpdateProposalStatus={ipcReady ? onUpdateProposalStatus : undefined}
        onRefresh={ipcReady ? bumpRefresh : undefined}
        error={ipcReady ? null : 'Thread Introspection IPC is not wired yet.'}
      />
    </div>
  )
}