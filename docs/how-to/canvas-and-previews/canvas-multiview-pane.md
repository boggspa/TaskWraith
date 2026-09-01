# How to: Canvas multiview pane

**Platform:** Electron

## What it is
A canvas multiview pane is a multiview cell that hosts a canvas surface — an embedded browser, a sketch board, the built-in homebrew emulator, a 3D mesh scene, charts, media, or an iOS simulator — instead of a chat, so you can keep it visible side-by-side with your conversation.

## Where to find it
Switch to a split multiview layout (2/3/4 panes) with the Multiview layout picker in the composer's telemetry row. Any pane that isn't showing a chat renders **Thread Home**: a list of your visible and running threads, and below it a grid of surface cards.

<!-- screenshot-pending: Canvas multiview pane showing an embedded preview -->

## How to use it
1. Open a multiview layout with at least one empty pane (or close a pane's chat/canvas to free it up).
2. In the empty pane's Thread Home, pick a surface card: **Graphs & charts**, **Browser**, **Mesh**, **Sketch**, **Emulator**, **Media**, or **Simulator**. The cards are disabled until the pane has an authority thread to attach the surface to.
3. **Browser** opens a blank embedded TaskWraith browser, **Sketch** opens a sketch board, and **Emulator** opens the fixed built-in homebrew demo as a full Canvas pane with no browser controls. Each shows a brief "Opening…" state and reports inline if it can't open. The other cards render their surface directly in the pane.
4. To go back, use the pane's close control — it returns the cell to Thread Home first, and closes the pane itself once Thread Home is already showing. Selecting a thread from the list turns the cell back into a chat pane.

The full-pane Emulator card is its own entry point; it has no separate Pop Out
control. To transfer an already-open dock session, use **Pop Out** and **Dock**
from the Inspector Canvas dock instead.

## Tips & related
- **Multiview layout picker** — the composer telemetry-row control where you switch between single and split multiview layouts.
- [Canvas composer button](canvas-composer-button.md) — opens a canvas in its own floating window instead of a multiview pane.
- [Emulator Canvas](emulator-canvas.md) — the fixed homebrew demo, its agent workflow, and exact-surface control boundary.
- [Multiview media pane](../media-audio-and-video/multiview-media-pane.md) — the equivalent multiview cell for detached audio/video players.
- [iOS canvas preview](ios-canvas-preview.md) — the canvas preview surface on iOS.
