export const TASKWRAITH_MCP_TOOLS = [
  'run_shell_command',
  'write_file',
  'replace',
  'read_file',
  'list_directory',
  'workspace_search',
  'web_search',
  'web_fetch',
  'apply_patch',
  'git_status',
  'git_diff',
  'git_stage',
  'git_commit',
  'run_task',
  'test_result_summary',
  'list_subthreads',
  'read_subthread_result',
  'cancel_subthread',
  'workspace_symbols',
  'browser_open',
  'browser_click',
  'browser_screenshot',
  'browser_console',
  'attached_window_capture',
  'attached_window_status',
  // Phase M1 — Appwatch MVP. Continuous low-fps ring buffer of the attached
  // window. `start`/`stop` bracket the SCStream; `latest_frame` pulls the
  // newest BGRA frame as PNG without per-call ScreenCaptureKit overhead.
  // M2 will add batch since-T retrieval and per-frame OCR.
  'appwatch_start',
  'appwatch_stop',
  'appwatch_status',
  'appwatch_latest_frame',
  'appwatch_frames',
  'approval_status',
  'provider_auth_status',
  // 1.0.4-AR9 — coarse quota-band view for the agent so it can
  // self-throttle / pick lighter models when a provider's window
  // is near exhaustion. See `executeProviderUsageStatus`.
  'provider_usage_status',
  'run_timeline',
  'raw_provider_events',
  'open_workspace_file',
  'creative_app_status',
  'creative_app_capabilities',
  'creative_project_snapshot',
  'creative_timeline_validate',
  'creative_timeline_ir',
  'creative_timeline_diff',
  // Phase K3 — write IR to .fcpxml + dispatch to FCP via NSWorkspace
  // (with user approval modal). Mutates state, hence the gate.
  'creative_timeline_import',
  // Phase K4 — dispatch a named AppleScript class against FCP or
  // Logic, with session-class approval cache. Source is constructed
  // from a curated library; raw-source path exists but never caches.
  'creative_applescript_dispatch',
  // Phase K5 — run a Blender Python script via subprocess Blender
  // --background --python in a per-invocation sandbox tempdir. Same
  // class-cache pattern as K4.
  'creative_blender_python',
  // Phase K6 — send a single MIDI event through the daemon's virtual
  // "TaskWraith" Core MIDI source. Logic Pro (or any MIDI receiver) can
  // route this source as an input. MIDI events to a virtual port have
  // no destructive surface, so the tool is gated by an
  // approval-once-per-event-type cache rather than a per-call modal.
  'creative_midi_dispatch',
  // Phase L — Editor / IDE transport tools. Auto-allowed: opening a
  // file in the user's editor of choice is a focus-change, not a
  // state mutation.
  'open_in_ide',
  'open_in_ide_at_position',
  'reveal_in_finder',
  'ide_app_status',
  'ide_app_capabilities',
  'list_running_ides',
  'create_handoff_card',
  'switch_auth_profile',
  'agent_delegation_role',
  'ensemble_yield',
  'ensemble_send',
  'ensemble_fanout',
  'ensemble_bossman_control',
  'list_ensemble_participants',
  'schedule_wakeup',
  'cancel_wakeup',
  // QMOD (1.0.3): universal "ask the user" tool. Agents call this when
  // they need clarification mid-run instead of trying to emit a
  // question into the chat stream and hoping the user notices. Renderer
  // shows a modal card (reuses .plan-choice-card surface) and the
  // tool's response is the user's selected option or free-text reply.
  // Critical for vague prompts, mid-task decision forks, and plan-mode
  // clarification alike. Universally auto-allowed.
  'ask_user_question',
  // Persistent thread goal lifecycle. The user owns objective set/clear via
  // /goal and composer controls; agents may read and update lifecycle only.
  'goal_read',
  'goal_update',
  'update_goal',
  'goal_complete',
  'goal_blocked',
  // 1.4.2 — universal goal-step / todo checklist surface. Agents call this
  // to publish a structured task list the renderer shows as a checklist
  // card (and pins the current step in the live activity viewport).
  'todo_write',
  'delegate_to_subthread',
  // 1.0.4-AK — Ensemble Work Session control tool. Lets a participant
  // queue exactly one follow-up round in the active Work Session
  // (`acceptanceStatus: 'inProgress'`), report completion to end the
  // session cleanly (`'complete'`), or pause for user input
  // (`'blocked'`). No-op when no Work Session is active. Validated +
  // dispatched in `src/main/EnsembleContinue.ts`.
  'ensemble_continue',
  // 1.0.4-AK6 — structured brief emitted by a participant at the
  // end of their parallel fan-out lane. Threaded into the
  // serial writer's prompt context so the writer can synthesize
  // the panel's read-only findings before acting. Validated +
  // recorded in `src/main/ScoutBrief.ts`. No-op outside an active
  // parallel fan-out pass.
  'scout_brief',
  // M4 — explicit shared scratchpad writes. Participants use this
  // for durable agreed facts / risks / decisions; conversational
  // participant-to-participant messages use `ensemble_send`.
  'blackboard_post',
  // TaskWraith Canvas (P0) — exclusive preview/runtime surface. Agents open a
  // sandboxed preview of a running app (web driver = an http(s) dev server),
  // then snapshot (a stable-ref element tree), screenshot, inspect, and read
  // console/network. Read-only verbs are auto-allowed; open/screenshot/resize/
  // close are gated like browser_open. Interaction (click/fill) + annotation
  // land in P1; arbitrary `eval` (P2) is signed-elevated (canvasEval service).
  'canvas_open',
  'canvas_list',
  'canvas_status',
  'canvas_snapshot',
  'canvas_screenshot',
  'canvas_inspect',
  'canvas_network',
  'canvas_console',
  'canvas_resize',
  // P1 interaction + annotation. click/fill mutate the app (gated; read-only-DENY);
  // annotate overlays numbered Set-of-Mark boxes for the human (gated).
  'canvas_click',
  'canvas_fill',
  'canvas_annotate',
  // P2 arbitrary eval (RCE) — runs agent-supplied JS in the page. Signed-elevated:
  // gated via the canvasEval service (never auto-allowed), egress-cut while running.
  'canvas_eval',
  'canvas_close',
  // Cross-thread retrospection (recall) — an in-thread agent resolves a vague
  // {provider, workspace, time, task} reference to a past run on ANOTHER
  // thread/provider/workspace and reads how far it got. Read-only; `find` is
  // NOT auto-allowed and cross-workspace reads are gated by the crossThreadRead
  // approval service. See src/main/mcp/RecallToolExecutors.ts.
  'tw_recall_find',
  'tw_recall_read',
  'tw_recall_read_events',
  // Image processing — edit (blur/redact/crop/resize) an existing image, or
  // rasterize SVG to PNG. Output rides back as a visible transcript attachment.
  // Gated as a file change (mutating/compute; denied under read-only), NEVER
  // auto-allowed. See src/main/mcp/ImageToolExecutors.ts.
  'image_edit',
  'svg_rasterize',
  // Text->image generation via a paid API. Default OFF (requires an enabled
  // flag + a safeStorage-encrypted key in Settings); gated as a file change.
  'image_generate'
] as const

export type TaskWraithMcpToolName = (typeof TASKWRAITH_MCP_TOOLS)[number]

export const TASKWRAITH_MCP_TOOL_LIST = TASKWRAITH_MCP_TOOLS.join(', ')
