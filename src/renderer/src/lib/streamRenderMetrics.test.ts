import { describe, expect, it, beforeEach } from 'vitest'
import {
  drainStreamRenderMetrics,
  recordStreamMarkdownRenderMetric,
  recordStreamReactCommitMetric,
  resetStreamRenderMetricsForTest
} from './streamRenderMetrics'

describe('streamRenderMetrics', () => {
  beforeEach(() => resetStreamRenderMetricsForTest())

  it('records and drains markdown and react timing totals by run id', () => {
    recordStreamMarkdownRenderMetric('run-1', 2.5, 10)
    recordStreamMarkdownRenderMetric('run-1', 4, 20)
    recordStreamReactCommitMetric('run-1', 3)
    recordStreamReactCommitMetric('run-1', 7)

    expect(drainStreamRenderMetrics('run-1')).toEqual({
      markdownParses: 2,
      markdownParseMs: 6.5,
      markdownParseChars: 30,
      maxMarkdownParseMs: 4,
      reactCommits: 2,
      reactCommitMs: 10,
      maxReactCommitMs: 7
    })
    expect(drainStreamRenderMetrics('run-1')).toBeUndefined()
  })

  it('ignores missing run ids and clamps invalid durations', () => {
    recordStreamMarkdownRenderMetric(undefined, 5, 10)
    recordStreamMarkdownRenderMetric('run-1', Number.NaN, -10)
    recordStreamReactCommitMetric('run-1', -2)

    expect(drainStreamRenderMetrics('run-1')).toEqual({
      markdownParses: 1,
      markdownParseMs: 0,
      markdownParseChars: 0,
      maxMarkdownParseMs: 0,
      reactCommits: 1,
      reactCommitMs: 0,
      maxReactCommitMs: 0
    })
  })
})
