// Cursor (Composer 2.5) provider sub-gates (raw-stream debug + web bridge).
//
// Pure (reads only process.env), so it can be imported by the Electron-heavy
// index.ts without an import cycle.
//
// NO PROVIDER-ELIGIBILITY GATE LIVES HERE ANYMORE. Cursor is a permanent
// first-class member of `ProviderId` (src/main/store/types.ts) and is accepted
// unconditionally at every trust boundary, exactly like gemini/codex/claude/
// kimi/ollama. The old `experimentalCursorProviderEnabled()` flag and its
// `TASKWRAITH_DISABLE_CURSOR` / `TASKWRAITH_EXPERIMENTAL_CURSOR` kill-switch were
// removed 2026-06 once Cursor matured — do NOT reintroduce an eligibility gate.
//
// Provider eligibility is independent of write SAFETY (which is unchanged): the
// load-bearing containment lives in CursorCliArgs (never bare `-p`: read-only
// uses `--mode plan`; write mode runs in default mode contained by a workspace-
// local deny-list config). Cursor is WRITE-CAPABLE like every other provider,
// gated by approval mode (CR6 landed write mode) — not read-only. Its read-only
// PLAN seat alone keeps no TaskWraith MCP coordination tools, because cursor-
// agent plan mode rejects all tools incl. MCP — a per-seat capability nuance,
// not an eligibility gate.

/**
 * Opt-in raw-stream capture for Cursor (mirrors TASKWRAITH_GROK_DEBUG). When set,
 * every parsed cursor-agent stream-json object is teed to stderr ([cursor-raw])
 * + a tmp jsonl so the live wire shape can be captured from an in-app run.
 * Off by default; never affects behaviour.
 */
export function cursorDebugEnabled(): boolean {
  const v = process.env.TASKWRAITH_CURSOR_DEBUG
  return v === '1' || v === 'true' || v === 'yes'
}

/**
 * OQ#2 — toggle for the Cursor web bridge (CRUX39 "B", the proven reliable path).
 * DEFAULT ON (opt-out via TASKWRAITH_CURSOR_WEB=0). It's inert anyway unless the
 * user's global taskwraith server is registered, so that registration is the real
 * opt-in; the env var is just an explicit kill-switch.
 *
 * Background: the spike PROVED Cursor can route web research through an TaskWraith
 * `web_fetch` MCP server in headless default/write mode (plan mode rejects all
 * tools, so it's write-mode only). BUT MCP approval is PER WORKSPACE and headless
 * `--approve-mcps` proved persistently unreliable (`User rejected MCP: …,
 * isReadonly:false`). The reliable recipe (proven 4/4) is: the user registers our
 * read-only server ONCE in global `~/.cursor/mcp.json` (Settings → MCP Servers),
 * MCP), then each workspace is approved via `cursor-agent mcp enable taskwraith`.
 *
 * When enabled AND that global server is registered, TaskWraith (per the maintainer's "B"
 * call) auto-approves the run's workspace itself (`mcp enable taskwraith`, idempotent
 * + cached) and adds the `Mcp(taskwraith:*)` allow rule to the run's `.cursor/cli.json`
 * — NO per-run mcp.json, NO `--approve-mcps`. That `mcp enable` is the ONLY write
 * TaskWraith makes under `~/.cursor`, and only ever approves our own server. If the
 * global server isn't registered the bridge stays inactive (no web, no ~/.cursor
 * write). See the OQ#2 verdict in the Cursor blueprint.
 */
export function cursorWebBridgeEnabled(): boolean {
  // DEFAULT ON (opt-out): inert anyway unless the user's global taskwraith server is
  // registered, so the registration is the real opt-in. TASKWRAITH_CURSOR_WEB=0
  // (or false/no) is an explicit kill-switch.
  const v = process.env.TASKWRAITH_CURSOR_WEB
  return v !== '0' && v !== 'false' && v !== 'no'
}
