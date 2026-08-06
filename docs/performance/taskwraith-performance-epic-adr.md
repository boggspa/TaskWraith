# ADR: TaskWraith Massive Performance Fix Epic

**Status:** Accepted (Execution Gate 1 — closed executable freeze)
**Date:** 2026-08-03
**Author lane:** GrokWork1 (isolated worktree; docs only)
**Candidate (pre-amendment):** `71c30f5a7248051ff77b47d7a6e523a5b4aaac98`
**Boss amendment reference:** blackboard decision `perf-epic-adr-boss-amendments-v1` (CodexBoss)
**Reviewer must-fixes folded:** Captain ledger `perf-epic-ledger-v2-reviewer-must-fixes`
**Authority:** CodexBoss (architecture / integration), KimizCaptain (ownership matrix / acceptance ledger)
**Baseline HEAD at first authoring:** `7333281329c95d793638e43286540fe727050839`
**Live product (do not touch):** v1.9.2 running app + its userData

---

## 1. Context and problem statement

TaskWraith must remain genuinely responsive under sustained **30–50-seat** ensemble pressure, multiple concurrent real runs, **6k–20k** transcript rows, **5k–15k** tool events, and **200–700** historical runs. Observed production pressure (mission brief + scout recon on current HEAD):

| Signal | Observation |
| --- | --- |
| Electron subtree | ~6.8 GB |
| Renderer physical | ~4.4 GB |
| Main peak | ~2.2 GB |
| CPU | main 74–118%; renderer bursts ~209%; GPU 40–53% |
| Hot chat | ~16.4 MB / ~6.8k messages; ~5,933 tool rows ≈ 10.9 MB |
| Global index | `chat-list-index.json` ~7.2 MB |
| Checkpoints | `session-checkpoints.json` ~20.3 MB; ~493/508 records superseded |
| Rewrite cadence (10 s window) | hot chat 8–14×; index/checkpoint 13–14× |

Scouts confirm the suspects are **still present on HEAD**. Partial mitigations exist (message-splice IPC, per-chat 250 ms flush, historical tool compaction, chat-record cache, chat-list-index mtime+size read cache + readEntry(chatId), flag-discriminated lean ensemble in index entries, virtualization prefix reuse). None breaks the **whole-document rewrite amplification DAG**.

### Non-negotiable safety (epic invariants)

1. Never quit/restart/kill/mutate the live TaskWraith app or its userData; never attach disruptive tooling to it.
2. Benchmark only isolated dev builds with isolated userData and deterministic generated/sanitized replay.
3. Preserve every capability: providers, seats, permissions, scheduling, audit history, raw-detail export, cinematic visuals, iOS/bridge/popout, 50-seat ceiling. No silent quality reduction, history truncation, or capability gating.
4. Preserve transcript order, identities, terminal state, approvals, trust boundaries, crash recovery, history-deletion semantics.
5. Follow AGENTS.md concurrency: status/markers, worktrees, explicit-path/hunk staging; no repo-wide formatting.
6. Do **not** grow `src/main/index.ts`, `src/renderer/src/App.tsx`, or `src/main/services/EnsembleOrchestrator.ts` — extract modules; monoliths get minimal wiring only.
7. Every performance claim requires before/after profiles under the **same** deterministic replay.

---

## 2. Decision summary (executable freeze)

Boss freeze (this ADR codifies; amendment `perf-epic-adr-boss-amendments-v1`):

1. **Dual-read and crash-safe** migration with explicit authority states and reversible rollback.
2. **Durability-tiered** writes (not one barrier for all row kinds).
3. **Append-oriented** hot path: per-chat segmented framed JSON event journals + atomic compact snapshots; stop per-event whole-chat pretty JSON + fsync on the hot path.
4. **Reversible** — v1 readers remain loadable; cutover is explicit; soak rollback is first-class.
5. **Full raw-detail / export semantics preserved** while hot transcript becomes compact and incremental. **Authoritative raw is never capped or truncated**; projection caps apply only to hot/UI projections.
6. **No epic source work in the shared dirty checkout** — writer lanes use isolated worktrees only; candidates promote via Boss/Captain gates.
7. **S2 must not preserve v1 whole-file amplification on the hot path** — no per-D1 authoritative v1 dual-write (see §6).
8. **Official baselines** only from clean isolated worktrees with HEAD + tree fingerprint; dirty production-tree runs are diagnostic-only and non-authoritative.

This ADR is the closed execution gate. Production source tranches remain locked until Boss authorizes them after T1/T2 artifacts exist.

---

## 3. Current amplification DAG (confirmed HEAD)

```text
Ensemble participant / tool tick / fan-out seed
  └─ EnsembleOrchestrator.saveChatWithCheckpoint
       ├─ deps.saveChat → AppStore.saveChat
       │    ├─ normalizeChatRecord + compactChatForPersist
       │    ├─ writeJson(chats/<id>.json)   // pretty JSON + sync write + fsync + rename + dir fsync
       │    │    // ── Mitigation landed (item 6, dark): with TASKWRAITH_UTILITY_WRITE=1 + a
       │    │    //    registered writer, normal saves route serialize (~30ms, on main, in the
       │    │    //    queue) → enqueue → utility process (write+fsync+rename+dir-fsync, ~40ms
       │    │    //    off main). Uncontended barriers still write on main; contended barriers
       │    │    //    follow the queue (ordering). Flag off; no composition-root wiring yet.
       │    │    //    See §5.2 amendment.
       │    └─ writeChatListIndex           // whole chat-list-index.json when row changes
       ├─ persistSessionCheckpoint → SessionCheckpointStore.upsertFromChat
       │    └─ persistOrThrow               // JSON.stringify(entire this.records[])
       └─ broadcastChatUpdated
            └─ ChatUpdateDeliveryCoordinator
                 └─ snapshot | patch(record=full non-message ChatRecord + message splice)
                      └─ renderer ACK baseline retains full ChatRecord
                           └─ App hydration merge keeps previously hydrated full chats (no byte LRU)
                                └─ TranscriptPanel O(n) maps / filters / groups / projections
                                     └─ compositor FX layers (cinematic defaults) + timer fan-out
```

### Fan-in hubs (serialize writers — one owner per path set)

| Hub | Risk |
| --- | --- |
| `src/main/store/index.ts` | `writeJson`, `saveChat`, chat-list index |
| `src/main/index.ts` | `broadcastChatUpdated` / IPC registration |
| `src/renderer/src/App.tsx` | chat merge / hydration consumers |
| `src/main/services/EnsembleOrchestrator.ts` | `saveChatWithCheckpoint` callers — **extract only, do not grow** |

### Amplification model (ensemble)

| Layer | Cadence today | Coalescing |
| --- | --- | --- |
| Stream → transcript | 250 ms **per chat** `scheduleFlush` (was per seat; N lanes → one batched `saveChat`) | Per-chat coalescing; N× save multiplier removed |
| Working telemetry | 450 ms / run | Ephemeral IPC only (good — keep) |
| IPC delivery | ≥100 ms / chat + ACK | Latest-wins pending; still fed by full saves |
| Fan-out seed | 1 save per lane | None → N+1 full writes at dispatch |
| Checkpoints | Every save while round `running` | Full 20 MB array rewrite |
| Renderer save path | 200 ms debounce | **Bypassed** by main-side ensemble saves |

Steady-stream theoretical upper bound: up to **4N saves/s** (`N × 1000/250`). Fan-out is the cliff; serial turns hide the cliff.

---

## 4. Existing seams to extend (do not reinvent)

| Module | Role vs epic |
| --- | --- |
| `store/UsageJournalStore.ts` | **Best prototype** for journal + checkpoint + archive + compact + history-mutation hold + crash seams |
| `workLocks/NodeWorkspaceLockPersistence.ts` | Second WAL/JSONL durability pattern |
| `store/ChatCompaction.ts` | Partial: drops historical raw tool bytes on save; still whole-chat rewrite; irreversible for dropped raw |
| `shared/chatUpdateTransport.ts` + `ChatUpdateDeliveryCoordinator.ts` | Message splice + ACK/latest-wins; baselines still full `ChatRecord`; non-message `record` resent wholesale |
| `checkpoints/SessionCheckpoint.ts` | Isolated module; schema v1; whole-array rewrite |
| `renderer/.../chatHydrationMerge.ts`, `chatUpdateHydrationQueue.ts` | Hydration races; **no byte-bounded LRU** |
| `TranscriptVirtualWindow.ts` + incremental grouping | Extend; do not rip out |
| `RunEventStore` | Bounded forensic channel (`MAX_RUN_EVENT_*`); model for tool-detail stream metadata, **not** for truncating authoritative raw authority |
| `RemoteThreadProjection.ts` | Windowed + byte-budgeted iOS pattern (template for bounded projections) |
| `HistoryDeletionIntent` + `HISTORY_DELETION_STEPS` | Template for store-format upgrade transaction + ordered resurrection kill |
| `HostCommandReceiptStore` / `HostDeltaStore` | Truncate-tail tolerance, corrupt-line skip, compact-into-checkpoint |
| `ThreadWorktreeBindingPersistence.writeJsonAtomically` | Async atomic patch for main-owned fields — preserve strip-and-remerge |
| `.claude/skills/verify/SKILL.md` | Isolated Electron + CDP recipe (`TASKWRAITH_INSTANCE_ID`) |

---

## 5. Target architecture

### 5.1 Persistence — chat store v2 (append-oriented) — **FROZEN**

**Boss freeze #1:** v2 uses **per-chat segmented framed JSON event journals** + **atomic compact snapshots**. Prefer existing JS/fs crash patterns over a new native SQLite dependency.

Composed of:

1. **Manifest** — `chats/<chatId>/manifest.json` (or equivalent) with `formatVersion`, `persistenceRevision`, authority pointers, segment list, compaction generation, content hashes.
2. **Atomic compact snapshot** — non-append fields + logical transcript offset map / recent window; published transactionally with segment list.
3. **Journal / segments** — append-only **framed JSON** event segments for message appends, tool-activity projections, ensemble metadata deltas, run summary updates.
4. **Tool-detail / blob segments** — append-only **content-addressed** blob/detail segments with **checksums** for large/full raw tool bodies (see §5.7).
5. **Archive** — compacted closed segments; never on the hot rewrite path.

**v1 authority (legacy):** single `chats/<id>.json` pretty `ChatRecord` via `writeJson` (current behavior).

**v2 authority:** manifest + snapshot + journal segments + blob segments; logical `ChatRecord` is a **projection**, not the on-disk unit of write.

Dual-read is mandatory until Boss declares cutover complete (see §6).

### 5.2 Durability classes and ACK semantics — **FROZEN**

**Amendment (2026-08-06, item 6):** A utility-process durable write mitigation is landed dark behind `TASKWRAITH_UTILITY_WRITE=1` (`b745115a1`). For `normal` saves while enabled with a registered writer, the write+fsync+rename+dir-fsync tail (~40 ms of a ~70 ms large-chat save) moves off main into a long-lived queued utility process; serialize (~30 ms) stays on main by design (queue serializes the record on enqueue). Uncontended barriers remain synchronous on main; a barrier for a chat that already has a queued job routes through the queue (ordering over sync durability) and is not awaited at the seam. Today both gates are shut (flag off + zero production `registerPersistenceWriteEnqueue` callers), so every save — barrier and normal — still takes the synchronous `writeJson` path. Crash fallback drains the queue FIFO in the calling thread before killing the worker — the queue owns its own fallback; N callers never race independent fallback writes. This is a quick win that narrows the freeze window until v2 append-oriented persistence lands; it does **not** change the durability class definitions or ACK semantics below.

| Class | Examples | Durability barrier | Client/provider ACK meaning |
| --- | --- | --- | --- |
| **D0 ephemeral** | Working telemetry, typing/elapsed clocks, FX state | No disk | Never claim durable |
| **D1 soft stream** | Token deltas, partial assistant text, tool progress previews | Memory + coalesced journal append; fsync deferred | UI may show; crash may lose trailing unflushed window ≤ coalesce budget |
| **D2 user/terminal** | User messages, terminal run outcomes (`done`/`failed`/`cancelled`), explicit cancel; round-start / accept / terminal checkpoints | Journal append + **fsync** before durable ACK | Safe to treat as recovered after crash |
| **D3 approval / grant / trust** | Approvals, permission grants, Full Access edges, history-deletion intent | Existing ledger barriers **or** stronger; never behind soft coalesce | Must survive crash/restart; fail-closed if incomplete |
| **D4 export/audit raw** | Full tool raw, provider forensic payloads | Content-addressed detail/blob segments; not hot chat document | Lazy load; export assembles full ordered view; **authoritative bytes never truncated** |

**Boss freeze #4 — D1 coalescer initial policy:**

- Trailing window: **100 ms**
- Maximum latency: **500 ms**
- Single in-flight write; merge pending mutations
- **D2/D3 bypass** the D1 trailing window and **fsync before durable ACK**
- In-memory timeline flush (250 ms per chat; was per seat) **decouples** from durability: materialize transcript in RAM for UI; durability class decides disk
- `history-deletion-intent.json` remains **independent** of chat coalesce (D3)

**Hard merge condition for T3a:** crash-injection tests (UsageJournal-style) must prove ≤D1 budget loss only; approvals/user/terminal/checkpoint barriers never batch behind the soft window.

### 5.3 Journal / segment corruption and crash recovery

Copy proven patterns from `UsageJournalStore` and host delta stores:

| Failure | Recovery |
| --- | --- |
| Missing manifest | Fail closed for that chat → try v1 file dual-read; else surface recovery UI |
| Truncated final journal line | Skip tail (malformed-line count); retain prior good records |
| Corrupt segment mid-file | Isolate segment; load prior snapshot + earlier good segments; mark segment quarantined |
| Crash during compact | Compact is transactional: new snapshot generation + new segment list published atomically; old artifacts retired only after verify |
| Crash during migration window | Authority bit in manifest decides canonical; never merge silently across versions without revision check |
| `persistenceRevision` race | Main remains authority; lagging writers merge or reject; same invariant as today |
| Missing blob checksum | Fail that activity’s raw recoverability; surface visible expand error; do not invent bytes |

**Stable read:** identity (dev/ino) + multi-attempt read; refuse to act on torn snapshots.

### 5.4 History-deletion step ordering

Current ordered resurrection kill (`HISTORY_DELETION_STEPS`):

```text
scheduled-orchestration → workflow-run-history → run-queue → run-recovery
  → approval-ledger → message-feedback → sub-thread-mailboxes
  → thread-messages → run-events → run-artifacts → kimi-seat-state
  → chat-records → chat-list-index → project-membership
```

**v2 additions (insert before `chat-records` / alongside store erasure, never after commit of visible transcript erase):**

| New step (proposed ids) | Covers |
| --- | --- |
| `chat-tool-detail-streams` | Per-chat raw tool detail/blob segments |
| `chat-journal-segments` | Append segments + quarantines |
| `chat-store-manifests` | Manifests + hot snapshots |
| `session-checkpoint-hot` | Hot per-chat/round checkpoint files |
| `session-checkpoint-archive` | Archived superseded checkpoint shards |
| `chat-list-index-shards` | Per-chat list shards (see §5.5) — lean ensemble landed (flag-discriminated, ~5.3 KB); full per-chat shards remain T3c |

Contract unchanged: fsynced prepare → acquire holds → quiesce → commit steps → release; incomplete is resumable; startup fail-closed blocks recovery until erasure resumes cleanly.

Checkpoint fence (`isHistoryMutationBlocked`) and usage-journal holds remain load-bearing.

### 5.5 Minimal ChatListItem and hot/archive checkpoint layouts — **FROZEN**

#### Chat list — Boss freeze #2

**Chat list is one minimal JSON shard per chat; no full global-index rewrite on hot updates.**

Today: `ChatListItem extends ChatRecord` with `messages: []`, `runs: []`, `summaryOnly: true`, plus `runsSummary` — and a **lean** `ensemble` projection (~5.3 KB: participant identities + `activeRound`; instructions, `roundSummaries`, and `blackboard` omitted; discriminated by an explicit `__chatListProjection` flag on write). Legacy fat lines heal to lean on first compaction; flagged lean rows never re-trigger. Interim step toward the frozen `ensembleLite?` DTO below; full per-chat index shards remain T3c. — still spreads ensemble / goal / fat metadata into one multi-MB `chat-list-index.json`.

**Target minimal DTO (logical fields; exact TypeScript names freeze at implement):**

```text
ChatListItemV2 {
  appChatId, title, createdAt, updatedAt, workspaceId?, workspacePath?
  provider, model?, archived?, pinned?
  summaryOnly: true
  messageCount, runCount
  lastMessagePreview? (bounded chars)
  lastRunSummary? { id, status, provider, startedAt?, endedAt? }  // single, not all runs
  ensembleLite? { participantCount, orchestrationMode?, activeRoundStatus?, activeParticipantIds?[] }
  persistenceRevision, contentHash?
  searchText? (bounded; rebuilt offline or on structural save only)
}
```

**Must not** embed full participant instructions, full `activeRound.prompt`, full blackboard, full runs with diffs, or tool bodies.

Index write policy:

- One **per-chat shard** under a list index directory (or equivalent); structural changes update **that chat’s shard only**.
- Volatile-only (status ticks) → throttle ≥2 s **and** prefer in-memory sidebar patches without rewriting all shards.
- A slim directory/manifest may enumerate shard ids; it must not re-serialize every chat’s fat metadata on hot ticks.
- SQLite sidebar index remains **out of scope** unless a future Boss amendment reopens it after measurement proves shards insufficient.

#### Session checkpoints — Boss freeze #3

| Store | Contents | Write triggers |
| --- | --- | --- |
| **Hot** | **One full-fidelity resumable record per `(chatId, roundId)`** (status `available`) | **D2** at round-start, accept, terminal complete/cancel/fail; **not** every `participant-updated` |
| **Archive** | Terminal / `superseded` / accepted / dismissed history | **Append** outside the hot rewrite; never rewrite full history on hot upsert |

Hot checkpoint path requires **D2-equivalent fsync** before durable resume claims. Participant-tick mirrors (if any) are soft and must **never** be product-labeled as crash-safe resume.

Schema: introduce **v2** with dual-read of v1 array file; unknown future versions fail closed without silent data loss of v1.

### 5.6 IPC delta / version / hash model — **FROZEN**

**Boss freeze #5:** IPC v2 uses:

- Explicit **top-level field mask** plus **append / update / delete-by-id** transcript ops
- **Sub-revisions** and **hashes**
- Retain **one snapshot retry**
- **Byte backpressure**
- **No full `ChatRecord` ACK baselines**

Keep protocol module evolution dual-read with v1; extend wire shape rather than rewrite from zero.

| Piece | Target |
| --- | --- |
| Message path | Append/update/delete-by-id ops; keep prefix/suffix splice during dual-read if needed |
| Non-message `record` | **Stop** shipping full `Omit<ChatRecord,'messages'>` on every patch. Ship `recordDelta` + explicit `recordMask` + `recordHash` / `ensembleRevision` / `runsRevision` |
| Baseline retention | Compact baselines (hashes + last full snapshot generation only); **never** three full multi-MB ChatRecords per target |
| ACK | ACK validates applied revision + optional content hash; reject → **one** snapshot retry (anti-spin) |
| Backpressure | Keep minDeliveryIntervalMs ≈ 100, ackTimeoutMs ≈ 5s, maxTrackedChatsPerTarget; add **byte meters** |
| Stats | `statsForTarget` reports retained baseline **bytes** (ensemble/runs/tool projections), not only message lengths |

Renderer equality: prefer version/hash short-circuit over O(n) deep `messagesRenderEqual` when revisions match.

### 5.7 Raw tool-detail stream and lazy export — **FROZEN**

**Problem:** tool rows dominate (~66% of hot chat bytes). Live path inlines unbounded `parameters` / `rawUseEvent` / `rawResultEvent`; compaction skips latest/running runs — exactly when saves are hottest.

**Boss freeze #1 + #9 (raw authority):**

1. Hot `ChatMessage.toolActivities` hold **projections only**: ids, names, status, bounded summaries/previews, error flags, byte lengths, content hashes, optional thumbnails.
2. Full raw bodies live in **append-only content-addressed blob/detail segments with checksums** (per chat or per run).
3. **Projection caps never truncate authoritative raw.** RunEventStore-style `MAX_*` / `{ truncated, preview }` may appear on **hot projections or wire summaries only**, never as the sole durable authority for new data after T5.
4. UI expand / raw drawer **lazy-fetches** by activity id / content hash; failure must surface visibly (no permanent silent empty).
5. Export / bridge full markdown continues to use `buildChatMarkdownTranscript` semantics: assemble **complete ordered** transcript (journal + detail stream), never “last 24 projected rows.” Desktop 2M / bridge 750k char caps unchanged as product policy (honest `too-large`, not silent truncate).
6. Handoff/bridge markdown may still **omit** raw tool bodies as product scrubbing — that is **not** a performance win and is **not** fused with raw recoverability acceptance (see §7.3).
7. **Backfill (Boss #9):** recover surviving inline v1 and RunEventStore detail on read/idle with **coverage manifests**; never fabricate or silently label already-compacted legacy bytes as recovered.

### 5.8 Per-chat renderer store + byte LRU pin rules

**Decision:** Introduce external **per-chat transcript store(s)** so `App` chrome commits do not invalidate the full transcript derivation graph. `TranscriptPanel` memo must not key solely on `currentChat ===`.

**Byte-weighted LRU (renderer hydrated chats):**

| Pin class | Evictible to summary? |
| --- | --- |
| Active focused chat | No |
| Open side/multiview panes | No while pane open |
| Popout chats | No while popout alive |
| Queued approval / requires_action chats | No until resolved or user navigates away with explicit policy |
| Recently visited | Yes — demote to `summaryOnly` projection; disk/journal remains source of truth |
| Background list rows | Always summary |

**Eviction:** demote in-memory to summary (keep list DTO fields); drop `messages`/`runs` arrays from heap; re-hydrate on focus via getChat / segment read. **Never** delete durable history as an LRU side effect.

**Targets:** renderer RSS peak ≤ **1.5 GB** under 50-chat-switch soak; growth t=5m→t=60m **&lt;10%** with only current+pinned hydrated.

### 5.9 Composition-root extraction rules

| Monolith | Allowed change |
| --- | --- |
| `src/main/index.ts` | Import + register extracted modules only |
| `src/renderer/src/App.tsx` | Wire store hooks / providers; move logic to `app/` / `lib/` modules |
| `src/main/services/EnsembleOrchestrator.ts` | Extract save coalescer, batched fan-out seed, checkpoint throttle helpers to new files; orchestrator calls them |

New modules preferred under:

- `src/main/store/chatJournal/` (or `ChatJournal*.ts`)
- `src/main/checkpoints/` (hot/archive split)
- `src/main/ipc/` or existing delivery coordinator files
- `src/renderer/src/lib/` / `app/` for transcript store + LRU
- `scripts/perf/` for harness (T1 scaffold already uses this path)

---

## 6. Format authority: v1 / v2 dual-read and rollback states — **FROZEN**

**Boss freeze #6 (critical amendment):** migration **avoids per-D1 authoritative v1 dual-write**. The original S2 “write v1 authoritative on every soft stream” design would preserve the whole-file amplification this epic eliminates.

| State | Disk | Reader behavior | Writer behavior |
| --- | --- | --- | --- |
| **S0 Legacy-only** | v1 `chats/<id>.json` only | v1 | v1 `writeJson` |
| **S1 Dual-read** | v1 present; v2 optional incomplete | Prefer v2 if manifest `authority=v2` and verify ok; else v1 | Writers still v1 until migration job |
| **S2 Dark-write verify** | v1 remains **authority**; v2 dark-written and verified | Read **v1**; shadow v2 diagnostics | **Do not** rewrite full v1 on every D1 tick for dual-write. Soft stream (D1) goes to v2 segments / coalesced path only for dark verification; v1 authoritative updates only at existing v1 save points until cutover policy allows reduction. Prefer: D1 dark-write to v2 only; D2/D3 update v1 authority **and** v2; continuous full v1 rewrite for D1 is **forbidden** |
| **S3 Cutover** | `authority=v2`; v1 retained as rollback material | Read v2 | Write **v2 only**; emit **v1 compatibility snapshots only at D2 / terminal / idle** plus an **explicit rollback materializer** (not per-token) |
| **S4 Rollback** | Flip `authority=v1`; stop v2 writers | Read v1 | Resume v1; quarantine v2 for forensics |
| **S5 Retire v1** | After Boss gate + N soak releases | v2 only | v2 only |

**Rules:**

- Never authorize launches / grants from a half-migrated store (mirror ScheduledOccurrenceSeal fail-closed precedent).
- Shadow/dark-write **divergence blocks cutover** — hard fail, not a buried log warning.
- Feature flag + manifest authority bit; user-visible recovery if both corrupt.
- S3 compatibility snapshots must not reintroduce 4N whole-chat fsyncs under continuous fan-out.

---

## 7. Deterministic baseline / after measurement schema

All claims use **identical** fixture seed, app build family, and isolated userData.

### 7.1 Environment

```json
{
  "schemaVersion": 2,
  "runId": "uuid",
  "gitSha": "...",
  "treeFingerprint": "clean-worktree-or-marked-dirty",
  "authoritativeBaseline": true,
  "gitShaDirty": false,
  "appVersion": "...",
  "instanceId": "TASKWRAITH_INSTANCE_ID",
  "userDataDir": "isolated path",
  "remoteDebuggingPort": 0,
  "iosRemote": false,
  "fxPosture": "cinematic_default" | "fx_off_refraction_on" | "solid_reduce_transparency" | "reduce_motion",
  "workload": "30seat" | "50seat" | "dual_run" | "455_soak" | "50_chat_switch",
  "seed": 42,
  "startedAt": "ISO-8601",
  "endedAt": "ISO-8601"
}
```

**Boss freeze #10 — official baseline authority:**

- Official baselines **must** run from a **clean isolated worktree** and record **HEAD + tree fingerprint**.
- Shared dirty checkout runs are **diagnostic only** and must set `authoritativeBaseline: false` (or be rejected by the harness evaluator).
- Live Application Support roots (`TaskWraith`, `TaskWraith Dev`, etc.) remain refused.

### 7.2 Workloads (generators — not live userData)

| Workload | Shape |
| --- | --- |
| `30seat` | 30 participants; continuous round; dual concurrent streams optional |
| `50seat` | 50-seat ceiling stress |
| `dual_run` | Two simultaneous runs on one or two chats |
| `455_soak` | 455-turn schedule matching mission hop budget class |
| `50_chat_switch` | 50 unique chat visits for heap growth |

Sanitized synthetic messages/tools only; no secrets; PRNG seed fixed.

**Scale requirement (reviewer must-fix):** generators used for official gates must reach mission-class hot-chat pressure — approximately **~6.8k messages**, **~5.9k tool activities**, **~16 MB** chat body for at least one named “baseline-class” profile (may be a parameter set on `30seat`/`50seat`, not a separate product mode). Current under-scale fixtures (~241 msgs) are diagnostic-only until hardened.

Optional mode: reproduce legacy fat global index bloat for index-rewrite comparisons.

### 7.3 Metrics (required fields)

```json
{
  "main": {
    "eventLoopLagMs": { "p50": 0, "p95": 0, "p99": 0, "max": 0 },
    "longTasks": [{ "ms": 0, "label": "..." }],
    "saveChat": {
      "count": 0,
      "coalescedCount": 0,
      "stringifyMs": { "p50": 0, "p95": 0 },
      "writeBytes": { "total": 0, "p95": 0 },
      "fsyncMs": { "p50": 0, "p95": 0 }
    },
    "checkpointWriteBytes": { "total": 0 },
    "indexWriteBytes": { "total": 0 },
    "heapRssBytes": { "p95": 0, "max": 0 },
    "spawnReap": { "spawnMsP95": 0, "zombieOver500msCount": 0 }
  },
  "ipc": {
    "bytesTotal": 0,
    "bytesPerSecP95": 0,
    "ackLagMs": { "p50": 0, "p95": 0 },
    "snapshotRatio": 0,
    "rejectCount": 0
  },
  "renderer": {
    "reactCommitMs": { "p95": 0 },
    "inputToPaintMs": { "p95": 0 },
    "longTasks": [],
    "jsHeapUsedBytes": { "p95": 0, "max": 0 },
    "rssBytes": { "p95": 0, "max": 0 },
    "gc": { "major": 0, "minor": 0 },
    "hydratedFullChatCount": 0,
    "hydratedMessageBytes": 0
  },
  "gpu": {
    "utilPctP95": 0,
    "compositorLayerCountP95": 0,
    "animatedLayerCountP95": 0
  },
  "correctness": {
    "transcriptOrderOk": true,
    "identityOk": true,
    "terminalStateOk": true,
    "dupCount": 0,
    "missingCount": 0,
    "exportParityOk": true,
    "approvalsLedgerOk": true,
    "historyDeletionOk": true,
    "crashBarrierRecoveredOk": true,
    "durableAckClassMismatchCount": 0
  },
  "capability": {
    "fiftySeatRosterOk": true,
    "cinematicSelectableOk": true,
    "reduceMotionHonoredOk": true,
    "toolExpandLazyOk": true,
    "exportFullTranscriptOk": true,
    "popoutPinHydrationOk": true,
    "sideMultiviewPinOk": true,
    "composerFocusRetainedOk": true,
    "desktopExportCapOk": true,
    "bridgeExportCapOk": true,
    "exportFullAssemblyOk": true,
    "iosProjectionBoundedOk": true,
    "iosScrollAnchorOk": true,
    "rawDetailRecoverableOk": true
  },
  "profiles": {
    "cpuProfilePath": "...",
    "heapSnapshotPaths": ["..."]
  }
}
```

JS CPU profiles + heap snapshots are mandatory for gate claims; native Electron symbols alone are insufficient.

**Correctness field semantics (executable):**

| Field | Meaning |
| --- | --- |
| `approvalsLedgerOk` | Approval/grant durable path intact under replay |
| `historyDeletionOk` | prepare → quiesce → ordered steps → no resurrection |
| `crashBarrierRecoveredOk` | D2/D3 rows survive injected crash-at-barrier |
| `durableAckClassMismatchCount` | UI/provider treated D1 as recovered (must stay 0) |
| `exportParityOk` | Scrubbed handoff/bridge markdown parity (caps + order + omissions policy) |
| `rawDetailRecoverableOk` | Lazy expand/audit raw still reachable after hot projection (**not** fused with `exportParityOk`) |
| `exportFullAssemblyOk` | After T5: markdown assembled from journal + detail stream, not last-N projected rows |

**Capability field semantics (executable; stub `false` on HEAD is fine until exercised):**

| Field | Regression it catches |
| --- | --- |
| `fiftySeatRosterOk` | 50 seats still selectable/spawnable; chip layout |
| `cinematicSelectableOk` | Cinematic mode remains choosable after T8 QoS |
| `reduceMotionHonoredOk` | Pause-on-hide does not override OS/user Reduce Motion |
| `toolExpandLazyOk` | Expand fetches raw; failure surfaces visibly |
| `exportFullTranscriptOk` | Full ordered export still available |
| `popoutPinHydrationOk` / `sideMultiviewPinOk` | Open panes not blanked by LRU demote |
| `composerFocusRetainedOk` | Continuous IPC must not steal focus / drop IME |
| `desktopExportCapOk` / `bridgeExportCapOk` | 2M / 750k honest too-large paths |
| `iosProjectionBoundedOk` / `iosScrollAnchorOk` | Bounded projection + jump targets survive |
| `rawDetailRecoverableOk` | Audit/raw after projection |

### 7.4 Acceptance gates (user mission → measurable)

| Gate ID | Requirement | Evidence artifact |
| --- | --- | --- |
| G-write-bytes | ≥ **95%** reduction in hot-path write bytes vs baseline same workload | `main.saveChat.writeBytes` + checkpoint/index totals |
| G-cpu | ≥ **3×** reduction in main+renderer CPU cost on same workload (profile-normalized) | CPU profiles + process CPU samples |
| G-lag | Main event-loop lag **p95 &lt; 25 ms** under 30-seat continuous | `main.eventLoopLagMs` |
| G-input | Input-to-paint **p95 &lt; 100 ms** | `renderer.inputToPaintMs` |
| G-heap | Renderer RSS peak **≤ 1.5 GB**; 60-min/50-switch growth **&lt; 10%** | heap timeline + snapshots |
| G-gpu | GPU **≤ 20%** when static/occluded via lifecycle pause only (see §12 closed #7) | gpu samples × FX postures |
| G-zombie | No kernel `STATE=Z` child **&gt; 500 ms** across two 1 s samples under replay | spawn/reap sampler |
| G-correct | Zero transcript reorder/dup/loss; export parity; approvals/deletion/crash barriers; durable ACK class honesty | correctness block + integration tests |
| G-cap | 50-seat, cinematic, reduce-motion, tool expand, export assembly, iOS projection/anchor, popout/side pins, composer focus, raw recoverability | capability block + smoke |

---

## 8. Tranche dependency graph

```text
T0  ADR accepted (this amended doc) ─────────────────────────────────┐
                                                                     │
T1  Instrumentation + deterministic replay harness (+ schema fields)  │
     │  blocks all “win” claims                                       │
     ▼                                                                │
T2  HEAD baseline capture (30/50/dual/soak) under isolated userData   │
     │  authoritative only from clean worktree + fingerprint          │
     │                                                                │
     ├─► T3a Chat-level save coalescer + batched fan-out seed         │
     │     + durability class hooks (still v1 files)   [@GrokWork1]   │ — per-chat flush landed; utility-process write landed dark (item 6, TASKWRAITH_UTILITY_WRITE=1); full coalescer + fan-out seed batch remain
     │                                                                │
     ├─► T3b Checkpoint hot/archive + upsert throttle  [@GrokWork1]   │
     │                                                                │
     ├─► T3c Minimal ChatListItem + per-chat index shards [@GrokWork1]│
     │                                                                │
     ▼                                                                │
T4  Chat journal/segments dual-read (S1→S2 dark-write) + deletion     │
     │                                              [@GrokWork1]      │
     ▼                                                                │
T5  Tool-detail content-addressed blobs + hot projection-only         │
     │                         [@GrokWork1 core store; @GrokWork2 UI/IPC projection]
     ▼                                                                │
T6  IPC field-mask + by-id ops + byte-aware baselines  [@GrokWork2]   │
     │                                                                │
     ├─► T7a Per-chat renderer store + memo split   [@CursorWork1]    │
     ├─► T7b Byte LRU pin/evict                     [@CursorWork1]    │
     └─► T7c Incremental indices (prefix Maps)      [@CursorWork2]    │
                                                                      │
T8  FX/timer QoS + GPU pause-on-hide (lifecycle suspension only)      │
     [@CursorWork3 + measured by @GrokBG]                             │
                                                                      │
T9  Process census coalesce / zombie measurement fixes [@CursorWork3] │
                                                                      │
T10 Cutover S3 + soak + rollback drill → S5                          │
     [@CodexBoss gate; @KimizCaptain ledger; @GrokBG monitor]         │
```

**Hard dependencies:**

- No T3+ performance claim without T1/T2 **authoritative** artifacts.
- T4 before declaring journal architecture “done.”
- T5 before removing raw from hot path (capability rule); prove `rawDetailRecoverableOk` separately from scrubbed export parity.
- T6 after or paired with T4 so deltas name stable revisions.
- T7 can start against T2 baselines using current IPC, but final gate needs T6.
- T10 only after G-* gates pass on same harness.
- Live unrelated claims on composition-root / export / iOS projection paths block workers until cleared or Captain assigns disjoint scopes.

**Quick wins allowed in T3a** (coalesce + batch seed) because they do not change format authority — still require before/after metrics and D2/D3 barrier tests.

**Item 6 (utility-process durable write) — committed, outside this ADR's core tranches:** `b745115a1` landed the worker (`src/main/store/PersistenceWriteWorker.ts` + `.test.ts`, `src/main/workers/persistenceWriteWorker.ts`), seam (`src/main/store/index.ts`), durability tests (`src/main/store/persistenceDurability.test.ts`, 14/14), Phase-0 baseline (`src/main/store/persistenceWriteBaseline.bench.test.ts`), and build entry (`electron.vite.config.ts`). Flag dark (`TASKWRAITH_UTILITY_WRITE=1`), no composition-root wiring. ~40 ms (57%) of the ~70 ms large-save block moves off main; serialize (~30 ms) stays. This narrows the freeze window until T4 — it does not replace v2 append-oriented persistence.

---

## 9. File ownership matrix (disjoint worktrees)

Captain enforces one writer per path set. Shared hubs require extracted modules + minimal wiring only.

| Owner | Primary paths | Must not touch |
| --- | --- | --- |
| **@GrokWork1** | `docs/performance/*` (this ADR); new `store/ChatJournal*` / segmented chat store; extract `writeJson`/`saveChat` I/O helpers from `store/index.ts`; `SessionCheckpoint.ts` hot/archive; minimal `ChatListItem` DTO + per-chat index shards; durability class + chat-level coalescer modules; history-deletion step registrations for new artifacts | Renderer App guts; IPC protocol shape beyond revision hooks; FX/CSS; process reaper internals |
| **@GrokWork2** | `shared/chatUpdateTransport.ts`; `ChatUpdateDeliveryCoordinator.ts`; tool-detail projection modules; IPC byte stats | Persistence journal internals; TranscriptPanel layout |
| **@CursorWork1** | Per-chat external transcript store; `chatHydrationMerge.ts`; `chatUpdateHydrationQueue.ts`; byte-weighted LRU; TranscriptPanel memo prop split | `store/index.ts` persistence core |
| **@CursorWork2** | Append-only incremental indices (`messageById`, projected lookup, super-groups); grouping hooks | Main persistence; IPC coordinator |
| **@CursorWork3** | GPU/FX visibility QoS; shared animation clock; timer fan-in; LocalServers census coalesce; spawn/reap instrumentation; harness schema/scale hardening | Chat journal format |
| **Harness owners** | `scripts/perf/**`; fixture generators; CDP samplers; report schema | Production userData |
| **@GrokBG** | Read-only profiling execution; baseline/after runs; regression monitoring | Source edits unless promoted |
| **@CodexBoss** | Architecture amendments; cutover authority; integration merge order | N/A |
| **@KimizCaptain** | Ownership matrix updates; acceptance ledger; fan-out sequencing | Unilateral architecture override while Boss available |
| **Review seats** | Findings only | Implementation unless assigned |

**Live claim note:** shared checkout may hold unrelated claims (side-chat authority-return, iOS transcript navigation, workspace-stats). Epic writers **must not** edit those paths; worktrees only.

---

## 10. Acceptance ledger (mission gate → owner → evidence)

| Mission / user gate | Owner | Tranche | Evidence |
| --- | --- | --- | --- |
| Responsive under 30–50 seats | All; Boss integrates | T3–T9 | T2 vs post-fix profiles |
| Multi concurrent runs | Harness + persistence/IPC | T1–T6 | `dual_run` workload |
| 6k–20k rows / 5k–15k tools | Persistence + renderer | T4–T7 | Fixture scale + lag/heap |
| 200–700 historical runs | Index + LRU + checkpoints | T3b/T3c/T7b | Index write bytes; heap soak |
| Order-of-magnitude not cosmetic | Boss | T10 | G-write-bytes + G-cpu |
| No live app/userData harm | All | always | Process of record; isolated instance ids |
| Isolated deterministic replay | Harness | T1 | Schema §7 artifacts |
| Official baseline not dirty tree | Harness + GrokBG | T2 | `authoritativeBaseline` + tree fingerprint |
| Preserve capabilities / 50 seats / cinematic / export / iOS | Review + Work3 + Work2 | T5/T8/T10 | G-cap block |
| Transcript order/identity/terminal | Work1/Work2 + tests | T4–T6 | G-correct |
| Approvals / trust / deletion / crash barriers | Work1 | T3a/T4 | correctness + crash injection |
| Durable ACK class honesty | Work1 + harness | T3a+ | `durableAckClassMismatchCount` |
| No monolith growth | All writers | every PR | diff line policy on three roots |
| Before/after same replay | GrokBG + harness | T2/T10 | Paired JSON reports |
| Append-only / async / coalesce persistence | GrokWork1 | T3a/T4 | saveChat metrics |
| Minimal list DTO + per-chat shards + checkpoint hot/archive | GrokWork1 | T3b/T3c | File size + rewrite counts |
| IPC field-mask not full record | GrokWork2 | T6 | ipc.bytes* |
| Tool detail lazy / raw recoverable / export full | GrokWork1+2 | T5 | split acceptance fields |
| Renderer store + LRU | CursorWork1 | T7 | G-heap |
| Incremental transcript indices | CursorWork2 | T7c | React commit + long tasks |
| GPU ≤20% occluded (lifecycle pause only) | CursorWork3 | T8 | G-gpu |
| Zombie &lt;500 ms | CursorWork3 + GrokBG | T9 | G-zombie |

---

## 11. Implementation constraints (every tranche)

1. **Tests first for crash/deletion** when touching durability — copy UsageJournal crash seams.
2. **Explicit path staging** only; no `git add -A`.
3. **Format only new/touched files**; new ADR/file born formatted; never repo-wide Prettier.
4. **Feature flags** for S2/S3 cutover; default off until Boss enables.
5. **Logging:** prefer meters/metrics over chatty main-thread logs under load.
6. **iOS/bridge:** keep bounded projections; full export path remains full-transcript builder.
7. **Popout:** second hydrated consumer — must respect pin rules and same IPC protocol.
8. **Main-owned fields** (`threadWorktreeBinding`, `watchedPr`, `gitWorkflow`, `fanoutWorktreeCandidates`) continue strip-and-remerge across any new save path.
9. **Authoritative raw never truncated** on durable blob segments; projection caps are UI/wire only.
10. **No adaptive fidelity reduction** for GPU QoS (Boss #7).

---

## 12. Closed decisions (Boss amendment `perf-epic-adr-boss-amendments-v1`)

Former open items are **closed** as follows:

| # | Topic | Frozen choice |
| --- | --- | --- |
| 1 | Storage engine for v2 | **Per-chat segmented framed JSON event journals + atomic compact snapshots**; content-addressed blob/detail segments with checksums for raw. **No new native SQLite dependency.** Prefer existing JS/fs crash patterns (UsageJournal-like). |
| 2 | Index medium | **One minimal JSON shard per chat**; **no full global-index rewrite on hot updates.** |
| 3 | Coalesce budgets | **D1: 100 ms trailing, 500 ms maximum latency, single in-flight.** D2/D3 bypass + fsync before durable ACK. |
| 4 | Checkpoint snapshot richness | **One full-fidelity resumable hot record per chat/round**; D2 at round-start/accept/terminal; **append** terminal/superseded archive outside hot rewrite. |
| 5 | IPC patch encoding | **Explicit top-level field mask** + append/update/delete-by-id transcript ops + sub-revisions/hashes; one snapshot retry; byte backpressure; **no full ChatRecord ACK baselines.** |
| 6 | Dual-write release policy | **No per-D1 authoritative v1 dual-write.** S2: read v1 authority, dark-write/verify v2. S3: write v2; v1 compatibility snapshots only at D2/terminal/idle + explicit rollback materializer. Divergence blocks cutover. |
| 7 | GPU QoS product wording | Hidden/occluded FX pause is **lifecycle suspension only**: exact selected cinematic settings resume unchanged; **no adaptive fidelity reduction.** |
| 8 | Harness / CI posture | Deterministic schema/fixture/correctness tests **required** in CI. Isolated Electron perf runs are **manual / nightly / release-gated** until stable. |
| 9 | Pre-T5 raw backfill | Recover surviving inline v1 and RunEventStore detail on read/idle with **coverage manifests**; never fabricate or silently label already-compacted legacy bytes as recovered. |
| 10 | Official baseline trees | Clean isolated worktree + HEAD + tree fingerprint; shared dirty checkout runs diagnostic only / non-authoritative. |

### 12.1 Remaining unknowns that truly require measurement

These are **not** architecture freezes; they are calibration/measurement items:

1. **Whether 100 ms / 500 ms D1 budgets** need retune after T2 save-rate histograms under baseline-class 6.8k-message load (policy may adjust numbers without reopening JSON vs SQLite).
2. **Per-chat 250 ms flush vs chat-level 100 ms coalescer interaction** under 30–50 concurrent streams — measure double-scheduling waste.
3. **Compact snapshot cadence** (how often atomic snapshots run under dual_run) for crash recovery time vs write-byte budgets.
4. **Blob segment packing size / content-hash chunking** for multi-MB tool payloads (throughput vs random expand latency).
5. **IPC field-mask vs full-record break-even** on tiny metadata-only ticks (keep mask always for simplicity unless measurement shows pathological overhead).
6. **Shard directory enumeration cost** for 200–700 chats in sidebar cold start (may need a tiny id manifest cache).
7. **GPU layer counts** under cinematic_default vs reduce_motion vs occluded pause — numbers only; policy already frozen.
8. **Zombie parentage attribution** under Observatory vs TaskWraith hosts — measurement methodology, not product capability.
9. **Harness generator parameters** to hit ~16 MB / ~6.8k msgs without flaking CI unit tests (separate “baseline-class” profile flags).
10. **Worktree candidate merge order** when multiple tranches are green — process ownership stays with @KimizCaptain sequencing under @CodexBoss cutover authority (not a storage-format question).

---

## 13. Out of scope for this ADR

- Editing production source in this commit.
- Changing live v1.9.2 userData or restarting the user’s running app.
- Provider admission / LIVE_SELECTABLE set changes.
- Repo-wide formatting or monolith refactors unrelated to extracted seams.
- Claiming performance wins without T1/T2 **authoritative** artifacts.
- Introducing SQLite as a dependency in this epic without a new Boss amendment.

---

## 14. Consequences

**Positive**

- Breaks the O(events × whole-document) write and IPC amplification loop.
- Makes durability explicit; enables safe coalesce without lying about approvals/user/terminal.
- Closes the dual-write trap that would have preserved v1 hot-path amplification.
- Guarantees authoritative raw recoverability separate from scrubbed export parity.
- Gives measurement teeth (including G-correct / G-cap executable fields) to every later PR.

**Negative / cost**

- Multi-tranche migration complexity; dark-write verification and rollback materializer engineering.
- New failure modes (segment quarantine, authority bits, coverage manifests) require UI/recovery copy.
- Worker coordination overhead (worktrees, ownership matrix, claim avoidance).

**Residual risk**

- Without T1 schema/scale hardening and T2 clean-worktree baselines, the ensemble will re-litigate performance with anecdotes — Boss should refuse source PRs that skip metrics.
- Shared dirty checkout and concurrent claims remain a process risk; isolation is mandatory.
- Pre-T5 already-compacted legacy raw cannot be resurrected; coverage manifests must say so honestly.

---

## 15. References (scout evidence synthesized)

- CursorScout1 — main-thread write path / `writeJson` / `saveChat` / index spread / ensemble bypass of renderer debounce
- GrokScout3 — IPC patch still full non-message record; baseline RSS under-report
- CursorScout3 — TranscriptPanel invalidation + O(n) derivations
- CursorScout4 — ensemble cadence; N-seat save amplification; coalesce recommendations
- CursorScout2 — checkpoint whole-array rewrite; hot/archive split
- CursorScout7 — durability/authority/deletion/crash invariants
- CursorScout8 — missing stress/replay harness
- CursorScout10 — no chat-store format version; dual-read patterns to copy
- CursorScout11 — heap/LRU absence; soak criteria
- CursorScout5/6 — GPU/FX and timer/RAF amplifiers
- CursorScout9 — iOS/bridge/popout/export parity constraints
- CursorScout12 — DAG, ownership, rollout graph
- GrokScout4 — tool raw inlining; RunEventStore contrast
- GrokScout5 — process pollers / zombie measurement definition
- CursorReview1 — G-correct durability acceptance fields; T3a barrier cliff
- CursorReview2 — G-cap UX/a11y fields; reduce-motion composition
- CursorReview3 — export vs raw split; cross-surface capability fields
- GrokReview1 — baseline validity / non-authoritative claim rules
- GrokReview2 — concurrency / composition-root / format ratchet hygiene
- CodexBoss — dual-read, durability-tiered, append-oriented, reversible freeze; worktree-only writers; amendment `perf-epic-adr-boss-amendments-v1`
- KimizCaptain — ownership matrix + ledger v2 reviewer must-fixes

---

## 16. Approval

| Role | Action |
| --- | --- |
| @CodexBoss | **Accepted in principle** via `perf-epic-adr-boss-amendments-v1`; this commit is the executable amendment. Re-confirm after reading this file; then authorize T1 schema/scale hardening and T2 clean baselines. |
| @KimizCaptain | Lock ownership matrix + acceptance ledger tracking (ledger v2 already lists must-fixes). |
| @GrokBG | Ready to run baselines once T1 fields/scale land; refuse authoritative claims from dirty trees. |
| Work/Review seats | Implement only after gate + explicit writeScopes; no production tranche until T2 authoritative artifact. |

**Next action after this amendment lands:** Boss reviews this commit; Captain updates ledger to ADR-freeze-closed; harness owners implement §7.3 correctness/capability fields + baseline-class scale; then T2 clean-worktree HEAD baseline.
