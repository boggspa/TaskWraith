/**
 * ModelUsageSettingsTable — the comprehensive per-provider, per-MODEL
 * usage/cost table for Settings → Model usage.
 *
 * Where the sidebar Model Usage card (ModelUsageCard / ApiSpendView) rolls up
 * Day / 7d / 30d per provider, this table breaks each provider down PER MODEL
 * and shows FIVE rolling windows — 1H / 24H / 7D / 30D / 90D — with token +
 * estimated-cost columns. It is the takeover-tab companion to that card.
 *
 * Data: SELF-FETCHED over the existing IPC (same pattern as ApiSpendView /
 * UsageHeatmap) — no new IPC, no prop drilling of records:
 *   - `window.api.getUsage()`          → TaskWraith's own runs
 *   - `window.api.getExternalUsage()`  → externally-tracked provider activity
 *                                        (the 90-day dataset behind the
 *                                        External Activity heatmap)
 *   - `window.api.getProviderRates()`  → per-model USD rate table
 * It refetches on the `usage-changed` event the app already broadcasts, via a
 * tiny leak-free subscription shim (see `subscribeUsageChanged`) so multiple
 * mounts share ONE underlying listener and never clobber App's own handler.
 *
 * The "External Usage" toggle drives `includeExternal`: ON merges the external
 * dataset in so the user sees provider-WIDE usage; OFF shows only TaskWraith's
 * runs. The chosen value is seeded from `externalUsageDefault` (a persisted
 * pref threaded from SettingsPanel) and kept in local state so a click is
 * instant.
 *
 * **Honesty (non-negotiable):** records carry token counts only — never a
 * billed amount. Every cost here is a rate-table PROJECTION, so it is badged:
 * a `~` prefix on every figure, an "estimated, not billed" column note, and a
 * footnote. We never render a bare currency string that implies money spent
 * (mirrors the just-fixed ApiSpendView footnote).
 *
 * Testing: SSR via `renderToStaticMarkup` (this repo has no jsdom, so effects
 * don't fire). The data math lives in the pure `buildModelUsageTable`
 * aggregator (unit-tested separately); this file tests structure + empty
 * state, and exposes the pure {@link ModelUsageProviderTableBlock} so a
 * populated render can be SSR-tested by feeding aggregator output directly.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import type { UsageRecord, ChatListItem } from '../../../main/store/types'
import {
  MODEL_USAGE_WINDOW_LABEL,
  MODEL_USAGE_WINDOW_ORDER,
  buildModelUsageTableForSettings,
  buildModelUsageWorkspaceMatrix,
  sumModelUsageProviderTotals,
  type ModelUsageProviderGroup,
  type ModelUsageWorkspaceCell,
  type ModelUsageWorkspaceMatrix,
  type ModelUsageWindowKey,
  type ModelUsageWindowTotals
} from '../lib/modelUsageTable'
import { fetchProviderRates, type RendererProviderRates } from '../lib/providerRateEstimate'
import { loadRendererUsageRecords } from '../lib/usageRecordsCache'
import type { DisplayCurrency } from '../lib/formatCost'
import {
  buildProviderApiRateGroups,
  type ProviderApiRateGroup,
  type ProviderApiRateRow
} from '../lib/providerApiRatesTable'
import { humaniseModelIdCompact, humaniseModelIdTableCell } from '../lib/modelDisplayName'
import { formatTokenCount } from '../lib/UsageHeatmap'
import {
  buildOllamaMemoryModelTable,
  formatOllamaMemoryAvgCell,
  formatOllamaSampleAvgCell,
  mergeOllamaMemoryUsageRecords,
  type OllamaMemoryProviderGroup,
  type OllamaMemoryWindowTotals
} from '../lib/ollamaMemoryAggregation'
import { getProviderName } from './Sidebar'
import { ProviderLogoTile } from './ProviderLogoTile'
import { buildModelContextLengthGroups } from '../lib/modelContextLengths'
import './ModelUsageSettingsTable.css'

export interface ModelUsageSettingsTableProps {
  /** Display currency for the cost columns. */
  currency?: DisplayCurrency
  /** Conservative-overestimate bias percent (0–25). */
  overestimatePercent?: number
  /** Optional locale override for `Intl.NumberFormat`. */
  locale?: string
  /**
   * Initial value of the "External Usage" toggle. When provided it takes
   * precedence (handy for tests / explicit control). When OMITTED the
   * component self-hydrates the persisted `modelUsageExternalUsage` setting
   * over `window.api.getSettings()` on mount, defaulting to OFF
   * (TaskWraith-only) until that resolves.
   */
  externalUsageDefault?: boolean
  /**
   * Persist a new toggle value. When provided, the component defers entirely
   * to it. When OMITTED the component self-persists via
   * `window.api.updateSettings({ modelUsageExternalUsage })` so the choice
   * survives reload without any prop threading. Either way the flip is
   * reflected locally first so it feels instant.
   */
  onExternalUsageChange?: (next: boolean) => void
}

// ── usage-changed subscription shim ─────────────────────────────────────────
// `window.api.onUsageChanged` registers an ipc listener but returns no
// unsubscribe, and the renderer's global teardown calls
// `removeAllListeners('usage-changed')`. So we must NOT register a fresh raw
// listener per mount (that would leak across the takeover's mount/unmount
// cycles AND risk being wiped alongside App's listener). Instead we keep ONE
// process-lifetime underlying listener and fan it out to a Set of local
// subscribers; mounting adds a callback, unmounting removes it. App's own
// listener is untouched.
const usageChangedSubscribers = new Set<() => void>()
let usageChangedWired = false

function subscribeUsageChanged(callback: () => void): () => void {
  usageChangedSubscribers.add(callback)
  if (
    !usageChangedWired &&
    typeof window !== 'undefined' &&
    typeof window.api?.onUsageChanged === 'function'
  ) {
    usageChangedWired = true
    window.api.onUsageChanged(() => {
      for (const sub of usageChangedSubscribers) {
        try {
          sub()
        } catch {
          // A misbehaving subscriber must not break the others.
        }
      }
    })
  }
  return () => {
    usageChangedSubscribers.delete(callback)
  }
}

/** Format a single window's cost cell. Honesty: badge with `~` and fall back
 * to a neutral dash when the projection rounds to nothing. */
function costCell(totals: ModelUsageWindowTotals): string {
  return totals.costDisplay ? `~${totals.costDisplay}` : '—'
}

/** Format a single window's token cell. */
function tokenCell(totals: ModelUsageWindowTotals): string {
  return totals.totalTokens > 0 ? `${formatTokenCount(totals.totalTokens)} tok` : '—'
}

function workspaceMatrixCostCell(cell: ModelUsageWorkspaceCell): string {
  return cell.costDisplay ? `~${cell.costDisplay}` : '—'
}

function workspaceMatrixCellTitle(cell: ModelUsageWorkspaceCell): string {
  return [
    `${cell.changedFiles.toLocaleString()} changed file${cell.changedFiles === 1 ? '' : 's'}`,
    `${cell.totalTokens.toLocaleString()} tokens`,
    `${cell.runs.toLocaleString()} run${cell.runs === 1 ? '' : 's'}`,
    cell.costDisplay ? `~${cell.costDisplay} projected API-equivalent` : 'no cost estimate'
  ].join(' · ')
}

function rateCell(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 4
  })}`
}

function statusLabel(row: ProviderApiRateRow): string {
  if (row.status === 'manual-override') return 'override'
  if (row.status === 'verified') return 'verified'
  if (row.status === 'not-verified') return 'review'
  return 'source'
}

function rateSourceTitle(row: ProviderApiRateRow, group: ProviderApiRateGroup): string {
  const parts = [
    `Rate table ${group.rateTableVersion || 'unknown version'}`,
    `Last verified ${row.lastVerified || 'unknown'}`,
    `Source ${row.sourceUrl || group.pricingUrl || 'not recorded'}`
  ]
  if (row.notes) parts.push(row.notes)
  if (row.statusMessage) parts.push(row.statusMessage)
  return parts.join(' · ')
}

/** One token+cost pair of cells for a given window. */
function WindowCells({
  windowKey,
  totals
}: {
  windowKey: ModelUsageWindowKey
  totals: ModelUsageWindowTotals
}) {
  return (
    <>
      <td
        className="model-usage-table-tokens"
        title={`${totals.totalTokens.toLocaleString()} tokens · ${totals.runs.toLocaleString()} run${
          totals.runs === 1 ? '' : 's'
        } (${MODEL_USAGE_WINDOW_LABEL[windowKey]})`}
      >
        {tokenCell(totals)}
      </td>
      <td
        className="model-usage-table-cost"
        title={
          totals.costDisplay
            ? `~${totals.costDisplay} · projected API-equivalent — estimated, not billed (${MODEL_USAGE_WINDOW_LABEL[windowKey]})`
            : undefined
        }
      >
        {costCell(totals)}
      </td>
    </>
  )
}

/**
 * One provider's block of rows: a provider summary row (bold, all models
 * summed) followed by one row per model. Pure given its `group` — exported so
 * a populated render can be SSR-tested by feeding aggregator output directly.
 */
export function ModelUsageProviderTableBlock({ group }: { group: ModelUsageProviderGroup }) {
  return (
    <tbody className={`model-usage-table-provider provider-${group.provider}`}>
      <tr className="model-usage-table-provider-row">
        <th scope="rowgroup" className="model-usage-table-provider-cell">
          <span className={`model-usage-table-provider-label provider-${group.provider}`}>
            <ProviderLogoTile provider={group.provider} />
            <span className="model-usage-table-provider-name">
              {getProviderName(group.provider)}
            </span>
            <span
              className="model-usage-table-model-count"
              title={`${group.models.length} model${group.models.length === 1 ? '' : 's'}`}
            >
              {group.models.length}
            </span>
          </span>
        </th>
        {MODEL_USAGE_WINDOW_ORDER.map((windowKey) => (
          <WindowCells key={windowKey} windowKey={windowKey} totals={group.totals[windowKey]} />
        ))}
      </tr>
      {group.models.map((model) => (
        <tr key={`${group.provider}-${model.model}`} className="model-usage-table-model-row">
          <td
            className="model-usage-table-model-cell"
            title={humaniseModelIdCompact(group.provider, model.model)}
          >
            {humaniseModelIdTableCell(group.provider, model.model)}
          </td>
          {MODEL_USAGE_WINDOW_ORDER.map((windowKey) => (
            <WindowCells key={windowKey} windowKey={windowKey} totals={model.windows[windowKey]} />
          ))}
        </tr>
      ))}
    </tbody>
  )
}

/** Ollama block — periodic-sample / RAM columns instead of tokens/cost. */
export function ModelUsageOllamaTableBlock({ group }: { group: OllamaMemoryProviderGroup }) {
  const MemoryCells = ({
    windowKey,
    totals
  }: {
    windowKey: ModelUsageWindowKey
    totals: OllamaMemoryWindowTotals
  }) => (
    <>
      <td
        className="model-usage-table-samples"
        title={
          totals.runs > 0
            ? `Average periodic memory samples per run (${MODEL_USAGE_WINDOW_LABEL[windowKey]})`
            : undefined
        }
      >
        {formatOllamaSampleAvgCell(totals.avgSampleCount, totals.runs, true)}
      </td>
      <td
        className="model-usage-table-memory"
        title={
          totals.avgPeakRssGb > 0
            ? `Average per-run peak llama-server RSS (${MODEL_USAGE_WINDOW_LABEL[windowKey]})`
            : undefined
        }
      >
        {formatOllamaMemoryAvgCell(totals.avgPeakRssGb, true)}
      </td>
    </>
  )

  return (
    <tbody className="model-usage-table-provider provider-ollama model-usage-table-provider--memory">
      <tr className="model-usage-table-provider-row">
        <th scope="rowgroup" className="model-usage-table-provider-cell">
          <span className="model-usage-table-provider-label provider-ollama">
            <ProviderLogoTile provider="ollama" />
            <span className="model-usage-table-provider-name">{getProviderName('ollama')}</span>
            <span
              className="model-usage-table-model-count"
              title={`${group.models.length} model${group.models.length === 1 ? '' : 's'}`}
            >
              {group.models.length}
            </span>
          </span>
        </th>
        {MODEL_USAGE_WINDOW_ORDER.map((windowKey) => (
          <MemoryCells key={windowKey} windowKey={windowKey} totals={group.totals[windowKey]} />
        ))}
      </tr>
      {group.models.map((model) => (
        <tr key={`ollama-${model.model}`} className="model-usage-table-model-row">
          <td
            className="model-usage-table-model-cell"
            title={humaniseModelIdCompact('ollama', model.model)}
          >
            {humaniseModelIdTableCell('ollama', model.model)}
          </td>
          {MODEL_USAGE_WINDOW_ORDER.map((windowKey) => (
            <MemoryCells key={windowKey} windowKey={windowKey} totals={model.windows[windowKey]} />
          ))}
        </tr>
      ))}
    </tbody>
  )
}

/** Footer totals — API token/cost roll-up + Ollama RAM roll-up. */
export function ModelUsageTableTotalsFooter({
  tokenTotals,
  ollamaTotals
}: {
  tokenTotals: Record<ModelUsageWindowKey, ModelUsageWindowTotals> | null
  ollamaTotals: Record<ModelUsageWindowKey, OllamaMemoryWindowTotals> | null
}) {
  if (!tokenTotals && !ollamaTotals) return null

  const OllamaCells = ({
    windowKey,
    totals
  }: {
    windowKey: ModelUsageWindowKey
    totals: OllamaMemoryWindowTotals
  }) => (
    <>
      <td
        className="model-usage-table-samples"
        title={
          totals.runs > 0
            ? `Average periodic memory samples per run (${MODEL_USAGE_WINDOW_LABEL[windowKey]})`
            : undefined
        }
      >
        {formatOllamaSampleAvgCell(totals.avgSampleCount, totals.runs, true)}
      </td>
      <td
        className="model-usage-table-memory"
        title={
          totals.avgPeakRssGb > 0
            ? `Average per-run peak llama-server RSS (${MODEL_USAGE_WINDOW_LABEL[windowKey]})`
            : undefined
        }
      >
        {formatOllamaMemoryAvgCell(totals.avgPeakRssGb, true)}
      </td>
    </>
  )

  return (
    <tfoot className="model-usage-table-totals">
      {tokenTotals ? (
        <tr className="model-usage-table-totals-row model-usage-table-totals-row--tokens">
          <th scope="row" className="model-usage-table-totals-label">
            Token / cost total
          </th>
          {MODEL_USAGE_WINDOW_ORDER.map((windowKey) => (
            <WindowCells key={windowKey} windowKey={windowKey} totals={tokenTotals[windowKey]} />
          ))}
        </tr>
      ) : null}
      {ollamaTotals ? (
        <tr className="model-usage-table-totals-row model-usage-table-totals-row--memory">
          <th scope="row" className="model-usage-table-totals-label">
            Ollama RAM total
          </th>
          {MODEL_USAGE_WINDOW_ORDER.map((windowKey) => (
            <OllamaCells key={windowKey} windowKey={windowKey} totals={ollamaTotals[windowKey]} />
          ))}
        </tr>
      ) : null}
    </tfoot>
  )
}

export function ModelUsageWorkspaceMatrixTable({ matrix }: { matrix: ModelUsageWorkspaceMatrix }) {
  if (matrix.workspaces.length === 0 || matrix.groups.length === 0) return null
  return (
    <section className="model-usage-table-section" aria-label="Model usage by workspace">
      <div className="model-usage-table-header">
        <div className="model-usage-table-heading">
          <span className="model-usage-table-title">Models by workspace</span>
          <span className="model-usage-table-subtitle">
            Top {matrix.workspaces.length} busiest workspaces over 90D · changed files, tokens,
            estimated cost
          </span>
        </div>
      </div>
      <div className="model-usage-table-scroll">
        <table className="model-usage-table model-usage-table--workspace-matrix">
          <colgroup>
            <col className="model-usage-table-name-col" />
            {matrix.workspaces.map((workspace) => (
              <col key={workspace.workspaceId} className="model-usage-table-workspace-col" />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="model-usage-table-corner">
                Model
              </th>
              {matrix.workspaces.map((workspace) => (
                <th
                  key={workspace.workspaceId}
                  scope="col"
                  className="model-usage-table-workspace-head"
                  title={`${workspace.label} · ${workspace.totalTokens.toLocaleString()} tokens · ${workspace.changedFiles.toLocaleString()} changed files`}
                >
                  {workspace.label}
                </th>
              ))}
            </tr>
          </thead>
          {matrix.groups.map((group) => (
            <tbody
              key={group.provider}
              className={`model-usage-table-provider provider-${group.provider}`}
            >
              <tr className="model-usage-table-provider-row">
                <th scope="rowgroup" className="model-usage-table-provider-cell">
                  <span className={`model-usage-table-provider-label provider-${group.provider}`}>
                    <ProviderLogoTile provider={group.provider} />
                    <span className="model-usage-table-provider-name">
                      {getProviderName(group.provider)}
                    </span>
                    <span
                      className="model-usage-table-model-count"
                      title={`${group.models.length} model${group.models.length === 1 ? '' : 's'}`}
                    >
                      {group.models.length}
                    </span>
                  </span>
                </th>
                {matrix.workspaces.map((workspace) => {
                  const cell = group.totals[workspace.workspaceId]
                  return (
                    <td
                      key={workspace.workspaceId}
                      className="model-usage-table-workspace-cell is-provider-total"
                      title={workspaceMatrixCellTitle(cell)}
                    >
                      <span className="model-usage-table-workspace-diffs">
                        {cell.changedFiles > 0
                          ? `${cell.changedFiles.toLocaleString()} files`
                          : '— files'}
                      </span>
                      <span className="model-usage-table-workspace-tokens">
                        {cell.totalTokens > 0
                          ? `${formatTokenCount(cell.totalTokens)} tok`
                          : '— tok'}
                      </span>
                      <span className="model-usage-table-workspace-cost">
                        {workspaceMatrixCostCell(cell)}
                      </span>
                    </td>
                  )
                })}
              </tr>
              {group.models.map((model) => (
                <tr
                  key={`${group.provider}-${model.model}`}
                  className="model-usage-table-model-row"
                >
                  <td
                    className="model-usage-table-model-cell"
                    title={humaniseModelIdCompact(group.provider, model.model)}
                  >
                    {humaniseModelIdTableCell(group.provider, model.model)}
                  </td>
                  {matrix.workspaces.map((workspace) => {
                    const cell = model.workspaces[workspace.workspaceId]
                    return (
                      <td
                        key={workspace.workspaceId}
                        className="model-usage-table-workspace-cell"
                        title={workspaceMatrixCellTitle(cell)}
                      >
                        <span className="model-usage-table-workspace-diffs">
                          {cell.changedFiles > 0
                            ? `${cell.changedFiles.toLocaleString()} files`
                            : '— files'}
                        </span>
                        <span className="model-usage-table-workspace-tokens">
                          {cell.totalTokens > 0
                            ? `${formatTokenCount(cell.totalTokens)} tok`
                            : '— tok'}
                        </span>
                        <span className="model-usage-table-workspace-cost">
                          {workspaceMatrixCostCell(cell)}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <p className="model-usage-table-footnote">
        Changed-file counts come from TaskWraith run diffs when a usage row can be joined to a
        stored chat run. Provider-wide external rows without a local run join show no changed-file
        count.
      </p>
    </section>
  )
}

export function ProviderApiRatesTableBlock({ group }: { group: ProviderApiRateGroup }) {
  return (
    <tbody className={`model-usage-table-provider provider-${group.provider}`}>
      <tr className="model-usage-table-provider-row model-usage-table-provider-row--rates">
        <th scope="rowgroup" className="model-usage-table-provider-cell">
          <span className={`model-usage-table-provider-label provider-${group.provider}`}>
            <ProviderLogoTile provider={group.provider} />
            <span className="model-usage-table-provider-name">
              {getProviderName(group.provider)}
            </span>
            <span
              className="model-usage-table-model-count"
              title={`${group.rows.length} rate row${group.rows.length === 1 ? '' : 's'}`}
            >
              {group.rows.length}
            </span>
          </span>
        </th>
        <td className="model-usage-table-rate-meta" colSpan={4}>
          <span>rate table {group.rateTableVersion || 'unknown'}</span>
          {group.provider === 'gemini' ? <span>historic provider</span> : null}
          {group.provider === 'codex' ||
          group.provider === 'grok' ||
          group.provider === 'cursor' ? (
            <span>API-equivalent projection</span>
          ) : null}
        </td>
      </tr>
      {group.rows.map((row) => {
        const sourceTitle = rateSourceTitle(row, group)
        const source =
          row.sourceUrl && /^https?:\/\//.test(row.sourceUrl) ? (
            <a
              href={row.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className={`model-usage-table-rate-source is-${row.status}`}
              title={sourceTitle}
            >
              {statusLabel(row)}
            </a>
          ) : (
            <span className={`model-usage-table-rate-source is-${row.status}`} title={sourceTitle}>
              {statusLabel(row)}
            </span>
          )
        return (
          <tr key={`${group.provider}-${row.modelId}`} className="model-usage-table-model-row">
            <td
              className="model-usage-table-model-cell"
              title={humaniseModelIdCompact(group.provider, row.modelId)}
            >
              {humaniseModelIdTableCell(group.provider, row.modelId)}
            </td>
            <td
              className="model-usage-table-rate"
              title={`${row.inputUsdPerMillion} USD per 1M input tokens`}
            >
              {rateCell(row.inputUsdPerMillion)}
            </td>
            <td
              className="model-usage-table-rate"
              title={
                row.cachedInputUsdPerMillion !== undefined
                  ? `${row.cachedInputUsdPerMillion} USD per 1M cached input tokens`
                  : undefined
              }
            >
              {rateCell(row.cachedInputUsdPerMillion)}
            </td>
            <td
              className="model-usage-table-rate"
              title={`${row.outputUsdPerMillion} USD per 1M output tokens`}
            >
              {rateCell(row.outputUsdPerMillion)}
            </td>
            <td className="model-usage-table-rate-source-cell">{source}</td>
          </tr>
        )
      })}
    </tbody>
  )
}

export function ProviderApiRatesSettingsTable() {
  const [groups, setGroups] = useState<ProviderApiRateGroup[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.api?.getProviderRates !== 'function') {
      setLoaded(true)
      return
    }
    let cancelled = false
    void window.api
      .getProviderRates()
      .then((snapshot) => {
        if (cancelled) return
        setGroups(buildProviderApiRateGroups(snapshot))
      })
      .catch(() => {
        if (!cancelled) setGroups([])
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="model-usage-table-section" aria-label="Provider and model API rates">
      <div className="model-usage-table-header">
        <div className="model-usage-table-heading">
          <span className="model-usage-table-title">Provider/Model API Rates</span>
          <span className="model-usage-table-subtitle">
            USD per 1M tokens used for estimated API-equivalent cost · not billed
          </span>
        </div>
      </div>

      {!loaded ? (
        <div className="model-usage-table-empty" role="note">
          <strong>Loading provider/model API rates…</strong>
          <span>Cost estimates stay hidden until the rate table loads.</span>
        </div>
      ) : groups.length > 0 ? (
        <>
          <div className="model-usage-table-scroll">
            <table className="model-usage-table model-usage-table--rates">
              <colgroup>
                <col className="model-usage-table-name-col" />
                <col className="model-usage-table-rate-col" />
                <col className="model-usage-table-rate-col" />
                <col className="model-usage-table-rate-col" />
                <col className="model-usage-table-source-col" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className="model-usage-table-corner">
                    Model
                  </th>
                  <th scope="col" className="model-usage-table-rate">
                    In / 1M
                  </th>
                  <th scope="col" className="model-usage-table-rate">
                    Cached in / 1M
                  </th>
                  <th scope="col" className="model-usage-table-rate">
                    Out / 1M
                  </th>
                  <th scope="col" className="model-usage-table-rate-source-cell">
                    Source
                  </th>
                </tr>
              </thead>
              {groups.map((group) => (
                <ProviderApiRatesTableBlock key={group.provider} group={group} />
              ))}
            </table>
          </div>
          <p className="model-usage-table-footnote">
            These rows are the same rate metadata used by TaskWraith&apos;s projected cost
            estimates. Gemini remains visible for historic usage; local Ollama models are tracked as
            RAM usage instead of API rates.
          </p>
        </>
      ) : (
        <div className="model-usage-table-empty" role="note">
          <strong>No API rates available.</strong>
          <span>Cost estimates will stay hidden until the rate table loads.</span>
        </div>
      )}
    </section>
  )
}

export function ModelContextLengthsSettingsTable() {
  const groups = buildModelContextLengthGroups({ includeOllama: true })
  return (
    <section className="model-usage-table-section" aria-label="Model context lengths">
      <div className="model-usage-table-header">
        <div className="model-usage-table-heading">
          <span className="model-usage-table-title">Model Context Lengths</span>
          <span className="model-usage-table-subtitle">
            Official maximum context window per model
          </span>
        </div>
      </div>
      <div className="model-usage-table-scroll">
        <table className="model-usage-table model-usage-table--context">
          <colgroup>
            <col className="model-usage-table-name-col" />
            <col className="model-usage-table-rate-col" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="model-usage-table-corner">
                Model
              </th>
              <th scope="col" className="model-usage-table-tokens">
                Context length
              </th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody
              key={group.provider}
              className={`model-usage-table-provider provider-${group.provider}`}
            >
              <tr className="model-usage-table-provider-row">
                <th scope="rowgroup" className="model-usage-table-provider-cell">
                  <span className={`model-usage-table-provider-label provider-${group.provider}`}>
                    <ProviderLogoTile provider={group.provider} />
                    <span className="model-usage-table-provider-name">
                      {getProviderName(group.provider)}
                    </span>
                    <span
                      className="model-usage-table-model-count"
                      title={`${group.models.length} model${group.models.length === 1 ? '' : 's'}`}
                    >
                      {group.models.length}
                    </span>
                  </span>
                </th>
                <td className="model-usage-table-tokens" aria-hidden />
              </tr>
              {group.models.map((m) => (
                <tr key={`${group.provider}-${m.modelId}`} className="model-usage-table-model-row">
                  <td className="model-usage-table-model-cell" title={m.label}>
                    {humaniseModelIdTableCell(group.provider, m.modelId)}
                  </td>
                  <td
                    className="model-usage-table-tokens"
                    title={`${m.contextWindow.toLocaleString()} tokens`}
                  >
                    {m.formatted}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <p className="model-usage-table-footnote">
        Exact vendor maximums — some models support a smaller default window (e.g. Claude&apos;s 1M
        context is an opt-in beta). Local Ollama windows are conservative defaults and vary by
        quantization.
      </p>
    </section>
  )
}

/** Count the runs feeding the widest (90d) window across all shown providers —
 * so the footnote can't claim runs the table doesn't display. */
function countShownRuns(groups: ModelUsageProviderGroup[]): number {
  return groups.reduce((total, group) => total + group.totals.d90.runs, 0)
}

export function ModelUsageSettingsTable({
  currency,
  overestimatePercent,
  locale,
  externalUsageDefault,
  onExternalUsageChange
}: ModelUsageSettingsTableProps) {
  const [internalRecords, setInternalRecords] = useState<UsageRecord[]>([])
  const [chats, setChats] = useState<ChatListItem[]>([])
  const [externalRecords, setExternalRecords] = useState<UsageRecord[]>([])
  const [rates, setRates] = useState<RendererProviderRates>({})
  // Whether the toggle's initial value is controlled by the caller. When the
  // prop is omitted we self-hydrate the persisted setting (below).
  const isControlledDefault = externalUsageDefault !== undefined
  const persistedExternal = externalUsageDefault === true
  // Toggle: seed from the (possibly controlled) pref, mirror locally so a click
  // is instant. Reconcile to a CONTROLLED pref during render (no effect) by
  // tracking the last-seen value — same pattern ModelUsageCard uses for its
  // view toggle. For the self-hydrated path the seed effect below sets it once.
  const [includeExternal, setIncludeExternal] = useState<boolean>(persistedExternal)
  const [lastPersistedExternal, setLastPersistedExternal] = useState<boolean>(persistedExternal)
  if (isControlledDefault && persistedExternal !== lastPersistedExternal) {
    setLastPersistedExternal(persistedExternal)
    setIncludeExternal(persistedExternal)
  }
  // Bumped on the `usage-changed` event to force a refetch.
  const [refreshTick, setRefreshTick] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Self-hydrate the persisted toggle when the caller didn't control it. Runs
  // once on mount; defers the setState to a microtask so it isn't a synchronous
  // in-effect update. Best-effort — stays OFF if the read fails.
  useEffect(() => {
    if (isControlledDefault) return
    if (typeof window === 'undefined' || typeof window.api?.getSettings !== 'function') return
    let cancelled = false
    void window.api
      .getSettings()
      .then((settings) => {
        if (cancelled) return
        const stored = settings?.modelUsageExternalUsage === true
        void Promise.resolve().then(() => {
          if (!cancelled) setIncludeExternal(stored)
        })
      })
      .catch(() => {
        // Leave the toggle OFF.
      })
    return () => {
      cancelled = true
    }
    // Mount-only: the persisted value is read once; subsequent flips go through
    // selectExternal which both updates local state and re-persists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fetch the priced rate table once (rarely changes within a session).
  useEffect(() => {
    let cancelled = false
    void fetchProviderRates().then((next) => {
      if (!cancelled) setRates(next)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Fetch the lean chat list so Ollama RAM + the workspace matrix can
  // backfill from run summaries — getChatList ships runsSummary (per-run
  // stats + precomputed diff counts) without serializing every chat's full
  // transcript over IPC the way getChats() did.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.api?.getChatList !== 'function') return
    let cancelled = false
    window.api
      .getChatList()
      .then((latest) => {
        if (!cancelled) setChats(Array.isArray(latest) ? latest : [])
      })
      .catch(() => {
        // Best-effort — usage rows without chat backfill still render.
      })
    return () => {
      cancelled = true
    }
  }, [refreshTick])

  // Fetch TaskWraith's own usage records (+ refetch on usage-changed).
  // Routed through the shared renderer cache: App's usage-changed handler
  // force-refreshes and seeds it, so this join is usually a free cache hit
  // instead of a second identical getUsage IPC round trip.
  useEffect(() => {
    if (typeof window === 'undefined') return
    let cancelled = false
    loadRendererUsageRecords('taskwraith')
      .then((latest) => {
        if (!cancelled) setInternalRecords(Array.isArray(latest) ? latest : [])
      })
      .catch(() => {
        // Best-effort — keep whatever we have rather than crashing the tab.
      })
    return () => {
      cancelled = true
    }
  }, [refreshTick])

  // Fetch the external provider activity only when the toggle is on — no point
  // scanning ~thousands of CLI session files for a view the user isn't seeing.
  // When the toggle is OFF we skip the fetch and leave any previously fetched
  // set untouched: the aggregator ignores `externalRecords` unless
  // `includeExternal` is true, so a stale set is inert (and re-toggling on is
  // instant). This keeps the effect free of a synchronous in-body setState.
  useEffect(() => {
    if (!includeExternal) return
    if (typeof window === 'undefined') return
    let cancelled = false
    loadRendererUsageRecords('external')
      .then((latest) => {
        if (!cancelled) setExternalRecords(Array.isArray(latest) ? latest : [])
      })
      .catch(() => {
        // Best-effort — leave the table on the internal-only data.
      })
    return () => {
      cancelled = true
    }
  }, [includeExternal, refreshTick])

  // Live-refresh on the broadcast usage-changed event (shared shim).
  useEffect(() => {
    return subscribeUsageChanged(() => setRefreshTick((tick) => tick + 1))
  }, [])

  const groups = useMemo<ModelUsageProviderGroup[]>(
    () =>
      buildModelUsageTableForSettings(internalRecords, externalRecords, rates, {
        currency,
        overestimatePercent,
        locale,
        includeExternal
      }),
    [
      internalRecords,
      externalRecords,
      rates,
      currency,
      overestimatePercent,
      locale,
      includeExternal
    ]
  )

  const ollamaMemoryRecords = useMemo(
    () => mergeOllamaMemoryUsageRecords(internalRecords, chats),
    [internalRecords, chats]
  )

  const ollamaGroup = useMemo(
    () => buildOllamaMemoryModelTable(ollamaMemoryRecords),
    [ollamaMemoryRecords]
  )

  const tokenTotals = useMemo(
    () =>
      groups.length > 0
        ? sumModelUsageProviderTotals(groups, {
            currency,
            overestimatePercent,
            locale
          })
        : null,
    [groups, currency, overestimatePercent, locale]
  )

  const workspaceMatrix = useMemo(
    () =>
      buildModelUsageWorkspaceMatrix(internalRecords, externalRecords, chats, rates, {
        currency,
        overestimatePercent,
        locale,
        includeExternal
      }),
    [
      internalRecords,
      externalRecords,
      chats,
      rates,
      currency,
      overestimatePercent,
      locale,
      includeExternal
    ]
  )

  const hasTableContent = groups.length > 0 || Boolean(ollamaGroup)

  const selectExternal = (next: boolean) => {
    if (next === includeExternal) return
    setIncludeExternal(next)
    if (onExternalUsageChange) {
      onExternalUsageChange(next)
    } else if (typeof window !== 'undefined' && typeof window.api?.updateSettings === 'function') {
      // Self-persist when the caller didn't hand us a persistence callback, so
      // the chosen scope survives reload without any prop threading. Fire-and-
      // forget — a failed write just means the toggle reverts to its stored
      // value on the next reload; the in-session flip already took effect.
      void window.api.updateSettings({ modelUsageExternalUsage: next }).catch(() => {})
    }
  }

  const manualRefresh = () => {
    if (isRefreshing || typeof window === 'undefined') return
    setIsRefreshing(true)
    // force: bypass the shared renderer cache AND (for external) the main-
    // process cache — the ↻ button's contract is "fetch the freshest now".
    // The results seed the shared cache for every other consumer.
    const usagePromise = loadRendererUsageRecords('taskwraith', { force: true }).catch(
      () => [] as UsageRecord[]
    )
    const chatsPromise =
      typeof window.api?.getChatList === 'function'
        ? window.api.getChatList().catch(() => [] as ChatListItem[])
        : Promise.resolve([] as ChatListItem[])
    const externalPromise = includeExternal
      ? loadRendererUsageRecords('external', { force: true }).catch(() => [] as UsageRecord[])
      : Promise.resolve(null)
    void Promise.all([usagePromise, chatsPromise, externalPromise])
      .then(([usage, chatList, external]) => {
        setInternalRecords(Array.isArray(usage) ? usage : [])
        setChats(Array.isArray(chatList) ? chatList : [])
        if (external !== null) {
          setExternalRecords(Array.isArray(external) ? external : [])
        }
      })
      .finally(() => setIsRefreshing(false))
  }

  const shownRuns = countShownRuns(groups) + (ollamaGroup?.totals.d90.runs ?? 0)

  return (
    <section className="model-usage-table-section" aria-label="Per-model usage and estimated cost">
      <div className="model-usage-table-header">
        <div className="model-usage-table-heading">
          <span className="model-usage-table-title">Usage by provider &amp; model</span>
          <span className="model-usage-table-subtitle">
            Tokens and estimated API-equivalent cost · not billed
            {ollamaGroup ? ' · Ollama shows average llama-server RAM' : ''}
          </span>
        </div>
        <div className="model-usage-table-header-controls">
          <label className="model-usage-table-external-toggle">
            <input
              type="checkbox"
              checked={includeExternal}
              onChange={(event) => selectExternal(event.target.checked)}
            />
            <span className="model-usage-table-external-toggle-label">External Usage</span>
            <span
              className="model-usage-table-external-toggle-hint"
              title="When on, includes provider activity tracked outside TaskWraith (the same data behind the External Activity heatmap) so you see provider-wide usage."
            >
              {includeExternal ? 'provider-wide' : 'this app only'}
            </span>
          </label>
          <button
            type="button"
            className="model-usage-table-refresh-button"
            onClick={manualRefresh}
            disabled={isRefreshing}
            title="Refresh usage data"
            aria-label="Refresh usage data"
          >
            {isRefreshing ? '…' : '↻'}
          </button>
        </div>
      </div>

      {hasTableContent ? (
        <>
          <div className="model-usage-table-scroll">
            <table className="model-usage-table">
              <colgroup>
                <col className="model-usage-table-name-col" />
                {MODEL_USAGE_WINDOW_ORDER.flatMap((windowKey) => [
                  <col key={`${windowKey}-metric-a`} className="model-usage-table-metric-col" />,
                  <col key={`${windowKey}-metric-b`} className="model-usage-table-metric-col" />
                ])}
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className="model-usage-table-corner">
                    Model
                  </th>
                  {MODEL_USAGE_WINDOW_ORDER.map((windowKey) => (
                    <th key={windowKey} scope="colgroup" colSpan={2}>
                      {MODEL_USAGE_WINDOW_LABEL[windowKey]}
                    </th>
                  ))}
                </tr>
                <tr className="model-usage-table-subhead">
                  <th scope="col" aria-hidden />
                  {MODEL_USAGE_WINDOW_ORDER.map((windowKey) => (
                    <Fragment key={windowKey}>
                      <th scope="col" className="model-usage-table-tokens">
                        tokens
                      </th>
                      <th scope="col" className="model-usage-table-cost">
                        ~cost
                      </th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              {groups.map((group) => (
                <ModelUsageProviderTableBlock key={group.provider} group={group} />
              ))}
              {ollamaGroup ? <ModelUsageOllamaTableBlock group={ollamaGroup} /> : null}
              <ModelUsageTableTotalsFooter
                tokenTotals={tokenTotals}
                ollamaTotals={ollamaGroup?.totals ?? null}
              />
            </table>
          </div>
          <p className="model-usage-table-footnote">
            Cost columns are projected API-equivalents from the per-model rate table —{' '}
            <strong>estimated, not billed</strong> (records carry token counts only). To see real
            invoices, visit each provider&apos;s billing page.{' '}
            {shownRuns === 1 ? '1 run' : `${shownRuns.toLocaleString()} runs`} over the 90-day
            window{includeExternal ? ', including external activity.' : '.'}
            {ollamaGroup
              ? ' Ollama RAM columns average per-run peak llama-server RSS and periodic sample counts.'
              : ''}
          </p>
        </>
      ) : (
        <div className="model-usage-table-empty" role="note">
          <strong>No tracked usage in the last 90 days.</strong>
          <span>
            {includeExternal
              ? 'No priced provider activity found — start a chat or use a provider CLI to populate this table.'
              : 'Start a chat with any provider to populate this table, or turn on External Usage to include activity from outside TaskWraith.'}
          </span>
        </div>
      )}
      <ModelUsageWorkspaceMatrixTable matrix={workspaceMatrix} />
    </section>
  )
}
