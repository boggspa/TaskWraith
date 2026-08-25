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
advertise those capabilities. It must not manufacture approval cards for a
provider that cannot resume them safely.

An interactively started `taskwraith-host serve` can hand
`muse login` to that same terminal with exact, shell-free argv. A detached Host
has no visible TTY and therefore does not advertise an invisible manual-auth
flow; configure its approved credential environment or start it interactively.

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
`--no-animation` change presentation only. Solo threads use compact HUD plus
composer; ensemble threads add a baton row. Provider identity carries colour,
while transcript prose stays neutral and detail remains in transient lenses.

| Key                                              | Action                                     |
| ------------------------------------------------ | ------------------------------------------ |
| `Enter`                                          | Send/open selected thread                  |
| `Ctrl+O`, `Ctrl+K`, `Ctrl+R`, `Ctrl+G`, `Ctrl+P` | Context, threads, missions, tune, commands |
| `Page Up` / `Page Down`                          | Scroll transcript/history                  |
| `Esc`, `Ctrl+U`, `Ctrl+C`                        | Close lens, clear composer, clear/quit     |

Slash commands (COMMAND SPEC v1). Inline args are optional; invalid args are
non-fatal notices and never throw out of the keypress loop. `/model` and
`/think` reuse the existing offers/tune plumbing (`getThreadOffers`,
`TuiPendingSelection`, `applyTuneSelection`). `/new` uses the existing
`thread.create` flow with a solo/`single` chatKind default.

| Command                                         | Action                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/model [id]`, `/m`                             | No argument opens the existing tune/model picker. With an id, stage that model for the next send; unknown id lists offered ids. |
| `/think [level]`, `/reasoning`                  | Set reasoning against the **thread's offered ladder** (never a hardcoded list). No argument shows current + ladder.             |
| `/new`                                          | Create and switch to a fresh solo thread.                                                                                       |
| `/status`                                       | Host kind + connection, socket/profile path, thread provider/model/reasoning, advertised capabilities.                          |
| `/clear`                                        | Local scrollback/viewport reset only — never history mutation.                                                                  |
| `/context`, `/threads`, `/missions`, `/history` | Existing overlay toggles.                                                                                                       |
| `/seats`, `/tune`                               | Seat roster / tune lens.                                                                                                        |
| `/help`                                         | Command cheat sheet.                                                                                                            |
| `/cancel`                                       | Cancel the active run.                                                                                                          |
| `/dismiss`                                      | Dismiss a pending question when the Host advertises `questions`.                                                                |
| `/quit`, `/q`                                   | Exit the TUI; the Host remains running.                                                                                         |

Every setup, cancellation, and configuration action remains a bounded Host
command with capability, actor, offer, and receipt validation.
Approval/question actions are available only when the connected Host actually
negotiates those capabilities. Muse standalone production currently does not
advertise them (see Current boundary).

### Current boundary

The Node Host owns private discovery/token/socket artifacts and the versioned
local protocol (`node-host-v1`). Standalone production currently supports Muse
through its Node-owned resource/run ports
([`HostNodeProductionFactory.ts`](../host-node/HostNodeProductionFactory.ts)
composes `HostNodeMuse*` only). The TUI supports cold workspace registration,
thread creation/configuration/archive, provider offers/auth metadata, bounded
history, and receipt replay through that Host. It deliberately omits arbitrary
AppStore writes, permission bodies, credentials, raw provider payloads,
desktop-only drag/drop/canvas/glass surfaces, and unbounded terminal control.

Goal `goal-1787698539643-zyrznc` (user-ruled 2026-08-25) intends to expand
that factory to the live multi-provider inventory with capability-gated
approvals/questions. That expansion is **not** shipped in this pass; do not
read this README as claiming it.

## Desktop coexistence rollout

The standalone TUI path does **not** require the desktop app. `tw` reuses or
auto-starts the pure-Node Host (`taskwraith-host serve --mode production
--profile <path>`); `tw --no-start-host` is connect-only.

Desktop is **not** cut over to that Host. The app still composes its own Host
inside Electron main by default. An external-host path exists
([`HostExternalSupervisor`](../main/host/HostExternalSupervisor.ts)) but is
gated off unless `TASKWRAITH_DESKTOP_EXTERNAL_HOST=1`
([`bootstrap.ts`](../main/bootstrap.ts)). Landed as `7e633fa7e`. Without that
flag, Desktop and TUI **coexist as two hosts over one profile** (`e8622883d`),
both writing `<profile>/chats/<id>.json` and `workspaces.json`.
`LegacyStoreWriterGate` is the unfinished cross-process single-writer fence.
The standalone TUI path remains independent either way.
