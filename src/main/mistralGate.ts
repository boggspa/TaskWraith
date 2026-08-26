// Mistral provider sub-gates.
//
// Pure (reads only process.env), so it can be imported by the Electron-heavy
// index.ts without an import cycle — same constraint as grokGate.ts.
//
// There is deliberately NO provider-eligibility gate here. Mistral is a
// first-class member of `ProviderId` (src/main/store/types.ts) and is accepted
// at every trust boundary like gemini/codex/claude/kimi/grok. Do not add a
// `TASKWRAITH_DISABLE_MISTRAL`-style switch: Grok shipped one, matured, and had
// it removed, and the sibling gates below exist to tune HOW the seat runs, never
// WHETHER it is valid.

/**
 * The seat runs `vibe-acp` over ACP and nothing else — there is no second
 * transport to fall back to. `vibe` (the interactive TUI) is not a headless
 * alternative: it waits on a terminal that a managed run does not have and
 * hangs the turn rather than failing.
 *
 * This gate exists only as an emergency stop. A recognized false value makes
 * Mistral UNAVAILABLE with a clear message, exactly as Grok's does — it must
 * never silently select some other path.
 */
export function mistralAcpEnabled(): boolean {
  const value = process.env.TASKWRAITH_MISTRAL_ACP?.trim().toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off'
}

export const MISTRAL_ACP_REQUIRED_MESSAGE =
  'Managed Mistral runs require the Vibe ACP transport (`vibe-acp`). There is no headless fallback — the interactive `vibe` TUI cannot service a managed run. Unset TASKWRAITH_MISTRAL_ACP or set it to 1 to run Mistral.'

/**
 * Allow an ambient `MISTRAL_API_KEY` to satisfy a key-marked Mistral model.
 *
 * This flag authorizes a credential SOURCE; it does not choose the billing
 * lane. The model makes that choice deterministically: Devstral Small and
 * Mistral Medium 3.5 always use Vibe's subscription credential, while the
 * picker's key-marked rows use BYOK. A key stored in TaskWraith is already an
 * explicit source and does not need this flag.
 *
 * OFF by default because the same variable is what Pi exports for its Mistral
 * upstream. Without an explicit opt-in, a key inherited from a parent process
 * or runtime profile must not silently qualify as the API credential.
 */
export function mistralAmbientApiKeyEnabled(): boolean {
  const value = process.env.TASKWRAITH_MISTRAL_BYOK?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

/**
 * Advertise TaskWraith's MCP tools to the Vibe session.
 *
 * Unlike Grok's equivalent this defaults ON, because the safety boundary here
 * is materially different. Vibe raises `session/request_permission` for tool
 * executions in the `default` and `plan` modes this seat uses, so the host gate
 * actually sees each call and can refuse it. (Grok's read-only advertise gate
 * is default-OFF precisely because a live trace showed Grok auto-running MCP
 * tools with NO permission request, leaving the bridge's advertise list as the
 * only boundary.)
 *
 * That difference is load-bearing: if Vibe is ever observed executing an
 * advertised MCP tool without raising a permission request, this must flip to
 * default-OFF and the seat's containment story has to be rebuilt.
 */
export function mistralMcpAdvertiseEnabled(): boolean {
  const value = process.env.TASKWRAITH_MISTRAL_MCP?.trim().toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off'
}

/**
 * Reuse one `vibe-acp` process + ACP session across a seat's turns.
 *
 * Hard-disabled, like Grok's. Vibe DOES support it at the protocol level — it
 * advertises `loadSession: true` and implements session/load, session/resume
 * and session/fork, so this is genuinely available in a way it is not for Grok.
 * It stays off anyway until a persistent child has durable PID/birth identity
 * and a joined close receipt usable by history deletion and crash recovery.
 * Environment flags cannot reopen that boundary.
 *
 * When this is lifted, `mistralNeedsContextInjection` in PromptComposition.ts
 * must stop being unconditional in the same change — otherwise the host will
 * keep re-injecting a transcript the provider is already holding, paying for
 * the same context twice on every turn.
 */
export function mistralSeatSessionsEnabled(): boolean {
  return false
}
