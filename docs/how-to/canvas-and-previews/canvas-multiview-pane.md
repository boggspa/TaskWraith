# How to: Canvas multiview pane

**Platform:** Electron

## What it is
A canvas multiview pane is a multiview cell that hosts a live, embedded preview of a web URL (a "web canvas") instead of a chat — useful for keeping a running app or page visible side-by-side with your conversation.

## Where to find it
Switch to a split multiview layout (2/3/4 panes) from the composer's Plus Tools menu. Any pane that isn't showing a chat appears as an empty cell labeled "Select a chat for this pane," with a URL field and an **Open web canvas** button — submitting a URL there turns that cell into a canvas pane.

<!-- screenshot-pending: Canvas multiview pane showing an embedded preview -->

## How to use it
1. Open a multiview layout with at least one empty pane (or close a pane's chat/canvas to free it up).
2. In the empty pane, type a URL into the field (it defaults to `http://localhost:3000`) and press **Enter** or click **Open web canvas**.
3. The pane loads the page as a live-embedded preview, with a thin toolbar showing the page title or URL.
4. Click the **×** in the pane's toolbar, or the pane's close button, to close the canvas and return the cell to empty.

## Tips & related
- [Plus tools menu (multiview layout)](../composer/plus-tools-menu.md) — where you switch between single and split multiview layouts.
- [Canvas composer button](canvas-composer-button.md) — opens a canvas in its own floating window instead of a multiview pane.
- [Multiview media pane](../media-audio-and-video/multiview-media-pane.md) — the equivalent multiview cell for detached audio/video players.
- [iOS canvas preview](ios-canvas-preview.md) — the canvas preview surface on iOS.
