// Provider auth status card extracted from SettingsPanel.tsx. Purely
// presentational: every dependency is shared/ or renderer-local, so this
// module adds no renderer→main runtime edge.

import type React from 'react'
import type { ProviderId } from '../../../main/store/types'
import { ProviderLogoTile } from './ProviderLogoTile'
import type { ProviderAuthSummary } from '../lib/providerAuthSummary'

export interface SettingsProviderAuthCardProps {
  provider: ProviderId
  label: string
  summary: ProviderAuthSummary
  description: string
  optional?: boolean
  children?: React.ReactNode
}

export function SettingsProviderAuthCard({
  provider,
  label,
  summary,
  description,
  optional,
  children
}: SettingsProviderAuthCardProps): React.JSX.Element {
  // The status dot has CSS for signed-in / partial / not-available only.
  // "out-of-usage" (signed in but rate-limited) reads as a warning, so
  // borrow the amber `partial` dot styling rather than fall back to the
  // neutral base dot. Grok is a CLI-owned auth surface: when the adapter is
  // available, its card should read as ready/connected even though TaskWraith
  // cannot inspect the provider's private login state. Cursor and Grok both
  // use that partial → ready-dot path.
  const dotVariant =
    summary.variant === 'out-of-usage'
      ? 'partial'
      : (provider === 'cursor' || provider === 'grok') && summary.variant === 'partial'
        ? 'signed-in'
        : summary.variant
  return (
    <article
      className={`settings-provider-auth-card settings-provider-auth-card-${summary.variant} provider-${provider}`}
      data-provider={provider}
    >
      <div className="settings-provider-auth-card-header">
        <ProviderLogoTile provider={provider} />
        <strong>{label}</strong>
        {optional && <span className="settings-provider-auth-optional">Optional</span>}
      </div>
      <div className="settings-provider-auth-status">
        <span
          className={`settings-provider-auth-status-dot settings-provider-auth-status-dot-${dotVariant}`}
          aria-hidden
        />
        <span>{summary.statusText}</span>
      </div>
      <p>{description}</p>
      <p className="settings-provider-auth-hint">{summary.hint}</p>
      {children && <div className="settings-provider-auth-actions">{children}</div>}
    </article>
  )
}
