# Repository workflow doctrine

Read this file in full before any repository mutation, formatter use, work-marker or worktree action, staging or commit, or irreversible release action.

## Formatting policy for agents

`npm run format` formats only files you have **staged**. It is scoped on
purpose: concurrent sessions often have unrelated uncommitted work in the
same tree, so formatting the whole working tree would rewrite another
session's in-flight files. `--working-tree` opts into unstaged and
untracked files when you know you are the only session in the tree.
`npm run format:check` is the verifying form, suitable for a CI gate.

Do not run `npm run format:all`, `prettier --write .`, or any repo-wide
Prettier glob. The baseline is ~27% unformatted — 1183 of 4457 considered
files, per `scripts/format-baseline.json` — so a repo-wide write is not a
tidy-up: it is a ~30,000-line mass reformat that rewrites `git blame` for
a thousand files and conflicts with every open branch and fan-out
worktree.

Three files remain in `.prettierignore` because formatting them was proven to
be corruption, not cleanup: `AGENTS.md`,
`src/main/BridgeActionExecutor.test.ts`, and
`src/renderer/src/assets/css/04-settings-controls.css`. Leave all three in the
ignore file. Verified 2026-07-25 by formatting all 2814 tracked files twice and
comparing: pass 3 differs from pass 1, so they do not even oscillate. In the
original monolithic `AGENTS.md`, each pass added two spaces of indentation to
code blocks nested inside list items. The extracted occurrence is protected by
a targeted `prettier-ignore`; that is containment, not authority to change the
three-file ignore policy.

Two CI gates enforce this rather than relying on you reading it:

- `npm run format:ratchet` fails if the number of unformatted tracked
  files rises above the baseline in
  [`scripts/format-baseline.json`](../../scripts/format-baseline.json). It never
  asks for the backlog to be fixed — only that you not add to it. If the
  count drops, lower the baseline in the same commit with
  `npm run format:ratchet -- --write`. (`format:check` is deliberately
  **not** the CI gate: it scopes to staged files, and a CI checkout has
  nothing staged, so it would pass unconditionally.)
- `npm run guard:doctrine-integrity` fails if any agent-read file contains
  invisible or direction-overriding characters — zero-width codepoints,
  Unicode tag characters, or bidi overrides (Trojan Source). `AGENTS.md` and
  the linked doctrine files are routed into agent sessions, so hidden text in
  any of them is an instruction channel that a human cannot see in a diff.

Two rules keep the ratchet honest, because the gate as written can be
satisfied in a way that is much worse than the problem:

- **A file you ADD must be born formatted.** New files have no history, so
  formatting them costs nothing — no `git blame` churn, no conflicts with
  open branches. This is the whole backlog-prevention rule, and skipping it
  is what turns the ratchet red. Verified 2026-07-27: 92 files were added
  in one cycle and exactly 18 of them were unformatted, which was the
  entire regression.
- **Never format a large existing file to pay the ratchet down.** The
  baseline is a _count_, not a set of paths, so the gate cannot tell the
  difference between "you formatted the new file you just added" and "you
  reformatted a monolith to buy headroom for it". The second is the
  cheapest way to make the number go green and the most destructive thing
  you can do to the tree: measured 2026-08-16, `src/main/index.ts` is
  ~58,600 lines and `App.tsx` ~31,700. At the 2026-07-27 measurement
  (48,861 and 30,481) a reformat rewrote ~2,558 and ~3,421 lines
  respectively; both files have only grown since, so treat those rewrite
  counts as a floor. That is thousands of unrelated lines, `git
blame` destroyed across two files everything depends on, and a conflict
  in every open worktree — to satisfy a counter. Fix the file you dirtied.

The same reasoning forbids format-on-touch: editing one line of a large
unformatted file must not reformat the file. Leave the surrounding style
alone.

Note the denominator moves. `consideredFiles` grows as tracked files are
added (2,968 → 3,053 over one cycle), so a red ratchet is not automatically
someone's mistake — check whether newly-added files are the cause before
attributing it, and check whether _your_ touched files changed status
rather than assuming.

None of the above is authority to change what any code does. Formatting
work is formatting only.

Prettier is available for intentional formatting work, but normal code
changes should preserve the surrounding style and format only the files
or regions that were deliberately touched. Use scoped formatting or
targeted `prettier-ignore` comments only when the formatting change is
part of the task.

---

## Concurrent work in this repo

Several agents — Claude, Codex, Cursor, and others — work in this single
checkout at the same time, on unrelated features, with no coordinator. These
rules exist because every one of them has already been violated at cost.

### The one thing to understand first

A work marker is a **promise about the future** ("I am going to keep editing
this"). Promises rot: sessions crash, get reassigned, or finish one task and
silently start another. Git, by contrast, records the **present** and cannot
lie about it. So:

> **Marker absence is absence of evidence, never evidence of quiescence.**

Proven three times in 30 hours: every marker down while a session sat mid-edit
on an uncommitted test; a session that dropped its marker and immediately
picked up new work without re-raising; and a truthful "tree clean, nothing in
flight" report that was false twenty minutes later. In the last case a naive
marker check would have gone green on top of a half-written 17-file feature.

Split the two questions and use the right tool for each:

| Question                                                  | Answer with                                   |
| --------------------------------------------------------- | --------------------------------------------- |
| Is anything uncommitted right now?                        | `git status --porcelain`. **Never a marker.** |
| Is someone about to touch a file that is clean right now? | A marker. This is its only job.               |

### Before you write

1. **`git status --porcelain` first.** If files you intend to touch are already
   dirty, they belong to someone else. Do not edit them, do not stage them, do
   not revert them. Pick different work or ask.
2. **Read any live markers** (`ls -1a | grep -E '^(SHIP-HOLD|\.WORK-IN-PROGRESS|SESSION-IN-PROGRESS)'`).
   Never write that check as a bare `ls A-* B-*`: under zsh a single missing
   glob triggers `nomatch` and aborts the whole command, printing nothing,
   which reads exactly like "no markers". A _decayed_ marker (expired, or its
   pid dead) is not noise — it is work to adopt; see "Adopting a decayed
   claim" below.
3. **Raise your own marker before your first edit to a clean file** — not "when
   you start", which is fuzzy and skippable. First write is the trigger.

### Marker format — it must self-expire

Staleness has to be mechanical, not a judgement call. Name the file
`.WORK-IN-PROGRESS-<slug>.md` at the repo root (untracked, gitignored) with
frontmatter:

```yaml
---
session: <session id>
agent: <provider/model, e.g. claude, codex>
task: <stable human task/chat label — presentation only>
taskId: <opaque task/chat id, when available>
runId: <opaque provider run id, when available>
participantId: <opaque ensemble participant id, when applicable>
laneId: <opaque ensemble lane id, when applicable>
pid: <the long-lived session host pid — ownership is recognized by ancestry from it>
started: <ISO-8601 UTC>
expires: <ISO-8601 UTC — the moment rescuers should move in, not the task's outer bound>
worktree: <path, only if your edits live outside the main tree>
paths:
  - src/main/Thing.ts
---
one line on what you are doing and what you are NOT touching
```

`task` is the durable human breadcrumb for finding the originating transcript;
the opaque IDs disambiguate similarly titled tasks and multi-participant runs.
They are attribution metadata only: none grants authority, extends liveness, or
changes claim scope. Older markers without them remain valid.

**A lease may not exceed 15 minutes, and it is renewed by hand.** Anything
longer is honoured only for its first 15 minutes, measured from `started` — a
claim is clamped, not voided, so a typo costs you the tail of a lease rather
than all your protection. Renewing means re-stamping **both** `started` and
`expires`; bumping `expires` alone changes nothing, because the ceiling is
anchored to the start. A lease over the ceiling with **no readable `started`**
cannot be bounded at all and is treated as decayed.

**If your claim carries `lockOwnerId:`, re-read the id and re-stamp that too.**
It is scoped per _run_, which means per _turn_: the value your seat carried when
you raised the marker is not the value it carries now. Renewing the two clock
fields and leaving a stale id behind is the worst of both worlds — measured, it
blocks _your own_ commit on _your own_ claim, and does so for as long as you
keep faithfully renewing the lease. Re-run `printenv TASKWRAITH_LOCK_OWNER_ID`
at each renewal, not just the first time.

Consequences to plan around rather than be surprised by: your claim will lapse
during any long stretch of thinking, testing or reviewing, and a lapsed claim is
**adoptable** — another agent is entitled to harvest its paths. Re-stamp before
a long operation, not after it, and re-stamp before your final commit if the
work ran long.

A reader treats a marker as **blocking** only if it is still held _and_ the
clock is inside its effective (capped) `expires`; otherwise it is advisory. "Held" means a live pid,
or a matching `lockOwnerId` (below) when the claim carries no pid. That way a
crashed or forgotten claim decays on its own instead of blocking the tree
forever. The pid half is the same liveness model the credential authority uses
(owner pid plus process birth identity) — copy it rather than inventing another.

#### When a pid will not hold your claim — TaskWraith seats

This exception applies to **TaskWraith seats only**. An external or interactive
agent does not need `TASKWRAITH_LOCK_OWNER_ID`: when it has a stable,
long-lived session-host PID, use that normal `pid:` field. The hook recognises
the claim when that PID is an ancestor of `git`; do not add an invented
`lockOwnerId:` just because the environment variable is absent. Without a
stable ancestor PID, coordinate instead.

**Use `lockOwnerId:` instead of `pid:`** — the _exact_ value of
`TASKWRAITH_LOCK_OWNER_ID`, which main stamps into your seat's environment at
launch. Read it; never invent one. It is an opaque id, so a human-readable
stand-in (`lockOwnerId: MySeatName`) matches nothing at the hook — while
`work-guard` still counts the field as a held lease, so the two tools then
contradict each other over your own claim. Verify it in the same shell you will
commit from, because that is the environment the hook reads:

```bash
printenv TASKWRAITH_LOCK_OWNER_ID
```

```yaml
---
session: <session id>
agent: <provider/model>
lockOwnerId: <the exact value of $TASKWRAITH_LOCK_OWNER_ID>
expires: <ISO-8601 UTC — short lease, renew it>
paths:
  - src/main/Thing.ts
---
```

**Why, precisely** — because the reason matters for choosing between them. It is
_not_ that a seat cannot see pids: TaskWraith imposes no OS sandbox on any seat,
and the hook's own ancestry walk runs inside seat-invoked commits. The problem
is that a seat has no _stable, long-lived_ pid to record. Each shell invocation
is a fresh transient process, and a provider host pid can rotate underneath a
running session — observed 2026-08-06, a session's marker decayed twice in one
evening when its Claude host pid rotated, silently un-claiming its files while
it was still working. A pid you cannot keep alive is worse than no pid, because
it decays without telling you.

That id is issued at the narrowest execution boundary available — it is scoped
to `runId + laneId + participantId` (`src/main/WorkspaceLockExecutionIdentity.ts`),
so it identifies **your seat alone**, not your thread. A thread-wide marker is
the wrong shape: it claims far more than you are editing and collides with work
done outside TaskWraith in the same checkout.

Not every shell you can reach carries it. It is stamped into the seat process
itself, so commands your provider runs natively inherit it — but TaskWraith's
brokered `run_shell_command` rebuilds its environment from scratch and strips
the key deliberately, and so does `run_task`. Commit from a shell where the
`printenv` above prints your id, or the hook cannot tell your claim from a
peer's.

If no owner id was stamped for a TaskWraith seat,
`TASKWRAITH_LOCK_OWNER_ID` is absent rather than empty. That seat then has
neither safe identity — say so and coordinate in the open rather than raising a
marker that claims nothing. This is not the external-agent case: an external
agent with a stable session-host PID uses `pid:`, not `lockOwnerId:`.

Ownership is exact string equality against the env var, so an absent or empty
`TASKWRAITH_LOCK_OWNER_ID` never matches anything. Either field alone is enough;
supply both if you have both.

**With no pid there is no process to probe, so `expires` is the only decay
signal your claim has.** A missing or unparseable `expires` is treated as
decayed — the marker claims nothing — precisely so a dead seat cannot wedge the
tree forever. Keep the lease short and renew it.

The runtime-derived markers (`.WORK-IN-PROGRESS-taskwraith-runtime-*.md`) are
**not** a substitute: those are projected while a durable write lease is held
and released with it, so they exist for seconds. They serialise a mutation;
they cannot say "I am working on these files for the next two hours."

Read the two liveness signals **asymmetrically**. `expires` is the authority:
past it, the claim is decayed no matter what the pid says. The pid exists only
to decay a claim _early_ when a session dies; it can never extend one.
Interactive CLI hosts (a `codex` or `claude` REPL) routinely sit alive and
idle long after their session's work has ended — proven 2026-07-28, when a
finished session's pid stayed up for four hours past expiry and read as
"still working" to the next agent. Pid-alive means nothing; pid-dead means
dead.

Runtime-derived markers (`derived: true`, `agent: taskwraith-runtime`) are the
one deliberate exception. They project a durable lock rather than a human
promise, and the runtime owns their removal. Expiry or a dead projected pid
never makes one adoptable: a launching process may outlive main, and a direct
child may leave descendants. The git hook therefore fails closed until the
durable authority removes or reconciles the projection; the exact opaque owner
id is its only normal bypass. Restart TaskWraith to reconcile a dead runtime
owner, and use the explicit recovery path rather than deleting the marker.
Manual markers retain the expiry-authoritative rule above.

Size `expires` accordingly: it is when you would _want_ someone to move in if
you went silent. Take an hour and **renew** (rewrite the marker with a later
`expires`) when you need more, rather than taking an afternoon up front and
going dark inside it. A lease that outlives the work by hours is how an
abandoned claim impersonates a live one.

Drop your marker in the same breath as your final commit — before the host
process goes idle, not "at the end of the session"; an idle-but-alive host is
exactly what makes an abandoned claim look owned. If you finish one task and
pick up another, **re-raise** — the old marker does not cover new work. And if
your in-flight edits live anywhere but the main tree, say where with
`worktree:` — a claim that decays with finished work stranded in an unnamed
worktree forces the next session to go spelunking. The 2026-07-28 harvest
recovered a completed, uncommitted fix only because the worktree happened to
share the marker's slug.

### Adopting a decayed claim

A **manual** marker whose `expires` has passed or whose pid is dead is not noise
to step around — its lane is **adoptable**, and adoption has its own small
protocol. Runtime-derived markers are excluded: restart TaskWraith and use its
exact recovery path instead of adopting or deleting them.

1. **Confirm decay.** Expired, or `kill -0 <pid>` fails. An alive pid past
   expiry is still decayed (see above). Prefer `npm run work-guard`, which
   reads all three signals together — a stale pid or a passed expiry does
   **not** mean decayed if the claim's own files are still being written.
2. **Hunt for stranded work before your first edit.** Check the marker's
   `paths:` in `git status`, and check its `worktree:` (or `git worktree list`
   for the marker's slug). A session that died mid-task leaves half-done work;
   one that finished and never landed leaves _complete_ work. Both are worth
   more than your re-derivation of them.
3. **Land or explicitly discard what you find — never silently duplicate it.**
   Credit the originating session in the commit message: its work, your
   landing.
4. **Clean up.** Delete the marker and remove any harvested worktree. Deleting
   a _decayed_ marker is part of adoption; deleting a _live_ one is still
   forbidden — `TW_ALLOW_CLAIMED=1` exists for a live claim you know to be
   wrong.

### Prefer a worktree; it cannot go stale

For anything larger than a quick fix, work in a `git worktree` on its own
branch. Collision becomes structurally impossible, and `git worktree list` is
a registry that reflects reality rather than intent, so it cannot drift. This
is strictly better than any marker and is already normal here. When a task is
explicitly out of the current release, a worktree is the answer, not a marker.

### Committing

- **Stage by explicit path. Never `git add -A`, `git add .`, or `-u`.** Other
  sessions' files live in this tree and bulk staging sweeps them into your
  commit. Diff-audit what you staged before committing.
- **In a large shared file, commit a hunk subset through a PRIVATE index — not
  `git add -p`.** Staging a monolith wholesale takes _every_ change in it,
  including hunks another session left there mid-edit; you then commit their
  half-written work under your message and they lose it on their next checkout.
  `index.ts` is ~49k lines and `App.tsx` ~30k: assume someone else is in there.

  `git add -p` looks like the answer and is not, because neither completion is
  safe. A **pathspec** commit runs in `--only` mode and rebuilds the tree from
  HEAD plus the **working-tree** content of the named path — it discards your
  hunk selection and commits the foreign hunk anyway (measured 2026-08-05: the
  index held one hunk, the commit landed both). A **bare** commit takes the
  whole **shared** index, sweeping whatever a concurrent session has staged.
  `git add -p` is also interactive, which most agent harnesses cannot run.

  Do this instead, which never reads or writes the shared index:

  ```bash
  rm -f /tmp/c.idx; export GIT_INDEX_FILE=/tmp/c.idx
  git read-tree HEAD
  git apply --cached your-isolated-hunks.patch
  git diff --cached          # PROVE only your hunks are there
  git commit -F msg          # bare is safe: the index is private
  unset GIT_INDEX_FILE
  git restore --staged -- <your paths>   # re-sync the shared index, NOT optional
  ```

  To _produce_ the isolated patch without hand-splitting `@@` blocks, make your
  edits in a detached worktree at HEAD (`git worktree add --detach <scratch>
HEAD`) and `git -C <scratch> diff` — that tree holds only your changes.
  The remainder staying unstaged in the shared tree afterwards is the expected,
  healthy state during a hot session.

- **Never `git stash`** while another session may be live — it pockets their
  uncommitted work too.
- Do not revert, format, or "tidy" a file you did not change.
- If a shared file (`index.ts`, `store/types.ts`, `App.tsx`) is dirty when you
  need it, that is a collision: coordinate rather than merging blind.

### Before anything irreversible

Publishing, tagging, and force-pushing require all of:

1. no live markers,
2. `git status --porcelain` shows nothing you do not own, and
3. no other session committed in the last few minutes or is still running.

Also confirm what you are about to tag is actually pushed —
`git rev-list --count origin/master..master`. A commit can be built from,
verified locally, and tagged while origin has never seen it.

### The hook, for the agent who never read this file

Docs bind only the agents that read them, so the load-bearing checks also run
at the git layer, which every provider goes through:

```bash
npm run hooks:install        # git config core.hooksPath .githooks
```

[`.githooks/pre-commit`](../../.githooks/pre-commit) **blocks exactly two things.**
The first is staging a path claimed by another owner. A manual claim blocks
only while its pid is alive and its expiry has not passed; a valid
runtime-derived claim
blocks until durable authority removes it, regardless of projected pid or
expiry. The second is force-adding a gitignored path into this public repo.
Everything else advises: whole-file staging of a >5,000-line file,
forty-plus staged paths, your own claim still being up, and a decayed manual
claim still standing (adopt or delete it). Two blocks and otherwise quiet is
deliberate; a hook that cries wolf gets disabled, and a disabled hook protects
nothing.

`TW_ALLOW_CLAIMED=1 git commit …` overrides a claim you know to be wrong. Use
it rather than deleting someone's marker.

`TW_ALLOW_IGNORED_ADD=1 git commit …` overrides the gitignored-add block. This
is not exotic: `docs/` is ignore-by-default with ~187 files force-tracked
individually, so a plain `git mv` of an already-tracked doc trips it — the
destination reads as a brand-new ignored path. Before overriding, prove you
are not publishing anything new (`git show HEAD:<oldpath>` should match the
new file, and the old path should already be tracked). The hook logs an
`override:` line either way.

Hooks are not cloned by a fresh checkout and only fire at commit time, so this
is a backstop, not a guarantee — the rules above still stand on their own.

### The clock, for the hours between commits

Everything above is edge-triggered on `git commit`: the hook, "raise your
marker before your first edit", "drop it in the same breath as your final
commit". On 2026-07-30 every failure happened in the gaps. One session sat
**~11 hours on 8,600 uncommitted lines without a single commit**, so the hook
was never invoked once and its marker's scope list was the only trace; a
visible bug shipped in 1.9.1 because its fix was uncommitted the whole time;
and a marker decayed while its session was demonstrably still working. That is
one defect, not three — **nothing ran between commits.**

[`scripts/work-guard.cjs`](../../scripts/work-guard.cjs) is the clock. It is
read-only with respect to shared state: it never writes the index, the working
tree, another session's marker, or any branch, and it never pushes.

```bash
npm run work-guard           # who is live, what is unclaimed, snapshot count
npm run work-guard:check     # exit 1 on aged unclaimed work — use before a tag
```

**Unclaimed dirty work is the alarm.** The question it answers is the one no
marker can: _is there dirty work that nobody has promised to finish?_ That
needs no attribution — you never have to work out whose file it is. A path is
orphaned when it is dirty and no **live** claim covers it, and a decayed claim
covers nothing, which is exactly how the 8,600-line case would have surfaced
within the hour instead of the next day.

**Snapshots make loss impossible.** Every tick commits the whole working tree
to `refs/wip/<timestamp>` — tracked edits, other sessions' staged work, and
untracked files, plus the markers themselves so a dead session's intent
survives with its diff. Nothing is pushed and nothing appears in `git status`,
`git log`, or `git branch`. To recover:

```bash
git for-each-ref --format='%(refname) %(committerdate:relative)' refs/wip/
git show refs/wip/<stamp>:path/to/file
git checkout refs/wip/<stamp> -- path/to/file
```

**Provenance makes stranded work traceable.** TaskWraith's broker writes an
immutable local receipt for an exact verified file/hunk edit, including its
before/after fingerprint and opaque task/run/participant identity. Opaque native
provider runs can produce only a weaker run-bound observation. When a marker
vanishes while matching dirty bytes remain, work-guard retains a tombstone and
records the weaker marker correlation instead of dropping the last breadcrumb.
None of these receipts contains transcript text, diff bodies, file contents, or
secrets; they live under the repository's Git common directory and are never
committed or pushed.

The first observed dirty state is retained separately from the marker's final
state. If a path was already dirty when the marker appeared, closing or adopting
that marker does not silently award the pre-existing bytes to the new task: the
projection preserves the known predecessor, or emits an explicit unattributed
pre-existing contributor when no earlier receipt exists.

Confidence is explicit and must not be inflated: `exact`, `observed-native`,
`correlated-claim`, `ambiguous`, or `unknown`. Multiple contributors are retained;
there is no “last marker wins” blame. Marker disappearance is only an observation,
never proof that work was resolved. Clean/committed/reverted bytes resolve the
matching origin; a later defensible contributor can adopt or supersede it.

```bash
node scripts/work-guard.cjs provenance
node scripts/work-guard.cjs provenance --json --limit=200
```

The JSON form is the supported, versioned, bounded read-only projection for local
tools such as Observatory. One invocation describes one canonical Git worktree.
It brackets HEAD/status/numstat/fingerprints into a coherent generation and
partitions every dirty path exactly once into unique, shared/ambiguous, or
unclaimed/unknown totals; raw marker-scope totals may overlap and are secondary.
Read-only Git sampling disables repository fsmonitor execution and optional index
locks, and provider-seam receipt capture has a hard deadline: accountability may
lose evidence, but it may never run workspace-controlled hooks or retain edit
ownership while waiting on audit I/O.
Each unresolved origin pins the whole-tree recovery
commit under `refs/taskwraith/work-provenance/`; resolution releases that pin.
The projection returns both the friendly ref and immutable commit/tree IDs, so a
consumer can distinguish “recorded” from “still recoverable.” Provenance is
additive assurance only: receipt/query failure must never grant authority, retain
a workspace lock, deny a provider, cancel a run, or change a user-approved
permission posture.

Note that `git stash create` is **not** what this uses: measured on git 2.49.0
it does not capture untracked files, which is precisely where new work lives.
The tree is built through a throwaway `GIT_INDEX_FILE`, which is why the real
index comes back byte-identical.

**The heartbeat stops false decay.** `lastSeen` is _derived_ — the newest mtime
among the dirty files a marker actually claims, plus a live pid — and it lives
in a sidecar (`.work-guard/heartbeat.json`), never inside the marker, so the
timer never writes a file another session owns. A claim is live when its
heartbeat is fresh **or** the old pid-and-expiry rule says so, which is what
kept all three of today's false decays from mattering: a pid recorded from a
subshell, a host process that died mid-session, and an `expires` guessed too
short. A marker carrying no heartbeat behaves exactly as it did before, so
claims written before this existed are unaffected.

It does **not** join the `ci` chain, deliberately: CI checks out clean and has
no sessions or markers to reason about. It is local concurrency tooling, and a
green CI run says nothing about it.

---

## Composition-root growth policy

Do not add code to the three composition-root monoliths —
`src/main/index.ts`, `src/renderer/src/App.tsx`, and
`src/main/services/EnsembleOrchestrator.ts` — when the logic can live in an
extracted module instead (`src/main/ipc/*`, service modules, renderer
`app/`/`lib/` modules). Prefer wiring: the monolith gets one
import/registration line; the logic gets its own file and its own test.

CI does not block on their size. Post-hoc line/branch budgets existed briefly
and were removed on 2026-07-21 by user decision: a gate that rejects a diff
_after_ the growth already happened only manufactures friction. This note is
the pre-write guard that replaced them — apply it while planning an edit, not
after the diff exists.

---
