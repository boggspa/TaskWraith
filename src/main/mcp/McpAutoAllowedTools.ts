import {
  MEDIA_EDITING_TOOLS,
  MESH_SCENE_MCP_TOOL_NAMES,
  TASKWRAITH_MCP_TOOLS,
  type TaskWraithMcpToolName
} from '../TaskWraithMcpTools'

/**
 * MCP tools that skip the per-call approval modal (auto-allowed).
 *
 * ⚠️ SAFETY INVARIANT — this set may contain ONLY host-safe non-mutating tools
 * plus explicit chat-local coordination updates (`todo_write`, goal lifecycle
 * updates, `blackboard_post`, `scout_brief`, and the audited ensemble
 * participation tools — poll vote/propose + `ensemble_send`).
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
  // appshots_status lists owned/attached capture targets without pixels.
  'appshots_status',
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
  // 1.0.4-AN — ensemble PARTICIPATION tools (vote + peer-open a goal-complete
  // poll). Per the all-participants-vote ratification these are read-only-callable
  // app-state participation: auto-allowed (prompt-free) + read-only advertised.
  // They STAY in MCP_APP_STATE_MUTATION_TOOLS (below) so route/workspace-lineage
  // guards still treat them as mutations. See MCP_ENSEMBLE_PARTICIPATION_TOOLS.
  'ensemble_poll_response',
  'ensemble_propose_goal_complete',
  // Efficiency audit 2026-07 — ensemble_send joins the participation exception.
  // The prompt and catalog schema have always advertised it as read-only visible
  // coordination ("send a visible note into the main transcript"), but gating it
  // as a generic app-state mutation meant read-only seats were hard-denied and
  // write seats hit the approval modal — observed transcripts show denied sends
  // followed by blackboard/yield detours that reach the SAME audience slower.
  // It is strictly less powerful than the ratified poll tools above (a visible
  // chat-local note vs a vote that can drive a BINDING goal-complete quorum):
  // no workspace mutation, no egress, host-validated route/roster resolution,
  // and the message renders inline for the user. Stays in
  // MCP_APP_STATE_MUTATION_TOOLS so route/workspace-lineage guards are unchanged.
  'ensemble_send',
  // A Scout returning its bounded findings is the completion step of an
  // already-authorized fan-out lane, not a new host action. The handler accepts
  // this only from a tracked participant in the active Scout pass, performs no
  // workspace or network I/O, and rejects every out-of-lane call. Auto-allowing
  // it also advertises the handoff to read_only Scouts instead of making them
  // ask permission to finish their assigned lane.
  'scout_brief',
  // QMOD (1.0.3): asking the user a question is the inverse of the
  // user prompting the agent — it's a focus-shift, not a state mutation.
  // The renderer modal IS the approval surface, so a second confirm
  // step would be silly. Universally auto-allowed.
  'ask_user_question',
  // This capability only opens a one-shot, exact-call approval modal. It cannot
  // execute its target until that main-authority prompt is accepted, and it
  // never mints a standing grant. Auto-allowing the outer elicitation is what
  // lets read-only/plan seats ask the human to override their posture once.
  'request_tool_permission',
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
  // Proposals persist bounded untrusted run evidence only. Human review is the
  // sole path that mutates the Project library; proposing performs no I/O,
  // fetch, grant, or workspace write.
  'project_reference_propose',
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
  // Runs a fixed-argv git status snapshot; it does not stage, modify, or
  // otherwise mutate the repository, so read-only and plan seats may inspect
  // their working tree without an approval prompt.
  'git_status',
  // 2026-07-25 (user decision): git_diff + git_log join git_status. Both
  // executors build FIXED argv from structured params (scoped pathspecs after
  // `--`, sanitizeGitRef rejects leading-dash injection, log output bounded by
  // max-count/pretty), so there is no flag-injection surface. This narrows the
  // earlier "history reads stay gated" stance to git_show / git_blame, which
  // remain gated (arbitrary-object reads / line-provenance).
  'git_diff',
  'git_log',
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
  // TaskWraith Canvas read-only verbs. No pixels, no workspace mutation:
  // list/status are metadata the user already sees; snapshot/inspect run FIXED
  // inspection scripts (not agent-supplied JS); network/console are read-only
  // buffers. Sketch open/get are chat-owned structured-document reads: opening
  // restores the same persisted sketch and does not navigate, fetch, or alter
  // its elements. Web canvas_open / screenshot / resize / close stay gated.
  'canvas_list',
  'canvas_status',
  'canvas_snapshot',
  'canvas_inspect',
  'canvas_sketch_open',
  'canvas_sketch_get',
  'canvas_network',
  'canvas_console',
  // Thread Introspection read-only verbs — bounded pack metadata / full pack read.
  'tw_introspection_list',
  'tw_introspection_read',
  // Agent-programmed-graph reads: a bounded JOIN on lane settlement and a
  // structured lane-output fetch. Neither mutates anything — await polls the
  // persisted round's lane statuses; lane_result reads durable transcript
  // messages the caller's prompts already receive via shared history.
  'ensemble_await',
  'ensemble_lane_result'
])

export const MCP_APP_STATE_MUTATION_TOOLS = new Set<TaskWraithMcpToolName>([
  'ensemble_send',
  'ensemble_fanout',
  'ensemble_fanout_all',
  'ensemble_control',
  'ensemble_bossman_control',
  'ensemble_poll_response',
  'ensemble_propose_goal_complete',
  'ensemble_roster_edit',
  'ensemble_brief_update',
  'schedule_wakeup',
  'cancel_wakeup',
  'blackboard_delete',
  'workspace_board_apply_plan',
  'tw_introspection_run',
  'tw_introspection_review',
  // Outlook draft creation mutates the user's mailbox. Both are absent from
  // MCP_AUTO_ALLOWED_TOOLS (so they always prompt) and listed here so the
  // route/workspace-lineage guards treat them as mutations and read_only
  // seats are denied outright.
  'outlook_create_draft',
  'outlook_create_event'
])

/**
 * 1.0.4-AN — the audited read-only PARTICIPATION exception: the ensemble
 * participation tools a read_only-preset seat may call WITHOUT an approval
 * prompt — the two poll tools (the user's "all participants vote" spec) plus,
 * per the 2026-07 efficiency audit, ensemble_send (visible chat-local
 * coordination notes; see the rationale in MCP_AUTO_ALLOWED_TOOLS). They are
 * auto-allowed + read-only advertised + orchestration-class, yet REMAIN in
 * MCP_APP_STATE_MUTATION_TOOLS so route/workspace-lineage guards still treat
 * them as mutations. isReadOnlyBlockedTool exempts ONLY this set; every
 * filesystem / shell / workspace-write / other app-state tool stays blocked
 * under read-only.
 */
export const MCP_ENSEMBLE_PARTICIPATION_TOOLS = new Set<TaskWraithMcpToolName>([
  'ensemble_poll_response',
  'ensemble_propose_goal_complete',
  'ensemble_send'
])

/**
 * Recon-tier instrument tools: the approval-gated instruments a `read_only`
 * (Recon) seat may REACH that remain outside MCP_AUTO_ALLOWED_TOOLS. Today this
 * is exactly Canvas Browser navigation (user decision 2026-08-04): read-class
 * browsing in the sandboxed preview surface — the same reach web_fetch already
 * has prompt-free — offered to Recon as a per-invocation ASK instead of the
 * old silent unavailability. CRITICAL INVARIANT (mirrors the plan-instrument
 * tier below): nothing here is auto-allowed, so every call still hits the host
 * approval gate; advertising makes it REACHABLE and approval-queued, NEVER
 * auto-run. Its dedicated `webBrowsing` service resolves to ASK under
 * read_only/plan with grant-immunity (isPlanInstrumentGrantHold), and the
 * global kill switch still forces deny. DERIVED, never hand-listed.
 */
export const RECON_INSTRUMENT_ADVERTISE_TOOLS: ReadonlyArray<TaskWraithMcpToolName> = Object.freeze(
  TASKWRAITH_MCP_TOOLS.filter((tool) => tool === 'canvas_navigate')
)

/**
 * Tools advertised to a READ-ONLY / plan seat: (TASKWRAITH_MCP_TOOLS ∩
 * MCP_AUTO_ALLOWED_TOOLS) — the advertised universe narrowed to read/search
 * plus coordination-state updates — PLUS the recon-tier gated instruments
 * above. DERIVED, never hand-listed, so a mutating workspace/shell/destructive
 * app tool can never appear here unless it is also wrongly added to
 * MCP_AUTO_ALLOWED_TOOLS (SAFETY INVARIANT test) or wrongly promoted to the
 * recon instrument tier (its own invariant test). The Gemini read-only
 * --allowed-tools allowlist, the Grok and Cursor read-only safe-subset
 * bridges, the Mistral safe-tool gate, and the Ollama read_only tool tier are
 * all built from this set, so every read-only seat advertises an identical
 * surface.
 */
export const READ_ONLY_MCP_ADVERTISE_TOOLS: ReadonlyArray<TaskWraithMcpToolName> = Object.freeze([
  ...TASKWRAITH_MCP_TOOLS.filter((tool) => MCP_AUTO_ALLOWED_TOOLS.has(tool)),
  ...RECON_INSTRUMENT_ADVERTISE_TOOLS
])

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
 * canvas_fill), structured Sketch edits (canvas_sketch_update), Mesh scene
 * authoring (the meshCanvas-service tools), and media compute (the
 * mediaEditing-service tools). CRITICAL INVARIANT: none of these are in
 * MCP_AUTO_ALLOWED_TOOLS, so every one still hits the host approval gate
 * (requestAgenticServiceApproval) when invoked. Advertising them to a plan
 * bridge seat makes them REACHABLE and approval-queued, NEVER auto-run — the
 * enforcement stays the main-side gate (canvasInteraction / sketchCanvas /
 * meshCanvas / mediaEditing = 'ask' under the plan preset). A read_only seat
 * never sees them.
 */
export const PLAN_INSTRUMENT_ADVERTISE_TOOLS: ReadonlyArray<TaskWraithMcpToolName> = Object.freeze(
  TASKWRAITH_MCP_TOOLS.filter(
    (tool) =>
      tool === 'canvas_click' ||
      tool === 'canvas_fill' ||
      tool === 'canvas_sketch_update' ||
      (MESH_SCENE_MCP_TOOL_NAMES as readonly string[]).includes(tool) ||
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
