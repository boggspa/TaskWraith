// Muse provider sub-gates.
//
// Pure (reads only process.env), so it can be imported by the Electron-heavy
// index.ts without an import cycle — same constraint as mistralGate.ts and
// grokGate.ts.
//
// As with those, there is deliberately NO provider-eligibility gate here. Muse
// is a first-class member of `ProviderId` and is accepted at every trust
// boundary like the rest. These tune HOW the seat runs, never WHETHER it is
// valid.

/**
 * Select the MSP transport (`muse serve`) instead of the one-shot
 * `muse exec --json` child.
 *
 * MSP is the protocol Meta is moving its own TUI onto
 * (MUSE_EXPERIMENTAL_TUI_MSP_CLIENT) and it is strictly more capable: image
 * input, real `session/resume`, live `session/tokenUsage` and
 * `session/contextUsage` (including the provider's true window size), mid-turn
 * `turn/steer`, a native session goal, and an `approval/*` plane.
 *
 * DEFAULT-OFF while the lane is qualified against a live account. The exec lane
 * is what ships today and what every existing test and receipt describes; a
 * transport swap must be an explicit opt-in until its own qualification lands,
 * because the two lanes differ in containment shape (see the sandbox note on
 * `museMspHostPostureIsPerHost`).
 */
export function museMspTransportEnabled(): boolean {
  const value = process.env.TASKWRAITH_MUSE_MSP?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

/**
 * Reuse one MSP session across a seat's turns.
 *
 * Unlike the Grok/Mistral equivalents this is NOT hard-disabled: `session/resume`
 * is a first-class MSP method, it was proven to restore full conversational
 * context (including prior image input) from a FRESH host process, and the
 * measured cost of not using it is re-paying an entire cold prompt prefix on
 * every turn.
 *
 * It still rides the transport gate: resumption is meaningless on the exec lane,
 * which mints a fresh isolated home per run. When this returns true,
 * `museNeedsContextInjection` in PromptComposition.ts MUST stop being
 * unconditional in the same change, or the host pays for a transcript the
 * provider is already holding.
 */
export function museMspSessionResumeEnabled(): boolean {
  if (!museMspTransportEnabled()) return false
  const value = process.env.TASKWRAITH_MUSE_MSP_RESUME?.trim().toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off'
}

/**
 * Whether MSP sandbox posture is fixed for the HOST process rather than the
 * session.
 *
 * Not an env switch — a fact about `muse serve`, stated as executable doctrine
 * because it constrains any future host-pooling design. `--disable-write`,
 * `--disable-shell`, `--disable-sandbox` and `--sandbox-network` are `serve`
 * flags and apply to every session that host loads; only the approval mode is
 * selected per session on the wire. A read-only seat and a write-capable seat
 * therefore require SEPARATE host processes: never pool one host across
 * postures, and never "upgrade" a running host by changing a session's mode.
 */
export const museMspHostPostureIsPerHost = true as const

/**
 * Advertise TaskWraith's MCP tools to the Muse session.
 *
 * Default-ON, matching the exec lane it replaces: the broker is injected into
 * the per-run disposable home, so the tools reach exactly one run and vanish
 * with its lease.
 */
export function museMcpAdvertiseEnabled(): boolean {
  const value = process.env.TASKWRAITH_MUSE_MCP?.trim().toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off'
}
