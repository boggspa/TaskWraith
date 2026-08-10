import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { getProviderLabel } from '../../../shared/providerLabels'
import {
  CODEX_HARNESS_TW_ONLY_NOTE,
  CURSOR_HARNESS_SUPPRESS_DISCLOSURE,
  DEFAULT_PROVIDER_HARNESS_POSTURES,
  mergeProviderHarnessPosture,
  normalizeProviderHarnessPostureMap,
  resolveProviderHarnessPosture,
  type HarnessPassthroughMode,
  type HarnessProviderId,
  type ProviderHarnessPosture,
  type ProviderHarnessPostureMap
} from '../../../shared/providerHarnessPosture'
import type { ProviderId } from '../../../main/store/types'

const MODE_OPTIONS: { value: HarnessPassthroughMode; label: string }[] = [
  { value: 'tw-only', label: 'TaskWraith only' },
  { value: 'allow-native', label: 'Allow native' },
  { value: 'suppress', label: 'Suppress native' }
]

const EDITABLE_PROVIDERS: readonly HarnessProviderId[] = [
  'claude',
  'pi',
  'kimi',
  'cursor',
  'codex',
  'grok',
  'ollama',
  'mistral',
  'muse',
  'antigravity'
]

export interface ProviderPassthroughSettingsProps {
  postureMap: ProviderHarnessPostureMap
  onChange: (next: ProviderHarnessPostureMap) => void | Promise<void>
  busy?: boolean
  error?: string | null
}

function modeSelect(
  provider: HarnessProviderId,
  channel: 'skills' | 'hooks',
  value: HarnessPassthroughMode,
  busy: boolean,
  onSelect: (
    provider: HarnessProviderId,
    channel: 'skills' | 'hooks',
    mode: HarnessPassthroughMode
  ) => void
): React.JSX.Element {
  return (
    <label className="settings-effects-check-row" style={{ gap: 8, margin: 0 }}>
      <span style={{ minWidth: 48 }}>{channel === 'skills' ? 'Skills' : 'Hooks'}</span>
      <select
        value={value}
        disabled={busy}
        aria-label={`${getProviderLabel(provider as ProviderId)} ${channel} posture`}
        onChange={(event) =>
          onSelect(provider, channel, event.target.value as HarnessPassthroughMode)
        }
      >
        {MODE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function ProviderPassthroughSettings({
  postureMap,
  onChange,
  busy = false,
  error = null
}: ProviderPassthroughSettingsProps): React.JSX.Element {
  const rows = useMemo(() => {
    return EDITABLE_PROVIDERS.map((provider) => ({
      provider,
      posture: resolveProviderHarnessPosture(provider, postureMap)
    }))
  }, [postureMap])

  const handleSelect = useCallback(
    (provider: HarnessProviderId, channel: 'skills' | 'hooks', mode: HarnessPassthroughMode) => {
      const current = resolveProviderHarnessPosture(provider, postureMap)
      const nextPosture: ProviderHarnessPosture = mergeProviderHarnessPosture(current, {
        [channel]: mode
      })
      const nextMap: ProviderHarnessPostureMap = {
        ...postureMap,
        [provider]: nextPosture
      }
      // Drop entries that match the built-in default so the stored map stays sparse.
      const defaults = DEFAULT_PROVIDER_HARNESS_POSTURES[provider]
      if (nextPosture.skills === defaults.skills && nextPosture.hooks === defaults.hooks) {
        const { [provider]: _removed, ...rest } = nextMap
        void onChange(rest)
        return
      }
      void onChange(nextMap)
    },
    [onChange, postureMap]
  )

  return (
    <div className="settings-section" style={{ marginTop: 24 }}>
      <div className="settings-section-header">
        <h4 className="sidebar-section-title" style={{ margin: 0 }}>
          Provider passthrough
        </h4>
        <p className="settings-hint">
          Per-provider skills/hooks posture for managed launches. Defaults keep today&apos;s
          containment (Claude/Pi/Kimi suppress native; Cursor allows native; Codex tw-only via
          private home).
        </p>
      </div>
      {error ? <div className="settings-audit-empty">{error}</div> : null}
      <div className="settings-user-mcp-list">
        {rows.map(({ provider, posture }) => {
          const showCursorDisclosure =
            provider === 'cursor' && (posture.skills === 'suppress' || posture.hooks === 'suppress')
          return (
            <article key={provider} className="settings-user-mcp-row">
              <div className="settings-user-mcp-main">
                <strong>{getProviderLabel(provider as ProviderId)}</strong>
                <div className="settings-mcp-server-meta" style={{ gap: 12, flexWrap: 'wrap' }}>
                  {modeSelect(provider, 'skills', posture.skills, busy, handleSelect)}
                  {modeSelect(provider, 'hooks', posture.hooks, busy, handleSelect)}
                </div>
                {provider === 'codex' ? (
                  <p className="settings-hint" style={{ marginTop: 8 }}>
                    {CODEX_HARNESS_TW_ONLY_NOTE}
                  </p>
                ) : null}
                {showCursorDisclosure ? (
                  <p className="settings-hint" style={{ marginTop: 8 }}>
                    {CURSOR_HARNESS_SUPPRESS_DISCLOSURE}
                  </p>
                ) : null}
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

export interface ProviderPassthroughSettingsHostProps {
  /** Optional external map; when omitted the host loads from app settings. */
  postureMap?: ProviderHarnessPostureMap
  onChange?: (next: ProviderHarnessPostureMap) => void | Promise<void>
}

/**
 * Loads / persists `providerHarnessPosture` via `window.api` settings IPC.
 * Works alongside skillsHooksSettingsApi panes; settings bridge is independent
 * of skills:/hooks: preload wiring.
 */
export function ProviderPassthroughSettingsHost({
  postureMap: controlledMap,
  onChange: controlledOnChange
}: ProviderPassthroughSettingsHostProps = {}): React.JSX.Element {
  const [localMap, setLocalMap] = useState<ProviderHarnessPostureMap>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controlled = controlledMap !== undefined

  useEffect(() => {
    if (controlled) return
    if (typeof window === 'undefined' || typeof window.api?.getSettings !== 'function') return
    let cancelled = false
    void window.api
      .getSettings()
      .then((settings) => {
        if (cancelled) return
        setLocalMap(normalizeProviderHarnessPostureMap(settings?.providerHarnessPosture))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [controlled])

  const postureMap = controlled ? controlledMap : localMap

  const onChange = useCallback(
    async (next: ProviderHarnessPostureMap) => {
      if (controlledOnChange) {
        await controlledOnChange(next)
        return
      }
      setLocalMap(next)
      if (typeof window === 'undefined' || typeof window.api?.updateSettings !== 'function') {
        setError('Settings IPC is unavailable — posture changes stay in this session.')
        return
      }
      try {
        setBusy(true)
        setError(null)
        await window.api.updateSettings({ providerHarnessPosture: next })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [controlledOnChange]
  )

  return (
    <ProviderPassthroughSettings
      postureMap={postureMap}
      onChange={onChange}
      busy={busy}
      error={error}
    />
  )
}
