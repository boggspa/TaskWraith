/** Requested configuration and provider observations are deliberately separate. */
export interface ProviderContextPolicy {
  provider: 'codex' | 'claude'
  model: string
  modelCapacityTokens?: number
  requestedWindowTokens?: number
  requestedCompactionTokens?: number
  reportedWindowTokens?: number
  reportedCompactionTokens?: number
  runtimeVersion?: string
  configurationSource: 'taskwraith' | 'environment' | 'user-settings' | 'provider-default'
}

export function providerContextPolicyDetails(policy: ProviderContextPolicy): [string, string][] {
  const tokens = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? `${value.toLocaleString('en-US')} tokens`
      : undefined
  const rows: [string, string | undefined][] = [
    ['Model', policy.model],
    ['Model capacity', tokens(policy.modelCapacityTokens)],
    ['Requested working window', tokens(policy.requestedWindowTokens)],
    [
      policy.provider === 'claude'
        ? 'Requested compaction window'
        : 'Requested compaction threshold',
      tokens(policy.requestedCompactionTokens)
    ],
    ['Runtime working window', tokens(policy.reportedWindowTokens) || 'Not reported'],
    ['Runtime compaction threshold', tokens(policy.reportedCompactionTokens) || 'Not reported'],
    ['Runtime version', policy.runtimeVersion || 'Not reported'],
    [
      'Configuration',
      {
        taskwraith: 'TaskWraith',
        environment: 'Environment override',
        'user-settings': 'Saved Claude preference',
        'provider-default': 'Provider default'
      }[policy.configurationSource]
    ]
  ]
  return rows.filter((row): row is [string, string] => Boolean(row[1]))
}

export function formatProviderContextPolicy(policy: ProviderContextPolicy): string {
  return providerContextPolicyDetails(policy)
    .map(([key, value]) => `${key}: ${value}`)
    .join(' · ')
}

/** Keep only a version identifier, never an entire user-agent or init envelope. */
export function providerRuntimeVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.match(/\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\b/)?.[0]?.slice(0, 64)
}
