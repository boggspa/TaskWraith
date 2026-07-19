// Cursor (Composer 2.5) provider sub-gates.
//
// Pure (reads only process.env), so it can be imported by the Electron-heavy
// index.ts without an import cycle.
//
// Cursor remains a stable ProviderId for historical records and configuration
// interchange, but source-ahead production admission fails before process
// launch. These legacy feature switches are hard-disabled compatibility seams;
// none authorize a managed Cursor run. Re-enabling any path requires a reviewed
// exact-build startup-containment suite or a stronger sandbox.

/**
 * Opt-in raw-stream capture for Cursor (mirrors TASKWRAITH_GROK_DEBUG). When set,
 * every parsed historical/qualification stream-json object is teed to stderr
 * ([cursor-raw]) plus a temporary jsonl. Source-ahead production starts no
 * in-app Cursor run, so this compatibility flag is inert there.
 */
export function cursorDebugEnabled(): boolean {
  const v = process.env.TASKWRAITH_CURSOR_DEBUG
  return v === '1' || v === 'true' || v === 'yes'
}

/**
 * Historical OQ#2 Cursor web-bridge switch. Production keeps this false and
 * starts no Cursor process; the retained probe notes below are evidence, not a
 * supported setup recipe.
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
  return false
}

/**
 * Historical read-only-broker switch. It is hard-disabled: there is no
 * source-ahead Cursor seat, Plan run, safe subset, or broker attachment.
 */
export function cursorReadOnlyMcpEnabled(): boolean {
  return false
}

/**
 * Historical global-broker switch. It remains false and production must not
 * mutate the user's Cursor configuration through this path.
 */
export function cursorGlobalBrokerEnabled(): boolean {
  return false
}

/**
 * Historical force-MCP switch. It remains false; production never emits
 * `--force`, `--approve-mcps`, or a Cursor launch from this checkout.
 */
export function cursorForceMcpEnabled(): boolean {
  return false
}
