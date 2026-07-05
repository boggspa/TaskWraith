import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  MemoryProposal,
  MemoryProposalPack,
  MemoryProposalStatus
} from '../../../main/store/types'
import {
  buildIntrospectionScheduleMetaLines,
  introspectionScheduleApiReady,
  type IntrospectionScheduleSettings
} from '../lib/threadIntrospectionSchedule'
import { MemoryProposalReviewPanel } from './MemoryProposalReviewPanel'
import './ThreadIntrospectionSettingsPanel.css'

/**
 * Settings host for Thread Introspection — wires MemoryProposalReviewPanel
 * to the preload IPC surface and optional daily schedule controls.
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

export type { IntrospectionScheduleSettings } from '../lib/threadIntrospectionSchedule'

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
  getIntrospectionSchedule?: (
    workspaceId?: string | null
  ) => Promise<IntrospectionScheduleSettings>
  updateIntrospectionSchedule?: (
    partial: Partial<IntrospectionScheduleSettings> & { workspaceId?: string | null }
  ) => Promise<IntrospectionScheduleSettings>
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
  const scheduleApiReady = introspectionScheduleApiReady(api)

  const [runLoading, setRunLoading] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [runNotice, setRunNotice] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [schedule, setSchedule] = useState<IntrospectionScheduleSettings | null>(null)
  const [scheduleLoading, setScheduleLoading] = useState(false)
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [scheduleError, setScheduleError] = useState<string | null>(null)

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

  const loadSchedule = useCallback(async () => {
    if (!api?.getIntrospectionSchedule) return
    try {
      setScheduleLoading(true)
      setScheduleError(null)
      const result = await api.getIntrospectionSchedule(workspaceId ?? undefined)
      setSchedule(result)
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : String(err))
    } finally {
      setScheduleLoading(false)
    }
  }, [api, workspaceId])

  useEffect(() => {
    if (!scheduleApiReady) return
    void loadSchedule()
  }, [loadSchedule, scheduleApiReady])

  const scheduleMetaLines = useMemo(
    () =>
      scheduleApiReady
        ? buildIntrospectionScheduleMetaLines({
            schedule,
            loading: scheduleLoading,
            saving: scheduleSaving
          })
        : [],
    [schedule, scheduleApiReady, scheduleLoading, scheduleSaving]
  )

  const handleScheduleToggle = useCallback(
    async (enabled: boolean) => {
      if (!api?.updateIntrospectionSchedule) {
        setScheduleError('Daily scheduling is not available in this build yet.')
        return
      }
      try {
        setScheduleSaving(true)
        setScheduleError(null)
        const updated = await api.updateIntrospectionSchedule({
          enabled,
          workspaceId: workspaceId ?? undefined
        })
        setSchedule(updated)
      } catch (err) {
        setScheduleError(err instanceof Error ? err.message : String(err))
      } finally {
        setScheduleSaving(false)
      }
    },
    [api, workspaceId]
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

      <div
        className={`thread-introspection-settings-schedule${
          schedule?.enabled ? ' thread-introspection-settings-schedule--enabled' : ''
        }`}
      >
        <div className="thread-introspection-settings-schedule-header">
          <div className="thread-introspection-settings-schedule-title">Automatic daily harvest</div>
          {scheduleApiReady && schedule?.enabled && (
            <span className="thread-introspection-settings-schedule-badge" aria-hidden="true">
              On
            </span>
          )}
        </div>
        <label
          className={`thread-introspection-settings-schedule-toggle${
            !scheduleApiReady || scheduleLoading || scheduleSaving
              ? ' thread-introspection-settings-schedule-toggle--disabled'
              : ''
          }`}
        >
          <input
            type="checkbox"
            checked={schedule?.enabled ?? false}
            disabled={!scheduleApiReady || scheduleLoading || scheduleSaving}
            aria-busy={scheduleLoading || scheduleSaving}
            onChange={(event) => void handleScheduleToggle(event.target.checked)}
          />
          <span>
            <strong>Enable daily run</strong>
            <span className="thread-introspection-settings-schedule-hint">
              Once per calendar day, harvest the last 24 hours for this workspace and leave new
              proposals in review. Scheduled runs are read-only — no skills or durable memory change
              until you approve them.
            </span>
          </span>
        </label>
        {scheduleApiReady && scheduleMetaLines.length > 0 && (
          <div
            className="thread-introspection-settings-schedule-meta"
            role="status"
            aria-live="polite"
          >
            {scheduleMetaLines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
        )}
        {!scheduleApiReady && (
          <p className="thread-introspection-settings-schedule-pending" role="status">
            Daily scheduling is not available in this build yet. Manual runs and proposal review
            still work when Thread Introspection IPC is wired.
          </p>
        )}
      </div>

      {!ipcReady && (
        <p className="thread-introspection-settings-ipc-hint" role="status">
          Thread Introspection review API is unavailable in this context. Reload the app or check
          that preload exposed getMemoryProposalPacks and updateMemoryProposal.
        </p>
      )}

      {scheduleError && (
        <div className="settings-error thread-introspection-settings-run-error">{scheduleError}</div>
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