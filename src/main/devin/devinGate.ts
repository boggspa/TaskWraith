// Devin provider sub-gates.
//
// Pure (reads only process.env), so it can be imported by the Electron-heavy
// index.ts without an import cycle — same constraint as mistralGate.ts.
//
// There is deliberately NO provider-eligibility gate here. Devin is a
// first-class member of `ProviderId` (src/main/store/types.ts) and is accepted
// at every trust boundary like the other CLI seats. Do not add a
// `TASKWRAITH_DISABLE_DEVIN`-style switch: the gates below tune HOW the seat
// runs, never WHETHER it is valid.

/**
 * The seat runs `devin acp` over stdio and nothing else — there is no second
 * transport to fall back to.
 *
 * This gate exists only as an emergency stop. A recognized false value makes
 * Devin UNAVAILABLE with a clear message, exactly as Mistral's does — it must
 * never silently select some other path.
 */
export function devinAcpEnabled(): boolean {
  const value = process.env.TASKWRAITH_DEVIN_ACP?.trim().toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off'
}

export const DEVIN_ACP_REQUIRED_MESSAGE =
  'Managed Devin runs require the ACP transport (`devin acp`). There is no headless fallback. Unset TASKWRAITH_DEVIN_ACP or set it to 1 to run Devin.'

/**
 * Allow an ambient `WINDSURF_API_KEY` / `DEVIN_API_KEY` to satisfy the seat.
 *
 * ON by default — unlike Mistral's MISTRAL_API_KEY, which collides with Pi's
 * `mistral/<model>` BYOK upstream and therefore needs an explicit opt-in,
 * WINDSURF_API_KEY and DEVIN_API_KEY name exactly one product. A user who
 * exports one intends it as this seat's credential, the same way an exported
 * ANTHROPIC_API_KEY intends Claude. Set TASKWRAITH_DEVIN_BYOK=0 to force the
 * stored-credentials lane only.
 */
export function devinAmbientApiKeyEnabled(): boolean {
  const value = process.env.TASKWRAITH_DEVIN_BYOK?.trim().toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off'
}

/**
 * Advertise TaskWraith's MCP tools to the Devin session.
 *
 * DEFAULT OFF — the opposite of Mistral's gate, and the reason is evidence
 * rather than preference. Mistral's default-ON is predicated on a MEASURED
 * trace showing `vibe-acp` raises session/request_permission for every tool
 * execution. Devin's request_permission coverage is verified from the Synara
 * source but has not been live-measured against the real CLI, so the
 * advertise list remains the only boundary for brokered tools until it is.
 * When a live trace confirms full permission-request coverage, flip this
 * default ON and update the `devin` run-management declaration and the
 * defaultProviderDescriptor caveat in the same change.
 */
export function devinMcpAdvertiseEnabled(): boolean {
  const value = process.env.TASKWRAITH_DEVIN_MCP?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

/**
 * Reuse one `devin acp` process + ACP session across a seat's turns.
 *
 * Hard-disabled, like Mistral's and Grok's, until a persistent child has
 * durable PID/birth identity and a joined close receipt usable by history
 * deletion and crash recovery. Environment flags cannot reopen that boundary.
 */
export function devinSeatSessionsEnabled(): boolean {
  return false
}
