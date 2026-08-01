import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_HOST_REASON_CHARS } from '../../../shared/collaboration/externalContributionLimits'

/**
 * Contributions an external has sent that are waiting for the host to release
 * them, pinned above the composer.
 *
 * WHY IT LIVES INSIDE `.composer-area`. The composer is not in flow — it is
 * absolutely positioned over the transcript — so "above but outside the
 * composer" is a z-layer band, not a flow position. `.composer-area` is the
 * bottom-anchored flex column that band is measured from:
 * `bindComposerReservation` observes that element with a ResizeObserver and a
 * subtree MutationObserver, so an in-flow child of it grows
 * `--composer-reserved-height` automatically and the transcript's last message
 * can never end up underneath this. An `.app-transcript` sibling — the
 * jump-to-latest pill's idiom — would have needed the reservation taught about
 * a second element in all three lanes (main, side chat, Multiview) plus its own
 * welcome-mode anchor. Living in the column gets all of that for nothing, and it
 * follows the composer when welcome mode relocates it.
 *
 * `.composer-area` itself is transparent and `pointer-events: none`; the VISIBLE
 * composer is `.composer-surface`, which this renders above and outside. It is
 * deliberately NOT in `.composer-above-bar-stack`, where the host's own queued
 * messages live — keeping those two apart is the point, not an accident of
 * layout.
 *
 * Self-contained by design (the HostAdmissionBanner shape): it takes a chat id
 * and owns its own fetch, so nothing has to be threaded through App or
 * MainAppLayout, and each Multiview pane resolves its own chat rather than
 * inheriting focused-only state that would leak into resting panes.
 */
export interface PendingContribution {
  entryId: string
  chatId: string
  displayName: string
  body?: string
  enqueuedAt: number
  /**
   * Approved, but the seat is muted so delivery is held. Approval is not final:
   * the row comes back here so the host can deny it or unmute the seat. Without
   * this it was invisible — gone from the stack, refused by delivery, forever.
   */
  heldByMute?: boolean
}

export function PendingContributionsStack({ chatId }: { chatId: string | null | undefined }) {
  const [pending, setPending] = useState<PendingContribution[]>([])
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null)
  /**
   * The row currently being declined, and the note being written for it.
   * Declining is two-step on purpose: the note is optional, but a one-click
   * deny gives a real collaborator nothing to act on, and a note typed into the
   * wrong row would be worse than none.
   */
  const [decliningEntryId, setDecliningEntryId] = useState<string | null>(null)
  const [declineReason, setDeclineReason] = useState('')
  /**
   * The chat this surface currently belongs to, assigned during RENDER rather
   * than in an effect so it is already current when an awaited IPC reply is
   * processed. Every fetch here is async and there are four callers (mount, the
   * update broadcast, window focus, and the refresh after approve/deny), so
   * without this a reply for the chat the host just left can land afterwards
   * and paint one chat's pending queue underneath another's transcript.
   */
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId

  const refresh = useCallback(async () => {
    if (!chatId) {
      setPending([])
      return
    }
    if (typeof window.api?.humanCollaborationListPendingContributions !== 'function') return
    try {
      const entries = await window.api.humanCollaborationListPendingContributions(chatId)
      if (chatIdRef.current !== chatId) return
      setPending(Array.isArray(entries) ? (entries as PendingContribution[]) : [])
    } catch {
      // A chat the renderer no longer owns throws by design. Showing nothing is
      // the honest result — never a stale queue from a previous chat.
      if (chatIdRef.current !== chatId) return
      setPending([])
    }
  }, [chatId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (typeof window.api?.onHumanCollaborationUpdated !== 'function') return
    const unsubscribe = window.api.onHumanCollaborationUpdated(() => {
      void refresh()
    })
    return unsubscribe
  }, [refresh])

  useEffect(() => {
    // `human-collaboration-updated` is sent to the MAIN window only, so a chat
    // popout would otherwise never learn that a contribution arrived. Refetching
    // when the window regains focus is the popout's only signal today; the
    // broadcast becoming multi-window would make this redundant rather than wrong.
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const resolve = useCallback(
    async (entryId: string, action: 'approve' | 'deny', reason?: string) => {
      setBusyEntryId(entryId)
      try {
        if (action === 'approve') {
          await window.api.humanCollaborationApproveContribution(entryId)
        } else {
          const note = reason?.trim()
          await window.api.humanCollaborationDenyContribution({
            entryId,
            ...(note ? { reason: note } : {})
          })
        }
      } catch {
        // Fall through to the refresh: main is the authority on what actually
        // happened, and a failed call must not leave the row optimistically gone.
      } finally {
        setBusyEntryId(null)
        setDecliningEntryId(null)
        setDeclineReason('')
        void refresh()
      }
    },
    [refresh]
  )

  if (pending.length === 0) return null

  return (
    <div className="pending-contributions-stack" role="group" aria-label="Pending contributions">
      {pending.map((entry) => (
        <div className="pending-contribution" key={entry.entryId}>
          <div className="pending-contribution-body">
            <div className="pending-contribution-author">
              {entry.displayName} · external
              {entry.heldByMute ? (
                <span className="pending-contribution-held"> · approved, held (seat muted)</span>
              ) : null}
            </div>
            <div className="pending-contribution-text">{entry.body ?? ''}</div>
          </div>
          {decliningEntryId === entry.entryId ? (
            <div className="pending-contribution-decline">
              <input
                type="text"
                className="pending-contribution-reason"
                aria-label={`Why you are declining ${entry.displayName}'s contribution (optional)`}
                placeholder="Optional note back to them"
                maxLength={MAX_HOST_REASON_CHARS}
                value={declineReason}
                autoFocus
                onChange={(event) => setDeclineReason(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void resolve(entry.entryId, 'deny', declineReason)
                  if (event.key === 'Escape') {
                    setDecliningEntryId(null)
                    setDeclineReason('')
                  }
                }}
              />
              <button
                type="button"
                disabled={busyEntryId === entry.entryId}
                onClick={() => void resolve(entry.entryId, 'deny', declineReason)}
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => {
                  setDecliningEntryId(null)
                  setDeclineReason('')
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="pending-contribution-actions">
              <button
                type="button"
                hidden={entry.heldByMute === true}
                className="pending-contribution-approve"
                aria-label={`Approve the contribution from ${entry.displayName}`}
                disabled={busyEntryId === entry.entryId}
                onClick={() => void resolve(entry.entryId, 'approve')}
              >
                Approve
              </button>
              <button
                type="button"
                className="pending-contribution-deny"
                aria-label={`Decline the contribution from ${entry.displayName}`}
                disabled={busyEntryId === entry.entryId}
                onClick={() => {
                  setDecliningEntryId(entry.entryId)
                  setDeclineReason('')
                }}
              >
                Decline
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
