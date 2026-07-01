import { useId, useMemo, useState } from 'react'
import type { ChatRecord } from '../../../main/store/types'
import { isValidRelativePlanArtifactPath } from '../lib/proposedPlan'
import { MarkdownMessage } from './MarkdownMessage'

export type ProposedPlanCardProps = {
  title: string
  body: string
  artifactPath?: string
  /** Decision state — `pending` shows the action row; once decided the card
   *  collapses to a read-only outcome. */
  status: 'pending' | 'approved' | 'dismissed'
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
  artifactPath,
  status,
  chat,
  onApprove,
  onDismiss,
  onCustom
}: ProposedPlanCardProps) {
  const isPending = status === 'pending'
  const bodyPanelId = useId()
  // Pending plans open for review; a decided plan collapses to its outcome.
  const [expanded, setExpanded] = useState(isPending)
  const [mode, setMode] = useState<CardMode>('view')
  const [draftBody, setDraftBody] = useState(body)
  const [customText, setCustomText] = useState('')
  // Latch: a decision dispatches a run (Approve elevates to write), and the card
  // stays mounted until the parent clears state, so a fast double-click could
  // dispatch twice. Fire once.
  const [submitted, setSubmitted] = useState(false)
  const fire = (action: () => void) => {
    if (submitted) return
    setSubmitted(true)
    action()
  }

  const canOpenPlanFile = Boolean(
    chat?.workspacePath &&
      artifactPath &&
      isValidRelativePlanArtifactPath(artifactPath)
  )

  const handleOpenPlanFile = (): void => {
    if (!canOpenPlanFile || !artifactPath || !chat?.workspacePath) return
    void window.api.openWorkspacePopout({
      kind: 'file-editor',
      workspacePath: chat.workspacePath,
      targetPath: artifactPath,
      targetView: 'editor'
    })
  }

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
        aria-controls={bodyPanelId}
        title={expanded ? 'Collapse plan' : 'Expand plan'}
      >
        <span className="proposed-plan-chevron" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
        <span className="proposed-plan-eyebrow">Plan</span>
        <span className="proposed-plan-title">{title}</span>
        {status === 'approved' && (
          <span className="proposed-plan-badge proposed-plan-badge-approved">Approved</span>
        )}
        {status === 'dismissed' && (
          <span className="proposed-plan-badge proposed-plan-badge-dismissed">Dismissed</span>
        )}
      </button>

      {expanded && (
        <div className="proposed-plan-body" id={bodyPanelId}>
          {mode === 'edit' && isPending ? (
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

      {isPending && (mode === 'custom' ? (
        <div className="proposed-plan-custom">
          <textarea
            className="proposed-plan-custom-input"
            value={customText}
            onChange={(event) => setCustomText(event.target.value)}
            rows={3}
            autoFocus
            aria-label="Plan feedback"
            placeholder="Tell the agent what to change… (⌘/Ctrl+Enter to send)"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && customText.trim()) {
                event.preventDefault()
                fire(() => onCustom(customText.trim()))
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
              disabled={submitted || !customText.trim()}
              onClick={() => fire(() => onCustom(customText.trim()))}
            >
              Send response
            </button>
            {canOpenPlanFile && (
              <button
                type="button"
                className="proposed-plan-btn"
                disabled={submitted}
                onClick={handleOpenPlanFile}
              >
                Open plan file
              </button>
            )}
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
            disabled={submitted || !draftBody.trim()}
            onClick={() => fire(() => onApprove(draftBody.trim()))}
            title="Approve the edited plan and implement it"
          >
            Approve edited plan
          </button>
          {canOpenPlanFile && (
            <button
              type="button"
              className="proposed-plan-btn"
              disabled={submitted}
              onClick={handleOpenPlanFile}
            >
              Open plan file
            </button>
          )}
        </div>
      ) : (
        <div className="proposed-plan-actions">
          <button
            type="button"
            className="proposed-plan-btn proposed-plan-dismiss"
            disabled={submitted}
            onClick={() => fire(onDismiss)}
            title="Dismiss without implementing"
          >
            Dismiss
          </button>
          <button
            type="button"
            className="proposed-plan-btn"
            disabled={submitted}
            onClick={() => {
              setExpanded(true)
              setMode('custom')
            }}
          >
            Respond…
          </button>
          <button
            type="button"
            className="proposed-plan-btn"
            disabled={submitted}
            onClick={() => {
              setExpanded(true)
              setMode('edit')
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="proposed-plan-btn proposed-plan-primary"
            disabled={submitted}
            onClick={() => fire(() => onApprove(draftBody.trim()))}
            title="Approve this plan and implement it with edit permissions"
          >
            Approve &amp; implement
          </button>
          {canOpenPlanFile && (
            <button
              type="button"
              className="proposed-plan-btn"
              disabled={submitted}
              onClick={handleOpenPlanFile}
            >
              Open plan file
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
