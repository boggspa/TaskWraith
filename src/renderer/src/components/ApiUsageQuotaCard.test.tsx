import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiUsageQuotaCardView, type ApiUsageQuotaCardViewProps } from './ApiUsageQuotaCard'
import {
  apiUsageBillingDraftsFromSettings,
  apiUsageBillingFromDrafts
} from './ApiUsageQuotaCardModel'

const drafts = apiUsageBillingDraftsFromSettings({
  deepseek: { totalTopUp: 10 },
  cerebras: { purchasedCredits: 20, currentBalance: 6.5, currency: 'GBP' },
  meta: {
    preloadCredits: 15,
    remainingBalance: 14.95,
    spent: 0.05,
    currency: 'EUR',
    resetAt: '2026-09-01T00:00:00.000Z',
    planName: 'API Credits'
  }
})

function render(overrides: Partial<ApiUsageQuotaCardViewProps> = {}): string {
  return renderToStaticMarkup(
    <ApiUsageQuotaCardView
      drafts={drafts}
      configuredCount={3}
      busy={false}
      error={null}
      saved={false}
      onChange={() => {}}
      onSave={() => {}}
      onClear={() => {}}
      {...overrides}
    />
  )
}

describe('ApiUsageQuotaCardView', () => {
  it('renders in-house billing controls for DeepSeek, Cerebras and Meta', () => {
    const html = render()
    expect(html).toContain('API usage and credit anchors')
    expect(html).toContain('DeepSeek')
    expect(html).toContain('Cerebras')
    expect(html).toContain('Meta / Muse')
    expect(html).toContain('Total topped up')
    expect(html).toContain('Purchased credits')
    expect(html).toContain('Spend so far')
    expect(html).toContain('Token plan browser imports')
    expect(html).toContain('platform.xiaomimimo.com')
    expect(html).toContain('modelstudio.console.alibabacloud.com')
    expect(html).toContain('dev.meta.ai/billing')
    expect(html).toContain('cloud.cerebras.ai/platform')
    expect(html).toContain('3 API billing providers are currently anchored')
    expect(html).not.toContain('type="password"')
  })

  it('shows validation failures without losing the form', () => {
    const html = render({ error: 'Enter both Cerebras figures.' })
    expect(html).toContain('Enter both Cerebras figures.')
    expect(html).toContain('value="6.5"')
  })
})

describe('apiUsageBillingFromDrafts', () => {
  it('creates a fresh Meta watermark only when billing readings change', () => {
    const now = Date.parse('2026-08-15T12:00:00.000Z')
    const first = apiUsageBillingFromDrafts(drafts, undefined, now)
    expect(first).toEqual(
      expect.objectContaining({
        deepseek: { totalTopUp: 10 },
        cerebras: { purchasedCredits: 20, currentBalance: 6.5, currency: 'GBP' },
        meta: expect.objectContaining({
          spent: 0.05,
          anchorUpdatedAt: '2026-08-15T12:00:00.000Z'
        })
      })
    )

    const unchanged = apiUsageBillingFromDrafts(drafts, first, now + 60_000)
    expect(unchanged?.meta?.anchorUpdatedAt).toBe('2026-08-15T12:00:00.000Z')
  })

  it('requires Cerebras purchased and current balances as a pair', () => {
    expect(() =>
      apiUsageBillingFromDrafts(
        { ...apiUsageBillingDraftsFromSettings(undefined), cerebrasPurchasedCredits: '20' },
        undefined
      )
    ).toThrow('Enter both Cerebras purchased credits and current balance')
  })
})
