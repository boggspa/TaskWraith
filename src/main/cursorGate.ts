// Cursor debug-capture flag.
//
// Pure (reads only process.env), so it can be imported by the Electron-heavy
// index.ts without an import cycle.
//
// This is the ONLY surviving cursorGate export. The historical OQ#2 sub-gates
// (web bridge, read-only broker, global broker, force-MCP) were hard-disabled
// compatibility seams and were deleted rather than left as re-wire bait.
// Path-B now establishes its contained argv and optional governed broker
// directly in runCursorProvider: `--sandbox enabled` is always pinned,
// `--force` appears only after broker setup succeeds, and `--approve-mcps` is
// never emitted. This debug flag is diagnostics only, not a capability gate.

/**
 * Opt-in raw-stream capture for Cursor (mirrors TASKWRAITH_GROK_DEBUG). When set,
 * every parsed live Path-B stream-json object is teed to stderr ([cursor-raw])
 * plus a temporary jsonl. Diagnostics only — it never widens a live contained
 * run.
 */
export function cursorDebugEnabled(): boolean {
  const v = process.env.TASKWRAITH_CURSOR_DEBUG
  return v === '1' || v === 'true' || v === 'yes'
}
