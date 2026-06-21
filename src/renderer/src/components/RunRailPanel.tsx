import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ChatRecord,
  ChatRun,
  HandoffCard,
  ProviderId,
  RunAnalystRequest,
  RunAnalystSnapshot,
  RunEventReplay
} from '../../../main/store/types'
import { compactPromptPreview, type RunLane } from '../lib/RunLanes'
import { buildLaunchAttemptRows, type LaunchAttemptRow } from '../lib/launchAttemptRows'
import { getProviderLabel } from '../lib/providerLabels'
import { useLaunchAttempts } from '../hooks/useLaunchAttempts'
import { RunInspector } from './RunInspector'
import { ProviderBadgeIcon } from './Sidebar'
import { ReviewSymbolIcon, RunSymbolIcon } from './AppChromeSymbols'

interface RunRailPanelProps {
  lanes: RunLane[]
  handoffCards: HandoffCard[]
  chats: ChatRecord[]
  currentChat?: ChatRecord | null
  currentRun?: ChatRun | null
  selectedRunId?: string | null
  onSelectRun: (runId: string) => void
  onOpenThread: (chatId?: string) => void
  onCancelRun: (lane: RunLane) => void
  onRetryRun: (lane: RunLane) => void
  onDuplicateRun: (lane: RunLane) => void
  onCreateHandoff: (lane: RunLane) => void
  onDispatchHandoff: (card: HandoffCard) => void
  onArchiveHandoff: (card: HandoffCard) => void
  onPersistAnalysis: (chatId: string, runId: string, snapshot: RunAnalystSnapshot) => void
}

interface RunSource {
  lane: RunLane | null
  chat: ChatRecord | null
  run: ChatRun | null
}

const providerIds: ProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama'
]

function formatDuration(startedAt?: string, endedAt?: string): string {
  if (!startedAt || !endedAt) return ''
  const start = new Date(startedAt).getTime()
  const end = new Date(endedAt).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ''
  const totalSeconds = Math.round((end - start) / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function signal(
  label: string,
  value: string,
  tone: RunAnalystSnapshot['signals'][number]['tone'] = 'neutral'
): RunAnalystSnapshot['signals'][number] {
  return { label, value, tone }
}

function findRunSource({
  lanes,
  chats,
  currentChat,
  currentRun,
  selectedRunId
}: {
  lanes: RunLane[]
  chats: ChatRecord[]
  currentChat?: ChatRecord | null
  currentRun?: ChatRun | null
  selectedRunId?: string | null
}): RunSource {
  const runId = selectedRunId || currentRun?.runId || lanes.find((lane) => lane.runId)?.runId || ''
  const lane = runId ? lanes.find((item) => item.runId === runId) || null : null
  const currentChatRun =
    runId && currentChat?.runs?.some((run) => run.runId === runId) ? currentChat : null
  const chat =
    currentChatRun ||
    (lane?.chatId ? chats.find((item) => item.appChatId === lane.chatId) || null : null) ||
    chats.find((item) => item.runs?.some((run) => run.runId === runId)) ||
    null
  const run =
    (runId && chat?.runs?.find((item) => item.runId === runId)) ||
    (currentRun?.runId === runId ? currentRun : null)
  return { lane, chat, run }
}

function buildLocalAnalysis(source: RunSource, replay: RunEventReplay | null): RunAnalystSnapshot | null {
  const runId = source.run?.runId || source.lane?.runId
  if (!runId) return null

  const status = source.run?.status || source.lane?.status || 'unknown'
  const phase = source.lane?.phase || (status === 'failed' ? 'failed' : 'completed')
  const provider = source.run?.provider || source.lane?.provider || source.chat?.provider || 'gemini'
  const touchedFiles = source.lane?.touchedFiles || []
  const counts = replay?.countsByKind || {}
  const providerErrors = Number(counts.provider_error || 0)
  const approvals = Number(counts.approval_request || 0)
  const timeouts = Number(counts.approval_timer_timeout || 0)
  const duration = formatDuration(source.run?.startedAt, source.run?.endedAt)
  const warnings = source.run?.warnings?.map((warning) => warning.message) || []
  const risks: string[] = []
  const nextSteps: string[] = []

  if (phase === 'failed' || providerErrors > 0) risks.push('Provider errors were recorded.')
  if (phase === 'cancelled') risks.push('Run was cancelled before a normal completion.')
  if (timeouts > 0) risks.push('One or more approvals timed out.')
  if (warnings.length > 0) risks.push(...warnings.slice(0, 3))
  if (source.lane?.conflictSummary) risks.push(source.lane.conflictSummary)
  if (risks.length === 0) risks.push('No high-risk run signals detected.')

  if (phase === 'failed') nextSteps.push('Open the thread, inspect the final provider error, then retry if the workspace is still valid.')
  if (touchedFiles.length > 0) nextSteps.push('Review this run in Diff Studio before committing or handing off.')
  if (approvals > 0) nextSteps.push('Audit approval decisions for scope and intent.')
  if (phase === 'active') nextSteps.push('Keep the run selected here while it streams; the event timeline will refresh on demand.')
  if (nextSteps.length === 0) nextSteps.push('Open the run timeline for event-level details.')

  return {
    runId,
    generatedAt: new Date().toISOString(),
    source: 'local',
    status: 'ready',
    summary: `${getProviderLabel(provider)} run ${status || phase}${duration ? ` in ${duration}` : ''}. ${replay?.count || 0} recorded event${replay?.count === 1 ? '' : 's'}${touchedFiles.length ? `, ${touchedFiles.length} touched file${touchedFiles.length === 1 ? '' : 's'}` : ''}.`,
    risks: risks.slice(0, 6),
    nextSteps: nextSteps.slice(0, 6),
    signals: [
      signal('Status', status || phase, phase === 'failed' ? 'bad' : phase === 'cancelled' ? 'warn' : 'good'),
      signal('Provider', getProviderLabel(provider)),
      signal('Events', String(replay?.count || 0)),
      signal('Approvals', String(approvals), approvals > 0 ? 'warn' : 'neutral'),
      signal('Files', String(touchedFiles.length), touchedFiles.length > 0 ? 'warn' : 'neutral')
    ]
  }
}

function buildAnalystRequest(source: RunSource, replay: RunEventReplay | null): RunAnalystRequest | null {
  const runId = source.run?.runId || source.lane?.runId
  if (!runId) return null
  const provider = source.run?.provider || source.lane?.provider || source.chat?.provider
  return {
    runId,
    provider,
    chatTitle: source.chat?.title || source.lane?.chatTitle,
    status: source.run?.status || source.lane?.status,
    startedAt: source.run?.startedAt,
    endedAt: source.run?.endedAt,
    promptPreview:
      source.lane?.promptPreview ||
      compactPromptPreview(
        source.chat?.messages.find((message) => message.id === source.run?.promptMessageId)?.content
      ),
    workspacePath: source.run?.effectiveWorkspacePath || source.lane?.workspacePath || source.chat?.workspacePath,
    touchedFiles: source.lane?.touchedFiles || [],
    warnings: source.run?.warnings?.map((warning) => warning.message) || [],
    countsByKind: replay?.countsByKind || {},
    timeline:
      replay?.timeline.slice(-14).map((item) => ({
        kind: item.kind,
        summary: item.summary,
        timestamp: item.timestamp
      })) || []
  }
}

export function RunRailPanel({
  lanes,
  handoffCards,
  chats,
  currentChat,
  currentRun,
  selectedRunId,
  onSelectRun,
  onOpenThread,
  onCancelRun,
  onRetryRun,
  onDuplicateRun,
  onCreateHandoff,
  onDispatchHandoff,
  onArchiveHandoff,
  onPersistAnalysis
}: RunRailPanelProps) {
  const [replay, setReplay] = useState<RunEventReplay | null>(null)
  const [replayError, setReplayError] = useState('')
  const [analysis, setAnalysis] = useState<RunAnalystSnapshot | null>(null)
  const [analysisBusy, setAnalysisBusy] = useState(false)
  const [launchActionError, setLaunchActionError] = useState('')
  const { attempts: launchAttempts, stop: stopLaunchAttempt } = useLaunchAttempts()

  const source = useMemo(
    () => findRunSource({ lanes, chats, currentChat, currentRun, selectedRunId }),
    [lanes, chats, currentChat, currentRun, selectedRunId]
  )
  const runId = source.run?.runId || source.lane?.runId || ''
  const storedAnalysis = source.run?.runAnalyst || null
  const localAnalysis = useMemo(() => buildLocalAnalysis(source, replay), [source, replay])
  const displayedAnalysis = analysis || storedAnalysis || localAnalysis
  const openHandoffs = handoffCards.filter((card) => card.status === 'draft')
  const activeCount = lanes.filter((lane) => lane.phase === 'active').length
  const waitingCount = lanes.filter((lane) =>
    lane.phase === 'queued' || lane.phase === 'scheduled' || lane.phase === 'paused'
  ).length
  const failedCount = lanes.filter((lane) => lane.phase === 'failed').length
  const launchRows = useMemo(() => buildLaunchAttemptRows(launchAttempts), [launchAttempts])
  const activeLaunchCount = launchRows.filter((row) => row.active).length

  useEffect(() => {
    setAnalysis(null)
    setReplay(null)
    setReplayError('')
    if (!runId) return
    let cancelled = false
    window.api
      .getRunEventReplay(runId)
      .then((nextReplay) => {
        if (!cancelled) setReplay(nextReplay)
      })
      .catch((error) => {
        if (!cancelled) setReplayError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [runId])

  const handleAnalyze = useCallback(async () => {
    const request = buildAnalystRequest(source, replay)
    if (!request || !source.chat) return
    setAnalysisBusy(true)
    try {
      const snapshot = await window.api.analyzeRun(request)
      setAnalysis(snapshot)
      if (snapshot.status === 'ready') {
        onPersistAnalysis(source.chat.appChatId, request.runId, snapshot)
      }
    } catch (error) {
      setAnalysis({
        runId: request.runId,
        generatedAt: new Date().toISOString(),
        source: 'foundationModels',
        status: 'error',
        summary: 'Run analysis failed.',
        risks: [error instanceof Error ? error.message : String(error)],
        nextSteps: ['Use the local deterministic summary above.'],
        signals: []
      })
    } finally {
      setAnalysisBusy(false)
    }
  }, [source, replay, onPersistAnalysis])

  const handleStopLaunch = useCallback(
    async (row: LaunchAttemptRow) => {
      setLaunchActionError('')
      try {
        const result = await stopLaunchAttempt({ attemptId: row.id })
        if (result && !result.ok) {
          setLaunchActionError(result.error || `Could not stop ${row.label}.`)
        }
      } catch (error) {
        setLaunchActionError(error instanceof Error ? error.message : String(error))
      }
    },
    [stopLaunchAttempt]
  )

  return (
    <div className="run-rail-panel">
      <header className="run-rail-header">
        <div>
          <span className="right-dock-kicker">Run rail</span>
          <strong>Live lanes and analyst</strong>
        </div>
        <div className="run-rail-metrics" aria-label="Run lane metrics">
          <span><strong>{activeCount}</strong> active</span>
          <span><strong>{waitingCount}</strong> waiting</span>
          <span><strong>{failedCount}</strong> failed</span>
          <span><strong>{activeLaunchCount}</strong> launch</span>
        </div>
      </header>

      <div className="run-rail-provider-strip">
        {providerIds.map((provider) => {
          const count = lanes.filter((lane) => lane.provider === provider && lane.phase !== 'completed').length
          return (
            <span key={provider} className={`run-rail-provider provider-${provider}`}>
              <ProviderBadgeIcon provider={provider} />
              <span>{count}</span>
            </span>
          )
        })}
      </div>

      <section className="run-rail-section run-rail-launches">
        <div className="run-rail-section-title">
          <strong>Launches</strong>
          <span>{launchRows.length} tracked</span>
        </div>
        {launchRows.length === 0 ? (
          <div className="run-rail-empty">No launch targets have been started yet.</div>
        ) : (
          <div className="run-rail-launch-list" role="list">
            {launchRows.slice(0, 12).map((row) => (
              <article
                key={row.id}
                className={`run-rail-launch tone-${row.tone}`}
                role="listitem"
              >
                <div className="run-rail-launch-top">
                  <span className="run-rail-lane-provider">
                    <ProviderBadgeIcon provider={row.provider} />
                    <strong>{row.label}</strong>
                  </span>
                  <span className="run-rail-launch-status">{row.statusLabel}</span>
                </div>
                <div className="run-rail-launch-command" title={row.command}>
                  {row.command}
                </div>
                <div className="run-rail-lane-meta">
                  <span title={row.workspacePath}>{row.workspaceName}</span>
                  {row.branchLabel && (
                    <span title={`Git branch: ${row.branchLabel}`}>{row.branchLabel}</span>
                  )}
                  <span>{row.executionLabel}</span>
                  <span title={row.cwd}>{row.cwd.split(/[\\/]/).pop() || row.cwd}</span>
                  {row.pid && <span>pid {row.pid}</span>}
                  {row.duration && <span>{row.duration}</span>}
                </div>
                {row.outputPreview && (
                  <pre className="run-rail-launch-output">
                    {`${row.outputTruncated ? '[truncated]\n' : ''}${row.outputPreview}`}
                  </pre>
                )}
                {row.lastError && <div className="run-rail-error">{row.lastError}</div>}
                <div className="run-rail-actions">
                  {row.chatId && (
                    <button type="button" onClick={() => onOpenThread(row.chatId)}>
                      Thread
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleStopLaunch(row)}
                    disabled={!row.canStop}
                  >
                    Stop
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {launchActionError && <div className="run-rail-error">{launchActionError}</div>}
      </section>

      <section className="run-rail-section run-rail-runs">
        <div className="run-rail-section-title">
          <strong>Runs</strong>
          <span>{lanes.length} tracked</span>
        </div>
        <div className="run-rail-lanes" role="list">
          {lanes.length === 0 ? (
            <div className="run-rail-empty">No runs have been recorded yet.</div>
          ) : (
            lanes.slice(0, 40).map((lane) => (
              <button
                key={lane.id}
                className={`run-rail-lane phase-${lane.phase}${lane.runId === runId ? ' is-selected' : ''}`}
                type="button"
                role="listitem"
                onClick={() => lane.runId && onSelectRun(lane.runId)}
                disabled={!lane.runId}
              >
                <span className="run-rail-lane-top">
                  <span className="run-rail-lane-provider">
                    <ProviderBadgeIcon provider={lane.provider} />
                    <strong>{lane.chatTitle || lane.chatId || 'Untitled chat'}</strong>
                  </span>
                  <span className="run-rail-lane-phase">{lane.phase}</span>
                </span>
                <span className="run-rail-lane-prompt">
                  {lane.promptPreview || 'No prompt preview available.'}
                </span>
                <span className="run-rail-lane-meta">
                  <span>{lane.runtimeProfileName || 'Default runtime'}</span>
                  {lane.workspacePath && (
                    <span title={lane.workspacePath}>
                      {lane.workspacePath.split(/[\\/]/).pop() || lane.workspacePath}
                    </span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <section className="run-rail-section run-rail-analyst">
        <div className="run-rail-section-title">
          <strong>Analyst</strong>
          {displayedAnalysis && (
            <span>
              {displayedAnalysis.source === 'foundationModels' ? 'Foundation Models' : 'Local'}
            </span>
          )}
        </div>
        {displayedAnalysis ? (
          <>
            <p className="run-rail-summary">{displayedAnalysis.summary}</p>
            <div className="run-rail-signals">
              {displayedAnalysis.signals.map((item) => (
                <span key={`${item.label}:${item.value}`} className={`run-rail-signal tone-${item.tone || 'neutral'}`}>
                  <small>{item.label}</small>
                  <strong>{item.value}</strong>
                </span>
              ))}
            </div>
            <div className="run-rail-lists">
              <div>
                <strong>Risks</strong>
                <ul>
                  {displayedAnalysis.risks.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>Next</strong>
                <ul>
                  {displayedAnalysis.nextSteps.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          </>
        ) : (
          <div className="run-rail-empty">Select a recorded run to analyze it.</div>
        )}
        <div className="run-rail-actions">
          <button type="button" onClick={handleAnalyze} disabled={!runId || analysisBusy}>
            <ReviewSymbolIcon />
            <span>{analysisBusy ? 'Analyzing' : 'Local AI'}</span>
          </button>
          {source.lane && (
            <>
              <button type="button" onClick={() => onOpenThread(source.lane?.chatId)}>
                <RunSymbolIcon />
                <span>Open</span>
              </button>
              <button
                type="button"
                onClick={() => source.lane && onCancelRun(source.lane)}
                disabled={!source.lane.runId || !['active', 'queued', 'paused'].includes(source.lane.phase)}
              >
                Cancel
              </button>
              <button type="button" onClick={() => source.lane && onRetryRun(source.lane)} disabled={!source.lane.runId}>
                Retry
              </button>
              <button type="button" onClick={() => source.lane && onDuplicateRun(source.lane)} disabled={!source.lane.chatId}>
                Duplicate
              </button>
              <button type="button" onClick={() => source.lane && onCreateHandoff(source.lane)} disabled={!source.lane.runId || !source.lane.chatId}>
                Handoff
              </button>
            </>
          )}
        </div>
        {displayedAnalysis?.error && (
          <div className="run-rail-error">{displayedAnalysis.error}</div>
        )}
      </section>

      {runId && (
        <section className="run-rail-section run-rail-timeline">
          <RunInspector
            runId={runId}
            onJumpToSubThread={(subThreadId) => onOpenThread(subThreadId)}
          />
          {replayError && <div className="run-rail-error">{replayError}</div>}
        </section>
      )}

      <section className="run-rail-section run-rail-handoffs-section">
        <div className="run-rail-section-title">
          <strong>Handoffs</strong>
          <span>{openHandoffs.length} draft</span>
        </div>
        {openHandoffs.length === 0 ? (
          <div className="run-rail-empty">No draft handoffs.</div>
        ) : (
          <div className="run-rail-handoffs">
            {openHandoffs.map((card) => (
              <article key={card.id} className="run-rail-handoff">
                <strong>{getProviderLabel(card.sourceProvider)} handoff</strong>
                <p>{compactPromptPreview(card.summary || card.finalPrompt)}</p>
                <div className="run-rail-actions">
                  <button type="button" onClick={() => onOpenThread(card.sourceChatId)}>
                    Source
                  </button>
                  <button type="button" onClick={() => onDispatchHandoff(card)}>
                    Dispatch
                  </button>
                  <button type="button" onClick={() => onArchiveHandoff(card)}>
                    Archive
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
