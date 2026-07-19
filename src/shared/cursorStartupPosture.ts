/**
 * Durable identity for the Cursor Path-B containment posture: the exact-build
 * qualification lane that must pass before TaskWraith will admit a managed
 * cursor-agent run. Path B runs cursor-agent against the user's REAL ~/.cursor
 * login (their Pro quota) and contains it with the native OS sandbox
 * (`--sandbox enabled`, Seatbelt — live-validated to block writes to the user's
 * HOME) plus a read-only `--mode`, NOT config isolation. The account's own
 * surfaces (skills, plugins, MCP) load but are sandbox-bounded — accepted
 * own-account trust. Admission is therefore gated on a reviewed, per-build
 * native-sandbox attestation rather than mere authentication.
 *
 * EGRESS CAVEAT: the sandbox is validated to block FILE WRITES to the user HOME;
 * it is NOT proven to block NETWORK EGRESS, and cursor-agent uses the network
 * normally (its own web tools, npx-installed language servers). A non-scrubbed
 * env secret is therefore egress-exfiltratable by a compromised session —
 * bounded by own-account trust (Path B), not by the sandbox.
 *
 * The scope and the posture version deliberately share the same string: unlike
 * Kimi (whose transport posture is narrower than its qualification scope), the
 * Cursor posture is the whole native-sandbox read-only surface.
 *
 * This constant is kept node-free so it is safe to import from either process.
 */
export const CURSOR_STARTUP_CONTAINMENT_POSTURE_VERSION = 'cursor-native-sandbox-readonly-v1' as const

export function isCursorStartupContainmentPosture(value: unknown): boolean {
  return value === CURSOR_STARTUP_CONTAINMENT_POSTURE_VERSION
}
