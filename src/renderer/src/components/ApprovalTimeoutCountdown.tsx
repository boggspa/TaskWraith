import { memo, useMemo, useRef } from 'react'
import { useSharedNowTick } from '../hooks/useSharedNowTick'
import { formatApprovalCountdown } from '../lib/approvalTimeoutCountdown'

/**
 * Isolated approval auto-deny countdown.
 *
 * The shared 1 Hz tick must live in this leaf. Subscribing from ComposerInner
 * reconciled the whole composer (textarea, pickers, overlay, preview) every
 * second while the user needed the Allow/Deny/Grant buttons to stay clickable.
 */
export const ApprovalTimeoutCountdown = memo(function ApprovalTimeoutCountdown({
  approvalId,
  timeoutMs
}: {
  approvalId: string
  timeoutMs: number
}) {
  const lastIdRef = useRef<string | null>(null)
  const appearedAtRef = useRef(Date.now())
  if (lastIdRef.current !== approvalId) {
    lastIdRef.current = approvalId
    appearedAtRef.current = Date.now()
  }
  const tick = useSharedNowTick(true)
  const remainingMs = useMemo(
    () => Math.max(0, appearedAtRef.current + timeoutMs - Date.now()),
    [tick, timeoutMs, approvalId]
  )
  return (
    <div
      id="composer-agent-approval-countdown"
      className="composer-permission-countdown"
      role="status"
      aria-live="polite"
    >
      Auto-denies in {formatApprovalCountdown(remainingMs)}
    </div>
  )
})
