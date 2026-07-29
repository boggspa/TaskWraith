import { useState, type CSSProperties } from 'react'
import type { ContextActivitySummary } from '../lib/contextMeter'
import { formatContextTokens } from '../lib/contextWindows'
import type { ContextUsagePrecision, ContextUsageSnapshot } from '../../../shared/contextUsage'

interface ContextMeterDetailsProps {
  primary: string
  usedTokens: number
  windowTokens: number
  percent: number
  usage?: ContextUsageSnapshot
  activity?: ContextActivitySummary
}

interface CompositionPart {
  key: string
  label: string
  tokens: number
  tone: string
  approximate?: boolean
}

function precisionLabel(precision: ContextUsagePrecision): string {
  if (precision === 'exact') return 'Exact snapshot'
  if (precision === 'estimated') return 'Estimated'
  return 'Derived'
}

function sourceDescription(usage: ContextUsageSnapshot | undefined): string {
  if (!usage) {
    return 'No provider token snapshot has arrived for this context yet.'
  }
  if (usage.source === 'provider-last-invocation') {
    return 'Provider-reported latest model invocation. Token categories are exact where the provider exposes them.'
  }
  if (usage.source === 'provider-compaction') {
    if (usage.precision !== 'exact') {
      return 'Provider-reported post-compaction baseline with a TaskWraith live-output estimate added. The displayed total is derived; only the compaction baseline is exact.'
    }
    return 'Provider-reported post-compaction occupancy. The new total is exact; the provider did not expose a category breakdown for the compacted context.'
  }
  if (usage.source === 'post-compaction-unknown') {
    if (usage.outputTokens > 0) {
      return 'Compaction completed without a post-token count. TaskWraith is carrying forward the last pre-compaction value and adding an approximate live-output estimate; the displayed total is not provider-reported occupancy.'
    }
    return 'Compaction completed without a post-token count. This is the last pre-compaction value, retained only as a stale upper bound until the next provider snapshot.'
  }
  if (usage.source === 'host-estimate') {
    return 'The provider has not exposed a live window snapshot. TaskWraith is using its shared character-based stream estimate.'
  }
  return 'Derived from the latest whole-turn provider usage. This provider has not exposed a distinct last-invocation window snapshot.'
}

function compositionParts(
  usage: ContextUsageSnapshot | undefined,
  usedTokens: number
): CompositionPart[] {
  if (!usage) {
    return usedTokens > 0
      ? [{ key: 'used', label: 'Used context', tokens: usedTokens, tone: 'used' }]
      : []
  }
  if (usage.source === 'provider-compaction' || usage.source === 'post-compaction-unknown') {
    const liveOutputTokens = Math.min(usage.contextTokens, usage.visibleOutputTokens)
    const baselineTokens = Math.max(0, usage.contextTokens - liveOutputTokens)
    const parts: CompositionPart[] = [
      {
        key: 'compacted',
        label:
          usage.source === 'provider-compaction'
            ? liveOutputTokens > 0
              ? 'Compacted baseline'
              : 'Compacted context'
            : liveOutputTokens > 0
              ? 'Stale pre-compaction value'
              : 'Pre-compaction upper bound',
        tokens: baselineTokens,
        tone: usage.source === 'provider-compaction' ? 'input' : 'other',
        approximate: usage.source === 'post-compaction-unknown'
      }
    ]
    if (liveOutputTokens > 0) {
      parts.push({
        key: 'live-output',
        label: 'Live output estimate',
        tokens: liveOutputTokens,
        tone: 'output',
        approximate: true
      })
    }
    return parts.filter((part) => part.tokens > 0)
  }
  return [
    {
      key: 'fresh-input',
      label: 'Fresh input',
      tokens: usage.freshInputTokens,
      tone: 'input'
    },
    {
      key: 'cache-read',
      label: 'Cache read',
      tokens: usage.cacheReadInputTokens,
      tone: 'cache-read'
    },
    {
      key: 'cache-write',
      label: 'Cache write',
      tokens: usage.cacheCreationInputTokens,
      tone: 'cache-write'
    },
    {
      key: 'visible-output',
      label: 'Answer',
      tokens: usage.visibleOutputTokens,
      tone: 'output'
    },
    {
      key: 'reasoning',
      label: 'Reasoning',
      tokens: usage.reasoningTokens,
      tone: 'reasoning'
    },
    {
      key: 'unclassified',
      label: 'Other provider tokens',
      tokens: usage.unclassifiedTokens,
      tone: 'other'
    }
  ].filter((part) => part.tokens > 0)
}

function TokenAmount({
  tokens,
  approximate = false
}: {
  tokens: number
  approximate?: boolean
}): React.JSX.Element {
  return (
    <span className="context-meter-detail-token">
      {approximate ? '≈' : ''}
      {formatContextTokens(tokens)}
    </span>
  )
}

function ActivityDetails({ activity }: { activity: ContextActivitySummary }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const directionRows = [
    {
      label: 'Transcript text tracked',
      value: `${activity.messageCount} messages`,
      tokens: activity.messageTokens
    },
    {
      label: 'Model → tools',
      value: `${activity.toolCallCount} calls`,
      tokens: activity.toolInputTokens
    },
    {
      label: 'Tools → model',
      value: `${activity.toolResultCount} results`,
      tokens: activity.toolResultTokens
    },
    {
      label: 'Visible reasoning traces',
      value: `${activity.reasoningSegmentCount} segments`,
      tokens: activity.reasoningTextTokens
    }
  ].filter((row) => row.tokens > 0 || !row.value.startsWith('0 '))

  return (
    <details
      className="context-meter-detail-section"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>Observed activity</span>
        <span className="context-meter-detail-summary-meta">
          {activity.toolCallCount} tools · {activity.messageCount} messages
        </span>
      </summary>
      <div className="context-meter-detail-section-body">
        <div className="context-meter-activity-grid">
          {directionRows.map((row) => (
            <div className="context-meter-activity-row" key={row.label}>
              <span>{row.label}</span>
              <span className="context-meter-activity-value">
                {row.value}
                {row.tokens > 0 && <TokenAmount tokens={row.tokens} approximate />}
              </span>
            </div>
          ))}
        </div>
        {(activity.readCalls > 0 ||
          activity.writeCalls > 0 ||
          activity.searchCalls > 0 ||
          activity.shellCalls > 0) && (
          <div className="context-meter-activity-pills" aria-label="Tool activity by kind">
            {activity.readCalls > 0 && <span>{activity.readCalls} reads</span>}
            {activity.writeCalls > 0 && <span>{activity.writeCalls} writes</span>}
            {activity.searchCalls > 0 && <span>{activity.searchCalls} searches</span>}
            {activity.shellCalls > 0 && <span>{activity.shellCalls} shell</span>}
            {activity.filesRead > 0 && <span>{activity.filesRead} files read</span>}
            {activity.filesWritten > 0 && <span>{activity.filesWritten} files written</span>}
          </div>
        )}
        {activity.tools.length > 0 && (
          <div className="context-meter-tool-list">
            {activity.tools.slice(0, 8).map((tool) => (
              <div className="context-meter-tool-row" key={tool.name}>
                <span className="context-meter-tool-name" title={tool.label}>
                  {tool.label}
                </span>
                <span className="context-meter-tool-count">{tool.count}</span>
              </div>
            ))}
          </div>
        )}
        <p className="context-meter-detail-note">
          Activity counts are observed by TaskWraith. Their token figures are approximate and are
          descriptive only—they are never added on top of provider totals.
        </p>
      </div>
    </details>
  )
}

export function ContextMeterDetails({
  primary,
  usedTokens,
  windowTokens,
  percent,
  usage,
  activity
}: ContextMeterDetailsProps): React.JSX.Element {
  const freeTokens = Math.max(0, windowTokens - usedTokens)
  const freePercent = windowTokens > 0 ? Math.max(0, 100 - percent) : 0
  const parts = compositionParts(usage, usedTokens)
  const precision = usage?.precision || 'estimated'
  const [tokenMakeupOpen, setTokenMakeupOpen] = useState(true)

  return (
    <div className="context-meter-details" aria-label={`${primary} context details`}>
      <div className="context-meter-detail-hero">
        <div>
          <strong>{Math.round(percent)}% used</strong>
          <span> · {Math.round(freePercent)}% free</span>
        </div>
        <div className="context-meter-detail-hero-amount">
          {formatContextTokens(usedTokens)} / {formatContextTokens(windowTokens)}
        </div>
      </div>

      <div
        className="context-meter-composition-bar"
        role="meter"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${primary} context composition`}
      >
        {parts.map((part) => (
          <span
            key={part.key}
            className={`context-meter-composition-segment tone-${part.tone}`}
            style={
              {
                '--context-meter-segment-width':
                  windowTokens > 0 ? `${(part.tokens / windowTokens) * 100}%` : '0%'
              } as CSSProperties
            }
            title={`${part.label}: ${formatContextTokens(part.tokens)}`}
          />
        ))}
        {freeTokens > 0 && (
          <span
            className="context-meter-composition-segment tone-free"
            style={
              {
                '--context-meter-segment-width':
                  windowTokens > 0 ? `${(freeTokens / windowTokens) * 100}%` : '100%'
              } as CSSProperties
            }
            title={`Free space: ${formatContextTokens(freeTokens)}`}
          />
        )}
      </div>

      <details
        className="context-meter-detail-section"
        open={tokenMakeupOpen}
        onToggle={(event) => setTokenMakeupOpen(event.currentTarget.open)}
      >
        <summary>
          <span>Token makeup</span>
          <span className={`context-meter-precision-badge is-${precision}`}>
            {precisionLabel(precision)}
          </span>
        </summary>
        <div className="context-meter-detail-section-body">
          <div className="context-meter-token-list">
            {parts.map((part) => (
              <div className="context-meter-token-row" key={part.key}>
                <span
                  className={`context-meter-token-swatch tone-${part.tone}`}
                  aria-hidden="true"
                />
                <span>{part.label}</span>
                <TokenAmount tokens={part.tokens} approximate={part.approximate} />
              </div>
            ))}
            {usage && usage.toolUsePromptTokens > 0 && (
              <div className="context-meter-token-row is-subset">
                <span className="context-meter-token-subset-mark" aria-hidden>
                  ↳
                </span>
                <span>Tool definitions inside input</span>
                <TokenAmount tokens={usage.toolUsePromptTokens} />
              </div>
            )}
            <div className="context-meter-token-row">
              <span className="context-meter-token-swatch tone-free" aria-hidden="true" />
              <span>Free space</span>
              <TokenAmount tokens={freeTokens} />
            </div>
          </div>
        </div>
      </details>

      {activity && <ActivityDetails activity={activity} />}

      <div className="context-meter-detail-provenance">
        <span className={`context-meter-precision-badge is-${precision}`}>
          {precisionLabel(precision)}
        </span>
        <span>{sourceDescription(usage)}</span>
      </div>
    </div>
  )
}
