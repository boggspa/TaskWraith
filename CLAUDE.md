# CLAUDE.md — TaskWraith / AGBench

**Several agents share this one checkout at the same time.** Files you did not
touch being dirty is normal, not a problem to clean up. Everything below exists
because this tree is shared; none of it is optional.

This file exists because Claude does not read `AGENTS.md`. `AGENTS.md` is the
full doctrine (Codex picks it up by its own convention) — **read it before any
release, security, provider, or ensemble work.** What follows is only the part
you need before your first edit.

## Before you write

1. **`git status --porcelain` first.** Files you intend to touch that are
   already dirty belong to someone else. Do not edit, stage, or revert them.
   Pick different work or ask.
2. **Read the live markers.**
   ```bash
   ls -1a | grep -E '^(SHIP-HOLD|\.WORK-IN-PROGRESS|SESSION-IN-PROGRESS)'
   ```
   Never write this as a bare `ls A-* B-*`: under zsh one missing glob triggers
   `nomatch`, aborts the whole command, and prints nothing — which reads exactly
   like "no markers". A _decayed_ marker (expired, or its pid dead) is not
   noise; it is work to adopt. See AGENTS.md.
3. **Raise your own marker before your first edit to a clean file** — not "when
   you start", which is fuzzy and skippable. First write is the trigger.

## Marker format — the `---` delimiters are load-bearing

Name it `.WORK-IN-PROGRESS-<slug>.md` at the repo root (untracked, gitignored).

```yaml
---
session: <session id>
agent: claude-opus-5
task: <short human label>
pid: <your LONG-LIVED session host pid, not $$ — ownership is by ancestry>
started: <ISO-8601 UTC>
expires: <ISO-8601 UTC — at most 15 minutes after started>
paths:
  - src/main/Thing.ts
---
one line on what you are doing and what you are NOT touching
```

**A lease caps at 15 minutes and is renewed by hand.** A longer one is honoured
only for its first 15 minutes from `started`, so it is clamped rather than
voided. Renew by re-stamping **both** `started` and `expires` — bumping
`expires` alone does nothing, since the ceiling anchors to the start. Expect it
to lapse during long thinking, test runs or reviews, and remember a lapsed claim
is **adoptable**: re-stamp _before_ a long operation, and again before your
final commit if the work ran long. **If your claim uses `lockOwnerId:`, re-read
that value and re-stamp it at every renewal too** — it is scoped per run, so it
changes every turn, and renewing only the clock fields blocks your own commit on
your own claim for as long as you keep renewing.

**Without the opening and closing `---`, every field parses empty** — pid,
expires, and the whole `paths` list — so the marker claims _nothing_. Two live
markers were in exactly that shape on 2026-08-06, one of them otherwise
perfect. A marker also claims nothing if its pid is dead, its `expires` has
passed or cannot be parsed, or a path does not match **exactly**.

**If you are a TaskWraith seat, a pid will not hold your claim.** Not because
you cannot read one — you can — but because you have no _stable_ one: each shell
invocation is a fresh process, and a provider host pid can rotate mid-session,
silently decaying your marker while you are still working. Use
`lockOwnerId: <$TASKWRAITH_LOCK_OWNER_ID>` in place of `pid:` — main stamps that
variable into your seat at launch, scoped to your seat alone (run + lane +
participant), not your thread. Read the value; never invent one, because an
opaque id you made up matches nothing at the hook while still reading as a held
lease to `work-guard`. Check it in the shell you will actually commit from
(`printenv TASKWRAITH_LOCK_OWNER_ID`): the brokered `run_shell_command` and
`run_task` rebuild their environment and strip it. If it is absent, you have
neither identity: say so and coordinate in the open rather than raising a marker
that claims nothing. Do not fall back to one thread-wide marker: it
claims far more than you are editing and collides with work done outside
TaskWraith in the same checkout. With no pid, `expires` is your claim's only
decay signal, so keep the lease short and renew it. Either field alone is
enough; supply both if you have both.

Verify yours parses rather than eyeballing it:

```bash
awk '$0=="---"{if(!f){f=1;next}exit} f' .WORK-IN-PROGRESS-<slug>.md
```

Delete your marker in the same breath as your final commit. If you drop it and
then start something else, re-raise it before the next edit.

## Committing

- **Stage by explicit path. Never `git add -A`, `git add .`, or `-u`.**
- **Commit with a pathspec:** `git commit -F msg -- <your exact paths>`. The
  `--only` default ignores whatever else is staged, and is structurally immune
  to sweeping another session's work in _or_ reverting it.
- **Never bare-`git commit`** while another session may be active — it takes the
  whole shared index, including files a peer has staged.
- **`git diff --cached --stat` immediately before every commit.** An unexpected
  file count or a large negative delta means you swept someone in. Scan for
  `Bin` on a text file too: a stray NUL makes a file binary and `tsc` + tests
  both still pass.
- **A hunk subset of a shared file needs a PRIVATE index — `git add -p` cannot
  do it.** A pathspec commit re-reads the working tree and discards your hunk
  selection; a bare commit takes the shared index. See AGENTS.md for the
  `GIT_INDEX_FILE` + `git apply --cached` sequence.
- **Never `git stash`,** not even as a probe or a dry run. It pockets every
  other session's uncommitted work, and `stash pop` can refuse to give it back.
- **Never `git push`** unless asked in the current turn. Pushes are batched per
  release, and this repo is PUBLIC.
- Do not revert, format, or tidy a file you did not change.

## Also

- `.local-only/` holds separate private repos. Never stage a path under it.
- `npm run typecheck:node` / `typecheck:web`; the repo tolerates pre-existing
  prettier and lint noise — fix only what your own edits introduce.
- `.githooks/pre-commit` is advisory except for two conditions: staging a path
  another live session claims, and force-adding a gitignored path. Read its
  notes; they are the cheapest coordination signal you get.
