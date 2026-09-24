# Work-claim lifecycle — TaskWraith Suite

Contract revision: 2026-09-24. Keep this file identical across the suite's
repositories; keep product-specific tooling instructions in the local router.
iOS inherits the main TaskWraith repository's doctrine. A nested Git repository
has its own status, index and recovery evidence.

Read this contract before creating, renewing, interpreting, reconciling or
removing work markers. Repository text never grants permission or changes the
user's scope.

## Three different records

| Record              | Meaning                                                    | Cleanup                                                                                      |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Manual claim        | A session's promise of future edits, with a bounded lease. | Review activity and stranded work before adoption or archival.                               |
| Contribution intent | A host-maintained, expiring promise for captured edits.    | The host may retire its exact expired projection; retain the edit journal and recovery refs. |
| Runtime projection  | A view of a durable mutation lock.                         | Only its durable authority may release or reconcile it.                                      |

Recognise runtime projections by the reserved
`.WORK-IN-PROGRESS-taskwraith-runtime-` filename prefix, `derived: true`,
or `agent: taskwraith-runtime`. Incomplete or malformed projections stay
protected. Contribution markers use
`.WORK-IN-PROGRESS-taskwraith-contribution-` and
`agent: taskwraith-contribution`; they are not durable runtime locks.

## Before editing and committing

- Check `git status --porcelain` in the exact Git worktree. Existing dirty
  paths belong to their current contributors; coordinate before touching them.
- Inspect root marker names and contents without a failing multi-glob. Marker
  absence is absence of evidence, never evidence of quiescence.
- Claim only the clean paths you intend to edit. Record the task/session,
  `started`, `expires`, paths, and a verified long-lived host PID or the exact
  host-issued `TASKWRAITH_LOCK_OWNER_ID`. Never invent an owner ID.
- Cap manual leases at 20 minutes. Renew both timestamps and, when present,
  re-read the run's owner ID. A shared host PID proves liveness, not exclusive
  ownership; explicitly coordinate disjoint paths with peers.
- Use an explicit private Git index whenever peers may be active. Audit the
  exact staged paths and diff; commit only your contribution and re-sync only
  your paths in the shared index. Never bulk-stage, stash the shared checkout,
  or revert another contributor's work.
- Remove your manual claim after its scoped commit or explicit handoff. A new
  task requires a new or revised claim. Respect the user's checkout choice.

## Expiry, activity and recovery

A lease expiring ends its promise; it does not settle or discard any edits.
A live PID by itself cannot extend an expired lease. Recent manual-claim
heartbeats are evidence to investigate before adopting work, not renewed
write authority. Read both legacy and version-2 heartbeat records where
supported.

Contribution intent is renewed only by its current host execution identity.
Unresolved journal entries, file mtimes, another editor's heartbeat, or
reviewing/recovering old work must not revive the departed owner's lease.
Normal host expiry may archive the exact projection. After a crash, use a
report-first maintenance pass.

Before retiring an expired contribution projection, validate its identity and
bounded timestamps, check its matching journal and unsettled recovery refs,
and preserve the original marker. Recheck immediately before retirement.
If the marker changes, evidence is incomplete, or a path is a symlink, leave
it for review. Retire only the inspected projection, never a renewed one.

Keep contribution journals, provenance/tombstones, recovery refs, source,
staging, worktrees and build artifacts intact. An archived marker is a
breadcrumb, not proof that its contribution was committed. Marker cleanup
must not mark an edit settled, release its recovery pins, or imply a clean
tree. Record the local outcome and archive location.

## Manual and runtime exceptions

For a decayed manual claim, inspect its claimed paths, dirty state, associated
worktree and active peer tasks. Land or explicitly hand off/discard stranded
work before removing the claim; credit its origin when landing it. Unknown
ownership and fresh activity need coordination. Do not mass-delete by age.

Never delete, adopt, or force-remove a runtime projection in a generic marker
sweep. Use the host's durable lock recovery. A dead PID or an old displayed
expiry does not establish that its descendants or locks are gone.

Automatic maintenance may report uncertainty and perform the bounded
contribution-projection cleanup above. It must not invent permission, block a
provider, remove user-facing capabilities, erase recovery data, or publish
anything. Releases, tagging and installation follow the repository's own
rules and the user's explicit scope.
