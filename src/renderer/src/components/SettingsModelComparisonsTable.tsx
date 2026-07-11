import type { ModelUsageAggregate } from '../lib/usageAggregateTypes'
import { humaniseModelId } from '../lib/modelDisplayName'
import { resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { formatTokenCount } from '../lib/UsageHeatmap'
import './ModelUsageSettingsTable.css'

function tokenCell(value: number): string {
  return value > 0 ? `${formatTokenCount(value)} tok` : '—'
}

export function SettingsModelComparisonsTable({
  entries
}: {
  entries: readonly ModelUsageAggregate[]
}): React.JSX.Element | null {
  if (entries.length === 0) return null

  const sortedEntries = [...entries].sort(
    (a, b) => b.totalTokens - a.totalTokens || b.runs - a.runs
  )
  const tokenTotal = sortedEntries.reduce(
    (sum, entry) => sum + Math.max(0, entry.totalTokens || 0),
    0
  )

  return (
    <section
      className="model-usage-table-section settings-model-comparisons"
      aria-label="Model comparisons"
    >
      <div className="model-usage-table-header">
        <div className="model-usage-table-heading">
          <span className="model-usage-table-title">Model Comparisons</span>
          <span className="model-usage-table-subtitle">
            Input, output, and share of tracked tokens
          </span>
        </div>
        <span className="settings-model-comparison-window">Last 30 days</span>
      </div>

      <div className="model-usage-table-scroll settings-model-comparison-scroll">
        <table className="model-usage-table model-usage-table--comparisons">
          <colgroup>
            <col className="settings-model-comparison-model-col" />
            <col className="settings-model-comparison-token-col" />
            <col className="settings-model-comparison-token-col" />
            <col className="settings-model-comparison-share-col" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="model-usage-table-corner">
                Model
              </th>
              <th scope="col">Input</th>
              <th scope="col">Output</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((entry) => {
              const percent =
                tokenTotal > 0
                  ? Math.max(0, Math.min(100, (entry.totalTokens / tokenTotal) * 100))
                  : 0
              const displayName = humaniseModelId(entry.provider, entry.model)
              const colorClass = `provider-${resolveProviderHueClass(entry.provider, entry.model)}`
              return (
                <tr key={`${entry.provider}-${entry.model}`}>
                  <th scope="row" className="settings-model-comparison-model" title={entry.model}>
                    <span className={`settings-model-comparison-dot ${colorClass}`} aria-hidden />
                    <span className="settings-model-comparison-name">{displayName}</span>
                  </th>
                  <td className="settings-model-comparison-tokens">
                    {tokenCell(entry.inputTokens)}
                  </td>
                  <td className="settings-model-comparison-tokens">
                    {tokenCell(entry.outputTokens)}
                  </td>
                  <td className="settings-model-comparison-share">
                    <span className="settings-model-comparison-share-inner">
                      <span
                        className="settings-model-comparison-track"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent}
                        aria-label={`${displayName} accounts for ${percent.toFixed(1)}% of model usage in the last 30 days`}
                      >
                        <span
                          className={`settings-model-comparison-fill ${colorClass}`}
                          style={{ width: `${Math.max(2, percent)}%` }}
                        />
                      </span>
                      <strong className="settings-model-comparison-percent">
                        {percent.toFixed(1)}%
                      </strong>
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
