# Session and Workspace Orchestration

TaskWraith coordinates **provider sessions** (history, forks, caching) and
**git workspaces** (branches, worktrees, isolation) so multi-agent work stays
inspectable on your machine. This page describes prompt caching guarantee
tiers, universal forks, and worktree orchestration — including honest limits
where a provider or CLI does not expose native controls.

## Prompt caching (BYOK and API paths)

TaskWraith tracks **cache read** and **cache creation** tokens in Model Usage
when a provider reports them. This release adds a **guarantee tier** per
provider transport so you can see what TaskWraith can enforce versus what is
best-effort or opaque.

### Guarantee tiers

| Tier | Settings badge | Meaning |
| --- | --- | --- |
| **Guaranteed** | Guaranteed | TaskWraith owns the API/BYOK request and can apply cache policy (`off` / `auto` / `explicit`) on stable prompt prefix blocks when the transport is controllable. |
| **Automatic** | Automatic | Provider-managed implicit caching. TaskWraith observes cache hits in usage metadata but cannot force breakpoints. |
| **Best effort** | Best effort | Opaque CLI or subscription session. Cache tokens appear only when the CLI emits them — not guaranteed. |
| **Unsupported** | Unsupported | No provider-side prompt caching on this transport (for example local Ollama). |

TaskWraith **does not claim** uniform provider-side prompt caching on every BYOK
path. Opaque CLI transports cannot be forced to cache a stable prefix the way
an owned API request can.

### Settings

Open **Settings → Providers** and scroll to **Prompt caching**:

- Global enable/disable for cache policy.
- Per live provider **mode** (`off`, `auto`, `explicit`) where mode control is
  supported for your auth transport.
- A **guarantee badge** and detail line per provider summarizing the strongest
  applicable transport (API/BYOK vs CLI).
- Optional **diagnostics** from recent runs: cache read vs creation tokens and
  input totals when reported.

Runtime profile **secret env refs** inject encrypted env vars at launch; pair
them with the provider's API path and caching settings — secret refs alone do
not enable caching.

### Stable prefix vs dynamic suffix

When TaskWraith applies caching on a controllable API path, it targets
**stable** blocks (runtime preamble, tool/MCP declarations, system instructions)
and keeps **dynamic** blocks uncached (latest user prompt, rolling conversation
context, goal/todo injections). Prefix bytes must stay stable across turns for
providers to report cache hits.

### Caveats

- **CLI login paths** (Codex, Claude Code, Kimi, Cursor, Grok) are **best
  effort** — TaskWraith cannot force caching inside a closed CLI.
- **Claude Agent SDK / Claude Code** may not expose raw Messages API
  `cache_control` even in BYOK mode; guarantee tier reflects what TaskWraith
  can honestly control on that transport.
- **Implicit provider caching** on some API stacks is **automatic / observed**
  only — hits show in usage metadata, not via TaskWraith breakpoints.
- **Retired providers:** Gemini is not selectable for new runs; historical chats
  may still show legacy usage rows. Do not expect new Gemini-specific features.
- **Cost projection:** Cached-input pricing depends on rate tables **and**
  reported cache tokens; opaque paths may under-report.
- **Minimum token thresholds:** Providers may ignore caching below their own
  minimum prefix sizes even when TaskWraith requests it.

See also [Advanced Optional Setup — API Keys](ADVANCED_OPTIONAL_SETUP.md#api-keys)
and [Architecture — Provider orchestration](ARCHITECTURE.md#provider-orchestration-caching-forks-worktrees).

## Universal forks

**Fork** starts a new conversation branch from the current thread while
preserving a link back to the parent session. Use it to explore an alternative
approach without losing the original timeline.

### Capability modes

| Mode | Label in UI | Behavior |
| --- | --- | --- |
| **Native** | Fork (native) | Provider exposes a first-class fork API. Today: **Codex** via `thread/fork`. TaskWraith calls the native fork and stores linked session metadata. |
| **Emulated** | Fork (emulated) | TaskWraith duplicates transcript/session metadata into an **isolated sibling chat** (or linked sub-thread where policy allows). Not a provider-native fork. |
| **Unsupported** | Fork unavailable | Fork is not offered for this provider. |

### UX

- Slash command: **`/fork`** in the composer (slash-command picker describes
  native vs emulated for the active provider).
- Inspector / thread controls use the same capability summary.
- **Codex** is the only provider with true native fork support today. Claude,
  Kimi, Cursor, Grok, and Ollama use **emulated** fork fallbacks until a
  provider adds native fork APIs.

Emulated forks preserve TaskWraith audit and workspace boundaries; they do not
merge provider-native session state the provider never exposed.

## Worktree and branch orchestration

The composer **above row** (Create PR strip) shows workspace, branch, commits
ahead, diff stats, and changed files. This release adds interactive branch and
worktree controls.

### Branch popover

Click the **branch** value in the above row to open a popover with:

- **Existing branches** — local refs; stale/deleted refs filtered where possible.
- **Create branch** — new branch from current HEAD (blocked when the tree is dirty).
- **Checkout** — switch branch with the same dirty-tree guards as Create PR.
- **Worktrees** — list, create, select, or remove isolated worktrees when git
  worktree IPC is available.

If git branch/worktree APIs are unavailable (older build), the popover shows a
clear unavailable state instead of failing silently.

### Runtime profile `workspaceMode: worktree`

**Settings → Runtime profiles** includes `workspaceMode`:

- **`local`** — run against the workspace checkout directly (default).
- **`worktree`** — TaskWraith resolves an effective checkout via managed git
  worktree lifecycle and passes worktree metadata into run launch (no longer
  inert).
- **`container`** — reserved for containerized isolation where configured.

Worktree paths are validated (naming, confinement, collision guards). TaskWraith
does not silently remove worktrees that still have uncommitted changes.

### Requirements and caveats

- Requires a normal **git repository** workspace (not bare repos or non-git folders).
- **Dirty tree:** checkout, branch creation, and some worktree actions block when
  staged/unstaged/conflicted changes exist — commit, stash, or discard first.
- **iOS companion** reflects Mac workspace/git state; worktree selection follows
  the desktop binding.
- Removing a worktree does not delete its branch unless you use an explicit
  branch cleanup flow where offered.

## Related surfaces

- **Sub-threads** — cross-provider delegation; not the same as fork (see
  `AGENTS.md`).
- **Ensemble mode** — shared transcript; per-participant worktree isolation is
  optional and policy-dependent, not automatic for every seat.
- **Create PR** — shares git snapshot sources with the branch popover.
