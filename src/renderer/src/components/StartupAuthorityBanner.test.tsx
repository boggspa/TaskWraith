import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import type { StartupAuthorityRecoveryState } from '../../../shared/startupAuthority'
import { StartupAuthorityBannerView } from './StartupAuthorityBanner'

function state(
  overrides: Partial<StartupAuthorityRecoveryState> = {}
): StartupAuthorityRecoveryState {
  return {
    status: 'available',
    failure: null,
    attempts: 1,
    nextRetryAtMs: null,
    lastAttemptAtMs: 1_000,
    recoveredAfterRetry: false,
    bootRecoveryIncomplete: false,
    ...overrides
  }
}

describe('StartupAuthorityBannerView', () => {
  it('renders nothing on a healthy boot or before the first attempt reports', () => {
    expect(renderToStaticMarkup(<StartupAuthorityBannerView state={state()} />)).toBe('')
    expect(renderToStaticMarkup(<StartupAuthorityBannerView state={null} />)).toBe('')
  })

  it('says what is unavailable on a degraded boot, not just that something failed', () => {
    const html = renderToStaticMarkup(
      <StartupAuthorityBannerView
        state={state({
          status: 'degraded',
          failure: { failureClass: 'authority_busy', retryable: true, message: 'busy' }
        })}
      />
    )
    expect(html).toContain('data-tone="warning"')
    expect(html).toContain('Workspace locking unavailable')
    expect(html).toContain('Workspace edits, run recovery and scheduling stay disabled')
    expect(html).toContain('role="status"')
  })

  it('offers an explicit retry only for a transient failure', () => {
    const transient = renderToStaticMarkup(
      <StartupAuthorityBannerView
        state={state({
          status: 'degraded',
          failure: { failureClass: 'wal_identity_conflict', retryable: true, message: 'race' }
        })}
        onRetry={vi.fn()}
      />
    )
    expect(transient).toContain('Retry now')

    const permanent = renderToStaticMarkup(
      <StartupAuthorityBannerView
        state={state({
          status: 'permanently_failed',
          failure: {
            failureClass: 'wal_corrupt',
            retryable: false,
            message: 'Workspace-lock WAL is corrupt at line 9'
          }
        })}
        onRetry={vi.fn()}
      />
    )
    expect(permanent).toContain('data-tone="error"')
    expect(permanent).not.toContain('<button')
    expect(permanent).toContain('corrupt at line 9')
  })

  it('disables the button while a retry is in flight', () => {
    const html = renderToStaticMarkup(
      <StartupAuthorityBannerView
        state={state({
          status: 'degraded',
          failure: { failureClass: 'authority_busy', retryable: true, message: 'busy' }
        })}
        onRetry={vi.fn()}
        retrying
      />
    )
    expect(html).toContain('disabled=""')
    expect(html).toContain('Retrying')
  })

  it('asks for a restart when a retry recovered authority but not the boot-only work', () => {
    const html = renderToStaticMarkup(
      <StartupAuthorityBannerView
        state={state({
          status: 'available',
          recoveredAfterRetry: true,
          bootRecoveryIncomplete: true
        })}
      />
    )
    expect(html).toContain('Restart to finish recovery')
    expect(html).toContain('Restart TaskWraith to finish recovering')
    expect(html).not.toContain('<button')
  })

  it('does not nag once a mid-session retry fully recovered the boot', () => {
    expect(
      renderToStaticMarkup(
        <StartupAuthorityBannerView
          state={state({ status: 'available', recoveredAfterRetry: true })}
        />
      )
    ).toBe('')
  })
})
