# AGENTS.md — environment notes for coding agents working inside TaskWraith

This file documents the TaskWraith runtime environment for any agent operating
inside a chat thread. It's meant to be read by the LLM at the start of a session
(via a system-prompt injection or MCP context exchange) so the agent understands
what affordances it has and how to use them.

If you're a human, this is also a useful map of the product surface.

---

## Formatting policy for agents

Do not run `npm run format` or repository-wide Prettier as routine
cleanup. The current `format` script runs `prettier --write .`, which
can create large unrelated diffs across the workspace and make review
harder.

Prettier is available for intentional formatting work, but normal code
changes should preserve the surrounding style and format only the files
or regions that were deliberately touched. Use scoped formatting or
targeted `prettier-ignore` comments only when the formatting change is
part of the task.

---

## Environment summary

TaskWraith is an Electron desktop app that runs coding agents in isolated
chat threads against workspaces. Each thread:

- Is bound to a configured provider runtime.
- Targets a single workspace (or runs in "global" scope without one).
- Has its own provider session, message history, run state, and
  approval policy.
- Lives under a workspace in the sidebar topology.

The desktop hosts the runtime and keeps settings, chats, run state, approvals,
usage, and pairing records under Electron `userData` by default, with provider
tools operating on workspace files through the configured workspace and policy
boundaries.

---

## Sub-Threads (Phase F1) — isolated delegation

TaskWraith supports **sub-threads**: a thread can spawn child threads
that run on the same or a different provider while remaining topologically
linked under the parent in the workspace tree.

Cross-provider orchestration is a common use, but a same-provider child is also
useful when parallel work needs a fresh context and an independently resumable
session. Common patterns:

- A long-context **Claude** thread hands the noisy CLI work off to a
  **Codex** sub-thread, then continues planning while Codex runs.
- A **Kimi** or **Cursor** project-aware thread delegates a careful diff edit to
  a **Claude** sub-thread.
- A **Codex** runtime delegates "research this codebase" reading work
  to a **Claude**, **Kimi**, or **Cursor** sub-thread.
- A **Codex** parent opens a second **Codex** seat for an independent review
  without sharing the parent's provider context.

### How it appears in the UI

1. The user opens a chat and clicks the **↪ delegate** affordance on a parent
   thread in the sidebar, or an agent calls the `delegate_to_subthread` MCP tool
   when policy allows it.
2. A modal asks: provider, delegation prompt, "return result on
   completion?" toggle.
3. On confirm, TaskWraith creates a new sub-thread:
   - Inherits the parent's workspace.
   - Records `parentChatId` + `delegationContext` (parent provider,
     delegation prompt, return-result flag, timestamps).
   - Navigates the user to the new sub-thread with the composer
     pre-filled by the delegation prompt.
4. The sidebar renders the sub-thread indented under the parent with
   a `↳` glyph.

### How it appears in the data model

`ChatRecord` gains two optional fields:

```typescript
parentChatId?: string;          // present on sub-threads only
delegationContext?: {
  createdAt: number;
  parentProvider: ProviderId;
  delegationPrompt: string;
  returnResultToParent: boolean;
  joinPolicy?: SubThreadJoinPolicy; // required/optional + quorum/deadline/debounce
  resultReturnedAt?: number;    // set when F2+ propagates back
};
```

Sub-threads do **not** share context with their parent — each is its
own isolated provider session. The delegation prompt is the only thing
that bridges across; everything beyond that is what the user (or the
sub-thread's agent) types in.

### Phase F1 invariants (still in force)

- **Max depth = 1.** A sub-thread cannot itself spawn a sub-thread.
  The UI affordance is hidden and the store rejects attempts. Future
  revs will lift this with ladder semantics.
- **Workspace inheritance.** Sub-threads default to the parent's
  workspace. Users can override per-spawn (future UI), but the data
  model already supports it via the optional `workspaceId` /
  `workspacePath` overrides on `AppStore.createSubThread`.

### Phase F2 — auto-propagation of sub-thread results

When `returnResultToParent: true` was selected, every terminal child outcome
(`done`, `requires_action`, `failed`, or `cancelled`) is first persisted in the
parent's durable mailbox. A projection-only synthetic `role: 'tool'` message is
appended to the parent transcript for UI/audit visibility, while provider
context receives the result exactly once through the mailbox delivery prompt.

```
↩ Result from <Provider> sub-thread (<title>):

<final assistant message content>
```

The synthetic message carries `metadata.kind = 'subThreadReturn'`,
`metadata.resultTrust = 'untrusted-child-output'`, and a back-pointer
(`subThreadId`, `subThreadProvider`, `subThreadTitle`) so renderers can show a
"view sub-thread" affordance. Propagation is idempotent —
`delegationContext.resultReturnedAt` is set on the sub-thread record and the
helper short-circuits on re-invocation.

The trigger is the terminal run event from `RunManager.onChange` (or the
background transcript's final flush). Failed and cancelled workers propagate a
typed terminal result even when they produced no assistant text.

A `subthread_returned` durable run-event is written under the
**parent** chat for audit.

### How a parent-thread agent should think about delegation

Agents can request delegation with
`delegate_to_subthread({ provider, prompt, model?, reasoningEffort?,
kimiThinking?, returnResult, subThreadId? })`.
That request is approval-gated by the current workspace's agentic-service
policy. Treat the tool result as fallible: if policy declines or recall fails,
do not loop or retry; continue the parent turn and tell the user what was
declined.

`model`, `reasoningEffort`, and `kimiThinking` configure a **fresh** delegated
seat. They are spawn-only: recalls inherit the existing seat controls and reject
attempts to change them, preserving the provider session and cache continuity.
TaskWraith-owned orchestration assigns a durable join policy to returned
results. Delegations from one parent run share a join group; required workers
gate quorum, optional workers do not, and the bounded debounce produces one
coalesced parent wake. These controls remain internal so the advertised MCP
catalogue and seat prompt prefix stay stable. Async delegated runs inherit a
capped permission posture but never inherit Trusted Session.

### Audit trail

Each spawn writes a `subthread_spawned` durable run event under the
parent chat with `{ subThreadId, provider, delegationPrompt,
returnResultToParent }`. Each future result-propagation will write a
matching `subthread_returned` event. The Approval Ledger panel doesn't
surface these — they go to the run-event store, which is the
broader-scope audit log.

---

## Ensemble mode (1.7.0) — multi-provider in a single thread

Ensemble chats put multiple providers in the **same** thread (vs
sub-threads which are isolated). Each chat can have up to 20 named
participants with their own provider + model + permission preset +
role. Participants take turns speaking in `order` ascending; each
participant sees the full transcript so far (their own messages +
every other participant's messages + user prompts).

If you're an agent operating inside an Ensemble chat, this affects
you in three concrete ways:

### 1. You're not the only voice in this thread

The transcript includes other participants' messages stamped with
`metadata.ensembleProvider` / `ensembleRole` / `ensembleModel`.
Treat them as peers, not as the user. They may disagree with you,
build on your work, or yield back to you.

### 2. You can hand off the turn deliberately

Call `ensemble_yield({ reason?, target? })` when you want to pass
the current turn to another participant. Three ways to pick a
target:

- **By role** (recommended): `ensemble_yield({ target: 'Planner',
  reason: 'Need a high-level plan before I implement.' })`.
- **By provider**: `ensemble_yield({ target: 'codex' })`.
- **By model alias**: `ensemble_yield({ target: 'GPT 5.5' })`
  / `{ target: 'Sonnet 4.7' }` / `{ target: 'Flash Lite' }` /
  `{ target: 'Kimi K2.6' }`. Multi-word model names are supported —
  the resolver matches across spaced + hyphenated forms.

If `target` doesn't resolve, the round falls through to default
ordering. `reason` is included in the audit trail.

### 3. You can call another participant in-line via @-mention

If your assistant message contains `@Role` / `@provider` /
`@ModelName` (matching the same alias resolver as `ensemble_yield`),
TaskWraith's orchestrator promotes that participant to speak next OR
appends them an extra turn if they've already spoken this round.
First match wins; subsequent `@-mentions` in the same message are
ignored. Self-mentions are filtered (you can narrate "I, Codex,
think…" without looping yourself back to the front).

```
"@Reviewer can you sanity-check this diff before I commit?"
→ Reviewer participant gets the next turn.
```

This is the lower-friction way to invite collaboration — yield is
explicit, mention is conversational.

### Stage roles and background lanes

The participant Stage control has five choices: **Any**, **Scout**, **Work**,
**Review**, and **BG**. Scout/Work/Review shape the foreground waves. A BG
participant is different: it receives no ordinary serial or review turn and
runs only when explicitly delegated.

- A unique `@BG`, `@Background`, `@Role`, or `@Model` mention launches that
  participant in a detached lane while foreground rotation continues. Bare
  `@BG` is rejected as ambiguous when more than one BG seat matches.
- Mention/yield launches are always capped to read-only posture. Scoped
  mutations must use the existing Boss-authorized
  `ensemble_fanout(mode=locked_writers, targetStage=backgrounds,
  writeScopes=...)` path.
- BG lanes never inherit Trusted Session and cannot own Boss, Captain, Work
  Session lead/manager, synthesizer, or broad fan-out authority.
- Normal completion waits for live/reserved BG lanes. Cancellation and failure
  preserve the terminal fast-close semantics and stop those lanes immediately.

### Turn-bound vs Continuous mode

Each ensemble has a `orchestrationMode`:

- **Turn-bound** (default) — each enabled participant speaks ONCE
  per round. After everyone speaks, the round ends and the user
  is prompted for the next user turn.
- **Continuous** — participants can keep handing off (via yield or
  @-mention) until either someone explicitly "returns to user"
  (replies without a yield + without an @-mention) or the
  `maxContinuationHops` budget is exhausted (default 6).

The user picks the mode via the composer's Turn / Continuous chip.
If the round is currently running, the toggle reflects the active
round's mode (not editable mid-round).

### Same-provider participants

Ensembles can include MULTIPLE participants of the same provider
running DIFFERENT models — e.g. one `claude-sonnet-4-7` + one
`claude-opus-4-7` working alongside each other. Each has a stable
participant id, so the orchestrator can dispatch them independently.
This is why the model-name @-tagging (above) matters: `@Sonnet 4.7`
disambiguates from `@Opus 4.7` even though both are Claude.

### Asking the user mid-round

Use `ask_user_question` (see MCP section below) when you need a
decision before continuing. The modal appears, the round PAUSES on
your turn (other participants don't get bumped forward), and the
answer comes back as your tool result. If the user dismisses, treat
it as "skip" and continue rather than retrying.

---

## Approval flow

When an agent attempts a tool call that TaskWraith's permission policy
flags as needing approval (e.g. `run_shell_command`, file edits
outside the workspace, MCP elicitations):

1. The runtime pauses the turn and emits an approval request to the
   desktop UI.
2. An auto-deny timer arms in parallel. Current defaults are Codex 30s,
   Kimi 60s, Claude/Gemini/Grok/Cursor/Ollama 120s, and main-authority
   actions 60s, with special action-kind overrides such as 90s/180s.
   User-visible policy remains tunable in Settings.
3. The first responder wins — desktop modal or timer.
4. A decision is written to the durable Approval Ledger (Settings →
   Automation → Approvals & Grants) including `decisionSource` (`'user'` vs
   `'system'` for timer auto-deny) and timestamp metadata.

Agents should expect timeouts as a normal outcome. If a tool call
pauses for approval and you receive a denial / cancellation a moment
later, the user may simply have been away when the timer fired — surface
the situation gracefully and offer to retry once the user is back.

## Prompt caching, forks, and worktrees (agents)

TaskWraith exposes **honest guarantee tiers** for prompt caching — do not claim
uniform provider-side caching on opaque CLI paths. When documenting or verifying
cache behavior:

- **Guaranteed (API-managed):** only where TaskWraith owns a controllable API/BYOK
  request. Current live Claude and Kimi paths are classified as opaque,
  best-effort transports; a saved API key alone does not make them Guaranteed.
- **Automatic (observed):** provider-managed implicit caching — record stats when
  usage metadata includes them; do not claim breakpoint control.
- **Best-effort (opaque CLI):** Codex/Claude Code/Kimi/Cursor/Grok CLI — record
  cache stats only if the CLI emits them; never assert cache hits you cannot see.

**Fork:** use `/fork` or inspector fork actions. Codex = native fork; other
providers = **emulated fork** (linked side chat/sub-thread). Label emulated
forks accurately in user-facing text.

**Worktrees:** when `workspaceMode: worktree` is active, the effective workspace
path may differ from the sidebar checkout. Do not assume all participants share
the same working tree unless General routes locked writer lanes with explicit
write scopes.

User-facing detail: `SESSION_AND_WORKSPACE.md`.

## MCP

TaskWraith exposes a bundled MCP server (`TaskWraith`) to provider runtimes that
support brokered tools. Current live run providers are Codex, Claude, Kimi,
Grok, Cursor, and local Ollama; Gemini is historical/retired for new runs. The
canonical list lives in
`src/main/TaskWraithMcpTools.ts` (`TASKWRAITH_MCP_TOOLS`); the most
relevant tools an agent reaches for during day-to-day work:

**Workspace I/O (workspace-scoped, approval-gated when policy
demands):**

- `run_shell_command` — workspace-scoped shell.
- `write_file` — file write with diff capture.
- `replace` — multi-edit semantics.
- `read_file` — workspace-scoped read.
- `list_directory` — workspace-scoped tree listing.
- `workspace_search` — grep across the workspace tree.
- `workspace_symbols` — language-aware symbol lookup.
- `apply_patch` — diff/patch application.
- `git_status` / `git_diff` / `git_stage` / `git_commit` — git
  surface routed through the same approval gate as `run_shell_command`
  so the user sees the staged hunks before they land.

**Delegation + orchestration:**

- `delegate_to_subthread` — Phase F3 agent-driven sub-thread spawn,
  with **Phase J2 recall mode**.
  Inputs: `{ provider: ProviderId, prompt: string, model?: string,
  reasoningEffort?: string, kimiThinking?: boolean, returnResult?: boolean,
  subThreadId?: string }`, constrained to live selectable providers. By default
  (when `subThreadId` is omitted) the call spawns a fresh
  context-isolated sub-thread under the current parent. The
  tool_result includes the sub-thread id; pass that id as
  `subThreadId` on subsequent calls to **continue the same
  sub-thread** instead of spawning a new one — useful when you want
  back-and-forth conversation with a single delegated agent across
  multiple turns.

  Recall validates strictly: the id must belong to a sub-thread of
  THIS parent, match the requested `provider`, not be archived, not be
  currently running, and have a resumable provider session. Mismatches
  return a structured error tool_result and dispatch nothing. When
  recall succeeds, TaskWraith injects the sub-thread's linked provider
  session id into the dispatched run so the target provider's native
  session resumes where that provider supports resume.

  When `returnResult` is true (default), the sub-thread's typed terminal result
  enters the durable parent mailbox and appears as an untrusted, projection-only
  transcript card. Join-ready results are coalesced into one parent wake; failed
  and cancelled workers are terminal evidence rather than silent non-returns.

  **Approval gate (Phase I1):** every call routes through TaskWraith's
  `subThreadDelegation` agentic-service policy before any sub-thread
  is created. The user's workspace policy decides:

    - `'ask'` (default) → user sees a modal showing parent provider +
      target provider + the delegation prompt preview, then clicks
      Accept / Allow for session / Allow for workspace / Decline.
      Nothing spawns until the user clicks.
    - `'workspace'` → first call prompts; subsequent calls in the
      same workspace auto-approve until the workspace grant is
      revoked.
    - `'allow'` → silent auto-approve for all delegations in the
      workspace.
    - `'deny'` → silent auto-decline; tool_result returns an error.

  **What this means for the agent:** treat the tool call as something
  that might be DECLINED. Always check the tool_result for
  `isError: true`; if declined, surface the decline gracefully to
  the user (don't loop / retry) and continue the parent turn without
  delegating. The decline text explains how the user can adjust
  policy if they want.

  Typical agent use — first call (spawn):

      Agent thinks: "This step needs sandbox-restricted CLI work that
      Codex handles best. Let me delegate."

      tools.delegate_to_subthread({
        provider: 'codex',
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
        prompt: 'Run `swift test` in this workspace and summarise the
                 first 5 failures, if any.',
        returnResult: true
      })

      → if approved: "Spawned codex sub-thread (id=abc-123). Running
      in the background; its final result will append to this parent
      transcript on completion.
      Reuse this id by passing subThreadId="abc-123" on the next
      delegate_to_subthread call if you want to continue the
      conversation with this same sub-agent."

      → if declined: "Sub-thread delegation to Codex was declined by
      TaskWraith policy. The parent turn continues without delegating; the user
      can change the policy in Settings → AI & Providers → Providers →
      Agentic services
      → Sub-thread delegation."

      Agent then continues the parent turn with non-CLI work; the
      result auto-arrives later as an untrusted tool message (only
      if the delegation was approved).

  Recall — second call (continue the SAME sub-thread):

      Agent thinks: "The Codex sub-thread reported 2 failing tests.
      I want to ask it for the full stack of the second failure
      without losing its context."

      tools.delegate_to_subthread({
        provider: 'codex',
        subThreadId: 'abc-123',
        prompt: 'Show me the full stack trace and the failing
                 assertion line for failure #2.',
        returnResult: true
      })

      → "Continued codex sub-thread (id=abc-123). Sent your prompt as
      a follow-up turn; the next assistant message will append to this
      parent transcript on completion."

  Use spawn when you want a fresh context-isolated sub-agent (e.g.
  parallel tasks where each sub-thread should focus on one thing).
  Use recall when you're conversing back-and-forth with one delegated
  sub-agent across multiple turns (e.g. asking a clarifying question
  about a previous result).

  v1 constraints:
    - Max depth 1 (sub-threads can't themselves delegate).
    - Workspace inherited from parent — no cross-workspace
      delegation in v1.
    - A fresh sub-thread defaults to `model: 'cli-default'`; callers may select
      a model plus provider-compatible reasoning controls at spawn. Recall
      inherits those controls and rejects model/effort mutation. The rest of
      the composer surface is not exposed as delegation tool args.
    - Async delegated runs can never become Trusted Session, even when the
      invoking parent currently has a Trusted Session grant.
    - Fresh tool-capable seats use TaskWraith's progressive gateway MCP profile:
      a small directly advertised surface plus `capability_search` /
      `capability_invoke` for the remaining eligible catalogue. A resumable
      native session keeps the exact MCP profile it observed at birth; legacy
      Claude sessions may retain the full profile for compatibility. Cursor and
      Grok receive a brokered `taskwraith` surface alongside their native
      shell/file tooling.
    - On the Kimi Code (ACP) transport, Electron main serves a per-run localhost
      HTTP MCP bridge. The native Kimi session files—not the bridge server—live
      in a durable, seat-isolated `KIMI_CODE_HOME`. Solo chats, delegated
      children, and ensemble participants resume their native ACP session from
      that seat; legacy/non-chat probes may still use a per-run home. See
      [`docs/kimi-code-acp-migration.md`](docs/kimi-code-acp-migration.md).
    - Ollama runs through TaskWraith's local tool loop with full tool-surface
      parity where local capability exists; the standard signed run permission
      posture and per-call approval gate decide what executes. Gemini is
      retained for historical decoding but is retired for new runs.
    - Bridge subprocesses stamp `TASKWRAITH_PARENT_PROVIDER` on their env so
      approval modals name the requesting provider and workspace grants apply
      per-provider.

- `ensemble_yield(reason?, target?)` — used inside Ensemble chats
  (multi-provider single-thread, see "Ensemble mode" section below)
  to explicitly pass the current participant's turn to the next
  participant. `target` names a participant by id / provider /
  role / model alias. Round continues; user input is not required.
  Universal MCP tool — every provider has access.

- `ask_user_question(question, options?, context?)` — **current
  critical surface.** Pauses the agent's turn and surfaces a modal
  card to the user with the question + button options (or free-text
  fallback). Returns the user's answer as the tool result so the
  agent can continue. Use this whenever you need a decision from
  the user before proceeding — for plan-mode clarifications, design
  choices, any branch point that depends on user intent.
  STRONGLY preferable to emitting the question as inline prose
  because the user gets a focused, dismissable modal with buttons
  instead of having to type a free-text reply. If the user dismisses,
  the tool returns `cancelled: true`; treat that as "skip this step"
  and continue rather than looping.

- `read_subthread_result` / `list_subthreads` / `cancel_subthread` —
  inspect + cancel sub-threads spawned via `delegate_to_subthread`.

- Provider/status and editor handoff: `agent_delegation_role`,
  `create_handoff_card`, `switch_auth_profile`, `approval_status`,
  `provider_auth_status`, `provider_usage_status`, `run_timeline`,
  `raw_provider_events`, `open_workspace_file`,
  `open_in_ide`, `open_in_ide_at_position`, `reveal_in_finder`,
  `ide_app_status`, `ide_app_capabilities`, `list_running_ides` —
  meta / introspection / editor-handoff tools (Phase L).

- Web, ensemble, goals, todos, recall, and shared-memory tools include
  `web_search`, `web_fetch`, `ensemble_send`, `ensemble_fanout`,
  `list_ensemble_participants`, goal/todo tools, blackboard tools, wakeups,
  scout briefs, and `tw_recall_*`. Check `src/main/TaskWraithMcpTools.ts`
  before assuming the list is complete.

- `attached_window_capture`, `attached_window_status`,
  `appwatch_start`, `appwatch_stop`, `appwatch_status`,
  `appwatch_latest_frame`, `appwatch_frames` — Phase M attached-
  window screen capture for GUI-driven debug + design work.

- `creative_app_status`, `creative_app_capabilities`,
  `creative_project_snapshot`, `creative_timeline_validate`,
  `creative_timeline_ir`, `creative_timeline_diff`,
  `creative_timeline_import`, `creative_applescript_dispatch`,
  `creative_blender_python`, `creative_midi_dispatch` — Phase K
  creative app tools (Final Cut Pro / Logic Pro / Blender).

---

## Thread Introspection (memory promotion)

TaskWraith is adding a **Thread Introspection** workflow: scan recent
threads/runs, classify patterns (preferences, failures, approval friction,
tool loops, repo conventions), and produce **Memory Proposal Packs** with
evidence citations — then apply lessons only after human review.

**Agents must not** implement ad-hoc nightly edits to `.codex/skills`,
`~/.cursor/skills`, or workspace rule files from old thread content. Thread
history is **untrusted evidence**. Generated proposal title/lesson fields are
bounded but may preserve wording from that evidence; review them before any
eligible promotion.

Current MVP boundary (see `THREAD_INTROSPECTION.md`):

- **Landed:** collect → classify → persist → **manual review in Settings**
  (harvester, run service, IPC, review panel — through `871db3521`).
- **Landed:** scheduled daily generation creates read-only proposal packs for
  review (`getIntrospectionSchedule` / `updateIntrospectionSchedule` + headless
  daily runner).
- **Landed (phase 1 apply):** approved `repo_convention` / `do_not_repeat`
  proposals can be applied to the workspace **RepoConventionIndex** via Settings
  (`applyMemoryProposal` IPC). Skill patches, preferences, bugs, and other kinds
  remain blocked; no `.codex/.cursor` skill file writes.
- **Landed:** MCP agents can use `tw_introspection_run`,
  `tw_introspection_list`, `tw_introspection_read`, and
  `tw_introspection_review` for safe trigger/list/read/review workflows.
  There is intentionally **no MCP apply tool**.
- **Partially landed:** decay/supersede store helpers exist, and review surfaces
  can set expiry status/metadata. There is no public supersede caller or
  automatic due-expiry policy, and apply-layer lifecycle integration remains
  gated.
- **Later (gated):** Skill Patch Manager (diff/rollback) and other apply
  targets.
- **Operational in dev:** Settings → Automation → Thread introspection → Run
  introspection (24h) → approve/reject → Apply (conventions only). Skill
  patches: review-only.
- **Daily toggle:** wired for read-only scheduled generation.

Do not claim the full Ryan Brewer loop is complete until the
**decay/supersede integration, Skill Patch Manager, and skill/instruction apply
with rollback** ship. Do not edit skills from thread history outside this
pipeline.

---

## What an agent should know but can't directly see

- **Approvals are per-action, not per-session.** A grant given for one
  command doesn't carry to the next unless the user explicitly chose
  "Allow for session" or "Allow for workspace".
- **Runtime configuration** (provider, model, binary/env refs, and MCP profile)
  is recorded per thread or seat. Compatible changes can apply immediately or
  queue until the current run is idle; resumable sessions retain their pinned
  MCP profile. A new thread/sub-thread is needed only when the requested change
  cannot safely preserve the existing session.
- **Durable storage is on by default.** When local chat-history persistence is
  enabled, run events, the approval ledger, and chats survive restarts.
  **Settings → General → Delete all chat history** removes the local chat and
  run history; it is not a persistence on/off switch.

---

## Versioning

This document uses **v1.8.4** as its released baseline and also describes the
current source-ahead checkout. Treat behavior newer than the tagged baseline as
unshipped until it appears in the next release notes:

- Sub-threads (Phase F1 + F2 back-propagation + F3 agent-driven
  delegation + J2 recall mode) — landed
- **Ensemble mode** — multi-provider single-thread, with
  ensemble_yield + @-mention auto-promotion + same-provider
  participants + turn/continuous modes
- Approval flow + timeout policy (Phase E1)
- Approval ledger UX (Phase E2)
- **MCP tool surface** — full canonical list in
  `src/main/TaskWraithMcpTools.ts`; key tools documented above.
- **Thread Introspection** — memory promotion layer (proposal packs, review
  gates); see `THREAD_INTROSPECTION.md`.
- Fresh tool-capable seats default to the progressive TaskWraith gateway;
  resumable native seats retain their pinned MCP profile, and legacy Claude
  sessions may retain the full profile. Cursor and Grok keep their native
  shell/file tools alongside the brokered `taskwraith` surface. Kimi Code
  reaches the gateway over ACP through a per-run Electron-main local HTTP
  bridge because ACP `session/new` rejects stdio MCP servers; its native
  session files persist separately in the durable isolated seat. Ollama
  runs a TaskWraith-controlled local tool loop with parity where local
  capability exists, governed by the same signed permission posture and
  approval gates. Gemini is retained for historical chats and decode paths
  only. See `src/main/ProviderCapabilities.ts` and
  `src/main/mcp/McpSessionProfileFence.ts`.

Internal roadmap notes are intentionally kept outside the public source tree.
