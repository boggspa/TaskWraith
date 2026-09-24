# Workspace-lock WAL checkpoint and compaction protocol

Status: implemented (`src/main/workLocks/WorkspaceLockWalCheckpoint.ts`).
Written before the implementation, per the design-first requirement.

## The problem this solves

`WorkspaceLockAuthority.boot()` calls `decodeWorkspaceLockWal()` on the complete
`events.jsonl` before `createWindow()` on every launch. Measured 2026-08-29
(`scripts/perf/walDecodeBench.cjs`): ~14–15 ms/MB, linear, ~1.88 s at the
observed 127.6 MiB / 82,950-event journal. The journal is append-only with no
compaction anywhere in `src/main/workLocks/`, so the cost compounds forever, and
at snapshot time the whole 128 MB reconstructed **zero** active leases and zero
markers.

The cost is not I/O. It is per-event canonical-JSON re-serialization, SHA-256
re-hashing, and deep structural validation of every lease claim and its path
evidence. A snapshot that still holds every event in replayable form does not
remove any of that, which is why the format below moves events off the boot path
rather than merely summarizing them.

## What the format must preserve

`WorkspaceLockWalState` is not a cache; each field is an invariant.

| Field              | Invariant                                                                               | Treatment                                         |
| ------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `sequence`         | contiguity: every event is `previous + 1`                                               | stored exactly                                    |
| `lastDigest`       | hash-chain anchor                                                                       | stored exactly; also the tail-authentication link |
| `lastTransitionId` | last-transition anchor                                                                  | stored exactly                                    |
| `transitionIds`    | request-level idempotency; a repeated id is refused                                     | stored **complete**, never truncated              |
| `leaseIds`         | lease ids are never reusable, including after release                                   | stored **complete**, never truncated              |
| `maxGeneration`    | boot generation monotonicity                                                            | stored exactly                                    |
| `activeLeases`     | the live authority; a lost lease is a lost lock                                         | stored verbatim                                   |
| `recoveredLeases`  | audit of retired leases (already capped at 100)                                         | stored verbatim                                   |
| `knownMarkers`     | pending derived-marker cleanup inventory                                                | stored verbatim                                   |
| `events`           | exact committed-operation replay (`replayedAcquire`, `historicalWorkspaceLockWalEvent`) | **bounded retention window; see below**           |

### The explicit decision on old event payloads

`events` is the only unbounded field, and it is the whole 128 MB. It is read by
exactly two families of caller, both of them _idempotent-retry_ paths:

- `replayedAcquire` / `replayedTransfer` — a caller re-issued a stable
  `transitionId` for an acquisition that already committed.
- `replayedDirectRelease` / `replayedAcquisitionRelease` / `replayedRunRelease`
  via `historicalWorkspaceLockWalEvent` — the same, for releases. These need the
  event _and the state immediately before it_.

Nothing retries a transition committed tens of thousands of events ago. So:

1. **Old event payloads are archived, not deleted.** Sealed segments are moved to
   `archive/events-<sequence>.jsonl` with their SHA-256 recorded in the
   checkpoint. Audit evidence is preserved; it is simply never on the boot path.
2. **A compact idempotency index is kept for the whole history**, because a
   transition id or lease id being refused is a hard fence, not a nicety. These
   are plain string arrays: ~40 bytes each versus ~1.6 KB for the event that
   produced them, and they are read with one `JSON.parse` — no per-item SHA-256,
   no canonical JSON, no claim/path-evidence validation. That is where the
   1.88 s actually goes.
3. **A bounded window of recent events stays replayable**, and the window is the
   live `events.jsonl` tail itself rather than a copy inside the checkpoint.

Consequence, stated plainly: retrying a transition whose event has been archived
no longer replays idempotently. It falls through to
`state.transitionIds.includes(transitionId)` and is **refused** with
`Transition <id> was already used for a different operation.` That is
fail-closed — a refusal, never a double-acquire and never a lost lease.

## On-disk layout

```
<authority-root>/work-lock-authority/
  events.jsonl                      # live tail segment; framing unchanged
  checkpoint.json                   # compacted state at sequence B (atomic)
  archive/
    events-00000000000000000000.jsonl   # sealed segment, frames 1..B
    events-00000000000000082950.jsonl   # sealed segment, frames B+1..B'
```

`events.jsonl` keeps its exact v1 framing (one canonical JSON object per line,
newline-terminated, torn final fragment ignored). A v1 authority root has no
`checkpoint.json` and no `archive/`, and is read exactly as before.

### Checkpoint record

```jsonc
{
  "schema": "taskwraith.workspace-lock.checkpoint.v1",
  "sequence": 82438, // B: last event compacted into this checkpoint
  "lastDigest": "<sha256 of event B>",
  "lastTransitionId": "<transition id of event B>",
  "transitionIds": ["…"], // complete, length === sequence
  "leaseIds": ["…"], // complete, sorted
  "maxGeneration": 4127,
  "activeLeases": [
    /* WorkspaceLockLease */
  ],
  "recoveredLeases": [
    /* WorkspaceLockLease */
  ],
  "knownMarkers": [
    /* WorkspaceLockWalMarker */
  ],
  "archivedSegments": [
    {
      "sequence": 82438,
      "filename": "events-…jsonl",
      "byteLength": 133_000_000,
      "digest": "<sha256 of the segment's exact bytes>"
    }
  ],
  "previousCheckpointDigest": "<sha256 of the checkpoint this supersedes, or ''>",
  "createdAt": "2026-08-29T02:00:00.000Z",
  "authority": { "instanceId": "…", "generation": 4127 },
  "digest": "<sha256 of canonicalJson(record without digest)>"
}
```

### Authentication — no weakening versus v1

The v1 WAL is a self-consistent SHA-256 chain, not a keyed MAC: anyone who can
write `events.jsonl` can write a fresh valid chain. The checkpoint is held to
exactly that bar and no lower:

- `digest` uses the same `sha256(canonicalJson(record-without-digest))`
  construction as an event, so accidental corruption is detected.
- **The checkpoint is bound to the tail it precedes.** A checkpoint at sequence
  `B` with digest anchor `D` is honoured only if the first frame of
  `events.jsonl` has `sequence === B + 1` **and** `previousDigest === D`. So a
  substituted checkpoint cannot describe a different history without the tail
  being rewritten too — the same property the chain already had.
- `previousCheckpointDigest` chains successive checkpoints, and
  `archivedSegments[].digest` binds the sealed bytes, so the audit trail from
  event 1 to the present is still verifiable end to end. That one field is
  hashed as raw UTF-8 rather than through `canonicalJson`, precisely so it can
  be checked from outside the app with `shasum -a 256 events-<seq>.jsonl`.

## Publication protocol

All steps run while the caller holds the existing O_EXCL instance fence
(`acquireInstanceFence`), under the same byte fence as an append.

1. **Plan.** Read and validate the WAL as normal (the state is already in
   memory under the fence). Choose boundary `B = sequence - RETAINED_TAIL_EVENTS`.
   Abort if `B <= checkpointSequence` (nothing to seal).
2. **Seal.** Write frames `checkpointSequence+1 .. B` to
   `archive/events-<B>.jsonl` via temp + fsync + rename + directory fsync.
3. **Publish.** Write `checkpoint.json` via temp + fsync + rename + directory
   fsync.
4. **Truncate.** Atomically replace `events.jsonl` with frames `> B` only, via
   temp + fsync + rename + directory fsync.

### Crash behaviour at each step

| Crash after | On-disk state                                               | Boot outcome                                                                                                                                    |
| ----------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1           | unchanged                                                   | v1 replay; unchanged behaviour                                                                                                                  |
| 2           | orphan archive segment, no checkpoint                       | v1 replay; the segment is inert and is overwritten byte-identically by the next attempt at the same `B`                                         |
| 3           | checkpoint at `B`, `events.jsonl` still holds frames `1..N` | first frame has `sequence === 1 !== B + 1` → **checkpoint ignored, full v1 replay**. Slow but exactly correct; the next compaction re-publishes |
| 4           | checkpoint at `B`, tail holds frames `> B`                  | steady state: checkpoint + short tail                                                                                                           |

Step 4 is the only step that removes bytes, and it removes only bytes already
sealed in step 2 and summarized in step 3. There is no window in which a frame
exists in neither the tail nor the archive.

### Torn tails and concurrent appenders

Truncation reuses `atomicReplaceRegularFile` (temp inode, `fsync`, `rename`,
directory `fsync`), so a reader never observes a partial `events.jsonl`. Because
the whole sequence happens under the instance fence and every append re-checks
`byteLength` and the file's dev/ino/size revision, a concurrent appender that
raced the truncation fails its byte fence and retries against the new file —
the same path an ordinary lost race already takes. `repairTornEventTail` is
unchanged and still refuses to touch a complete frame.

## Decode

```
decode(tail, checkpoint):
  if checkpoint is null:
      return legacyDecode(tail)                       # v1, unchanged
  base = validateCheckpoint(checkpoint)               # one JSON.parse + structure
  if tail is empty:
      return base                                     # nothing appended since
  first = parse(first line of tail)                   # O(1)
  if first.sequence === base.sequence + 1
     and first.previousDigest === base.lastDigest:
      return replay(base, tail)                       # normal path
  if first.sequence === 1:
      return legacyDecode(tail)                       # step-3 crash window
  throw                                               # fail closed
```

The decision is O(1) — one line parsed — and every branch either produces a
state identical to the full replay or refuses. A checkpoint can never produce a
_weaker_ state than v1: it either chains exactly, or it is ignored, or boot
fails.

The one unrecoverable case is deliberate: a tail that starts at `B+1` with no
readable checkpoint cannot be replayed from empty, because event `B+1` chains to
a digest the reader has never seen. That throws rather than booting with a
silently truncated history, which would drop active leases.

## Where the tail retention window comes from

`RETAINED_TAIL_EVENTS = 512` frames, and compaction only runs when
`events.jsonl` exceeds `CHECKPOINT_BYTE_THRESHOLD` (8 MiB). 512 frames is far
more than any live retry window (an operation's retry happens within one process
lifetime, or across a crash-restart of a still-pending operation) while keeping
the steady-state tail in the low megabytes.

## When compaction runs

Never inside the awaited boot path. `WorkspaceLockAuthority.compactIfNeeded()`
is a separate public entry point, called after the window exists. The first run
after upgrade still pays one full replay (there is no way to summarize a history
without reading it once); every launch after that reads the checkpoint plus a
bounded tail.

## What this deliberately does not do

- It does not weaken any fence, admission check, or recovery decision.
- It does not delete audit evidence: sealed segments are retained and digest-bound.
- It does not make `historicalWorkspaceLockWalEvent` guess. Outside the retained
  window it returns `null`, and the caller refuses.
