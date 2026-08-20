// Pure TaskWraith MCP tool catalog — the canonical tool-name list, its derived
// type/const, the tool-name canonicalizer, and the media-editing set.
//
// ZERO imports from src/main or src/renderer BY DESIGN: this is the shared
// source of truth that both src/shared/canonicalToolCoalesce and
// src/main/TaskWraithMcpTools (now a thin re-export) consume, so the
// architecture guard's `sharedUpwardRuntimeEdges` budget stays []. Lifted
// verbatim from src/main/TaskWraithMcpTools.ts (137a7a8b7 introduced the sole
// shared -> main runtime edge this extract removes). Keep it dependency-free.
export const MESH_SCENE_MCP_TOOL_NAMES = [
  'mesh_scene_create',
  'mesh_scene_list',
  'mesh_scene_inspect',
  'mesh_scene_import',
  'mesh_scene_apply',
  'mesh_scene_set_material',
  'mesh_scene_present',
  'mesh_scene_close',
  'mesh_scene_delete'
] as const

/** Editable topology additions; kept separate so frozen v7-v14 profiles retain the original nine. */
export const MESH_TOPOLOGY_MCP_TOOL_NAMES = [
  'mesh_topology_convert',
  'mesh_topology_inspect',
  'mesh_topology_edit'
] as const

export const MESH_MCP_TOOL_NAMES = [
  ...MESH_SCENE_MCP_TOOL_NAMES,
  ...MESH_TOPOLOGY_MCP_TOOL_NAMES
] as const

/** Simulator Canvas MCP surface — status/inspect are auto-allowed; the rest gate on simulatorCanvas. */
export const SIMULATOR_MCP_TOOL_NAMES = [
  'simulator_status',
  'simulator_open',
  'simulator_boot',
  'simulator_install',
  'simulator_launch',
  'simulator_screenshot',
  'simulator_terminate',
  'simulator_inspect',
  'simulator_button',
  'simulator_rotate',
  'simulator_tap',
  'simulator_type',
  'simulator_scroll'
] as const

/** Mutating simulator control tools (approval-gated via simulatorCanvas). */
export const SIMULATOR_MUTATING_MCP_TOOL_NAMES = [
  'simulator_open',
  'simulator_boot',
  'simulator_install',
  'simulator_launch',
  'simulator_screenshot',
  'simulator_terminate',
  'simulator_button',
  'simulator_rotate',
  'simulator_tap',
  'simulator_type',
  'simulator_scroll'
] as const

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
  'github_ci_status',
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
  // Outlook mail + calendar over Microsoft Graph. Reads pull untrusted
  // third-party text into context; writes create DRAFTS only. There is no
  // send tool and the app never holds the Mail.Send scope, so none of these
  // can put a message in front of another human without the user pressing
  // send in Outlook themselves. All six stay approval-gated.
  'outlook_list_messages',
  'outlook_search_messages',
  'outlook_get_message',
  'outlook_list_events',
  'outlook_create_draft',
  'outlook_create_event',
  // Propose-only Project library inbox. This writes bounded untrusted metadata
  // to the current run ledger; only the human review surface can materialize a
  // normal ProjectReference, and proposal never reads/fetches/grants access.
  'project_reference_propose',
  // Read-only Project library catalogue browse (metadata only; never fetch/stat).
  'project_reference_list',
  'test_result_summary',
  'prompt_task_normalize',
  'scope_radar',
  'repo_convention_scan',
  'coherence_gate_check',
  'evidence_pack_write',
  'completion_claim_check',
  'list_subthreads',
  'read_subthread_result',
  'cancel_subthread',
  'claim_fleet_wave',
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
  // Agent AppShots — owned/attached process screenshots (optional interval burst).
  // Capture is posture-gated; status is auto-allowed like other status tools.
  'appshots',
  'appshots_status',
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
  'ensemble_fanout_all',
  // Agent-programmed graph primitives: JOIN (bounded wait on named lanes) and
  // READ (structured fetch of one lane's output). With ensemble_fanout these
  // let an agent express planner → workers → join → synthesize → gate → retry
  // entirely in tool calls; the transcript is the receipt, not a graph editor.
  'ensemble_await',
  'ensemble_lane_result',
  // Peer thread-to-thread message. The missing direction: SubThreadMailbox is
  // child -> parent and cross-thread recall is read-only, so this is the only way
  // one top-level chat hands a message to another. Gated by its OWN agentic
  // service (`threadMessage`), never by the generic mcpTools grant.
  'thread_message',
  // Compact, provider-neutral front door for the overloaded Boss/Captain
  // controller. It canonicalizes to ensemble_bossman_control at execution so
  // authority, approval, and audit semantics remain exactly the same.
  'ensemble_control',
  'ensemble_bossman_control',
  'ensemble_poll_response',
  // 1.0.4-AN — peer-openable BINDING goal-complete poll. Any eligible-at-open
  // seat may propose completing the active goal (quorum + authority veto decide),
  // so a finished panel isn't deadlocked when authority is unreachable.
  'ensemble_propose_goal_complete',
  'ensemble_roster_edit',
  'ensemble_brief_update',
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
  // Exact, one-shot escalation after an apparent permission-boundary failure.
  // The tool itself is auto-allowed so a restricted seat can reach the existing
  // approval modal; it performs no target action unless the human accepts.
  'request_tool_permission',
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
  // Spawn-only batch of ≥2 sub-threads sharing one wave join group.
  // Approval-gated via subThreadDelegation (Boss/Captain Full Access /
  // Full WS Access may skip the card); Ollama excluded like other
  // sub-thread tools.
  'delegate_wave',
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
  'blackboard_read',
  'blackboard_delete',
  // TaskWraith Canvas (P0) — exclusive preview/runtime surface. Agents open a
  // sandboxed preview of a running app (web driver = an http(s) dev server),
  // then snapshot (a stable-ref element tree), screenshot, inspect, and read
  // console/network. Read-only verbs are auto-allowed; open/screenshot/resize/
  // close are gated like browser_open. Interaction (click/fill) + annotation
  // land in P1; arbitrary `eval` (P2) is signed-elevated (canvasEval service).
  'launch_list_targets',
  'launch_start',
  'launch_adopt',
  'launch_stop',
  'launch_status',
  'canvas_open',
  'canvas_render_html',
  'canvas_render_chart',
  'canvas_open_attachment',
  'canvas_open_launch',
  'canvas_sketch_open',
  'canvas_sketch_get',
  'canvas_sketch_update',
  'canvas_list',
  'canvas_status',
  'canvas_snapshot',
  'canvas_screenshot',
  'canvas_inspect',
  'canvas_network',
  'canvas_console',
  'canvas_resize',
  // P1 interaction + annotation. Accept Edits+ authorizes ordinary click/fill;
  // stricter postures never auto-run them. Credential fields stay refused.
  // annotate overlays numbered Set-of-Mark boxes for the human (gated).
  'canvas_click',
  'canvas_fill',
  'canvas_key',
  'canvas_scroll',
  'canvas_hover',
  'canvas_select',
  'canvas_wait_for',
  'canvas_annotate',
  // P2 arbitrary eval (RCE) — runs agent-supplied JS in the page. Signed-elevated:
  // gated via the canvasEval service (never auto-allowed), egress-cut while running.
  'canvas_eval',
  // Canvas Browser navigation — goto/back/forward/reload/stop on the chat's
  // sandboxed web canvas, auto-opening one in the chat dock when none is open.
  // Gated by the dedicated webBrowsing service: allowed under Accept Edits+,
  // per-invocation ask under Ask, denied under Plan. Never actuation:
  // click/fill/eval keep their own stricter services.
  'canvas_navigate',
  'canvas_close',
  // Mesh Canvas — declarative, provider-agnostic 3D scene construction and
  // presentation. Normal gateway seats discover this specialist surface with
  // capability_search; a fresh mesh-authorised participant can receive it
  // directly. Catalog visibility is never itself a grant.
  ...MESH_MCP_TOOL_NAMES,
  // Simulator Canvas — TaskWraith-owned Simulator.app / simctl / idb host.
  // Status + inspect are auto-allowed observation; open/boot/install/launch/
  // screenshot/terminate/button/rotate/tap/type/scroll gate on the dedicated
  // simulatorCanvas service (Accept Edits allow; Ask/Plan ask with
  // grant-immunity under Plan). Catalog visibility is never itself a grant.
  ...SIMULATOR_MCP_TOOL_NAMES,
  // Agent-accessed appearance. A DATA channel over an allowlist of typed theme
  // tokens (see shared/agentThemeTokens) — never CSS text, never a selector, and
  // never a token that could move the approval chrome or restyle a provider's
  // identity colour. `_get` is a read; `_set` mutates persisted settings and is
  // classified workspace_write so a read-only seat cannot restyle the app.
  'theme_tokens_get',
  'theme_tokens_set',
  // Cross-thread retrospection (recall) — an in-thread agent resolves a vague
  // {provider, workspace, time, task} reference to a past run on ANOTHER
  // thread/provider/workspace and reads how far it got. Read-only; `find` is
  // NOT auto-allowed and cross-workspace reads are gated by the crossThreadRead
  // approval service. See src/main/mcp/RecallToolExecutors.ts.
  'tw_recall_find',
  'tw_recall_read',
  'tw_recall_read_events',
  // Thread Introspection — memory promotion over recent runs/threads. Read-only
  // list/read are auto-allowed; run/review mutate internal proposal state and stay
  // gated. No MCP apply path in phase 1 (Settings-only). See
  // src/main/mcp/IntrospectionToolExecutors.ts.
  'tw_introspection_run',
  'tw_introspection_list',
  'tw_introspection_read',
  'tw_introspection_review',
  // TaskWraith-owned skills — progressive disclosure catalog + body fetch.
  // Read-only; bodies stay behind skill_read. See src/main/mcp/SkillToolExecutors.ts.
  'skill_list',
  'skill_read',
  // Existing-image inspection is a real, canonical read tool so every provider
  // gets the same auditable Image View identity. It accepts chat media ids or
  // workspace-jailed raster paths and is auto-allowed like read_file.
  'image_view',
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
  // Read the TEXT layer out of a workspace PDF via the BUNDLED pdfjs build — no
  // host binary, so behaviour is identical on every machine (deliberately unlike
  // the pdftoppm/sips rasterization in PdfAttachmentRenderService). Writes NO
  // file and emits NO media ref; returns structured text over a realpath-jailed
  // read. Non-mutating, read-only-safe (orchestration). See
  // src/main/mcp/DocumentToolExecutors.ts.
  'document_extract_text',
  // ON-DEVICE Vision OCR of a workspace image via the daemon's native
  // `document.ocrImage` (the same recognizer behind attached-window capture;
  // on-device ONLY, no network). Writes NO file and emits NO media ref — returns
  // the recognized text plus per-block boxes. The sourcePath is realpath-jailed
  // before the daemon runs. Non-mutating, read-only-safe (orchestration). See
  // src/main/mcp/DocumentToolExecutors.ts.
  'document_ocr_image',
  'transcode_video'
] as const

export type TaskWraithMcpToolName = (typeof TASKWRAITH_MCP_TOOLS)[number]

export type MeshSceneMcpToolName = (typeof MESH_SCENE_MCP_TOOL_NAMES)[number]
export type MeshTopologyMcpToolName = (typeof MESH_TOPOLOGY_MCP_TOOL_NAMES)[number]
export type MeshMcpToolName = (typeof MESH_MCP_TOOL_NAMES)[number]
export type SimulatorMcpToolName = (typeof SIMULATOR_MCP_TOOL_NAMES)[number]
export type SimulatorMutatingMcpToolName = (typeof SIMULATOR_MUTATING_MCP_TOOL_NAMES)[number]

export const TASKWRAITH_MCP_TOOL_LIST = TASKWRAITH_MCP_TOOLS.join(', ')

function normalizeTaskWraithToolName(toolName: string): string {
  let normalized = (toolName || '').trim().toLowerCase()
  if (normalized.startsWith('mcp__')) {
    const idx = normalized.indexOf('__', 5)
    normalized = idx > 5 ? normalized.slice(idx + 2) : normalized.slice('mcp__'.length)
  } else {
    const cursorMcpPrefixes = [
      'mcp_taskwraith-broker_',
      'mcp_taskwraith-broker-',
      'mcp_taskwraith_',
      'mcp_taskwraith-',
      'taskwraith-broker__',
      'taskwraith_broker__',
      'taskwraith-broker_',
      'taskwraith_broker_',
      'taskwraith-broker-',
      'taskwraith_broker-'
    ]
    for (const prefix of cursorMcpPrefixes) {
      if (normalized.startsWith(prefix)) {
        normalized = normalized.slice(prefix.length)
        break
      }
    }
  }
  if (normalized.startsWith('taskwraith__')) {
    normalized = normalized.slice('taskwraith__'.length)
  }
  return normalized
}

/**
 * `ensemble_control` is the small, provider-portable invocation shape for the
 * existing Bossman authority primitive. Keep this predicate separate from the
 * canonicalizer so profile-fenced transports can reject an unadvertised alias
 * without weakening the canonical authority path.
 */
export function isPortableEnsembleControlToolName(toolName: string): boolean {
  return normalizeTaskWraithToolName(toolName) === 'ensemble_control'
}

/**
 * Lets constrained function-call transports use a small, declared envelope
 * while MCP-capable callers may keep sending the action fields flat. The
 * envelope is deliberately unwrapped before the legacy authority executor,
 * schema preflight, approval, and audit paths run.
 */
export function normalizePortableEnsembleControlArguments(
  toolName: string,
  value: unknown
): unknown {
  if (!isPortableEnsembleControlToolName(toolName)) return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const outer = value as Record<string, unknown>
  const params = outer.params
  if (!params || typeof params !== 'object' || Array.isArray(params)) return value
  const { params: _params, ...flat } = outer
  return { ...(params as Record<string, unknown>), ...flat }
}

export function canonicalTaskWraithToolName(toolName: string): string {
  const normalized = normalizeTaskWraithToolName(toolName)
  if (normalized.replace(/[\s_-]+/g, '') === 'askuserquestion') return 'ask_user_question'
  if (normalized === 'ensemble_control') return 'ensemble_bossman_control'
  return normalized
}

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
