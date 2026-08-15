import { useCallback, useEffect, useState, type ReactElement } from 'react'
import {
  API_USAGE_BILLING_CURRENCIES,
  normalizeApiUsageBillingSettings,
  type ApiUsageBillingCurrency,
  type ApiUsageBillingSettings
} from '../../../shared/apiUsageBilling'
import { PillButton } from './PillButton'
import {
  apiUsageBillingDraftsFromSettings,
  apiUsageBillingFromDrafts,
  configuredApiUsageProviderCount,
  EMPTY_API_USAGE_BILLING_DRAFTS,
  type ApiUsageBillingDrafts
} from './ApiUsageQuotaCardModel'

export interface ApiUsageQuotaCardViewProps {
  drafts: ApiUsageBillingDrafts
  configuredCount: number
  busy: boolean
  error: string | null
  saved: boolean
  onChange: <K extends keyof ApiUsageBillingDrafts>(
    field: K,
    value: ApiUsageBillingDrafts[K]
  ) => void
  onSave: () => void
  onClear: () => void
}

function MoneyField({
  label,
  value,
  placeholder,
  disabled,
  onChange
}: {
  label: string
  value: string
  placeholder: string
  disabled: boolean
  onChange: (value: string) => void
}): ReactElement {
  return (
    <label className="settings-field">
      <span className="settings-field-label">{label}</span>
      <input
        className="settings-input"
        inputMode="decimal"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

function CurrencyField({
  label,
  value,
  disabled,
  onChange
}: {
  label: string
  value: ApiUsageBillingCurrency
  disabled: boolean
  onChange: (value: ApiUsageBillingCurrency) => void
}): ReactElement {
  return (
    <label className="settings-field">
      <span className="settings-field-label">{label}</span>
      <select
        className="settings-select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as ApiUsageBillingCurrency)}
      >
        {API_USAGE_BILLING_CURRENCIES.map((currency) => (
          <option value={currency} key={currency}>
            {currency}
          </option>
        ))}
      </select>
    </label>
  )
}

export function ApiUsageQuotaCardView({
  drafts,
  configuredCount,
  busy,
  error,
  saved,
  onChange,
  onSave,
  onClear
}: ApiUsageQuotaCardViewProps): ReactElement {
  return (
    <div className="settings-provider-auth-card provider-pi" data-provider="api-usage">
      <div className="settings-provider-auth-header">
        <span className="settings-provider-auth-title">API usage and credit anchors</span>
      </div>
      <p>
        TaskWraith reads DeepSeek&apos;s official balance directly. Cerebras and Meta do not expose
        equivalent stable usage APIs, so copy the non-secret figures from their billing consoles;
        TaskWraith keeps adding its own recorded spend on top. API keys stay in the encrypted Pi
        card above.
      </p>

      <strong>DeepSeek</strong>
      <div className="settings-field-row">
        <MoneyField
          label="Total topped up"
          value={drafts.deepseekTotalTopUp}
          placeholder="10"
          disabled={busy}
          onChange={(value) => onChange('deepseekTotalTopUp', value)}
        />
        <MoneyField
          label="Monthly soft budget (USD)"
          value={drafts.deepseekMonthlyBudgetUsd}
          placeholder="20"
          disabled={busy}
          onChange={(value) => onChange('deepseekMonthlyBudgetUsd', value)}
        />
      </div>
      <p className="settings-provider-auth-footnote">
        Total topped up minus the live DeepSeek balance produces the credit-used quota meter.
      </p>

      <div className="settings-provider-auth-divider" />
      <strong>Cerebras</strong>
      <div className="settings-field-row">
        <MoneyField
          label="Purchased credits"
          value={drafts.cerebrasPurchasedCredits}
          placeholder="20"
          disabled={busy}
          onChange={(value) => onChange('cerebrasPurchasedCredits', value)}
        />
        <MoneyField
          label="Current balance"
          value={drafts.cerebrasCurrentBalance}
          placeholder="6.50"
          disabled={busy}
          onChange={(value) => onChange('cerebrasCurrentBalance', value)}
        />
        <CurrencyField
          label="Billing currency"
          value={drafts.cerebrasCurrency}
          disabled={busy}
          onChange={(value) => onChange('cerebrasCurrency', value)}
        />
        <MoneyField
          label="Monthly soft budget (USD)"
          value={drafts.cerebrasMonthlyBudgetUsd}
          placeholder="25"
          disabled={busy}
          onChange={(value) => onChange('cerebrasMonthlyBudgetUsd', value)}
        />
      </div>
      <p className="settings-provider-auth-footnote">
        Enter purchased and remaining credits together. The separate TaskWraith estimate remains
        visibly labelled as an estimate, never as a Cerebras invoice.
      </p>

      <div className="settings-provider-auth-divider" />
      <strong>Meta / Muse</strong>
      <div className="settings-field-row">
        <MoneyField
          label="Preload credit"
          value={drafts.metaPreloadCredits}
          placeholder="15"
          disabled={busy}
          onChange={(value) => onChange('metaPreloadCredits', value)}
        />
        <MoneyField
          label="Remaining balance"
          value={drafts.metaRemainingBalance}
          placeholder="14.95"
          disabled={busy}
          onChange={(value) => onChange('metaRemainingBalance', value)}
        />
        <MoneyField
          label="Payment threshold"
          value={drafts.metaPaymentThreshold}
          placeholder="20"
          disabled={busy}
          onChange={(value) => onChange('metaPaymentThreshold', value)}
        />
        <MoneyField
          label="Spend so far"
          value={drafts.metaSpent}
          placeholder="0.05"
          disabled={busy}
          onChange={(value) => onChange('metaSpent', value)}
        />
        <CurrencyField
          label="Billing currency"
          value={drafts.metaCurrency}
          disabled={busy}
          onChange={(value) => onChange('metaCurrency', value)}
        />
        <MoneyField
          label="Monthly soft budget (USD)"
          value={drafts.metaMonthlyBudgetUsd}
          placeholder="15"
          disabled={busy}
          onChange={(value) => onChange('metaMonthlyBudgetUsd', value)}
        />
      </div>
      <div className="settings-field-row">
        <label className="settings-field">
          <span className="settings-field-label">Plan label</span>
          <input
            className="settings-input"
            placeholder="API Credits"
            value={drafts.metaPlanName}
            disabled={busy}
            onChange={(event) => onChange('metaPlanName', event.target.value)}
          />
        </label>
        <label className="settings-field">
          <span className="settings-field-label">Billing resets on</span>
          <input
            className="settings-input"
            type="date"
            value={drafts.metaResetAt}
            disabled={busy}
            onChange={(event) => onChange('metaResetAt', event.target.value)}
          />
        </label>
      </div>
      <p className="settings-provider-auth-footnote">
        Saving a Meta reading starts a new anchor. Later Muse runs recorded by TaskWraith advance
        spend and remaining-credit meters without another external app.
      </p>

      <div className="settings-provider-auth-actions">
        <PillButton size="compact" onClick={onSave} disabled={busy}>
          Save API readings
        </PillButton>
        <PillButton
          size="compact"
          variant="danger"
          onClick={onClear}
          disabled={busy || configuredCount === 0}
        >
          Clear readings
        </PillButton>
      </div>
      {error ? <p className="settings-provider-auth-error">{error}</p> : null}
      {saved ? (
        <p className="settings-provider-auth-footnote">API usage readings saved.</p>
      ) : configuredCount > 0 ? (
        <p className="settings-provider-auth-footnote">
          {configuredCount} API billing {configuredCount === 1 ? 'provider is' : 'providers are'}
          {' currently anchored.'}
        </p>
      ) : null}
    </div>
  )
}

export function ApiUsageQuotaCard(): ReactElement {
  const [drafts, setDrafts] = useState<ApiUsageBillingDrafts>(EMPTY_API_USAGE_BILLING_DRAFTS)
  const [stored, setStored] = useState<ApiUsageBillingSettings | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api
      .getSettings()
      .then((settings) => {
        if (cancelled) return
        const billing = normalizeApiUsageBillingSettings(settings.apiUsageBilling)
        setStored(billing)
        setDrafts(apiUsageBillingDraftsFromSettings(billing))
      })
      .catch(() => {
        if (!cancelled) setError('Could not load API usage readings.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const next = apiUsageBillingFromDrafts(drafts, stored)
      await window.api.updateSettings({ apiUsageBilling: next ?? null })
      setStored(next)
      setDrafts(apiUsageBillingDraftsFromSettings(next))
      setSaved(true)
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : 'Could not save API usage readings.'
      )
    } finally {
      setBusy(false)
    }
  }, [drafts, stored])

  const clear = useCallback(async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await window.api.updateSettings({ apiUsageBilling: null })
      setStored(undefined)
      setDrafts(EMPTY_API_USAGE_BILLING_DRAFTS)
    } catch {
      setError('Could not clear API usage readings.')
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <ApiUsageQuotaCardView
      drafts={drafts}
      configuredCount={configuredApiUsageProviderCount(stored)}
      busy={busy}
      error={error}
      saved={saved}
      onChange={(field, value) => {
        setSaved(false)
        setDrafts((current) => ({ ...current, [field]: value }))
      }}
      onSave={() => void save()}
      onClear={() => void clear()}
    />
  )
}
