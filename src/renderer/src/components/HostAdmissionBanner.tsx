import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Host-side surface for L6-2: when a collaborator begins admission, the host's
 * runtime computes the same 6-digit SAS. This banner shows it so the host can
 * compare it OUT OF BAND with the collaborator before they accept on their end,
 * and Reject (revoke the share) if the codes don't match.
 *
 * Keyed by handshakeId so two near-simultaneous collaborators each get their own
 * code (a single-slot banner would clobber one), and each entry auto-expires so
 * a stale code can't linger after the collaborator has joined/abandoned.
 */
interface PendingAdmission {
  handshakeId: string
  shareId: string
  displayName: string
  confirmCode: string
  /** 'reconnect' = pinned-identity re-admission: no SAS compare happens, so the
   * banner must not show a code or a codes-don't-match Reject. */
  mode: 'admission' | 'reconnect'
}

const ADMISSION_TTL_MS = 120_000
const RECONNECT_NOTICE_TTL_MS = 20_000
/** Newest-wins ceiling on simultaneous cards. A share admits two collaborators,
 * so anything past a handful is a producer misbehaving, not a real queue. */
const MAX_PENDING_CARDS = 5

export function hostAdmissionRejectAriaLabel(displayName: string): string {
  return `Reject ${displayName}'s join attempt and stop sharing`
}

/**
 * Turn an admission-began IPC payload into a card. Every field is derived from
 * REMOTE input, so this is the last gate before it becomes a JSX child.
 *
 * `displayName` is type-checked, not merely defaulted: main normalizes it, but
 * `payload.displayName || fallback` lets any truthy non-string through, and a
 * plain object as a React child makes React throw. There is no boundary between
 * this banner and the root one, so that blanks the host's entire window until
 * they reload it.
 *
 * Exported and pure so it can be tested — this repo has no DOM environment, so
 * the mounted stack cannot be driven from a test at all.
 */
export function toPendingAdmission(payload: {
  handshakeId: string
  shareId: string
  displayName?: unknown
  confirmCode: string
  mode?: unknown
}): PendingAdmission {
  return {
    handshakeId: payload.handshakeId,
    shareId: payload.shareId,
    displayName:
      typeof payload.displayName === 'string' && payload.displayName
        ? payload.displayName
        : 'A collaborator',
    confirmCode: payload.confirmCode,
    // Missing mode (older main process) = first admission: fail toward the
    // SAS-compare card, never toward the quieter reconnect notice.
    mode: payload.mode === 'reconnect' ? 'reconnect' : 'admission'
  }
}

/**
 * Add a card, newest wins, bounded.
 *
 * `handshakeId` is a fresh uuid per begin, so the same-id filter never removes
 * anything and the stack only grows — one unbounded producer upstream papers
 * the host's screen in cards they cannot dismiss. Main throttles the handshake
 * lane now; this is the backstop that does not depend on it.
 *
 * Returns the dropped entries too, so the caller can clear their timers rather
 * than leaking one per evicted card.
 */
export function admitToPendingStack(
  current: readonly PendingAdmission[],
  entry: PendingAdmission,
  max = MAX_PENDING_CARDS
): { next: PendingAdmission[]; dropped: PendingAdmission[] } {
  const merged = [...current.filter((p) => p.handshakeId !== entry.handshakeId), entry]
  const overflow = Math.max(0, merged.length - max)
  return { next: merged.slice(overflow), dropped: merged.slice(0, overflow) }
}

export function HostAdmissionBannerCard({
  entry,
  onReject,
  onDismiss
}: {
  entry: PendingAdmission
  onReject: () => void
  onDismiss: () => void
}) {
  if (entry.mode === 'reconnect') {
    // Pinned-identity reconnect: the collaborator's device verified the host key
    // automatically — there is no code to compare, and offering a "Reject"
    // framed as a code mismatch would invite an accidental share revoke.
    return (
      <div className="host-admission-banner" role="status">
        <div className="host-admission-banner-body">
          <div className="host-admission-banner-text">
            <strong>{entry.displayName}</strong> is reconnecting to this People chat from their
            previously verified device. No code check is needed.
          </div>
        </div>
        <div className="host-admission-banner-actions">
          <button
            type="button"
            className="host-admission-banner-dismiss"
            onClick={onDismiss}
            aria-label="Dismiss"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="host-admission-banner" role="status">
      <div className="host-admission-banner-body">
        <div className="host-admission-banner-text">
          <strong>{entry.displayName}</strong> is joining this People chat. Confirm this code
          matches what they see before they accept:
        </div>
        <div
          className="host-admission-banner-code"
          aria-label={`Security code ${entry.confirmCode}`}
        >
          {entry.confirmCode}
        </div>
      </div>
      <div className="host-admission-banner-actions">
        <button
          type="button"
          className="host-admission-banner-reject"
          onClick={onReject}
          aria-label={hostAdmissionRejectAriaLabel(entry.displayName)}
          title="Codes don't match — stop sharing"
        >
          Reject
        </button>
        <button
          type="button"
          className="host-admission-banner-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  )
}

export function HostAdmissionBanner() {
  const [pending, setPending] = useState<PendingAdmission[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((handshakeId: string) => {
    const timer = timersRef.current.get(handshakeId)
    if (timer) clearTimeout(timer)
    timersRef.current.delete(handshakeId)
    setPending((current) => current.filter((p) => p.handshakeId !== handshakeId))
  }, [])

  useEffect(() => {
    const off = window.api.onHumanCollaborationAdmissionBegan?.((payload) => {
      const entry = toPendingAdmission(payload)
      setPending((current) => {
        const { next, dropped } = admitToPendingStack(current, entry)
        for (const stale of dropped) {
          const timer = timersRef.current.get(stale.handshakeId)
          if (timer) clearTimeout(timer)
          timersRef.current.delete(stale.handshakeId)
        }
        return next
      })
      const existing = timersRef.current.get(entry.handshakeId)
      if (existing) clearTimeout(existing)
      timersRef.current.set(
        entry.handshakeId,
        setTimeout(
          () => dismiss(entry.handshakeId),
          entry.mode === 'reconnect' ? RECONNECT_NOTICE_TTL_MS : ADMISSION_TTL_MS
        )
      )
    })
    return () => {
      off?.()
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [dismiss])

  const reject = useCallback(
    (entry: PendingAdmission) => {
      // Codes don't match → revoke the share so the collaborator can't establish
      // (or is dropped if they already did).
      void window.api.humanCollaborationRevokeShare?.(entry.shareId)
      dismiss(entry.handshakeId)
    },
    [dismiss]
  )

  if (pending.length === 0) return null

  return createPortal(
    <div className="host-admission-banner-stack">
      {pending.map((entry) => (
        <HostAdmissionBannerCard
          key={entry.handshakeId}
          entry={entry}
          onReject={() => reject(entry)}
          onDismiss={() => dismiss(entry.handshakeId)}
        />
      ))}
    </div>,
    document.body
  )
}
