import type { ProviderId } from '../../../main/store/types'

function humaniseRawPlan(raw: string, prefixes: string[] = []): string {
  let value = raw.trim()
  const upper = value.toUpperCase()
  const prefix = prefixes.find((candidate) => upper.startsWith(candidate))
  if (prefix) value = value.slice(prefix.length)
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

export function providerPlanName(provider: ProviderId, rawValue: unknown): string | undefined {
  const raw = typeof rawValue === 'string' ? rawValue.trim() : ''
  if (!raw) return undefined
  const normalized = raw.toLowerCase()

  if (provider === 'codex') {
    if (normalized.includes('enterprise')) return 'Enterprise'
    if (normalized.includes('business') || normalized.includes('team')) return 'Business'
    if (normalized.includes('pro')) return 'Pro'
    if (normalized.includes('plus')) return 'Plus'
    if (normalized.includes('free')) return 'Free'
  }

  if (provider === 'claude') {
    if (normalized.includes('max')) {
      if (normalized.includes('20')) return 'Max x20'
      if (normalized.includes('5')) return 'Max x5'
      return 'Max'
    }
    if (normalized.includes('enterprise')) return 'Enterprise'
    if (normalized.includes('team')) return 'Team'
    if (normalized.includes('pro')) return 'Pro'
  }

  if (provider === 'kimi') {
    const membership = normalized.replace(/^level_/, '')
    if (membership === 'free' || membership.startsWith('fr')) return 'Adagio'
    if (membership === 'basic' || membership.startsWith('bal')) return 'Moderato'
    if (membership === 'pro' || membership.startsWith('pr')) return 'Allegretto'
    if (membership === 'max' || membership.startsWith('ma')) return 'Allegro'
    if (membership === 'ultra' || membership.startsWith('ul')) return 'Vivace'
    return humaniseRawPlan(raw, ['LEVEL_', 'TYPE_']) || undefined
  }

  if (provider === 'cursor') {
    if (normalized === 'pro_plus') return 'Pro +'
    if (normalized === 'pro') return 'Pro'
    if (normalized === 'free') return 'Free'
    if (normalized === 'business') return 'Business'
  }

  if (provider === 'grok') {
    const plan = raw.replace(/^free\s+credits\s+with\s+/i, '').trim()
    return plan || undefined
  }

  return humaniseRawPlan(raw) || undefined
}

export function providerPlanNameFromSnapshot(
  provider: ProviderId,
  snapshot: unknown
): string | undefined {
  const value = snapshot && typeof snapshot === 'object' ? (snapshot as Record<string, any>) : null
  return providerPlanName(
    provider,
    value?.planName ?? value?.planType ?? value?.subscriptionType ?? value?.planLabel
  )
}
