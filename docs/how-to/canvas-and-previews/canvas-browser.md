# How to: Canvas Browser

**Platform:** Electron

## What it is

Canvas Browser is TaskWraith's live web surface in the current task's right dock. It gives you and the active agent the same visible page, browser history, address bar, and tabs, so an agent can research the web, operate a site, or walk through a local app without taking the result away from the conversation.

Browser tabs are task-owned, while cookies, sign-ins, and site storage live in one persistent TaskWraith-owned browser profile on the device. The profile survives TaskWraith restarts, but it is separate from Safari, Chrome, and provider sign-ins.

## Where to find it

Open the right dock and select **Canvas**, or ask the agent to browse. A navigation request opens Canvas automatically in the active task when no browser tab is already open.

The empty Canvas starts with a quiet **New tab** view. Use **+** to switch between Browser, Sketch Canvas, Mesh Canvas, and Simulator Canvas. Use **…** for browser profile and privacy controls. The placement button moves the current surface into its own window without reloading a live Browser or Sketch tab.

The Canvas window uses the same tab strip and surface picker as the dock. Browser tabs keep their address bar, back/forward history, reload/stop control, and live loading state. Choose **Dock** in the window header to move all of that window's live Browser/Sketch tabs back into the owning task. Mesh Canvas, Simulator Canvas, and Media Viewer use the same pop-out/Dock placement pattern.

<!-- screenshot-pending: Canvas Browser in the right dock with the address bar and a loaded page -->

## Browse with an agent

1. Choose **Accept Edits**, **Full WS Access**, or **Full Access** in the composer.
2. Ask naturally, for example: “Go on Google and search for Cambridge weather, then open the BBC local forecast.”
3. The agent opens Canvas in this task, navigates, inspects the visible page, and can click or type ordinary non-secret form values. The final page stays open for you.
4. If a site asks for a password, passkey, or verification code, take over the Canvas and complete that step yourself.
5. Tell the agent to continue after sign-in. It can use the resulting signed-in page, subject to the same browser controls and the instructions you give it.

Accept Edits and higher authorize ordinary navigation, clicks, and typing without a second approval for every page action. Ask and Plan keep these actions attended with per-invocation approval. Workspace-wide denies, preview-model clamps, stale-target checks, covered-element checks, and the recent-human-input takeover guard still apply. Script evaluation keeps its separate, stricter permission path.

**One exception overrides your posture entirely:** a click on a target the page labels destructive or financial stops for a single native confirmation — "Allow one consequential action?" — even at Full Access. The check runs before dispatch and inside the same lock, so a second interaction cannot slip past while you are deciding, and declining refuses that one action rather than ending the run. Raising your permission tier does not remove it.

## Sign-ins and credentials

- TaskWraith retains the Canvas Browser's cookies and site storage between app launches.
- The profile belongs to TaskWraith on this device; it does not import or expose Safari, Chrome, password-manager, or provider credentials.
- Agents cannot type into password, one-time-code, or other credential-marked fields. Coordinate-based clicks and script evaluation are not a workaround for that boundary.
- When you interact with the page, agent actuation yields rather than competing with your input.

## Clear the browser profile

1. Open **Canvas** in the right dock.
2. Select **…** to open **TaskWraith Browser** profile controls.
3. Choose **Clear browsing data…**, review the scope, then select **Clear data**.

The reset closes browser tabs across all tasks before clearing cookies, sign-ins, site data, and cache. Sketch, Mesh, Simulator, rendered HTML, image, and device canvases are preserved. The reset is human-only; agents cannot invoke it through Canvas or MCP tools.

## Browser boundaries

- Canvas accepts HTTP and HTTPS pages. Link-local and cloud-metadata addresses stay blocked, and private-network hosts require the existing allowlist policy.
- Downloads and website permission prompts are blocked.
- Pages that request a new window stay inside the Canvas Browser.
- Use the address-bar control to go back, forward, reload, stop, or open the current page in your default browser.
- Closing a Canvas window closes its window-owned live Browser/Sketch tabs. Choosing **Dock** transfers them instead.

## Tips and related guides

- [Canvas composer button](./canvas-composer-button.md) — open a URL directly in a separate floating Canvas window.
- [Canvas multiview pane](./canvas-multiview-pane.md) — embed a live web preview in a split workspace pane.
- [Mesh Canvas](./mesh-canvas.md) — inspect and author chat-owned 3D scenes.
- [iOS canvas preview](./ios-canvas-preview.md) — preview Canvas content on the companion.
