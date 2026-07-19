// Grok provider sub-gates (ACP transport + read-only MCP advertise).
//
// Pure (reads only process.env), so it can be imported by the Electron-heavy
// index.ts without an import cycle.
//
// NO PROVIDER-ELIGIBILITY GATE LIVES HERE ANYMORE. Grok is a permanent
// first-class member of `ProviderId` (src/main/store/types.ts) and is accepted
// unconditionally at every trust boundary, exactly like gemini/codex/claude/
// kimi/ollama. The old `experimentalGrokProviderEnabled()` flag and its
// `TASKWRAITH_DISABLE_GROK` / `TASKWRAITH_EXPERIMENTAL_GROK` kill-switch were
// removed 2026-06 once Grok matured — do NOT reintroduce an eligibility gate.
// The remaining sub-gates tune MCP advertising and experimental seat reuse,
// never WHETHER Grok is valid or WHICH one-shot transport it uses.

/**
 * Managed Grok runs use only the joined ACP transport (`grok agent stdio`,
 * bidirectional JSON-RPC). The legacy `TASKWRAITH_GROK_ACP=0` emergency
 * fallback is retired: its headless child did not publish exact close evidence
 * to history deletion. A recognized false value now makes Grok unavailable
 * rather than reopening the unjoined transport.
 */
export function grokAcpEnabled(): boolean {
  const value = process.env.TASKWRAITH_GROK_ACP?.trim().toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off'
}

export const GROK_ACP_REQUIRED_MESSAGE =
  'Managed Grok runs require TaskWraith\'s joined ACP transport. The legacy headless fallback is retired because it cannot provide exact process-close evidence for history deletion. Unset TASKWRAITH_GROK_ACP or set it to 1 to run Grok.'

/**
 * 1.0.72-G5b — Sub-gate that advertises TaskWraith's read-only MCP tools (the
 * non-mutating safe subset: read/list/search + ask_user_question + ensemble
 * coordination) to a READ-ONLY Grok seat over ACP, via a scoped bridge
 * (mcpServers entry launched with --safe-subset).
 *
 * Default OFF — a deliberate seatbelt. The live trace proved Grok auto-runs MCP
 * tools with NO session/request_permission, so the bridge's advertise list +
 * tools/call reject are the ENTIRE safety boundary; this stays gated until that
 * boundary is runtime-verified in a live Grok run. Only meaningful when the
 * provider gate, grokAcpEnabled(), AND settings.geminiMcpBridgeEnabled are on,
 * and only ever attached to a read-only (plan / non-write) seat.
 */
export function grokReadOnlyMcpAdvertiseEnabled(): boolean {
  const value = process.env.TASKWRAITH_GROK_READONLY_MCP
  return value === '1' || value === 'true' || value === 'yes'
}

/**
 * Spike 7 (docs/ensemble-posture-fanout-preamble-design.md) — sub-gate for
 * persistent per-seat Grok ACP sessions in ensembles. When ON, a TOOLLESS
 * read-only ensemble Grok seat keeps one `grok agent stdio` process + ACP
 * session alive across its turns (GrokSeatSession), giving it provider-native
 * cross-turn memory instead of a fresh `session/new` per turn.
 *
 * Disabled for new runs until a persistent child has durable PID/birth
 * identity and a joined close receipt usable by history deletion and crash
 * recovery. Environment flags cannot reopen this safety boundary. Native Grok
 * session ids may still resume provider context in a fresh per-turn process.
 */
export function grokSeatSessionsEnabled(): boolean {
  return false
}
