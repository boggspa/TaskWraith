import { useEffect, useMemo, useState, type JSX } from 'react'
import type { ChatRun, ProviderId, RunEventReplay } from '../../../main/store/types'
import { classifyRunEvent } from '../lib/RunEventClassifier'
import { humaniseModelId } from '../lib/modelDisplayName'
import { resolveOllamaDisplayBrand, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { getProviderLabel } from '../lib/providerLabels'
import { useSharedNowTick } from '../hooks/useSharedNowTick'
import { DigitOdometer } from './DigitOdometer'

interface RunCardProps {
  run: ChatRun
  fallbackProvider?: ProviderId
  /** Phase K1B: when provided, the Inspect button enters Run mode for
   * this run. Without it, the button just logs a stub for debugging
   * (the K1A default). */
  onInspect?: (runId: string) => void
  onOpenSideChat?: (runId: string) => void
}

interface RunAggregate {
  approvalCount: number
  eventFileCount: number | null
}

export function RunCard({
  run,
  fallbackProvider,
  onInspect,
  onOpenSideChat
}: RunCardProps): JSX.Element {
  const provider = run.provider || fallbackProvider || 'gemini'
  const providerDisplay = getRunProviderDisplay(run, provider)
  const [aggregate, setAggregate] = useState<RunAggregate>({
    approvalCount: 0,
    eventFileCount: null
  })
  const isActive =
    !run.endedAt &&
    run.status !== 'failed' &&
    run.status !== 'cancelled' &&
    run.status !== 'success' &&
    run.status !== 'sleeping'
  const nowTick = useSharedNowTick(isActive)
  const fileCount = useMemo(() => {
    const diffCount = countRunDiffFiles(run)
    if (diffCount !== null) return diffCount
    return aggregate.eventFileCount
  }, [aggregate.eventFileCount, run])

  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      if (!run.runId || typeof window.api.getRunEventReplay !== 'function') return
      if (document.hidden) return
      try {
        const replay = (await window.api.getRunEventReplay(run.runId)) as RunEventReplay
        if (cancelled) return
        const next = buildRunAggregate(replay)
        setAggregate((current) =>
          current.approvalCount === next.approvalCount && current.eventFileCount === next.eventFileCount
            ? current
            : next
        )
      } catch {
        if (!cancelled) setAggregate((current) => current)
      }
    }
    void refresh()
    if (!isActive)
      return () => {
        cancelled = true
      }
    const intervalId = window.setInterval(() => void refresh(), 2000)
    const onVisibilityChange = (): void => {
      if (!document.hidden) void refresh()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [isActive, run.runId])

  const status = getRunStatus(run)
  const duration = useMemo(
    () => formatDuration(run.startedAt, run.endedAt),
    [nowTick, run.endedAt, run.startedAt]
  )
  const inspect = (): void => {
    // K1B+ always provides `onInspect`. Silent no-op fallback protects
    // against any future caller that mounts RunCard without wiring it
    // — a no-op button is a fixable bug, not a silent data issue.
    if (onInspect && run.runId) onInspect(run.runId)
  }

  /*
    1.0.5-EW64 — Satellite redesign. The previous two-row card
    (`.run-card-main` → `.run-card-title-row` + `.run-card-meta`)
    became a single inline strip:

      [Provider] [Status] [#run-id]  ·  [duration]  ·  [N files]  ·  [N approvals]                              [Inspect →]

    `.run-card-main` / `.run-card-title-row` / `.run-card-meta`
    wrappers all deleted. `.run-card-meta-inline` (new) groups
    the dot-separated meta segments so they stay clustered
    before the right-anchored Inspect button. All existing
    behaviour preserved: status tone, transcript-resumed
    warning, file + approval odometers, active polling,
    Inspect handler — only the visual shape changed.
  */
  return (
    <div className="run-card" data-provider={provider}>
      <span className={`run-card-provider provider-${providerDisplay.providerClass}`}>
        {providerDisplay.label}
      </span>
      <span className={`run-card-status tone-${status.tone}`}>{status.label}</span>
      {run.ensembleSleepResumeWarning && (
        // 1.0.5-N6 — Wakeup resumed from transcript context
        // only (no native provider session id available). The
        // tooltip carries the full explanation; the chip just
        // flags that the agent's working memory is
        // reconstructed.
        <span className="run-card-resume-warning" title={run.ensembleSleepResumeWarning}>
          transcript-resumed
        </span>
      )}
      <span className="run-card-id" title={run.runId}>
        #{shortRunId(run.runId)}
      </span>
      <span className="run-card-meta-inline">
        <span>{duration}</span>
        {fileCount !== null && (
          <span className="run-card-meta-count">
            <DigitOdometer value={fileCount} /> file{fileCount === 1 ? '' : 's'}
          </span>
        )}
        <span className="run-card-meta-count">
          <DigitOdometer value={aggregate.approvalCount} /> approval
          {aggregate.approvalCount === 1 ? '' : 's'}
        </span>
      </span>
      <button type="button" className="run-card-inspect" onClick={inspect} title="Inspect run">
        <span>Inspect</span>
        <span aria-hidden>→</span>
      </button>
      {run.runId && run.endedAt && onOpenSideChat && (
        <button
          type="button"
          className="run-card-inspect run-card-side-chat"
          onClick={() => onOpenSideChat(run.runId)}
          title="Open side chat from this run result"
          aria-label="Open side chat from this run result"
        >
          <span>Side chat</span>
        </button>
      )}
    </div>
  )
}

function buildRunAggregate(replay: RunEventReplay): RunAggregate {
  const files = new Set<string>()
  let editEventCount = 0
  let approvalCount = 0

  for (const event of replay.events || []) {
    const classified = classifyRunEvent(event)
    if (event.kind === 'approval_request') {
      approvalCount += 1
    } else if (classified.kind === 'file_edit') {
      editEventCount += 1
      for (const file of classified.files) files.add(file)
    }
  }

  return {
    approvalCount,
    eventFileCount: files.size > 0 ? files.size : editEventCount > 0 ? editEventCount : null
  }
}

function countRunDiffFiles(run: ChatRun): number | null {
  const diff = run.runDiff
  if (!diff) return null
  const files = [
    ...(diff.createdFiles || []),
    ...(diff.modifiedFiles || []),
    ...(diff.deletedFiles || [])
  ].filter((file) => file && !file.isNoise)
  return files.length
}

function getRunStatus(run: ChatRun): {
  label: string
  tone: 'success' | 'warning' | 'danger' | 'muted' | 'running'
} {
  if (run.cancelled || run.status === 'cancelled') return { label: 'Cancelled', tone: 'muted' }
  if (run.status === 'failed') return { label: 'Failed', tone: 'danger' }
  if (run.status === 'sleeping') return { label: 'Sleeping', tone: 'warning' }
  // In-flight runs render as the contrast-aware accent shimmer-sweep
  // "Active" badge (CSS handles the animation; tone-running is the hook).
  if (!run.endedAt) return { label: 'Active', tone: 'running' }
  if (run.status === 'success' || run.status === 'completed')
    return { label: 'Done', tone: 'success' }
  if (run.status === 'success_with_warnings') return { label: 'Warnings', tone: 'warning' }
  return { label: run.status || 'Complete', tone: 'muted' }
}

function formatDuration(startedAt?: string, endedAt?: string): string {
  const started = startedAt ? Date.parse(startedAt) : NaN
  if (!Number.isFinite(started)) return 'duration unknown'
  const ended = endedAt ? Date.parse(endedAt) : Date.now()
  const elapsedMs = Math.max(0, (Number.isFinite(ended) ? ended : Date.now()) - started)
  const seconds = Math.floor(elapsedMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function getRunProviderDisplay(
  run: ChatRun,
  provider: ProviderId
): { label: string; providerClass: string } {
  const model = run.actualModel || run.requestedModel || ''
  if (provider === 'ollama') {
    const modelLabel = humaniseModelId('ollama', model)
    const brand = resolveOllamaDisplayBrand(model, modelLabel)
    return {
      label: brand?.modelLabel || modelLabel || getProviderLabel(provider),
      providerClass: resolveProviderHueClass(provider, model, modelLabel)
    }
  }

  return {
    label: getProviderLabel(provider),
    providerClass: resolveProviderHueClass(provider, model)
  }
}

function shortRunId(runId: string): string {
  if (runId.length <= 8) return runId
  // 1.0.4 — TaskWraith's standard runId is
  // `<provider>-<Date.now()>-<base36-random>` from
  // `createFallbackRunId` in main/index.ts. The previous
  // `slice(0, 8)` produced confusing display collisions when two
  // same-provider participants dispatched in the same ensemble
  // round: both shared `<provider>-<first 2 digits of Date.now()>`
  // (e.g. every 2025-era Codex run displayed as `codex-17` because
  // Date.now() ≈ 17xxxxxxxxxxx). Switching to
  // `<provider>-<first 4 chars of random tail>` keeps the
  // discriminator visible — collision space goes from ~100
  // (2 timestamp digits) to ~1.6M (4 base36 chars).
  const parts = runId.split('-')
  if (parts.length >= 3) {
    const provider = parts[0]
    const tail = parts[parts.length - 1]
    if (provider && tail && tail.length >= 3) {
      return `${provider}-${tail.slice(0, 4)}`
    }
  }
  return runId.slice(0, 8)
}
