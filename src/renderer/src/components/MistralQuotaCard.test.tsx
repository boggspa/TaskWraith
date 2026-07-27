import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  MISTRAL_PLAN_ALLOWANCE_EUR,
  MistralQuotaCardView,
  toUsd,
  type MistralQuotaCardViewProps
} from './MistralQuotaCard'

/** No jsdom in this repo, so only the pure view is exercised (SSR markup). */
function render(overrides: Partial<MistralQuotaCardViewProps> = {}): string {
  const props: MistralQuotaCardViewProps = {
    plan: 'unknown',
    allowanceDraft: '',
    spentDraft: '',
    currency: 'EUR',
    resetDraft: '',
    anchoredSummary: null,
    adminKeyDraft: '',
    adminKeyConfigured: false,
    adminStatus: null,
    busy: false,
    error: null,
    onPlanChange: () => {},
    onAllowanceChange: () => {},
    onSpentChange: () => {},
    onCurrencyChange: () => {},
    onResetChange: () => {},
    onSave: () => {},
    onClear: () => {},
    onAdminKeyChange: () => {},
    onSaveAdminKey: () => {},
    onClearAdminKey: () => {},
    onRefreshAdmin: () => {},
    ...overrides
  }
  return renderToStaticMarkup(<MistralQuotaCardView {...props} />)
}

describe('MISTRAL_PLAN_ALLOWANCE_EUR', () => {
  it('carries only the allowances actually observed on a console', () => {
    // Free and Pro were read on 2026-07-27. Team was not, so it offers no
    // prefill rather than a fabricated number.
    expect(MISTRAL_PLAN_ALLOWANCE_EUR.free).toBe(8.5)
    expect(MISTRAL_PLAN_ALLOWANCE_EUR.pro).toBe(25.5)
    expect(MISTRAL_PLAN_ALLOWANCE_EUR.team).toBeNull()
    expect(MISTRAL_PLAN_ALLOWANCE_EUR.unknown).toBeNull()
  })
})

describe('toUsd', () => {
  it('passes USD through untouched', () => {
    expect(toUsd(25.5, 'USD')).toBeCloseTo(25.5, 6)
  })

  it('converts a EUR console figure upward into USD', () => {
    // EUR is worth more than USD, so the USD figure must be the larger one.
    // Asserting the direction rather than a rate keeps this from breaking every
    // time the FX table hydrates.
    expect(toUsd(25.5, 'EUR')).toBeGreaterThan(25.5)
  })

  it('refuses to turn a nonsense amount into a number that would divide by zero', () => {
    expect(toUsd(Number.NaN, 'EUR')).toBe(0)
    expect(toUsd(-5, 'EUR')).toBe(0)
  })
})

describe('MistralQuotaCardView', () => {
  it('explains why the plan cannot be detected', () => {
    const html = render()
    expect(html).toContain('cannot detect it')
    expect(html).toContain('warns early rather than late')
  })

  it('explains why the reset date matters', () => {
    expect(render()).toContain('anniversary, not the 1st of the month')
  })

  it('points at the console when no reading has been taken', () => {
    const html = render()
    expect(html).toContain('admin.mistral.ai/subscription')
    expect(html).toContain('Included')
  })

  it('summarises the reading in force instead of the instructions', () => {
    const html = render({ anchoredSummary: 'Using your reading of EUR 25.50 from 27/07/2026.' })
    expect(html).toContain('EUR 25.50')
    expect(html).not.toContain('admin.mistral.ai/subscription')
  })

  it('states the Enterprise-only restriction on the admin key up front', () => {
    const html = render()
    expect(html).toContain('Enterprise')
    expect(html).toContain('standard Mistral API key will not work')
  })

  it('renders the admin key as a password field and never echoes a stored one', () => {
    const html = render({ adminKeyConfigured: true })
    expect(html).toContain('type="password"')
    // The placeholder acknowledges a stored key without reproducing it.
    expect(html).toContain('stored')
  })

  it('disables refresh and removal until a key is actually stored', () => {
    const withoutKey = render({ adminKeyConfigured: false })
    // Both admin buttons plus "Clear reading" start disabled.
    expect((withoutKey.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(3)
    const withKey = render({ adminKeyConfigured: true, anchoredSummary: 'Using your reading.' })
    expect(withKey).toContain('Refresh from Mistral')
  })

  it('surfaces the admin outcome and the form error separately', () => {
    const html = render({
      adminStatus: 'Mistral refused the key.',
      error: 'Could not save the reading.'
    })
    expect(html).toContain('Mistral refused the key.')
    expect(html).toContain('Could not save the reading.')
  })

  it('locks every control while a write is in flight', () => {
    const html = render({ busy: true, adminKeyDraft: 'k', adminKeyConfigured: true })
    expect(html).not.toContain('<select class="settings-select">')
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(8)
  })
})
