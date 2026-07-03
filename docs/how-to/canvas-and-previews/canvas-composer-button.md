# How to: Canvas composer button

**Platform:** Electron

## What it is
The Canvas composer button is a one-click way to open a running web app (e.g. a local dev server) in a standalone, movable Canvas window — separate from embedding a Canvas in a multiview pane or asking an agent to open one for you.

## Where to find it
It's an icon-only button in the composer's telemetry row (the footer icon cluster), next to the Multiview layout picker. Hovering or focusing it shows a "Web canvas" hint label; clicking it opens a small popover with a URL field.

<!-- screenshot-pending: Canvas composer button in the telemetry row -->

## How to use it
1. Click the canvas icon in the composer's telemetry row to open the URL popover.
2. Enter the address of a running app (it defaults to `http://localhost:3000`).
3. Press Enter or click **Open web canvas** to launch it.
4. TaskWraith opens the page in its own floating Canvas window, which you can move and close independently of the chat.
5. If the URL can't be reached, the popover shows an inline error (e.g. "Couldn't load that URL — is a dev server running there?") so you can fix the address and try again.

## Tips & related
- [Canvas multiview pane](./canvas-multiview-pane.md) — embed a Canvas inside a split pane instead of a floating window.
- [Plus tools menu](../composer/plus-tools-menu.md) — other composer-row tools and pickers.
- [iOS canvas preview](./ios-canvas-preview.md) — the companion view for Canvas content on iOS.
