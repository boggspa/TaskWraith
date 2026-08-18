import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { getFxRatesPerUsd, type DisplayCurrency } from '../lib/formatCost'
import { PillButton } from './PillButton'

/**
 * Settings card for the Mistral seat's quota meter.
 *
 * WHY THIS EXISTS AT ALL. The meter's two inputs — which plan you are on, and
 * what your allowance is — are both undiscoverable from the run lane:
 *
 *   - Nothing Vibe sends over ACP reports the plan, so the store's `setPlan` had
 *     no caller anywhere and every seat metered as `unknown`.
 *   - The allowance appears in no public pricing page. The only place it exists
 *     is the user's own admin.mistral.ai/subscription page, which is also the
 *     only place the real reset date shows up ("Resets in 26 days" — an account
 *     anniversary, not the 1st of the month).
 *
 * WHICH BAR TO TYPE IN. That page shows TWO. Since ~3 Aug 2026 the Vibe CLI
 * debits only the "Vibe Code budget" bar (€255 on Pro), NOT the shared
 * "Included monthly usage" bar (€25.50) — measured 2026-08-06: €5.49 of Vibe
 * spend moved the Vibe bar and left the shared bar unchanged to the cent. So
 * this card asks for the Vibe Code budget. Typing the shared figure in would
 * meter the seat against roughly a tenth of its real ceiling.
 *
 * So the user reads their console and types both in. That is not a workaround —
 * for a non-Enterprise seat it is the single most accurate source available, and
 * it outranks every heuristic in MistralQuotaEstimate.ts.
 *
 * CURRENCY. The console reports EUR. Conversion to USD happens HERE, using the
 * renderer's live FX table, so the main-process model stays currency-free (see
 * its purity note). The figure the user actually typed rides along as
 * `declared`, so the meter's tooltip can quote it back in the currency they saw.
 *
 * Pure view + thin IPC shell, matching PiProviderKeysCard — this repo has no
 * jsdom, so only the pure half is testable.
 */

export type MistralCardPlan = 'unknown' | 'free' | 'pro' | 'team'

/**
 * Allowances observed on real consoles, offered as a one-tap prefill so the
 * common case does not require reading two numbers. Still only a prefill: the
 * user's own figure always wins, because these came from one account and Mistral
 * publish them nowhere.
 */
export const MISTRAL_PLAN_ALLOWANCE_EUR: Readonly<Record<MistralCardPlan, number | null>> = {
  unknown: null,
  free: 8.5,
  pro: 25.5,
  // Not observed — Team is offered without a prefill rather than with a guess.
  team: null
}

const PLAN_OPTIONS: ReadonlyArray<{ id: MistralCardPlan; label: string }> = [
  { id: 'unknown', label: 'Not set' },
  { id: 'free', label: 'Free' },
  { id: 'pro', label: 'Pro' },
  { id: 'team', label: 'Team' }
]

const CURRENCIES: ReadonlyArray<DisplayCurrency> = ['EUR', 'USD', 'GBP']

/** Convert a console figure into the USD the main-process model expects. */
export function toUsd(amount: number, currency: DisplayCurrency): number {
  if (!Number.isFinite(amount) || amount < 0) return 0
  if (currency === 'USD') return amount
  const perUsd = getFxRatesPerUsd()[currency]
  // A missing or nonsensical rate must not silently scale the figure to zero
  // or infinity; fall back to treating it as USD and let the declared figure
  // preserve what the user actually saw.
  if (!Number.isFinite(perUsd) || perUsd <= 0) return amount
  return amount / perUsd
}

export interface MistralQuotaCardViewProps {
  plan: MistralCardPlan
  allowanceDraft: string
  spentDraft: string
  currency: DisplayCurrency
  resetDraft: string
  /** Summary of the reading currently in force, or null when unanchored. */
  anchoredSummary: string | null
  adminKeyDraft: string
  adminKeyConfigured: boolean
  /** Outcome of the last admin fetch, in plain language. */
  adminStatus: string | null
  busy: boolean
  error: string | null
  onPlanChange: (plan: MistralCardPlan) => void
  onAllowanceChange: (value: string) => void
  onSpentChange: (value: string) => void
  onCurrencyChange: (currency: DisplayCurrency) => void
  onResetChange: (value: string) => void
  onSave: () => void
  onClear: () => void
  onAdminKeyChange: (value: string) => void
  onSaveAdminKey: () => void
  onClearAdminKey: () => void
  onRefreshAdmin: () => void
  /** Projection only — the imported cookie itself never reaches the renderer. */
  webSessionStatus: { configured: boolean; updatedAt?: string } | null
  onImportWebSession: () => void
  onClearWebSession: () => void
}

export function MistralQuotaCardView({
  plan,
  allowanceDraft,
  spentDraft,
  currency,
  resetDraft,
  anchoredSummary,
  adminKeyDraft,
  adminKeyConfigured,
  adminStatus,
  webSessionStatus,
  onImportWebSession,
  onClearWebSession,
  busy,
  error,
  onPlanChange,
  onAllowanceChange,
  onSpentChange,
  onCurrencyChange,
  onResetChange,
  onSave,
  onClear,
  onAdminKeyChange,
  onSaveAdminKey,
  onClearAdminKey,
  onRefreshAdmin
}: MistralQuotaCardViewProps): ReactElement {
  return (
    <div className="settings-provider-auth-card provider-mistral">
      <div className="settings-provider-auth-header">
        <span className="settings-provider-auth-title">Mistral usage meter</span>
      </div>

      <label className="settings-field">
        <span className="settings-field-label">Plan</span>
        <select
          className="settings-select"
          value={plan}
          disabled={busy}
          onChange={(event) => onPlanChange(event.target.value as MistralCardPlan)}
        >
          {PLAN_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <p className="settings-provider-auth-footnote">
        Nothing the Vibe CLI sends reports your plan, so the meter cannot detect it. Left unset it
        assumes the smallest allowance, which warns early rather than late.
      </p>

      <div className="settings-field-row">
        <label className="settings-field">
          <span className="settings-field-label">Vibe Code budget</span>
          <input
            className="settings-input"
            inputMode="decimal"
            placeholder="255"
            value={allowanceDraft}
            disabled={busy}
            onChange={(event) => onAllowanceChange(event.target.value)}
          />
        </label>
        <label className="settings-field">
          <span className="settings-field-label">Used so far</span>
          <input
            className="settings-input"
            inputMode="decimal"
            placeholder="21.30"
            value={spentDraft}
            disabled={busy}
            onChange={(event) => onSpentChange(event.target.value)}
          />
        </label>
        <label className="settings-field">
          <span className="settings-field-label">Currency</span>
          <select
            className="settings-select"
            value={currency}
            disabled={busy}
            onChange={(event) => onCurrencyChange(event.target.value as DisplayCurrency)}
          >
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="settings-provider-auth-footnote">
        Read these off the <strong>Vibe Code budget</strong> bar on your Mistral subscription page,
        not the shared &ldquo;Included monthly usage&rdquo; bar above it. Vibe Code spends from its
        own budget, so the shared bar stays still while this seat runs.
      </p>

      <label className="settings-field">
        <span className="settings-field-label">Resets on (optional)</span>
        <input
          className="settings-input"
          type="date"
          value={resetDraft}
          disabled={busy}
          onChange={(event) => onResetChange(event.target.value)}
        />
      </label>
      <p className="settings-provider-auth-footnote">
        Mistral bills on your account&apos;s own anniversary, not the 1st of the month. Without this
        the meter guesses a month from when it first saw the seat, which can be weeks out.
      </p>

      <div className="settings-provider-auth-actions">
        <PillButton size="compact" onClick={onSave} disabled={busy}>
          Save reading
        </PillButton>
        <PillButton
          size="compact"
          variant="danger"
          onClick={onClear}
          disabled={busy || !anchoredSummary}
        >
          Clear reading
        </PillButton>
      </div>

      <div className="settings-provider-auth-divider" />

      <div className="settings-field">
        <span className="settings-field-label">Web session</span>
        <p className="settings-provider-auth-footnote">
          {webSessionStatus?.configured
            ? `Session imported${formatImportedOn(webSessionStatus.updatedAt)}. Both console bars — API usage and Vibe Code usage — refresh from it automatically.`
            : 'Sign in once and TaskWraith reads both console bars — API usage and Vibe Code usage — for you. The session cookie is kept in the system keychain and never shown.'}
        </p>
        <div className="settings-provider-auth-actions settings-web-session-actions">
          <PillButton size="compact" variant="primary" onClick={onImportWebSession} disabled={busy}>
            {webSessionStatus?.configured ? 'Re-import web session…' : 'Import web session…'}
          </PillButton>
          <PillButton
            size="compact"
            variant="danger"
            onClick={onClearWebSession}
            disabled={busy || webSessionStatus?.configured !== true}
          >
            Clear session
          </PillButton>
        </div>
      </div>

      <label className="settings-field">
        <span className="settings-field-label">Mistral Admin API key (optional)</span>
        <input
          className="settings-input"
          type="password"
          autoComplete="off"
          placeholder={adminKeyConfigured ? '•••••••• stored' : 'from backoffice.mistral.ai'}
          value={adminKeyDraft}
          disabled={busy}
          onChange={(event) => onAdminKeyChange(event.target.value)}
        />
      </label>
      <p className="settings-provider-auth-footnote">
        Enterprise-only alternative to the web session: an Admin API key from backoffice.mistral.ai
        reads the same usage over Mistral&rsquo;s Admin API.
      </p>
      <div className="settings-provider-auth-actions">
        <PillButton
          size="compact"
          onClick={onSaveAdminKey}
          disabled={busy || !adminKeyDraft.trim()}
        >
          Save key
        </PillButton>
        <PillButton size="compact" onClick={onRefreshAdmin} disabled={busy || !adminKeyConfigured}>
          Refresh from Mistral
        </PillButton>
        <PillButton
          size="compact"
          variant="danger"
          onClick={onClearAdminKey}
          disabled={busy || !adminKeyConfigured}
        >
          Remove key
        </PillButton>
      </div>
      {adminStatus ? <p className="settings-provider-auth-footnote">{adminStatus}</p> : null}

      {error ? <p className="settings-provider-auth-error">{error}</p> : null}
      {anchoredSummary ? (
        <p className="settings-provider-auth-footnote">{anchoredSummary}</p>
      ) : (
        <p className="settings-provider-auth-footnote">
          Open admin.mistral.ai/subscription and copy the two numbers from the &ldquo;Included
          monthly usage&rdquo; bar. The meter keeps counting locally on top of your reading until
          you refresh it.
        </p>
      )}
    </div>
  )
}

function parseAmount(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed.replace(/[^0-9.]/g, ''))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function formatImportedOn(updatedAt: string | undefined): string {
  if (!updatedAt) return ''
  const when = new Date(updatedAt)
  if (Number.isNaN(when.getTime())) return ''
  return ` ${when.toLocaleDateString()}`
}

export function MistralQuotaCard(): ReactElement {
  const [plan, setPlan] = useState<MistralCardPlan>('unknown')
  const [allowanceDraft, setAllowanceDraft] = useState('')
  const [spentDraft, setSpentDraft] = useState('')
  const [currency, setCurrency] = useState<DisplayCurrency>('EUR')
  const [resetDraft, setResetDraft] = useState('')
  const [anchoredSummary, setAnchoredSummary] = useState<string | null>(null)
  const [adminKeyDraft, setAdminKeyDraft] = useState('')
  const [adminKeyConfigured, setAdminKeyConfigured] = useState(false)
  const [adminStatus, setAdminStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [webSessionStatus, setWebSessionStatus] = useState<{
    configured: boolean
    updatedAt?: string
  } | null>(null)

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.getMistralWebSessionStatus !== 'function') return
    let cancelled = false
    void api
      .getMistralWebSessionStatus()
      .then((status) => {
        if (!cancelled) setWebSessionStatus(status ?? null)
      })
      .catch(() => {
        // Leave it reading unconfigured — Clear stays disabled, which is the
        // safe direction.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const importWebSession = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.importMistralWebSession !== 'function') return
    setBusy(true)
    setError(null)
    try {
      const outcome = await api.importMistralWebSession()
      if (outcome?.ok) {
        setWebSessionStatus(outcome.status ?? { configured: true })
      } else if (outcome && outcome.reason !== 'cancelled') {
        // Closing the sign-in window without finishing is not an error.
        setError('Could not import the web session.')
      }
    } catch {
      setError('Could not import the web session.')
    } finally {
      setBusy(false)
    }
  }, [])

  const clearWebSession = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.clearMistralWebSession !== 'function') return
    setBusy(true)
    setError(null)
    try {
      const result = await api.clearMistralWebSession()
      if (result?.ok) setWebSessionStatus({ configured: false })
      else setError('Could not clear the web session.')
    } catch {
      setError('Could not clear the web session.')
    } finally {
      setBusy(false)
    }
  }, [])

  const absorb = useCallback((snapshot: unknown) => {
    const snap = snapshot as { plan?: string; estimate?: Record<string, unknown> } | null
    if (!snap) {
      setAnchoredSummary(null)
      return
    }
    if (
      snap.plan === 'free' ||
      snap.plan === 'pro' ||
      snap.plan === 'team' ||
      snap.plan === 'unknown'
    ) {
      setPlan(snap.plan)
    }
    const estimate = snap.estimate
    const ceilingSource = estimate?.ceilingSource as
      | { confidence?: string; declared?: { amount: number; currency: string }; asOf?: string }
      | undefined
    if (ceilingSource?.confidence === 'anchored' || ceilingSource?.confidence === 'reported') {
      const declared = ceilingSource.declared
      const when = ceilingSource.asOf ? new Date(ceilingSource.asOf) : null
      setAnchoredSummary(
        [
          'Using your reading',
          declared ? `of ${declared.currency} ${declared.amount.toFixed(2)}` : null,
          when && !Number.isNaN(when.getTime()) ? `from ${when.toLocaleDateString()}` : null
        ]
          .filter(Boolean)
          .join(' ') + '.'
      )
    } else {
      setAnchoredSummary(null)
    }
  }, [])

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.getMistralQuotaEstimate !== 'function') return
    let cancelled = false
    void api
      .getMistralQuotaEstimate()
      .then((snapshot) => {
        if (!cancelled) absorb(snapshot)
      })
      .catch(() => {
        // A failed read just leaves the form empty; nothing is destroyed.
      })
    return () => {
      cancelled = true
    }
  }, [absorb])

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.getMistralAdminKeyStatus !== 'function') return
    let cancelled = false
    void api
      .getMistralAdminKeyStatus()
      .then((status) => {
        if (!cancelled) setAdminKeyConfigured(status?.configured === true)
      })
      .catch(() => {
        // Leave it reading unconfigured — the buttons stay disabled, which is
        // the safe direction.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const changePlan = useCallback(
    (next: MistralCardPlan) => {
      setPlan(next)
      // Prefill the allowance from the observed figure for that plan, but never
      // overwrite something the user has already typed.
      const prefill = MISTRAL_PLAN_ALLOWANCE_EUR[next]
      if (prefill !== null && !allowanceDraft.trim()) {
        setAllowanceDraft(prefill.toFixed(2))
        setCurrency('EUR')
      }
      const api = typeof window !== 'undefined' ? window.api : undefined
      if (typeof api?.setMistralPlan !== 'function') return
      void api
        .setMistralPlan(next)
        .then(absorb)
        .catch(() => setError('Could not save the plan.'))
    },
    [absorb, allowanceDraft]
  )

  const save = useCallback(() => {
    const allowance = parseAmount(allowanceDraft)
    const spent = parseAmount(spentDraft)
    if (allowance === null || allowance <= 0) {
      setError('Enter the included monthly usage figure from your Mistral console.')
      return
    }
    if (spent === null) {
      setError('Enter how much of it you have used so far (0 is fine).')
      return
    }
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.setMistralQuotaAnchor !== 'function') return
    setBusy(true)
    setError(null)
    void api
      .setMistralQuotaAnchor({
        allowanceUsd: toUsd(allowance, currency),
        spentUsd: toUsd(spent, currency),
        ...(resetDraft ? { cycleResetsAt: new Date(`${resetDraft}T00:00:00Z`).toISOString() } : {}),
        declared: { allowance, spent, currency }
      })
      .then(absorb)
      .catch(() => setError('Could not save the reading.'))
      .finally(() => setBusy(false))
  }, [absorb, allowanceDraft, currency, resetDraft, spentDraft])

  const clear = useCallback(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.clearMistralQuotaAnchor !== 'function') return
    setBusy(true)
    void api
      .clearMistralQuotaAnchor()
      .then(absorb)
      .catch(() => setError('Could not clear the reading.'))
      .finally(() => setBusy(false))
  }, [absorb])

  const saveAdminKey = useCallback(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.setMistralAdminKey !== 'function') return
    setBusy(true)
    setError(null)
    void api
      .setMistralAdminKey(adminKeyDraft.trim())
      .then((result) => {
        if (!result?.ok) {
          setError(
            result?.error === 'encryptionUnavailable'
              ? 'This machine has no secure credential storage available, so the key cannot be saved.'
              : 'Could not save the key.'
          )
          return
        }
        // Never keep the key in renderer state once it is stored.
        setAdminKeyDraft('')
        setAdminKeyConfigured(true)
        setAdminStatus('Key stored. Use “Refresh from Mistral” to pull your usage.')
      })
      .catch(() => setError('Could not save the key.'))
      .finally(() => setBusy(false))
  }, [adminKeyDraft])

  const clearAdminKey = useCallback(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.clearMistralAdminKey !== 'function') return
    setBusy(true)
    void api
      .clearMistralAdminKey()
      .then(() => {
        setAdminKeyConfigured(false)
        setAdminStatus(null)
      })
      .catch(() => setError('Could not remove the key.'))
      .finally(() => setBusy(false))
  }, [])

  const refreshAdmin = useCallback(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.refreshMistralAdminUsage !== 'function') return
    setBusy(true)
    setError(null)
    void api
      .refreshMistralAdminUsage()
      .then((result) => {
        if (result?.ok) {
          absorb(result.snapshot ?? null)
          setAdminStatus('Usage read from Mistral’s Admin API.')
          return
        }
        // Say which wall was hit. "unauthorized" is by far the likeliest and
        // means the plan or the key type is wrong, not that something broke.
        setAdminStatus(
          result?.failure === 'unauthorized'
            ? 'Mistral refused the key. The Admin API is Enterprise-only, and a standard API key never grants admin access.'
            : result?.failure === 'no-key'
              ? 'No admin key stored.'
              : result?.failure === 'rate-limited'
                ? 'Mistral rate-limited the request. Try again shortly.'
                : result?.failure === 'unparseable'
                  ? 'Mistral answered in a shape this build does not recognise, so nothing was changed.'
                  : 'Could not reach Mistral’s Admin API.'
        )
      })
      .catch(() => setError('Could not reach Mistral’s Admin API.'))
      .finally(() => setBusy(false))
  }, [absorb])

  return (
    <MistralQuotaCardView
      plan={plan}
      allowanceDraft={allowanceDraft}
      spentDraft={spentDraft}
      currency={currency}
      resetDraft={resetDraft}
      anchoredSummary={anchoredSummary}
      adminKeyDraft={adminKeyDraft}
      adminKeyConfigured={adminKeyConfigured}
      adminStatus={adminStatus}
      webSessionStatus={webSessionStatus}
      onImportWebSession={() => void importWebSession()}
      onClearWebSession={() => void clearWebSession()}
      busy={busy}
      error={error}
      onPlanChange={changePlan}
      onAllowanceChange={setAllowanceDraft}
      onSpentChange={setSpentDraft}
      onCurrencyChange={setCurrency}
      onResetChange={setResetDraft}
      onSave={save}
      onClear={clear}
      onAdminKeyChange={setAdminKeyDraft}
      onSaveAdminKey={saveAdminKey}
      onClearAdminKey={clearAdminKey}
      onRefreshAdmin={refreshAdmin}
    />
  )
}
