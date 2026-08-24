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

## Packages

Packages ship `tw`/`taskwraith` in `Resources/bin` and
`taskwraith-host` in `Resources/host-bin` (`.cmd`/`.ps1` on Windows). These
launchers use bundled `Resources/tui-runtime` Node, never Electron or
`ELECTRON_RUN_AS_NODE`; production payload is `Resources/host` with the exact
pure Muse closure.

```sh
taskwraith-host --profile /absolute/profile
```

The launcher fixes `serve --mode production`; callers provide a profile and
optionally an absolute Muse executable. An existing Host is reused, while a
held lease fails cleanly.

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

Slash commands include `/context`, `/threads`, `/missions`, `/history`,
`/model`, `/seats`, `/help`, `/cancel`, `/dismiss`, and `/quit`. Every setup,
approval, cancellation, and configuration action remains a bounded Host command
with capability, actor, offer, and receipt validation.

### Current boundary

The Node Host owns private discovery/token/socket artifacts and the versioned
local protocol. Standalone production currently supports Muse through its
Node-owned resource/run ports. The TUI supports cold workspace registration,
thread creation/configuration/archive, provider offers/auth metadata, bounded
history, and receipt replay through that Host. It deliberately omits arbitrary
AppStore writes, permission bodies, credentials, raw provider payloads,
desktop-only drag/drop/canvas/glass surfaces, and unbounded terminal control.
