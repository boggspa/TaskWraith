import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { ProviderId } from '../../../main/store/types'
import type {
  CloseoutSubagentDelegation,
  CloseoutSubagentDelegationStatus
} from '../lib/taskWraithCloseoutMessage'
import { assignAgentIdentityFromSeed } from '../lib/agentIdentitySeed'
import { providerDisplayName } from '../lib/AgentInvocationPresentation'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'
import { getDiffHoverPreviewLayout } from './DiffHoverPreview'

export const SUBAGENT_INVOCATION_TOOLTIP_ID = 'subagent-invocation-hover-card'

/** Longest prompt shown in the bubble; the sub-thread itself holds the rest. */
export const SUBAGENT_INVOCATION_PROMPT_LIMIT = 900

export interface SubagentInvocationHoverState {
  anchor: DOMRect
  boundary?: DOMRect
  row: CloseoutSubagentDelegation
}

export interface SubagentInvocationView {
  agentName: string
  agentKey: string
  agentAccent: string
  title: string
  provider: ProviderId
  parentProvider?: ProviderId
  routeLabel: string
  statusLabel: string
  statusKey: CloseoutSubagentDelegationStatus
  prompt: string
  promptTruncated: boolean
}

function statusLabelFor(status: CloseoutSubagentDelegationStatus): string {
  switch (status) {
    case 'returned':
      return 'Returned'
    case 'completed':
      return 'Completed'
    case 'running':
      return 'Active'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'created':
      return 'Created'
    default:
      return 'Pending'
  }
}

/**
 * Presentation model for the Agent-Invocation hover bubble.
 *
 * Pure so it can be tested without a DOM: this repo has no jsdom environment,
 * and the bubble itself only ever renders through a portal.
 */
export function buildSubagentInvocationView(
  row: CloseoutSubagentDelegation
): SubagentInvocationView {
  const identity = assignAgentIdentityFromSeed(row.identitySeed || row.subThreadId)
  const prompt = (row.promptPreview || '').trim()
  const promptTruncated = prompt.length > SUBAGENT_INVOCATION_PROMPT_LIMIT
  return {
    agentName: identity.name,
    agentKey: identity.key,
    agentAccent: identity.accent,
    title: row.title || identity.name,
    provider: row.provider,
    ...(row.parentProvider ? { parentProvider: row.parentProvider } : {}),
    // Same "caller → worker" reading as the close-out row it hangs off.
    routeLabel: row.parentProvider
      ? `${providerDisplayName(row.parentProvider)} → ${providerDisplayName(row.provider)}`
      : providerDisplayName(row.provider),
    statusLabel: statusLabelFor(row.status),
    statusKey: row.status,
    prompt: promptTruncated
      ? `${prompt.slice(0, SUBAGENT_INVOCATION_PROMPT_LIMIT).trimEnd()}…`
      : prompt,
    promptTruncated
  }
}

/**
 * The bubble's contents, without the portal — exported so it can be rendered
 * (and asserted on) in a DOM-free test.
 */
export function SubagentInvocationHoverCardBody({
  view
}: {
  view: SubagentInvocationView
}): JSX.Element {
  return (
    <>
      <header className="subagent-invocation-hover-header">
        <span className="agent-invocation-label">Agent Invocation</span>
        <span className={`subagent-invocation-hover-status status-${view.statusKey}`}>
          {view.statusLabel}
        </span>
      </header>
      <div className="subagent-invocation-hover-identity">
        <AgentIdentityIcon
          name={view.agentKey}
          color={view.agentAccent}
          size={20}
          className="subagent-invocation-hover-icon"
        />
        <span className="subagent-invocation-hover-name">{view.agentName}</span>
        <span className="subagent-invocation-hover-title">{view.title}</span>
      </div>
      <div className="subagent-invocation-hover-route">
        {view.parentProvider ? (
          <ProviderBrandLogoIcon
            provider={view.parentProvider}
            wrapperClassName="subagent-invocation-hover-logo"
          />
        ) : null}
        <ProviderBrandLogoIcon
          provider={view.provider}
          wrapperClassName="subagent-invocation-hover-logo"
        />
        <span className="subagent-invocation-hover-route-label">{view.routeLabel}</span>
      </div>
      {view.prompt ? (
        <div className="subagent-invocation-hover-prompt">{view.prompt}</div>
      ) : (
        <div className="subagent-invocation-hover-prompt is-empty">
          This invocation recorded no prompt preview.
        </div>
      )}
    </>
  )
}

/**
 * Hover bubble for a Task-complete Sub-threads row — the Agent Invocation the
 * row summarises. Mirrors the commit-files pill beside it: portalled to the
 * body, positioned by the shared preview layout, and kept open while the
 * pointer is over the bubble itself.
 */
export function SubagentInvocationHoverCard({
  preview,
  onFocus,
  onBlur,
  onMouseEnter,
  onMouseLeave
}: {
  preview: SubagentInvocationHoverState | null
  onFocus?: () => void
  onBlur?: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}): JSX.Element | null {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!preview) {
      setMeasuredHeight(null)
      return
    }
    const height = cardRef.current?.getBoundingClientRect().height
    if (typeof height === 'number' && height > 0) setMeasuredHeight(height)
  }, [preview])

  useEffect(() => {
    if (!preview || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onBlur?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onBlur, preview])

  if (!preview || typeof document === 'undefined') return null

  const view = buildSubagentInvocationView(preview.row)
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768
  const layout = getDiffHoverPreviewLayout({
    anchor: preview.anchor,
    boundary: preview.boundary,
    previewHeight: measuredHeight ?? undefined,
    viewportHeight,
    viewportWidth
  })

  return createPortal(
    <div
      ref={cardRef}
      id={SUBAGENT_INVOCATION_TOOLTIP_ID}
      className="subagent-invocation-hover-card"
      data-status={view.statusKey}
      role="tooltip"
      aria-label={`Agent Invocation for ${view.agentName}`}
      tabIndex={0}
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        left: `${layout.left}px`,
        maxHeight: `${layout.maxHeight}px`,
        top: `${layout.top}px`,
        width: `${layout.width}px`
      }}
    >
      {/* Invisible gutter so the pointer can cross the gap from row to bubble
          without tripping the close timer — same trick as the diff preview. */}
      <div
        className="subagent-invocation-hover-bridge"
        style={{ position: 'absolute', top: '-14px', bottom: '-14px', left: 0, right: 0 }}
        aria-hidden
      />
      <SubagentInvocationHoverCardBody view={view} />
    </div>,
    document.body
  )
}
