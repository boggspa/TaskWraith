# Delegation and Ensemble doctrine

Read this file in full before sub-thread delegation or recall, asynchronous child coordination, Ensemble participation, fan-out or background lanes, yields, mentions, or mid-round user questions.

## Sub-Threads (Phase F1) — isolated delegation

TaskWraith supports **sub-threads**: a thread can spawn child threads
that run on the same or a different provider while remaining topologically
linked under the parent in the workspace tree.

Cross-provider orchestration is a common use, but a same-provider child is also
useful when parallel work needs a fresh context and an independently resumable
session. Common patterns:

- A long-context **Claude** thread hands the noisy CLI work off to a
  **Codex** sub-thread, then continues planning while Codex runs.
- A **Kimi** project-aware thread delegates a careful diff edit to a **Claude**
  sub-thread.
- A **Codex** runtime delegates "research this codebase" reading work to a
  **Claude** or **Kimi** sub-thread.
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

Sub-threads do **not** share provider context with their parent — each is its
own isolated provider session. Only explicit delegation/recall prompts and the
governed result-return path cross that boundary.

### Phase F1 invariants (still in force)

- **Max depth = 1.** A sub-thread cannot itself spawn a sub-thread.
  Enforced twice, independently: `AppStore.createSubThread` throws when the
  parent is itself a sub-thread (`src/main/store/index.ts`), and the
  `delegate_to_subthread` tool rejects the same case before it gets there
  (`src/main/index.ts`). Note the UI affordance is **not** hidden — the
  sidebar "Delegate to a sub-thread" menu item is offered on sub-threads
  too, so a user who picks it gets the store's error rather than an absent
  option. Future revs will lift the depth limit with ladder semantics.
- **Workspace inheritance.** Sub-threads default to the parent's
  workspace. Users can override per-spawn (future UI), but the data
  model already supports it via the optional `workspaceId` /
  `workspacePath` overrides on `AppStore.createSubThread`.

### Phase F2 — auto-propagation of sub-thread results

When `returnResultToParent: true` was selected, every terminal child outcome
(`done`, `requires_action`, `failed`, or `cancelled`) is first persisted in the
parent's durable mailbox. A projection-only synthetic `role: 'tool'` message is
appended to the parent transcript for UI/audit visibility. For a solo parent,
the mailbox delivers the result to provider context exactly once, through an
auto-wake or the next ordinary parent turn. Ensemble parents currently retain
the mailbox event and transcript card but do **not** automatically inject it
into any participant seat's provider context; this limitation existed in v1.8.4;
v1.8.5 added Ensemble mailbox drain into the idle authority seat (see
`CHANGELOG.md`), while broader auto-injection nuances may still evolve
source-ahead.

```
↩ Result from <Provider> sub-thread (<title>):

<typed terminal result, including assistant output when present>
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

This MCP route is available only to tool-capable parent seats (Codex, Claude,
Kimi, Cursor, Grok, Ollama when admitted). A Path-B Cursor turn receives the
gateway when its TaskWraith-owned broker starts successfully and can then call
`delegate_to_subthread`; if broker setup fails, TaskWraith posts a visible
warning and that turn degrades to native-only operation. Any tool-capable parent
can still spawn or recall a Cursor child sub-thread.

`model`, `reasoningEffort`, and `kimiThinking` configure a **fresh** delegated
seat. They are spawn-only: recalls inherit the existing seat controls and reject
attempts to change them, preserving the provider session and cache continuity.
TaskWraith-owned orchestration assigns a durable join policy to returned
results. Delegations from one parent run share a join group; required workers
gate quorum, optional workers do not, and the bounded debounce produces one
coalesced parent wake. These controls remain internal so the advertised MCP
catalogue and seat prompt prefix stay stable. Async delegated runs inherit a
capped permission posture but never inherit Full Access.

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
sub-threads which are isolated). Each chat can have up to 50 named
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

This explicit call requires a tool-capable seat. Broker-active managed Cursor
seats are tool-capable and can call `ensemble_yield`; a Cursor turn that visibly
degraded to native-only operation must instead use @-mention routing from a
tool-capable peer or ordinary turn order. Pi is not a generic MCP seat, but an
Ensemble Pi lane with a visible verified coordination receipt can call its fixed
`ensemble_yield` tool; a Pi lane without that receipt must use unique @-mention
routing instead.

### 3. You can call another participant in-line via @-mention

If your assistant message contains `@Role` / `@provider` / `@ModelName`
references, TaskWraith resolves every unique mention and applies the routable
targets in prompt order. Unambiguous participants that have not spoken are
promoted together to the front of the remaining queue. An ambiguous alias is
skipped with a warning, and self-mentions are filtered (you can narrate "I,
Codex, think…" without looping yourself back to the front).

In Continuous mode, mentioning an ordinary participant that already reached a
terminal status does not re-summon it. The active authority is the exception:
the Boss—or the Captain once the Boss is unavailable—may be re-summoned after
answering or yielding, subject to the continuation budget. If that active
authority appears alongside advisory participant mentions, only the authority
route is applied.

```
"@Reviewer can you sanity-check this diff before I commit?"
→ Reviewer participant gets the next turn.
```

This is the lower-friction way to invite collaboration — yield is
explicit, mention is conversational.

This in-round handoff rule is distinct from directing a new user/composer
round. In the current source-ahead checkout, Electron main is authoritative for
new-round routing: it validates an exact participant link inserted by the
picker, or resolves a plain alias against the current enabled roster. A
hand-typed provider/role/model alias that matches multiple seats is rejected
rather than selecting whichever participant happens to appear first. The
renderer may send an advisory participant id for explicit UI gestures, but it
cannot override a prompt routing signal. This main-authoritative change shipped
in v1.9.0 and is part of the current v1.9.5 release baseline described under
[Versioning](INTROSPECTION_AND_RELEASE_STATE.md#versioning).

### Stage roles and background lanes

The participant Stage control has five choices: **Any**, **Scout**, **Work**,
**Review**, and **BG**. Scout/Work/Review shape the foreground waves. A BG
participant is different: it receives no ordinary serial or review turn and
runs only when explicitly delegated.

- A unique `@Background`, `@Role`, or `@Model` mention attempts to launch that
  participant in a detached lane while foreground rotation continues.
  Concurrent lanes must be enabled, the seat must not already be active, and
  admission/budget checks must pass.
- **`@BG` is no longer one of those — it is a roster GROUP token** (source-ahead
  of v1.9.5). `src/shared/ensembleGroupMention.ts` defines five provider-neutral
  group tokens that address a whole stage at once: `@All` (every enabled
  participant), `@Scouts`, `@Workers`, `@Reviewers`, and `@BG` (every enabled
  background seat). `findAllMentions` tests the first word against the group
  table **before** any per-participant alias resolution
  (`EnsembleMentionAlias.ts`), so bare `@BG` now expands to every enabled BG
  seat and **can no longer be ambiguous** — the previous "rejected as ambiguous
  when more than one BG seat matches" behaviour is gone.
- **`@BG` and `@Background` are no longer equivalent.** Only `bg` is registered
  as a group alias; `@Background` still resolves through the ordinary
  per-participant alias path and can still fail closed as ambiguous with
  multiple BG seats. Do not treat the two as interchangeable in prose or tests.
- Group tokens are fail-closed for assistants, not for users. A user may always
  use one. A participant that writes a group token mid-round only fans out if it
  holds Boss/Captain fan-out authority; otherwise the orchestrator appends a
  round-status notice and no turns
  (`EnsembleGroupMentionRouting.ts`). The `ensemble_send` tool path is
  deliberately different again — it accepts group tokens as recipient selectors
  under the tool's existing any-active-seat communication policy, without the
  Boss/Captain gate.
- Mention/yield launches are always capped to read-only posture. Scoped
  mutations must use the existing Boss- or Captain-authorized
  `ensemble_fanout(mode=locked_writers, targetStage=backgrounds,
writeScopes=...)` path.
- BG lanes never inherit Full Access and cannot own Boss, Captain, Work
  Session lead/manager, synthesizer, or broad fan-out authority.
- Normal completion waits for live/reserved BG lanes. Cancellation and failure
  preserve the terminal fast-close semantics and stop those lanes immediately.

### Turn-bound vs Continuous mode

Each ensemble has a `orchestrationMode`:

- **Turn-bound** (default) — each enabled participant speaks ONCE
  per round. After everyone speaks, the round ends and the user
  is prompted for the next user turn. Beyond this, participants tagging each other (after all participants' contributions complete or round 1 over, etc.) then offers turns (in addition to existing fan-out and yield).
- **Continuous** — after the roster drains, TaskWraith can autonomously run
  another pass even when nobody explicitly yielded or mentioned a peer. Every
  admitted continuation turn consumes the `maxContinuationHops` budget
  (default 6). The loop stops on an explicit `ensemble_yield(target: 'user')`,
  user cancellation, goal completion/block/pause, a queued user prompt or seat
  change, no progress/administrative deadlock, or budget exhaustion.
- **A bounded final synthesis turn may be inserted immediately before the loop
  actually stops** (source-ahead of v1.9.5). When a synthesizer is elected —
  configured seat, else Boss, else Captain, else the last enabled foreground
  participant — and two or more participants answered or yielded without a
  structured convergence summary being captured, the orchestrator dispatches one
  extra restricted turn before ending the round, whatever the stop cause. It is
  exactly-once (guarded by a durable `synthesisAttemptedAt`), forbidden from new
  work, tools, fan-out, yield or delegation, and must answer in the fixed
  `Round summary:` / `Decisions:` / `Corrections:` / `Open risks:` /
  `Next action:` shape. See `EnsembleSynthesisLifecycle.ts`.
- Consequence worth knowing: `disagreement-unresolved` was advisory and
  explicitly excluded from failure surfacing; it is now a real completion
  blocker titled "Synthesis unresolved". A _configured_ synthesizer no longer
  suppresses the signal — only a _captured_ summary does.

The user picks the mode via the composer's Turn / Continuous chip.
If the round is currently running, the toggle reflects the active
round's mode (not editable mid-round).

### Same-provider participants

Ensembles can include MULTIPLE participants of the same provider
running DIFFERENT models — e.g. one `claude-sonnet-4-7` + one
`claude-opus-4-7` working alongside each other. Each has a stable
participant id, so the orchestrator can dispatch them independently.
This is why the model-name @-tagging (above) matters: when those aliases are
unique, `@Sonnet 4.7` disambiguates from `@Opus 4.7` even though both are
Claude. Use the participant picker when aliases collide; its structured link
preserves the exact participant id.

### Asking the user mid-round

Use `ask_user_question` (see [MCP](RUNTIME_AND_TOOLS.md#mcp)) when you need a
decision before continuing. The modal appears, the round PAUSES on
your turn (other participants don't get bumped forward), and the
answer comes back as your tool result. If the user dismisses, treat
it as "skip" and continue rather than retrying.

Broker-active managed Cursor seats can call this tool under the same host
policy as other gateway seats. A Cursor turn that visibly degraded to
native-only operation cannot, so use another tool-capable seat in that case.

---
