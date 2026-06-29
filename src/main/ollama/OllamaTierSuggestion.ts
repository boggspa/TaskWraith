import type { OllamaToolControlTier, ProviderCapabilityWarning } from '../store/types'
import { normalizeOllamaToolControlTier, ollamaToolNamesForTier } from './OllamaToolTiers'
import type { OllamaToolName } from './OllamaToolTiers'

const TIER_ORDER: OllamaToolControlTier[] = [
  'read_only',
  'approved_edits',
  'approved_shell',
  'provider_parity'
]

const AMBITIOUS_PROMPT =
  /\b(refactor|rewrite|fix all tests|fix every test|entire module|whole module|whole repo|codebase[- ]wide|migrate|implement feature|multi[- ]file|all tests|test suite|run tests and fix)\b/i

const SHELL_PROMPT = /\b(npm (install|run|test)|pnpm |yarn |cargo test|swift test|xcodebuild|make test|pytest|run_shell)\b/i

function tierLabel(tier: OllamaToolControlTier): string {
  if (tier === 'read_only') return 'Read-only workspace'
  if (tier === 'approved_edits') return 'Approved edits'
  if (tier === 'approved_shell') return 'Approved shell'
  return 'Provider parity'
}

function nextTier(tier: OllamaToolControlTier): OllamaToolControlTier | null {
  const index = TIER_ORDER.indexOf(tier)
  if (index < 0 || index >= TIER_ORDER.length - 1) return null
  return TIER_ORDER[index + 1]
}

export function minimumOllamaTierForTool(toolName: OllamaToolName | string): OllamaToolControlTier {
  for (const tier of TIER_ORDER) {
    if (ollamaToolNamesForTier(tier).includes(toolName as OllamaToolName)) return tier
  }
  return 'provider_parity'
}

/** Mid-run warning when a tool call exceeds the active tier. */
export function buildOllamaMidRunTierBumpWarning(
  toolName: string,
  currentTier: OllamaToolControlTier | string | undefined | null
): ProviderCapabilityWarning {
  const normalized = normalizeOllamaToolControlTier(currentTier)
  const required = minimumOllamaTierForTool(toolName)
  return {
    id: 'ollama-midrun-tier-bump',
    severity: 'warning',
    title: 'Raise Ollama tool tier to continue',
    message: `${toolName} needs ${tierLabel(required)} tools, but this run is on ${tierLabel(normalized)}. Open Settings → Behavior → Ollama, raise the tier, then retry.`
  }
}

export function ollamaMidRunTierBumpMessage(
  toolName: string,
  currentTier: OllamaToolControlTier | string | undefined | null
): string {
  return buildOllamaMidRunTierBumpWarning(toolName, currentTier).message
}

/** Suggest bumping the Ollama tool tier before a run stalls on policy. */
export function suggestOllamaTierBump(
  prompt: string,
  tier: OllamaToolControlTier | string | undefined | null
): ProviderCapabilityWarning | null {
  const normalized = normalizeOllamaToolControlTier(tier)
  const text = String(prompt || '').trim()
  if (!text) return null

  const wantsShell = SHELL_PROMPT.test(text)
  const wantsEdits = AMBITIOUS_PROMPT.test(text) || /\b(write_file|apply_patch|create file|edit file)\b/i.test(text)

  let target: OllamaToolControlTier | null = null
  if (wantsShell && normalized !== 'approved_shell' && normalized !== 'provider_parity') {
    target = normalized === 'read_only' ? 'approved_edits' : 'approved_shell'
    if (normalized === 'approved_edits') target = 'approved_shell'
  } else if (wantsEdits && normalized === 'read_only') {
    target = 'approved_edits'
  }

  if (!target || target === normalized) return null
  const bump = nextTier(normalized)
  const effective = bump && TIER_ORDER.indexOf(bump) >= TIER_ORDER.indexOf(target) ? bump : target

  return {
    id: 'ollama-tier-suggestion',
    severity: 'warning',
    title: 'Consider raising Ollama tool tier',
    message: `This request likely needs ${tierLabel(effective)} tools. Current tier is ${tierLabel(normalized)}. Raise it in Settings → Behavior → Ollama before running, or choose a participant/profile with the needed tools.`
  }
}
