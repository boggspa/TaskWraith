<!-- GENERATED FILE — do not edit by hand.
     Source of truth: src/main/McpToolCatalog.ts (createTaskWraithMcpToolDefinitions).
     Regenerate: npm run generate:ollama-tools-md
     A drift test (OllamaToolsDoc.test.ts) fails CI if this file is stale. -->

# TaskWraith tools reference

Local Ollama models call a directly advertised tool by emitting exactly one JSON object per turn:

```
{"taskwraith_tool":{"name":"<tool>","arguments":{ ... }}}
```

The 155 tools below are the full TaskWraith surface. 38 common tools are callable directly; every other example uses capability_invoke so the top-level tool surface stays compact. Every mutating target (file edits, shell, publishing) is gated by your run's permission role, and paths must stay inside the active workspace.

## run_shell_command

Run a shell command in the active TaskWraith workspace after TaskWraith approval policy allows it.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: command
- Optional args: cwd
- Example: `{"taskwraith_tool":{"name":"run_shell_command","arguments":{"command":"text"}}}`

## write_file

Write a UTF-8 text file inside the active TaskWraith workspace after approval.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: path, content
- Example: `{"taskwraith_tool":{"name":"write_file","arguments":{"path":"text","content":"text"}}}`

## replace

Replace text in a UTF-8 file inside the active TaskWraith workspace after approval.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: path, old_string, new_string
- Optional args: replace_all
- Example: `{"taskwraith_tool":{"name":"replace","arguments":{"path":"text","old_string":"text","new_string":"text"}}}`

## create_directory

Create a directory inside the active TaskWraith workspace after approval.

- Access: governed by your run permission role
- Required args: path
- Optional args: recursive, intent
- Example: `{"taskwraith_tool":{"name":"create_directory","arguments":{"path":"text"}}}`

## delete_path

Delete a file or empty directory inside the active TaskWraith workspace after approval. Recursive deletion is not supported.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: path
- Optional args: intent
- Example: `{"taskwraith_tool":{"name":"delete_path","arguments":{"path":"text"}}}`

## move_path

Move a file or directory inside the active TaskWraith workspace after approval. Destination overwrite is opt-in.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: from, to
- Optional args: overwrite, createParents, intent
- Example: `{"taskwraith_tool":{"name":"move_path","arguments":{"from":"text","to":"text"}}}`

## rename_path

Rename a file or directory within its current parent directory inside the active workspace after approval.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: path, newName
- Optional args: overwrite, intent
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"rename_path","arguments":{"path":"text","newName":"text"}}}}`

## read_file

Read a UTF-8 text file inside the active TaskWraith workspace after tool policy allows it.

- Access: read-only (no approval needed)
- Required args: path
- Example: `{"taskwraith_tool":{"name":"read_file","arguments":{"path":"text"}}}`

## list_directory

List a directory inside the active TaskWraith workspace after tool policy allows it.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: path
- Example: `{"taskwraith_tool":{"name":"list_directory","arguments":{"path":"text"}}}`

## find_files

Find files by filename/path glob inside the active workspace and return bounded metadata-only matches.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: pattern, patterns, path, includeHidden, maxResults
- Example: `{"taskwraith_tool":{"name":"find_files","arguments":{"pattern":"text"}}}`

## workspace_search

Search the active workspace with ripgrep and return structured JSON matches.

- Access: read-only (no approval needed)
- Required args: query
- Optional args: path, globs, contextLines, maxResults
- Example: `{"taskwraith_tool":{"name":"workspace_search","arguments":{"query":"text"}}}`

## web_search

Search the web for current online information and return top result titles and URLs. Read-only network access.

- Access: read-only (no approval needed)
- Required args: query
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"web_search","arguments":{"query":"text"}}}}`

## web_fetch

Fetch the text contents of an absolute http(s) URL. Read-only network access.

- Access: read-only (no approval needed)
- Required args: url
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"web_fetch","arguments":{"url":"text"}}}}`

## apply_patch

Validate or apply a git-style unified diff patch in the active workspace.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: patch
- Optional args: dryRun, check
- Example: `{"taskwraith_tool":{"name":"apply_patch","arguments":{"patch":"text"}}}`

## git_status

Return structured git status for the active workspace.

- Access: read-only (no approval needed)
- Required args: none
- Example: `{"taskwraith_tool":{"name":"git_status","arguments":{}}}`

## git_diff

Return git diff output for the active workspace.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: cached, staged, stat, paths
- Example: `{"taskwraith_tool":{"name":"git_diff","arguments":{"cached":false}}}`

## git_log

Return bounded structured commit history for the active workspace, optionally scoped to a path.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: ref, path, maxCount, grep, author
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"git_log","arguments":{"ref":"text"}}}}`

## git_show

Show bounded metadata, stats, and optionally patch output for a single git ref.

- Access: read-only (no approval needed)
- Required args: ref
- Optional args: path, includePatch, stat
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"git_show","arguments":{"ref":"text"}}}}`

## git_blame

Return bounded structured git blame information for a workspace file and line range.

- Access: read-only (no approval needed)
- Required args: path
- Optional args: startLine, endLine, maxLines
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"git_blame","arguments":{"path":"text"}}}}`

## git_stage

Stage selected files or all changes in the active workspace.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: none
- Optional args: paths, patch, all, update
- Example: `{"taskwraith_tool":{"name":"git_stage","arguments":{"paths":[]}}}`

## git_commit

Create a git commit in the active workspace with the supplied message.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: message
- Example: `{"taskwraith_tool":{"name":"git_commit","arguments":{"message":"text"}}}`

## git_push

Push the current git branch for the active workspace.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: none
- Optional args: remote, setUpstream
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"git_push","arguments":{"remote":"text"}}}}`

## git_create_pr

Create a GitHub pull request for the active workspace branch using gh.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: none
- Optional args: title, body, draft, base, head, fill
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"git_create_pr","arguments":{"title":"text"}}}}`

## github_ci_status

Read GitHub Actions / pull request check state for the active workspace using gh. This is an observational CI-state primitive, not a push loop: it confirms gh auth, binds the query to a PR/branch/commit SHA when supplied, can fetch bounded failed job logs, and returns repair-loop guardrails for local test-before-push workflows.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: pr, branch, commitSha, includeFailedLogs, maxRuns, maxFailedLogs, maxLogChars, repairAttempt, maxRepairPushes
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"github_ci_status","arguments":{"pr":"text"}}}}`

## run_task

Run a known project task such as test, typecheck, lint, or build and return structured output.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: task
- Optional args: args, timeoutMs
- Example: `{"taskwraith_tool":{"name":"run_task","arguments":{"task":"text"}}}`

## start_background_process

Start a long-running workspace command such as a dev server or watcher and return a TaskWraith process id for later reads or cancellation.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: command
- Optional args: name, cwd, initialWaitMs, maxInitialChars
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"start_background_process","arguments":{"command":"text"}}}}`

## list_background_processes

List long-running processes started by TaskWraith MCP tools in this chat.

- Access: read-only (no approval needed)
- Required args: none
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"list_background_processes","arguments":{}}}}`

## read_background_process

Read bounded stdout/stderr from a background process started by TaskWraith MCP tools in this chat.

- Access: read-only (no approval needed)
- Required args: processId
- Optional args: stdoutOffset, stderrOffset, maxChars, stream
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"read_background_process","arguments":{"processId":"text"}}}}`

## kill_background_process

Stop a background process previously started by TaskWraith MCP tools in this chat.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: processId
- Optional args: signal
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"kill_background_process","arguments":{"processId":"text"}}}}`

## get_diagnostics

Run fixed workspace diagnostic tools and return structured TypeScript/ESLint problems.

- Access: governed by your run permission role
- Required args: none
- Optional args: source, path, project, maxDiagnostics, timeoutMs
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"get_diagnostics","arguments":{"source":"text"}}}}`

## list_active_runs

List TaskWraith-owned active provider runs and queued run jobs, with optional recent run events.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: provider, chatId, includeEvents, eventLimit
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"list_active_runs","arguments":{"provider":"text"}}}}`

## cancel_active_run

Request cancellation of one TaskWraith-owned active provider run. Requires provider plus a run id when more than one run matches.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: provider, intent
- Optional args: runId, chatId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"cancel_active_run","arguments":{"provider":"text","intent":"text"}}}}`

## list_chat_attachments

List attachments and transcript media visible in the active chat: uploaded images/files, run attachment snapshots, and generated media refs. Current-chat scoped. Paths are omitted unless includePaths is true; use attachmentId with inspect_chat_attachment to re-inspect an item.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: kind, kinds, includePaths, limit
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"list_chat_attachments","arguments":{"kind":"text"}}}}`

## inspect_chat_attachment

Inspect one attachment/media item from the active chat by attachmentId. Returns structured metadata and, for raster images with available bytes or thumbnails, an inline image block that appears in the transcript. Current-chat scoped; it does not accept arbitrary paths.

- Access: read-only (no approval needed)
- Required args: attachmentId
- Optional args: includeImage, includePath, maxBytes
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"inspect_chat_attachment","arguments":{"attachmentId":"text"}}}}`

## workspace_board_snapshot

Return a bounded snapshot of workspace boards and cards for the active TaskWraith workspace. Current-workspace scoped; no transcript bodies.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: boardId, includeArchived, limit
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"workspace_board_snapshot","arguments":{"boardId":"text"}}}}`

## workspace_board_preview_plan

Preview a declarative Workspace Board plan without mutating state. TaskWraith will stamp agent provenance from the active run context.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: boardId, name, description, sourceKind, sourceId, sourceTitle, note, cards, plan
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"workspace_board_preview_plan","arguments":{"boardId":"text"}}}}`

## workspace_board_apply_plan

Apply a declarative Workspace Board plan by creating/updating a board and cards in the active workspace. Gated app-state mutation; no deletes or archives. TaskWraith stamps actor=agent and trust=agent-proposed.

- Access: governed by your run permission role
- Required args: none
- Optional args: boardId, name, description, sourceKind, sourceId, sourceTitle, note, cards, plan
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"workspace_board_apply_plan","arguments":{"boardId":"text"}}}}`

## test_result_summary

Summarize test failures from supplied output or a durable run id.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: output, runId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"test_result_summary","arguments":{"output":"text"}}}}`

## prompt_task_normalize

Convert messy user intent into a task contract before implementation: current state, desired capability, inferred work mode, non-goals, acceptance criteria, evidence required, allowed repo surfaces, open questions, first slice, and slop budget. Uses the latest Repo Convention Index when available.

- Access: read-only (no approval needed)
- Required args: prompt
- Optional args: task, userPrompt, currentState, repoConventionIndex
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"prompt_task_normalize","arguments":{"prompt":"text"}}}}`

## scope_radar

Normalize a messy user prompt into a pre-work capability map: desired capability, slice kinds, evidence required, allowed surfaces, non-goals, open questions, and slop budget. By default records the inferred map as an Evidence Pack for the active run; pass record=false for preview only.

- Access: governed by your run permission role
- Required args: prompt
- Optional args: task, userPrompt, currentState, record
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"scope_radar","arguments":{"prompt":"text"}}}}`

## repo_convention_scan

Scan the active workspace file tree and build a deterministic Repo Convention Index: package/tooling signals, UI component families, process boundaries, tests, style systems, generated paths, and do-not-repeat rules. Records the snapshot by default; pass record=false for preview only.

- Access: governed by your run permission role
- Required args: none
- Optional args: record, maxFiles, includeHidden
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"repo_convention_scan","arguments":{"record":false}}}}`

## coherence_gate_check

Run a deterministic coherence gate over planned or actual changed files. Compares touched paths against Scope Radar scope, slop budget, validation evidence, and the latest Repo Convention Index to flag generated-path edits, placeholder work, broad styling drift, duplicate-abstraction risk, and missing validation.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: prompt, scopeRadar, repoConventionIndex, touchedFiles, changedFiles, diffTouchedFiles, newFiles, placeholderFiles, validationCommands, validationEvidenceRefs, pack
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"coherence_gate_check","arguments":{"prompt":"text"}}}}`

## evidence_pack_write

Persist a structured Evidence Pack for the active run: capability cells, completion claims, changed files, and supporting evidence refs. TaskWraith stamps workspace/chat/run/provider context.

- Access: governed by your run permission role
- Required args: none
- Optional args: title, mapEntries, capabilityCells, cells, completionClaims, claims, diffTouchedFiles, changedFiles, finalAnswer, pack
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"evidence_pack_write","arguments":{"title":"text"}}}}`

## completion_claim_check

Check whether completion-style language in a planned final answer is backed by the active run Evidence Pack. Returns shouldRevise/canClaimComplete and a recommended caveat.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: finalText, finalAnswer, runId, chatId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"completion_claim_check","arguments":{"finalText":"text"}}}}`

## list_subthreads

List lifecycle-aware sub-threads under the active parent chat, including readiness to read results.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: parentChatId, includeArchived, includePrompt
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"list_subthreads","arguments":{"parentChatId":"text"}}}}`

## read_subthread_result

Read lifecycle, final result, transcript slices, and/or run events from a sub-thread owned by the active parent chat.

- Access: read-only (no approval needed)
- Required args: subThreadId
- Optional args: depth, includeRuns, includeMessages, includeEvents, messageLimit, eventLimit
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"read_subthread_result","arguments":{"subThreadId":"text"}}}}`

## cancel_subthread

Cancel an active run in a sub-thread owned by the active parent chat.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: subThreadId
- Optional args: reason
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"cancel_subthread","arguments":{"subThreadId":"text"}}}}`

## workspace_symbols

Find likely source symbols in the active workspace using a fast regex fallback.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: query, path, maxResults
- Example: `{"taskwraith_tool":{"name":"workspace_symbols","arguments":{"query":"text"}}}`

## browser_open

Open a URL or workspace file in the dedicated MCP browser window.

- Access: governed by your run permission role
- Required args: none
- Optional args: url, path, show, width, height
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"browser_open","arguments":{"url":"text"}}}}`

## browser_click

Click in the dedicated MCP browser window by selector or viewport coordinates.

- Access: governed by your run permission role
- Required args: none
- Optional args: selector, x, y
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"browser_click","arguments":{"selector":"text"}}}}`

## browser_screenshot

Capture the dedicated MCP browser window and optionally write the PNG inside the workspace.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: path
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"browser_screenshot","arguments":{"path":"text"}}}}`

## browser_console

Return recent MCP browser console messages, or app renderer console messages with target=app/all.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: target, clear, limit
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"browser_console","arguments":{"target":"text"}}}}`

## attached_window_capture

Capture one frame of the macOS window the user attached via the TaskWraith picker. Returns a PNG (as an image content block) plus optional local Vision OCR. Fails fast with a structured error when no window is attached — never enumerates windows the user hasn't picked. The user must click the Attach button (or use the hotkey) first; you cannot initiate the pick.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: include_ocr, max_dimension_px
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"attached_window_capture","arguments":{"include_ocr":false}}}}`

## attached_window_status

Return whether a user-picked window is currently attached, and if so just its title/bundle/application name. Carries no pixel data and no enumeration of other windows; safe to poll. Auto-approved (no modal); the user already chose to share this metadata when they picked the window.

- Access: read-only (no approval needed)
- Required args: none
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"attached_window_status","arguments":{}}}}`

## appwatch_start

Start a continuous low-fps capture stream of the attached window into a daemon-side ring buffer. Returns the resolved config. Idempotent: second call with same handle returns the existing config without restarting. Refuses if the configured buffer would exceed 350 MB — reduce fps/bufferSeconds/maxDimensionPx and retry. The user must have already attached a window via the picker; you cannot initiate the pick.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: fps, buffer_seconds, max_dimension_px
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"appwatch_start","arguments":{"fps":0}}}}`

## appwatch_stop

Stop the Appwatch stream for the attached window and free the ring buffer. Safe to call when no stream is running. Detaching the window (or the daemon idling for 60s without a frame pull) also stops the stream.

- Access: governed by your run permission role
- Required args: none
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"appwatch_stop","arguments":{}}}}`

## appwatch_status

Read-only Appwatch stream status — fps, bufferSeconds, current frameCount, oldest/newest frame timestamps, memory footprint, idle-timeout pull clock. Does NOT bump the idle-timeout clock; safe to poll from a UI. Returns `streaming: false` when no stream is running or when the daemon auto-stopped on idle timeout.

- Access: read-only (no approval needed)
- Required args: none
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"appwatch_status","arguments":{}}}}`

## appwatch_latest_frame

Return the most recent frame from the Appwatch ring buffer as a PNG (image content block). Bumps the idle-timeout pull clock so an active agent loop keeps the stream alive. Fails fast if `appwatch_start` has not been called for the current handle. Returns `hasFrame: false` when the stream is up but no frame has landed yet (first frame typically arrives within ~200 ms). For batch/since retrieval use `appwatch_frames`.

- Access: read-only (no approval needed)
- Required args: none
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"appwatch_latest_frame","arguments":{}}}}`

## appwatch_frames

Return a chronological batch of recent Appwatch frames from the attached-window ring buffer. Input `{ since?: string, count?: number, format?: "jpeg" | "png", include_ocr?: boolean, includeOCR?: boolean }`; defaults to count=5 and jpeg, clamps count to 1..20, and clamps to 1..5 when OCR is enabled. Returns structured metadata with hasFrames, returned, nextSince, availability timestamps, and one image content block per returned frame.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: since, count, format, include_ocr, includeOCR
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"appwatch_frames","arguments":{"since":"text"}}}}`

## approval_status

Return approval policies, workspace grants, and recent approval ledger records. By default the query is scoped to the current run+chat (derived from the calling agent context) so the agent sees only approvals relevant to its own work. Pass `all: true` to widen the query to ALL of the calling agent's provider's approvals across every run+chat — useful for auditing or surfacing historical approvals. Explicit `runId` / `chatId` always override scope inference, regardless of `all`.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: provider, service, approvalId, runId, chatId, statuses, scopes, includeExpired, includePreview, all, limit
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"approval_status","arguments":{"provider":"text"}}}}`

## provider_auth_status

Return sanitized provider authentication status. Tokens and secrets are never included.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: provider
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"provider_auth_status","arguments":{"provider":"text"}}}}`

## provider_usage_status

Return a coarse quota-band view of the requested provider (or all providers when omitted) so the calling agent can self-throttle or pick a lighter model when a window is near exhaustion. Per window, the response carries a `band` value of one of `'low' | 'medium' | 'high' | 'critical' | 'unknown'` (computed from `usedPercent`) plus the underlying percent, the window label, and `resetAt` if known. No raw credentials or account-identifying detail. This is intentionally COARSE — finer numeric usage telemetry beyond the band is deferred to a future tool to keep this one cheap and stable across provider snapshot-shape changes.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: provider
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"provider_usage_status","arguments":{"provider":"text"}}}}`

## run_timeline

Return structured durable run timeline events for a run.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: runId, limit, includeEvents, includePayload
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"run_timeline","arguments":{"runId":"text"}}}}`

## raw_provider_events

Return raw provider durable events for parser debugging.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: runId, chatId, provider, includeArtifacts, limit
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"raw_provider_events","arguments":{"runId":"text"}}}}`

## open_workspace_file

Open or reveal a workspace file on the host.

- Access: governed by your run permission role
- Required args: path
- Optional args: reveal
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"open_workspace_file","arguments":{"path":"text"}}}}`

## creative_app_status

Return the supported creative app adapters, install hints, attached-window match, transports, risk tiers, and limitations. Read-only discovery; does not enumerate windows beyond the user-attached window.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: appId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"creative_app_status","arguments":{"appId":"text"}}}}`

## creative_app_capabilities

Return detailed TaskWraith creative app adapter capabilities for Final Cut Pro, Logic Pro, and Blender, including safe transports, approval risk tiers, prompts, and known limitations.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: appId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"creative_app_capabilities","arguments":{"appId":"text"}}}}`

## creative_project_snapshot

Read a workspace creative project or interchange file and return a bounded, read-only structural snapshot. Supports FCPXML, MusicXML, MIDI headers, Blender file hints, and package metadata without mutating source projects.

- Access: read-only (no approval needed)
- Required args: path
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"creative_project_snapshot","arguments":{"path":"text"}}}}`

## creative_timeline_validate

Validate a workspace FCPXML timeline/interchange document with lightweight read-only checks: root/version, structural counts, duplicate ids, unresolved refs, and truncation warnings. Does not import or mutate Final Cut Pro projects.

- Access: read-only (no approval needed)
- Required args: path
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"creative_timeline_validate","arguments":{"path":"text"}}}}`

## creative_timeline_ir

Parse a workspace FCPXML document into the compact TaskWraith timeline IR for preview, diff, and plan workflows. Does not import or mutate Final Cut Pro projects.

- Access: read-only (no approval needed)
- Required args: path
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"creative_timeline_ir","arguments":{"path":"text"}}}}`

## creative_timeline_diff

Compare an original FCPXML and a drafted FCPXML into a read-only timeline diff plan, affected-resource summary, and JSON sidecar payload. Does not import or mutate Final Cut Pro projects.

- Access: read-only (no approval needed)
- Required args: beforePath, afterPath
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"creative_timeline_diff","arguments":{"beforePath":"text","afterPath":"text"}}}}`

## creative_timeline_import

Write a timeline IR to .fcpxml and hand it to Final Cut Pro via NSWorkspace.open. REQUIRES USER APPROVAL — a modal will surface in TaskWraith asking the user to approve the import before dispatch. Returns { refused, reason } if the user rejects, or { dispatched: true, filePath, daemonResult } on approval.

- Access: governed by your run permission role
- Required args: ir
- Optional args: bundleId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"creative_timeline_import","arguments":{"ir":{}}}}}`

## creative_applescript_dispatch

Dispatch an AppleScript class against Final Cut Pro or Logic Pro. Two modes: pass { className, params } to invoke a curated named class (fcp.open-project, fcp.set-playhead, fcp.export-current, logic.open-project, logic.set-tempo) or pass { source } for raw AppleScript. REQUIRES USER APPROVAL — a modal will surface with the script source. Named classes can be approved-and-cached for the session; raw scripts always prompt.

- Access: governed by your run permission role
- Required args: none
- Optional args: className, params, source
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"creative_applescript_dispatch","arguments":{"className":"text"}}}}`

## creative_blender_python

Run a Python script inside `Blender --background --python` in a per-invocation sandbox tempdir. Two modes: { className, params } picks a curated class (render-still, import-obj, export-gltf); { pythonSource, inputBlendPath? } runs raw Python. REQUIRES USER APPROVAL — modal shows the Python source. Named classes are cacheable for session; raw always prompts. Default timeout 30s.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: none
- Optional args: className, params, pythonSource, inputBlendPath
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"creative_blender_python","arguments":{"className":"text"}}}}`

## creative_midi_dispatch

Send a MIDI event through TaskWraith's virtual "TaskWraith" Core MIDI source. Logic Pro (or any MIDI receiver) can route this source as input. Supported eventTypes: note_on, note_off, cc, program_change, transport_play, transport_stop. Requires user approval; approval is cacheable per eventType for the session.

- Access: governed by your run permission role
- Required args: eventType
- Optional args: channel, note, velocity, controller, value, program
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"creative_midi_dispatch","arguments":{"eventType":"text"}}}}`

## open_in_ide

Open a file in the user's editor of choice via NSWorkspace. Optional `ide` arg picks one of: vscode, vscode-insiders, cursor, zed, sublime-text, xcode, bbedit, nova, textmate, intellij-idea, webstorm, pycharm, goland, clion, rustrover, rider, rubymine, phpstorm, datagrip, android-studio. When omitted, picks the first running editor → first installed → vscode fallback. No approval needed (focus-change only).

- Access: governed by your run permission role
- Required args: path
- Optional args: ide
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"open_in_ide","arguments":{"path":"text"}}}}`

## open_in_ide_at_position

Open a file at a specific line and column via the editor's CLI shim (code -g, cursor -g, subl, xed -l, JetBrains --line --column, etc). Falls back to a plain NSWorkspace open when the editor's CLI is not on PATH or doesn't support positional args (the fallback response includes a cliMissing flag the agent can surface to the user).

- Access: governed by your run permission role
- Required args: path, line
- Optional args: column, ide
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"open_in_ide_at_position","arguments":{"path":"text","line":0}}}}`

## reveal_in_finder

Reveal a file in macOS Finder with the file selected. Wraps NSWorkspace.selectFile.

- Access: governed by your run permission role
- Required args: path
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"reveal_in_finder","arguments":{"path":"text"}}}}`

## ide_app_status

Snapshot of every recognised editor / IDE with installedHint + runningHint per entry. Cheap; backed by a 3-second cache.

- Access: read-only (no approval needed)
- Required args: none
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"ide_app_status","arguments":{}}}}`

## ide_app_capabilities

Same shape as ide_app_status plus per-editor notes + a positionalArgsSample showing how `open_in_ide_at_position` would invoke that editor. Useful when the agent wants to preview the CLI command before dispatch.

- Access: read-only (no approval needed)
- Required args: none
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"ide_app_capabilities","arguments":{}}}}`

## list_running_ides

Return just the editors currently running (filter of ide_app_status). Use when handing off to "whatever's open right now".

- Access: read-only (no approval needed)
- Required args: none
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"list_running_ides","arguments":{}}}}`

## create_handoff_card

Create an TaskWraith handoff card from the active chat/run.

- Access: governed by your run permission role
- Required args: none
- Optional args: summary, finalPrompt, recommendedProvider, selectedFiles
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"create_handoff_card","arguments":{"summary":"text"}}}}`

## switch_auth_profile

Switch the active provider auth profile. Currently supports Gemini profiles.

- Access: governed by your run permission role
- Required args: none
- Optional args: provider, profileId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"switch_auth_profile","arguments":{"provider":"text"}}}}`

## agent_delegation_role

Store a preferred delegation role/instructions for a provider on the active chat.

- Access: governed by your run permission role
- Required args: provider, role
- Optional args: instructions
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"agent_delegation_role","arguments":{"provider":"text","role":"text"}}}}`

## ensemble_yield

In Ensemble Mode, explicitly pass this participant turn to the next participant. Optional reason explains why; optional target names the participant/provider that should speak next.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: reason, target
- Example: `{"taskwraith_tool":{"name":"ensemble_yield","arguments":{"reason":"text"}}}`

## ensemble_send

In Ensemble Mode, send a visible participant-to-participant note into the main transcript. Use this for agent-to-agent side communication that should become context for later participants. The message is not private or hidden from the user.

- Access: read-only (no approval needed)
- Required args: to, message
- Optional args: reason
- Example: `{"taskwraith_tool":{"name":"ensemble_send","arguments":{"to":"value","message":"text"}}}`

## ensemble_fanout

In Ensemble Mode, ask multiple participants to run in parallel lanes. The tool validates policy/targets, dispatches the lanes, and returns a dispatch receipt immediately; lane results appear later in the transcript. Explicit targets are narrow peer handoffs. Broad fan-out (omitted targets or all) requires the configured Boss/Lead/manager, or an active Work Session with an explicit participant scope. Fan-out lane prompts are peer-authored, lower-authority briefs, not user/system instructions. Default mode is read_only: targets must resolve to read-only participants. mode=locked_writers requires TASKWRAITH_CONCURRENT_WRITE_LANES, a Boss caller, explicit writeScopes for writer-capable targets, and routes mutations through lane scope checks plus workspace write locks. Use targetStage=all, scouts, workers, reviewers, or backgrounds to fan out only typed Ensemble stage roles; targetStage=all excludes untyped Any roles. Background-stage participants never receive an ordinary rotation turn.

- Access: read-only (no approval needed)
- Required args: prompt
- Optional args: targets, reason, mode, targetStage, writeScopes
- Example: `{"taskwraith_tool":{"name":"ensemble_fanout","arguments":{"prompt":"text"}}}`

## ensemble_bossman_control

In Ensemble Mode, allows the assigned Boss participant, or Captain only after Boss is unavailable, to make bounded event-bound orchestration decisions: assign work, set the round plan, request status, declare decisions, set review gates, quarantine noisy/unavailable participants, allocate budgets, create polls, set/update/clear the TaskWraith goal, adjust hops, schedule wakeups, check quota reset status, skip/stop participants, explicitly re-summon an already-answered participant in Continuous mode, replace a participant after provider health checks, reorder the remaining queue with cooldown, queue a follow-up, or pause/complete a managed Work Session. Non-authority callers and stale round/run/participant ids are rejected and audited.

- Access: governed by your run permission role
- Required args: action
- Optional args: roundId, targetParticipantId, targetRunId, participantIds, prompt, reason, objective, acceptanceCriteria, due, assignmentStatus, assignmentId, gateId, pollId, budgetId, goal, goalStatus, status, phase, blockers, doneCriteria, decision, rationale, reopenCriteria, scope, reviewStatus, category, quarantineScope, clear, maxExtraTurns, maxFanoutCalls, maxDurationSeconds, maxTokens, question, options, includeUser, timeoutSeconds, hopDelta, maxContinuationHops, delaySeconds, provider, replacement
- Example: `{"taskwraith_tool":{"name":"ensemble_bossman_control","arguments":{"action":"text"}}}`

## ensemble_poll_response

In Ensemble Mode, cast or update this participant’s response to an open Boss/Captain poll created by ensemble_bossman_control({ action: "create_poll" }). Active participant runs only. The choice must match one of the poll options.

- Access: governed by your run permission role
- Required args: pollId, choice
- Optional args: rationale
- Example: `{"taskwraith_tool":{"name":"ensemble_poll_response","arguments":{"pollId":"text","choice":"text"}}}`

## ensemble_roster_edit

In Ensemble Mode, lets the assigned Boss participant, or Captain only after Boss is unavailable, add, remove, or edit participants in the active roster, including swapping an inactive participant seat to a different provider/model/reasoning/permission setup when quota walls, poor output, or agreed role changes make that necessary. Authority-only and audited; requires the user's Allow Auto Approvals opt-in on the Ensemble. Call list_ensemble_participants first to inspect live participant ids plus available providers, models, context windows, and coarse quota bands. Permission presets are capped at read_only, plan, or default assignment, and tool-grant permissionOverrides are narrow-only: service overrides may only deny, network may only deny, approvalMode may only narrow to plan, and external path grants are forbidden.

- Access: governed by your run permission role
- Required args: action
- Optional args: roundId, targetParticipantId, participant
- Example: `{"taskwraith_tool":{"name":"ensemble_roster_edit","arguments":{"action":"text"}}}`

## ensemble_brief_update

In Ensemble Mode, lets the assigned Boss participant, or Captain only after Boss is unavailable, set or clear another participant's Brief / Goal for future turns. Authority-only and audited; requires the user's Allow Auto Approvals opt-in on the Ensemble. Call list_ensemble_participants first to inspect live participant ids. The caller cannot edit their own brief.

- Access: governed by your run permission role
- Required args: targetParticipantId
- Optional args: roundId, brief, clear, reason
- Example: `{"taskwraith_tool":{"name":"ensemble_brief_update","arguments":{"targetParticipantId":"text"}}}`

## list_ensemble_participants

In Ensemble Mode, list the current participants, providers, roles, models, per-round statuses, Boss/Captain roster-edit eligibility, available provider/model catalog, per-model context windows, and coarse provider quota bands for the active round. Boss participants and active Captain should use this before ensemble_roster_edit when selecting a replacement provider/model, or before ensemble_brief_update when changing another participant Brief / Goal. Context usage fields are latest usage-bearing run estimates: contextTokens is latest input+output tokens, contextWindow is the resolved token window, and contextPercent is a 0-100 usage percentage; in-flight output is not included.

- Access: read-only (no approval needed)
- Required args: none
- Example: `{"taskwraith_tool":{"name":"list_ensemble_participants","arguments":{}}}`

## schedule_wakeup

In Ensemble Mode, pause this participant and schedule it to resume later in the same active round. Active participant runs only; unavailable from parallel fan-out lanes. Provide wakeAt (ISO), delayMs, or delaySeconds. Maximum delay 7 days — schedule sequential wakeups (one now, another on resume) for longer horizons.

- Access: governed by your run permission role
- Required args: none
- Optional args: wakeAt, delayMs, delaySeconds, reason, cancelOnUserInput
- Example: `{"taskwraith_tool":{"name":"schedule_wakeup","arguments":{"wakeAt":"text"}}}`

## cancel_wakeup

Cancel this participant’s pending wakeup in the active Ensemble round. Omit wakeupId to cancel all own pending wakeups for the round.

- Access: governed by your run permission role
- Required args: none
- Optional args: wakeupId
- Example: `{"taskwraith_tool":{"name":"cancel_wakeup","arguments":{"wakeupId":"text"}}}`

## ask_user_question

Pause the turn and surface a question to the user via a modal card. Use this whenever you need the user to make a decision before you can proceed — for plan-mode clarifications, design choices, or any other branch point that depends on user intent. Preferable to emitting the question as inline prose because the user gets a focused modal with buttons instead of having to type back. Provide 2-4 concise option strings if the answer is multiple-choice; otherwise omit `options` to ask a free-text question. `context` may carry a sub-paragraph of explanation shown beneath the question. Returns the user's `answer` string. If the user dismissed the modal (cancelled), the tool returns `cancelled: true` and the agent should treat that as "skip this step".

- Access: governed by your run permission role
- Required args: question
- Optional args: options, context
- Example: `{"taskwraith_tool":{"name":"ask_user_question","arguments":{"question":"text"}}}`

## goal_read

Read the active TaskWraith thread goal. A goal is the persistent objective and stopping condition for this chat; it is separate from todo_write checklists.

- Access: read-only (no approval needed)
- Required args: none
- Example: `{"taskwraith_tool":{"name":"goal_read","arguments":{}}}`

## goal_update

Update the lifecycle status of the existing active TaskWraith goal without changing its objective. Use this for status transitions only; the user owns setting, replacing, and clearing the objective.

- Access: read-only (no approval needed)
- Required args: status
- Optional args: reason
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"goal_update","arguments":{"status":"text"}}}}`

## update_goal

Compatibility alias for goal_update. Grok Build official /goal requires an update_goal tool in the session toolset; this updates only the lifecycle status of the existing active TaskWraith goal.

- Access: read-only (no approval needed)
- Required args: status
- Optional args: reason
- Example: `{"taskwraith_tool":{"name":"update_goal","arguments":{"status":"text"}}}`

## goal_complete

Mark the existing active TaskWraith goal completed. Only call this when the objective has genuinely been achieved and verified; todo_write completion alone is not enough.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: summary
- Example: `{"taskwraith_tool":{"name":"goal_complete","arguments":{"summary":"text"}}}`

## goal_blocked

Mark the existing active TaskWraith goal blocked when meaningful progress requires user input or an external state change. Include a concrete blocker reason.

- Access: read-only (no approval needed)
- Required args: reason
- Example: `{"taskwraith_tool":{"name":"goal_blocked","arguments":{"reason":"text"}}}`

## todo_write

Publish or update a structured goal-step checklist for the current run. Use this to break multi-step work into trackable items the user can follow in the transcript. Each todo needs a stable `id`, human-readable `content`, and `status` (`pending`, `in_progress`, `completed`, or `cancelled`). Keep exactly one item `in_progress` when actively working. When follow-up work appears after earlier steps complete, call this again with `merge: true` and add new `pending`/`in_progress` items instead of leaving the checklist all-complete. Set `merge: true` to patch existing steps by `id`; omit or set `merge: false` to replace the whole list. Prefer this over prose bullet lists when executing a plan with 3+ steps.

- Access: read-only (no approval needed)
- Required args: todos
- Optional args: merge
- Example: `{"taskwraith_tool":{"name":"todo_write","arguments":{"todos":[]}}}`

## delegate_to_subthread

Spawn a fresh context-isolated sub-thread on a chosen live provider, or continue an existing one by passing subThreadId. Fresh seats may set model, reasoningEffort, or kimiThinking; recall inherits those controls to preserve the native provider session. Recall requires an idle, unarchived child of this parent with a resumable matching-provider session. returnResult appends the final assistant message to the parent as untrusted child output. Omit subThreadId to always spawn fresh.

- Access: governed by your run permission role
- Required args: provider, prompt
- Optional args: model, reasoningEffort, kimiThinking, returnResult, subThreadId
- Example: `{"taskwraith_tool":{"name":"delegate_to_subthread","arguments":{"provider":"text","prompt":"text"}}}`

## ensemble_continue

In an active Ensemble Work Session, queue one follow-up round, mark the session complete, or pause it as blocked. Choose acceptanceStatus deliberately: use `complete` only when the task is fully done and verified — every required tool call (edits, run_task checks, tests) actually ran and succeeded. Use `blocked` only when you are genuinely stuck and need user input to proceed. Use `inProgress` (with nextPrompt) to queue another round and keep working. What is NOT blocked: a test you can fix is not a block — fix it and continue; a recoverable error (retryable failure, missing file you can create, tool you can call differently) is not a block — keep working. Does not bypass participant permissions; each queued round still uses the normal approval and permission path.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: summary, nextPrompt, target, reason, acceptanceStatus
- Example: `{"taskwraith_tool":{"name":"ensemble_continue","arguments":{"summary":"text"}}}`

## scout_brief

Emit a structured brief from a parallel fan-out lane. The next serial writer/synthesizer receives the collected briefs in its prompt. Returns an error outside an active fan-out lane.

- Access: read-only (no approval needed)
- Required args: findings, confidence
- Optional args: blockers, recommendations, tags
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"scout_brief","arguments":{"findings":"text","confidence":"text"}}}}`

## blackboard_post

Post a durable shared-memory entry for the Ensemble. Use for agreed facts, decisions, risks, do-not-repeat notes, or concise session notes. Do not use this for conversational side messages; use ensemble_send instead.

- Access: read-only (no approval needed)
- Required args: key, value
- Optional args: category, scope
- Example: `{"taskwraith_tool":{"name":"blackboard_post","arguments":{"key":"text","value":"text"}}}`

## blackboard_read

Read bounded entries from the Ensemble blackboard. A bare call returns the newest entries; pass ids, keys, category, first, last, or unseenOnly to keep the result small. Entries returned by this tool are marked as seen for the calling participant.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: ids, keys, category, unseenOnly, first, last
- Example: `{"taskwraith_tool":{"name":"blackboard_read","arguments":{"ids":[]}}}`

## blackboard_delete

Retire stale or superseded Ensemble blackboard entries by id, key, category, or all:true. This mutates shared blackboard state and is not available to read-only seats.

- Access: governed by your run permission role
- Required args: none
- Optional args: ids, keys, category, all
- Example: `{"taskwraith_tool":{"name":"blackboard_delete","arguments":{"ids":[]}}}`

## launch_list_targets

List the runnable "Run Button" targets TaskWraith discovered for this workspace (dev servers, build/test/run targets from package.json scripts, .vscode tasks/launch, Package.swift, .xcodeproj). Read-only. Each entry has a `targetId` (pass to launch_start), `label`, `command`, `kind`, `longRunning`, `runnable`, and any `blockers`. Use this before launch_start — you can only start a discovered target, not an arbitrary command.

- Access: read-only (no approval needed)
- Required args: none
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"launch_list_targets","arguments":{}}}}`

## launch_start

Start a discovered Run-Button target by `targetId` (from launch_list_targets) — e.g. run a dev server or a build. You can ONLY start a target TaskWraith already discovered from repo config, never an arbitrary command. The launch is gated: TaskWraith prompts for approval showing the exact command and working directory before spawning, and the process runs jailed to the workspace. Returns an `attemptId` + status; poll launch_status for detected URLs (a dev server's http://localhost:PORT, which you can then open with canvas_open).

- Access: governed by your run permission role
- Required args: targetId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"launch_start","arguments":{"targetId":"text"}}}}`

## launch_stop

Stop a running launch attempt by `attemptId` (from launch_start / launch_status). Terminates the spawned process tree.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: attemptId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"launch_stop","arguments":{"attemptId":"text"}}}}`

## launch_status

Return launch attempts (status, detected http://localhost URLs, errors). Pass `attemptId` for one, or omit for all. Read-only; use it to wait for a dev server to come up before canvas_open.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: attemptId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"launch_status","arguments":{"attemptId":"text"}}}}`

## canvas_open

Open a TaskWraith Canvas: a sandboxed preview of a running app the agent can inspect. Driver "web" (default) loads an http(s) `url` (typically a local dev server, e.g. http://localhost:3000) and supports the full structured surface (snapshot/inspect/click/fill/eval). Driver "device" launches an app by `bundleId` in a booted iOS Simulator (optionally installing a built `appPath` first; optional `udid`, default the booted sim) and is SCREENSHOT-ONLY — only canvas_screenshot/canvas_close apply; the DOM verbs return an error. Returns a canvasId used by every other canvas_* tool. Gated; the web driver blocks file://, link-local and cloud-metadata addresses.

- Access: governed by your run permission role
- Required args: none
- Optional args: driver, url, bundleId, appPath, udid, width, height, originAllowlist
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_open","arguments":{"driver":"text"}}}}`

## canvas_render_html

Render agent-authored HTML (or SVG markup) as a TaskWraith Canvas and return a screenshot of it. Use this to draw and look at a custom layout / SVG / mockup WITHOUT a server. The markup is rasterized by a hardened offscreen renderer with JavaScript DISABLED and ALL network access cut, so it is a static, fully-contained preview — it cannot run scripts, fetch URLs, or read files (for an interactive page, serve it and use canvas_open with the local URL instead). Returns a canvasId; canvas_screenshot re-captures it, canvas_resize re-renders at a new size, and the DOM verbs (snapshot/inspect/click/fill/eval) are NOT available for this driver. Gated like canvas_open.

- Access: governed by your run permission role
- Required args: html
- Optional args: width, height
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_render_html","arguments":{"html":"text"}}}}`

## canvas_open_attachment

Open an EXISTING image attachment in a TaskWraith Canvas and return it as an image. Pass the content hash (`sha256`) and `mimeType` of an image asset you already have (e.g. from image_generate / image_edit output or a chat attachment). The hash resolves through the media store's realpath jail, so only assets that already exist can be viewed — never an arbitrary file. Returns a canvasId; canvas_screenshot re-returns the image, canvas_close ends it; the DOM verbs do not apply. Only image/* attachments are supported today. Gated like canvas_open.

- Access: governed by your run permission role
- Required args: sha256, mimeType
- Optional args: width, height
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_open_attachment","arguments":{"sha256":"text","mimeType":"text"}}}}`

## canvas_open_launch

Open an existing Run-Button launch attempt in TaskWraith Canvas. Pass an `attemptId` from launch_start / launch_status. This tool NEVER starts a process: it only attaches to an attempt owned by the calling chat. If the attempt is running and has a detected http://localhost URL, Canvas opens that live app with the web driver. Otherwise Canvas renders the attempt's recent outputTail as escaped static HTML and returns a screenshot. Gated like canvas_open.

- Access: governed by your run permission role
- Required args: attemptId
- Optional args: width, height
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_open_launch","arguments":{"attemptId":"text"}}}}`

## canvas_sketch_open

Open a bidirectional Sketch Canvas for quick visual communication between the human and agent. It is a lightweight drawing surface for rectangles, ellipses, lines/arrows, freehand paths, SVG-style path data, and text. Use canvas_sketch_update to add/replace/delete structured primitives and canvas_sketch_get to read what the human drew. Gated like canvas_open.

- Access: governed by your run permission role
- Required args: none
- Optional args: width, height
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_sketch_open","arguments":{"width":0}}}}`

## canvas_sketch_get

Return the current Sketch Canvas document: title, viewport, and structured shape/text/path elements. Read-only; use this after the human sketches or after canvas_sketch_update.

- Access: read-only (no approval needed)
- Required args: canvasId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_sketch_get","arguments":{"canvasId":"text"}}}}`

## canvas_sketch_update

Edit a Sketch Canvas using structured primitives, not arbitrary JavaScript. Modes: append (default) adds elements, replace swaps the whole element list, clear removes all elements, delete removes ids. Element kinds: rect/ellipse with x,y,width,height; line/arrow with x1,y1,x2,y2; path with points or SVG path `d`; text with x,y,text,fontSize. Supports fill, stroke, strokeWidth, opacity. Gated via canvasInteraction and denied under read-only.

- Access: governed by your run permission role
- Required args: canvasId
- Optional args: mode, title, elementIds, elements
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_sketch_update","arguments":{"canvasId":"text"}}}}`

## canvas_list

List currently open Canvas sessions (canvasId, driver, url, status). Read-only; carries no pixels.

- Access: read-only (no approval needed)
- Required args: none
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_list","arguments":{}}}}`

## canvas_status

Return metadata for one Canvas session (status, url, viewport). Read-only; carries no pixels.

- Access: read-only (no approval needed)
- Required args: canvasId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_status","arguments":{"canvasId":"text"}}}}`

## canvas_snapshot

Return the Canvas as a structured element tree with stable refs (e.g. ref "e7"), roles, accessible names, text and bounding boxes. PREFER this over a screenshot for reading structure/text — it is cheaper and deterministic, and its refs are how you target canvas_inspect.

- Access: read-only (no approval needed)
- Required args: canvasId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_snapshot","arguments":{"canvasId":"text"}}}}`

## canvas_screenshot

Capture the Canvas as a PNG (image content block) plus dimensions. Use as a VISUAL SUPPLEMENT to canvas_snapshot — e.g. to check layout/spacing/colour you cannot read from the tree. Gated (pixel egress).

- Access: read-only (no approval needed)
- Required args: canvasId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_screenshot","arguments":{"canvasId":"text"}}}}`

## canvas_inspect

Inspect ONE element — by `ref` (from canvas_snapshot) or CSS `selector` — returning tag, role, text, bounding box and computed styles. BEST tool for verifying exact colours, fonts, spacing and dimensions (more accurate than a screenshot). Read-only.

- Access: read-only (no approval needed)
- Required args: canvasId
- Optional args: ref, selector, styles
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_inspect","arguments":{"canvasId":"text"}}}}`

## canvas_network

List network requests observed by the Canvas (url, method, status). Pass `requestId` for a single entry; `filter:"failed"` for 4xx/5xx and errors. Read-only.

- Access: read-only (no approval needed)
- Required args: canvasId
- Optional args: requestId, filter
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_network","arguments":{"canvasId":"text"}}}}`

## canvas_console

Return Canvas console output (log/info/warn/error). `level:"error"` or `"warn"` filters. Read-only.

- Access: read-only (no approval needed)
- Required args: canvasId
- Optional args: level, lines
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_console","arguments":{"canvasId":"text"}}}}`

## canvas_resize

Resize the Canvas viewport to test responsive layouts. Use `preset` (mobile 375x812 / tablet 768x1024 / desktop 1280x800) or explicit width/height. Gated.

- Access: governed by your run permission role
- Required args: canvasId
- Optional args: preset, width, height
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_resize","arguments":{"canvasId":"text"}}}}`

## canvas_click

Click an element in the Canvas by `ref` (from canvas_snapshot — preferred), CSS `selector`, or `x`/`y` coordinates. Dispatches a realistic mouse interaction. Gated; denied under read-only. Re-run canvas_snapshot afterwards to observe the result.

- Access: governed by your run permission role
- Required args: canvasId
- Optional args: ref, selector, x, y
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_click","arguments":{"canvasId":"text"}}}}`

## canvas_fill

Set the value of an input/textarea/select in the Canvas by `ref` or CSS `selector`, firing input+change events (React-compatible). Gated; denied under read-only. The typed value is never recorded in the audit log.

- Access: governed by your run permission role
- Required args: canvasId, value
- Optional args: ref, selector
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_fill","arguments":{"canvasId":"text","value":"text"}}}}`

## canvas_annotate

Overlay numbered Set-of-Mark boxes on the Canvas to flag elements for the human (agent→human redlines). Each mark targets a `ref` or explicit `bbox` [x,y,w,h] with a `label` and optional `severity` (info/warn/error). Persisted and visible in a subsequent canvas_screenshot. Gated.

- Access: governed by your run permission role
- Required args: canvasId, marks
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_annotate","arguments":{"canvasId":"text","marks":[]}}}}`

## canvas_eval

Run arbitrary JavaScript in the Canvas page and return its (size-capped) completion value. The MOST powerful canvas verb: it executes agent-supplied code in the previewed app (RCE). PREFER canvas_snapshot / canvas_inspect / canvas_click / canvas_fill — reach for eval only when a structured tool cannot express the check. Signed-elevated: it PROMPTS EVERY CALL (never auto-allowed by a grant, preset, or session-YOLO) and is denied under read-only; the human approving sees the exact script. The page network egress is best-effort cut while the script runs. The script text and its result are never written to the audit log.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: canvasId, script
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_eval","arguments":{"canvasId":"text","script":"text"}}}}`

## canvas_close

Close a Canvas session and free its preview window. Gated.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: canvasId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"canvas_close","arguments":{"canvasId":"text"}}}}`

## tw_recall_find

Find past runs on OTHER threads to answer "how far did <provider> get with <task> <when> in <workspace>?". Resolves deliberately-vague references (a provider alias, an approximate time like "yesterday ~6pm", a workspace name, a task description) to a ranked, bounded set of candidate runs. Returns the host interpretation, a verdict (one|many|none), and STRUCTURAL candidate metadata only — never prompt or transcript text. Call tw_recall_read with a candidate runId to read how far it got. Read-only. Discovery in your OWN workspace is allowed; other workspaces require user approval. On "many" disambiguate from the metadata or ask the user; on "none" say you could not find it — never guess.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: provider, workspace, timeApprox, taskQuery, freeText, limit
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"tw_recall_find","arguments":{"provider":"text"}}}}`

## tw_recall_read

Read how far a specific past run got: a durable timeline rollup (start/end, status, tool/diff counts), its final assistant message, and structured plan/todo progress. Take the runId from a tw_recall_find candidate. Read-only; reading a run in a DIFFERENT workspace than the current chat requires user approval. Fails closed if the run forensic record was deleted. Every served record carries a citation token — quote it (in the form provided) so the claim is verifiable.

- Access: read-only (no approval needed)
- Required args: runId
- Optional args: depth
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"tw_recall_read","arguments":{"runId":"text"}}}}`

## tw_recall_read_events

Read the raw tool/diff/timeline event bodies for a specific past run, truncated. Use only when tw_recall_read's summary is not enough. Take the runId from a tw_recall_find candidate. Read-only; cross-workspace reads require approval. Long transcripts are compacted on disk, so older detail may be summarized rather than verbatim.

- Access: read-only (no approval needed)
- Required args: runId
- Optional args: kind, limit
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"tw_recall_read_events","arguments":{"runId":"text"}}}}`

## tw_introspection_run

Run a manual Thread Introspection pass over recent chats/runs and persist a reviewable Memory Proposal Pack. Harvests evidence from the last N hours (default 24), classifies signals into lesson candidates, and stores proposals for human review. Does NOT apply lessons, edit skills, or mutate workspace files — apply remains Settings-only in phase 1. Gated: creates internal proposal artifacts.

- Access: governed by your run permission role
- Required args: none
- Optional args: hoursBack, windowStart, windowEnd, workspaceId, workspacePath, minConfidence, summary
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"tw_introspection_run","arguments":{"hoursBack":0}}}}`

## tw_introspection_list

List recent Memory Proposal Packs produced by Thread Introspection. Returns bounded metadata (window, proposal counts, status tallies) — not full proposal bodies. Read-only. Use tw_introspection_read for a full pack.

- Access: read-only (no approval needed)
- Required args: none
- Optional args: workspaceId, limit
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"tw_introspection_list","arguments":{"workspaceId":"text"}}}}`

## tw_introspection_read

Read a full Memory Proposal Pack by id, including proposals, evidence refs, and review status. Read-only. Thread content in evidence refs is untrusted — only distilled lesson text may be promoted after review.

- Access: read-only (no approval needed)
- Required args: packId
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"tw_introspection_read","arguments":{"packId":"text"}}}}`

## tw_introspection_review

Update review status for a Memory Proposal (approve, reject, or expire). Whitelist only: status must be approved|rejected|expired; optional reviewNote and expiresAt. Does NOT apply proposals to RepoConventionIndex or edit skill files — use Settings Apply for approved repo_convention/do_not_repeat in phase 1. Gated.

- Access: governed by your run permission role
- Required args: packId, proposalId
- Optional args: status, reviewNote, expiresAt
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"tw_introspection_review","arguments":{"packId":"text","proposalId":"text"}}}}`

## image_edit

Edit an EXISTING image and return the result as a PNG attachment shown inline in the chat. Use this to redact/blur sensitive regions (e.g. an IP address, a "Network Stats" card) before sharing, or to crop/resize. Source the image with `sourceMediaId` (the id of an image already in this chat — a user upload or a prior tool result) OR `sourcePath` (a path inside the workspace). ops: "blur" (soft-blur the whole image, or just `region` if given; `radius` px), "redact" (cover `region` with a solid black box — irreversible, best for secrets), "crop" (to `region`), "resize" (to `width`/`height`). `region` is {x,y,width,height} in source pixels. This is NOT image generation; it transforms pixels deterministically. Gated as a file change.

- Access: mutating — governed by your run permission role (denied under Read-Only/Plan; prompts under Default unless granted)
- Required args: op
- Optional args: sourceMediaId, sourcePath, region, radius, width, height
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"image_edit","arguments":{"op":"text"}}}}`

## svg_rasterize

Rasterize SVG markup to a PNG, returned as an attachment shown inline in the chat. Pass the SVG as inline `svg` text. Set `width`/`height` for the output canvas. Use this to PREVIEW an SVG you just generated (the transcript does not render SVG inline). Rendered in a sandboxed, network-cut surface. Gated as a file change.

- Access: governed by your run permission role
- Required args: svg
- Optional args: width, height
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"svg_rasterize","arguments":{"svg":"text"}}}}`

## image_generate

Generate an image from a text prompt via a configured paid API (OpenAI or xAI), returned as a PNG attachment shown inline in the chat. This is OFF by default and requires the user to enable image generation and add an API key in TaskWraith Settings — if it is not configured the call is refused (use image_edit/svg_rasterize for local, no-network image work). The prompt and target endpoint are shown to the user for approval. Gated as a file change.

- Access: governed by your run permission role
- Required args: prompt
- Optional args: provider, size
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"image_generate","arguments":{"prompt":"text"}}}}`

## audio_render_wav

Synthesize a short tone with the Web Audio API and return its WAVEFORM as a PNG attachment shown inline in the chat, plus measured peak / RMS / peak-dBFS. Use this to PREVIEW or sanity-check audio parameters (pitch, level, shape) — it builds a 16-bit PCM WAV in-process (no ffmpeg, no network) and reports its byte length, but returns the waveform image, not the audio bytes. Params: `frequencyHz` (20–Nyquist, default 440), `durationMs` (1–30000, default 1000), `waveform` (sine|square|sawtooth|triangle), `gain` (0–1), `sampleRate` (8000–48000, snapped to the nearest supported), `width`/`height` for the waveform canvas. Rendered in a sandboxed, network-cut surface. Gated as a file change.

- Access: governed by your run permission role
- Required args: none
- Optional args: frequencyHz, durationMs, waveform, gain, sampleRate, width, height
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"audio_render_wav","arguments":{"frequencyHz":0}}}}`

## audio_analyze

Decode a REAL audio file from the workspace and return its waveform as an inline PNG plus measured introspection: duration, channels, sample rate, peak / RMS (and their dBFS), clipped-sample count + percent, and silence percent. Use this to answer "is this audio clipping / too quiet / mostly silent / how long is it" without opening a DAW. Source the file with `sourcePath` (a path inside the workspace); supported containers: WAV, MP3, M4A/AAC, OGG, FLAC. Decoding is in-process (no network); analysis is on the decoded PCM (resampled to 44.1kHz). Gated as a file change.

- Access: governed by your run permission role
- Required args: sourcePath
- Optional args: width, height
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"audio_analyze","arguments":{"sourcePath":"text"}}}}`

## inspect_audio_segment

Extract a TIME WINDOW of a workspace audio file as an INTERACTIVE, PLAYABLE clip: returns the [startMs, endMs] sub-range as an inline audio player (waveform + scrub) plus a windowed on-device TRANSCRIPT when speech is present. Use it to zoom into one part of a clip ("play the chorus at 1:05–1:20", "what is said in the intro"). Source the file with `sourcePath` (a path inside the workspace); `startMs` and `endMs` bound the window in milliseconds (0 <= startMs < endMs; max span 120s). Native decode (no network). The clip is content-addressed into the internal asset store — NO workspace file is written (non-mutating, read-only-safe). The transcript is best-effort: it is omitted (the clip still returns) if macOS Speech permission or the on-device locale model is unavailable.

- Access: read-only (no approval needed)
- Required args: sourcePath, startMs, endMs
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"inspect_audio_segment","arguments":{"sourcePath":"text","startMs":0,"endMs":0}}}}`

## video_probe

Analyze a media file (video or audio) in the workspace with ffprobe and return its structure as JSON: container/format, duration, bitrate; per-stream video codec + width/height + fps + rotation + HDR flag + pixel format, and audio codec + channels + sample rate. Use this to inspect a clip before transcoding or to answer "what codec / resolution / length is this". Requires a user-installed ffmpeg/ffprobe (`brew install ffmpeg`); if absent the call returns an actionable "install ffmpeg" error. Reads a path inside the workspace only (realpath-jailed). Runs an external subprocess, so gated as a file change.

- Access: read-only (no approval needed)
- Required args: sourcePath
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"video_probe","arguments":{"sourcePath":"text"}}}}`

## video_thumbnail

Capture a single PNG frame from a workspace video as an inline thumbnail, using ffmpeg. Params: sourcePath, `atMs` (timestamp in ms, default 0), `width` (px, keeps aspect). Requires ffmpeg. Gated as a file change.

- Access: governed by your run permission role
- Required args: sourcePath
- Optional args: atMs, width
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"video_thumbnail","arguments":{"sourcePath":"text"}}}}`

## video_decode_frame

Decode a single frame from a video at a precise timestamp using the OS's built-in VideoToolbox (hardware-accelerated; works WITHOUT ffmpeg installed). Returns the frame as an image. Params: inputPath (a video file inside the workspace), `timestampSeconds` (default 0), `preferHardware` (default true). Reads a realpath-jailed workspace path; native (no external process), non-mutating, and read-only-safe.

- Access: read-only (no approval needed)
- Required args: inputPath
- Optional args: timestampSeconds, preferHardware
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"video_decode_frame","arguments":{"inputPath":"text"}}}}`

## inspect_video_frames

Decode SEVERAL frames from a video in one call using the OS's built-in VideoToolbox (hardware-accelerated; works WITHOUT ffmpeg installed) so you can scrub/inspect a clip. Provide `timestamps` (an array of seconds) for exact frames, or `everyNSeconds` to sample evenly from 0; omit both to grab a single frame at 0. `maxFrames` caps the count (default 8, hard max 24). Returns each frame as an inline image (grouped as a scrollable filmstrip). If a sample falls past the end of the clip the tool stops and returns the frames it got. Reads a realpath-jailed workspace path; native (no external process), non-mutating, read-only-safe.

- Access: read-only (no approval needed)
- Required args: inputPath
- Optional args: timestamps, everyNSeconds, maxFrames
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"inspect_video_frames","arguments":{"inputPath":"text"}}}}`

## video_encode_clip

Re-encode a segment of a workspace video to H.264 MP4 using the OS's built-in VideoToolbox (hardware-accelerated; no ffmpeg required). Params: inputPath, scaleWidth (output width px, height auto), targetBitrateKbps, startSeconds, durationSeconds. Optionally composites a workspace image (PNG/JPEG/WebP) watermark/logo over every frame via overlayPath (+ overlayX/overlayY/overlayWidth/overlayOpacity). Writes a new file; gated as a file change.

- Access: governed by your run permission role
- Required args: inputPath
- Optional args: scaleWidth, targetBitrateKbps, startSeconds, durationSeconds, overlayPath, overlayX, overlayY, overlayWidth, overlayOpacity
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"video_encode_clip","arguments":{"inputPath":"text"}}}}`

## video_concat_clips

Concatenate N video segments into one H.264 MP4 using the OS's built-in VideoToolbox (hardware-accelerated; no ffmpeg). Each segment is a workspace video with an optional trim (startSeconds, durationSeconds); segments with different dimensions are letterboxed to the first segment's size. Params: segments (array, 2–50), scaleWidth, targetBitrateKbps. Writes a new file; gated as a file change.

- Access: governed by your run permission role
- Required args: segments
- Optional args: scaleWidth, targetBitrateKbps
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"video_concat_clips","arguments":{"segments":[]}}}}`

## audio_extract

Extract the audio track from a workspace VIDEO to a standalone audio file via ffmpeg. Params: sourcePath, `format` (wav|m4a|mp3), `bitrateKbps` (32–320, default 192; ignored for wav). Requires ffmpeg. Writes a new audio file into the workspace and returns it as a media attachment. Gated as a file change.

- Access: governed by your run permission role
- Required args: sourcePath, format
- Optional args: bitrateKbps
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"audio_extract","arguments":{"sourcePath":"text","format":"text"}}}}`

## transcode_audio

Transcode a workspace audio/video file’s audio to the chosen format via ffmpeg. Params: sourcePath, `format` (wav|m4a|mp3), `bitrateKbps` (32–320, default 192; ignored for wav). Requires ffmpeg. Writes a new audio file into the workspace and returns it as a media attachment. Gated as a file change.

- Access: governed by your run permission role
- Required args: sourcePath, format
- Optional args: bitrateKbps
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"transcode_audio","arguments":{"sourcePath":"text","format":"text"}}}}`

## audio_mix

Mix N workspace audio tracks into one file using the OS's native audio engine (no ffmpeg). Per-track gainDb (dB), pan (-1..1), offsetMs (timeline placement in ms), fadeInMs/fadeOutMs (ms). Params: tracks (array, 1–24), `format` (wav|m4a), sampleRate (default 44100), channels (1|2, default 2), bitrateKbps (AAC m4a only, 32–320, default 192). All sources must already match the output sampleRate. Writes a new audio file and returns it as a media attachment. Gated as a file change.

- Access: governed by your run permission role
- Required args: tracks, format
- Optional args: sampleRate, channels, bitrateKbps
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"audio_mix","arguments":{"tracks":[],"format":"text"}}}}`

## transcribe_audio

Transcribe a workspace audio file to text ON-DEVICE using the Mac’s built-in Speech recognition (no audio ever leaves the machine; no network). Returns the recognized text plus per-segment timings (startMs/endMs) and confidence. Use it to read back what was said in a recording, voice memo, or extracted audio track. Params: sourcePath (an audio file inside the workspace), `localeIdentifier` (BCP-47, e.g. "en-US", default "en-US"). Requires the macOS Speech Recognition permission; if it is not granted (or an on-device model for the locale is unavailable) the call returns an actionable error telling you how to enable it. Reads a realpath-jailed workspace path; non-mutating and read-only-safe.

- Access: read-only (no approval needed)
- Required args: sourcePath
- Optional args: localeIdentifier
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"transcribe_audio","arguments":{"sourcePath":"text"}}}}`

## transcode_video

Transcode a workspace VIDEO to H.264/AAC MP4 (faststart) via ffmpeg. Params: sourcePath, `crf` (0–51, lower=higher quality, default 23), `scaleWidth` (output width in px; height auto), `fps`. Requires ffmpeg. Writes a new MP4 file into the workspace and returns it as a media attachment. Gated as a file change.

- Access: governed by your run permission role
- Required args: sourcePath
- Optional args: crf, scaleWidth, fps
- Example: `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"transcode_video","arguments":{"sourcePath":"text"}}}}`
