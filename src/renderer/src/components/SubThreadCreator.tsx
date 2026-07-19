import React, { useEffect, useState } from 'react'
import type { ChatRecord, ProviderId } from '../../../main/store/types'
import { isSubThreadChat } from '../lib/chatScope'
import { isLiveSelectableProvider } from '../../../shared/retiredProviders'
import { PillButton } from './PillButton'

/**
 * SubThreadCreator — Phase F1 modal for delegating to a sub-thread.
 *
 * The user picks a provider, writes the delegation prompt, and optionally
 * asks for the result to be propagated back to the parent transcript on
 * completion. On confirm we call `api.createSubThread` to spawn the
 * sub-thread; the parent (App.tsx) navigates to the new chat and
 * pre-fills the composer with the delegation prompt so the user can
 * verify before submitting.
 *
 * v1 deliberately keeps the surface minimal:
 *   - Provider picker (4 options)
 *   - Free-text delegation prompt
 *   - Return-result checkbox (records intent, F2 will auto-propagate)
 *
 * No automatic prompt construction yet — that's Phase F2's job once we
 * have the right primitives (read the parent's last N turns and ask
 * the parent provider to draft a delegation prompt).
 */

const PROVIDER_OPTIONS: Array<{ value: ProviderId; label: string; helper: string }> = ([
  {
    value: 'gemini',
    label: 'Gemini',
    helper: 'Long-context reasoning, image inputs, project-aware planning.'
  },
  {
    value: 'codex',
    label: 'Codex',
    helper: 'Fast-twitch CLI work, shell commands, sandboxed execution.'
  },
  {
    value: 'claude',
    label: 'Claude',
    helper: 'Deep reasoning, tool use, careful code edits with strong safety.'
  },
  {
    value: 'kimi',
    label: 'Kimi',
    helper: 'Admitted ACP runtime with a governed per-run TaskWraith gateway.'
  }
] as Array<{ value: ProviderId; label: string; helper: string }>).filter(
  (opt) => isLiveSelectableProvider(opt.value)
)

interface SubThreadCreatorProps {
  /** Parent chat. The new sub-thread will inherit its workspace and
   * record its `appChatId` as the `parentChatId`. */
  parentChat: ChatRecord
  /** Called after a successful spawn. The host navigates to the new
   * chat and pre-fills the composer with the delegation prompt. */
  onCreated: (subThread: ChatRecord, delegationPrompt: string) => void
  /** Close without creating. */
  onCancel: () => void
}

export function SubThreadCreator({
  parentChat,
  onCreated,
  onCancel
}: SubThreadCreatorProps): React.JSX.Element {
  // Default the picked provider to anything OTHER than the parent's
  // current provider — the point of delegation is cross-provider.
  // First entry in the options list that doesn't match parent.provider.
  const defaultProvider: ProviderId =
    PROVIDER_OPTIONS.find((opt) => opt.value !== parentChat.provider)?.value ?? 'codex'
  const [provider, setProvider] = useState<ProviderId>(defaultProvider)
  const [delegationPrompt, setDelegationPrompt] = useState('')
  const [returnResultToParent, setReturnResultToParent] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    const trimmed = delegationPrompt.trim()
    if (!trimmed) {
      setError('Delegation prompt is required.')
      return
    }
    if (isSubThreadChat(parentChat)) {
      setError("Sub-threads can't themselves be delegated from (v1: max depth 1).")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const subThread = await window.api.createSubThread({
        parentChatId: parentChat.appChatId,
        provider,
        delegationPrompt: trimmed,
        returnResultToParent
      })
      onCreated(subThread, trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const isParentItselfSubThread = isSubThreadChat(parentChat)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div className="sub-thread-creator-backdrop" onClick={onCancel} role="presentation">
      <div
        className="sub-thread-creator"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sub-thread-creator-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sub-thread-creator-header">
          <h2 id="sub-thread-creator-title">Delegate to a sub-thread</h2>
          <button
            type="button"
            className="sub-thread-creator-close"
            onClick={onCancel}
            aria-label="Cancel"
          >
            ×
          </button>
        </header>

        <p className="sub-thread-creator-hint">
          Spawn a context-isolated sub-thread under <strong>{parentChat.title}</strong> to hand off
          part of the work to a different provider. The sub-thread inherits the parent&apos;s
          workspace.
        </p>

        {isParentItselfSubThread && (
          <div className="sub-thread-creator-error" role="alert">
            This chat is itself a sub-thread. Delegation depth is limited to 1 level in v1 — return
            to the parent thread to spawn another sibling.
          </div>
        )}

        <fieldset className="sub-thread-creator-section" disabled={isParentItselfSubThread}>
          <legend>Provider</legend>
          <div className="sub-thread-creator-provider-grid">
            {PROVIDER_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`sub-thread-creator-provider-card${
                  provider === opt.value ? ' sub-thread-creator-provider-card-active' : ''
                }`}
              >
                <input
                  type="radio"
                  name="sub-thread-provider"
                  value={opt.value}
                  checked={provider === opt.value}
                  onChange={() => setProvider(opt.value)}
                />
                <span className="sub-thread-creator-provider-label">{opt.label}</span>
                <span className="sub-thread-creator-provider-helper">{opt.helper}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="sub-thread-creator-section" disabled={isParentItselfSubThread}>
          <legend>Delegation prompt</legend>
          <textarea
            className="sub-thread-creator-textarea"
            rows={6}
            placeholder="What should the sub-thread focus on? The text is recorded for audit and pre-fills the composer in the new sub-thread."
            value={delegationPrompt}
            onChange={(e) => setDelegationPrompt(e.target.value)}
          />
        </fieldset>

        <fieldset className="sub-thread-creator-section" disabled={isParentItselfSubThread}>
          <label className="sub-thread-creator-checkbox">
            <input
              type="checkbox"
              checked={returnResultToParent}
              onChange={(e) => setReturnResultToParent(e.target.checked)}
            />
            <span>
              <strong>Return result to parent on completion.</strong>
              <span className="sub-thread-creator-helper">
                Records intent. v1 lets you navigate back manually; v2 will auto-append the
                sub-thread&apos;s final assistant message to the parent transcript.
              </span>
            </span>
          </label>
        </fieldset>

        {error && (
          <div className="sub-thread-creator-error" role="alert">
            {error}
          </div>
        )}

        <footer className="sub-thread-creator-footer">
          <PillButton onClick={onCancel} disabled={submitting}>
            Cancel
          </PillButton>
          <PillButton
            variant="primary"
            onClick={() => void submit()}
            disabled={submitting || isParentItselfSubThread}
          >
            {submitting
              ? 'Creating…'
              : `Spawn ${PROVIDER_OPTIONS.find((o) => o.value === provider)?.label} sub-thread`}
          </PillButton>
        </footer>
      </div>
    </div>
  )
}
