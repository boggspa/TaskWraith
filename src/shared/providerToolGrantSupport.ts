import type { ProviderId } from '../main/store/types'

/**
 * Whether a provider's tools pass through TaskWraith's per-service approval
 * gate, where a workspace Tool Grant can change the decision.
 *
 * Cursor Path-B intentionally runs its own native tools inside Cursor's OS
 * sandbox. It has no TaskWraith MCP broker or per-tool approval/grant route,
 * so storing a Tool Grant for Cursor would be an inert preference.
 */
export function supportsTaskWraithToolGrants(provider: ProviderId): boolean {
  return provider !== 'cursor'
}

export function taskWraithToolGrantUnsupportedReason(provider: ProviderId): string | null {
  if (supportsTaskWraithToolGrants(provider)) return null
  return 'Cursor uses native tools under its contained sandbox; TaskWraith Tool Grants do not apply.'
}
