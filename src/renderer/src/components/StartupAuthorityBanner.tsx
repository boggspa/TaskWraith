import {
  describeStartupAuthorityState,
  startupAuthorityHeadline,
  startupAuthorityNeedsAttention,
  type StartupAuthorityRecoveryState
} from '../../../shared/startupAuthority'
import { useStartupAuthorityState } from '../hooks/useStartupAuthorityState'
import './StartupAuthorityBanner.css'

export interface StartupAuthorityBannerViewProps {
  state: StartupAuthorityRecoveryState | null
  onRetry?: () => void
  retrying?: boolean
}

function tone(state: StartupAuthorityRecoveryState): 'warning' | 'error' | 'info' {
  if (state.status === 'permanently_failed') return 'error'
  if (state.status === 'available' || state.status === 'retrying') return 'info'
  return 'warning'
}

/**
 * The only user-visible signal that workspace locking is unavailable.
 *
 * Measured 2026-08-29: under authority contention, 2 of 12 launches booted with
 * run and schedule recovery disabled and the app looked completely normal. The
 * banner names what is unavailable rather than showing an error code, and
 * offers the explicit retry when the failure is transient.
 */
export function StartupAuthorityBannerView({
  state,
  onRetry,
  retrying = false
}: StartupAuthorityBannerViewProps): React.JSX.Element | null {
  if (!state || !startupAuthorityNeedsAttention(state)) return null
  const headline = startupAuthorityHeadline(state)
  const detail = describeStartupAuthorityState(state)
  if (!headline && !detail) return null
  const canRetry = Boolean(onRetry) && state.failure?.retryable === true
  return (
    <aside className="startup-authority-banner" role="status" data-tone={tone(state)}>
      <span className="startup-authority-banner__text">
        {headline ? (
          <strong className="startup-authority-banner__headline">{headline}</strong>
        ) : null}
        {detail ? <span className="startup-authority-banner__detail">{detail}</span> : null}
      </span>
      {canRetry ? (
        <button
          type="button"
          className="startup-authority-banner__retry"
          onClick={onRetry}
          disabled={retrying || state.status === 'retrying'}
        >
          {retrying || state.status === 'retrying' ? 'Retrying…' : 'Retry now'}
        </button>
      ) : null}
    </aside>
  )
}

export function StartupAuthorityBanner(): React.JSX.Element | null {
  const { state, retry, retrying } = useStartupAuthorityState()
  return (
    <StartupAuthorityBannerView state={state} onRetry={() => void retry()} retrying={retrying} />
  )
}
