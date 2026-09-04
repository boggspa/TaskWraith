// Welcome-heatmap slot builder extracted from `src/renderer/src/App.tsx` (Wave 5).
// Pure module-level helper with no React state/hook dependencies.
// Behaviour-preserving move: bodies are byte-identical to the App.tsx originals,
// with `export` added. Type-only imports from `src/main/store/types` keep this
// module free of renderer -> main runtime edges (architecture-guard safe).
// App.tsx reimports from here.
import { DailyActivityHeatmap } from '../components/DailyActivityHeatmap'
import { TokenUsageChart } from '../components/TokenUsageChart'
import { UsageHeatmap } from '../components/UsageHeatmap'
import { WorkspaceActivityHeatmap } from '../components/WorkspaceActivityHeatmap'
import type { WelcomeHeatmapSlot } from '../components/WelcomeHeatmaps'
import type { UsageRecord } from '../../../main/store/types'

export const EMPTY_WELCOME_HEATMAP_SLOTS: WelcomeHeatmapSlot[] = []

export interface WelcomeHeatmapSlotsConfig {
  workspaceActivityPath?: string
  showUsageDashboard: boolean
  taskwraithActivityEnabled: boolean
  externalActivityEnabled: boolean
  refreshKey: number
  usageRecords: UsageRecord[]
}

export function buildWelcomeHeatmapSlots({
  workspaceActivityPath,
  showUsageDashboard,
  taskwraithActivityEnabled,
  externalActivityEnabled,
  refreshKey,
  usageRecords
}: WelcomeHeatmapSlotsConfig): WelcomeHeatmapSlot[] {
  if (!workspaceActivityPath && !showUsageDashboard) return EMPTY_WELCOME_HEATMAP_SLOTS

  const slots: WelcomeHeatmapSlot[] = []
  if (workspaceActivityPath) {
    slots.push({
      key: 'workspace',
      node: (
        <WorkspaceActivityHeatmap
          workspacePath={workspaceActivityPath}
          dayCount={90}
          refreshKey={refreshKey}
          className="usage-heatmap--welcome-standalone"
        />
      )
    })
  }
  if (showUsageDashboard && taskwraithActivityEnabled) {
    slots.push({
      key: 'taskwraith',
      node: (
        <UsageHeatmap
          dayCount={90}
          refreshKey={refreshKey}
          records={usageRecords}
          title="TaskWraith Activity"
          showProviderFilter
          className="usage-heatmap--welcome-standalone"
        />
      )
    })
  }
  if (showUsageDashboard && externalActivityEnabled) {
    slots.push({
      key: 'external',
      node: (
        <UsageHeatmap
          dayCount={90}
          refreshKey={refreshKey}
          usageSource="external"
          supplementalTaskWraithRecords={usageRecords}
          title="External Activity"
          showProviderFilter
          className="usage-heatmap--welcome-standalone"
        />
      )
    })
  }
  if (showUsageDashboard) {
    slots.push({
      key: 'taskwraith-tokens',
      node: (
        <TokenUsageChart
          title="TaskWraith Tokens"
          records={usageRecords}
          dayCount={90}
          refreshKey={refreshKey}
          showProviderFilter
          className="token-usage-chart--welcome"
        />
      )
    })
    slots.push({
      key: 'external-tokens',
      node: (
        <TokenUsageChart
          title="External Tokens"
          source="external"
          supplementalTaskWraithRecords={usageRecords}
          dayCount={90}
          refreshKey={refreshKey}
          showProviderFilter
          className="token-usage-chart--welcome"
        />
      )
    })
    // The only slot in the cycle that reaches past 90 days: it reads the
    // persisted daily rollup rather than the scan window, one cell per day.
    slots.push({
      key: 'external-year',
      node: (
        <DailyActivityHeatmap
          title="External Activity · Year"
          supplementalTaskWraithRecords={usageRecords}
          refreshKey={refreshKey}
          showProviderFilter
          className="daily-heatmap--welcome-standalone"
        />
      )
    })
  }
  return slots.length > 0 ? slots : EMPTY_WELCOME_HEATMAP_SLOTS
}
