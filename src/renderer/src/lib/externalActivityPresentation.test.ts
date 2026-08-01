import { describe, expect, it } from 'vitest'
import type { UsageRecord } from '../../../main/store/types'
import { buildExternalActivityPresentationRecords } from './externalActivityPresentation'
import { buildHeatmapGrid } from './UsageHeatmap'
import { buildTokenUsageChartData } from '../components/TokenUsageChart'

const record = (overrides: Partial<UsageRecord>): UsageRecord =>
  ({
    id: 'usage-1',
    provider: 'codex',
    timestamp: new Date(2026, 7, 1, 12).getTime(),
    workspaceId: 'workspace-1',
    chatId: 'chat-1',
    runId: 'run-1',
    model: 'model-1',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    ...overrides
  }) as UsageRecord

describe('buildExternalActivityPresentationRecords', () => {
  it('supplements the four no-scanner providers without duplicating scanned-provider runs', () => {
    const now = new Date(2026, 7, 1, 12)
    const externalRecords = [record({ id: 'external-codex', totalTokens: 100 })]
    const taskwraithRecords = [
      record({ id: 'internal-codex', totalTokens: 200 }),
      record({ id: 'ollama', provider: 'ollama', totalTokens: 10 }),
      record({ id: 'ollama-marker', provider: 'ollama' }),
      record({ id: 'antigravity', provider: 'antigravity', totalTokens: 20 }),
      record({ id: 'pi', provider: 'pi', totalTokens: 30 }),
      record({ id: 'mistral', provider: 'mistral', totalTokens: 40 })
    ]

    const records = buildExternalActivityPresentationRecords(externalRecords, taskwraithRecords)

    expect(records.map((entry) => entry.id)).toEqual([
      'external-codex',
      'ollama',
      'ollama-marker',
      'antigravity',
      'pi',
      'mistral'
    ])
    const heatmap = buildHeatmapGrid(records, now, 1)
    expect(heatmap.totals.window).toBe(200)
    expect(heatmap.cells.some((cell) => cell.totalTokens === 200 && cell.eventCount === 6)).toBe(
      true
    )
    expect(buildTokenUsageChartData(records, now, 1).totalTokens).toBe(200)
  })
})
