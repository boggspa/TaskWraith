import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { UsageRecord } from '../../../main/store/types'
import { DailyActivityHeatmap } from '../components/DailyActivityHeatmap'
import { TokenUsageChart } from '../components/TokenUsageChart'
import { UsageHeatmap } from '../components/UsageHeatmap'
import { WorkspaceActivityHeatmap } from '../components/WorkspaceActivityHeatmap'
import { buildWelcomeHeatmapSlots, EMPTY_WELCOME_HEATMAP_SLOTS } from './welcomeHeatmapSlots'

const RECORDS: UsageRecord[] = [
  {
    id: 'usage-1',
    timestamp: 1788500000000,
    workspaceId: 'workspace-1',
    chatId: 'chat-1',
    runId: 'run-1',
    model: 'test-model',
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    durationMs: 1000
  }
]

function elementOf(index: number, slots: { node: unknown }[]): ReactElement {
  return slots[index].node as ReactElement
}

function propsOf(node: ReactElement): Record<string, unknown> {
  return node.props as Record<string, unknown>
}

describe('buildWelcomeHeatmapSlots', () => {
  it('returns the shared empty array when nothing can render', () => {
    const slots = buildWelcomeHeatmapSlots({
      workspaceActivityPath: undefined,
      showUsageDashboard: false,
      taskwraithActivityEnabled: true,
      externalActivityEnabled: true,
      refreshKey: 1,
      usageRecords: RECORDS
    })

    expect(slots).toBe(EMPTY_WELCOME_HEATMAP_SLOTS)
  })

  it('treats an empty workspace path as absent for the early return', () => {
    const slots = buildWelcomeHeatmapSlots({
      workspaceActivityPath: '',
      showUsageDashboard: false,
      taskwraithActivityEnabled: false,
      externalActivityEnabled: false,
      refreshKey: 1,
      usageRecords: RECORDS
    })

    expect(slots).toBe(EMPTY_WELCOME_HEATMAP_SLOTS)
  })

  it('keeps one stable empty-array identity across calls', () => {
    const first = buildWelcomeHeatmapSlots({
      workspaceActivityPath: undefined,
      showUsageDashboard: false,
      taskwraithActivityEnabled: true,
      externalActivityEnabled: true,
      refreshKey: 1,
      usageRecords: RECORDS
    })
    const second = buildWelcomeHeatmapSlots({
      workspaceActivityPath: '',
      showUsageDashboard: false,
      taskwraithActivityEnabled: false,
      externalActivityEnabled: false,
      refreshKey: 2,
      usageRecords: []
    })

    expect(first).toBe(second)
    expect(first).toBe(EMPTY_WELCOME_HEATMAP_SLOTS)
  })

  it('emits slots in workspace, activity, tokens, year order when everything is on', () => {
    const slots = buildWelcomeHeatmapSlots({
      workspaceActivityPath: '/repo',
      showUsageDashboard: true,
      taskwraithActivityEnabled: true,
      externalActivityEnabled: true,
      refreshKey: 7,
      usageRecords: RECORDS
    })

    expect(slots.map((slot) => slot.key)).toEqual([
      'workspace',
      'taskwraith',
      'external',
      'taskwraith-tokens',
      'external-tokens',
      'external-year'
    ])
  })

  it('renders only the workspace slot when the dashboard is hidden', () => {
    const slots = buildWelcomeHeatmapSlots({
      workspaceActivityPath: '/repo',
      showUsageDashboard: false,
      taskwraithActivityEnabled: true,
      externalActivityEnabled: true,
      refreshKey: 3,
      usageRecords: RECORDS
    })

    expect(slots.map((slot) => slot.key)).toEqual(['workspace'])
    expect(slots).not.toBe(EMPTY_WELCOME_HEATMAP_SLOTS)
  })

  it('omits the taskwraith activity slot but keeps token slots when disabled', () => {
    const slots = buildWelcomeHeatmapSlots({
      workspaceActivityPath: undefined,
      showUsageDashboard: true,
      taskwraithActivityEnabled: false,
      externalActivityEnabled: true,
      refreshKey: 3,
      usageRecords: RECORDS
    })

    expect(slots.map((slot) => slot.key)).toEqual([
      'external',
      'taskwraith-tokens',
      'external-tokens',
      'external-year'
    ])
  })

  it('omits the external activity slot but keeps token and year slots when disabled', () => {
    const slots = buildWelcomeHeatmapSlots({
      workspaceActivityPath: undefined,
      showUsageDashboard: true,
      taskwraithActivityEnabled: true,
      externalActivityEnabled: false,
      refreshKey: 3,
      usageRecords: RECORDS
    })

    expect(slots.map((slot) => slot.key)).toEqual([
      'taskwraith',
      'taskwraith-tokens',
      'external-tokens',
      'external-year'
    ])
  })

  it('still returns token and year slots when both activity flags are off', () => {
    const slots = buildWelcomeHeatmapSlots({
      workspaceActivityPath: undefined,
      showUsageDashboard: true,
      taskwraithActivityEnabled: false,
      externalActivityEnabled: false,
      refreshKey: 3,
      usageRecords: RECORDS
    })

    expect(slots.map((slot) => slot.key)).toEqual([
      'taskwraith-tokens',
      'external-tokens',
      'external-year'
    ])
    expect(slots).not.toBe(EMPTY_WELCOME_HEATMAP_SLOTS)
  })

  it('builds the workspace node with the original component and props', () => {
    const slots = buildWelcomeHeatmapSlots({
      workspaceActivityPath: '/repo',
      showUsageDashboard: false,
      taskwraithActivityEnabled: false,
      externalActivityEnabled: false,
      refreshKey: 9,
      usageRecords: RECORDS
    })

    const node = elementOf(0, slots)
    expect(node.type).toBe(WorkspaceActivityHeatmap)
    expect(propsOf(node)).toMatchObject({
      workspacePath: '/repo',
      dayCount: 90,
      refreshKey: 9,
      className: 'usage-heatmap--welcome-standalone'
    })
  })

  it('builds activity nodes with titles, sources, and records by reference', () => {
    const slots = buildWelcomeHeatmapSlots({
      workspaceActivityPath: undefined,
      showUsageDashboard: true,
      taskwraithActivityEnabled: true,
      externalActivityEnabled: true,
      refreshKey: 11,
      usageRecords: RECORDS
    })

    const taskwraith = elementOf(0, slots)
    expect(taskwraith.type).toBe(UsageHeatmap)
    expect(propsOf(taskwraith)).toMatchObject({
      dayCount: 90,
      refreshKey: 11,
      title: 'TaskWraith Activity',
      showProviderFilter: true,
      className: 'usage-heatmap--welcome-standalone'
    })
    expect(propsOf(taskwraith).records).toBe(RECORDS)

    const external = elementOf(1, slots)
    expect(external.type).toBe(UsageHeatmap)
    expect(propsOf(external)).toMatchObject({
      dayCount: 90,
      refreshKey: 11,
      usageSource: 'external',
      title: 'External Activity',
      showProviderFilter: true,
      className: 'usage-heatmap--welcome-standalone'
    })
    expect(propsOf(external).supplementalTaskWraithRecords).toBe(RECORDS)
  })

  it('builds token nodes with titles, sources, and records by reference', () => {
    const slots = buildWelcomeHeatmapSlots({
      workspaceActivityPath: undefined,
      showUsageDashboard: true,
      taskwraithActivityEnabled: true,
      externalActivityEnabled: true,
      refreshKey: 13,
      usageRecords: RECORDS
    })

    const taskwraithTokens = elementOf(2, slots)
    expect(taskwraithTokens.type).toBe(TokenUsageChart)
    expect(propsOf(taskwraithTokens)).toMatchObject({
      title: 'TaskWraith Tokens',
      dayCount: 90,
      refreshKey: 13,
      showProviderFilter: true,
      className: 'token-usage-chart--welcome'
    })
    expect(propsOf(taskwraithTokens).records).toBe(RECORDS)
    expect('source' in propsOf(taskwraithTokens)).toBe(false)

    const externalTokens = elementOf(3, slots)
    expect(externalTokens.type).toBe(TokenUsageChart)
    expect(propsOf(externalTokens)).toMatchObject({
      title: 'External Tokens',
      source: 'external',
      dayCount: 90,
      refreshKey: 13,
      showProviderFilter: true,
      className: 'token-usage-chart--welcome'
    })
    expect(propsOf(externalTokens).supplementalTaskWraithRecords).toBe(RECORDS)
  })

  it('builds the year node with the original component and props', () => {
    const slots = buildWelcomeHeatmapSlots({
      workspaceActivityPath: undefined,
      showUsageDashboard: true,
      taskwraithActivityEnabled: true,
      externalActivityEnabled: true,
      refreshKey: 17,
      usageRecords: RECORDS
    })

    const year = elementOf(4, slots)
    expect(year.type).toBe(DailyActivityHeatmap)
    expect(propsOf(year)).toMatchObject({
      title: 'External Activity · Year',
      refreshKey: 17,
      showProviderFilter: true,
      className: 'daily-heatmap--welcome-standalone'
    })
    expect(propsOf(year).supplementalTaskWraithRecords).toBe(RECORDS)
  })
})
