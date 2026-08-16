# T2 Baseline Artifact Index

> **Status:** Boss-accepted (2026-08-04) · 3/3 reviewer concurrence confirmed
> **Epic:** TaskWraith Performance Fix Epic — 455-turn mission
> **Phase:** T2 — Authoritative 30-seat baseline capture

> ### ⚠ ARTIFACTS ABSENT — verified 2026-08-16
>
> **The ~140 MB of profile evidence this index exists to point at is no longer
> on disk.** The measurements, digests and gate results below are unchanged and
> remain the record of what was captured; what is gone is the ability to
> re-verify them against the files.
>
> What was checked on 2026-08-16:
>
> - The frozen worktree `fanout-CursorWork1-299397f7ef` still exists but
>   contains only `perf-homes/` (three run dirs, each holding an empty
>   `Downloads/`). There is **no `perf-artifacts/` directory in it at all**.
> - Zero `.cpuprofile` and zero `.heapsnapshot` files exist anywhere under
>   `/Users/chrisizatt` (excluding `node_modules`).
> - The only `perf-t2-report.json` files on disk are transient fixtures under
>   `AGBench/.tmp_vitest/`, not this run's report.
> - `perf-artifacts/t2-cursorwork-host-retry/` at the repo root retains only a
>   `LANE-RECEIPT.md` from the earlier failed, non-authoritative retry.
>
> Consequences, stated plainly: the SHA-256 digests in "Profile Artifacts"
> below are now the **only** surviving evidence of these files, and nothing can
> be re-checked against them. Any T3+ gate whose precondition is "T1/T2
> authoritative artifacts exist" is **not currently satisfiable by
> re-verification** — it can only be satisfied by accepting this record on its
> face, or by re-running the T2 capture to produce a fresh authoritative
> baseline. Deciding which is a Boss/owner call, not a documentation fix.
>
> Neither the removal date nor the authority for it is recorded anywhere found.
> "Frozen, read-only forever" describes the intent, not what happened.

---

## Overview

First **authoritative** 30-seat baseline capture for the TaskWraith Performance Epic.
This artifact establishes the **measured denominator** for all subsequent performance comparisons.

- **Verdict:** Boss-accepted with amended gate criteria
- **Reviewer Concurrence:** 3/3 confirmed (MistralReview conditional-pass, GrokReview conditional-pass, K3Review PASS)
- **Production Unlock:** Effective per `perf-epic-production-unlock-effective-and-tranche-dispatch`

---

## Artifact Identity

| Field | Value |
|-------|-------|
| **Run ID** | `perf-t2-30seat-42-9977a712b741` |
| **Commit SHA** | `06778017e5ec898e1c4e30ceee96c28ab4259bb0` |
| **Worktree** | `fanout-CursorWork1-299397f7ef` (intended frozen/read-only; **artifacts absent as of 2026-08-16** — see the banner above) |
| **Blackboard Entry** | #49 (49-entry capsule) |

---

## Run Window

| Timestamp | Event | Source |
|-----------|-------|--------|
| 2026-08-04T08:41:02Z | Replay started | `perf-t2-report.json` |
| 2026-08-04T11:25:14Z | Replay completed | `perf-t2-report.json` |
| **Duration** | **9,851 seconds** (~2h 44m) | Computed |

---

## Replay Statistics

| Metric | Value | Notes |
|--------|-------|-------|
| **Events** | 13,897 / 13,897 | 100% complete |
| **Saves** | 13,894 | |
| **Unsupported Signals** | 272 | Documented, not fabricated |
| **Throughput (cumulative)** | **1.41 evt/s** | 13,897 events / 9,851 s |
| **Throughput Decay** | 6.9 → 1.41 evt/s | O(n²) signature confirmed |

### Decay Series (Boss-measured)

| Window | Events/s | Notes |
|--------|----------|-------|
| 08:41–08:49Z | 6.9 | Initial |
| 08:49–08:59Z | 3.0 | |
| 09:00–09:02Z | 2.03 | |
| 09:02–09:06Z | 2.01 | |
| 09:06–09:10Z | 1.80 | |
| 09:06:13–09:10:04Z | 1.80 | Windowed rate |

> **Note:** Cumulative ETA was ~2× optimistic; windowed rate is the authoritative signal.

---

## Profile Artifacts

All profiles are **digest-verified** (SHA-256) and **non-empty**.

| File | Size | SHA-256 Digest | Verified By |
|------|------|----------------|-------------|
| `main.cpuprofile` | 49,131,085 B (~46.8 MB) | `0642a7b4...8e57` | Boss, DSeekScout, K3Review |
| `renderer.cpuprofile` | 63,564,049 B (~60.6 MB) | `a89a1b33...7c2c` | Boss, DSeekScout, K3Review |
| `renderer.heapsnapshot` | 34,076,993 B (~32.5 MB) | `118c5bd7...a7db` | Boss, DSeekScout, K3Review |
| **Total** | **146,772,127 B (~140 MB)** | | |

> **Path (as captured):** `fanout-CursorWork1-299397f7ef/perf-artifacts/t2g30-d613-0804-host/profiles/`
> — this directory no longer exists; the digests above are the surviving record.

---

## Gate Results

All gates evaluated to **`true`** in `perf-t2-report.json`.

| Gate | Result | Notes |
|------|--------|-------|
| `evaluated` | ✅ `true` | |
| `profilesEvidenceOk` | ✅ `true` | Digest-verified non-empty profiles |
| `fixtureFingerprintOk` | ✅ `true` | |
| `baselineFingerprintMatch` | ✅ `true` | |
| `authoritativeBaseline` | ✅ `true` | |
| `metricsCollectedAllowed` | ✅ `true` | |
| `metricsCollected` | ❌ `false` | **Honest** — unsupported telemetry at this HEAD |
| `gCorrect` | ❌ `false` | No numeric comparison baseline yet |
| `gCap` | ❌ `false` | |
| `gPerf` | `null` | |
| `refuseReasons` | `[]` | Empty — no gate failures |

### Amended Gate Rationale

**Original Gate:** Required `metricsCollected:true` for acceptance.
**Amendment:** Clause **REMOVED for T2-class runs** (Boss ruling, 2026-08-04).

**Reason:** Numeric metrics (event-loop lag, IPC bytes, write-serialization timing, spawn latency, GPU counters) require production probes that **did not exist** at this HEAD — adding them is T3+'s work. The T2 runner contract mandated explicit `unsupported` over fabricated values, so a `true` value would mean fabrication. The clause's intent is carried by `profilesEvidenceOk` + digest-verified non-empty profiles + `metricsCollectedAllowed`.

> **T2-only scoping:** All T3+/T4/T6/T7 comparison runs **must** report real `metricsCollected:true` from the probes those tranches add.

---

## Provenance

| Field | Value |
|-------|-------|
| `gitSha` | `06778017e5ec898e1c4e30ceee96c28ab4259bb0` |
| `dirty` | `false` |
| `isolatedWorktree` | `true` |
| `buildAuthoritative` | `true` |
| Isolated HOME verified | ✅ (observed == expected, realpath proven) |

---

## Teardown

| Item | Status |
|------|--------|
| Child PID 42851 | Reaped |
| Port 46000 | Free |
| Port 46001 | Free |
| Worktree `fanout-CursorWork1-299397f7ef` | Clean at `06778017e` |

---

## Environment

- **TaskWraith:** v1.9.2
- **Fixture:** 30-seat deterministic legacy_v1, seed 42
- **Isolation:** Unique `TASKWRAITH_INSTANCE_ID`, isolated HOME, mock Keychain
- **Build mode:** Production bundle (note: minified but 11.3 MB with surviving names — comparison run must pin exact build command)

---

## Profile Analysis Summary

Read-only analysis by GrokWork of both `.cpuprofile` artifacts:

| Measurement | Value |
|---|---|
| Main busy CPU | 173 s of 9,836 s = **1.8%** (98.2% idle) |
| Renderer busy CPU | 2,183 s of 9,832 s = **22.2%** |
| `JSON.stringify` in main profile | **Not present** in top 30 |
| `fsync` CPU | 0.2 s |
| `sanitizeChatForSave` CPU | 0.4 s |
| Renderer `(program)` bucket | 1,020.7 s (~47% of renderer busy) |

**Key finding:** Aggregate CPU is low, but throughput collapsed 5× — decay is per-event cost growth + un-attributed blocked wall time (V8 sampler cannot see synchronous syscall blocking). This is the structural reason T3+ probes are required: they are the only instrument that can attribute the decay.

---

## Heap Snapshot (renderer.heapsnapshot)

| Artifact | Value |
|----------|-------|
| Retained `Error` instances | **13,948** (≈ 1:1 with 13,894 saves) |
| Plain Objects | 26,669 |
| Arrays | 9,546 |

> **Finding:** Per-save Error stack captures are retained in the renderer heap — the first quantified per-event retention evidence beyond messages. T7 should add an Error-instance attribution probe for the comparison run.

---

## Related Decisions

| Blackboard Key | Summary |
|----------------|---------|
| `perf-epic-t2-amended-gate-and-boss-acceptance` | Boss acceptance with amended gate criteria |
| `perf-epic-t2-k3review-final-gate-pass` | K3Review final gate PASS from second vantage |
| `perf-epic-production-unlock-effective-and-tranche-dispatch` | Production T3+/T6/T7 unlock effective |
| `perf-epic-t2-profile-analysis-cpu-hypothesis-refuted` | Profile analysis refutes CPU-bound hypothesis |

---

## Reference

- **Frozen worktree:** `/Users/chrisizatt/Documents/.taskwraith-worktrees/AGBench/fanout-CursorWork1-299397f7ef` — still present, but only `perf-homes/` survives inside it
- **Report:** `fanout-CursorWork1-299397f7ef/perf-artifacts/t2g30-d613-0804-host/perf-t2-report.json` — **absent as of 2026-08-16**
- **Land tip (post T2):** `3fdcce856b4508f219f2a5ba7cb13891ebad4b53`
- **Epic ADR:** `docs/performance/taskwraith-performance-epic-adr.md`
