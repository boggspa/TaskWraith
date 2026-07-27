# How-To Manual — Screenshot Shot List

85 screenshots, one per guide page. Save each PNG to `docs/how-to/images/` with the exact **Save as** filename below, then replace the matching `screenshot-pending` comment with the image tag.

Current inventory after the 2026-07-18 latest-source capture pass: **63 captured, 22 pending**. See [`REMAINING.md`](REMAINING.md) for the unresolved set.

The current refresh uses latest-source development apps, not an installed release build. Existing captures can be replaced in place without changing the inventory count.

## Capture settings

- **Format:** PNG at native display resolution. Do not upscale a small capture.
- **Theme:** use a consistent current theme unless the page specifically documents Appearance or dark mode.
- **Scope:** capture or crop to the relevant panel/control so the detail remains legible. Include surrounding chrome only when it explains where the feature lives.
- **State:** put the UI in the state the caption describes (e.g. a popover open, a chip active, an ensemble running).
- **Privacy:** use only the authorized `Test 1` through `Test 4` workspaces for live examples. Workspace names, agent/task metrics, usage telemetry, and live demo transcripts are acceptable; full private file paths, secrets, pairing QR codes, and unrelated personal content are not. Crop or redact before committing when necessary.

## Shots


### approvals-and-permissions

| Save as | Platform | Capture | Where to find it |
|---|---|---|---|
| `approvals-and-permissions__approval-ledger.png` | Electron | Approval Ledger panel with filter and export controls | **Settings → Automation → Approvals & Grants.** |
| `approvals-and-permissions__approval-timeouts.png` | Electron | Settings panel showing approval timeout fields per provider | Settings → **Behavior** tab → **Timeout windows** section. |
| `approvals-and-permissions__pending-approval-modal.png` | Electron | Pending approval modal showing Accept / Decline options with countdown | Appears automatically above the composer for the chat that triggered the request, whenever an agent's action needs your approval. |
| `approvals-and-permissions__permission-elevation-sheet.png` | Electron | Permission elevation sheet showing posture options | Appears automatically over the current chat when you raise the **permissions chip** in the composer (or the side-chat composer) to Default Approval, Workspace Write, or Trusted Session. |
| `approvals-and-permissions__provider-agentic-policies.png` | Electron | Provider settings showing agentic policy matrix | **Settings → AI & Providers → Providers → Agentic services.** A read-only summary ("Policy posture") also appears on **Settings → Data → Safety & Privacy**, with an **Edit policies** button that jumps back here. |

### canvas-and-previews

| Save as | Platform | Capture | Where to find it |
|---|---|---|---|
| `canvas-and-previews__canvas-composer-button.png` | Electron | Canvas composer button in the telemetry row | It's an icon-only button in the composer's telemetry row (the footer icon cluster), next to the Multiview layout picker. |
| `canvas-and-previews__canvas-multiview-pane.png` | Electron | Canvas multiview pane showing an embedded preview | Switch to a split multiview layout (2/3/4 panes) from the composer's Plus Tools menu. |
| `canvas-and-previews__mesh-canvas.png` | Electron | Mesh Canvas dock with direct-model and scene-package import actions | Open the composer's **Canvas** menu, choose **Open Mesh Canvas**, then use the right-dock toolbar. |
| `canvas-and-previews__ios-canvas-preview.png` | iOS | iOS canvas preview card in the companion app | Open a chat in the companion app that has an open Canvas on the desktop. |

### chats-and-threads

| Save as | Platform | Capture | Where to find it |
|---|---|---|---|
| `chats-and-threads__chat-types.png` | Electron | Chat surface with the Chat / Code / Work switcher and chat, Shared, and Ensemble sections | Use **Chat** for General chats, **Code** for workspace-scoped threads/workflows/boards, and **Work** for Projects; Pinned, Recents, Ensembles, and Shared are scoped to the active Chat or Code surface. |
| `chats-and-threads__in-chat-search.png` | Electron | In-chat search bar with highlighted results in the transcript | In any chat, press **⌘F** on macOS or **Ctrl+F** on Windows/Linux to open the search bar above the transcript. |
| `chats-and-threads__pinned-messages.png` | Electron | Pinned messages panel in the right dock | Pin a message from its hover action chip or right-click context menu in any transcript. |
| `chats-and-threads__side-chat.png` | Electron | Side chat panel docked on the right | Open the **linked chat menu** (the split-pane icon with a chevron, in the chat header next to the other corner buttons) and choose how to open it: - **Open isolated side split** — docks a sidecar pane beside the current chat with a copied parent snapshot. |
| `chats-and-threads__sub-thread-delegation.png` | Electron | Sub-thread delegation card and return card in a chat transcript | Open a chat's overflow menu in the sidebar and choose **Delegate to a sub-thread**. |

### composer

| Save as | Platform | Capture | Where to find it |
|---|---|---|---|
| `composer__ensemble-mode-picker.png` | Electron | Composer ensemble mode picker showing Turn / Continuous options | In an **ensemble chat**, look at the **composer's action row** above the input box. |
| `composer__goal-button.png` | Electron | Composer goal button popover showing objective and status | In the **composer's telemetry row** (the icon row beneath the prompt box), next to the Screen Watch and schedule controls. |
| `composer__plus-tools-menu.png` | Electron | Composer + tools menu expanded showing attachments, multiview, screen watch | Click the **+ button** at the start of the composer's action row (next to the prompt input, identified by the plus icon). |
| `composer__provider-model-permissions-pickers.png` | Electron | Composer inline pickers row with provider, model+reasoning, and permissions chips | In the **composer's inline pickers row**, just below the prompt input. |
| `composer__schedule-prompt.png` | Electron | Composer schedule button with quick offset options | In the **composer's control row** (the icon row beneath the prompt box), next to the Goal button. |
| `composer__slash-commands.png` | Electron | Composer slash command menu open with available commands | Open it from the **chat composer** in three ways: - Type `/` at the start of a word in the composer. |

### ensemble-mode

| Save as | Platform | Capture | Where to find it |
|---|---|---|---|
| `ensemble-mode__continuous-hops-meter.png` | Electron | Continuous hops meter chip showing "2/6" | In an ensemble chat's composer, next to the Turn / Continuous mode picker, whenever Continuous mode is active for the current round. |
| `ensemble-mode__create-ensemble-chat.png` | Electron | Active new Ensemble draft with roster controls and participant chips | Create a new draft, turn **Ensemble** on before first send, and capture the active Ensemble composer plus its roster controls. |
| `ensemble-mode__fan-out.png` | Electron | Fan-out toggle chip next to the mode picker | In an ensemble chat, it sits as a separate chip group right beside the Turn / Continuous orchestration mode picker in the composer's action row. |
| `ensemble-mode__ios-ensemble-ui.png` | iOS | iOS companion showing ensemble strip and roster sheet | Open any Ensemble chat on the companion app — the chip strip appears automatically in the composer, above the message field. |
| `ensemble-mode__mention-yield-routing.png` | Electron | Composer showing an @-mention being typed with role autocomplete | Type `@` followed by a participant's role or model name in the composer during an ensemble chat — an autocomplete menu lists matching participants. |
| `ensemble-mode__participant-chip-strip.png` | Electron | Participant chip strip above composer with multiple provider chips | In an ensemble chat, the strip sits in the composer's above-row stack: below the branch / files-changed / Create PR row (and any external-path rows), and above the message textarea. |
| `ensemble-mode__round-cards.png` | Electron | Manually expanded completed Ensemble round with participant activity and close-out card | Expand a completed round after its close-out appears; live rounds stay flat, while close-out-backed completed rounds collapse by default. |
| `ensemble-mode__saved-roster-presets.png` | Electron | Ensemble roster settings panel with saved presets | Settings → **AI & Providers → Ensemble roster** for the full editor (create, duplicate, rename, delete, and edit every participant). |

### footer-control-row

| Save as | Platform | Capture | Where to find it |
|---|---|---|---|
| `footer-control-row__approvals-popover.png` | Electron | Sidebar footer red shield and expanded Approvals popover | In the **Sidebar footer control row** — click the **red shield** icon. |
| `footer-control-row__devices-popover.png` | Electron | Sidebar footer green devices icon and expanded Devices popover | In the **Sidebar footer control row** — click the **green devices** icon (when iOS remote is enabled). |
| `footer-control-row__shares-popover.png` | Electron | Sidebar footer yellow shares icon and expanded Shares popover | In the **Sidebar footer control row** — click the **yellow shares** icon. |

### getting-started

| Save as | Platform | Capture | Where to find it |
|---|---|---|---|
| `getting-started__add-workspace.png` | Electron | Workspaces section header with its Add workspace plus button | Select **Code**, then click the **+** button on the **Workspaces** section header, or go to **Settings → Workspaces → Workspaces**. |
| `getting-started__first-launch-sheet.png` | Electron | Top of the First Launch Sheet showing provider status and authentication actions | It appears automatically the first time you launch TaskWraith. |
| `getting-started__sidebar-onboarding-hint.png` | Electron | Sidebar onboarding hint card under the + button | In the **Sidebar**, directly under the **+** (Add workspace) button, when no workspaces are loaded. |
| `getting-started__welcome-screen.png` | Electron | General welcome draft with greeting, composer, and Weather/Sky backdrop | Appears in the **center stage** when a selected General draft is pristine and idle; workspace drafts can additionally show usage and activity dashboards. |

### goals-todos-and-scheduling

| Save as | Platform | Capture | Where to find it |
|---|---|---|---|
| `goals-todos-and-scheduling__goals.png` | Electron | Goal popover showing objective text and lifecycle status dropdown | In the **composer's control row**, click the target-shaped **Goal** button to open the Goal popover. |
| `goals-todos-and-scheduling__routines-and-scheduled-tasks.png` | Electron | ComposerScheduleButton showing quick-offset schedule picker | For a single message: the **clock icon** in the composer's control row. |
| `goals-todos-and-scheduling__todos.png` | Electron | TodoChecklistCard showing multiple items with status badges | A checklist appears inline in the transcript on the tool-activity row where the agent published it, and a **Plan** button (checklist icon) in the composer's telemetry row opens a popover with every lane's full checklist. |

### media-audio-and-video

| Save as | Platform | Capture | Where to find it |
|---|---|---|---|
| `media-audio-and-video__chat-media-dock.png` | Electron | Chat media dock in the right panel | Click the media icon among the corner controls above the transcript (it shows a count badge when the chat has media) to open the **Media** tab in the right dock. |
| `media-audio-and-video__inline-transcript-media.png` | Electron | Inline media strip within a transcript message | It renders automatically beneath any transcript message (user or assistant) that has attachments, directly in the chat view — no separate panel to open. |
| `media-audio-and-video__ios-media-playback.png` | iOS | iOS media playback in the companion app | Open any chat that has audio or video attachments. |
| `media-audio-and-video__multiview-media-pane.png` | Electron | Multiview media pane showing a detached video player | Click **Detach to pane** (or the pop-out icon) on an audio/video attachment — available on the inline transcript media card, in the chat media dock, and on the image/media preview overlay. |
| `media-audio-and-video__waveform-audio-player.png` | Electron | Waveform audio player in the transcript or media pane | It appears wherever an audio attachment is rendered: inline in the transcript under a message, in the chat media dock (the right-side panel listing uploads and paths), and in a detached Multiview media pane when you pop a clip out of the transcript flow. |

### notifications-and-status

| Save as | Platform | Capture | Where to find it |
|---|---|---|---|
| `notifications-and-status__notification-zone.png` | Electron | Notification zone showing a sample toast/alert banner | It appears on the welcome / new-thread screen for a selected pristine, idle draft and on the First Launch Sheet shown on your first run. |
| `notifications-and-status__participant-health.png` | Electron | ParticipantHealthCard showing ok/warning states for multiple providers | Participant health cards appear automatically, inline in the transcript, in any Ensemble chat — they're inserted just before a round dispatches, as the orchestrator's pre-flight check on each participant. |
| `notifications-and-status__provider-health-chips.png` | Electron | OllamaHealthChip showing green/connected state next to provider picker | Warning chips appear in the **composer chips row**, just above the prompt input, alongside the queued-run-count chip — the row only renders when there's something to show. |
| `notifications-and-status__push-notifications.png` | iOS | iOS push notification from TaskWraith on the lock screen | Push notifications arrive as system notifications on the paired iPhone/iPad — there's no in-app notification list to open. |
| `notifications-and-status__sub-thread-status-ticker.png` | Electron | SubThreadStatusTicker showing running/completed sub-thread states | It renders inline above the transcript of the parent chat, and only appears while at least one of that chat's sub-threads is running — it disappears again once all sub-threads finish or stop. |

### settings-and-configuration

| Save as | Platform | Capture | Where to find it |
|---|---|---|---|
| `settings-and-configuration__appearance-tab.png` | Electron | Appearance tab showing theme selector, accent color picker, and FX Labs section | Open **Settings → App → Appearance**. |
| `settings-and-configuration__devices-tab.png` | Electron | Devices tab showing QR code, paired devices list, and networking options | **Settings → Integrations → Devices**. |
| `settings-and-configuration__general-tab.png` | Electron | General tab showing behavior settings, context turns slider, and product ops section | Open **Settings → App → General**. |
| `settings-and-configuration__keyboard-shortcuts-tab.png` | Electron | Keyboard shortcuts tab showing editable keybinding list | Open the sidebar footer **Settings** entry, then choose **Keyboard shortcuts** under the App group in the Settings sidebar rail. |
| `settings-and-configuration__local-servers-tab.png` | Electron | Local servers tab showing dev server list with workspace associations | **Settings → Integrations → Local servers** |
| `settings-and-configuration__local-model-tool-surface.png` | Electron | Provider Tools view showing Ollama's gateway profile and compact direct tool surface | **Settings → Integrations → Provider Tools**; select or filter for Ollama and show the 39 direct tools plus the capability gateway. |
| `settings-and-configuration__mcp-servers-tab.png` | Electron | MCP servers tab showing server list with add/edit/import controls | **Settings → Integrations → MCP Servers** |
| `settings-and-configuration__model-usage-tab.png` | Electron | Model usage tab showing usage dashboard, API rates table, and context lengths table | Open **Settings → Data → Model usage**. |
| `settings-and-configuration__plugins-tab.png` | Electron | Plugins tab showing marketplace and installed plugin list | **Settings → Integrations → Plugins** |
| `settings-and-configuration__provider-tools-tab.png` | Electron | Provider tools tab showing MCP bridge audit and tool catalog | **Settings → Integrations → Provider Tools**. |
| `settings-and-configuration__providers-tab.png` | Electron | Providers tab showing provider sign-in cards and agentic policy matrix | Open **Settings → AI & Providers → Providers**. |
| `settings-and-configuration__safety-and-privacy-tab.png` | Electron | Safety and privacy tab showing risk posture overview and deep-links | Open **Settings → Data → Safety & Privacy**. |
| `settings-and-configuration__shares-tab.png` | Electron | Shares tab showing collaborator list and access controls | **Settings → Integrations → Shares** |
| `settings-and-configuration__workspaces-tab.png` | Electron | Workspaces tab showing loaded workspace list with pin/remove controls | **Settings → Workspaces → Workspaces**. |

### sidebar-navigation

| Save as | Platform | Capture | Where to find it |
|---|---|---|---|
| `sidebar-navigation__overflow-menus.png` | Electron | Sidebar overflow menu expanded on a workspace or chat item | In the **Sidebar**, on any workspace or chat item — click the **⋯** (overflow) button or right-click the item. |
| `sidebar-navigation__project-reference-library.png` | Electron | Selected Project detail showing the metadata-only file, folder, and link References controls | Select **Work**, then select a Project; the References controls appear in its expanded detail panel. |
| `sidebar-navigation__settings-entry.png` | Electron | Sidebar footer with Settings button highlighted | In the **Sidebar footer** — click the **Settings** (gear) button. |
| `sidebar-navigation__sidebar-search.png` | Electron | Surface-scoped sidebar search focused with results | Select **Chat**, **Code**, or **Work**, then focus the search field below the switcher; capture text/results appropriate to that surface. |
| `sidebar-navigation__sidebar-sections.png` | Electron | Sidebar showing the Chat / Code / Work switcher and current Chat hierarchy | In the **left sidebar panel** of the TaskWraith main window, with **Chat** selected and its hierarchy visible. |
| `sidebar-navigation__update-pill.png` | Electron | Sidebar update pill above the masthead | In the **Sidebar**, directly above the masthead (workspace name / + button area), for as long as an update is available, downloading, downloaded, or has hit an error. |
| `sidebar-navigation__workspace-and-chat-tree.png` | Electron | Tight crop of an expanded authorized test workspace with a parent and linked child | Select **Code**, expand a workspace in **Workspaces**, then expand a thread with a linked side chat or sub-thread. Keep full filesystem paths and unrelated workspace names out of frame. |

### transcript-and-search

| Save as | Platform | Capture | Where to find it |
|---|---|---|---|
| `transcript-and-search__activity-stack.png` | Electron | Collapsible activity stack showing tool calls in the transcript | Renders inline in the transcript, beneath an agent's turn, wherever the agent used tools. |
| `transcript-and-search__agent-question-cards.png` | Electron | Agent question card inline in the transcript | The card appears automatically in the transcript, anchored next to the system message marking the question, whenever a participant asks one. |
| `transcript-and-search__copy-transcript-button.png` | Electron | Composer telemetry row showing the copy transcript button | It's a small icon button in the composer's bottom telemetry row, next to the run timecode, Goal button, and Multiview layout picker, just below the message input. |
| `transcript-and-search__diff-hover-preview.png` | Electron | Hovering over a diff in the transcript to show the preview | It attaches to two places in the transcript: - Rows in the **File changes** card above the composer (each changed-file row and its "Diff" bubble). |
| `transcript-and-search__file-changes-row.png` | Electron | File changes row showing pending diffs above the composer | It sits at the bottom of the transcript, just above the composer, in any workspace chat that has file changes (it's hidden in a General/Global chat unless that chat has changes too). |
| `transcript-and-search__inspector-panel.png` | Electron | Inspector panel showing diff/Raw/Delegation/Timeline tabs | Click **Inspect** in the right-dock rim (the icon strip at the edge of the chat) to open it. |
| `transcript-and-search__message-context-menu.png` | Electron | Right-click context menu on a transcript message | Right-click any message bubble in the main transcript: user messages, assistant/system/guest-participant replies, tool messages, provider-failure cards, and sub-thread result cards. |
| `transcript-and-search__proposed-plan-cards.png` | Electron | Proposed plan card in the transcript | Appears automatically in the **transcript**, attached to the assistant message that contains the plan, whenever the active permission preset is **Plan** (set via the composer's permissions chip) and the agent's reply is plan-shaped — either an explicit plan block, or (while in plan mode) a substantive turn with real structure. |
| `transcript-and-search__queued-messages-row.png` | Electron | Queued messages row above the composer input | Above the composer input, in the same stack that holds the ensemble participant chips and the Create-PR row. |
| `transcript-and-search__right-dock-rim.png` | Electron | Right dock rim tabs in the chat corner | It appears at the top of the right dock whenever the dock is open. |
| `transcript-and-search__run-cockpit-panel.png` | Electron | Run cockpit panel in the right dock | Click the **Run** tab on the right-dock rim (or use the "Open Run rail" toggle) to open it for the current pane. |
| `transcript-and-search__transcript-message-stream.png` | Electron | Main chat transcript showing a multi-message conversation thread | It fills the center stage whenever a chat is open. |

### workflows-and-boards

| Save as | Platform | Capture | Where to find it |
|---|---|---|---|
| `workflows-and-boards__board-overflow-actions.png` | Electron | Board overflow menu showing pin, rename, duplicate, archive options | Select **Code**, then in **Workspace Boards** hover a board row and click its **⋯** button, or right-click the row. |
| `workflows-and-boards__workflow-compose-controls.png` | Electron | Workflow compose controls showing cadence and interval pickers | Select **Code**, open **Workflows**, and click the **+** (New workflow) button. |
| `workflows-and-boards__workflow-creator.png` | Electron | New workflow draft with inline workflow and Ensemble controls | Select **Code**, then click the **+** ("New workflow") button in **Workflows**. |
| `workflows-and-boards__workflows-sidebar-section.png` | Electron | Expanded Workflows section in its empty state with the New workflow button | Select **Code**, then find **Workflows** in the sidebar hierarchy. |
| `workflows-and-boards__workspace-boards.png` | Electron | Workspace board view with kanban columns and cards | Select **Code**, then open the **Workspace Boards** section. |
