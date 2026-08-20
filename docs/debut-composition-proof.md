# Debut §9 composition proof record

**Record status:** OPEN — the capture contract is frozen, but the live proof is
not closed until an installed build completes every row below on real hardware.

**Owner:** release maintainer

**Source contract:** `docs/competitive-popularity-analysis.md` §9 (local analytical source)

This is the closure record for the highest-value debut proof. It is deliberately
separate from the development test suite: a green unit test or a source-tree
run can establish implementation facts, but cannot prove that a packaged app
continues a scheduled Ensemble after its renderer closes, delivers attention to
the companion, and carries cost/receipt evidence end to end.

## Candidate identity

Fill these fields before the live run. Do not overwrite an earlier candidate;
append a new dated run if the artifact changes.

| Field | Recorded value |
| --- | --- |
| App version | `1.9.6` |
| Git commit | `UNKNOWN — the installed artifact carries no source-commit receipt; current checkout HEAD is not artifact evidence` |
| Installer | `dist/TaskWraith-1.9.6-universal-mac.dmg` |
| Installer SHA-256 | `06fc25f270632dc5b03060ad4676e6b3e528703a38584fa0790860d6f7ad1ccf` |
| Build/signing posture | `Developer ID signed with hardened runtime and a stapled notarization ticket; package-contract smoke failed before live use` |
| Host hardware / OS | `Mac13,1 / Apple M1 Max / macOS 26.0 (25A353)` |
| iOS companion build / device | `Physical iPhone 15 Pro is paired and available; companion build/install and notification attention are not yet verified` |
| Provider seats | `Not exercised — live dispatch deliberately stopped at the failed package prerequisite` |
| Workspace | `Not selected — no workspace content was sent to a provider` |
| Run date (UTC) | `2026-08-20 preflight only` |

## Closure rule

The result is **PASS** only when every required row is `PASS` and its evidence
pointer is durable (recording, redacted transcript/export, or test log). A
`PARTIAL`, `BLOCKED`, or missing pointer keeps the record `OPEN`; static package
smoke is necessary hygiene but never substitutes for a live row.

| Row | Required live observation | Evidence to retain | Result |
| --- | --- | --- | --- |
| A | Create a multi-provider Ensemble with named roles and schedule a near-term run. The schedule is sealed and visible before the window closes. | Screenshot or redacted capture of schedule + sealed occurrence id | `TBD` |
| B | Close the renderer window while the host Mac remains awake. Main-owned dispatch starts the scheduled round without renderer participation. | Timestamped host log and occurrence/round ids spanning close → dispatch | `TBD` |
| C | Reopen the app (or inspect the permitted run projection) and show every lane's role, provider, permission posture, and provenance. | Redacted transcript/run projection with per-seat labels | `TBD` |
| D | A reviewing seat returns a ranked verdict that cites peer findings; the round settles instead of becoming an unlabelled batch of solo outputs. | Final review card/transcript plus settled round id | `TBD` |
| E | The native iOS companion receives attention for the completed round and opens the corresponding result. | Physical-device notification/attention capture and device/build details | `TBD` |
| F | The opened result carries per-model token totals and projected cost, with provider/model identity intact. | Usage/cost capture tied to the same round id | `TBD` |
| G | The same evidence package records the host ceiling: the awake Mac is local infrastructure, not an always-on cloud service. | Spoken or written disclosure in the recording/notes | `TBD` |

Rows A–F are the §9 gate. Row G is required for an honest public recording but
does not turn local scheduling into a cloud-continuity claim.
Row E requires a physical device, not only a simulator.

## Reproducible run procedure

1. Build or install the exact candidate. Record the installer hash, signing
   posture, host, iOS build, and commit in the table above. Run the packaged
   static smoke first and retain its output:

   ```sh
   TASKWRAITH_REQUIRE_PRODUCTION_SIGNING=1 \
     node scripts/smoke-packaged-electron.cjs dist/mac-universal
   ```

   The command may skip a second GUI launch when another TaskWraith instance is
   active; that is a package-smoke note, not a §9 pass.

2. Use a disposable workspace and pre-authenticate at least two providers. Set
   every seat to Ask/read-only for the proof task. Do not make the first proof
   run depend on provider setup, private files, or a rich surface.

3. Create the Ensemble, keep the roster and role labels visible, and schedule a
   near-term occurrence. Capture the schedule and sealed occurrence id before
   closing the renderer.

4. Close the renderer window, leave the host Mac awake, and wait for the
   main-owned occurrence to fire. Record timestamps, occurrence id, round id,
   and each lane's terminal outcome. Do not silently restart or manually send
   a replacement prompt if the occurrence fails; record the failure and open a
   new dated attempt.

5. Reopen the installed app and inspect the settled round. Capture the role,
   provider, posture, provenance, reviewing verdict, usage, and cost rows in
   one redacted evidence package. Trigger/observe the iOS attention on a
   physical paired device and record the device/build identity.

6. Complete rows A–G, link the evidence, and change `Record status` to `PASS`
   only when the closure rule is satisfied. If a row fails, keep its exact
   result and add a corrective attempt below; never turn a source or simulator
   result into a real-hardware claim.

## Attempt log

Append one block per candidate/run. Attempt 1 records the first real preflight;
it stopped before provider dispatch because the package prerequisite failed.

### Attempt 1 — blocked at package preflight

| Field | Value |
| --- | --- |
| Candidate / commit | `TaskWraith-1.9.6-universal-mac.dmg` / source commit unknown |
| Date (UTC) | `2026-08-20` |
| Result | `BLOCKED — production package smoke rejected mixed/unknown distribution identity` |
| Failed or missing rows | `A–F not attempted; G disclosure retained in the procedure` |
| Evidence location | This record: signing, artifact hash, host/device preflight and exact smoke failure below |
| Follow-up owner/date | Release maintainer — build a fresh signed candidate from the identity-handoff commits, then append Attempt 2 |

#### Preflight evidence

- Installed `/Applications/TaskWraith.app` reports version `1.9.6`, bundle id
  `com.chrisizatt.taskwraith`, hardened runtime, a Developer ID signature and a
  stapled notarization ticket.
- `xcrun devicectl list devices` reported an available paired physical iPhone
  15 Pro. Pairing alone does not prove the companion build or row E.
- The required static prerequisite was run against `dist/mac-universal`:

  ```text
  TASKWRAITH_REQUIRE_PRODUCTION_SIGNING=1 \
    node scripts/smoke-packaged-electron.cjs dist/mac-universal

  Packaged app contains an unknown or mixed distribution identity/appId/update feed.
  ```

Because the package prerequisite failed, the operator did not schedule an
Ensemble, close the renderer, send workspace content to providers, or claim any
physical-device attention. A new signed candidate with a recorded source commit
must start a new attempt; this blocked artifact must not be relabelled PASS.

Do not cite this record publicly while it says `OPEN`. A future `PASS` block
must name the exact build and all evidence pointers.
