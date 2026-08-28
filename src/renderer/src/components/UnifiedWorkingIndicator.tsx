import type { CSSProperties, ReactNode } from 'react'
import { ThinkingIndicator } from './AppChromeSymbols'

export interface UnifiedWorkingSeat {
  id: string
  label: string
  statusLabel: string
  accentStyle?: CSSProperties
  telemetry?: ReactNode
  contextHint?: ReactNode
  onJump?: () => void
  jumpTitle?: string
}

function WorkingSeatContent({ seat }: { seat: UnifiedWorkingSeat }): ReactNode {
  return (
    <>
      <span className="message-working-label message-working-seat-label" data-label={seat.label}>
        {seat.label}
      </span>
      {seat.telemetry}
      {seat.contextHint}
    </>
  )
}

export function UnifiedWorkingIndicator({
  label,
  ariaLabel,
  seats
}: {
  label: string
  ariaLabel: string
  seats: readonly UnifiedWorkingSeat[]
}): ReactNode {
  return (
    <div className="message-working-unified">
      <ThinkingIndicator label={label} ariaLabel={ariaLabel} />
      <div className="message-working-seat-grid" role="group" aria-label="Active participant seats">
        {seats.map((seat) =>
          seat.onJump ? (
            <button
              key={seat.id}
              type="button"
              className="message-working-seat message-working-seat-jump"
              style={seat.accentStyle}
              aria-label={`${seat.statusLabel}. ${seat.jumpTitle || `Go to ${seat.label}'s fan-out lane`}`}
              title={seat.jumpTitle}
              onClick={seat.onJump}
            >
              <WorkingSeatContent seat={seat} />
            </button>
          ) : (
            <div
              key={seat.id}
              className="message-working-seat"
              style={seat.accentStyle}
              role="group"
              aria-label={seat.statusLabel}
            >
              <WorkingSeatContent seat={seat} />
            </div>
          )
        )}
      </div>
    </div>
  )
}
