import { useState } from 'react'
import type { ProviderId, ToolActivity } from '../../../main/store/types'
import { ToolFamilyIcon, toolNameToFamily } from './icons/ToolFamilyIcon'
import {
  REDACTION_HINT,
  buildFoldoutSections,
  buildResultPreview,
  compactToolDisplayName,
  durationLabel,
  extractToolUrlTargets,
  friendlyGlobalToolLabel,
  providerLabel,
  resolveProvider,
  statusLabel
} from './CompactToolTrace.lib'
import { ToolUrlBadge } from './ToolUrlBadge'

interface CompactToolTraceProps {
  activity: ToolActivity
  /** Chat-level provider — used when the activity itself doesn't
   * carry a `metadata.provider` / `metadata.ensembleProvider`. */
  provider?: ProviderId
  /** Slice 6a — when true (chat.scope === 'global'), the collapsed one-line
   * trace softens to a friendly summary ("Searched the web…") for web tools.
   * Softens, never hides: the foldout still carries the full raw output. */
  globalScope?: boolean
}

export function CompactToolTrace({
  activity,
  provider,
  globalScope = false
}: CompactToolTraceProps) {
  const [expanded, setExpanded] = useState(false)
  const resolvedProvider = resolveProvider(activity, provider)
  const family = toolNameToFamily(activity.toolName)
  const preview = buildResultPreview(activity)
  const duration = durationLabel(activity.durationMs)
  const status = statusLabel(activity.status)
  const toolName = compactToolDisplayName(activity)
  const provLabel = providerLabel(resolvedProvider)
  const urlTargets = extractToolUrlTargets(activity)
  const softLabel = globalScope ? friendlyGlobalToolLabel(activity) : null

  const sections = expanded ? buildFoldoutSections(activity) : []

  return (
    <div
      className={`compact-tool-trace ${expanded ? 'is-expanded' : 'is-collapsed'}`}
      data-status={activity.status}
      data-provider={resolvedProvider || 'unknown'}
    >
      <button
        type="button"
        className="compact-tool-trace-line"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="compact-tool-trace-icon" aria-hidden>
          {family ? (
            <ToolFamilyIcon family={family} size={14} />
          ) : (
            <span className={`compact-tool-trace-pip category-${activity.category || 'unknown'}`} />
          )}
        </span>
        <span className="compact-tool-trace-name">{softLabel || toolName}</span>
        {!softLabel && provLabel && (
          <>
            <span className="compact-tool-trace-sep" aria-hidden>
              ·
            </span>
            <span className={`compact-tool-trace-provider provider-${resolvedProvider}`}>
              {provLabel}
            </span>
          </>
        )}
        {urlTargets[0] && (
          <>
            <span className="compact-tool-trace-sep" aria-hidden>
              ·
            </span>
            <ToolUrlBadge target={urlTargets[0]} compact />
          </>
        )}
        <span className="compact-tool-trace-sep" aria-hidden>
          ·
        </span>
        <span className={`compact-tool-trace-status status-${activity.status}`}>{status}</span>
        {duration && (
          <>
            <span className="compact-tool-trace-sep" aria-hidden>
              ·
            </span>
            <span className="compact-tool-trace-duration">{duration}</span>
          </>
        )}
        {preview.hasContent && (
          <>
            <span className="compact-tool-trace-sep" aria-hidden>
              ·
            </span>
            <span
              className={`compact-tool-trace-preview${preview.redacted ? ' is-redacted' : ''}`}
              title={preview.display}
            >
              &ldquo;{preview.display}&rdquo;
            </span>
            {preview.redacted && (
              <span className="compact-tool-trace-redacted-hint">{REDACTION_HINT}</span>
            )}
          </>
        )}
        <span
          className="compact-tool-trace-chevron"
          data-expanded={expanded ? 'true' : 'false'}
          aria-hidden
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3,4.5 6,7.5 9,4.5" />
          </svg>
        </span>
      </button>
      {expanded && (sections.length > 0 || urlTargets.length > 0) && (
        <div className="compact-tool-trace-foldout">
          {urlTargets.length > 0 && (
            <div className="compact-tool-trace-foldout-section">
              <div className="compact-tool-trace-foldout-label">Sources</div>
              <div className="compact-tool-trace-sources">
                {urlTargets.map((target) => (
                  <ToolUrlBadge key={target.url} target={target} />
                ))}
              </div>
            </div>
          )}
          {sections.map((section) => (
            <div key={section.label} className="compact-tool-trace-foldout-section">
              <div className="compact-tool-trace-foldout-label">{section.label}</div>
              <pre className="compact-tool-trace-foldout-body">{section.body}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
