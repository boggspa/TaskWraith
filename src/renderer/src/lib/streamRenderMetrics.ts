import {
  createRunStreamRenderMetrics,
  type RunStreamRenderMetrics
} from '../../../shared/runStreamMetrics'

const renderMetricsByRunId = new Map<string, RunStreamRenderMetrics>()

function metricsForRun(runId: string): RunStreamRenderMetrics {
  const existing = renderMetricsByRunId.get(runId)
  if (existing) return existing
  const created = createRunStreamRenderMetrics()
  renderMetricsByRunId.set(runId, created)
  return created
}

function saneDurationMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function recordStreamMarkdownRenderMetric(
  runId: string | undefined,
  durationMs: number,
  chars: number
): void {
  if (!runId) return
  const metrics = metricsForRun(runId)
  const duration = saneDurationMs(durationMs)
  metrics.markdownParses += 1
  metrics.markdownParseMs += duration
  metrics.markdownParseChars += Math.max(0, chars)
  metrics.maxMarkdownParseMs = Math.max(metrics.maxMarkdownParseMs, duration)
}

export function recordStreamReactCommitMetric(
  runId: string | undefined,
  durationMs: number
): void {
  if (!runId) return
  const metrics = metricsForRun(runId)
  const duration = saneDurationMs(durationMs)
  metrics.reactCommits += 1
  metrics.reactCommitMs += duration
  metrics.maxReactCommitMs = Math.max(metrics.maxReactCommitMs, duration)
}

export function drainStreamRenderMetrics(runId: string): RunStreamRenderMetrics | undefined {
  const metrics = renderMetricsByRunId.get(runId)
  if (!metrics) return undefined
  renderMetricsByRunId.delete(runId)
  return { ...metrics }
}

export function resetStreamRenderMetricsForTest(): void {
  renderMetricsByRunId.clear()
}
