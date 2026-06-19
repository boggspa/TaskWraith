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
// The sub-gates below tune HOW Grok runs (transport, MCP advertise), never
// WHETHER it is a valid provider.

/**
 * 1.0.6-G4/G6 — Sub-gate routing Grok runs through the ACP transport
 * (`grok agent stdio`, bidirectional JSON-RPC) instead of the headless
 * streaming-json path (G3). Default ON so TaskWraith can register its MCP
 * bridge and mediate native permission requests; set TASKWRAITH_GROK_ACP=0
 * (or false/no) to fall back to the older headless path for emergency triage.
 * Only meaningful when the provider gate is also on.
 */
export function grokAcpEnabled(): boolean {
  const value = process.env.TASKWRAITH_GROK_ACP
  return value !== '0' && value !== 'false' && value !== 'no'
}

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
