// Cursor debug-capture flag.
//
// Pure (reads only process.env), so it can be imported by the Electron-heavy
// index.ts without an import cycle.
//
// This is the ONLY surviving cursorGate export. The historical OQ#2 sub-gates
// (web bridge, read-only broker, global broker, force-MCP) were hard-disabled
// compatibility seams superseded by the Path-B contained argv
// (buildContainedCursorArgv: `--sandbox enabled` pinned, no bridge, no
// `--approve-mcps`/`--force`) and were deleted rather than left as re-wire
// bait; see the OQ#2 verdict in the Cursor blueprint for the retained probe
// evidence.

/**
 * Opt-in raw-stream capture for Cursor (mirrors TASKWRAITH_GROK_DEBUG). When set,
 * every parsed historical/qualification stream-json object is teed to stderr
 * ([cursor-raw]) plus a temporary jsonl. Diagnostics only — it never widens a
 * live contained run.
 */
export function cursorDebugEnabled(): boolean {
  const v = process.env.TASKWRAITH_CURSOR_DEBUG
  return v === '1' || v === 'true' || v === 'yes'
}
