import { useMemo, useState } from 'react'
import type { ChatRecord } from '../../../main/store/types'
import { MarkdownMessage } from './MarkdownMessage'

export type ProposedPlanCardProps = {
  title: string
  body: string
  chat?: ChatRecord
  /** Approve → re-dispatch the thread (write-capable) to implement `planBody`
   *  (the possibly-edited plan). */
  onApprove: (planBody: string) => void
  /** Dismiss the plan without implementing (stays in plan mode). */
  onDismiss: () => void
  /** Send a free-text response so the agent revises the plan (stays in plan
   *  mode). */
  onCustom: (feedback: string) => void
}

type CardMode = 'view' | 'edit' | 'custom'

/**
 * The Codex-style proposed-plan card: a collapsible "Plan" panel rendered
 * inline in the transcript when an agent presents a plan in plan mode. The
 * action row gates the read-only→implement transition — Approve re-runs the
 * thread with edit permissions; Dismiss / Respond keep it read-only.
 */
export function ProposedPlanCard({
  title,
  body,
  chat,
  onApprove,
  onDismiss,
  onCustom
}: ProposedPlanCardProps) {
  const [expanded, setExpanded] = useState(true)
  const [mode, setMode] = useState<CardMode>('view')
  const [draftBody, setDraftBody] = useState(body)
  const [customText, setCustomText] = useState('')

  const editRows = useMemo(
    () => Math.min(24, Math.max(6, draftBody.split('\n').length + 1)),
    [draftBody]
  )

  return (
    <div className="proposed-plan-card">
      <button
        type="button"
        className="proposed-plan-header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        title={expanded ? 'Collapse plan' : 'Expand plan'}
      >
        <span className="proposed-plan-chevron" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
        <span className="proposed-plan-eyebrow">Plan</span>
        <span className="proposed-plan-title">{title}</span>
      </button>

      {expanded && (
        <div className="proposed-plan-body">
          {mode === 'edit' ? (
            <textarea
              className="proposed-plan-edit"
              value={draftBody}
              onChange={(event) => setDraftBody(event.target.value)}
              rows={editRows}
              autoFocus
              aria-label="Edit the plan before approving"
            />
          ) : (
            <MarkdownMessage content={draftBody} chat={chat || undefined} />
          )}
        </div>
      )}

      {mode === 'custom' ? (
        <div className="proposed-plan-custom">
          <textarea
            className="proposed-plan-custom-input"
            value={customText}
            onChange={(event) => setCustomText(event.target.value)}
            rows={3}
            autoFocus
            placeholder="Tell the agent what to change… (⌘/Ctrl+Enter to send)"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && customText.trim()) {
                event.preventDefault()
                onCustom(customText.trim())
              }
            }}
          />
          <div className="proposed-plan-actions">
            <button type="button" className="proposed-plan-btn" onClick={() => setMode('view')}>
              Back
            </button>
            <button
              type="button"
              className="proposed-plan-btn proposed-plan-primary"
              disabled={!customText.trim()}
              onClick={() => onCustom(customText.trim())}
            >
              Send response
            </button>
          </div>
        </div>
      ) : mode === 'edit' ? (
        <div className="proposed-plan-actions">
          <button
            type="button"
            className="proposed-plan-btn"
            onClick={() => {
              setDraftBody(body)
              setMode('view')
            }}
          >
            Cancel edit
          </button>
          <button
            type="button"
            className="proposed-plan-btn proposed-plan-primary"
            disabled={!draftBody.trim()}
            onClick={() => onApprove(draftBody.trim())}
            title="Approve the edited plan and implement it"
          >
            Approve edited plan
          </button>
        </div>
      ) : (
        <div className="proposed-plan-actions">
          <button
            type="button"
            className="proposed-plan-btn proposed-plan-dismiss"
            onClick={onDismiss}
            title="Dismiss without implementing"
          >
            Dismiss
          </button>
          <button type="button" className="proposed-plan-btn" onClick={() => setMode('custom')}>
            Respond…
          </button>
          <button type="button" className="proposed-plan-btn" onClick={() => setMode('edit')}>
            Edit
          </button>
          <button
            type="button"
            className="proposed-plan-btn proposed-plan-primary"
            onClick={() => onApprove(draftBody.trim())}
            title="Approve this plan and implement it with edit permissions"
          >
            Approve &amp; implement
          </button>
        </div>
      )}
    </div>
  )
}
