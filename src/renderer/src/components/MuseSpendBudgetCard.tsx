import { useEffect, useState } from 'react'
import {
  DEFAULT_MUSE_MONTHLY_SPEND_CAP_USD,
  resolveMuseMonthlySpendCapUsd
} from '../../../shared/museSpendBudget'

export interface MuseSpendBudgetCardProps {
  /** Persisted soft cap. `undefined` → default $15; `null` → no meter. */
  monthlySpendCapUsd?: number | null
  onChange: (next: { museMonthlySpendCapUsd: number | null }) => void
}

/**
 * Settings control for Muse's advisory calendar-month spend budget.
 * Mirrors the AntiGravity Gemini API soft-cap field without an opt-in wall.
 */
export function MuseSpendBudgetCard({ monthlySpendCapUsd, onChange }: MuseSpendBudgetCardProps) {
  const effective = resolveMuseMonthlySpendCapUsd(monthlySpendCapUsd)
  const [spendCapInput, setSpendCapInput] = useState(effective !== null ? String(effective) : '')

  useEffect(() => {
    const next = resolveMuseMonthlySpendCapUsd(monthlySpendCapUsd)
    setSpendCapInput(next !== null ? String(next) : '')
  }, [monthlySpendCapUsd])

  const commitSpendCap = () => {
    const trimmed = spendCapInput.trim()
    if (!trimmed) {
      if (monthlySpendCapUsd !== null) {
        onChange({ museMonthlySpendCapUsd: null })
      }
      return
    }
    const value = Number(trimmed)
    if (Number.isFinite(value) && value > 0) {
      onChange({ museMonthlySpendCapUsd: Math.min(value, 1_000_000) })
      return
    }
    const revert = resolveMuseMonthlySpendCapUsd(monthlySpendCapUsd)
    setSpendCapInput(revert !== null ? String(revert) : '')
  }

  return (
    <div className="muse-spend-budget-card">
      <label className="settings-provider-auth-field">
        <span>Monthly budget — soft cap, USD</span>
        <input
          data-testid="muse-monthly-spend-cap"
          type="number"
          min={0}
          step="1"
          inputMode="decimal"
          value={spendCapInput}
          onChange={(event) => setSpendCapInput(event.target.value)}
          onBlur={commitSpendCap}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitSpendCap()
          }}
          placeholder={`e.g. ${DEFAULT_MUSE_MONTHLY_SPEND_CAP_USD} — leave empty for no cap`}
          aria-label="Monthly Muse spend budget in US dollars (soft cap)"
        />
      </label>
      <p className="settings-provider-auth-footnote">
        Advisory only: fills the Model Usage spend meter from the 1st of each month and warns as
        estimated spend approaches the cap. Default is ${DEFAULT_MUSE_MONTHLY_SPEND_CAP_USD}.00.
        Never blocks a run — set a hard limit in Meta / Model API billing if you need one.
      </p>
    </div>
  )
}
