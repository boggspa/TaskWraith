import { describe, expect, it } from 'vitest'

import {
  projectThreadCatalogueRunSummary,
  threadCatalogueRunOrder
} from './ThreadCatalogueRunSummary'

describe('projectThreadCatalogueRunSummary', () => {
  it('copies the bounded run fields and counts distinct diff paths', () => {
    expect(
      projectThreadCatalogueRunSummary({
        runId: 'run-1',
        provider: 'codex',
        status: 'success',
        toolActivities: [{ id: 'tool' }],
        hostRunOrigin: { kind: 'host-node' },
        runDiff: {
          createdFiles: [{ path: ' a ' }, { path: 'a' }, { path: '  ' }],
          modifiedFiles: [{ path: 'b' }],
          deletedFiles: 'not a list',
          preExistingFiles: [{ path: 'c' }, { nope: 1 }]
        },
        runDiffByPath: { x: [{ path: 'd' }, { path: 'b' }], y: 'not a list' }
      } as never)
    ).toEqual({ runId: 'run-1', provider: 'codex', status: 'success', diffFileCount: 4 })
  })

  it('keeps positive Ollama memory samples, and none for other providers', () => {
    const stats = {
      ollamaMemoryPeakRssGb: 1.5,
      ollamaMemoryRssGb: 0,
      ollamaMemorySampleCount: '3',
      hardware: { ram: { peakRssGb: 2, rssGb: -1, sampleCount: 'x' } }
    }
    expect(
      projectThreadCatalogueRunSummary({ runId: 'o', provider: 'ollama', stats } as never)
    ).toEqual({
      runId: 'o',
      provider: 'ollama',
      diffFileCount: 0,
      stats: {
        ollamaMemoryPeakRssGb: 1.5,
        ollamaMemorySampleCount: 3,
        hardware: { ram: { peakRssGb: 2 } }
      }
    })
    expect(
      projectThreadCatalogueRunSummary({ runId: 'c', provider: 'codex', stats } as never)
    ).toEqual({
      runId: 'c',
      provider: 'codex',
      diffFileCount: 0
    })
  })
})

describe('threadCatalogueRunOrder', () => {
  it('orders only objects with a string run id', () => {
    expect(threadCatalogueRunOrder({ status: 'running' })).toBeUndefined()
    expect(threadCatalogueRunOrder({ runId: 7, status: 'running' })).toBeUndefined()
  })

  it.each([
    [
      'a live run by its start',
      { status: 'running', startedAt: '2026-01-01T00:00:01.000Z' },
      true,
      1_767_225_601_000
    ],
    [
      'a terminal status in any case',
      { status: 'ERROR', startedAt: '2026-01-01T00:00:01.000Z' },
      false,
      1_767_225_601_000
    ],
    [
      'an end that parses',
      {
        status: 'weird',
        startedAt: '2026-01-01T00:00:01.000Z',
        endedAt: '2026-01-01T00:00:02.000Z'
      },
      false,
      1_767_225_602_000
    ],
    ['an end before the epoch', { endedAt: '1969-12-31T23:59:59.000Z' }, false, -1_000],
    ['no time that parses', { status: 'queued', startedAt: 'soon', endedAt: '' }, true, 0]
  ])('ranks %s', (_label, run, catalogueActive, catalogueRecency) => {
    expect(threadCatalogueRunOrder({ runId: 'r', ...run })).toEqual({
      catalogueActive,
      catalogueRecency
    })
  })
})
