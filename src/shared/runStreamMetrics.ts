import type { RunItemEvent } from './runItemEvents'

export interface RunStreamMetrics {
  runId: string
  startedAtMs: number
  updatedAtMs: number
  itemEvents: number
  itemDeltas: number
  itemDeltaChars: number
  toolOutputDeltas: number
  toolOutputChars: number
  flushes: number
  flushedChars: number
  maxCharsPerFlush: number
  itemFlushes: number
  maxCharsPerItemFlush: number
  markdownParses: number
  markdownParseMs: number
  markdownParseChars: number
  maxMarkdownParseMs: number
  reactCommits: number
  reactCommitMs: number
  maxReactCommitMs: number
  sequenceGaps: number
  duplicateSequences: number
  maxSequenceGap: number
  lastSequence: number
}

export interface RunStreamMetricRates {
  eventsPerSecond: number
  deltasPerSecond: number
  charsPerSecond: number
  flushesPerSecond: number
  averageCharsPerFlush: number
  averageItemsPerFlush: number
  averageCharsPerItemFlush: number
  averageMarkdownParseMs: number
  averageReactCommitMs: number
}

export interface RunStreamRenderMetrics {
  markdownParses: number
  markdownParseMs: number
  markdownParseChars: number
  maxMarkdownParseMs: number
  reactCommits: number
  reactCommitMs: number
  maxReactCommitMs: number
}

export function createRunStreamMetrics(runId: string, nowMs: number): RunStreamMetrics {
  return {
    runId,
    startedAtMs: nowMs,
    updatedAtMs: nowMs,
    itemEvents: 0,
    itemDeltas: 0,
    itemDeltaChars: 0,
    toolOutputDeltas: 0,
    toolOutputChars: 0,
    flushes: 0,
    flushedChars: 0,
    maxCharsPerFlush: 0,
    itemFlushes: 0,
    maxCharsPerItemFlush: 0,
    markdownParses: 0,
    markdownParseMs: 0,
    markdownParseChars: 0,
    maxMarkdownParseMs: 0,
    reactCommits: 0,
    reactCommitMs: 0,
    maxReactCommitMs: 0,
    sequenceGaps: 0,
    duplicateSequences: 0,
    maxSequenceGap: 0,
    lastSequence: 0
  }
}

export function createRunStreamRenderMetrics(): RunStreamRenderMetrics {
  return {
    markdownParses: 0,
    markdownParseMs: 0,
    markdownParseChars: 0,
    maxMarkdownParseMs: 0,
    reactCommits: 0,
    reactCommitMs: 0,
    maxReactCommitMs: 0
  }
}

export function recordRunItemMetric(
  metrics: RunStreamMetrics | undefined,
  event: RunItemEvent,
  nowMs: number
): RunStreamMetrics {
  const next = metrics ? { ...metrics } : createRunStreamMetrics(event.runId, nowMs)
  next.updatedAtMs = nowMs
  next.itemEvents += 1
  if (event.sequence <= next.lastSequence) {
    next.duplicateSequences += 1
  } else {
    const gap = event.sequence - next.lastSequence
    if (next.lastSequence > 0 && gap > 1) {
      next.sequenceGaps += 1
      next.maxSequenceGap = Math.max(next.maxSequenceGap, gap)
    }
    next.lastSequence = event.sequence
  }
  if (event.kind === 'item/delta') {
    next.itemDeltas += 1
    next.itemDeltaChars += event.delta.length
  } else if (event.kind === 'tool/outputDelta') {
    next.toolOutputDeltas += 1
    next.toolOutputChars += event.delta.length
  }
  return next
}

export function recordRunFlushMetric(
  metrics: RunStreamMetrics | undefined,
  runId: string,
  chars: number,
  nowMs: number,
  itemChars: readonly number[] = []
): RunStreamMetrics {
  const next = metrics ? { ...metrics } : createRunStreamMetrics(runId, nowMs)
  next.updatedAtMs = nowMs
  const positiveItemChars = itemChars
    .map((count) => Math.max(0, count))
    .filter((count) => count > 0)
  next.flushes += 1
  next.flushedChars += Math.max(0, chars)
  next.maxCharsPerFlush = Math.max(next.maxCharsPerFlush, Math.max(0, chars))
  next.itemFlushes += positiveItemChars.length
  for (const itemCharCount of positiveItemChars) {
    next.maxCharsPerItemFlush = Math.max(next.maxCharsPerItemFlush, itemCharCount)
  }
  return next
}

export function mergeRunStreamRenderMetrics(
  metrics: RunStreamMetrics | undefined,
  runId: string,
  renderMetrics: RunStreamRenderMetrics,
  nowMs: number
): RunStreamMetrics {
  const next = metrics ? { ...metrics } : createRunStreamMetrics(runId, nowMs)
  next.updatedAtMs = nowMs
  next.markdownParses += renderMetrics.markdownParses
  next.markdownParseMs += renderMetrics.markdownParseMs
  next.markdownParseChars += renderMetrics.markdownParseChars
  next.maxMarkdownParseMs = Math.max(next.maxMarkdownParseMs, renderMetrics.maxMarkdownParseMs)
  next.reactCommits += renderMetrics.reactCommits
  next.reactCommitMs += renderMetrics.reactCommitMs
  next.maxReactCommitMs = Math.max(next.maxReactCommitMs, renderMetrics.maxReactCommitMs)
  return next
}

export function runStreamMetricRates(metrics: RunStreamMetrics): RunStreamMetricRates {
  const elapsedSeconds = Math.max(0.001, (metrics.updatedAtMs - metrics.startedAtMs) / 1000)
  return {
    eventsPerSecond: metrics.itemEvents / elapsedSeconds,
    deltasPerSecond: metrics.itemDeltas / elapsedSeconds,
    charsPerSecond: metrics.itemDeltaChars / elapsedSeconds,
    flushesPerSecond: metrics.flushes / elapsedSeconds,
    averageCharsPerFlush: metrics.flushes > 0 ? metrics.flushedChars / metrics.flushes : 0,
    averageItemsPerFlush: metrics.flushes > 0 ? metrics.itemFlushes / metrics.flushes : 0,
    averageCharsPerItemFlush:
      metrics.itemFlushes > 0 ? metrics.flushedChars / metrics.itemFlushes : 0,
    averageMarkdownParseMs:
      metrics.markdownParses > 0 ? metrics.markdownParseMs / metrics.markdownParses : 0,
    averageReactCommitMs:
      metrics.reactCommits > 0 ? metrics.reactCommitMs / metrics.reactCommits : 0
  }
}
