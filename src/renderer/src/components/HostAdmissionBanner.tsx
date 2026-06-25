import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Host-side surface for L6-2: when a collaborator begins admission, the host's
 * runtime computes the same 6-digit SAS. This banner shows it so the host can
 * compare it OUT OF BAND with the collaborator before they accept on their end.
 * Self-contained (subscribes to the IPC event itself) so App.tsx only mounts it.
 */
interface PendingAdmission {
  handshakeId: string
  displayName: string
  confirmCode: string
}

export function HostAdmissionBanner() {
  const [pending, setPending] = useState<PendingAdmission | null>(null)

  useEffect(() => {
    const off = window.api.onHumanCollaborationAdmissionBegan?.((payload) => {
      setPending({
        handshakeId: payload.handshakeId,
        displayName: payload.displayName || 'A collaborator',
        confirmCode: payload.confirmCode
      })
    })
    return () => off?.()
  }, [])

  if (!pending) return null

  return createPortal(
    <div className="host-admission-banner" role="status">
      <div className="host-admission-banner-body">
        <div className="host-admission-banner-text">
          <strong>{pending.displayName}</strong> is joining this shared chat. Confirm this code
          matches what they see before they accept:
        </div>
        <div className="host-admission-banner-code" aria-label="Security code">
          {pending.confirmCode}
        </div>
      </div>
      <button
        type="button"
        className="host-admission-banner-dismiss"
        onClick={() => setPending(null)}
        aria-label="Dismiss"
        title="Dismiss"
      >
        ×
      </button>
    </div>,
    document.body
  )
}
