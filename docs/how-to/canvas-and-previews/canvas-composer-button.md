# How to: Canvas composer button

**Platform:** Electron

## What it is
A one-click way to open a Canvas for the current task — a browser, a sketch pad, a 3D scene, a simulator, or the Homebrew emulator. It opens in the right dock, and you can move it into its own window later.

## Where to find it
An icon-only button in the composer's telemetry row, next to the Multiview layout picker. Hover it and the hint reads **Canvas**.

![Canvas composer button in the telemetry row](../images/canvas-and-previews__canvas-composer-button.png)

## How to use it
1. Click the canvas icon to open the picker.
2. Choose what to open: **Open browser**, **Open sketch canvas**, **Open Mesh Canvas**, **Open Simulator Canvas**, or **Open Emulator Canvas**.
3. For the browser, type the address in the browser's own address bar once it opens — it starts blank on purpose.
4. Use the placement button in the Canvas tab strip to move the surface into its own window; it keeps the same tabs and controls.
5. Click **Dock** in that window's header to send it back to the task.

## Tips & related
- If a page cannot be reached, the browser shows the error in its own chrome so you can fix the address and retry.
- [Canvas multiview pane](./canvas-multiview-pane.md) — embed a Canvas inside a split pane instead of the right dock.
- [Plus tools menu](../composer/plus-tools-menu.md) — other composer-row tools and pickers.
- [iOS canvas preview](./ios-canvas-preview.md) — the companion view for Canvas content on iOS.
