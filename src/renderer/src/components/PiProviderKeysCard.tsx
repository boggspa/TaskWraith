import React, { useCallback, useEffect, useState } from 'react'
import {
  PI_CEREBRAS_30K_TPM_RECOMMENDED_MAX_COMPLETION_TOKENS,
  PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS,
  normalizePiCerebrasMaxCompletionTokens
} from '../../../shared/piCerebrasCompletionCap'
import { PillButton } from './PillButton'
import { notifyPiProviderModelCatalogMutation } from '../lib/providerModelCatalogEvents'

/**
 * Settings card for the Pi seat's BYOK upstream keys. Mirrors the
 * SettingsProviderAuthCard markup/classes so it inherits the provider-card
 * styling without widening that file-private component. Keys are write-only:
 * the renderer sees configured booleans, never values.
 *
 * The upstream list deliberately duplicates PI_ALLOWED_UPSTREAMS
 * (src/main/pi/PiModelPolicy.ts) rather than importing main-process code into
 * the renderer bundle — the accept-set duplication idiom every provider
 * surface uses. Keep them in lockstep; the wall itself is enforced main-side.
 */
export const PI_CARD_UPSTREAMS: ReadonlyArray<{ id: string; label: string; keyHint: string }> = [
  { id: 'deepseek', label: 'DeepSeek', keyHint: 'platform.deepseek.com' },
  { id: 'zai', label: 'Z.ai (GLM)', keyHint: 'z.ai coding plan' },
  { id: 'qwen-token-plan', label: 'Qwen Token Plan', keyHint: 'sk-sp-… from Alibaba' },
  { id: 'minimax', label: 'MiniMax', keyHint: 'platform.minimax.io' },
  {
    id: 'xiaomi-token-plan',
    label: 'Xiaomi Token Plan',
    keyHint: 'MiMo · one key, pick your region'
  },
  { id: 'mistral', label: 'Mistral', keyHint: 'console.mistral.ai' },
  { id: 'groq', label: 'Groq', keyHint: 'console.groq.com' },
  { id: 'cerebras', label: 'Cerebras', keyHint: 'cloud.cerebras.ai' },
  { id: 'openrouter', label: 'OpenRouter', keyHint: 'Ox Alpha only · openrouter.ai/keys' }
]

/**
 * The regional upstreams behind the single Xiaomi Token Plan card entry. Must
 * mirror XIAOMI_TOKEN_PLAN_UPSTREAMS in src/main/pi/PiModelPolicy.ts: the
 * region picker files the stored key under ONE of these ids, and saving clears
 * the other two so exactly one regional MiMo catalog surfaces in the pickers.
 */
export const XIAOMI_TOKEN_PLAN_REGIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'xiaomi-token-plan-cn', label: 'China (CN)' },
  { id: 'xiaomi-token-plan-sgp', label: 'Singapore (SGP)' },
  { id: 'xiaomi-token-plan-ams', label: 'Amsterdam (AMS)' }
]

export interface PiKeyCardStatus {
  encryptionAvailable: boolean
  configuredUpstreams: string[]
  recordUnreadable: boolean
}

export interface PiProviderKeysCardViewProps {
  status: PiKeyCardStatus | null
  binaryAvailable: boolean
  drafts: Record<string, string>
  busyUpstream: string | null
  error: string | null
  cerebrasMaxCompletionTokens: number | null
  cerebrasCapDraft: string
  cerebrasCapBusy: boolean
  cerebrasCapError: string | null
  xiaomiRegion: string
  onDraftChange: (upstream: string, value: string) => void
  onSave: (upstream: string) => void
  onClear: (upstream: string) => void
  onXiaomiRegionChange: (region: string) => void
  onSaveXiaomi: () => void
  onClearXiaomi: () => void
  onCerebrasCapDraftChange: (value: string) => void
  onSaveCerebrasCap: () => void
  onClearCerebrasCap: () => void
}

export function PiProviderKeysCardView({
  status,
  binaryAvailable,
  drafts,
  busyUpstream,
  error,
  cerebrasMaxCompletionTokens,
  cerebrasCapDraft,
  cerebrasCapBusy,
  cerebrasCapError,
  xiaomiRegion,
  onDraftChange,
  onSave,
  onClear,
  onXiaomiRegionChange,
  onSaveXiaomi,
  onClearXiaomi,
  onCerebrasCapDraftChange,
  onSaveCerebrasCap,
  onClearCerebrasCap
}: PiProviderKeysCardViewProps): React.JSX.Element {
  const configured = new Set(status?.configuredUpstreams ?? [])
  const configuredCount = configured.size
  const summaryVariant = !binaryAvailable
    ? 'not-available'
    : configuredCount > 0
      ? 'signed-in'
      : 'partial'
  const statusText = !binaryAvailable
    ? 'Pi CLI not installed'
    : configuredCount > 0
      ? `${configuredCount} upstream ${configuredCount === 1 ? 'key' : 'keys'} configured`
      : 'No upstream keys yet'
  return (
    <article
      className={`settings-provider-auth-card settings-provider-auth-card-${summaryVariant} provider-pi`}
      data-provider="pi"
    >
      <div className="settings-provider-auth-card-header">
        <strong>Pi</strong>
        <span className="settings-provider-auth-optional">Optional</span>
      </div>
      <div className="settings-provider-auth-status">
        <span
          className={`settings-provider-auth-status-dot settings-provider-auth-status-dot-${summaryVariant}`}
          aria-hidden
        />
        <span>{statusText}</span>
      </div>
      <p>
        Your own API keys for Pi&apos;s curated upstream models — DeepSeek, GLM, Qwen, MiniMax,
        Xiaomi&apos;s MiMo, Mistral, open-weights serving, and OpenRouter&apos;s Ox Alpha.
      </p>
      <div className="settings-provider-auth-command">
        <code>npm install -g @earendil-works/pi-coding-agent</code>
        <span>Install the Pi CLI once, then add keys for the upstreams you use.</span>
      </div>
      {status?.recordUnreadable && (
        <p className="settings-provider-auth-footnote">
          The stored key record could not be read. Clear all Pi keys to recover, then re-add them.
        </p>
      )}
      {status && !status.encryptionAvailable && (
        <p className="settings-provider-auth-footnote">
          System keychain encryption is unavailable, so keys cannot be stored right now.
        </p>
      )}
      {error && <p className="settings-provider-auth-footnote">{error}</p>}
      <div className="settings-pi-upstream-list">
        {PI_CARD_UPSTREAMS.map((upstream) => {
          // The Xiaomi Token Plan is ONE card entry backed by three regional
          // upstream ids; the picker beneath the key field chooses which one.
          if (upstream.id === 'xiaomi-token-plan') {
            const configuredRegions = XIAOMI_TOKEN_PLAN_REGIONS.filter((region) =>
              configured.has(region.id)
            )
            const activeRegion = configuredRegions[0]
            const busy = busyUpstream === upstream.id
            return (
              <div className="settings-pi-upstream-row" key={upstream.id}>
                <div className="settings-pi-upstream-name">
                  <span
                    className={`settings-provider-auth-status-dot settings-provider-auth-status-dot-${activeRegion ? 'signed-in' : 'not-available'}`}
                    aria-hidden
                  />
                  <strong>{upstream.label}</strong>
                  <span className="settings-pi-upstream-hint">
                    {activeRegion
                      ? `Key stored — ${XIAOMI_TOKEN_PLAN_REGIONS.find((region) => region.id === activeRegion.id)?.label ?? activeRegion.id}`
                      : upstream.keyHint}
                  </span>
                </div>
                <div className="settings-pi-upstream-controls">
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={activeRegion ? 'Key stored — replace…' : 'API key'}
                    value={drafts[upstream.id] ?? ''}
                    onChange={(event) => onDraftChange(upstream.id, event.target.value)}
                  />
                  <PillButton
                    size="compact"
                    variant="primary"
                    disabled={busy || !drafts[upstream.id]?.trim()}
                    onClick={onSaveXiaomi}
                  >
                    Save
                  </PillButton>
                  <PillButton
                    size="compact"
                    variant="danger"
                    disabled={busy || !activeRegion}
                    onClick={onClearXiaomi}
                  >
                    Clear
                  </PillButton>
                </div>
                <div className="settings-pi-upstream-controls settings-pi-xiaomi-region">
                  <select
                    aria-label="Xiaomi Token Plan region"
                    value={xiaomiRegion}
                    disabled={busy}
                    onChange={(event) => onXiaomiRegionChange(event.target.value)}
                  >
                    {XIAOMI_TOKEN_PLAN_REGIONS.map((region) => (
                      <option key={region.id} value={region.id}>
                        Region: {region.label}
                      </option>
                    ))}
                  </select>
                  <span className="settings-pi-upstream-hint">
                    The region your key was issued for. Saving files the key under this region only.
                  </span>
                </div>
              </div>
            )
          }
          const isConfigured = configured.has(upstream.id)
          const draft = drafts[upstream.id] ?? ''
          const busy = busyUpstream === upstream.id
          return (
            <div className="settings-pi-upstream-row" key={upstream.id}>
              <div className="settings-pi-upstream-name">
                <span
                  className={`settings-provider-auth-status-dot settings-provider-auth-status-dot-${isConfigured ? 'signed-in' : 'not-available'}`}
                  aria-hidden
                />
                <strong>{upstream.label}</strong>
                <span className="settings-pi-upstream-hint">{upstream.keyHint}</span>
              </div>
              <div className="settings-pi-upstream-controls">
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={isConfigured ? 'Key stored — replace…' : 'API key'}
                  value={draft}
                  onChange={(event) => onDraftChange(upstream.id, event.target.value)}
                />
                <PillButton
                  size="compact"
                  variant="primary"
                  disabled={busy || !draft.trim()}
                  onClick={() => onSave(upstream.id)}
                >
                  Save
                </PillButton>
                <PillButton
                  size="compact"
                  variant="danger"
                  disabled={busy || !isConfigured}
                  onClick={() => onClear(upstream.id)}
                >
                  Clear
                </PillButton>
              </div>
            </div>
          )
        })}
      </div>
      <div className="settings-pi-upstream-row">
        <label className="settings-pi-upstream-name" htmlFor="pi-cerebras-completion-cap">
          <strong>Cerebras completion cap</strong>
          <span className="settings-pi-upstream-hint">
            {cerebrasMaxCompletionTokens === null
              ? `Optional — Pi default: ${PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS.toLocaleString()} tokens`
              : `Active: ${cerebrasMaxCompletionTokens.toLocaleString()} max output tokens`}
          </span>
        </label>
        <div className="settings-pi-upstream-controls">
          <input
            id="pi-cerebras-completion-cap"
            type="number"
            inputMode="numeric"
            min={1}
            max={PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS}
            step={1}
            aria-label="Cerebras maximum completion tokens"
            value={cerebrasCapDraft}
            disabled={cerebrasCapBusy}
            onChange={(event) => onCerebrasCapDraftChange(event.target.value)}
          />
          <PillButton
            size="compact"
            variant="primary"
            disabled={cerebrasCapBusy || !cerebrasCapDraft.trim()}
            onClick={onSaveCerebrasCap}
          >
            Apply cap
          </PillButton>
          <PillButton
            size="compact"
            variant="danger"
            disabled={cerebrasCapBusy || cerebrasMaxCompletionTokens === null}
            onClick={onClearCerebrasCap}
          >
            Use Pi default
          </PillButton>
        </div>
      </div>
      {cerebrasCapError && <p className="settings-provider-auth-footnote">{cerebrasCapError}</p>}
    </article>
  )
}

/** Renderer-safe text for a PiKeyMutationError. */
function describePiKeyError(error: unknown): string {
  return error === 'encryptionUnavailable'
    ? 'System keychain encryption is unavailable.'
    : error === 'existingRecordUnreadable'
      ? 'The stored record is unreadable; clear all Pi keys to recover.'
      : 'Could not update the key. Check the value and try again.'
}

export function PiProviderKeysCard({
  binaryAvailable = true
}: {
  /** Install-state is advisory only; dispatch fails honestly without the CLI. */
  binaryAvailable?: boolean
} = {}): React.JSX.Element {
  const [status, setStatus] = useState<PiKeyCardStatus | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busyUpstream, setBusyUpstream] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cerebrasMaxCompletionTokens, setCerebrasMaxCompletionTokens] = useState<number | null>(
    null
  )
  const [cerebrasCapDraft, setCerebrasCapDraft] = useState(
    String(PI_CEREBRAS_30K_TPM_RECOMMENDED_MAX_COMPLETION_TOKENS)
  )
  const [cerebrasCapBusy, setCerebrasCapBusy] = useState(false)
  const [cerebrasCapError, setCerebrasCapError] = useState<string | null>(null)
  // Which regional Xiaomi upstream the next Save files the key under.
  // Singapore is the default because Xiaomi auto-routes most new keys there.
  const [xiaomiRegion, setXiaomiRegion] = useState<string>('xiaomi-token-plan-sgp')

  const refresh = useCallback(async () => {
    const [keyStatus, settings] = await Promise.allSettled([
      window.api.getPiKeyStatus(),
      window.api.getSettings()
    ])
    if (keyStatus.status === 'fulfilled') {
      const next = keyStatus.value
      setStatus({
        encryptionAvailable: next.encryptionAvailable === true,
        configuredUpstreams: Array.isArray(next.configuredUpstreams)
          ? next.configuredUpstreams
          : [],
        recordUnreadable: next.recordUnreadable === true
      })
    } else {
      setStatus(null)
    }
    if (settings.status === 'fulfilled') {
      const cap = normalizePiCerebrasMaxCompletionTokens(
        settings.value.piCerebrasMaxCompletionTokens
      )
      setCerebrasMaxCompletionTokens(cap ?? null)
      setCerebrasCapDraft(String(cap ?? PI_CEREBRAS_30K_TPM_RECOMMENDED_MAX_COMPLETION_TOKENS))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const mutate = useCallback(
    async (upstream: string, action: 'save' | 'clear') => {
      setBusyUpstream(upstream)
      setError(null)
      try {
        const result =
          action === 'save'
            ? await window.api.setPiUpstreamKey(upstream, drafts[upstream] ?? '')
            : await window.api.clearPiUpstreamKey(upstream)
        if (!result.ok) {
          setError(describePiKeyError(result.error))
        } else if (action === 'save') {
          setDrafts((prev) => ({ ...prev, [upstream]: '' }))
        }
        if (result.ok) notifyPiProviderModelCatalogMutation()
        setStatus({
          encryptionAvailable: result.status.encryptionAvailable === true,
          configuredUpstreams: Array.isArray(result.status.configuredUpstreams)
            ? result.status.configuredUpstreams
            : [],
          recordUnreadable: result.status.recordUnreadable === true
        })
      } catch {
        setError('Could not update the key.')
      } finally {
        setBusyUpstream(null)
      }
    },
    [drafts]
  )

  // One card entry over three regional upstream ids: Save files the key under
  // the picked region, then clears the other two so exactly one regional MiMo
  // catalog is ever configured (and surfaced in the model pickers).
  const mutateXiaomi = useCallback(
    async (action: 'save' | 'clear') => {
      const cardId = 'xiaomi-token-plan'
      setBusyUpstream(cardId)
      setError(null)
      let last: Awaited<ReturnType<typeof window.api.setPiUpstreamKey>> | null = null
      try {
        if (action === 'save') {
          const result = await window.api.setPiUpstreamKey(xiaomiRegion, drafts[cardId] ?? '')
          last = result
          if (!result.ok) {
            setError(describePiKeyError(result.error))
            return
          }
          setDrafts((prev) => ({ ...prev, [cardId]: '' }))
          for (const region of XIAOMI_TOKEN_PLAN_REGIONS) {
            if (region.id !== xiaomiRegion) {
              last = await window.api.clearPiUpstreamKey(region.id)
            }
          }
        } else {
          for (const region of XIAOMI_TOKEN_PLAN_REGIONS) {
            last = await window.api.clearPiUpstreamKey(region.id)
          }
        }
        if (!last?.ok) {
          setError('Could not update the key.')
          return
        }
        notifyPiProviderModelCatalogMutation()
        setStatus({
          encryptionAvailable: last.status.encryptionAvailable === true,
          configuredUpstreams: Array.isArray(last.status.configuredUpstreams)
            ? last.status.configuredUpstreams
            : [],
          recordUnreadable: last.status.recordUnreadable === true
        })
      } catch {
        setError('Could not update the key.')
      } finally {
        setBusyUpstream(null)
      }
    },
    [drafts, xiaomiRegion]
  )

  const saveCerebrasCap = useCallback(async () => {
    const cap = normalizePiCerebrasMaxCompletionTokens(Number(cerebrasCapDraft))
    if (cap === undefined) {
      setCerebrasCapError(
        `Enter a whole number from 1 to ${PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS.toLocaleString()}.`
      )
      return
    }
    setCerebrasCapBusy(true)
    setCerebrasCapError(null)
    try {
      await window.api.updateSettings({ piCerebrasMaxCompletionTokens: cap })
      setCerebrasMaxCompletionTokens(cap)
      setCerebrasCapDraft(String(cap))
    } catch {
      setCerebrasCapError('Could not save the Cerebras completion cap.')
    } finally {
      setCerebrasCapBusy(false)
    }
  }, [cerebrasCapDraft])

  const clearCerebrasCap = useCallback(async () => {
    setCerebrasCapBusy(true)
    setCerebrasCapError(null)
    try {
      await window.api.updateSettings({ piCerebrasMaxCompletionTokens: null })
      setCerebrasMaxCompletionTokens(null)
      setCerebrasCapDraft(String(PI_CEREBRAS_30K_TPM_RECOMMENDED_MAX_COMPLETION_TOKENS))
    } catch {
      setCerebrasCapError('Could not restore Pi’s default Cerebras completion limit.')
    } finally {
      setCerebrasCapBusy(false)
    }
  }, [])

  return (
    <PiProviderKeysCardView
      status={status}
      binaryAvailable={binaryAvailable}
      drafts={drafts}
      busyUpstream={busyUpstream}
      error={error}
      cerebrasMaxCompletionTokens={cerebrasMaxCompletionTokens}
      cerebrasCapDraft={cerebrasCapDraft}
      cerebrasCapBusy={cerebrasCapBusy}
      cerebrasCapError={cerebrasCapError}
      xiaomiRegion={xiaomiRegion}
      onDraftChange={(upstream, value) => setDrafts((prev) => ({ ...prev, [upstream]: value }))}
      onSave={(upstream) => void mutate(upstream, 'save')}
      onClear={(upstream) => void mutate(upstream, 'clear')}
      onXiaomiRegionChange={setXiaomiRegion}
      onSaveXiaomi={() => void mutateXiaomi('save')}
      onClearXiaomi={() => void mutateXiaomi('clear')}
      onCerebrasCapDraftChange={setCerebrasCapDraft}
      onSaveCerebrasCap={() => void saveCerebrasCap()}
      onClearCerebrasCap={() => void clearCerebrasCap()}
    />
  )
}
