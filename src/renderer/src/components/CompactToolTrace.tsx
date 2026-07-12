import { useMemo, useRef, useState } from 'react'
import type { ProviderId, ToolActivity } from '../../../main/store/types'
import { MOTION_DURATIONS, usePresence } from '../hooks/usePanelPresence'
import { ToolFamilyIcon, toolNameToFamily } from './icons/ToolFamilyIcon'
import {
  REDACTION_HINT,
  buildFoldoutSections,
  buildResultPreview,
  durationLabel,
  extractToolUrlTargets,
  friendlyGlobalToolLabel,
  providerLabel,
  resolveProvider,
  splitCompactToolLabel,
  statusLabel
} from './CompactToolTrace.lib'
import { ToolUrlBadge } from './ToolUrlBadge'
import { TranscriptFileTarget } from './TranscriptFileTarget'

interface CompactToolTraceProps {
  activity: ToolActivity
  /** Chat-level provider — used when the activity itself doesn't
   * carry a `metadata.provider` / `metadata.ensembleProvider`. */
  provider?: ProviderId
  /** Workspace root — lets the clickable file path resolve a relative tool
   * path to an absolute one for open / reveal. */
  workspacePath?: string
  /** Slice 6a — when true (chat.scope === 'global'), the collapsed one-line
   * trace softens to a friendly summary ("Searched the web…") for web tools.
   * Softens, never hides: the foldout still carries the full raw output. */
  globalScope?: boolean
}

export function CompactToolTrace({
  activity,
  provider,
  workspacePath,
  globalScope = false
}: CompactToolTraceProps) {
  const [expanded, setExpanded] = useState(false)
  const resolvedProvider = resolveProvider(activity, provider)
  const family = toolNameToFamily(activity.toolName)
  const preview = buildResultPreview(activity)
  const duration = durationLabel(activity.durationMs)
  const status = statusLabel(activity.status)
  const provLabel = providerLabel(resolvedProvider)
  const urlTargets = extractToolUrlTargets(activity)
  const softLabel = globalScope ? friendlyGlobalToolLabel(activity) : null
  const { prefix: labelPrefix, filePath: labelFilePath } = splitCompactToolLabel(
    activity,
    softLabel
  )

  // Lazy-build foldout sections only while expanded; keep the last payload in
  // a ref so the exit fade still has stable content without parsing every
  // collapsed transcript row on every render.
  const sectionsRef = useRef<ReturnType<typeof buildFoldoutSections>>([])
  const sections = useMemo(() => {
    if (!expanded) return sectionsRef.current
    const next = buildFoldoutSections(activity)
    sectionsRef.current = next
    return next
  }, [activity, expanded])
  const hasFoldout = sections.length > 0 || urlTargets.length > 0
  const foldoutPresence = usePresence(expanded && hasFoldout, {
    durationMs: MOTION_DURATIONS.base,
    variant: 'rise'
  })

  const toggleExpanded = () => setExpanded((current) => !current)

  return (
    <div
      className={`compact-tool-trace ${expanded ? 'is-expanded' : 'is-collapsed'}`}
      data-status={activity.status}
      data-provider={resolvedProvider || 'unknown'}
    >
      <div
        className="compact-tool-trace-line"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggleExpanded}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggleExpanded()
          }
        }}
      >
        <span className="compact-tool-trace-icon" aria-hidden>
          {family ? (
            <ToolFamilyIcon family={family} size={14} />
          ) : (
            <span className={`compact-tool-trace-pip category-${activity.category || 'unknown'}`} />
          )}
        </span>
        <span className="compact-tool-trace-name">{labelPrefix}</span>
        {labelFilePath && (
          <TranscriptFileTarget
            filePath={labelFilePath}
            label={labelFilePath}
            workspacePath={workspacePath}
            className="compact-tool-trace-path"
          />
        )}
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
      </div>
      {foldoutPresence.mounted && hasFoldout && (
        <div
          className={`compact-tool-trace-foldout${
            foldoutPresence.className ? ` ${foldoutPresence.className}` : ''
          }`}
        >
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
