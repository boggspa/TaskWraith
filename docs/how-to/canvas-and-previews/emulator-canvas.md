# How to: Emulator Canvas

**Platform:** Electron

> **Source-ahead feature.** This guide describes code present after the public
> v1.9.6 baseline. It is not a released or packaged-artifact promise.

## What it is

Emulator Canvas is a small, reviewed homebrew demo that runs inside
TaskWraith's Canvas. It is deliberately a fixed demo, not a general-purpose
emulator: there is no game picker, ROM upload, file path, URL override, raw RAM
view, or cheat interface.

The demo is chat-owned. The right Inspector Canvas dock and the Thread Home
Emulator card are separate entry points for the same fixed demo. Thread Home
opens it as a full pane in a Multiview layout; the Inspector dock can also
transfer an already-open dock session into a floating Canvas window. Neither
entry point gives an agent permission to control a different chat's session.

## Open and place the demo

1. In a chat's right Inspector, open **Canvas** and choose **Homebrew
   Emulator**. An agent can also request the fixed demo with `emulator_open`.
2. To use the full-pane presentation, open an empty Multiview cell, choose its
   **Thread Home**, then select the **Emulator** surface card. Thread Home needs
   an authority thread before it can attach the demo.
3. For a demo already open in Inspector Canvas, use the Canvas placement
   control to **Pop Out** that active dock session into a floating Canvas
   window. Choose **Dock** in that window to return it to the Inspector Canvas
   dock. The full Thread Home pane has no separate Pop Out control.

For an Inspector dock session, Pop Out and Dock reparent that same live session
instead of starting a new demo. They do not reset the game or enlarge the
agent's authority.

## Play directly

1. Click **Play** to start the trusted human play loop; click **Pause** when
   you are done.
2. Use the arrow keys to move. `Z` is B, `X` is A, Enter is Start, and Shift is
   Select.
3. If the emulator loses focus or becomes hidden, it pauses and clears any held
   buttons. Start Play again after returning to it.
4. Pause before asking an agent to step. Human play takes precedence, so agent
   frame control stands down while the human loop is active.

## Work with an agent

The agent workflow is intentionally ordered:

If a live emulator `canvasId` is already attached, the agent reuses it and
begins at **Observe**. It calls `emulator_open` only when no live emulator
Canvas is attached.

1. **Open if needed** — `emulator_open` creates the fixed demo in the active
   chat and returns its `canvasId` only when no live emulator Canvas is already
   attached.
2. **Observe** — `emulator_observe` captures one atomic moment: a PNG frame,
   safe mapped state, and an opaque observation id. The PNG may become visual
   context for the active provider.
3. **Step** — `emulator_step` supplies that exact `canvasId`, the most recent
   observation id, and one to twelve controller segments. Each segment can hold
   supported non-opposing buttons for one to 120 frames; the whole request is
   capped at 240 frames.
4. **Check the result** — a step can complete, refuse before advancing, or be
   interrupted. Read its outcome and completed-frame count before asking the
   agent to make another move; a fresh observation may be needed.

The structured observation contains only a package-verified mapped state. It
does not expose ROM bytes, raw emulator RAM, internal URLs, or base64 pixel
data. The demo cannot be repointed at another game and it has no cheat command.

## You stay in control

An agent may step only with an exact-surface Canvas/AppDrive approval or grant.
That consent applies to the reviewed live Canvas, not another Canvas, chat, or
replacement session. You can take over and play directly whenever you want.
While a trusted human play loop is active, agent stepping stands down;
TaskWraith revokes the exact surface authority rather than trying to continue
around your input.

Like any Canvas screenshot, an observed frame can be visible to the active
provider. Keep the demo and its on-screen state appropriate for that provider's
normal data boundary.

## Related guides

- [Canvas Browser](canvas-browser.md) — browser-specific navigation and
  sign-in rules.
- [Canvas multiview pane](canvas-multiview-pane.md) — how Thread Home places a
  full Canvas surface in a split layout.
- [Trust and Safety](../../TRUST_AND_SAFETY.md) — the bounded demo and
  exact-surface control boundary.
