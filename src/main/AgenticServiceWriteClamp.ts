import type { AgenticServicesSettings } from './store/types'

/**
 * Whether the user's agentic-service settings deny write-capable work outright.
 *
 * Deliberately a leaf module with no runtime imports: both `ProviderCapabilities`
 * (which reports the effective mode) and a provider's launch preparation (which
 * builds the argv) must reach the SAME answer, and a second derivation would
 * drift the reported mode away from the mode actually launched.
 *
 * This exists because providers with no per-tool approval bridge cannot enforce
 * these settings mid-turn. Gemini already clamped to plan mode on a deny; the
 * official `agy` CLI transport has the same property — TaskWraith owns run
 * admission, cancellation and audit, but once the child is running there is no
 * supported way to adjudicate an individual tool call inside it. So a denied
 * service can only be honoured at launch, by refusing write capability up front.
 * Without that, "Shell commands: deny" was silently inert for AntiGravity: the
 * setting read as an enforced prohibition while the run still got
 * `--mode accept-edits`.
 */
export function agenticServicesDenyWrites(
  services: Pick<AgenticServicesSettings, 'shellCommands' | 'fileChanges'> | null | undefined
): boolean {
  if (!services) return false
  return services.shellCommands === 'deny' || services.fileChanges === 'deny'
}
