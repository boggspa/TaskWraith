/**
 * Interactive provider login happens outside the renderer in a Terminal or a
 * browser owned by the provider. There is no reliable completion callback, so
 * refresh runtime discovery immediately and on a short bounded backoff. This
 * keeps provider cards current without asking users to find a manual refresh.
 * Device-code sign-ins (`kimi login`, `grok login --device-auth`) routinely take
 * longer than a minute, so the backoff runs out to three minutes; the same
 * schedule refreshes a card after a terminal sign-out.
 */
export const INTERACTIVE_PROVIDER_LOGIN_REFRESH_DELAYS_MS = [
  4_000, 15_000, 45_000, 90_000, 180_000
] as const

type InteractiveLoginResult = { ok?: boolean; error?: string } | null | undefined

interface OpenInteractiveProviderLoginOptions<TProvider> {
  openTerminal: (provider: TProvider) => Promise<InteractiveLoginResult>
  refresh: (provider: TProvider) => void
  schedule: (callback: () => void, delayMs: number) => unknown
  onOpenError?: (error: unknown) => void
}

export async function openInteractiveProviderLogin<TProvider>(
  provider: TProvider,
  { openTerminal, refresh, schedule, onOpenError }: OpenInteractiveProviderLoginOptions<TProvider>
): Promise<boolean> {
  try {
    const result = await openTerminal(provider)
    if (!result?.ok) {
      onOpenError?.(result?.error)
      return false
    }

    refresh(provider)
    for (const delayMs of INTERACTIVE_PROVIDER_LOGIN_REFRESH_DELAYS_MS) {
      schedule(() => refresh(provider), delayMs)
    }
    return true
  } catch (error) {
    onOpenError?.(error)
    return false
  }
}
