/**
 * Durable identity for the Cursor startup-containment posture: the exact-build
 * qualification lane that must pass before TaskWraith will admit a managed
 * cursor-agent run. Cursor initializes provider-managed account/team hooks,
 * managed skills, plugins, and MCP sources at startup, so admission is gated on
 * a reviewed, per-build containment attestation rather than mere authentication.
 *
 * The scope and the posture version deliberately share the same string: unlike
 * Kimi (whose transport posture is narrower than its qualification scope), the
 * Cursor posture is the whole startup-containment surface.
 *
 * This constant is kept node-free so it is safe to import from either process.
 */
export const CURSOR_STARTUP_CONTAINMENT_POSTURE_VERSION = 'cursor-startup-containment-v1' as const

export function isCursorStartupContainmentPosture(value: unknown): boolean {
  return value === CURSOR_STARTUP_CONTAINMENT_POSTURE_VERSION
}
