# Cross-Provider Tool Adapter Papercuts & Native Dialect Inventory

- **Date:** 2026-08-27
- **Author / Consolidator:** @Challenge4 (Antigravity / Gemini 3.7 Flash High)
- **Round:** ensemble-1787835380903-wzaunzn2tu8
- **Scope:** `papercuts/2026-08-27-tool-adapter-papercuts.md`

---

## Overview & User Intent

During continuous multi-provider ensemble rounds, participant agents frequently encounter tool call failures, schema mismatches, and silent parameter drops when attempting to interact with the TaskWraith runtime.

As directed by host steering:

> _"Feel free to each of you to test tooling yourselves (each participant) and note any inconsistencies in a tool-specific papercuts markdown scratchpad that we'll work from in this thread so we can fix all the issues as necessary... the harness should cleanly adapt calls - but that means we need each of you to outlay your native call types so we can cleanly adapt them all too."_

This document consolidates the live probe findings and native call inventories across all **nine active provider platforms** on the panel (Codex, Ollama, Kimi, Claude, Cursor, Grok, Pi, Antigravity, Mistral). It establishes the structural root causes of dialect mismatch, catalogs newly discovered severity-ranked papercuts (S1–S7), confirms cross-provider invariants, provides a per-provider reference appendix, and records the current status of round fixes.

---

## 1. Structural Architecture: Three Provider Tooling Topologies

The friction described as _"agents fighting tool failures"_ is not a uniform issue across seats; it stems from three distinct provider integration topologies:

| Topology Tier                            | Providers                              | Integration Mechanism                                                                                                                                            | Observed Friction                                                                                                                                           | Adapter Strategy                                                                                                                                                                           |
| ---------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **(a) TaskWraith IS Native**             | Ollama, Mistral, Pi                    | Runtime directly advertises the TaskWraith MCP catalogue. No intermediary dialect or shim.                                                                       | **Zero dialect friction.** Availability can still vary: Pi/Scout2 saw managed transports advertised but unavailable through a prose-only readiness receipt. | No translation needed. Preserve canonical schemas and expose availability structurally.                                                                                                    |
| **(b) Native Layer SUPPRESSED**          | Claude                                 | Provider-native tools (`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Task`) are completely removed from the prompt; only `mcp__TaskWraith__*` is advertised. | **Zero dialect friction.** (Model never attempts unadvertised native tools).                                                                                | Ideal target topology for all providers.                                                                                                                                                   |
| **(c) Native Layer PRESENT & REACHABLE** | Codex, Kimi, Cursor, Grok, Antigravity | Model retains native tools alongside or wrapping TaskWraith MCP tools. Models emit native shapes, get rejected or silently mangled, and must fallback/reroute.   | **High friction.** Every reported papercut and dialect collision is a Topology (c) symptom.                                                                 | **Make (c) look like (b):** Surface suppression beats post-hoc translation. Where suppression is impossible (e.g. Grok parallel native runtime), provide strict containment & coalescence. |

**Strategic Architectural Goal:** Make Topology (c) behave like Topology (b). An unofferable tool cannot be miscalled. For parallel native tools that cannot be suppressed, the harness must adapt incoming shapes into audited TaskWraith operations without bypassing write locks or audit paths.

---

## 2. Severity-Ranked Defects & Papercuts (S1–S8)

The following bugs and papercuts were discovered and reproduced during panel probe passes. None of these were documented prior to this round.

### S1: `list_directory` Silently Returns Wrong Directory (Workspace Root) on Unknown Key

- **Severity:** S1 (Critical / Silent Wrong Data / Misleading State)
- **Reproducing Seat:** Grok (`@Work1` #9)
- **Symptom:** Invoking `list_directory({target_directory: "papercuts"})` silently ignored the unknown key `target_directory`. Because `path` was omitted, the tool defaulted to listing the **workspace root directory** with a successful return status.
- **Impact:** The agent receives confident, plausible, but entirely incorrect filesystem state without any error indicator.
- **Required Adaptation:** Coalesce `target_directory` → `path`. If an unrecognized parameter is passed without a valid `path`, fail closed immediately. Never default to listing workspace root on unrecognized arguments.

### S2: Inconsistent Ambiguous-Alias Guard Across Catalog Tools

- **Severity:** S2 (High / Inconsistent Safety Semantics)
- **Reproducing Seat:** Grok (`@Work1` #8 vs #4)
- **Symptom:**
  - On `read_file({path: "package.json", target_file: "README.md"})` (conflicting aliases), the tool correctly fails closed with `ambiguous_argument_alias`.
  - On `workspace_search({query: "taskwraith", pattern: "DOES_NOT_EXIST_GROK_PROBE"})` (conflicting aliases), the tool **silently drops `pattern` and executes `query`**.
- **Impact:** Inconsistent parameter resolution rules across catalog tools create unpredictable execution behavior.
- **Required Adaptation:** Standardize the ambiguous-alias guard centrally in argument normalization: if multiple recognized alias keys are supplied with differing values, fail closed across all tools with `ambiguous_argument_alias`.

### S3: Semantic Execution Parameters Silently Dropped on `run_shell_command`

- **Severity:** S3 (Medium-High / Silent Semantic Loss)
- **Reproducing Seats:** Claude (`@Work4` A), Grok (`@Work1` #5), predicted by Codex (`@Advisor` C)
- **Symptom:** Invoking `run_shell_command({command: "...", timeout: 5000, description: "...", run_in_background: false})` succeeded with no error and no mention of the three extra keys.
- **Impact:** `timeout` and `run_in_background` are load-bearing semantic controls. The calling agent falsely believes a 5-second cap was enforced or a background task was daemonized.
- **Required Adaptation:** Return an explicit receipt disclosing unhandled fields (e.g. `ignoredKeys: ["timeout", "run_in_background", "description"]`). Never silently discard semantic parameters. (Do not elevate permissions; explicitly disclose runtime limits).

### S4: `read_file` Entry Size-Gate Defeats Its Documented Offset/Limit Remedy

- **Severity:** S4 (Medium / Tool Usability & Guidance Block)
- **Reproducing Seats:** Claude (`@Work4` B), Claude (`@Orchestrator` live pass)
- **Symptom:** The schema description for `read_file` states: _"For large files, pass offset/limit to read a line window instead of shell tools like sed."_ However, on large monolith files (e.g. `src/main/index.ts`), invoking `{path: "src/main/index.ts", offset: 37234, limit: 6}` fails at the initial entry size-gate with `"File is too large to read through the MCP bridge"` before window slicing is evaluated.
- **Impact:** Agents are blocked from reading targeted line ranges and are forced back to shell commands (`sed`), contrary to catalog documentation. Furthermore, `read_file` and `replace` enforce different size limits (1.5 MB for `replace`) with divergent error messages.
- **Required Adaptation:** Evaluate bounded `offset`/`limit` windows before applying whole-file size checks, or update error messages to accurately recommend `run_shell_command sed -n` alongside working line limits.
- **Resolution (phase 2, `2d645a9f5`):** A requested line window is now STREAMED — 64KB chunks are scanned for newlines and discarded, retaining only the requested lines, so peak memory is one chunk plus the capped window at any file size. The byte cap was NOT raised; it now bounds the returned window instead of a file that had to be buffered in order to discard almost all of it. Measured on the real monolith: the old path refused `src/main/index.ts` outright, the new path served `[read_file: lines 40580-40583 of 60630]` in 20ms retaining 106 bytes. The whole-file path is byte-identical to before, pinned by a 5x6 equivalence matrix against `windowReadFileText`.
- **Resolution caveat — the first fix introduced a second silent-data bug.** The streaming reader set a `truncated` flag when the byte cap cut a window short, and its unit test asserted the flag, but the dispatch never read it: the caller received incomplete bytes under a normal `[read_file: lines X-Y of N]` success header whose `endLine` was the line REQUESTED, not the last line delivered. On a 4-line fixture with a 25-byte cap the header claimed 4 lines while delivering 2. This was caught by `@Validator` at the commit gate, NOT by the author. It now FAILS CLOSED, because a byte-boundary cut can leave a partial final line that cannot be described honestly, and the refusal carries a computed repair: `Retry with {"offset":X,"limit":<completeLines>}` derived from the bytes actually delivered. A dispatch-level regression was added because the unit-level flag assertion passed throughout and missed it.
- **Not fixed:** the mirror buffer-then-slice site in `src/main/ollama/OllamaMainRuntime.ts` retains the old behaviour. Its contract genuinely differs (`startLine`/`endLine`/`maxLines` rather than `offset`/`limit`; CRLF is normalized to LF; `bytes` comes from a whole-file stat), and its `read_file` path has zero test coverage, so only the error message was repaired to name the route that works in that loop.

### S5: Residual Verdict-Not-Repair Errors in Non-Ensemble Tools

- **Severity:** S5 (Medium / Agent Recovery Friction)
- **Reproducing Seat:** Claude (`@Work4` C, D, E)
- **Symptoms:**
  - `capability_invoke({name: "read_file"})` returns `"Unknown TaskWraith capability: read_file"` for a tool plainly advertised in the primary catalog, rather than indicating direct availability.
  - `run_task({task: "test", args: [...]})` returns `invalid-call: "run_task cannot prove an exact file/hunk mutation scope; use exact TaskWraith file tools or a read-only command"`, despite advertising `test` in its catalog description.
  - `apply_patch` reports invalid hunk line numbers and misattributes header failures when `@@` count markers do not match hunk line tallies.
- **Required Adaptation:** Extend self-healing repair templates and actionable error messages across `capability_invoke`, `run_task`, and `apply_patch`.
- **Resolution (phase 2, `2a19e65b9` + close-out):** PARTIAL, and the remainder is named rather than implied.
  - `run_task` — LIVE. The `invalid-call` verdict now echoes the received task and names the working route (`run_shell_command` with the equivalent command), whose boundary carries the approved-host-execution retry that `run_task` itself lacks.
  - `capability_invoke` — WIRED (0 call sites → 1). `buildCapabilityInvokeUnknownTargetHint` is attached at the gateway rejection rather than inside `attachMcpResultRepairHints`, because that rejection returns before the `mcpEnsembleJson` seam is declared and is in its temporal dead zone. Verified behaviourally: `capability_invoke({name:'read_file'})` now returns _"read_file is advertised directly — call it directly with the same arguments"_ plus `retryTemplate: {tool:'read_file', arguments:{…}}`.
  - `apply_patch` — builder exported and unit-tested but wiring was still in flight at the time of writing; it has no `index.ts` dispatch branch (`grep -c "toolName === 'apply_patch'"` = 0), so its real result path is `WorkspaceToolExecutors.ts`. The failing-hunk index and declared-vs-actual line counts can only be surfaced at the `unsafe_patch` rejects, where that data actually exists.
- **Open advertisement mismatch:** `run_task` always throws in claim derivation, yet the catalog still advertises `test`. Naming the working route repairs the error, but the advertisement itself stays misleading until `run_task` gains a claim derivation or stops advertising `test`.

### S6: Resumed Seat Loses Its Mutating Shell Route Without a Repair Path

- **Severity:** S1 (Critical / Commit Gate Unreachable)
- **Reproducing Seat:** Codex (`@Validator`, resumed turn)
- **Symptom:** A resumed seat lost `TASKWRAITH_RUN_ID` / `TASKWRAITH_CHAT_ID`. `run_shell_command` rejected `git commit` as an unrouted mutating call and supplied no `permissionRetry`, corrected call, or dedicated-tool hint. The validated slice was staged but uncommittable through the instructed shell route.
- **Repair Probe:** On a freshly routed turn, the purpose-built `git_commit` tool succeeded in both `private_index` and `pathspec` modes. However, two exact `capability_search` queries (`git commit staged exact paths private index` and `git_commit`) failed to return that tool even though it was directly callable.
- **Impact:** This is worse than a wasted first call: work stops at the commit gate unless a Boss re-routes the seat and already knows the undiscoverable dedicated tool name.
- **Required Adaptation:** Preserve run/chat audit identity across resumed turns. When shell containment rejects Git mutation, return a `permissionRetry` or a structured `directToolHint` containing the exact `git_commit` call. Exact-name `capability_search` must surface directly callable tools rather than only adjacent matches.
- **Resolution (phase 2, `50b37100e`):** Two of the three halves are closed; the third is explicitly NOT.
  - **S6a — route repair (`McpRouteGuards.ts`).** The unrouted mutating call STILL HARD-FAILS. It now additionally returns a `directToolHint` (`git_commit` / `write_file` / `apply_patch`) and states the real recovery sequence: restore a run-bound route, then invoke the direct tool under its normal route, approval, and workspace checks. Disclosure only — no `permissionRetry`, no auto-allow, no route bypass, no grant widening. A test asserts the guard still refuses.
  - **S6b — discovery (`McpToolGateway.ts`).** An exact-name match on a direct tool is now returned flagged as directly callable. The eligible/hidden/advertise sets were NOT widened; a regression test pins that the eligible set did not grow.
  - **S6c — identity propagation across resume: NOT FIXED.** The root cause (a resumed seat losing `TASKWRAITH_RUN_ID`/`TASKWRAITH_CHAT_ID`) is untouched. S6a makes the dead end navigable; it does not prevent it. This defect reproduced live at least three further times during phase 2, repeatedly blocking `@Validator`'s own independent typecheck at the commit gate.

### S7: `git_commit` Silently Accepts a Partial Requested Path Set

- **Severity:** S2 (High / Incomplete Commit Reported as Success)
- **Reproducing Seat:** Codex (`@Validator`, private-index commit gate)
- **Symptom:** `git_commit` received two requested paths, but the supplied ordinary `git diff` patch omitted the untracked new file. The tool returned `ok: true` and committed only one path instead of failing on the partial path set. Its result exposed the smaller committed-path list, but supplied no `rejectedPaths`, missing-path verdict, or repair.
- **Recovery:** Validator detected the result-path mismatch and created an explicit new-file patch with `git diff --no-index /dev/null`, then landed the omitted file in companion commit `408faf77a`.
- **Required Adaptation:** In `private_index` mode, compare requested paths with patch-touched paths and fail closed on any missing or extra entry. Return structured `missingPaths` / `rejectedPaths` plus a corrected new-file patch hint; never silently shrink an atomic slice.
- **Resolution (phase 2, `1d44b60d9`):** `assertCommittedPathsCovered` was asymmetric — it checked actual ⊆ declared (no path escapes the declaration) but never declared ⊆ actual, which is why a requested path absent from the patch was silently dropped. Private-index mode now enforces both directions and FAILS CLOSED with `missingPaths` plus the exact remedy: an untracked file needs its own `git diff --no-index /dev/null <file>` record, because ordinary `git diff` omits untracked files — precisely how the original trap was sprung. Pathspec mode is unchanged, and the pre-existing escape check is preserved.

### S8: `update_goal` Rejects an Unsent Field, Then Silently Discards the Payload

- **Severity:** S1 (Critical / Silent Data Loss Reported as Success)
- **Reproducing Seat:** Claude (`@Orchestrator`, live, while creating the goal to fix this very class)
- **Symptom (a) — verdict names a constraint on a field the caller never sent:** `update_goal({objective, reason})` with no `status` returned `ok:false` _"Goal status must be active, paused, blocked, or completed."_ The schema documents `status` as OPTIONAL. The error demands an enum for an unsupplied optional field, echoes none of what was received, and offers no corrected call.
- **Symptom (b) — silent drop under a success receipt, and the more serious half:** Retried as `update_goal({status:'active', objective:<2.5KB scope>, reason})` → **`ok:true`**. The returned goal's `objective` was byte-identical to the previous text: the supplied objective was DISCARDED and the receipt said success. The same payload exposed the cause — `objectiveSource:"user"` — but nothing in the result told the caller their field had been ignored.
- **Impact:** Same family as S1 (`list_directory` answering with the wrong directory) and the S4 truncation regression: confidently wrong state the caller cannot detect. Here it silently defeated the round's own goal-lifecycle step, so the tracked objective still describes phase 1.
- **Required Adaptation:** Never return a bare `ok:true` when a supplied field was ignored — disclose an `ignoredFields` list naming each dropped field and why (e.g. user-owned objective is not agent-writable). For (a), stop demanding an enum for an unsent optional field; echo the received keys and return a corrected call.
- **Status:** NOT FIXED. Recorded here as the round's own eighth specimen, produced by the tooling while it was being repaired.

---

## 3. Confirmed Cross-Provider Invariants

Probing across 3+ independent seats per feature established the following system-wide invariants:

1. **Git Unified Diff Requirement on `apply_patch`:**
   - `apply_patch` strictly requires `{patch: string}` containing a standard Git unified diff.
   - Provider-specific envelopes (such as Codex `*** Begin Patch` or Grok `search_replace` payloads) fail closed.
   - **Context line strictness:** Diff context lines require the mandatory leading whitespace marker. Unmarked context lines cause patch rejection.
2. **Strict Parameter Boundaries on `run_shell_command`:**
   - Supports only `{command: string, cwd?: string}`.
   - No interactive PTY/tty allocation, no streaming callbacks, no background resumption handles (`functions.wait(cell_id)` cannot resume background cells from MCP seats).
3. **Monolith Size Ceiling on `replace`:**
   - `replace` strictly rejects files $\ge 1,500,000$ bytes (e.g. `src/main/index.ts`). Modifications to monoliths must use `apply_patch` or private git indices.
4. **Normalized Catalog Alias Mappings:**
   - When a tool schema recognizes the canonical field and only one spelling is supplied, the shared alias layer reliably handles:
     - `cmd` → `command`
     - `workdir` → `cwd`
     - `file_path` / `target_file` → `path`
     - `pattern` → `query`
     - `glob` (string) → `globs` (string array, verified via control tests)
   - These aliases apply only where the receiving tool schema recognizes the canonical field. Conflicting spellings must fail closed; S2 documents the `workspace_search` exception found this round. Alias handling is not permission to translate unrelated native operations such as Grok `search_replace` into `apply_patch`.
5. **Antigravity Dialect Invariant:**
   - Antigravity cannot emit raw TaskWraith MCP JSON directly. It communicates exclusively via `call_mcp_tool({ServerName: "TaskWraith", ToolName: string, Arguments: object})` with PascalCase argument keys.

---

## 4. Per-Provider Native Tool Inventory (Appendix)

### 1. Codex (Advisor / Validator — GPT 5.6 Sol; Work3 — GPT 5.6 Terra)

- **Topology:** (c) Native Codex tool layer + TaskWraith MCP
- **Native Invocation Shapes:**
  - `functions.exec` accepts freeform JavaScript source that invokes typed nested tools; it is not a `{code}` JSON call.
  - `exec_command({cmd, workdir?, yield_time_ms?, max_output_tokens?, tty?, shell?, login?, sandbox_permissions?, justification?, prefix_rule?})`.
  - `functions.wait({cell_id})` resumes a yielded `functions.exec` cell; TaskWraith MCP itself exposes no equivalent `session_id`/`write_stdin` continuation surface.
  - Native `apply_patch` accepts a freeform string, normally a `*** Begin Patch` envelope.
- **Habits / Mismatches:** TaskWraith coalesces `cmd`→`command` and `workdir`→`cwd`, but unsupported execution controls were silently ignored. Codex patch envelopes must currently be translated into Git unified diffs before calling TaskWraith `apply_patch({patch})`.

### 2. Ollama (Challenge2 / Challenge3 — minimax-m3 / glm-5.2)

- **Topology:** (a) TaskWraith IS Native
- **Native Invocation Shapes:** Direct TaskWraith MCP catalogue (`run_shell_command`, `write_file`, `replace`, `read_file`, `apply_patch`, `list_directory`, `workspace_search`).
- **Habits / Mismatches:** Zero dialect translation friction.

### 3. Kimi (Boardmaster / Work2 — Kimi K3)

- **Topology:** (c) Kimi Code CLI native surface + TaskWraith MCP
- **Native Invocation Shapes:** Native `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `TaskOutput`, `WebSearch`, `FetchURL`, and related structured calls.
- **Habits / Mismatches:** Live probes saw native `Bash` and `Write` rejected, native `Read` limited for large previews, native `Grep` unavailable through ACP, and `Edit` fail closed after concurrent modification. The working route was to reissue the intent through TaskWraith `run_shell_command`, `read_file`, `write_file`, `replace`, and `workspace_search` without permission elevation.

### 4. Claude (Orchestrator / Work4 — Claude Opus 5)

- **Topology:** (b) Native Layer Fully Suppressed
- **Native Invocation Shapes:** Only `mcp__TaskWraith__*` is advertised. Claude-native tools (`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Task`, `WebFetch`, `NotebookEdit`, `TodoWrite`) are completely absent.
- **Habits / Mismatches:** Because the native surface is suppressed, no Claude-native call is emitted. Read-only TaskWraith probes using Claude-style field spellings supplied `Bash`-style parameters (`timeout`, `description`, `run_in_background` → S3) and `Grep`/`Glob` parameters (`pattern` → S2, singular `glob` string → normalized).

### 5. Cursor (Scout3 — Composer 2.5 Fast)

- **Topology:** (c) Native Cursor IDE surface + a limited dynamic TaskWraith broker
- **Native Invocation Shapes:** `Shell`, `Grep`, `Read`, `Write`, `StrReplace`, `Delete`, `Glob`, `WebSearch`, `WebFetch`, `Task`, `TodoWrite`, `SwitchMode`, `AskQuestion`, `EditNotebook`, `Await`, `GetDynamicTools`, `CallDynamicTool`, and `FetchMcpResource`.
- **Habits / Mismatches:** Native `Shell` failed closed, while the prompt-directed TaskWraith shell fallback was absent from the callable surface. `GetDynamicTools` exposed only TaskWraith web search/fetch despite prose describing the wider gateway. Read/search probes worked; mutating native tools were not probed, so no bypass claim is made.

### 6. Grok (Work1 — Grok 4.6)

- **Topology:** (c) Active Parallel Native Dialect + TaskWraith MCP
- **Native Tool Catalogue (Verbatim):**
  - `run_terminal_command({command, timeout?, description?, background?})` _(Note: no `cwd` parameter)_
  - `read_file({target_file, offset?, limit?, pages?, format?})`
  - `search_replace({file_path, old_string, new_string, replace_all?})`
  - `write({file_path, content})`
  - `list_dir({target_directory})`
  - `grep({pattern, path?, glob?, -B?, -A?, -C?, -i?, type?, head_limit?, multiline?})`
  - `web_search({query, num_results?})`, `web_fetch({url})`, `open_page({url, start_line?})`, `open_page_with_find({url, pattern?, max_matches?, context_lines?})`
  - `search_tool({query, limit?})` → `use_tool({tool_name: "TaskWraith__*", tool_input})`
  - `ask_user_question({questions:[{question, options:[{label,description,preview?}], multi_select?}]})`
- **Habits / Mismatches:** Native tools execute in parallel and bypass TaskWraith audit paths. `target_directory` triggered S1; `pattern` triggered S2; `timeout` triggered S3; `search_replace` rejected by `apply_patch`.

### 7. Pi (Paperwork — Cerebras/gpt-oss-120b; Scout2 — DeepSeek V4 Pro)

- **Topology:** (a) TaskWraith IS Native
- **Native Invocation Shapes:** Direct TaskWraith MCP JSON tools such as `read`, `grep`, `find`, `ls`, `run_shell_command`, file mutations, and Ensemble/blackboard controls.
- **Habits / Mismatches:** No dialect translation is required. On Scout2's run, managed shell/file/Ensemble/blackboard transports were advertised but declared unavailable only in a prose readiness receipt, preventing the requested blackboard post. Availability should be structured per tool rather than contradicted by the advertised schema.

### 8. Antigravity (Challenge4 / Work5 — Gemini 3.7 Flash High / Gemini 3.1 Pro High)

- **Topology:** (c) Antigravity API Dialect Wrapper
- **Native Tool Catalogue:**
  - `call_mcp_tool({ServerName: "TaskWraith", ToolName: string, Arguments: object})`
  - `run_command({Cwd, WaitMsBeforeAsync, CommandLine, BypassSandbox})`
  - `replace_file_content({TargetFile, Instruction, Description, AllowMultiple, TargetContent, ReplacementContent, StartLine, EndLine})`
  - `write_to_file({TargetFile, Overwrite, CodeContent, Description, ArtifactMetadata?})`
  - `view_file({AbsolutePath, StartLine?, EndLine?, ContentOffset?})`
  - `manage_task`, `invoke_subagent`, `find_by_name`, `grep_search`, `list_dir`, `ask_question`, `schedule`
- **Habits / Mismatches:** All MCP interactions require the `call_mcp_tool` wrapper with PascalCase property names. Native `view_file` is blocked by pre-tool workspace hooks; sandbox restricts execution strictly to workspace bounds.

### 9. Mistral (Scout1 — Mistral Medium 3.5)

- **Topology:** (a) TaskWraith IS Native
- **Native Invocation Shapes:** Canonical TaskWraith MCP catalogue (`run_shell_command`, `write_file`, `replace`, `read_file`, `apply_patch`, `list_directory`, `workspace_search`).
- **Habits / Mismatches:** Zero dialect translation friction.

---

## 5. Round Fix History & Verification Status

### Merged Commits in Current Round

1. `b4fbc67b9` — **Locked-Writers Demotion:** Implemented `resolveForcedReadOnlyFanoutPermissions` in `src/main/services/EnsembleOrchestrator.ts`. Demotes unkeyed fanout targets to read-only, resolving `missing_write_scope` failures.
2. `2e2035498` — **Shared Argument Normalizer:** Added `normalizeEnsembleMcpToolArguments` in `src/main/mcp/McpBridgeRuntime.ts` and `src/shared/taskWraithMcpCatalog.ts`. Handles both `ensemble_control` and legacy `ensemble_bossman_control`, folds snake_case, and supports `planSummary`/`plan`/`summary`/`steps` aliases.
3. `327d3af95` — **Catalog Example Correction:** Fixed poisoned example in `src/main/McpToolCatalog.ts` from `{action: "set_round_plan", goal: "..."}` to `{action: "set_round_plan", planSummary: "..."}`.
4. `f43632ca9` — **Actionable Repair Hints:** Added `src/main/mcp/McpResultRepairHints.ts` and wrapped 12 `mcpEnsembleJson` dispatch sites in `src/main/index.ts` to attach concrete retry templates to `ok:false` errors.
5. `80f90c000` — **First-Call Success Corpus:** Added table-driven test fixtures in `src/main/mcp/McpFirstCallSuccessCorpus.ts` and `src/main/mcp/McpFirstCallSuccess.test.ts`.
6. `be7d0355a` — **Native Directory/Search Aliases:** Restricts directory-native aliases to `list_directory` and makes conflicting `workspace_search` aliases fail closed.
7. `7528dabb3` — **Native Argument-Loss Hardening:** Prevents unknown path-like `list_directory` arguments from silently listing root and discloses unsupported native shell fields without implementing or elevating their semantics.
8. `20cb0c47f` — **Resumed-Seat Dead-End Record:** Adds the S6 commit-route and capability-discovery findings to this artifact.
9. `6119c1304` — **Dispatch Contract Guards:** Pins repair-wrapper coverage plus the S1/S3 fail-closed and disclosure contracts.
10. `408faf77a` — **First-Call Dispatch Projection:** Pins normalized `planSummary` and its aliases through the main dispatch projection.
11. `2d645a9f5` — **S4 Streaming Line Windows:** Bounded windows served by streaming without raising the byte cap, jail-parity behaviour tests, truncation fail-closed with a computed `{offset,limit}` retry, Ollama verdict disclosure, and the dispatch contract guard.
12. `2a19e65b9` — **S5 Partial:** `run_task` live repair message plus tested `capability_invoke` / `apply_patch` builders.
13. `50b37100e` — **S6a + S6b:** Unrouted mutation still refuses and now names a recovery route; exact direct-tool discovery without eligibility widening.
14. `1d44b60d9` — **S7 Symmetric Path Coverage:** Private-index requested/actual coverage with `missingPaths` and the `/dev/null` remedy; pathspec mode unchanged.

### Verification Status & Known Caveat

- **Unit Verification:** Production-slice full typecheck is **GREEN** across node/web/TUI/host. The final test gate also passed node typecheck and **137 tests across 7 affected suites**.
- **Live Binary Verification:** **NOT YET VERIFIED on a rebuilt binary.** The runtime binary (`out/main/index.js`) predates all round commits. Live end-to-end acceptance requires a fresh build before the root goal can be completed.
- **Repair Map Coverage:** All 11 `ensemble_*` tools plus `scout_brief` are wrapped (**12/12 coverage** for tools in the repair map). Future ensemble tools should be protected with guard tests to prevent bare `mcpJson` usage; `blackboard_*` (20 sites) remains uncovered by retry templates.
- **Repair Map Coverage — UPDATE (phase-2 close-out).** The line above is superseded and kept for the record. The "20 sites" figure was an artifact of a wide grep window that also swept `claim_fleet_wave` (a separate tool) and success paths; the measured figure is **12 `ok:false` error paths** across `blackboard_post` / `blackboard_read` / `blackboard_delete`. All 12 now serialize through `mcpEnsembleJson`, and the 3 success paths are deliberately left bare because a success needs no repair. Repair entries are keyed on the failure `code` rather than `toolName`, which also keeps the dispatch-coverage guard green. Covered so far include `blackboard_capacity_exhausted` (the highest-value case — session/chat-scoped entries are never evictable, so exhausting the board bricks it for every seat) and `blackboard_ttl_invalid`.
- **Coverage boundary (Boss decision, `boss-decision-blackboard-repair-coverage-boundary`).** A retry template is owed when a DIFFERENT CALL THE CALLER COULD MAKE would succeed. Where no argument change helps, the result owes DISCLOSURE of the failed precondition — never a template that would fail identically, because a retry template that cannot succeed on replay burns a second call and teaches a false lesson.
  - **Tier 1 — retry template required** (caller-correctable by changing arguments): `blackboard_capacity_exhausted`, `blackboard_ttl_invalid`, missing key/value, key/value length, category enum, poll-option bounds, round-resolution scope.
  - **Tier 2 — disclosure only** (no argument change helps): not-an-Ensemble chat, image persistence/finalization failures, and other environment or host-state preconditions.
  - **Tier 3 — verdict is already correct**: the error states a fact the caller can neither change nor act on differently.
