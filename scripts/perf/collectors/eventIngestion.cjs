'use strict'

/**
 * ACK / input / React commit / long-task event ingestion.
 * Pure reducer over a JSON event stream — no Electron attach.
 */

const KNOWN_KINDS = Object.freeze([
  'ipc_ack',
  'input_to_paint',
  'react_commit',
  'long_task',
  'event_loop_lag'
])

/**
 * @param {object[]} events
 */
function ingestPerfUiEvents(events) {
  if (!Array.isArray(events)) throw new Error('events must be an array')

  const ackLagMs = []
  const inputToPaintMs = []
  const reactCommitMs = []
  /** @type {object[]} */
  const longTasks = []
  const eventLoopLagMs = []
  let rejectCount = 0
  let unknownCount = 0

  for (const e of events) {
    if (!e || typeof e !== 'object') {
      unknownCount++
      continue
    }
    switch (e.kind) {
      case 'ipc_ack': {
        if (typeof e.lagMs === 'number' && Number.isFinite(e.lagMs)) ackLagMs.push(e.lagMs)
        if (e.rejected === true) rejectCount++
        break
      }
      case 'input_to_paint': {
        if (typeof e.durationMs === 'number' && Number.isFinite(e.durationMs)) {
          inputToPaintMs.push(e.durationMs)
        }
        break
      }
      case 'react_commit': {
        if (typeof e.durationMs === 'number' && Number.isFinite(e.durationMs)) {
          reactCommitMs.push(e.durationMs)
        }
        break
      }
      case 'long_task': {
        longTasks.push({
          durationMs: typeof e.durationMs === 'number' ? e.durationMs : 0,
          name: typeof e.name === 'string' ? e.name : 'unknown',
          startTime: typeof e.startTime === 'number' ? e.startTime : 0
        })
        break
      }
      case 'event_loop_lag': {
        if (typeof e.lagMs === 'number' && Number.isFinite(e.lagMs)) {
          eventLoopLagMs.push(e.lagMs)
        }
        break
      }
      default:
        unknownCount++
    }
  }

  return {
    ackLagMs,
    inputToPaintMs,
    reactCommitMs,
    longTasks,
    eventLoopLagMs,
    rejectCount,
    unknownCount,
    knownKinds: KNOWN_KINDS.slice()
  }
}

/**
 * @param {number[]} values
 * @param {number} p
 */
function percentile(values, p) {
  if (!values.length) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

/**
 * @param {ReturnType<typeof ingestPerfUiEvents>} ingested
 */
function summarizeIngestedUiEvents(ingested) {
  return {
    ipc: {
      ackLagMs: {
        p50: percentile(ingested.ackLagMs, 50),
        p95: percentile(ingested.ackLagMs, 95)
      },
      rejectCount: ingested.rejectCount
    },
    renderer: {
      reactCommitMs: { p95: percentile(ingested.reactCommitMs, 95) },
      inputToPaintMs: { p95: percentile(ingested.inputToPaintMs, 95) },
      longTasks: ingested.longTasks.slice()
    },
    main: {
      eventLoopLagMs: {
        p50: percentile(ingested.eventLoopLagMs, 50),
        p95: percentile(ingested.eventLoopLagMs, 95),
        p99: percentile(ingested.eventLoopLagMs, 99),
        max: ingested.eventLoopLagMs.length ? Math.max(...ingested.eventLoopLagMs) : 0
      }
    }
  }
}

module.exports = {
  KNOWN_KINDS,
  ingestPerfUiEvents,
  summarizeIngestedUiEvents,
  percentile
}
