# TaskWraith TUI + Independent Node Host

The TUI is a first-class authenticated `HostProjectionClient`, not an Electron
or App-dependent presentation. It connects to a production Node Host directly.

```text
tw / taskwraith
  ├─ reuse an authenticated production Host for the selected profile
  └─ start `taskwraith-host serve --mode production --profile <profile>`
       └─ profile lease → stable identity → private discovery/token/socket
```

The Host is profile-owned, not connection-owned: disconnecting the TUI never
stops provider work. Its profile lease prevents duplicate owners and its
persisted `host-runtime/host-install-identity.json` prevents identity churn.
Discovery, token, and local transport artifacts are owner-only. The TUI fences
`node-host-v1` and negotiated production capabilities before treating a Host as
live. Desktop writer handoff remains a separate cutover concern.

## Launch and reconnect

```sh
npm run tui
tw --user-data /absolute/profile
tw --no-start-host --user-data /absolute/profile
```

`--user-data` is the standalone Node Host profile. Normal startup reuses an
existing Host or starts production Node Host; `--no-start-host` is connect-only
and never launches one. Reconnect uses ordered deltas when valid, otherwise a
coherent snapshot. History has its own bounded cursor.

## Cold setup, history, and receipts

Production capability negotiation provides bounded provider/model/posture and
manual-auth metadata, workspace/thread setup, history pages, and durable
command receipts/result references. Credentials, permission bodies, and raw
provider payloads are not projected. Provider runs use the authenticated client
id only as a transport-neutral delivery target.

Muse workspace-write posture requires an explicit, persisted consent bit before
the Host accepts configuration. Muse currently emits no deferred
approval/question continuation events, so the standalone Host does not
advertise those capabilities _for Muse_. Other providers can and do: Codex,
Kimi, Grok and Mistral advertise approvals, and Codex has advertised questions
since `d54d757cd` (2026-08-27). The registry ORs each flag across the
constructed factories. It must not manufacture approval cards for a
provider that cannot resume them safely.

An interactively started `taskwraith-host serve` can hand a provider CLI login
to that same terminal with exact, shell-free argv when the catalog advertises a
manual flow. Grok also accepts `XAI_API_KEY` / `GROK_API_KEY` on the Host
environment. Pi has no terminal login: configure allowed upstream API keys on
the Host env instead. A detached Host has no visible TTY and therefore does not
advertise an invisible manual-auth flow; configure its approved credential
environment or start it interactively.

## Packages

Packages ship `tw`/`taskwraith` in `Resources/bin` and
`taskwraith-host` in `Resources/host-bin` (`.cmd`/`.ps1` on Windows). These
launchers use bundled `Resources/tui-runtime` Node, never Electron or
`ELECTRON_RUN_AS_NODE`; production payload is `Resources/host` with the exact
pure Muse closure.

```sh
taskwraith-host --profile /absolute/profile
taskwraith-host stop --profile /absolute/profile
```

The launcher fixes `serve --mode production`; callers provide a profile and
optionally an absolute Muse executable. An existing Host is reused, while a
held lease fails cleanly. `stop` is a dedicated authenticated lifecycle RPC:
it awaits run/resource cleanup and removal of discovery, token, socket, and
profile lease rather than killing a discovery PID.

## Diagnostic rollback

Diagnostic mode is explicit, not the default TUI authority:

```sh
npm run host:serve:diagnostic -- --profile /absolute/profile
```

It is limited to recovery/diagnostics and does not advertise production setup,
provider, history, or command capabilities.

`--ascii`, `TASKWRAITH_TUI_ASCII=1`, `NO_COLOR=1`, `--no-color`, and
`--no-animation` change presentation only. `.twmission` replay is detached and
cannot mutate a live Host.

## User guide

```sh
npm run tui:demo
npm run tui:snapshot
tw --json
tw --export ./incident.twmission --force
tw --replay ./incident.twmission --width 100 --height 30
```

The demo is self-contained. Snapshot and JSON use the authenticated Host
projection. Export writes a bounded integrity-checked `.twmission` recorder;
replay is detached and cannot write a live Host. Export requires `--force` to
replace a file.

Packaged TUI launchers are under `Resources/bin` and production Host launchers
are under `Resources/host-bin` (`.cmd`/`.ps1` on Windows). The package's
`tui-runtime` Node binary runs both; no system Node, Electron executable, or
windowless parent process is required.

### Front page

The home frame (`renderHome`) is the solo-CLI landing: a hand-authored
Monoline Ghost banner from [`ghostBanner.ts`](./ghostBanner.ts), the
TaskWraith wordmark, and Host status lines. The mark follows
`design-assets/ghost/ghost-guy-mark-monoline.svg` (rounded crown, two
rectangular eyes, wavy/pleated base). `ghostBanner.ts` is a presentation
module only: Unicode vs `--ascii` selection, the compact-width fallback
glyph (`theme.ts` `ghost`: `ᜊ` / `*`), and any colour/tone come from
[`theme.ts`](./theme.ts). Full banner when width allows; below the minimum
width it falls back to that single glyph. The ASCII variant is sized to
remain inside `tw --ascii --width 80`.

### Controls and layout

`--ascii`, `TASKWRAITH_TUI_ASCII=1`, `NO_COLOR=1`, `--no-color`, and
`--no-animation` change presentation only. Threads use compact HUD plus
composer. There is no ensemble baton, seat lens, or mission-cast chrome.
Opening a Host-projected ensemble thread is view-compatible, not
controllable: HUD uses that thread's primary provider. Provider identity
carries colour, while transcript prose stays neutral and detail remains in
transient lenses.

| Key                                              | Action                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `Enter`                                          | Send/open selected thread; confirm a picker row                                  |
| `Ctrl+O`, `Ctrl+K`, `Ctrl+R`, `Ctrl+G`, `Ctrl+P` | Context, threads, missions, tune (model/reasoning), commands                     |
| `Page Up` / `Page Down`                          | Scroll transcript/history                                                        |
| `Esc`                                            | Close lens; cancel a mid-flow `/new`/`/provider` and restore the previous thread |
| `Ctrl+U`, `Ctrl+C`                               | Clear composer; clear then quit                                                  |

Slash commands (COMMAND SPEC v1). Inline args are optional; invalid args are
non-fatal notices and never throw out of the keypress loop. `/model` and
`/think` reuse the existing offers/tune plumbing (`getThreadOffers`,
`TuiPendingSelection`, `applyTuneSelection`). `/new` and `/provider` reuse
cold-start: provider picker → auth → offers → model/reasoning → solo thread.
A unique `/new claude` or `/provider kimi` skips the picker. Esc cancels a
mid-flow `/new` and restores the previous thread. Hosts without `setup` +
`provider-catalog` keep the old immediate-create fallback (`/new` with no
id). `/seats` opens a live seat lens on an ensemble thread (see Ensemble seat
control below); it is no longer rejected.

| Command                                         | Action                                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `/model [id]`, `/m`                             | No argument opens the existing tune/model picker. With an id, stage that model for the next send; unknown id lists offered ids.            |
| `/think [level]`, `/reasoning`                  | Set reasoning against the **thread's offered ladder** (never a hardcoded list). No argument shows current + ladder.                        |
| `/new [provider]`                               | Fresh solo thread. No id opens the provider picker (↑/↓, Enter). Unique id skips the picker. Esc cancels and restores the previous thread. |
| `/provider [id]`                                | Same guided flow as `/new`.                                                                                                                |
| `/status`                                       | Host kind + connection, socket/profile path, thread provider/model/reasoning, advertised capabilities.                                     |
| `/clear`                                        | Local scrollback/viewport reset only — never history mutation.                                                                             |
| `/context`, `/threads`, `/missions`, `/history` | Existing overlay toggles.                                                                                                                  |
| `/tune`                                         | Model/reasoning lens (same as Ctrl+G). Not a seat roster.                                                                                  |
| `/git [status\|diff\|log] [path]`               | Read-only workspace git lens. `s`/`d`/`l` switch scope, `r` refreshes, Esc closes. On demand only — no watcher.                            |
| `/seats`                                        | Seat lens for an ensemble thread. ↑/↓ select, Enter/Space toggle a seat, `r` refreshes, Esc closes. Round execution stays desktop-only.    |
| `/help`                                         | Command cheat sheet.                                                                                                                       |
| `/cancel`                                       | Cancel the active run.                                                                                                                     |
| `/dismiss`                                      | Dismiss a pending question when the Host advertises `questions`.                                                                           |
| `/quit`, `/q`                                   | Exit the TUI; the Host remains running.                                                                                                    |

Every setup, cancellation, and configuration action remains a bounded Host
command with capability, actor, offer, and receipt validation.
Approval/question actions are available only when the connected Host actually
negotiates those capabilities. Muse standalone production currently does not
advertise them (see Current boundary).

### Workspace git (`/git`)

`/git [status|diff|log] [path]` opens a read-only git lens over the thread's
registered workspace. With no scope argument it reuses the last scope, falling
back to `status`. Inside the overlay `s`/`d`/`l` switch scope, `r` re-reads, and
Esc closes. Switching scope **clears the `path` filter**; pass `/git diff
src/foo.ts` again to re-apply one.

**On demand only.** There is no watcher and no live update — the overlay shows
the result of the read you asked for, and nothing refreshes it until you press
`r` or reopen. This is deliberate, not a missing feature.

**Read-only, and narrow.** The Host runs only `status`, `diff`, `log`, `branch
--show-current` and `rev-parse HEAD`. `show` and `blame` are deliberately
excluded, mirroring the existing product decision that gates those two while
auto-allowing status/diff/log. Nothing in this surface writes to a repository.

**Truncation is explicit.** The Host caps a serialized git result at 128 KiB
and marks a clipped payload as truncated; the overlay banners it at the top of
the body. A truncated diff — or a truncated status file list — is never
presented as complete.

**A Host without git is a normal configuration, not an error.** The Host
advertises the `workspace-git` capability only when a git binary actually
resolves, so on a git-less Host `/git` reports that it is unavailable and says
so calmly. That is distinct from a read that genuinely failed, which surfaces
as an error; the two are kept apart deliberately.

**Local only.** Paired/remote peers are explicitly refused `workspace.git.read`
([`PairedHostProjectionGateway`](../main/remote/PairedHostProjectionGateway.ts)),
and the capability is never negotiated for them, because diff and log output can
carry secrets. Do not assume the remote surface has this.

**Scope containment.** Reads are pinned to the registered workspace path. A
repository whose toplevel resolves outside that workspace is refused, including
`.git`-file redirection (linked worktrees and submodules) — the read is not
widened to an ancestor checkout.

Known limit: ahead/behind counts are not carried on the wire, so the header
shows the branch, a short head, and the staged/unstaged/untracked counts rather
than a divergence figure.

### Ensemble seat control (`/seats`)

`/seats` opens a seat lens over an ensemble thread's persisted roster: each
participant's id, provider, model, role, stage, order and enabled state, read
from the Host snapshot rather than any local guess. ↑/↓ select, Enter/Space
toggles the selected seat, `r` re-reads, Esc closes. A toggle is a real
`ensemble.seat.toggle` mutation; the lens re-reads the authoritative snapshot
afterwards rather than flipping optimistically, so what you see is what the Host
stored.

**Round execution is desktop-only, and that is deliberate.** Toggling seats does
not make the standalone Host able to run a round. `composer.send` into an
ensemble thread is refused outright with `standalone_ensemble_round_unavailable`
so a single-provider run can never masquerade as an ensemble round. Sub-threads,
goals, the blackboard and workflows remain absent from the standalone Host. If
you need a round to actually run, use the desktop app.

**The Host owns the refusals; the TUI does not pre-empt them.** A toggle that
would disable the last enabled seat, or that arrives while a round is running,
is denied by the Host (`standalone_ensemble_last_seat_required`,
`standalone_ensemble_round_active`) and the lens surfaces that denial in plain
language. The client does not second-guess those rules locally, so the Host
stays the single authority on what is allowed.

**A Host without seat control is a normal configuration, not an error.** The
`ensemble` capability is advertised only when the Host can actually serve seat
control, so a Host that cannot reports unavailable calmly — the same distinction
`/git` draws between "not offered here" and "the read failed".

### Current boundary

The Node Host owns private discovery/token/socket artifacts and the versioned
local protocol (`node-host-v1`). Standalone production composes the nine live
providers — Codex, Claude, Kimi, Cursor, Grok, Ollama, Pi, Mistral, Muse —
through [`HostNodeProductionFactory.ts`](../host-node/HostNodeProductionFactory.ts).
That membership is exactly `LIVE_SELECTABLE_PROVIDER_IDS`; the registry rejects
any other id. The operator-facing matrix lives in
[`HostStandaloneProviderMatrix.ts`](../host-shared/HostStandaloneProviderMatrix.ts).

The TUI is a **solo**, multi-provider client (Pi/OMP-shaped): `/new` and cold
start create single-provider threads. It is not an ensemble authoring surface —
it cannot create an ensemble or run a round. Existing desktop ensemble threads
open for inspection **and for seat control** (see Ensemble seat control). The TUI
supports cold workspace registration, thread creation/configuration/archive,
provider offers/auth metadata, bounded history, and receipt replay through that
Host. It deliberately omits arbitrary AppStore writes, permission bodies,
credentials, raw provider payloads, desktop-only drag/drop/canvas/glass
surfaces, and unbounded terminal control.

**AntiGravity / AGY** is desktop-conditional only (`isAntigravityOptInEnabled`
plus a configured key in Electron settings). The standalone Host does **not**
compose or admit it and does not grow a parallel consent wall.

**Cursor** is setup/auth-only on this Host. `cursor-agent login` can run when a
TTY launcher is present; `run()` stays a typed hard-stop because a write-capable
Cursor argv requires MCP deny-list containment attestation the Node Host cannot
produce.

**Auth alternatives**

| Provider                                   | Manual TTY login                                                         | Env-key alternative                                           |
| ------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Codex, Claude, Kimi, Cursor, Mistral, Muse | Catalog `*:login` when a launcher is present                             | None advertised                                               |
| Grok                                       | `grok:login` (`grok login`) when a launcher is present                   | `XAI_API_KEY` or `GROK_API_KEY`                               |
| Pi                                         | None — `authFlows` stays empty; `beginAuth` refuses a fabricated handoff | Allowed upstream keys on the Host env (`PI_UPSTREAM_KEY_ENV`) |
| Ollama                                     | None — daemon reachability is the auth evidence                          | None advertised                                               |
| AntiGravity                                | Not a standalone provider                                                | Desktop consent only                                          |

A detached Host still does not advertise an invisible manual-auth flow.

## Desktop coexistence rollout

The standalone TUI path does **not** require the desktop app. `tw` reuses or
auto-starts the pure-Node Host (`taskwraith-host serve --mode production
--profile <path>`); `tw --no-start-host` is connect-only.

Desktop now **defaults onto** that Host: `prepareMainProcess`
([`bootstrap.ts`](../main/bootstrap.ts)) connects to the external Host
([`HostExternalSupervisor`](../main/host/HostExternalSupervisor.ts)) unless
`TASKWRAITH_DESKTOP_EXTERNAL_HOST=0` opts back into composing its own
in-process Host. Landed as `30b092586`. When the external Host is unavailable,
or that opt-out is set, Desktop still composes its own in-process Host
(`e8622883d`).

Both profile families the two processes used to contend over are now written
through the Host rather than directly. Chat records go through
`thread.record.persist` / `thread.record.delete`, and workspace records through
`workspace.record.upsert` / `workspace.record.remove` /
`workspace.records.clear` (`379e2dd2e`); Desktop submits them as an outbound
client instead of writing `<profile>/chats/<id>.json` and `workspaces.json`
itself. All five are restricted to the exact authenticated Desktop actor — a
local-control client cannot reach them. The cross-process single-writer fence
([`HostProfileWriterFence`](../host-runtime/HostProfileWriterFence.ts)) is
consumed on both sides of the process boundary, and `bootstrap.ts` handles
`ProfileWriterLivePeerError` on fallback (`bbda6a371`, `f4081926b`). The
standalone TUI path remains independent either way.
