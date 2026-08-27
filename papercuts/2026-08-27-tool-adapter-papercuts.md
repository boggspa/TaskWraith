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

This document consolidates the live probe findings and native call inventories across all **nine active provider platforms** on the panel (Codex, Ollama, Kimi, Claude, Cursor, Grok, Pi, Antigravity, Mistral). It establishes the structural root causes of dialect mismatch, catalogs newly discovered severity-ranked papercuts (S1–S5), confirms cross-provider invariants, provides a per-provider reference appendix, and records the current status of round fixes.

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

## 2. Severity-Ranked Defects & Papercuts (S1–S5)

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

### S5: Residual Verdict-Not-Repair Errors in Non-Ensemble Tools

- **Severity:** S5 (Medium / Agent Recovery Friction)
- **Reproducing Seat:** Claude (`@Work4` C, D, E)
- **Symptoms:**
  - `capability_invoke({name: "read_file"})` returns `"Unknown TaskWraith capability: read_file"` for a tool plainly advertised in the primary catalog, rather than indicating direct availability.
  - `run_task({task: "test", args: [...]})` returns `invalid-call: "run_task cannot prove an exact file/hunk mutation scope; use exact TaskWraith file tools or a read-only command"`, despite advertising `test` in its catalog description.
  - `apply_patch` reports invalid hunk line numbers and misattributes header failures when `@@` count markers do not match hunk line tallies.
- **Required Adaptation:** Extend self-healing repair templates and actionable error messages across `capability_invoke`, `run_task`, and `apply_patch`.

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
   - When a tool schema recognizes the canonical field and only one spelling is supplied, the shared alias layer reliably handles: - `cmd` $
ightarrow$ `command` - `workdir` $
ightarrow$ `cwd` - `file_path` / `target_file` $
ightarrow$ `path` - `pattern` $
ightarrow$ `query` - `glob` (string) $
ightarrow$ `globs` (string array, verified via control tests)
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
- **Habits / Mismatches:** Because the native surface is suppressed, no Claude-native call is emitted. Read-only TaskWraith probes using Claude-style field spellings supplied `Bash`-style parameters (`timeout`, `description`, `run_in_background` $
ightarrow$ S3) and `Grep`/`Glob` parameters (`pattern` $
ightarrow$ S2, singular `glob` string $
ightarrow$ normalized).

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
  - `search_tool({query, limit?})` $
ightarrow$ `use_tool({tool_name: "TaskWraith__*", tool_input})`
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

### Verification Status & Known Caveat

- **Unit Verification:** Full test suites are **GREEN** (45 tests across 6 affected suites; typecheck clean across node/web/TUI/host).
- **Live Binary Verification:** **NOT YET VERIFIED on a rebuilt binary.** The runtime binary (`out/main/index.js`) predates all round commits. Live end-to-end acceptance requires a fresh build before the root goal can be completed.
- **Repair Map Coverage:** All 11 `ensemble_*` tools plus `scout_brief` are wrapped (**12/12 coverage** for tools in the repair map). Future ensemble tools should be protected with guard tests to prevent bare `mcpJson` usage; `blackboard_*` (20 sites) remains uncovered by retry templates.
