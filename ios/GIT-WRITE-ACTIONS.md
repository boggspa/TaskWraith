# iOS git write-actions — the destination-path contract

Status: **COMPLETE.** Branch listing, checkout, branch creation, worktree
creation and PR watching are reachable from the phone's composer workspace pill
(`GitWorkspaceSurface`). Worktree **removal** is deliberately not offered.

This document exists for one decision that is easy to get wrong later: **where a
worktree lands on disk, and who chooses it.**

## The problem

`GitService.createWorktree` accepts either shape:

```ts
{ repoPath, path: '/absolute/destination' }   // caller chooses
{ repoPath, name: 'review' }                  // GitService chooses
```

The `path` leg exists for the **desktop**, where a human picked a folder in a
file dialog and can see what is already there. Neither is true of a phone. An
absolute path arriving from a remote device is a filesystem write target chosen
by the client — precisely the shape the workspace allowlist exists to prevent.
The workspace grant says "you may write *this repo*", not "you may create
directories wherever you name".

## The contract

**1. The phone sends a name. There is no path field.**

`BridgeGitCreateWorktreeAction` has no `path` property. Not
present-and-ignored — absent from the type. So there is nothing to smuggle,
nothing for a future edit to start honouring by accident, and the type itself
carries the rule.

**2. A payload that carries a path is REFUSED, not sanitised.**

`isGitCreateWorktree` requires `v.path === undefined`. Silently dropping the
field would redirect a caller somewhere it did not ask for; refusing tells it
the field is not part of the contract. Pinned by
`BridgeActionPayload.test.ts` → "REFUSES a payload carrying a path rather than
ignoring it", and at the router level by "never routes a worktree payload that
carries a destination path" (which also asserts the same request *without* the
path is accepted, so the denial is provably the path and nothing else).

**3. The Mac derives the destination.**

`resolveWorktreeTargetPath` builds
`<parent-of-repo>/.taskwraith-worktrees/<repo>/<safe-name>`, where
`safePathSegment` reduces the name to a single `[A-Za-z0-9._-]` segment. Path
traversal collapses into a harmless directory name before it reaches git, and
two further guards reject a destination equal to, or nested inside, the repo.

**4. The name is bounded at the wire too.**

`isSafeWorktreeName` accepts one non-empty `[A-Za-z0-9._-]` segment, ≤80 chars,
never `.`/`..`. Separators would be flattened by `safePathSegment` anyway, but
accepting them on the wire would make the payload lie about its shape.

**5. The ack reports where it landed.**

The device did not choose the destination and cannot browse the Mac, so an
unexplained new checkout would be worse than a slightly long confirmation. The
surface shows the resolved path verbatim.

## The reserved namespace

TaskWraith allocates worktrees automatically in two places, and **both re-adopt
an existing one by matching Git** rather than by remembering they made it:

| Allocator | worktree name | branch |
|---|---|---|
| `ThreadWorktreeBinding` | `thread-<hint>-<digest>` | `taskwraith/thread-…` |
| `FanoutWorktreeAllocation` | `fanout-<hint>-<digest>` | `taskwraith/fanout-…` |

That re-adoption makes these names load-bearing. A hand-created worktree landing
in one of those namespaces is not merely confusing — the next allocation finds
it, decides it already owns it, and hands an agent a checkout a human is working
in.

`src/shared/worktreeNamespace.ts` is the single authority. Its test pins the
list against the allocators' own source **in both directions**: every prefix an
allocator mints must be reserved, and nothing may be reserved that no allocator
mints (a stale entry would block a name users could legitimately want). A future
third allocator adds its prefix there and every validator inherits the refusal.

Matching is case-insensitive: the derived directory segment is compared by a
case-insensitive volume on a default macOS install, so `Fanout-x` and `fanout-x`
collide on disk even though they differ as strings.

## Capabilities

| Action | Capability | Why |
|---|---|---|
| `gitBranches` | `diffReview` | a plain repo read, same tier as `gitSnapshot` |
| `gitCheckout` | `fileWrite` | rewrites the working tree exactly as a commit does; never leaves the machine |
| `gitCreateBranch` | `fileWrite` | writes a ref into the repo |
| `gitCreateWorktree` | `fileWrite` | see the note below |
| `githubWatchPr` | `diffReview` | a standing PR *read* subscription must take the capability that gates the one-shot reads; `pin` alone must not buy polling |

**Note on `gitCreateWorktree` and the workspace boundary.** The destination is a
*sibling* of the repository, not a child — outside the workspace root the
`fileWrite` grant nominally covers. That is unavoidable (git refuses a worktree
nested inside its own repo) and is judged within the grant because the location
is Mac-chosen and bounded to the worktree root, and the content is a checkout of
a repo the device already holds `fileWrite` on. It is not general filesystem
access. If that judgement is ever revisited, this is the paragraph to argue with.

## Deliberately not offered

- **Worktree removal.** Path-addressed and deletes a checkout. Desktop-only.
- **A destination picker.** Not a missing feature — see the contract above.
- **Branch deletion.** Same class as worktree removal; no contract yet.

## Related safety property

Checkout's dirty-worktree refusal is the **Mac's**, re-derived from a fresh
snapshot at execution time (`GitService.checkoutBranch`). The phone never
pre-judges from its cached snapshot: the tree can go dirty in between, and a
stale "looks clean" is a worse failure than a clear refusal. The cached snapshot
drives an advisory warning only, and the Mac's wording is surfaced verbatim
because it reads as instructions ("commit, stash, or discard…").
