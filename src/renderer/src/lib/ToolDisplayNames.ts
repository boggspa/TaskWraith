/*
 * ToolDisplayNames.ts — humaniser dictionary for tool-call labels.
 *
 * Without this, the transcript shows raw `tool_name` identifiers like
 *   "Used delegate_to_subthread"
 *   "Used attached_window_capture"
 *   "Used creative_midi_dispatch"
 * Those leak underscores, casing, and provider-internal naming into a
 * user-facing surface. This dictionary maps the canonical (namespace-
 * stripped) tool name to a tidy past-tense or noun-phrase label that
 * reads naturally in a chat transcript.
 *
 * Coverage rules:
 *  - Keys are the unqualified name (mcp__/taskwraith__ prefix
 *    stripped, lower-case). Mixed-case keys never match.
 *  - Values are the FULL label as it should appear in the transcript.
 *    They DO NOT include a "Used " prefix — the parser composes that
 *    only as a fallback when no dictionary entry exists.
 *  - Past-tense action verbs ("Delegated", "Captured", "Opened")
 *    preferred where the tool clearly performs an action; noun
 *    phrases ("Git status", "Approval status") where the tool just
 *    reads or reports.
 *  - When a tool has a path or query parameter that's already woven
 *    into the label by a richer branch in `getToolDisplayName`
 *    (e.g. `read_file` → "Read README.md"), it is NOT listed here.
 *    The dictionary is only for the catch-all default branch.
 *
 * Adding new tools: drop a key/value pair below. Update the matching
 * test in `ToolParser.test.ts` if you want lock-in coverage.
 */

export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // ── Sub-thread orchestration (cross-provider delegation) ──────
  delegate_to_subthread: 'Delegated to sub-thread',
  list_subthreads: 'Listed sub-threads',
  read_subthread_result: 'Read sub-thread result',
  cancel_subthread: 'Cancelled sub-thread',

  // ── Git ──────────────────────────────────────────────────────
  git_status: 'Git status',
  git_diff: 'Git diff',
  git_stage: 'Git stage',
  git_commit: 'Git commit',
  git_push: 'Git push',
  git_create_pr: 'Git create PR',
  git_log: 'Git log',
  git_show: 'Git show',
  git_branch: 'Git branch',
  git_blame: 'Git blame',

  // ── Browser automation ───────────────────────────────────────
  browser_open: 'Opened browser',
  browser_navigate: 'Navigated browser',
  browser_click: 'Clicked in browser',
  browser_type: 'Typed in browser',
  browser_press_key: 'Pressed browser key',
  browser_select: 'Selected in browser',
  browser_wait: 'Waited in browser',
  browser_evaluate: 'Ran browser script',
  browser_screenshot: 'Browser screenshot',
  browser_snapshot: 'Browser snapshot',
  browser_console: 'Browser console',

  // ── Attached window (Vision OCR / capture) ───────────────────
  attached_window_capture: 'Captured attached window',
  attached_window_status: 'Attached window status',
  attached_window_pick: 'Picked attached window',
  attached_window_detach: 'Detached attached window',

  // ── AppWatch / Appshots window monitoring ────────────────────
  // M1 surface today: start / stop / status / latest_frame. M2
  // entries (`appwatch_frames`, `appwatch_ocr`) are pre-registered
  // so the daemon shipping those later doesn't leave the renderer
  // mis-labeling them as raw underscored identifiers.
  //
  // Labels were harmonised cross-branch (claude/tier01-polish +
  // codex/tier2-polish-experiments) before the integration merge,
  // so the two parallel additions landed on identical values. The
  // duplicate section that materialised post-merge was deleted
  // here in favour of the documented version.
  //
  // Window ATTACH / DETACH live under the `attached_window_*`
  // tool family, not here — see entries above.
  appwatch_start: 'Started AppWatch',
  appwatch_stop: 'Stopped AppWatch',
  appwatch_status: 'AppWatch status',
  appwatch_latest_frame: 'Latest AppWatch frame',
  appwatch_frames: 'AppWatch frames',
  appwatch_ocr: 'AppWatch OCR',

  // ── Workspace / project introspection ────────────────────────
  workspace_search: 'Workspace search',
  workspace_symbols: 'Workspace symbols',
  open_workspace_file: 'Opened workspace file',

  // ── System / runtime introspection ───────────────────────────
  approval_status: 'Approval status',
  provider_auth_status: 'Provider auth status',
  get_diagnostics: 'Checked diagnostics',
  run_task: 'Ran task',
  run_timeline: 'Run timeline',
  run_events: 'Run events',
  run_diff: 'Run diff',
  raw_provider_events: 'Raw provider events',
  test_result_summary: 'Test result summary',
  probe_external_path: 'External path probe',

  // ── Handoff / role / auth ────────────────────────────────────
  create_handoff_card: 'Created handoff card',
  get_handoff_cards: 'Handoff cards',
  update_handoff_card: 'Updated handoff card',
  delete_handoff_card: 'Deleted handoff card',
  switch_auth_profile: 'Switched auth profile',
  agent_delegation_role: 'Agent delegation role',

  // ── Editor / IDE transport (Phase L) ─────────────────────────
  open_in_ide: 'Opened in IDE',
  open_in_ide_at_position: 'Opened in IDE at position',
  reveal_in_finder: 'Revealed in Finder',
  ide_app_status: 'IDE app status',
  ide_app_capabilities: 'IDE app capabilities',
  list_running_ides: 'Listed running IDEs',

  // ── Creative apps (Phase K) — the *_status / *_capabilities /
  // *_snapshot / *_validate / *_ir / *_diff variants are handled
  // by richer branches in getToolDisplayName that fold path params
  // into the label, so they're intentionally omitted here. Only
  // the dispatch-style tools (which have no useful path) live in
  // the dictionary. ─────────────────────────────────────────────
  creative_timeline_import: 'Imported timeline',
  creative_applescript_dispatch: 'Dispatched AppleScript',
  creative_blender_python: 'Ran Blender Python script',
  creative_midi_dispatch: 'Dispatched MIDI',

  // ── Provider-internal task / thinking tools ──────────────────
  // (richer task-category branches handle these when a `title`
  // param is supplied — these are the no-title fallbacks.)
  update_topic: 'Topic update',
  ensemble_yield: 'Yielding',
  invoke_agent: 'Invoked agent',
  collabtoolcall: 'Collaboration tool call',
  codex_reasoning: 'Codex reasoning',
  codex_plan: 'Codex plan',
  kimi_thinking: 'Kimi thinking',
  claude_thinking: 'Claude thinking',
  gemini_thinking: 'Gemini thinking',
  task: 'Task',
  goal_read: 'Goal status',
  goal_update: 'Goal status',
  goal_complete: 'Goal completed',
  goal_blocked: 'Goal blocked',
  todowrite: 'Goal steps',
  todo_write: 'Goal steps',
  update_todo_list: 'Goal steps',
  updatetodolist: 'Goal steps',
  summary: 'Summary',
  intent: 'Intent',
  progress: 'Progress',
  tool_progress: 'Tool progress',

  // ── Image tools (edit/rasterize/generate) ───────────────────
  // Without these the title-case fallback yields "Svg Rasterize" /
  // "Image Edit" — past-tense action labels read better and fix the
  // SVG casing.
  image_edit: 'Edited image',
  svg_rasterize: 'Rasterized SVG',
  image_generate: 'Generated image',
  audio_render_wav: 'Rendered waveform',
  audio_analyze: 'Analyzed audio',
  video_probe: 'Probed media',
  video_thumbnail: 'Captured frame',
  video_decode_frame: 'Decoded frame',
  video_encode_clip: 'Encoded clip',
  video_concat_clips: 'Concatenated clips',
  audio_mix: 'Mixed audio',
  audio_extract: 'Extracted audio',
  transcode_audio: 'Transcoded audio',
  transcode_video: 'Transcoded video',

  // ── Web search (also matched by category='search' branch) ────
  google_web_search: 'Searched the web',
  web_search: 'Searched the web',
  websearch: 'Searched the web',
  webfetch: 'Fetched a web page',
  web_fetch: 'Fetched a web page',

  // ── Cross-thread recall (`tw_recall_*` MCP tools) ────────────
  tw_recall_find: 'Searched past threads',
  tw_recall_read: 'Read a past run',
  tw_recall_read_events: 'Read a past run',

  // ── Knowledge graph (Gemini `kg_*` family) ───────────────────
  kg_search: 'Searched knowledge graph',
  kg_list: 'Listed knowledge graph',
  kg_describe: 'Described knowledge graph',
  kg_query: 'Queried knowledge graph',

  // ── Directory / file enumeration aliases ─────────────────────
  ls: 'Listed directory',
  list_files: 'Listed files',
  directory_list: 'Listed directory',
  read_directory: 'Read directory',
  file_search: 'Searched files',

  // ── Misc shell / search aliases not always reached by the
  // category branches (some providers emit these as the literal
  // unqualified name without a query parameter). ───────────────
  grep: 'Grep',
  rg: 'Ripgrep',
  glob: 'Glob',
  grep_search: 'Grep search'
}

/**
 * Title-case fallback for tools that aren't in the dictionary.
 * "magic_tool" → "Magic Tool"; "MCPSomeWeirdTool" → "MCPSomeWeirdTool"
 * (only snake_case is rewritten; camelCase / PascalCase pass through).
 */
export function titleCaseToolName(rawToolName: string): string {
  if (!rawToolName) return rawToolName
  // Only humanise snake_case shapes. Preserve already-cased identifiers.
  if (!/_/.test(rawToolName)) return rawToolName
  return rawToolName
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Look up the human-readable label for a tool name. Returns
 * undefined when the tool isn't in the dictionary so callers can
 * fall through to their own naming logic (file-path-aware labels,
 * "Used …" prefix, etc.).
 *
 * The argument should already be unqualified (namespace prefixes
 * stripped) and lower-case — that's what ToolParser passes in.
 */
export function lookupToolDisplayName(unqualifiedLowerName: string): string | undefined {
  if (!unqualifiedLowerName) return undefined
  return TOOL_DISPLAY_NAMES[unqualifiedLowerName]
}
