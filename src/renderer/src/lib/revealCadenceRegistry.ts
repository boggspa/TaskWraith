import type { ProviderId } from '../../../main/store/types'
import type { RevealCadence } from './adaptiveReveal'

const MAX_EXACT_PRIORS = 48
const exactPriors = new Map<string, RevealCadence>()
const providerPriors = new Map<ProviderId, RevealCadence>()

function normalizedModel(model: string | null | undefined): string {
  return typeof model === 'string' ? model.trim().toLowerCase() : ''
}

function exactKey(
  provider: ProviderId | null | undefined,
  model: string | null | undefined
): string {
  return provider && normalizedModel(model) ? `${provider}:${normalizedModel(model)}` : ''
}

function blend(previous: RevealCadence | undefined, next: RevealCadence): RevealCadence {
  if (!previous) return { ...next }
  const weight = Math.min(0.42, Math.max(0.12, next.sampleCount / 20))
  return {
    sourceCharsPerSec:
      previous.sourceCharsPerSec + (next.sourceCharsPerSec - previous.sourceCharsPerSec) * weight,
    averageChunkChars:
      previous.averageChunkChars + (next.averageChunkChars - previous.averageChunkChars) * weight,
    averageGapMs: previous.averageGapMs + (next.averageGapMs - previous.averageGapMs) * weight,
    jitterMs: previous.jitterMs + (next.jitterMs - previous.jitterMs) * weight,
    sampleCount: Math.min(10_000, previous.sampleCount + Math.max(1, next.sampleCount))
  }
}

export function readRevealCadencePrior(
  provider: ProviderId | null | undefined,
  model: string | null | undefined
): RevealCadence | undefined {
  const key = exactKey(provider, model)
  if (key) {
    const exact = exactPriors.get(key)
    if (exact) {
      // Refresh insertion order so the bounded map behaves like a tiny LRU.
      exactPriors.delete(key)
      exactPriors.set(key, exact)
      return { ...exact }
    }
  }
  const providerPrior = provider ? providerPriors.get(provider) : undefined
  return providerPrior ? { ...providerPrior } : undefined
}

export function recordRevealCadencePrior(
  provider: ProviderId | null | undefined,
  model: string | null | undefined,
  cadence: RevealCadence
): void {
  if (cadence.sampleCount <= 0) return
  if (provider) providerPriors.set(provider, blend(providerPriors.get(provider), cadence))

  const key = exactKey(provider, model)
  if (!key) return
  const previousExact = exactPriors.get(key)
  exactPriors.delete(key)
  exactPriors.set(key, blend(previousExact, cadence))
  while (exactPriors.size > MAX_EXACT_PRIORS) {
    const oldest = exactPriors.keys().next().value as string | undefined
    if (!oldest) break
    exactPriors.delete(oldest)
  }
}

export function resetRevealCadenceRegistryForTest(): void {
  exactPriors.clear()
  providerPriors.clear()
}
