export const TASKWRAITH_MCP_TOOLS = [
  'run_shell_command',
  'write_file',
  'replace',
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path',
  'read_file',
  'list_directory',
  'find_files',
  'workspace_search',
  'web_search',
  'web_fetch',
  'apply_patch',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_blame',
  'git_stage',
  'git_commit',
  'git_push',
  'git_create_pr',
  'run_task',
  'start_background_process',
  'list_background_processes',
  'read_background_process',
  'kill_background_process',
  'get_diagnostics',
  'list_active_runs',
  'cancel_active_run',
  'list_chat_attachments',
  'inspect_chat_attachment',
  'workspace_board_snapshot',
  'workspace_board_preview_plan',
  'workspace_board_apply_plan',
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
  'ensemble_roster_edit',
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
  'canvas_render_html',
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
  'image_generate',
  // In-house media surface (proving slice) — synthesize a tone with the Web
  // Audio API, hand-build a pure-JS WAV (no native dep), and render its waveform
  // as an inline PNG attachment with peak/RMS/dBFS introspection. Headless,
  // network-cut, parameterized render (numbers + fixed-enum only — NOT eval).
  // Gated as a file change, like the image tools. See src/main/mcp/AudioToolExecutors.ts.
  'audio_render_wav',
  // Decode a REAL workspace audio file (wav/mp3/m4a/ogg/flac) and report
  // peak/RMS/dBFS/clipping/silence + a waveform PNG — introspection the
  // drive-the-real-app path can't give. Reads a path-jailed workspace file;
  // gated as a file change (writes a waveform asset).
  'audio_analyze',
  // Cut a [startMs,endMs] WINDOW of a workspace audio file into a PLAYABLE, content-
  // addressed WAV clip (waveform peaks + best-effort on-device transcript) that rides
  // the TRUSTED AV media_refs channel and renders as an interactive player. Slices via
  // the daemon's native audio.windowClip; path-jailed read. Content-addresses the
  // INTERNAL asset store only (no workspace file) → read-only-safe (orchestration). See
  // src/main/mcp/AudioToolExecutors.ts.
  'inspect_audio_segment',
  // Analyze a workspace media file with the user-installed ffprobe (S1b): codec,
  // dimensions, fps, duration, rotation, HDR, channels — over a realpath-jailed
  // path with a FIXED argv (intents not flags; -protocol_whitelist file). Runs an
  // external subprocess, so gated as a file change. See src/main/mcp/FfmpegToolExecutors.ts.
  'video_probe',
  // Extract one PNG frame from a workspace video (S1b-2) via ffmpeg — rides the
  // proven image media spine and renders inline.
  'video_thumbnail',
  // Decode a single video frame via the daemon's native VideoToolbox (no ffmpeg
  // required; hardware-accelerated). Like video_thumbnail the frame is a PNG, so
  // it rides the proven image media spine and renders inline. Reads a realpath-
  // jailed workspace path; gated as a file change. See src/main/mcp/VtToolExecutors.ts.
  'video_decode_frame',
  // Decode SEVERAL frames from a workspace video in one call (read-only) — at explicit
  // timestamps, every N seconds, or just [0]. Loops the SAME native VideoToolbox decode
  // as video_decode_frame; each frame is a PNG that rides the proven image media spine,
  // grouped into an NLE filmstrip in the transcript. Read-only-safe (orchestration).
  // See src/main/mcp/VtToolExecutors.ts.
  'inspect_video_frames',
  // Re-encode a SEGMENT of a workspace video to an H.264 MP4 via the daemon's native
  // VideoToolbox (no ffmpeg required; hardware-accelerated). Output is a video FILE,
  // so — like transcode_video — it rides the TRUSTED non-image media_refs channel
  // (NOT the image lane that video_decode_frame uses). Writes a new file; gated as a
  // file change. See src/main/mcp/VtToolExecutors.ts.
  'video_encode_clip',
  // Concatenate N video SEGMENTS (each a workspace video + optional trim) into one
  // H.264 MP4 via the daemon's native VideoToolbox (no ffmpeg required; hardware-
  // accelerated). Like video_encode_clip the output is a video FILE, so it rides the
  // same TRUSTED non-image media_refs channel. Each segment path is realpath-jailed
  // before the daemon runs. Writes a new file; gated as a file change. See
  // src/main/mcp/VtToolExecutors.ts.
  'video_concat_clips',
  // Media PRODUCERS (S1b-3) — write a standalone output media file via ffmpeg
  // over a trusted non-image media_refs channel. `audio_extract` pulls the audio
  // track out of a video; `transcode_audio` re-encodes audio to wav/m4a/mp3;
  // `transcode_video` re-encodes video to H.264/AAC MP4 (faststart). Run an
  // external subprocess, so gated as a file change. See src/main/mcp/FfmpegToolExecutors.ts.
  'audio_extract',
  'transcode_audio',
  // Mix N workspace AUDIO tracks (each + optional gain/pan/offset/fade) down to one
  // WAV/M4A file via the daemon's NATIVE audio engine (no ffmpeg required). Like the
  // video producers the output is an audio FILE, so it rides the TRUSTED non-image
  // media_refs channel. Each track's sourcePath is realpath-jailed before the daemon
  // runs. Writes a new file; gated as a file change. See src/main/mcp/VtToolExecutors.ts.
  'audio_mix',
  // ON-DEVICE speech-to-text of a workspace audio file via the daemon's native Speech
  // framework (SFSpeechRecognizer; on-device ONLY, no network). Writes NO file and emits
  // NO media ref — returns the transcript as structured text. The sourcePath is realpath-
  // jailed before the daemon runs. Non-mutating, read-only-safe (orchestration). See
  // src/main/mcp/VtToolExecutors.ts.
  'transcribe_audio',
  'transcode_video'
] as const

export type TaskWraithMcpToolName = (typeof TASKWRAITH_MCP_TOOLS)[number]

export const TASKWRAITH_MCP_TOOL_LIST = TASKWRAITH_MCP_TOOLS.join(', ')

/**
 * The audio/video media tools. ALL map to the dedicated `mediaEditing` agentic
 * service (grant bucket + audit tag) so they're gated/audited at shell/file
 * strictness instead of falling through to the generic `mcpTools` service.
 *
 * Sourced from the canonical TaskWraith tool list above (each name must be a
 * member of TASKWRAITH_MCP_TOOLS) so this set can't drift from the real tools.
 * Both the Codex/Gemini classifier (taskWraithToolAgenticService) and the Claude
 * classifier (claudeAgenticServiceForTool) key off this set via MEDIA_EDITING_TOOLS.
 *
 * NOTE: `video_decode_frame` is included here for the agentic SERVICE (grant
 * bucket + audit), even though it is read-only-SAFE (`orchestration`) on the
 * separate ToolClassTaxonomy axis — its read-only safety rides that axis, not a
 * read-tier split here (mirrors how read-only file reads share treatment without
 * a dedicated read service).
 */
export const MEDIA_EDITING_TOOL_NAMES = [
  'transcode_audio',
  'transcode_video',
  'audio_extract',
  'audio_render_wav',
  'audio_analyze',
  'inspect_audio_segment',
  'video_probe',
  'video_thumbnail',
  'video_decode_frame',
  'inspect_video_frames',
  'video_encode_clip',
  'video_concat_clips',
  'audio_mix',
  'transcribe_audio'
] as const satisfies readonly TaskWraithMcpToolName[]

export type MediaEditingToolName = (typeof MEDIA_EDITING_TOOL_NAMES)[number]

/** Membership set for O(1) classifier lookups. */
export const MEDIA_EDITING_TOOLS: ReadonlySet<string> = new Set(MEDIA_EDITING_TOOL_NAMES)
