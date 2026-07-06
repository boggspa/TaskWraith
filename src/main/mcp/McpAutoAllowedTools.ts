import {
  MEDIA_EDITING_TOOLS,
  TASKWRAITH_MCP_TOOLS,
  type TaskWraithMcpToolName
} from '../TaskWraithMcpTools'

/**
 * MCP tools that skip the per-call approval modal (auto-allowed).
 *
 * ⚠️ SAFETY INVARIANT — this set may contain ONLY host-safe non-mutating tools
 * plus explicit chat-local coordination updates (`todo_write`, goal lifecycle
 * updates, and `blackboard_post`).
 * Being a member makes a tool SKIP the host-side approval gate
 * (`requestAgenticServiceApproval`), so any mutating tool added here would
 * execute even under the `read_only` preset. Writes / shell / patch tools and
 * destructive app-state mutation tools MUST stay out — they remain gated and are
 * denied under read_only. Web reads are listed here but every provider preflight
 * checks `networkAccess` before auto-allowing them, so the global/run network
 * kill switch still wins. The invariant is enforced by
 * `McpAutoAllowedTools.test.ts`; do not weaken it.
 *
 * Historically this held only status / focus tools (state the user already
 * sees, or focus changes). 1.0.71+ adds the workspace READ tools so every
 * read-only participant — notably Claude, whose SDK plan-mode otherwise made
 * every file read hit the approval modal — gets the same friction-free read
 * surface Gemini already had. Those reads are genuinely read-only (`fs` reads +
 * fixed-argv ripgrep invocations, no shell) and are workspace-scope-guarded
 * (symlink/traversal-proof) in workspace chats. NOTE: in *global-scope* chats
 * the workspace path guard is bypassed by design, so auto-allowing reads there
 * means individual reads are no longer prompted — acceptable (reads only;
 * writes / shell stay gated; web reads still obey the network gate), but worth
 * knowing if global-scope per-read prompting is ever wanted back.
 */
export const MCP_AUTO_ALLOWED_TOOLS = new Set<TaskWraithMcpToolName>([
  'approval_status',
  'provider_auth_status',
  'list_active_runs',
  'list_background_processes',
  'read_background_process',
  'browser_console',
  'creative_app_status',
  'creative_app_capabilities',
  // attached_window_status carries no pixel data and no window enumeration —
  // only the title/bundle the user already sees in the renderer pill.
  // Capture stays gated; status is a read of state the user already shared.
  'attached_window_status',
  // appwatch_status is the same data class as attached_window_status: no
  // pixel data, only stream-up/down + counts the renderer pill already
  // shows. Start / stop / latest_frame stay gated.
  'appwatch_status',
  // Phase L — Editor / IDE transport tools. Opening a file in the
  // user's editor of choice is a focus-change, not a state mutation.
  // No destructive surface beyond the agent's choice of editor (which
  // we constrain via the EditorAdapters bundle allowlist).
  'open_in_ide',
  'open_in_ide_at_position',
  'reveal_in_finder',
  'ide_app_status',
  'ide_app_capabilities',
  'list_running_ides',
  'ensemble_yield',
  'list_ensemble_participants',
  // QMOD (1.0.3): asking the user a question is the inverse of the
  // user prompting the agent — it's a focus-shift, not a state mutation.
  // The renderer modal IS the approval surface, so a second confirm
  // step would be silly. Universally auto-allowed.
  'ask_user_question',
  // Persistent goal lifecycle is host UI coordination only. Tool schemas
  // prevent agents from replacing or clearing the user-owned objective.
  'goal_read',
  'goal_update',
  'update_goal',
  'goal_complete',
  'goal_blocked',
  // 1.4.2 — goal-step checklist updates are non-mutating run coordination.
  'todo_write',
  // Shared blackboard posts are coordination state, like todo_write. Deletion
  // remains a destructive app-state mutation and is not auto-allowed.
  'blackboard_post',
  // Blackboard reads are bounded, chat-local, and only mutate the per-entry
  // seenBy marker for the calling participant so slim prompts can omit it.
  'blackboard_read',
  // Evidence Packs are run-observability/progress records, not workspace
  // mutation. Read-only agents must still be able to leave auditable evidence
  // and check whether completion language is supported.
  'prompt_task_normalize',
  'scope_radar',
  'repo_convention_scan',
  'coherence_gate_check',
  'evidence_pack_write',
  'completion_claim_check',
  // 1.0.71+ — workspace READ tools (see header). Read-only + host-gate-safe:
  // writes/shell are NOT here, so they still hit the gate and are denied under
  // read_only. This is what gives read-only Claude/Kimi parity with Gemini's
  // read surface instead of a modal on every read.
  'read_file',
  'list_directory',
  'find_files',
  'workspace_search',
  'workspace_symbols',
  'list_chat_attachments',
  'inspect_chat_attachment',
  'workspace_board_snapshot',
  'workspace_board_preview_plan',
  // Web reads are non-mutating and are available in every permission posture.
  // NetworkAccess is enforced before the auto-allow fast path in the provider
  // preflight/shared dispatcher, so global/run offline policies still deny.
  'web_search',
  'web_fetch',
  'github_ci_status',
  // TaskWraith Canvas read-only verbs. No pixels, no mutation: list/status are
  // metadata the user already sees; snapshot/inspect run FIXED inspection
  // scripts (not agent-supplied JS); network/console are read-only buffers.
  // canvas_open / canvas_screenshot / canvas_resize / canvas_close stay GATED
  // (window lifecycle + pixel egress), like browser_open.
  'canvas_list',
  'canvas_status',
  'canvas_snapshot',
  'canvas_inspect',
  'canvas_sketch_get',
  'canvas_network',
  'canvas_console',
  // Thread Introspection read-only verbs — bounded pack metadata / full pack read.
  'tw_introspection_list',
  'tw_introspection_read'
])

export const MCP_APP_STATE_MUTATION_TOOLS = new Set<TaskWraithMcpToolName>([
  'ensemble_send',
  'ensemble_fanout',
  'ensemble_bossman_control',
  'ensemble_poll_response',
  'ensemble_roster_edit',
  'ensemble_brief_update',
  'schedule_wakeup',
  'cancel_wakeup',
  'blackboard_delete',
  'workspace_board_apply_plan',
  'tw_introspection_run',
  'tw_introspection_review'
])

/**
 * Tools advertised to a READ-ONLY / plan seat: TASKWRAITH_MCP_TOOLS ∩
 * MCP_AUTO_ALLOWED_TOOLS — the advertised universe narrowed to read/search plus
 * coordination-state updates. Single source of truth (DERIVED, never
 * hand-listed), so a mutating workspace/shell/destructive app tool can never
 * appear here unless it is also wrongly added to MCP_AUTO_ALLOWED_TOOLS — which
 * the SAFETY INVARIANT test forbids. The Gemini read-only --allowed-tools
 * allowlist and the Grok read-only mcpServers safe-subset are both built from
 * this set, so all three providers advertise an identical surface in read-only.
 */
export const READ_ONLY_MCP_ADVERTISE_TOOLS: ReadonlyArray<TaskWraithMcpToolName> = Object.freeze(
  TASKWRAITH_MCP_TOOLS.filter((tool) => MCP_AUTO_ALLOWED_TOOLS.has(tool))
)

/**
 * Is this bare tool name in the read-only advertise subset? The bridge uses this
 * to scope BOTH tools/list and tools/call for a read-only seat (notably Grok,
 * which auto-runs MCP tools with NO host gate — so the advertised list AND the
 * tools/call reject are the entire safety boundary). Unknown / mutating tools
 * return false.
 */
export function isReadOnlyAdvertisedTool(name: string): boolean {
  return (READ_ONLY_MCP_ADVERTISE_TOOLS as readonly string[]).includes(name)
}

/**
 * Plan-tier instrument tools: the approval-gated instruments a `plan` seat may
 * reach that a `read_only` seat may not — canvas actuation (canvas_click /
 * canvas_fill) and media compute (the mediaEditing-service tools). CRITICAL
 * INVARIANT: none of these are in MCP_AUTO_ALLOWED_TOOLS, so every one still hits
 * the host approval gate (requestAgenticServiceApproval) when invoked. Advertising
 * them to a plan bridge seat makes them REACHABLE and approval-queued, NEVER
 * auto-run — the enforcement stays the main-side gate (canvasInteraction /
 * mediaEditing = 'ask' under the plan preset). A read_only seat never sees them.
 */
export const PLAN_INSTRUMENT_ADVERTISE_TOOLS: ReadonlyArray<TaskWraithMcpToolName> = Object.freeze(
  TASKWRAITH_MCP_TOOLS.filter(
    (tool) =>
      tool === 'canvas_click' ||
      tool === 'canvas_fill' ||
      tool === 'canvas_sketch_update' ||
      MEDIA_EDITING_TOOLS.has(tool)
  )
)

/**
 * The advertise set for a `plan` bridge seat: the read-only safe subset PLUS the
 * plan-tier instruments. Still fail-closed — anything outside this set is rejected
 * at the bridge; everything inside it is either auto-allowed-safe (the read-only
 * subset) or host-gated (the instruments). DERIVED, never hand-listed.
 */
export const PLAN_MCP_ADVERTISE_TOOLS: ReadonlyArray<TaskWraithMcpToolName> = Object.freeze([
  ...READ_ONLY_MCP_ADVERTISE_TOOLS,
  ...PLAN_INSTRUMENT_ADVERTISE_TOOLS
])

/**
 * Is this bare tool name advertised to a `plan` bridge seat (read-only subset +
 * plan instruments)? Used by the bridge tools/list + tools/call scope when the
 * seat carries the plan-subset flag. Unknown / mutating (write/shell) tools return
 * false, so they stay rejected exactly as for a read_only seat.
 */
export function isPlanAdvertisedTool(name: string): boolean {
  return (PLAN_MCP_ADVERTISE_TOOLS as readonly string[]).includes(name)
}
