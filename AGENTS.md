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

## Sub-Threads (Phase F1) — multi-provider delegation

TaskWraith supports **sub-threads**: a thread can spawn child threads
that run on a *different* provider while remaining topologically linked
under the parent in the workspace tree.

The intent is cross-provider orchestration. Common patterns:

- A long-context **Claude** thread hands the noisy CLI work off to a
  **Codex** sub-thread, then continues planning while Codex runs.
- A **Kimi** or **Cursor** project-aware thread delegates a careful diff edit to
  a **Claude** sub-thread.
- A **Codex** runtime delegates "research this codebase" reading work
  to a **Claude**, **Kimi**, or **Cursor** sub-thread.

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

When `returnResultToParent: true` was selected at spawn time AND the
sub-thread's run completes successfully, the sub-thread's final
assistant message is automatically appended to the parent transcript
as an untrusted synthetic `role: 'tool'` ChatMessage with:

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

The trigger is the run-completion event from `RunManager.onChange`.
Failed or cancelled sub-thread runs don't propagate (the parent
agent should infer "no answer came back" and respond accordingly).

A `subthread_returned` durable run-event is written under the
**parent** chat for audit.

### How a parent-thread agent should think about delegation

Agents can request delegation with
`delegate_to_subthread({ provider, prompt, returnResult, subThreadId? })`.
That request is approval-gated by the current workspace's agentic-service
policy. Treat the tool result as fallible: if policy declines or recall fails,
do not loop or retry; continue the parent turn and tell the user what was
declined.

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
   Approval Ledger) including `decisionSource` (`'user'` vs
   `'system'` for timer auto-deny) and timestamp metadata.

Agents should expect timeouts as a normal outcome. If a tool call
pauses for approval and you receive a denial / cancellation a moment
later, the user may simply have been away when the timer fired — surface
the situation gracefully and offer to retry once the user is back.

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
  Inputs: `{ provider: ProviderId, prompt: string, returnResult?: boolean,
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

  When `returnResult` is true (default), the sub-thread's final
  assistant message auto-appends to the parent transcript on
  completion as untrusted child output (Phase F2 back-propagation) —
  works for both spawn and recall paths.

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
      can change the policy in Settings → Behavior → Agentic Services
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
    - The sub-thread runs with `approvalMode: 'default'` and
      `model: 'cli-default'`. Future revs may expose the full
      composer surface as additional tool args.
    - Codex, Claude, and Kimi register the full TaskWraith MCP surface with
      their native runtimes where available. Cursor and Grok receive a brokered
      `taskwraith` MCP surface alongside their native shell/file tooling.
      Ollama runs through TaskWraith's local tool loop with full tool-surface
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

## What an agent should know but can't directly see

- **Approvals are per-action, not per-session.** A grant given for one
  command doesn't carry to the next unless the user explicitly chose
  "Allow for session" or "Allow for workspace".
- **The runtime profile** (binary path, env, MCP profile) is per-thread
  state set at thread creation. If a user wants to change runtime, they
  spawn a new thread or sub-thread.
- **Durable storage is on.** Settings → Behavior controls whether chat
  history is persisted to disk; if it is, the run events, approval
  ledger, and chats survive restarts.

---

## Versioning

This document is updated as features ship. Sections currently documented (as of
**1.7.0**):

- Sub-threads (Phase F1 + F2 back-propagation + F3 agent-driven
  delegation + J2 recall mode) — landed
- **Ensemble mode** — multi-provider single-thread, with
  ensemble_yield + @-mention auto-promotion + same-provider
  participants + turn/continuous modes
- Approval flow + timeout policy (Phase E1)
- Approval ledger UX (Phase E2)
- **MCP tool surface** — full canonical list in
  `src/main/TaskWraithMcpTools.ts`; key tools documented above.
- Codex / Claude / Kimi share the full brokered MCP tool surface. Cursor and
  Grok get a brokered `taskwraith` MCP server but keep their native shell/file
  tools. Ollama runs a TaskWraith-controlled local tool loop with full
  tool-surface parity where local capability exists, governed by the same signed
  permission posture and approval gates rather than a safety-tier subset. Gemini
  is retained for historical chats and decode paths only. See
  `ProviderCapabilities.ts`.

Internal roadmap notes are intentionally kept outside the public source tree.
