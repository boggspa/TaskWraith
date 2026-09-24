import { hostStandaloneProviderMatrix } from '../host-shared/HostStandaloneProviderMatrix'
import type { HostProviderStatusProjection } from '../shared/hostSetupProtocol'

export function matchProviderStatus(
  providers: readonly HostProviderStatusProjection[],
  requested: string | undefined
): HostProviderStatusProjection | undefined {
  if (!requested?.trim()) return providers[0]
  const needle = requested.trim().toLowerCase()
  const exact = providers.filter(
    (provider) =>
      provider.providerId.toLowerCase() === needle || provider.label.toLowerCase() === needle
  )
  if (exact.length === 1) return exact[0]
  const prefix = providers.filter(
    (provider) =>
      provider.providerId.toLowerCase().startsWith(needle) ||
      provider.label.toLowerCase().startsWith(needle)
  )
  return prefix.length === 1 ? prefix[0] : undefined
}

/** Host-authored status first, then the static standalone boundary for no-flow cases. */
export function providerLoginGuidance(provider: HostProviderStatusProjection | undefined): string {
  if (!provider) return 'No provider is selected.'
  const matrix = hostStandaloneProviderMatrix().find(
    (candidate) => candidate.providerId === provider.providerId
  )
  return [
    provider.detail,
    matrix?.detail,
    'Complete setup outside the TUI, then press r to refresh.'
  ]
    .filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index)
    .join(' ')
}
