import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProviderId } from '../../../main/store/types'
import { getProviderName } from './Sidebar'
import { ProviderLogoTile } from './ProviderLogoTile'
import { PillButton } from './PillButton'
import {
  CACHE_GUARANTEE_DETAILS,
  DEFAULT_PROMPT_CACHE_POLICY,
  fetchPromptCachePolicy,
  fetchProviderCacheCapabilities,
  fetchProviderCacheDiagnostics,
  guaranteeBadgeClass,
  savePromptCachePolicy,
  summarizeCapabilitiesByProvider,
  type PromptCacheMode,
  type PromptCachePolicySettings,
  type ProviderCacheCapabilitySummary,
  type ProviderCacheDiagnostics
} from '../lib/promptCacheUi'
import './ModelUsageSettingsTable.css'
import './PromptCacheSettingsSection.css'

const VISIBLE_PROVIDERS: ProviderId[] = [
  'claude',
  'codex',
  'kimi',
  'grok',
  'cursor',
  'ollama'
]

const MODE_OPTIONS: Array<{ value: PromptCacheMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'auto', label: 'Auto' },
  { value: 'explicit', label: 'Explicit' }
]

function formatDiagnostics(row?: ProviderCacheDiagnostics): string {
  if (!row) return '—'
  const read = row.cacheReadInputTokens ?? 0
  const write = row.cacheCreationInputTokens ?? 0
  if (read === 0 && write === 0) return 'No cache tokens reported'
  return `${read.toLocaleString()} read · ${write.toLocaleString()} write`
}

export function PromptCacheSettingsSection(): React.JSX.Element {
  const [policy, setPolicy] = useState<PromptCachePolicySettings>(DEFAULT_PROMPT_CACHE_POLICY)
  const [capabilities, setCapabilities] = useState<ProviderCacheCapabilitySummary[]>([])
  const [diagnostics, setDiagnostics] = useState<ProviderCacheDiagnostics[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const capabilityByProvider = useMemo(
    () => summarizeCapabilitiesByProvider(capabilities),
    [capabilities]
  )
  const diagnosticsByProvider = useMemo(() => {
    const map = new Map<ProviderId, ProviderCacheDiagnostics>()
    for (const row of diagnostics) map.set(row.provider, row)
    return map
  }, [diagnostics])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const [nextPolicy, nextCapabilities, nextDiagnostics] = await Promise.all([
        fetchPromptCachePolicy(),
        fetchProviderCacheCapabilities(),
        fetchProviderCacheDiagnostics()
      ])
      setPolicy(nextPolicy)
      setCapabilities(nextCapabilities)
      setDiagnostics(nextDiagnostics)
    } catch (refreshError) {
      setError(String(refreshError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const persistPolicy = async (next: PromptCachePolicySettings): Promise<void> => {
    setSaving(true)
    setError('')
    const result = await savePromptCachePolicy(next)
    if (!result.ok) {
      setError(result.error || 'Could not save prompt cache policy.')
      setSaving(false)
      return
    }
    setPolicy(next)
    setSaving(false)
  }

  const setProviderMode = (provider: ProviderId, mode: PromptCacheMode): void => {
    const next: PromptCachePolicySettings = {
      ...policy,
      providers: {
        ...policy.providers,
        [provider]: { mode }
      }
    }
    void persistPolicy(next)
  }

  return (
    <div className="settings-group span-all prompt-cache-settings">
      <div className="prompt-cache-settings-header">
        <div>
          <h4 className="sidebar-section-title">Prompt caching</h4>
          <p className="prompt-cache-settings-note">
            Guarantee tiers are honest by transport. Controllable API/BYOK paths can request caching
            when TaskWraith owns the request; opaque CLI transports are best-effort or automatic
            (observed only). Diagnostics show reported cache read/write tokens from recent runs — not
            a billing invoice.
          </p>
        </div>
        <PillButton size="compact" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </PillButton>
      </div>

      <label className="prompt-cache-settings-global settings-effects-check-row">
        <input
          type="checkbox"
          checked={policy.enabled}
          disabled={saving}
          onChange={(event) => {
            void persistPolicy({ ...policy, enabled: event.target.checked })
          }}
        />
        <span>
          Enable prompt cache policy
          <small>When off, TaskWraith does not apply cache controls even on controllable API paths.</small>
        </span>
      </label>

      <section className="prompt-cache-table-section model-usage-table-section" aria-label="Prompt cache by provider">
        <div className="model-usage-table-header">
          <span>Provider</span>
          <span>Guarantee</span>
          <span>Mode</span>
          <span>Last-run diagnostics</span>
        </div>
        <div className="prompt-cache-table-scroll model-usage-table-scroll">
          <table className="prompt-cache-table">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Transport / tier</th>
                <th scope="col">Policy mode</th>
                <th scope="col">Reported tokens</th>
              </tr>
            </thead>
            <tbody>
              {VISIBLE_PROVIDERS.map((provider) => {
                const capability = capabilityByProvider[provider]
                const diag = diagnosticsByProvider.get(provider)
                const mode = policy.providers?.[provider]?.mode ?? capability?.defaultMode ?? 'off'
                const tier = capability?.guaranteeTier ?? 'unsupported'
                const modeDisabled = !policy.enabled || !capability?.supportsModeControl || saving
                return (
                  <tr key={provider} className={`provider-row provider-${provider}`}>
                    <td>
                      <div className="prompt-cache-provider-cell">
                        <ProviderLogoTile provider={provider} size={18} />
                        <span>{getProviderName(provider)}</span>
                      </div>
                    </td>
                    <td>
                      <span className={guaranteeBadgeClass(tier)}>
                        {capability?.guaranteeLabel ?? 'Unsupported'}
                      </span>
                      <div className="prompt-cache-detail">
                        {capability?.transport ? `${capability.transport.replace(/-/g, ' ')} · ` : ''}
                        {CACHE_GUARANTEE_DETAILS[tier]}
                      </div>
                    </td>
                    <td>
                      <select
                        className="settings-select prompt-cache-mode-select"
                        value={mode}
                        disabled={modeDisabled}
                        onChange={(event) =>
                          setProviderMode(provider, event.target.value as PromptCacheMode)
                        }
                      >
                        {MODE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <span className="prompt-cache-diagnostics">{formatDiagnostics(diag)}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {error && <p className="prompt-cache-settings-error">{error}</p>}
      <p className="prompt-cache-settings-footnote">
        Runnable opaque CLI paths (Codex login, Claude Code, Kimi/Grok, Path-B Cursor) cannot be
        forced to cache from TaskWraith. Cursor rows cover live Path-B managed runs as well as
        historical cache metadata.
      </p>
    </div>
  )
}
