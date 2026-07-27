# TaskWraith TUI sidecar

The TaskWraith TUI is a local terminal view of the running Electron app. It is
a separate executable and presentation target; Electron main remains the
authority for chats, providers, models, permissions, approvals, run dispatch,
cancellation, persistence, and audit.

The v1 shape is deliberately a sidecar:

```text
TaskWraith Electron main
  └─ same-user local control socket
       └─ taskwraith / tw (raw ANSI Node client)
```

It does not scrape renderer state, read AppStore files, or load provider
credentials. The host projects a small versioned contract and routes mutations
through the same main-owned action executor used by TaskWraith's other remote
surfaces.

## Try it

From the repository:

```sh
npm run tui:demo
```

The self-contained demo is safe when TaskWraith is not running. To connect to
the repository's normal `TaskWraith Dev` app:

```sh
npm run tui
```

For a deterministic, non-interactive 80x24 frame:

```sh
npm run tui:snapshot
```

Build only the sidecar with `npm run tui:build`. The compiled entry point is
`out/tui/tui/cli.js`, exposed as both `taskwraith` and `tw` when the package is
linked or installed. `NO_COLOR=1` and `--no-animation` provide static
fallbacks.

The installed `taskwraith` / `tw` binary defaults to the release app. Use
`--dev` to target `TaskWraith Dev`; it honours `TASKWRAITH_INSTANCE_ID` for
parallel dev hosts. If automatic discovery is not the desired one, pass
`--user-data <path>` or set `TASKWRAITH_USER_DATA`.

## Colour and ASCII fallbacks

Presentation degrades TrueColor → `NO_COLOR` → ASCII. Details and the
width-1 ASCII invariant are in [`DESIGN.md`](./DESIGN.md).

| Control | Effect |
| ------- | ------ |
| `--ascii` | Force the ASCII glyph set for the process |
| `TASKWRAITH_TUI_ASCII=1` | Same force via environment |
| Auto-detect | `TERM=linux` / `TERM=dumb`, or a non-UTF-8 locale, selects ASCII |
| `NO_COLOR=1` / `--no-color` | Colour off; glyphs and layout unchanged |
| `--no-animation` | Static working indicator (also off under `NO_COLOR` / non-TTY) |

## Interaction

| Key                       | Action                                               |
| ------------------------- | ---------------------------------------------------- |
| `Enter`                   | Send the composer prompt or open the selected thread |
| `←` / `→`, `Home` / `End` | Move through the one-line composer                   |
| `Ctrl+A` / `Ctrl+E`       | Jump to the start / end of the composer              |
| `Ctrl+O`                  | Toggle the context lens                              |
| `Ctrl+K`                  | Toggle the thread picker                             |
| `Ctrl+P`                  | Toggle the command reference                         |
| `Page Up` / `Page Down`   | Scroll the transcript                                |
| `Esc`                     | Close the active lens                                |
| `Ctrl+U`                  | Clear the composer                                   |
| `Ctrl+C`                  | Clear a non-empty composer; press again to leave     |

Slash commands are `/context`, `/threads`, `/help`, `/cancel`, and `/quit`.
Cancellation is always an explicit command and is still validated by Electron
main. Bracketed paste is enabled: a multi-line code block stays one prompt,
with preserved line breaks shown as `↵` inside the one-row composer viewport.

## Terminal layout

The transcript is the canvas; there is no persistent masthead.

- Solo threads reserve two rows: compact HUD, then composer.
- Ensemble threads reserve three rows: baton, compact HUD, then composer.
- The baton preserves current seat, next seat, roster count, and continuation
  budget. The full preset, stages, fan-out, and participant cast live in one
  transient context lens.
- At 100 columns and above, identity labels expand. From 72–99 columns the TUI
  uses the normal compact form. Below 72 columns it becomes a short semantic
  checksum rather than wrapping the composer vertically.
- Empty/offline state may use a sparse static sky and monoline ghost. It
  disappears as soon as a transcript exists.

The persistent rows retain the five details most useful during a run:
workspace, provider/model/reasoning, wall time, cost, and composer text. Full
primary/secondary workspace grants and ensemble roster distinctions remain one
keystroke away instead of consuming most of an 80x24 terminal.

## Presentation fidelity

Provider identity carries the colour; transcript prose stays neutral. The ANSI
palette is pinned to `src/renderer/src/styles/theme.css` by a drift test.

The runtime and display brands remain distinct:

- Ollama models use the shared `ollamaBrandTable` so Qwen, Gemma, Nemotron, and
  other curated models wear their upstream label and hue.
- Pi models use the shared `piBrandTable` so DeepSeek, Mistral, Groq, Cerebras,
  and the other upstreams remain visually legible.

During a live run, the provider-accented ghost and `Working…` label receive a
small ANSI shimmer sweep. The provider/role/model/reasoning identity, elapsed
time, and approximate tokens match the desktop working indicator's information
hierarchy. Nothing animates while idle.

Mistral Vibe is the layout precedent: strong provider names, sparse rhythm,
content-area selectors, and an anchored prompt. The Electron app is the final
reference for TaskWraith semantics and branding.

## Local-control boundary

The host writes a discovery document and random session token with owner-only
permissions inside Electron `userData`. POSIX uses an owner-only Unix socket in
a short private temp directory; Windows uses a per-user-data named pipe. The
token is read from its file, never passed in command-line arguments or logged.
Messages are bounded newline-delimited JSON with a versioned handshake.

The client can currently:

- list workspaces and threads;
- select a thread and receive transcript/run updates;
- send a prompt to an existing solo thread through the normal composer action;
- steer/start an existing ensemble through the ensemble action path;
- cancel a solo run or an ensemble round through their respective main-owned
  action paths.

The facade derives workspace, provider, model, reasoning, and live run identity
from canonical AppStore records. Client input cannot nominate a different
provider, permission posture, workspace, or run id.

## Intentional v1 omissions

The TUI does not imitate desktop glass, blur, refraction, floating shadows,
hover previews, drag-and-drop, persistent animated backgrounds, stacked
modals, canvas/media, or rich documents. It also does not yet edit providers,
models, permissions, grants, rosters, or create threads. Those richer mutations
stay in the Electron UI until they have a purpose-built terminal interaction
and an equally strong authority contract.

This boundary leaves a clean future route: the local-control host can move from
Electron main into a dedicated TaskWraith daemon without rewriting the
terminal renderer or weakening desktop behaviour.
