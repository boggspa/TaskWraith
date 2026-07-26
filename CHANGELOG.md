# Changelog

Notable changes to TaskWraith, the local-first desktop workbench for running and
reviewing AI coding agents. Entries are user-facing highlights; TaskWraith's
orchestration, local history, and workspace authority stay on your machine,
while selected cloud providers still receive the prompt and run context needed
to answer.

## 1.9.0 - 2026-07-26

If 1.8.9 gave every agent **room to work**, 1.9.0 connects those rooms into a
workshop. Parallel lanes can return work you choose to keep, top-level threads
can leave one another durable notes, and the dock can hold the documents,
canvases, mail, and calendar context around the code. Pi opens a broad BYOK
model bench, Mistral Vibe adds a plan-backed door, and the same local authority
still decides what each seat may touch—or which colours it may change.

### Branches come back as candidates

Write-capable fan-out lanes can now ask for an **isolated worktree** instead of
sharing the checkout. Each lane forks from the committed workspace boundary,
returns a durable candidate, and appears in a Compare dock where its patch can
be inspected and promoted deliberately. The composer exposes that choice as an
Isolate toggle, while `ensemble_await` and `ensemble_lane_result` give agent-run
workflows a real join-and-read step rather than making a synthesizer scrape the
panel transcript.

Git work is easier to follow before and after the fan-out. Main owns a
per-thread workflow marker, the sidebar groups marked threads under Git with
their true repository name, and worktree patches have explicit capture/apply
contracts. Read-only postures can inspect `git status`, `git diff`, and
`git log` without an approval card, so review lanes can gather evidence without
borrowing mutation authority.

### Threads can knock on another door

Top-level threads gain **peer messages**: a durable, permission-gated inbox for
passing a note to another task without pretending the two provider sessions
share context. A message enters the target's next turn exactly once, visibly
labelled as untrusted relayed content; an optional wake remains a separate,
more privileged choice. Exact ids and unambiguous titles resolve in main, the
startup sweep catches queued delivery, and user- plus agent-originated sends
converge on the same authority.

The Peers dock makes that path visible on desktop, and the paired iPhone/iPad
companion can read the inbox, send a reply, and show the same pending indicator.
Sub-thread return still flows child to parent; peer messaging is the deliberate
sideways path between independent top-level tasks.

### The dock becomes a desk

A new **Office dock** brings focused editors for Word documents, spreadsheets,
slide decks, calendars, and mail drafts into the workspace. TaskWraith can
round-trip DOCX, XLSX, PPTX, and ICS through bounded local codecs, preserve
deck speaker notes and document images, import dropped files, and open or reveal
grant-covered documents outside the workspace without turning a reference into
silent access.

An optional Outlook connector uses Microsoft's device-code sign-in to read
mail and calendar context, save email drafts, and create personal time blocks.
It deliberately has no send-mail permission, refuses invite-producing attendee
creation, bounds Graph responses, and treats message/event text as untrusted
third-party content. Canvas work also joins the right dock with sketch embeds
and chat-scoped list/close controls, so visual and document context can stay
beside the thread that owns it.

Agent-driven Canvas actions now fail closed when a target or human-input
snapshot is stale, serialize per surface, and stand down while a human is driving.
Credential fields remain human-only, in-progress sketch strokes survive agent
updates, and the audit receipt is persisted before a liveness check can fail.
Canvas drivers remain bound to their isolated surfaces and must never target
TaskWraith's own consent chrome; pausing for recent human input is courtesy,
not a substitute for that structural boundary.

### Canvas consent follows the surface

Permission to let an agent interact with a preview now applies **only to the
surface you approved**, not to every preview opened afterwards in the same run
— an agent can enumerate a chat's canvases, so an unscoped grant reached
windows you never saw a prompt for. Because a workspace-wide "interact with any
preview, in any chat, until revoked" grant is not a scope anyone can
meaningfully consent to, it can no longer authorize an interaction; a broader
grant persisted by an older build is inert rather than honoured.

Relatedly, and worth stating plainly: when an agent asked to type into a field,
the approval record kept the text it was about to type, and that record reached
TaskWraith's durable history — even though the tool contract told agents the
typed value was never recorded. New runs no longer store it. **Existing history
is not rewritten**, so if a previously typed value was sensitive, clear that
chat's history.

### Pi opens the model bench

**Pi** joins as a first-class coding-agent seat with isolated runtime homes and
bring-your-own-key access to DeepSeek, Z.ai/GLM, Qwen, MiniMax, Mistral, Groq,
and Cerebras models. Each upstream has its own key boundary, model names,
pricing row, spend attribution, and brand hue; pickers show only configured
upstreams, transcript attribution keeps the actual upstream's hue, and desktop
plus iOS carry the same provider/model map. The New Additions card now leads
with that upstream lineup.

AntiGravity becomes steadier at the same time: conversations resume, successful
model discovery is cached, unservable catalogue rows are filtered, Gemini 3.x
thought signatures survive tool replay, and schema unions stay real unions.
Denied services remain denied, cache reads are disclosed, and throttling is
distinguished from a genuinely empty allowance.

### Mistral gets its own door

**Mistral Vibe** joins as a first-class ACP seat for the user's Mistral plan,
separate from Pi's metered `mistral/*` API-key upstream. Devstral Small is the
fast, frugal default beside Mistral Medium 3.5; both carry their 262K context
map onto iOS, and a clearly heuristic plan-burn meter gives the otherwise
unmetered subscription a cautious early warning.

The distinction is authority, not just branding. Read-only and write-capable
seats select Vibe's gated `plan` and `default` session modes over ACP; its
auto-approve modes are unreachable, and inherited Mistral API credentials are
scrubbed so a plan-backed run cannot silently cross into Pi's pay-as-you-go
bill. Fresh sessions receive explicit host-composed context instead of
pretending provider history was retained. Provably read-only shell commands
remain useful in Plan, while short Vibe throttles surface as retryable warnings
instead of masquerading as a subscription quota wall.

The composer model picker and iOS first-launch sheet now carry that same
Mistral roster, and New Additions no longer promises an image-input capability
the seat does not expose. An opt-in live exercise against `vibe-acp 2.22.0`
also proves the normal lane can select Plan plus Devstral Small, use plan
credentials without inheriting an API key, return an answer, and close cleanly.
That source exercise is evidence for the ordinary ACP lane, not a substitute
for the scheduled-seat release seal.

### The workshop can wear your colours

Agents on write-capable seats can read and set a small allowlist of typed
**theme tokens** through `theme_tokens_get` and `theme_tokens_set`. This is a
data channel, not arbitrary CSS: selectors, rules, URLs, calculations, provider
identity colours, focus rings, and approval-card geometry stay outside the
writable set, with validation repeated when the renderer applies persisted
values. Successful writes are pushed narrowly to every open window and applied
through the same validated appearance path, so the change appears without a
reload. Read-only review seats can inspect the palette but cannot restyle it.

Two properties of the appearance channel are deliberately not negotiable. A
restyle always asks: `theme_tokens_set` prompts on every call, and no standing
grant, trusted session, or session-wide auto-approve can quiet it — previously
a single "allow for this session" on any unrelated tool silenced every later
restyle. And the approval card's own controls no longer take their spacing
from values an agent can write, so a restyle cannot crowd Accept and Reject
together and turn a near-miss click into a grant.

### Every provider leaves a clearer receipt

Run management now measures lifecycle assurance across all ten stable provider
identities without turning maturity into provider admission. Immutable launch
plans, per-run homes, exact transport close/kill joins, cancellation
settlement, launch evidence, signed posture validation, and honest capability
reports land provider by provider. Missing assurance produces a receipt or
warning and the safest compatible mode; it does not silently hide a seat the
user chose. An ensemble seat that cannot start now carries the reason with it —
a missing sign-in reads as a missing sign-in instead of “dispatch failed” — while
a seat stopped by cancellation stays quiet rather than blaming its provider.

The production adapter registry is checked against that full roster before a
new identity can become a mysterious startup crash. Its test follows the
actual registration graph, and a mismatch now names both the missing adapter
and the construction site that needs repair.

That same discipline reaches smaller authority edges: peer-thread wakes,
fan-out candidates, provider capability projection, grant expiry, and review
or compaction runs all re-check the scope they are about to use. `canvas_eval`
is available as an approval-visible instrument in Plan rather than disappearing
behind a silent deny.

### The phone keeps the same map

iOS gains the full-colour Ensemble identity, anchored participant editors,
Pi's provider/model branding, Mistral Vibe's context map, and a compact
single-row Ensemble composer that adapts to landscape and short viewports.
Above-composer pills stay reachable while typing; fan-out lane results and
provider-run failures get native cards; the workspace/branch pill opens a Git
surface for branch, checkout, and PR-watch actions; and the Peers inspector
carries cross-thread messages. Pairing reconnects no longer flap the app back
to the setup screen.

Across both apps, provider rows use cleaner labels, pickers stop calling an
empty model list “loading,” compact tool foldouts retain their diff accents,
and Codex authentication reports revoked credentials honestly and upgrades
that installed runtime instead of a different copy. Codex also stops looking
broken to anyone signed in elsewhere: TaskWraith keeps its own Codex home, so a
terminal `codex login` authenticates `~/.codex` and leaves this one untouched,
and the sign-in notice now says exactly that — the home it uses, the one it does
not, and the in-app route that works.

For anyone who would rather not sign in twice, **Settings → Providers → Codex →
“Use my existing Codex sign-in”** borrows the `~/.codex` credential instead.
It is off by default and asks plainly, because it trades containment for a
working seat: TaskWraith then reads and writes a file it otherwise never
touches. Borrowed, not copied — ChatGPT rotates its refresh token on use, so
two homes holding one token revoke each other. TaskWraith takes a lease for the
lifetime of the Codex process, commits any rotation straight back to `~/.codex`,
refuses a writeback that would move the credential backwards, and hands the
lease back on exit, removing the borrowed credential and nothing else. A second
TaskWraith window, or a machine with nothing to borrow, quietly runs the way it
always did rather than failing a launch that would otherwise have worked.

### Product observation says exactly what it counts

TaskWraith now has a public privacy notice and a visible, user-disableable
activity-reporting control under **Settings → Safety & Privacy**. A clear
first-launch choice now keeps first-party observation off until the user
affirmatively selects **Share minimal activity**; **Don't share** is equally
prominent and neither choice removes a feature. When enabled, it sends at most
one no-ID check-in per UTC day: schema, event, day, app version,
operating-system family, processor family, and release channel. Both controls
show that complete contract in the app. Prompts, workspaces, provider choices,
usage, and stable installation identifiers are outside it; builds without an
endpoint send nothing.

The same setting can now power an approximate **apps online now** gauge without
creating a session history. Each running app renews a random, process-only
lease; the receiver holds it in RAM for 150 seconds, returns only the aggregate
unexpired count, and never writes lease values, renewals, start/end times, or
durations to its analytics database. Switching the setting off stops renewals
and retracts the lease when reachable; a crashed or disconnected app simply
ages out.

That boundary also changes how adoption is described. GitHub release requests,
update-manifest checks, repository traffic, App Store aggregates, and optional
desktop activity check-ins are separate measures with separate caveats—none is
silently promoted into a unique-user count. They are used only to understand
adoption, prioritise supported platforms, and verify release/update health,
never for advertising or individual profiling.

New doctrine-integrity and formatting-ratchet
gates keep future agent work from turning documentation or unrelated source
into collateral churn.

## 1.8.9 - 2026-07-24

If 1.8.8 was about who can sit at the table, 1.8.9 is about giving everyone at
that table **room to work — and giving you permission to look away**. Agents
get their own isolated checkouts, your merged work gets a watcher that taps you
on the shoulder only when something actually changes, and the panel wastes
fewer turns figuring out how to collaborate.

### A room of their own

Runs that need one can now claim an **isolated worktree before dispatch**:
per-thread bindings are allocated during preflight, persisted asynchronously,
and reused on later turns, so parallel threads stop editing the same checkout
out from under each other. Diff Studio follows the allocated worktree — review
shows the tree the agent actually edited, not the base checkout. The same
instinct runs deeper: Codex's runtime home is now seat-local instead of
colliding with unrelated host state, and main-owned chat fields (worktree
bindings included) survive stale renderer saves instead of being overwritten
by an older snapshot.

### Someone keeps watch

The GitHub popover gains **Watch this PR** — a per-chat opt-in that keeps
polling after the agent's work lands. Polling is main-owned and skeptical: it
revalidates the PR number and current head before posting a status change,
deduplicates repeated CI states, and surfaces GitHub CLI authentication or
missing-PR failures instead of silently dropping them. You close the laptop;
TaskWraith watches the checks.

### AntiGravity takes a full seat

Last release AntiGravity joined the roster; this release it becomes a
**first-class Ensemble participant** — lane-aware reachability, isolated seat
prompting, serial and fan-out routing, compaction, usage telemetry, and the
ordinary participant affordances, where it was previously skipped silently
before dispatch. Tool Grants close the same gap: Cursor and AntiGravity now
expose the identical workspace-grant controls their broker routes actually
honor, and AntiGravity's ensemble chips wear their proper green.

### Rounds that get to the point

Every seat now receives a **concrete statement of what its posture permits**,
so nobody spends a turn asking. Boss guidance favors one explicit-target
fan-out for independent assignments, keeps assignment status current, and
closes completed goals without confirmation laps. Audited chat-local
`ensemble_send` participation stops presenting itself as a scary generic
mutation approval, user-directed background lanes run under the seat's own
posture, and stage badges read as stage — not status. The separate Work
Session mode retires in favor of the primitives that outgrew it: Turn and
Continuous rounds, stage roles, and explicit fan-out. And for the human in the
loop, the Blackboard learns **rich polls** with a larger board quota — put a
question to the panel and count the votes.

### New minds on the roster

**Claude Opus 5** is selectable across desktop and iOS — a single
`claude-opus-5` row carrying its default 1M context, the full reasoning ladder
through Ultracode, optional Fast mode, and rate metadata. The New Additions
card now leads with Opus 5 beside the current Gemini 3.6 Flash, 3.5 Flash, and
3.5 Flash-Lite lineup, byte-identical on desktop and iOS. The ChatGPT composer
shell graduates to quick settings.

### Calm to read, quick to follow

Settled transcript activity now **folds instead of jumping**: super-groups and
one-line summaries animate their transitions on desktop and iOS, hidden member
rows leave layout entirely, auto-follow survives participant boundaries, and
the jump-to-latest pill counts real messages. Approval requests float above
the composer instead of being clipped inside it, the ChatGPT shell drops the
unrelated running-state aura frame, and iOS converges roster editing, both
add-participant paths, and side-chat creation on the combined provider/model
picker. Under the hood, external usage history is time-bucketed before
aggregation — ending a launch stall — and intermediate APNs task notifications
are culled so your phone hears about state changes that matter.

## 1.8.8 - 2026-07-24

### Added
- **AntiGravity joins the provider roster (opt-in).** Bring your own Gemini
  API key and run Gemini models as a first-class provider: isolated per-turn
  execution, authenticated model discovery with product names, a prompt-cache
  setting, and an estimated-spend meter with a soft monthly budget in Model
  Usage. The plain API-key lane behaves like every other bring-your-own-key
  provider; the separate AntiGravity CLI integration stays behind its own
  informed-consent card with per-lane consent and honest dormant/rollback
  semantics.
- **A ChatGPT composer shell.** A new shell style that pairs the Codex
  above-row with a flat capsule body, with satellite actions, a tucked-tab
  above-row, and a wider model control — on desktop and the iPhone/iPad
  companion alike.
- **Live token telemetry while providers work.** Grok, Cursor, and Kimi now
  stream estimated working telemetry — text, thinking, and tool output — from
  one shared token-estimate authority. The working indicator and composer
  tally mark estimates and prefer live provider totals for context tracking,
  and the iPhone/iPad companion mirrors the same usage surfaces.
- **Boss full-roster fan-out.** An Ensemble Boss can fan work out to the
  entire roster in one action, with each participant running under its own
  permission posture; the panel now also shows participant turn order.
- **Transcript super-groups.** Adjacent one-line activity summaries condense
  into compact super-groups on desktop and iOS, collapsed summaries render as
  body text with tool-family icons, and every message gains a message-only
  copy action.
- **Blackboard housekeeping.** A confirmed full-board wipe, a larger post
  field, and section-highlighted cards.

### Changed
- **Read-only plans can run `git status`.** Tool grants respond immediately,
  and the grants picker is wider and easier to scan.
- **The sidebar organizes work more predictably.** Workspace ensembles are
  dual-listed under their workspace, unstarted draft chats stay hidden with
  one reusable draft per workspace, and Active Runs rows show the chat name.
- **The provider picker shows only connected providers.** Live providers are
  always offered; only AntiGravity is gated on its own discovery.
- **Usage plan labels read cleanly.** Sidebar plan labels are simpler, and
  Kimi's subscription tiers are shown by name.

### Fixed
- **Closing the window no longer ends active runs.** Runs keep executing after
  the window closes and are there when you come back.
- **Startup does less before first paint.** Project-reference reconciliation
  is deferred, roster discovery prewarms after paint, and ensemble provider
  discovery is bounded.
- **Ensemble routing and lifecycle are more dependable.** Explicit foreground
  yields are honored, picker routing stays out of composer text, no-op and
  duplicate seat changes are no longer announced, remaining participant
  choices are filtered, and Cursor runs are bounded against yield/transport
  zombies and missing terminal events, with concurrent Cursor MCP broker
  routes isolated. Codex tolerates structured app-server errors.
- **Transcript reading stays calm.** Short thought durations are included,
  mixed file-change lists keep a stable attribution column, the sky stays
  behind message text, the attachment-access modal respects read-only posture,
  and the advisory chip, hover seed highlight, and per-message action pill no
  longer add noise. Long approval choices wrap in the mini approvals popover.
- **Permission grants are enforced more precisely.** Trusted external writes
  are honored, effective grant scope is clearer, and unsupported provider
  grants are rejected.

## 1.8.7 - 2026-07-22

### Added
- **Blackboard posts can land in their intended section.** The Composer's
  Blackboard popover now lets you choose Decisions, Facts, Risks, Do Not
  Repeat, or Notes before posting; Notes remains the default.
- **Settled transcript activity folds into readable one-line summaries.**
  Consecutive work activity and plain system notices collapse after completion,
  and expand on demand for the full detail. The iOS companion now carries the
  same compact treatment.
- **The welcome usage heatmap can build a full 90-day view without freezing the
  app.** External history scans run in a utility process and promote completed
  scans into the welcome experience.

### Fixed
- **Provider quota refreshes time out instead of blocking the desktop.** Every
  supported external usage endpoint now has a bounded 15-second request window.
- **Ensemble routing is more deterministic.** Seed-id aliases no longer leak
  into roster hints, duplicate session events coalesce, and explicit yield
  targets either resolve correctly or report a typed failure.
- **File changes display official provider marks, and multi-pane Goal buttons
  preserve the focused popover anchor.**
- **Blackboard post handling fails closed with scope-aware eviction and clearer
  missing-key diagnostics.**

## 1.8.6 - 2026-07-22

### Added
- **Path-B Cursor is selectable again after the 1.8.5 product path.** Managed
  Cursor stays on contained native-sandbox argv (read-only vs write by seat),
  First Launch and Settings restore CLI login, and sidebar Model Usage meters
  report Cursor quota again. Product, safety, how-to, and AGENTS docs match the
  live Path-B story rather than the interim fail-closed posture.
- **iOS companion parity advances across transcript, tools, and Diff Studio.**
  Structured `@mentions` and fenced code chrome land in the transcript; message
  actions and context-compaction cards are available; brand logos densify the
  provider/model picker and home list; an unfocused tools pill covers Ensemble,
  Goal, Plan, and Blackboard with glyphs; Diff Studio expands Codex-style file
  cards with inline hunks on liquid glass; Copy Transcript matches peer toolbar
  pill chrome; and the bridge gains a `blackboardPost` action for paired
  clients.

### Fixed
- **Packaged macOS builds no longer crash when Electron reads hardened fuses.**
  The final app bundle restores a valid ad-hoc signature after fuse hardening,
  and package smoke tests now verify the Electron framework signature before
  launch.
- **Composer queue and Steer are classic again.** Follow-up messages while a
  chat is busy go back through the durable RunQueue and `QueuedMessagesAboveRow`
  (Edit / Delete / Steer), instead of being redirected onto the Execution Stack
  strip above the composer. Execution Graph / Stack / Map remain Work-tab and
  map tooling — they no longer own day-to-day message queueing.
- **Queued messages sit shell-native, not double-wrapped.** The gray nested
  capsule around each queue item is gone — items are flat satellites inside the
  Composer-Shell above-row. Codex queue rows tuck like Grok above-rows (still
  not the detached Primary/Secondary workspace lead pills). Gemini (and
  matching Kimi/Modular) queue chrome uses the same provider blue/shell border
  as other above-rows in that hierarchy.
- **Busy sends never force the Execution Stack gate.**
  `shouldAppendBusySendToExecutionStack` stays hard-off so ordinary above-row
  busy follow-ups cannot rewire into Stack/Map without an explicit future opt-in.
- **Overlong Execution Stack titles truncate on busy-queue append** so the Stack
  strip stays readable when a long prompt is attached as a queue title.
- **Workspace Write no longer demands a second standing workspace grant** for
  ordinary shell/file/media services already covered by the signed run posture.
  Global deny, path containment, external-path force-prompt, elevated services,
  and Full Access sandbox-drop requirements stay intact.
- **Workspace tool grants survive settings sanitization and path matching.**
  Grants persist through the main sanitizer and compare with resolved paths, so
  a granted workspace root is not dropped or missed after normalize/resolve.
- **Recents stop leapfrogging on stream write recency.** The Recents list ranks
  by the last genuine user message (else `createdAt`) instead of live
  `updatedAt`, so concurrent active threads no longer race for the top slot
  while real user compose still promotes a thread.
- **Usage and quota fetches no longer freeze the desktop.** Cold-launch provider
  quota work and 90-day external heatmap loads stay non-blocking so the app
  remains responsive while meters catch up.
- **Orphaned `chat.runs` reconcile so iOS drops stale Active cards.** Desktop
  main reaps run records that no longer have a live owner; the companion stops
  showing Active for work that already finished.
- **iOS liquid-glass sheets no longer fall back to an opaque gray plate.**
  Presentation chrome prefers clear glass over poorly sampling regular glass,
  host clearing leaves visual-effect layers intact, and Form/Navigation hosts
  (Diff Studio, Tools, Schedule, provider picker, Settings including App Icon)
  stay transparent so the sheet glass shows through. The Claude-style phone
  composer chrome stays compact.

### Changed
- **Docs realign to always-enabled Kimi admission and live Path-B Cursor.**
  The 1.8.5 note claiming packaged builds still reject Kimi is corrected in
  place (admission is structural and always-enabled; unreviewed runs are
  labelled `unattested-development`), and product, QA, safety, and how-to notes
  describe Cursor as a contained `--sandbox enabled`, non-MCP managed seat with
  honest partial-backstop residuals. Sealed scheduled Kimi/Cursor execution
  remains genuinely unavailable and stays documented as such.

## 1.8.5 - 2026-07-20

### Added
- **Kimi ACP sessions can resume as durable, isolated seats.** Native ACP
  continuity now survives TaskWraith run boundaries, with seat checkpoints,
  resumable provider sessions, and bounded prompt compaction for longer-lived
  work.
- **Kimi K3 exposes selectable thinking and plan-aware context.** K3 offers
  Low, High, and Max reasoning controls, while the usable context limit follows
  the detected Moonshot plan from 256K through as much as 1M rather than
  advertising one fixed window to every account.
- **Needs your input surfaces pending agent questions.** A global banner and
  Sidebar/Approvals attention markers call out chats that are waiting on a
  user answer, and the unfocused desktop window can bounce or flash so a
  parked question is harder to miss.
- **Node Graphs show project thread relationships.** A Work-scoped sidebar
  section and thread-graph pane project user-drawn dependency edges between
  chats, with SVG connectors for the active project map.
- **Execution Graph, Stack, and Map inspect main-owned run structure.** Main
  owns stack runtime, permission ceilings, terminal joins, and dispatch wiring
  so repository diagnostics and attention stacks stay coherent across
  multi-step work.
- **PDF text extraction and on-device OCR are brokered tools.** Bundled
  `pdfjs-dist` text-layer extraction plus generalized Vision OCR let agents
  read PDF text and image contents through TaskWraith-hosted tools rather than
  opaque provider-side parsing.
- **Projects have a guarded reference library.** A selected project now exposes
  a References section for cataloguing relevant files, folders, and links. Each
  row can be excluded from or restored to the library, removed, and—when it is
  a file or folder—checked for last-known availability. The main-owned Projects
  registry persists the metadata through main-renderer-only IPC and the
  renderer facade. Its file/folder picker remains deliberately separate from
  access-grant pickers, verification performs one main-side existence check
  without reading content, and URL verification is rejected rather than
  fetching the network. A reference grants no file or network access and is
  never indexed or injected into agent context.
- **Sub-thread status ticker and Ensemble mailbox delivery.** Parent chats show
  a live sub-thread status ticker, and Ensemble parents can drain a durable
  sub-thread mailbox into the idle authority seat once so returned worker
  results reach Boss/Captain context without a manual paste.
- **Host-rerun continuation keeps Codex work on a fresh run identity.** After a
  host rerun, TaskWraith mints an independent continuation run that resumes the
  existing provider session instead of double-joining history on the approval
  run or spawning a virgin seat.
- **The host sky follows local conditions.** Weather, solar and lunar state,
  and the starfield can now shape the optional sky effects. When those effects
  are enabled, TaskWraith resolves the host's approximate location through
  `ipapi.co` with `ipwho.is` as fallback, rounds coordinates to 0.1 degrees
  (about 11 km) before requesting Open-Meteo data, and stores the result in the
  local `host-weather-cache.json`. No workspace or task content is sent as part
  of that lookup.

### Changed
- **Cursor runs again under Path-B contained native sandbox (+ write).**
  Managed Cursor is always-enabled (no brittle per-build fingerprint gate) and
  re-admitted through the shared CLI transport. Production argv always comes
  from the contained builders that hard-pin `--sandbox enabled`, with separate
  read-only and write-capable argv shapes routed by seat permission—never a
  bare uncontained `cursor-agent` spawn, never sandbox-disabled / force /
  yolo / resume-token argv from the production entry.
- **Fresh Ensemble panels start small and role-shaped.** New Ensemble chats now
  seed at most four active seats (Boss, Captain, Specialist, and an independent
  Outsider), while new saved roster presets begin with the first three roles
  and room for at most five. The twenty-seat limit remains a capacity ceiling
  rather than the default panel size.
- **Primary navigation is organized as Chat, Code, and Work.** The surface
  split makes conversation, workspace activity, and projects/workflows easier
  to distinguish. Switching or choosing a workspace from a pristine draft now
  preserves its selected provider, model, reasoning, permission posture, and
  unsent composer text.
- **Provider brand marks appear on the transcript filter rail.** Official
  provider logos replace ad-hoc colour-only chips so multi-provider transcripts
  are easier to scan.
- **Solo tool grants stay editable while a run is live.** Permission grants for
  solo seats can be adjusted during an active turn without waiting for the run
  to finish.
- **Projects now use a main-backed optimistic registry.** Shared pure registry
  operations, a main-owned `projects.json`, snapshot/apply/import IPC, change
  broadcasts, one-shot legacy import, and explicit main-renderer channel
  classification establish the durable boundary. The renderer store now uses
  that boundary through an optimistic facade. Main-owned Project Work profiles
  also establish an atomic home-chat claim for each project, with Work-surface
  controls to set, clear, and open the claimed home. View-only preferences such
  as the active surface and expanded state remain in renderer storage, while
  per-surface search queries stay session-only. An unhomed project can also
  **Start Project Home**: TaskWraith opens an ordinary pristine General draft
  and claims it for that project on the first committed message or run, while
  an abandoned draft remains reusable/reapable like any other pristine draft.
- **The right dock remembers the surface for the current context.** Chat and
  Code keep the last-selected dock destination per chat for the current app
  session. In Work, a chat that belongs unambiguously to one project uses that
  project's dock memory, so moving among the project's member threads retains
  the same destination; ambiguous membership safely falls back to the chat.

### Fixed
- **Provider and orchestration edges are more resilient.** Fixes cover Kimi
  transport and usage hardening, Ensemble roster imports, stale broker sockets,
  and related run-lifecycle cleanup.
- **Grok broker tools advertise under the TaskWraith MCP namespace.** The
  progressive gateway presents Grok-facing broker tools as TaskWraith rather
  than a legacy unqualified surface, and parent-provider binding prefers the
  live run session so approval modals name the correct seat.
- **External activity includes Grok and keeps paired-device rollups honest.**
  The activity scan reads Grok usage instead of reporting zero, and the paired
  device rollup agrees with the header totals.
- **Universal Mac builds ship both `@napi-rs/canvas` architectures.** The
  notarized macOS package includes the canvas native binaries required on both
  Apple Silicon and Intel so Canvas/PDF paths do not miss one arch.
- **iOS reconnect wakes coalesce instead of flap.** APNs, foreground, and path
  reconnect signals single-flight through one coordinator so the companion no
  longer races competing reconnects after push or resume.

### Security

- **Managed Kimi authentication and admission stay fail-closed where it
  matters.** Rotating Kimi OAuth credentials use a source-home-keyed durable
  authority across isolated ACP seats and crash recovery. The brittle per-build
  fingerprint gate is dropped for always-enabled structural admission in every
  build, packaged included: stable binary identity, bounded probes, a
  parseable version, and the ACP-only posture still gate the seat, runs
  without a reviewed roster tuple are explicitly labelled
  `unattested-development`, and the gateway/deny-wall containment applies
  regardless of admission mode. The embedded qualification roster remains
  intentionally empty, so release qualification stays red and sealed scheduled
  Kimi execution stays unavailable until their respective admission/authority
  evidence is commissioned. A successful `kimi login` or a Settings usage key
  does not qualify a managed run. *(Corrected 2026-07-21: this entry
  originally claimed packaged builds still reject Kimi; the admission that
  shipped in 1.8.5 is always-enabled in packaged builds too.)*
- **Manual unsigned builds cannot write GitHub Release assets.** Windows and
  Linux testing builds now upload only immutable SHA/run-labelled Actions
  artifacts under read-only repository permission. The credentialed provider
  canary also stays fail-closed until its protected environment has been
  explicitly commissioned, and signed publication requires a fresh successful
  exact-commit canary attestation plus commissioned immutable `v*` tag/release
  controls. Both signed publishers re-resolve the remote tag and reject
  auto-created or moved tags before uploading.
- **Deleting chat history now clears the adjoining TaskWraith audit state.** The
  Settings action removes chats, run/run-queue and execution-graph history,
  approval/feedback ledgers, sub-thread mailboxes, Canvas workspaces/artifacts,
  Kimi seat state, and the bridge subprocess log. Provider-native history and
  provider credentials remain separate and are not removed by that control.
- **`canvas_eval` receipts retain correlation metadata instead of executable
  content.** Human-approved execution and Canvas-audit receipts retain the
  joined approval id, unkeyed SHA-256 digest, lengths, and outcome rather than
  script/result content. Auto-denial and compatibility/tool rows are
  content-redacted but may omit that full receipt. The digest is integrity and
  correlation metadata, not encryption; provider-authored transcript prose,
  provider-native history, and opt-in debug capture remain outside the
  guarantee.

## 1.8.4 - 2026-07-16

### Fixed
- **Transcript scrolling stays under the reader's control from the first
  message.** New messages, thinking traces, and tool activity no longer pull a
  reader back to the live edge after they scroll away. The initial
  welcome-to-transcript transition now rebinds every scroll-intent listener to
  the replacement transcript, while **Jump to latest** keeps counting unseen
  activity until the reader deliberately returns.
- **Concurrent Ensemble seats no longer collide on one chat.** Multiple
  ordinary provider dispatches may hold independent reservations while fan-out
  lanes overlap, eliminating false “already has a live dispatch owner” seat
  failures. Scheduled runs remain mutually exclusive with every live ordinary
  dispatch, preserving the scheduler's exactly-once authority boundary.
- **The Sidebar update pill stays inside the fixed chrome band.** Download and
  update progress no longer exposes a mismatched-opacity gap above the
  masthead; the pill, title, workspace counters, tabs, and search now share one
  seamless top surface.

## 1.8.3 - 2026-07-16

### Added
- **Kimi K3.** Moonshot's new flagship model joins the Kimi provider with a
  256K context window and always-on Max-effort thinking, selectable alongside
  Kimi K2.7 Code in solo, Ensemble, queued, scheduled, and remote runs. K2.7
  Code remains the default and keeps its Standard/HighSpeed Fast toggle; K3
  has no speed tiers, and a stale Fast flag can never reroute a K3 run onto
  the K2.7 family.

### Fixed
- **Windows is a first-class platform again.** The 1.8.2 Windows and Linux
  artifacts were never published; this release is the first since 1.8.1 for
  those platforms and repairs four Windows-fatal defects that had landed with
  the recent hardening work: scheduled-workflow persistence no longer fails on
  directory-fsync (Windows rejects it), media persistence no longer rejects
  every asset (POSIX permission-bit gates and mixed stat-flavor identity
  checks are now platform-aware), and every hardened Git invocation no longer
  fatals on a relative `include.path` override.
- **Linux media staging is safe against inode reuse.** A completed staged
  snapshot's cleanup now also requires size and mtime to match before
  unlinking, so an ext4-reused inode number cannot cause a replacement file to
  be removed.
- **Concurrent identical media ingests always deduplicate.** The
  content-addressed store's adopt path no longer races the winning ingest's
  cleanup, so simultaneous ingests of the same bytes both succeed with the
  canonical asset.

## 1.8.2 - 2026-07-16

### Added
- **Kimi Code now runs through a contained ACP transport (the new default).**
  Kimi Code sessions run in an isolated provider home over ACP while TaskWraith
  holds workspace file authority through its brokered read/write/edit tools,
  with per-tool approvals matching the stdio providers and the TaskWraith
  gateway MCP served over HTTP. Setup copy is transport-aware, per-run thinking
  is honored through ACP configuration, and the usage meter reads the Kimi Code
  OAuth credential — refresh-token rotation persists back to the CLI home so
  later logins stay valid.
- **Workflow controls from the iPhone/iPad companion.** Scheduled workflows can
  be paused, resumed, or run immediately from iOS, with every write action
  authorized against the host's native consent and authority checks.
- **Kimi Code HighSpeed.** Kimi K2.7 Code now offers Standard and HighSpeed
  tiers through the familiar Fast control across solo, Ensemble, queued, and
  remote runs.
- **Provider plan labels in usage.** Usage surfaces now show the provider's
  detected account plan where that metadata is available.

### Changed
- **Scheduled workflow occurrences dispatch exactly once.** Occurrence
  lifecycles are transacted with single-owner claims, journaled transitions,
  and bounded deferred retries; launches fail closed when preflight, admission,
  lease, or provider authority cannot be established, and a stalled occurrence
  is isolated instead of blocking the queue.
- **Provider colours are balanced across light and dark surfaces.** Desktop and
  iOS now share contrast-balanced provider hues, including upstream-brand
  overrides for Ollama-hosted models. The Ollama model picker follows the
  selected model's upstream brand instead of always using Ollama green.
- **The sidebar usage card has a calmer glass treatment.** Quota values, rails,
  plan labels, and reference views now use one bounded surface with clearer
  contrast and less competing chrome.

### Fixed
- **Transcript navigation keeps the reader's place.** Chat switches, popouts,
  document-root scrolling, and virtual-window remounts restore the correct
  reading anchor; expanded Ensemble rounds remain expanded per chat. Explicit
  wheel, key, touch, or scrollbar input owns scroll-away, while layout clamps
  no longer break live follow, and the streaming **Jump to latest** control now
  updates immediately.
- **Fan-out activity stays coherent.** Interleaved lane activity remains in one
  first-anchored viewport, foreground ownership closes only after its lanes
  settle, and the continuation-hop notice is published after live work rather
  than racing it.
- **Directed Ensemble steers stay single-recipient.** A direct or remote Steer
  with one structured `@participant` target preserves that participant scope
  and forces inherited Read/All fan-out off instead of widening to the roster.
- **Multiview lifecycle state stays with its pane and chat.** Workspace and
  worktree selection, focus, trust, permissions, Ensemble controls, queued-run
  scope, attachments, external grants, Git/PR/CI snapshots, file evidence, and
  composer state no longer bleed between panes or enter selection-update loops.
  Completion and diff views accept only successful evidence owned by the exact
  run, including additional write-granted workspaces.
- **Concurrent chat saves preserve canonical state.** Per-chat persistence is
  serialized and revision-aware, rebasing only disjoint updates so a stale UI
  snapshot cannot overwrite newer workspace, provider-session, grant, run, or
  Ensemble state.
- **Sandboxed builds keep their capability handoff.** The packaged preload uses
  browser-safe Web Crypto and local structural comparison instead of importing
  unavailable Node modules, so clipboard capabilities and serialized chat
  persistence no longer prevent the app from booting under Electron's sandbox.
- **Provider controls survive edge cases.** Grok can recover from a denied tool
  without weakening Read-Only mode, Kimi speed tiers resolve through their CLI
  aliases, and Codex reasoning controls are pinned to the dispatched run and
  reset safely when its model changes.
- **Codex quota windows keep the right labels.** Session and weekly meters are
  classified from their reported duration, so a temporary backend response
  that places weekly usage in the primary slot no longer presents it as the
  five-hour window.
- **Queued rosters and onboarding notices finish cleanly.** A queued agent roster
  can finalize from its source run's durable terminal event, activity collapse
  keeps its debounce guard, and iOS retains app notices in First Launch instead
  of consuming them in the thread detail view.
- **Transcript media and attachments keep durable ownership.** Ownership grants
  batch atomically — including forked runs and audio/video outputs — corrupt
  ownership ledgers lock fail-safe, large assets are ingested from files rather
  than buffered in memory, and workspace inputs stage asynchronously.
- **Workspace execution targets stay pinned.** Direct target pins are adopted at
  startup and runs resolve their real execution targets, so a scheduled or
  queued run cannot drift to a different workspace than the one it was created
  for.
- **Queued and scheduled state stays consistent.** Queued chat updates survive
  hydration, only persisted due tasks dispatch and their due times must
  actually arrive, and scheduled Ensemble rounds reserve fresh round state
  instead of reusing a stale reservation.
- **iOS streaming reveal stays smooth and scoped.** The type-out reveal drains
  fully when a stream exits, tracks provider aliases, remains scoped to its
  run, and the composer diff pill no longer risks a first-frame layout
  livelock.

### Security
- **Run authority is reconstructed from canonical state.** Main revalidates the
  invoking chat, workspace, scheduled occurrence, popout owner, attachment and
  external-path capabilities, and IPC operation instead of trusting renderer
  payloads. Capability handoffs are scoped to the receiving window and stale
  or detached views cannot widen a run.
- **Built-in Git actions treat repository configuration as untrusted.**
  TaskWraith disables repository-selected hooks, filters, monitors, external
  diff/credential helpers, SSH/signing helpers, transport commands, and URL
  rewrites; external repositories must also keep their Git metadata inside the
  granted root.
- **Native provider file and shell tools stay brokered.** Claude, Kimi, Cursor,
  and Grok cannot bypass signed chat, run, workspace, and approval boundaries
  through bare native filesystem or shell tools; they use the namespaced
  TaskWraith workspace tools instead.
- **Remote favicon fetches are pinned and bounded.** Public-address validation
  is repeated across redirects and connections are pinned to validated DNS
  results, with strict timeout, redirect, byte, concurrency, and queue limits.
- **Kimi Code's contained transport is deny-walled.** The ACP session cannot
  reach network tools or the CLI's server-side filesystem/exec tools (including
  sub-agent inheritance); file access flows only through TaskWraith's
  workspace-scoped client tools, runs fail closed at a generation gate, and
  project-level configuration cannot execute code at session start.
- **Scheduled and unattended workflow authority is native-owned.** Occurrence
  mutations are authenticated against a persisted authority root, workflow
  consent is delegated to the main process rather than the renderer, unattended
  authority binds to native intent, elevation revocations persist, runnable
  template fields are whitelisted, and canvas IPC, Cursor MCP denial, Claude
  launch environments, Git snapshot subscriptions, and secondary renderer
  windows enforce the same signed, fail-closed boundaries.

## 1.8.1 - 2026-07-12

### Added
- **Background lanes for Ensemble work.** The new BG stage keeps a participant
  out of ordinary round rotation and starts it in a detached lane only when
  explicitly @mentioned or delegated. Normal BG launches are read-only, and BG
  seats cannot own Boss, Captain, or synthesizer authority.
- **Provider-backed live usage in the composer.** During solo and Ensemble
  runs, live provider snapshots now lead the input/output tally when available,
  with an animated output counter and projected cost that includes the in-flight
  prompt. A labelled text estimate remains when a provider cannot report usage.
- **Goal completion by quorum during an authority outage.** Eligible Ensemble
  participants can open one binding complete/keep-working poll when the Boss or
  Captain cannot close the active goal. A passing quorum closes it; a
  Boss/Captain keep-working vote vetoes it.
- **Agent-proposed Ensemble rosters.** An agent can prepare a roster preset for
  confirmation, letting you apply a validated provider, model, and role
  configuration without rebuilding the panel by hand.
- **Select roster presets during import or export.** Settings now lets you pick
  individual saved panels when moving rosters, while participant cards stay
  compact until you expand their detailed controls.
- **Post and clean up Blackboard notes from the composer.** The composer
  popover can now add a session note and delete entries without opening the
  right dock.
- **Shared motion and feedback pass.** Desktop and iOS refine panel presence,
  counter movement, and interaction feedback while respecting Reduce Motion.

### Changed
- **Review gates now follow the active goal.** Resolved or superseded gates no
  longer block a newer goal, and an eligible reviewer can record a passed or
  failed verdict for the gate it owns.
- **Explicit Ensemble hand-offs win.** A uniquely resolved explicit @mention now
  takes precedence over a yield return, so an intentional next speaker is not
  lost to ordinary round routing; ambiguous aliases still fail closed.
- **Continuous mode now respects clean pass boundaries.** When an all-yielded
  panel has no actionable assignment and cannot complete on its own, it returns
  control instead of spending another hop. A queued provider or model seat swap
  ends the current pass before a new one can run on the stale seat.

### Fixed
- **Ensemble lifecycle and routing are more dependable.** Transcript events keep
  their order, directed prompts and shortcut queues retain their intended scope,
  and terminal yields close cleanly instead of leaving misleading idle hops.
  Foreground seats now also hold their reader/writer fan-out lanes through
  settlement, so late lane reports stay with their source before the next serial
  speaker begins; background lanes remain detached.
- **Contextual Ensemble controls no longer duplicate themselves.** A read-fan-out
  pass shows its precise **Skip reads** action instead of an adjacent generic
  **Skip** button.
- **Activity timeline collapse avoids a React render loop.** Rapid transcript
  measurement and collapse transitions no longer repeatedly dispatch the same
  state update.
- **Goal-complete poll reporting is accurate and idempotent.** Proposal results
  retain the `ensemble_propose_goal_complete` identity, and re-resolving a poll
  cannot append a duplicate audit status line.
- **Solo Codex runs seal reliably.** Terminal status, finish time, and usage now
  persist when a run ends instead of occasionally remaining unknown or active.
- **Remote iPhone actions stay safe when a Mac sleeps.** Before sending an
  action, the companion checks that its paired host is alive, makes a bounded
  reconnect/wake attempt when needed, and leaves synced threads readable while
  the Mac is unavailable.
- **Provider integrations handle their edge cases more gracefully.** Kimi keeps
  MCP bridge settings isolated per run, reports weekly quota correctly, and lets
  a final quota/auth wire failure override a provisional success; Grok keeps its
  active MCP lifecycle; and unsupported Codex reasoning levels no longer trigger
  a failed launch.

### Security
- **Reviewer verdicts use a strict, narrow allowance.** Only the exact
  gate-specific passed/failed verdict payload can take the reviewer path; every
  other management action remains behind its existing authority checks.
- **Agent-created rosters stay permission-capped.** Imports require confirmation,
  validate live providers and a single Boss, and may use only Read-Only, Plan,
  or Default permissions without custom overrides.

### Documentation
- **Motion and transitions guide.** The how-to documentation now explains the
  shared motion tokens, presence rules, feedback, and Reduce Motion behaviour.
- **MCP catalogue catch-up.** Settings groups goal-complete proposals with the
  other Ensemble controls, while the generated Ollama reference reflects the
  current 156-tool surface and 39 common direct tools. Cursor's capability
  gateway now also includes the goal-complete proposal tool.

## 1.8.0 - 2026-07-11

### Added
- **Durable delegated workers with joined return results.** Parent agents can now
  choose the provider, model, and reasoning controls for a fresh sub-thread
  worker, then recall that same worker later without losing its provider session
  or changing its seat configuration. Returned outcomes land exactly once in a
  durable parent mailbox — including failed, cancelled, and action-required
  workers — and multiple delegations from one parent run share a join group so
  required workers gate the resume, optional workers do not, and closely spaced
  results wake the parent once as a coalesced batch. Follow-up prompts queue
  safely while a worker is busy, and invocation/result cards expose the live
  worker and mailbox state instead of leaving background work ambiguous.
- **Progressive capability gateway for agent tools.** Fresh provider sessions
  now receive a smaller, stable, session-pinned TaskWraith tool profile: common
  coding and orchestration tools stay directly available, while specialized
  capabilities can be discovered and invoked on demand. The resolved target
  still keeps its original schema validation, approval policy, safety locks,
  budgets, media handling, and audit identity, and resumed sessions keep the
  exact profile they saw when they were created.
- **Live working telemetry and stage glyphs for Ensemble seats.** An active
  participant's working indicator now shows elapsed time plus an animated token
  count sourced from provider snapshots (with a clearly estimated fallback),
  without forcing the whole transcript to re-render. Scout, Worker, and Reviewer
  roles also gain distinct stage icons across the participant strip and round
  surfaces, making a busy panel easier to scan.
- **30-day model comparisons in Settings.** Model Usage now includes a compact
  comparison table ranked by tracked tokens, with input/output totals and each
  model's share of the selected 30-day window.
- **Git branch drift states.** Workspace git status now distinguishes a branch
  that is merely behind its upstream from one that has truly diverged, with
  severity styling that makes the latter harder to miss.
- **Unified provider, model, and reasoning picker.** The composer, side chats,
  and the Ensemble roster now share one combined picker that chooses provider,
  model, and reasoning tier as a single atomic selection instead of juggling
  separate controls. Side chats render the exact same full composer as the main
  pane, so they inherit the same picker, attachments, and controls, and adding a
  new Ensemble participant via the "+" chip now opens an inline "configure and
  add" picker for its provider, model, reasoning, and role up front rather than
  always cloning a default. Popovers stay clamped inside the viewport, with
  label-truncation fixes on the Gemini and Cursor composer styles.
- **Reasoning-effort ladder slider.** The old hierarchical list of reasoning
  levels is replaced by a vertical gradient slider with up to seven stops from
  Off to Ultracode, snapping only to the levels a given model actually supports.
  The track, shimmer, and sparkle glow in the selected provider's own brand
  color and now ramp up smoothly stop-by-stop from Low through Ultra instead of
  igniting abruptly at the top, and a drag commits only on release — fixing
  slider lag and ensemble notification spam. On iOS the selector moves out of
  the model list into the same ladder, with a Fast toggle for capable models
  (Codex, Claude, Cursor, Grok) and a thinking toggle for Kimi; those choices
  round-trip fully to the Mac and persist on reopen.
- **GitHub PR and CI status above the composer.** A new icon-only row shows the
  PR's lifecycle glyph and a live CI status dot whenever the current workspace
  has a real GitHub remote, replacing the older inline text chips. Hovering
  opens a popover with fuller PR/CI detail including failing-check logs, and the
  row keeps polling CI in the background so the dot updates as checks finish. A
  "Notify thread" button can post the status into the Blackboard (ensemble) or
  the transcript (solo chats) as an explicitly external, unverified note.
- **GPT-5.6 (Sol, Terra, Luna) reaches general availability.** OpenAI's GPT-5.6
  trio graduates from preview to a first-class choice with official names,
  descriptions, and a confirmed ~1.05M-token context window — no more "requires
  preview access" blocks, permission downgrades, or forced read-only caps. Sol
  and Terra gain the Ultra reasoning tier (Codex's own top mode, including its
  proactive multi-agent delegation) alongside Max; Luna tops out at Max. The
  trio now leads the model picker above GPT-5.5, which stays the default, and
  the Fast toggle is available on desktop to match iOS.
- **Grok 4.5.** Adds Grok 4.5 to both the Grok and Cursor providers, wired into
  the composer, side-chat, and ensemble/roster model pickers on desktop and iOS.
  Grok's own CLI models always run in Fast mode, so that seat reads "Grok 4.5
  Fast" everywhere; Cursor's Grok 4.5 keeps its own separate Fast toggle.
- **New Additions card replaces the notification carousel.** The old carousel of
  pinned/changelog notifications is gone, replaced by a single structured card
  that groups every newly added model by provider — Claude Sonnet 5, the GPT-5.6
  trio, Cursor Grok 4.5, Grok 4.5 Fast, and the new local Ollama models
  including Poolside Laguna XS 2.1 (a 262K-context coding model with tool use
  and thinking, no cloud account required). Model names are bold in their
  provider's hue (Ollama-hosted models show their real upstream brand color),
  each provider heading carries its glyph, and on the desktop welcome screen the
  card floats at the bottom so it no longer pushes the composer upward.
- **Set a goal without leaving the keyboard.** Typing `/goal ...` in the
  composer and pressing Enter/Run now sets, updates, pauses, or clears the goal
  directly instead of opening the goal picker for a second step, so steering a
  chat toward an objective is as fast as sending a normal message.
- **"This round" vs. session changes in the Task-complete card.** The
  Task-complete file list now leads with a "This round" section showing only the
  files touched by the round that just finished — with its own +/- totals —
  followed by a divider and the deduped "Earlier in session" list, so you can
  see exactly what an agent just did without scrolling the whole session. Side
  chats, panes, and the run inspector keep the original flat list.
- **On-device AI close-out summaries.** Run and ensemble-round close-out cards
  no longer quote the agent's final message verbatim (a plain "ok, done" used to
  become the whole summary). They now show readable prose plus a clear pass/fail
  validation line, and on Macs with Apple Foundation Models available, that
  prose is generated on-device from a digest of the run — prompt, file changes,
  commits, tool counts, warnings — badged "via Foundation Models." A
  deterministic summary remains the fallback whenever the on-device model is
  unavailable.
- **Codex Multi-agent transcript card.** Codex's native Multi-agent mode — a
  root agent that spawns parallel subagents and synthesizes their results — now
  gets its own honest transcript card instead of rendering as generic tool
  activity, walking through Delegating, Working in parallel, Synthesizing, and
  Completed states with per-subagent chips and a progress meter. It's built on a
  shared orchestration-card chassis also used by the Workflow and code-review
  cards.
- **Home tab for the right dock.** The main pane's action pill is consolidated
  to five clear actions (effects, info, popout, run, and a new Home), and Home
  opens a calm directory of the dock's destinations — Live Lanes, Media, Pins,
  Files, a Side Chats shortcut that opens or creates the chat's linked side
  conversation, plus deeper inspector views like Diff, Delegation, Timeline,
  Background Tasks, Safety, and Capabilities — grouped for quick navigation
  instead of hunting through tabs. The Inspector's own redundant tab strip was
  removed now that Home handles that navigation.
- **Agents tab on the welcome dashboard.** A fifth dashboard tab surfaces your
  Agent Pool leaderboard: a spotlighted #1 agent with its
  runs/threads/tokens/tool-calls/work-time stats, plus a scrollable standings
  list with per-agent token-share meters. It's driven by the same ranking as
  Settings → Agent pool so the two can't disagree, and shows all-time stats so a
  quiet month doesn't blank the leaderboard.
- **Quick-access Blackboard popover in the composer (ensemble).** A new
  Blackboard icon sits alongside Plan/Copy/Multiview in the composer's icon row
  for ensemble chats, opening a read-only, category-grouped view of the
  ensemble's Blackboard entries without leaving the composer, with a quiet dot
  marking unread entries. Full posting and deleting still happen in the
  right-dock Notes pane.
- **Delete Blackboard entries.** Entries pinned to a chat's Blackboard/Notes
  panel can now be removed, not just added — a delete affordance was added to
  each entry card and wired through IPC alongside the existing creation path.
- **Smarter diff hover previews for file-change bubbles.** Task-complete
  file-change bubbles now wait roughly 0.9s before opening or closing on hover
  instead of popping open instantly and slamming shut, while keyboard focus and
  clicks still respond immediately. When a row has no captured git diff, the
  preview now synthesizes one from the run's own write-tool payloads
  (Edit/MultiEdit/Write/patches) and labels it "tool snapshot" instead of
  showing an empty "No inline diff captured" message.
- **Transcript softly fades under the floating composer.** While scrolling,
  transcript content now dissolves smoothly as it passes behind the floating
  composer and reappears just as smoothly on the way back up, instead of getting
  cut off abruptly. The gradient is roughly twice as wide as the first pass and
  eases out more gradually so the newest message stays legible longer, and it
  automatically tracks a growing composer (ensemble rows, wrapped input).
- **Copy just the highlighted selection.** The transcript message context menu
  now offers a "Copy selection" action alongside "Copy message" whenever you've
  highlighted text within a message, so you can grab a snippet without copying
  the whole message.
- **Collapsed-sidebar pill shows who and where.** When you collapse the sidebar,
  the pill naming the current chat now also shows the provider's glyph and, for
  workspace chats, the workspace name, so a background thread's agent and
  project are identifiable at a glance without reopening the sidebar.
- **Mid-round provider/model swaps now queue instead of blocking (ensemble).**
  Changing a participant's provider or model while they're mid-round used to
  require the round to stop or the participant to be idle. Those edits are now
  accepted immediately and queued to take effect at the start of the next round,
  so you can line up a swap without interrupting an active run.
- **Compacting state on ensemble participant indicators.** When a participant is
  compacting its context — whether automatic or a maintenance compaction — its
  working indicator now shows a distinct "compacting" state instead of the
  generic spinner, making it clear the pause is intentional housekeeping rather
  than the agent being stuck.
- **iOS Home gains search, pin/rename/archive, and transcript export.** The
  companion app's Home list now supports search across Active/Archived scopes, a
  pin/rename/archive context menu, an "add to prompt" append action, and
  host-backed transcript copy/export that reuses the desktop's markdown builder
  for a byte-identical copy. Roster ordering was also tightened with
  provider-label search matching and a deterministic tie-break so a shuffled
  roster always renders in the same order.
- **Schedule composer messages for later (iOS).** The iOS composer now has a
  schedule sheet — pick a date and time or use quick presets (15m, 1h, tonight,
  tomorrow) — so a message queues up and sends automatically at the chosen time
  instead of needing to be sent by hand.
- **Collapsible thinking/reasoning viewport on iOS.** The companion app can now
  show a bounded preview of an agent's thinking/reasoning trace with an 8-line
  collapsed fade and in-place expand, instead of needing the full thought text
  streamed on every update. The remote bridge caps how much reasoning text it
  sends per row so this stays bandwidth-friendly.
- **Dismiss individual notices on iOS.** The remote notice carousel on the
  new-chat welcome screen and first-launch sheet gained a per-notice close
  button. Dismissing a notice persists across launches and is shared between
  both surfaces, matching how the desktop app already handles per-notice
  dismissal.

### Changed
- **Composer shells no longer repaint the whole app.** A composer style now
  changes composer chrome only; the selected app theme consistently owns the
  transcript, sidebar, message bubbles, and surrounding surfaces. Light mode's
  reading surface is fully opaque pure white by default (the Main-pane opacity
  slider can still bring the glass back), while the Codex light shell now uses
  its native pure-white editor and joined status rows over a neutral utility
  bed. Split panes use restrained metallic seams, the real composer preview is
  shared by Settings and first launch, and the quick Themes menu adds live
  Sidebar and Main-pane opacity sliders without closing the menu.
- **Composer and sidebar redressed for Claude-shell and iOS parity.** The Claude
  composer skin's above-composer rows (Create PR, ensemble/roster/queued rows)
  were restyled to match the real Claude app's chrome, with squared chips, a
  shared card frame, and a split Create-PR button. The workspace sidebar got a
  companion pass to line up with the iOS app: pill-style section headers with
  count badges, flatter selection highlighting, trailing disclosure chevrons,
  and a contrast/ink cleanup across light and dark themes.
- **Sidebar chrome stays solid, and starts calmer.** The sidebar's top band
  (logo, workspace/thread tabs, search), the Model Usage panel, the
  footer/status area, and the strip behind the traffic-light buttons now render
  at a fixed near-opaque fill independent of the sidebar-transparency slider, so
  navigation chrome stays legible in glass and aurora themes while the
  thread/workspace list still honors your chosen opacity. On first load the
  model-usage card now begins collapsed, the section order was retuned (Pinned,
  Recents, Workspaces, Chats, and Shared above Local
  servers/Workflows/Ensembles/Workspace boards, with Local servers itself
  collapsed), the "N models" count badge was dropped from each Model Usage
  provider heading, and masthead/chrome opacity and spacing were tuned so the
  fill no longer double-composites into an almost-solid block.
- **Consistent control styling across the app.** A broad visual pass replaced
  ad-hoc buttons and toggles with one shared control system throughout: the
  composer's workspace pickers, Diff Studio's inline/split toggle, the run-rail
  and workspace-file action buttons, the Settings panels, the Inspector (Diff
  Studio toolbar, Raw Events filters), the file editor, and the
  bug-report/changelog/first-launch sheets now share the same look and behavior.
  Right dock panel surfaces were unified, the Cursor composer shell got a
  flatter dark surface with its git action relabeled to Commit, the Grok
  composer's workspace rows lost their pill backgrounds, and composer controls
  tighten up automatically in narrow or split panes.
- **Under-the-hood performance sweep.** A broad set of fixes cuts disk I/O and
  CPU overhead: settings are cached instead of re-read and re-parsed on roughly
  200 internal call sites; usage tracking stops re-fetching the same data three
  times per update and rotates records older than 200 days into an archive so
  the file no longer grows forever; the 90-day external-activity scan for
  Codex/Claude/Gemini/Kimi usage now re-parses only session files that actually
  changed instead of the whole multi-gigabyte history; and Codex usage lookups,
  local-server detection, the welcome dashboard's usage heatmap and token chart
  (now skipped and cached while off-screen), and tool-file summary rendering all
  skip redundant work when nothing relevant has changed. Nothing looks
  different, but heavy ensemble sessions, long streaming runs, and older
  accounts should feel noticeably lighter.
- **Smoother multiview and background transcript panes during streaming.** Side
  and background transcript panes (multiview split panes, auxiliary chats) no
  longer re-render on every token from an unrelated chat streaming elsewhere;
  they now update only in response to changes that actually affect what they're
  displaying, cutting stutter when several chats are active side by side. Each
  pane now also measures its own live composer clearance, keeps Home/popout and
  workspace chrome scoped to that pane, reuses cached transcript walks by chat
  identity, and renders the same welcome/composer surface as the main pane.
- **More efficient, lighter iOS companion.** While a run is streaming, the app
  filters and coalesces what it pushes to your phone: only the thread you're
  actively watching gets full updates, redundant git and full-projection
  snapshots are replaced with smaller deltas, agent-exit updates ship as
  targeted diffs, projection snapshots are prepared off the main thread, very
  large synced threads hydrate in batches, and the home list and duplicate
  refresh projections were collapsed to do less work. Actions you take yourself
  — sending a message, approving a request, nudging an ensemble — still refresh
  instantly; only passive background chatter is throttled. Expect snappier
  scrolling and lower battery/network use, especially with big threads or
  multiple devices connected.
- **Provider and model switch atomically.** Switching a participant's provider
  used to leave a brief window where the model, reasoning effort, and fast-mode
  toggle could reflect the old provider's defaults. The composer and ensemble
  participant pickers now change provider and model as one atomic action, and
  every provider's model catalog is pre-fetched at startup instead of only the
  active one, so switching feels instant.
- **Redesigned ensemble participant chips.** Chips now lead with each provider's
  glyph, moved the inline token-usage badge into a 500ms hover tooltip that
  consolidates three previously stacked tooltips into one card, and made the
  role name glow — breathing in the provider's hue while a participant is
  speaking or running, steady red when it fails or goes unreachable. The old
  per-provider corner dots were dropped since the glyph already identifies the
  provider, and chip/role-name widths were eased so longer names survive before
  truncating.
- **Redesigned ensemble participant authority controls.** The participant
  popover's Boss/Captain assignment and Scout/Work/Review stage picker are now
  single-click segmented controls instead of separate dropdown menus.
  Auto-approval consent is now scoped to the thread rather than to whichever
  participant currently holds Boss or Captain, so reassigning either role
  mid-ensemble no longer silently resets your approval settings.
- **Close-out round summaries reorganized into tables.** The commit list,
  participant breakdown, and token totals shown after an ensemble round now
  render as clean markdown tables instead of dense semicolon- and comma-packed
  lines, with an overflow note past eight commits. Participants are attributed
  by their actual @-mention rather than provider name, tagged with a turn count
  and — for non-contributors, including seats that took zero turns and
  previously vanished — a status like yielded/skipped/failed.
  Deterministic-fallback close-outs also drop the "· deterministic" badge that
  read as noise, so the header just says "TaskWraith" while provider-generated
  close-outs still note their source.
- **Blackboard entries look consistent everywhere.** The composer's quick-glance
  Blackboard popover and the Notes-pane Blackboard now render through the same
  unified entry-card component: raw internal author strings become provider-hued
  role-name chips (with Bossman/Captain marks), plus category accent stripes,
  scope badges, and timestamps.
- **Consistent pill styling and taller cards for fan-out results.** The
  Provider/Role/Model/Participant chips in ensemble fan-out results and the
  Cancel/Set buttons in the Max Handoff Turns popup now use the same
  segmented-control pill treatment as other composer controls, and collapsed
  fan-out lane results grew about 38% taller with a more gradual fade at the top
  and bottom edges, making longer agent outputs easier to read without expanding
  the card.
- **Reasoning-tier visual polish.** The composer's model-trigger chip now shades
  its reasoning-effort suffix progressively — a bare whisper of provider color
  at Low up through a full hued sweep at High — and the provider-hued
  shimmer-and-sparkle treatment, once reserved for the very top Ultra/Ultracode
  stop, now also ignites at Max (a notch subtler so Ultra still reads as the
  peak). Models whose reasoning level isn't configurable (like Cursor Composer
  2.5's implicit Medium) now keep the slider in place showing a fixed reading
  with an explanatory tooltip instead of hiding it and shifting the layout, and
  a couple of styling bugs were fixed along the way (Cursor's trailing " Fast"
  suffix breaking the color, and the Fast lightning-bolt icon now appearing on
  every provider's chip).
- **Codex glyph and accent refreshed; provider glyphs gain a contrast outline.**
  Codex's mnemonic glyph switches from a prompt-box-and-cursor icon to a filled
  command-cloud shape with a terminal cutout, and its accent moves from indigo
  to a brighter purple, propagating through the composer, sidebar, settings, and
  the iOS app. Every provider's glyph (Claude, Codex, Grok, Kimi, Gemini,
  Cursor, Ollama, Ensemble) now sits on a black contrast outline so it stays
  legible on any theme or background.
- **Kimi's color changed from olive-green to blue.** Kimi's provider color
  across chips, glows, the roster icon, and transcript accents now uses a blue
  palette anchored on #1A8CFF on both desktop and iOS.
- **Composer telemetry row reorganized; timecode moves to its own bar.** The
  cramped composer telemetry row is decluttered by moving the run/thread
  timecode into its own bar glued under the composer — current turn's elapsed
  time on the left, total thread time on the right — leaving the freed row to
  split cleanly into workspace switcher, icon cluster, and token tally. The
  run-duration popover was also resized and repositioned to match other composer
  popovers instead of using its own fixed-width box.
- **Composer toolbar simplified.** The dedicated Queue and Steer buttons on the
  run cluster are gone, leaving just Run and Stop; queuing a follow-up or
  steering the active turn now happens through the queued message's own Steer
  menu (Steer now / Add to Blackboard), so the toolbar is less cluttered while
  streaming. The Add participant and Goal buttons also picked up the shared
  composer pill styling (with Add participant shortened to "Add"), and the
  Model/Reasoning chip dropped its middle-dot divider for a wider gap between
  the two labels.
- **iOS model picker redesigned as a glass popover.** The native menu for
  choosing model/reasoning is replaced by an anchored Liquid Glass popover that
  stays open after you pick a model so you can adjust reasoning without
  reopening it, dismissing on reasoning selection, tap-away, or a swipe-down
  gesture, and blurring the real app content behind it. When the composer
  collapses to give the transcript room, the model/reasoning picker now surfaces
  as a small pill in the input's top-left corner instead of disappearing, and
  the redundant "Default" model row was removed from the pickers.
- **iOS transcript rendering scoped to the open thread.** Viewing a thread no
  longer re-renders on every unrelated background update — another thread
  streaming, a git pull, a usage refresh. A per-thread invalidation gate means
  the transcript only redraws when something relevant to the open thread
  changes, improving scroll and streaming smoothness.
- **Streaming text reveal adapts to arrival speed.** The transcript's type-out
  reveal now measures each assistant stream's actual arrival cadence — chunk
  size, gaps, jitter — and adjusts its pacing and visual treatment accordingly,
  so a fast model doesn't look artificially slow and a bursty one doesn't look
  jerky. A companion fix stops plain sentences that merely contain a "|"
  character from being mistaken for an unfinished markdown table and getting
  stuck mid-reveal.
- **Compact composer pill launches builds directly.** The composer corner pill's
  Run button no longer just toggles a rail panel — it launches your project's
  detected build or preview target directly, opens a picker when there's more
  than one target, and surfaces launch errors inline. The pill and Home cards
  also picked up accessibility polish: reduced-motion and reduced-transparency
  compliance, forced-colors-mode outlines, and a light-theme hairline that no
  longer relies on a hardcoded white value.
- **Workspace switching is now the default click.** In the composer's workspace
  popover, clicking a known workspace's name now switches your primary workspace
  to it directly — previously that row was just a label and switching required a
  small leading icon button. Attaching the folder as an additional (secondary)
  workspace moves to its own explicit "+" button.
- **Paired-device workspace access moved out of the Devices tab.** The
  "Paired-device workspace access" card no longer appears on Settings → Devices;
  per-workspace access for paired iPhones/iPads is now configured directly from
  Settings → Workspaces via each workspace's own remote-access toggle, removing
  the duplicate control.
- **A touch more breathing room around the transcript.** The reserved scroll
  clearance beneath the transcript was trimmed from 110px to 10px so recent
  messages sit closer to the composer, while the clearance kept above the
  composer during auto-scroll widened slightly so the last line of a message no
  longer sits flush against the composer's top edge.
- **Per-participant compaction control in the context meter.** The context-meter
  popover's flaky "Compact" text pill is replaced by an always-present monoline
  icon on each participant row that shifts hue by usage risk — the provider's
  own tint when healthy, orange past 60%, red past 85% — so you can trigger a
  context compaction and read each seat's pressure at a glance.

### Fixed
- **Weather-off light themes no longer show a stray sky band.** The transcript's
  blue top reveal is now keyed to an actually mounted Weather/Sky layer in each
  pane, rather than the broader visual-effects switch, so disabling weather
  restores a clean reading surface even when other effects remain enabled.
- **Long-running Kimi and Grok seats compact context safely.** Host-managed
  compaction now converges through bounded, checkpointed summary chunks instead
  of assuming one summary covered an arbitrarily large history. It compacts from
  exact prompt gaps, preserves every accepted checkpoint, fails open if a later
  chunk cannot complete, recovers seats that already crossed the provider limit,
  and keeps Grok's live process until the summary provably covers the transcript
  prefix being retired.
- **Token and cost totals count cached input exactly once.** Provider usage is
  normalized through one cache-aware accounting path, fixing inflated or
  missing totals in Codex history, Cursor external activity, Gemini/Kimi cache
  breakdowns, Agent Pool stats, close-out cards, remote projections, and the
  welcome/usage dashboards. Ensemble records now also include the prompt each
  participant actually received, so fan-out and repeated shared context no
  longer disappear from the input tally.
- **Ensemble rounds wait for detached fan-out lanes.** A serial queue draining
  no longer marks the round complete while asynchronously dispatched fan-out
  participants are still working. Late lane output lands inside the live round,
  the final lane closes it once, and an explicit Stop still cancels immediately.
- **Right-dock restoration stays quiet and session-scoped.** Remembering the
  last dock destination no longer opens the dock as a side effect, and that
  surface memory no longer leaks across app sessions.
- **Zero-setup cellular iOS pairing over Tailscale.** Pairing now advertises the
  Mac's direct `100.64.0.0/10` Tailscale relay door alongside LAN, so devices on
  the same tailnet no longer need Tailscale Serve or a WSS override to pair and
  run over cellular; Serve stays available as optional TLS defense-in-depth.
  Finder/login-item launches also force Tailscale's documented CLI mode for
  status, Serve, and auth-key commands, avoiding a stray `Tailscale.CLIError`,
  and relay changes/tests refresh the visible pairing session immediately.
- **Claude composer shell: visible Stop button on light themes.** While a run
  was active, the Claude shell's Stop glyph kept its dark-native white ink on
  the Light, Mist, and Sage themes — an invisible white square in the send slot.
  It now uses the same dark-neutral ink as the shell's other light-mode
  controls, with a dimmed disabled state and a soft hover fill.
- **The phone's git pill no longer lags the Mac.** Paired phones now ride the
  same git watcher lane as the desktop pill: while at least one phone is
  connected, the Mac lands every filesystem/run-driven git recompute (terminal
  commits, edits from other sessions or editors, branch switches) in the remote
  snapshot cache and pushes it immediately. Previously the phone refreshed only
  on its own pulls — opening a thread, foregrounding the app, a run finishing —
  so git changes with no run attached never arrived until some unrelated event
  fired. Connecting a phone also lands a fresh snapshot per workspace up front,
  and zero connected phones means zero extra watchers on an idle Mac.
- **iOS sheets render their liquid glass.** The Diff Studio, roster (and its
  nested participant editor), approval, and rename sheets all requested the
  shared liquid-glass backdrop, but their own content painted a full opaque
  canvas and default list/form fills on top, so the glass never showed through.
  Sheet-hosted content now clears its canvas and uses translucent surface washes
  (with a darker wash kept for the diff hunk grid's monospace contrast), while
  full-screen hosts (iPad split view, phone cover) and Reduce Transparency still
  get solid fills; a same-day follow-up lightened the wash further for
  readability.
- **iOS companion streaming stalls smoothed out.** A multi-part pass eliminated
  stalls and lag during active runs: full-state pushes coalesce and send only
  what changed, live thread/diff updates are capped and throttled while
  streaming, projection decoding moved off the main thread, and markdown
  rendering picked up an LRU cache. Several remaining causes of transcript
  scroll stutter during a live ensemble round — touch tracking, growing
  tool-call bursts, and media previews all forcing full-view re-renders — were
  also fixed. Net effect is a noticeably more responsive phone app while an
  agent works, with no loss of live detail.
- **iOS companion recovers stale content after reconnecting.** Coming back from
  the background or a push notification usually found the socket still
  "connected," so the app took a fast "still alive" path and served
  pre-background cached content instead of refreshing — the main cause of the
  reconnect-blank/stale-content bug. The phone can now pull a fresh copy of the
  home list and the visible thread on foreground or notification wake without
  disturbing an in-progress live turn, no longer flashes a false "no threads"
  empty state during the initial grace window (distinguishing still-checking
  from confirmed-empty, with a Check Now retry), and the Mac can now tell a
  silently-dropped phone from a merely-backgrounded one so it stops serving
  updates to a gone device and doesn't needlessly keep itself awake.
- **Transcript chronology: no more duplicated or misordered messages.** Several
  related bugs could make a tool result, an assistant reply, or a queued-run
  card render in the wrong place or twice: a tool result arriving after other
  messages could duplicate into a new stack while the original spun "running"
  forever (Codex was hit hardest); a full-turn restatement landing after a
  system card could re-append the entire answer below the card instead of just
  its new tail; and a queued card popping in between two tool bursts could make
  them visibly regroup once it resolved. All are fixed so results settle in
  their true chronological position.
- **Long-thinking traces no longer jerk the transcript.** Streaming a long
  chain-of-thought could make the transcript jump and flash: a tool row's
  estimated height scaled with the raw uncapped thinking text instead of its
  bounded collapsed viewport, and a still-growing thinking row behind a later
  system event kept missing its cached measurement, snapping between measured
  and wildly-estimated heights on every update. Both are fixed, the live
  viewport no longer remounts and flashes when the streaming window's tail
  slides past its cap, a giant thinking trace renders only its visible tail
  while streaming, and the Raw log panel caps how much of an oversized payload
  it retains per line — cutting the memory and CPU cost of long thinking streams
  without losing the meaningful head/tail.
- **Transcript auto-follow stays disengaged.** A couple of edge cases could
  silently re-engage follow after you'd scrolled up to read history during a
  live stream — a coalesced content reflow, or dragging the scrollbar itself.
  Both are now recognized correctly, so the viewport only snaps back to the live
  edge on a genuine downward scroll. The same fix shipped to iOS, where an
  automatic follow-to-bottom pass could jump the scroll position out from under
  an active drag.
- **Light-theme legibility fixes.** Several controls that referenced
  non-theme-aware or missing CSS tokens rendered dark-on-dark under the Light,
  Mist, and Sage themes and are now scoped correctly: the "jump to latest" pill
  in live activity views, the Settings roster/pool picker popover, the
  Codex/Claude approval and discovery card (text, countdown, note field, and
  buttons), and a stray navy fallback behind the side-chat composer under the
  Codex style. On iOS, roster and other glass-sheet rows that were nearly
  indistinguishable from their backdrop in Light, Alabaster, and Mist now use a
  darker row wash so cards are clearly separated again.
- **Transcript side rails no longer misposition or bleed through modals.** The
  go-to-message gutter and the participant-filter rail could render
  mispositioned on first load, correcting only after an incidental scroll; both
  now re-measure against composer/roster growth and font loading so they land
  correctly from the first paint. Because they float above the whole app,
  they're now also hidden automatically behind every full-screen dialog
  (first-launch, bug-report, changelog, sub-thread creator, work-session setup,
  Discord picker, creative approval, media preview) instead of showing through.
- **Ensemble fan-out no longer reorders or yanks the transcript.** Re-flushing a
  participant's streaming output used to strip its messages and re-append them
  at the end, shuffling the reading order; reflushes now reinsert at the
  timeline's original position. A fan-out lane that completed while the Boss or
  next serial participant was still mid-turn could leapfrog above the live
  speaker — lane placement is now anchored below the live turn. And a collapsed
  lane card's badly overestimated on-screen height was inflating the scroll
  range and snapping auto-follow into empty space below the content (a linked
  side chat had the same gap); both are fixed so the transcript stays put while
  agents work in their collapsed windows.
- **Ensemble fan-out tool no longer times out on longer runs.** The fan-out tool
  used to wait for every dispatched lane to fully finish before returning
  control to the calling agent, which could exceed the provider's MCP call
  timeout. It now returns a dispatch receipt as soon as lanes are launched,
  while results still stream into the transcript as each lane completes.
- **Fan-out result cards show their own participant's color.** Cards previously
  inherited the whole pane's accent instead of their own participant's, and
  model-spoofed providers (e.g. a different model run through Ollama) showed the
  wrong brand color; each card now themes itself after its actual participant.
- **Ensemble close-out summaries capture accurate per-participant info.**
  Close-out messages now record each participant's model, reasoning effort, and
  permission preset as a snapshot taken at the start of their turn, so editing
  the roster mid-round no longer rewrites earlier history. A participant removed
  from the roster mid-round previously vanished from the audit trail entirely;
  it's now retained with a "removed from the active roster" status so the
  close-out and round history stay complete.
- **Ensemble goals stay steered by TaskWraith, not Codex.** On Codex-backed
  ensemble threads, Codex's own native goal-tracking could run alongside
  TaskWraith's ensemble goal scheduler, risking two schedulers acting on the
  same thread. TaskWraith's ensemble goal now always takes ownership and clears
  the provider-native copy.
- **Working indicator no longer vanishes partway through a solo run.** In
  non-ensemble chats the "working" ghost cleared as soon as the first assistant
  text streamed in, but nothing turned it back on when the agent moved into tool
  use, so a run doing tool work after its first reply showed no indicator until
  it finished. It now re-arms on tool activity so the indicator stays accurate
  for the whole run.
- **Activity group collapse flicker.** Tool-call activity groups could rapidly
  expand and collapse as new tool calls arrived, producing a visible flicker.
  Collapses are now briefly debounced so a group holds still through the churn.
- **Kimi live tool-row measurement.** Fixed incorrect height measurement of
  live-streaming tool-call rows for Kimi, which could cause the transcript to
  jump or clip while a tool call was still in progress.
- **Agent questions recognized under any tool-name alias.** Some providers call
  the ask-a-question tool by slightly different names (case, spacing, or dashes)
  that weren't always normalized to TaskWraith's internal `ask_user_question`,
  so a model's question could be rejected or dropped instead of prompting you.
  Tool-name normalization now happens consistently across the MCP bridge, Codex
  routing, and Ollama's native and text-based tool calls.
- **Composer file drag-and-drop is back.** Dropping files onto the composer had
  silently stopped attaching anything after an Electron update removed the old
  file-path API; drag-and-drop attachments and the drop-zone highlight both work
  again.
- **Thread Introspection no longer freezes the app.** Opening Settings →
  Automation → Thread Introspection triggered an infinite mount-refresh-remount
  loop that pegged the renderer and hung the window. The refresh wiring was
  untangled so a panel's initial load can no longer re-trigger its own remount.
- **Completed or cancelled runs can no longer resurrect.** A late-arriving
  callback from a fallback transport attempt, a delayed process attach, or a
  stale abort controller could reactivate a run that had already reached a
  terminal state, making it appear to start running again. Terminal runs are now
  final: late callbacks are cleaned up without reviving the run or overwriting
  its state.
- **Multiview panes no longer leak each other's workspace state.** In split-pane
  Multiview, one pane's external workspace context — granted external folders,
  git status snapshots, and PR summaries — could bleed into another pane. Each
  pane's workspace state is now derived and isolated per pane.
- **Markdown tables render consistently regardless of provider.** Tables used to
  pick up the emitting model's provider accent, so the same table rendered
  differently depending on who wrote it; they now always render in a neutral
  silver. Dense tables with many columns — like the ensemble close-out's
  eight-column breakdown — also no longer squeeze and wrap their headers into
  illegible fragments, keeping labels on a single line at a fixed width with the
  existing horizontal scroller handling overflow.
- **Wide system messages no longer overflow the transcript.** A system message
  containing a wide element (such as a large markdown table) could push past the
  transcript column's edge instead of staying contained within it.
- **Codex reasoning traces render cleanly.** Codex's streamed reasoning
  summaries could show stray internal markers, and the trace rendered in the
  transcript wasn't fully sanitized; both are cleaned up so Codex thinking reads
  as prose.
- **@-mention links render as chips again.** TaskWraith's internal `agent://`
  and `ensemble-dm://` mention-link schemes were being silently blanked by
  react-markdown's default URL sanitizer, so @-mentions in the transcript
  rendered as plain unstyled anchors instead of provider-tinted chips. Those
  schemes are now allowed through, restoring the styled mention chips.
- **Cursor + Grok 4.5 reliability.** Cursor's Grok 4.5 route was rejecting
  TaskWraith's full MCP tool catalogue outright (it caps out around 80 tools); a
  curated, capped tool profile now keeps core coding/orchestration tools
  available for tool-constrained models. Separately, the assistant's text after
  a tool call could go missing entirely on Grok 4.5 routes when its post-tool
  snapshot didn't line up with the pre-tool text — that text is now preserved
  instead of silently dropped.
- **Grok recon runs no longer hard-cancel on read-only shell commands.** A
  read-only or recon Grok turn denied every shell tool call outright, and Grok
  treats a denied tool as a fatal cancellation, so asking it to "investigate
  this repo" failed the instant it tried a plain `ls` or `git log`. The
  permission gate now recognizes provably read-only shell commands and allows
  them under read-only posture while continuing to block anything that could
  write or execute arbitrary code.
- **Codex code mode works with standalone CLI installs.** Codex's "code mode"
  tool relies on a companion helper binary that ships next to the ChatGPT/Codex
  apps but not always next to a standalone `codex` CLI install. TaskWraith now
  also checks the known app-bundle locations (or an explicit path override) so
  code mode resolves either way.
- **Claude Fast Mode no longer offered on Fable 5.** Fable 5 doesn't support
  Anthropic's paid Fast mode, but the model picker still showed a Fast tier for
  it. Fast mode is now correctly scoped to only the Opus models that support it.
- **Roster Presets popover no longer runs off-screen.** A long list of saved
  presets could grow the popover tall enough to push its Save/Save As buttons
  above the top of the window. The preset list now has a capped height with its
  own scrollbar.
- **Workspace boards scroll vertically again.** Board columns taller than the
  visible area were clipped with no way to reach the cards below the fold
  because only horizontal overflow was enabled; both directions now scroll.
- **No more "0 files changed" clutter.** The composer's workspace status row no
  longer shows a changes pill when the working tree is clean — it only appears
  once there's something to review.
- **External workspace rows show their real names.** When a Full Access agent
  touches a folder outside your current workspace, the composer's
  secondary-workspace row now resolves it to that folder's saved workspace name
  when it's registered in TaskWraith, instead of the raw folder name.
- **Welcome-screen composer centers correctly.** The welcome composer column
  (General, Workspace, Workflow, Shared, and their Ensemble variants) was
  rendering off-center rather than at the shared width used elsewhere, because
  its layout grid lacked an explicit column track; it now centers to match the
  started-transcript composer, and the gap to the 90-day activity heatmap below
  was tightened so the taller Workflow composer has room before the two collide.
- **iOS Fast/thinking toggle no longer resets unexpectedly.** Approving a
  proposed plan, or sending a composer prompt while a run was already active,
  could silently force Fast off and reset Kimi's thinking mode regardless of the
  thread's actual settings. Both paths now carry your Fast and reasoning
  selections through correctly, including threads that don't yet have a cached
  model card.
- **iOS reasoning labels, tool icons, and multi-step reasoning match Electron.**
  The collapsed reasoning chip routed every provider through generic ladder
  vocabulary ("Light", "Extra") and showed nothing for Kimi; labels now branch
  per provider the same way Electron does (Codex "Light"/"Extra High", Claude
  "Low"/"Extra", Kimi "Thinking" when on), which also corrects the model picker
  and Roster rows. The transcript tool-call glyph resolver, which had drifted so
  GitHub PR/CI/merge, background processes, launch/IDE-open, fan-out, canvas,
  web-fetch, and several brokered MCP calls fell through to a generic wrench,
  now mirrors Electron's tool-family mapping. And a multi-step turn that
  reasoned between several tool calls kept only the final reasoning segment on
  iOS — every segment is now concatenated in order.
- **iOS close-out row now appears before its Task-complete card.** An ensemble
  round's close-out summary could render after the round's
  Task-complete/run-summary card because it wasn't tagged with the round it
  belonged to; it's now correctly ordered ahead of the card, matching desktop.

### Security
- **Async delegated workers cannot inherit Trusted Session.** Worker runs carry
  a capped, signed snapshot of the invoking run's permission posture and
  external-path grants, with their run identity bound before dispatch. A
  background worker therefore cannot silently inherit host-level authority from
  its parent, while lower in-scope permissions remain explicit and auditable.
- **Closed a cross-instance MCP write path.** A mutating MCP tool call could
  execute against the wrong TaskWraith instance — for example, a dev build's
  write landing in the release app — via stale registrations or an unrouted
  fallback. Mutating calls now require an explicit run/chat route whose caller
  workspace matches the resolved run's workspace, and stale TaskWraith MCP
  registrations left behind by Grok are swept up automatically.
- **Ensemble participant permission raises go through the same confirmation
  gate.** Raising an ensemble participant's permission preset (for example
  Read-Only/Recon to Workspace Write) from the composer picker used to apply
  silently, while the identical raise in a solo chat warned first. Participant
  raises now route through the same two-tier elevation flow — a confirmation
  sheet with an acknowledgement gate — so every permission increase in an
  ensemble thread gets checked. Lowering a preset still applies immediately, and
  Trusted Session keeps its own dedicated confirmation sheet.
- **Prompt-injection defense for on-device AI summaries.** The on-device AI
  features that summarize run telemetry (close-out summaries and run analysis)
  now run their output through a deterministic echo guard: if the model's
  response verbatim-echoes text drawn from agent/tool output rather than
  composing its own summary, TaskWraith treats it as a hijacked response and
  withholds it, falling back to the deterministic summary. This closes off a
  class of attack where text embedded in commit messages or tool output tries to
  get the local model to parrot it back as "analysis."

### Accessibility
- **Finer app-size control on iOS.** The app display-scale setting now offers
  five steps in each direction (60% to 150%) instead of just one, letting you
  dial in text and UI size more precisely. Existing saved choices are
  unaffected.

### Removed
- **Redundant internal transcript notices.** Legacy queued-run request cards,
  per-run crash-recovery notes, steer-handoff notes, and retired Gemini
  capacity/command-bridge notices no longer interrupt the conversation. Their
  meaningful state remains available through the queue, activity, recovery, and
  provider-status surfaces that actually own it.
- **Duplicate workspace pickers removed from the welcome screens.** The "Work in
  folder" row of recent-workspace chips on the solo, ensemble, and workflow
  welcome screens duplicated the workspace switcher already in the composer's
  bottom bar and has been removed from all three. The ensemble welcome screen
  also drops the ordered provider chip chain below its copy, which duplicated
  the speaking-order information already shown in the composer's chip strip;
  participant editing still happens from that chip strip.
- **iOS composer orchestration-mode chip removed.** The orchestration-mode chip
  in the iOS composer was pulled out along with its supporting view code,
  simplifying the composer bar.

### Documentation
- **First-launch guidance matches the 1.8 permission and orchestration model.**
  Onboarding now distinguishes General chats from workspace-scoped coding,
  names Workspace Write and lane-scoped Trusted Session accurately, documents
  `/goal`, current Fast-capable model families, and inspectable delegated-worker
  returns, and describes provider context isolation rather than implying a
  shared provider session. The iOS guide now points workspace access to the
  current Settings → Workspaces control and covers its 1.8 thread-management,
  scheduling, export, and Ensemble seat controls.
- **How-to manual gains verified screenshots and corrected permission docs.**
  The in-app how-to manual now embeds 59 of its 83 planned screenshots, each
  visually checked against the feature it documents, with the remaining
  dynamic/onboarding-only shots tracked for later. The permission-preset pages
  were corrected to match the live app: the composer picker's only elevation
  confirmation is the Trusted Session sheet, and the current preset list is Plan
  / Read-Only-Recon / Default Approval / Workspace Write / Trusted Session.

## 1.7.9 - 2026-07-07

### Added
- **iOS performance pass.** The companion app caches MarkdownLite blocks by text
  and participant signature, resplits streaming Markdown only when a paragraph
  boundary crosses chunk edges, gates the composer rim-chase idle animation behind
  shell visibility / active run / Reduce Motion, replaces the 90-second git-status
  poll in the diff pill with event-driven refreshes, shares a single approval
  countdown ticker across attention rows, and memoizes adjacent tool-row grouping.
  Long ensemble threads should scroll and stream more smoothly while using less
  battery.
- **Liquid-glass sheets and subtler titles on iOS.** Sheets now use a new
  `twSheetLiquidGlass` chrome with three tiers: opaque under Reduce Transparency,
  native `glassEffect(.regular)` on iOS 26+, and an ultra-thin material fallback
  with the same dual-stroke rim as the desktop composer. `TWPrincipalTitle`
  replaces heavier inline navigation titles in Diff Studio, Files, the roster
  sheet, and thread covers.
- **iOS transcript parity refinements.** Settled rows show a typographic model
  chip parsed from the same single-source speaker split as the label, so they
  never disagree; ensemble yield/skip system rows render seat names from the host
  projection; footer timestamps use a static cached formatter; leading marks drop
  to 14 pt; and a 760 pt centered reading column improves iPad readability.
- **iOS Settings cleanup.** Mobile Settings shrinks from 14 tabs to 9: empty or
  duplicated read-only tabs are removed, Safety & Privacy and About merge into
  one honest "About & Privacy" tab, and the default landing tab is Appearance.
- **Deterministic ensemble participant seeding.** Adding a participant to an
  ensemble now seeds provider, model, and reasoning defaults from stable
  per-provider snapshots instead of volatile live catalogs, so rebuilt rosters
  match.
- **Queued-message Steer menu and blackboard nudge (ensemble).** The queued
  message Steer button on desktop is now a small menu: **Steer now** dispatches
  immediately, while **Add to Blackboard** consumes the message into a shared
  note without interrupting the round. Each seat's briefing also nudges it to
  re-check unread blackboard entries before wrapping up.
- **Ensemble Boss goal management.** The Boss/Captain orchestrator can now set,
  update, clear, and query the active thread goal inside ensemble rounds.

### Fixed
- **Ensemble participant ordering on iOS and Mac.** Round `participants` arrived
  in speaking-queue array order while the configured roster used slot order; both
  the host projection and iOS `displayParticipants` now sort by `(order,
  participantId)` so transcript, mention, and chip-strip surfaces stay aligned
  after mid-round roster edits.
- **iPad transcript scrolling restored.** A layout regression from the iOS parity
  work broke scroll-to-bottom and upward scrolling on iPad; the detail view now
  keeps correct content bounds and the follow-pin stays deferred to the next
  runloop.
- **Residual fan-out duplicate windows.** Review-wave and target-resolution paths
  could open duplicate fan-out windows; the orchestrator now closes them
  deterministically.
- **Composer git snapshot cache.** The Mac bridge routes composer git snapshot
  refreshes through the shared cache, cutting redundant git-status work.
- **Transcript scroll-up yank.** Streaming follow no longer snaps the viewport
  back to the live edge while you are scrolled up to read history.
- **Tool/thinking viewport persistence and chronology.** Live tool/thinking
  viewport expansion persists across remounts, and CLI thinking traces are
  segmented chronologically.
- **iOS projection aliases and hydration.** Oversized remote projection frames
  are trimmed before they hit the relay payload budget, and aliases are preserved
  so rows, ensemble metadata, and composer context stay attached to the selected
  chat.

## 1.7.8 - 2026-07-06

### Added
- **Queued messages → Blackboard.** The queued-message Steer button on desktop
  is now a small menu: **Steer now** (unchanged — interrupts the round and
  dispatches immediately) or **Add to Blackboard** (consumes the queued
  message into a user-authored blackboard note the panel sees next turn,
  without interrupting the round). Ensemble chats only; solo queue rows keep
  the plain Steer button.
- **iOS queued-message bubbles.** Queued messages moved out of the cramped
  composer above-row into dashed "Queued #n" bubbles at the transcript tail
  (Claude-app style), each with a 3-dots menu: Steer now / Add to Blackboard
  (ensemble) / Edit / Remove. The side-chat mini composer keeps its compact
  stack and the round HUD keeps its queued-count pill.
- **Blackboard unread nudge.** Participants who post but never read: each
  seat's briefing now calls out how many in-scope blackboard entries are new
  to that seat ("N of these are new to you…") and reminds it to re-check the
  board via `blackboard_read` at wrap-up. Quiet when everything is already
  seen; resumed turns keep the existing unseen-only delta.
- **GPT-5.6 Sol / Terra / Luna un-gated.** The GPT-5.6 trio is now selectable
  and runnable in the Codex model pickers (composer, ensemble rosters, paired
  iOS picker) under concrete ids `gpt-5.6-sol`, `gpt-5.6-terra`, and
  `gpt-5.6-luna`, with Max reasoning on Sol. Launch-day safety posture is
  unchanged: dispatch preflight still verifies the id against the live Codex
  `model/list` and blocks with "Requires OpenAI preview access" until OpenAI
  serves the model, and GPT-5.6 runs keep the stricter preview-risk approval
  presets until eval confidence.

### Fixed
- **Transcript scroll-up yank.** Automatic follow snaps no longer pull the
  viewport back to the live edge when you scroll up to read history during
  streaming. The scroll hook now checks live `scrollTop` movement before any
  layout-effect or resize re-pin, closing a race where stream deltas could snap
  before the scroll listener recorded your upward gesture. Pinned-at-bottom
  streaming follow is unchanged.
- **iOS transcript hydration.** The Mac bridge now avoids sending oversized rich
  remote-projection frames that could exceed the relay's payload budget after
  the phone had already received the lightweight chat list. Oversized projection
  snapshots fan out through the existing single-envelope channel, and large
  thread snapshots are trimmed to a safe latest-row window instead of leaving
  mobile detail screens stuck on "Loading transcript from your Mac...".
- **iOS thread detail refreshes.** Mobile detail views now re-request transcript
  snapshots when a metadata-only snapshot says history exists but contains no
  rows, and Mac-side request handling avoids races where an early request could
  be ignored before the bridge connection was ready.
- **iOS projection aliases.** Remote thread snapshots now carry the aliases the
  Swift client expects, keeping transcript rows, ensemble metadata, and composer
  context attached to the selected chat.
- **iOS compact composer.** The mobile composer again collapses both the
  above-row controls and the footer telemetry rail when the keyboard drops,
  while preserving the compact diff access affordance.
- **iOS Ollama brand parity.** Participant health cards now repair generic
  Ollama display stamps with model-specific branding, so Laguna renders as
  Poolside on mobile like it does on desktop.
- **Windows CI portability.** Release/test scripts avoid POSIX-only assumptions
  that broke the Windows lane.

## 1.7.7 - 2026-07-06

### Added
- **Thread Introspection — memory promotion (read-only MVP).** A retrospective
  layer scans recent threads and runs, harvests evidence (run events, approval
  friction, message feedback, correction heuristics), and produces reviewable
  **Memory Proposal Packs** with scoped, cited lessons (preferences, failure
  modes, repo conventions, provider hints, skill patches, bugs, do-not-repeat
  notes). **Settings → Automation → Thread introspection** supports a manual
  24h run, proposal review (approve/reject), evidence citations, and a daily
  **Enable** toggle for read-only scheduled packs. Distinct from per-run
  Evidence Packs and ensemble Blackboard. See `THREAD_INTROSPECTION.md`.
- **Thread Introspection — apply phase 1 (repo conventions).** After approval
  through Settings or the gated MCP review tool, eligible `repo_convention` and
  `do_not_repeat` proposals can be applied through Settings/IPC to the workspace
  **RepoConventionIndex** via
  `applyMemoryProposal` (stable `intro-{proposalId}` entries, apply receipt on
  the proposal). **Blocked in phase 1:** skill/instruction file writes,
  `skill_patch`, `bug`, `preference`, `provider_hint`, and `failure_mode`.
  Skill patches remain review-only until a later Skill Patch Manager with diff
  preview and rollback. See `THREAD_INTROSPECTION.md`.
- **Thread Introspection — MCP trigger and review tools.** Agents can now use
  `tw_introspection_run`, `tw_introspection_list`, `tw_introspection_read`, and
  `tw_introspection_review` to create, inspect, and review proposal packs from
  chat. The MCP surface intentionally has **no apply tool**; applying approved
  proposals remains gated through the Settings/API flow.
- **Thread Introspection — decay and supersede lifecycle.** Store-level helpers
  can now supersede one memory proposal with another, expire past-due proposed
  items, and preserve bidirectional provenance links. Review surfaces can set
  expiry status/metadata, but supersede and automatic due-expiry callers remain
  internal and no automatic lifecycle policy is exposed yet.
- **Ensemble roster import/export.** Settings → Ensemble Roster can now save,
  import, and export full roster presets as portable JSON so teams can swap
  task-specific ensembles between installs. Imported/exported rosters preserve
  participant shape without carrying live Trusted Session authority.
- **iOS Ensemble parity.** The companion app can create/switch Ensemble chats via
  the same chat-kind bridge as desktop, repairs thread-list/task-card metadata
  when older Mac projections are sparse, and keeps ensemble status visible in
  the mobile shell.
- **Boss controls.** Bounded Boss control tools add quota reset summaries,
  timeout expiry, user-response tracking, participant summons, and MCP coverage
  for controlled multi-agent orchestration.
- **Agent-pool and tool icon expansion.** The agent-pool icon catalog now covers
  more workflow/tool families, including Diff Nice and release/CI-oriented
  glyphs.

### Changed
- **Trusted Session replaces ambiguous YOLO trust.** Full local authority is now
  granted per chat or per ensemble participant lane, not globally to every
  participant in the session. Workspace Write is accented orange and Trusted
  Session/Full Access is accented red in the picker and composer chip.
- **Release-class shell posture is narrower.** Generic release shell commands no
  longer receive blanket release approval; explicit publish/signing receipts
  still carry their own authority.
- **Live activity attribution is clearer.** Tool-call and thinking-trace stacks
  show participant-style speaker headers, preserve model/reasoning boundaries,
  and avoid rendering stale historical run cards in the transcript path.
- **Composer and workspace controls are denser and steadier.** Git/worktree
  rows, utility popovers, goal/plan popovers, diff counters, external-path rows,
  and secondary workspace chrome were tightened for repeated operational use.
- **Release packaging checks are more stable.** Gate A packaging excludes local
  Cursor workspace state from the app bundle, reduces fixture IO, and keeps
  optional macOS dependency installation scoped to the universal build path.

### Fixed
- **iOS thread-list recovery.** Task-card fallbacks, `chatKind` repair, and
  metadata snapshot merge keep companion lists aligned with desktop state after
  older or partial broadcasts.
- **MCP bridge write hardening.** Safe-write paths and tool alias classification
  better distinguish reasoning traces, shell/search aliases, and write-capable
  bridge operations.
- **Grok/Cursor composer glow parity.** Provider aura styling now matches the
  current composer shell for Grok and Cursor.

## 1.7.6 - 2026-07-05

### Added
- **Prompt caching guarantee tiers.** Settings → Providers → Prompt caching shows
  per-transport posture (Guaranteed / Automatic / Best effort / Unsupported) with
  optional diagnostics when providers report cache read/creation tokens. Controllable
  API/BYOK paths honor policy modes (`off` / `auto` / `explicit`); opaque CLI
  transports remain best-effort only.
- **Universal forks.** `/fork` and thread fork actions use a provider capability
  summary: **native fork** on Codex (`thread/fork`), **emulated fork** (isolated
  sibling chat with duplicated transcript) on other live providers, with clear
  native vs emulated labeling.
- **Worktree and branch orchestration.** Runtime profile `workspaceMode:
  worktree` resolves to git worktree lifecycle at run launch. The composer
  above-row branch control opens a popover to list branches, create a branch,
  checkout, and create/select/remove worktrees with dirty-tree guards.
- **Thinking trace actions.** Reasoning traces in the activity stack gain
  copy-friendly actions consistent with other tool cards.
- **Provider thinking summaries.** Assistant turns can surface compact thinking
  summaries where the provider exposes reasoning metadata.

### Changed
- **Cache usage telemetry.** Model Usage and prompt-cache diagnostics surface
  cache read/creation tokens when providers report them, including on implicit
  caching transports TaskWraith observes but does not control.
- **Run summary diff stats.** Diff stat chips align with the current evidence-pack
  presentation.
- **Composer shell polish.** Mic affordance and provider-row aura refinements on
  the composer chrome.
- **Sidebar workspace hierarchy.** Startup layout for nested workspace trees is
  tidier and less jumpy on first paint.
- **iOS run details token table.** Token summary layout simplified on the companion
  run-details screen.

### Fixed
- **Branch popover readability and placement.** The composer branch/worktree
  popover reuses the Model/Reasoning picker frosted-glass chrome and opens above
  the trigger by default so it no longer overlaps the picker row below.
- **Grok and Cursor thinking traces.** Incremental thinking deltas preserve
  whitespace and word boundaries instead of trimming each chunk before append.
- **Brief mention overlay scroll sync.** Ensemble brief @-mention overlays stay
  aligned while the transcript scrolls.
- **Release-class shell commands.** Approved release workflows (`git push`,
  `git_create_pr`, and related host commands) bypass redundant shell blocks after
  explicit user approval.

### Documentation
- New guide: `SESSION_AND_WORKSPACE.md` (caching tiers, forks, worktrees).
- Architecture and Advanced Optional Setup cross-links for BYOK caching caveats.

## 1.7.5 - 2026-07-05

### Added
- **Agent Pool icon colour controls.** Hue and brightness sliders stay visible for
  seed, asset, and named icons — not only after Shuffle — with editable Hex and
  RGB fields for precise picks. When **Tint icon** is on, your chosen colour
  overrides pre-baked asset hues; when off, the preview stays monochrome while
  the colour fields still show your last pick.
- **Agent Pool leaderboard.** Settings → Agent Pool now includes a sortable
  leaderboard table (styled like Model Usage) ranking pooled agents by runs,
  threads, tokens, tool calls, edits, work time, ensemble stage/role, and last
  active. Stats accumulate forward from saved ensemble runs.
- **Transcript participant filter rail.** Ensemble transcripts gain a compact
  filter rail so you can focus on one participant's messages without losing
  round context.
- **Add selection to composer prompt.** Highlight transcript text and send it
  straight into the composer as quoted context.
- **Composer voice input.** Pick a microphone source and dictate locally into
  the composer; on-device transcription fills the prompt without sending audio
  off-machine.
- **Ensemble brief presets.** Edit reusable brief presets from Settings and
  update them mid-round via a new `ensemble_brief` MCP tool.
- **Stacked fan-out working indicators.** Parallel fan-out lanes now show a
  clearer stacked busy state while seats are running.
- **Plugin contributions surface.** Activated plugin capabilities, tool bundles,
  local services, workflow templates, connector secret setup, health probes, and
  launch runners are wired into Settings and the new-workflow menu, with review
  gates before risky activations.
- **Sketch canvas tooling.** Agents can open a persisted sketch canvas for
  lightweight markup workflows.
- **Poolside Laguna (Ollama).** A new local-model preset joins the Ollama catalog.
- **Full thinking traces.** Extended reasoning traces are surfaced where the
  provider exposes them.
- **Compact collapsed model-usage grid.** With the sidebar collapsed, model usage
  condenses into a tighter grid layout.

### Changed
- **Fan-out transcript grouping.** Parallel fan-out activity rolls up into grouped
  cards instead of scattering individual lane messages through the thread.
- **Ensemble send queueing.** Sends issued while the orchestrator is busy route
  through the ensemble queue instead of racing the active turn.
- **Solo assistant labels.** Single-provider chats label assistant turns with
  provider identities rather than generic placeholders.
- **Workspace board creator.** Creating a board opens from a main-pane sheet
  instead of a sidebar-only flow.
- **Sidebar rhythm and composer tabs.** Section spacing is normalized; tucked
  composer tabs cap at 850px so wide monitors do not sprawl.
- **Ensemble chars slider polish.** Glass styling refinements and removal of
  noisy warning hints on the orchestration row.
- **Ollama branding.** Mentions, health cards, and iOS working labels carry
  consistent Ollama identity.
- **Provider tools catalog.** The tools reference is reorganized for easier
  discovery.

### Fixed
- **Agent Pool tint precedence.** Legacy baked accents no longer win over user
  hue/brightness when tinting is enabled.
- **Settings roster brief editor width.** The ensemble brief editor no longer
  overflows its panel.
- **Workflow quick-create from general chats.** Quick workflow creation works
  from non-workspace threads again.
- **Participant filter rail alignment.** Underfilled filter rails bottom-align
  cleanly against the transcript edge.
- **Completion-claim warnings retired.** Stale completion-claim transcript
  warnings are removed in favour of the current evidence-pack flow.
- **Active run provider labels.** In-flight runs show the correct provider name.
- **Ollama health card brand fallback.** Missing brand metadata no longer leaves
  a blank card.

## 1.7.4 - 2026-07-04

### Added
- **Mid-thread ensemble toggle.** Top-level chats can now flip in place between
  single-provider and Ensemble mode on the same chat, preserving transcript and
  run history. Solo → Ensemble seeds a single participant from the current
  provider instead of recreating the thread, and Ensemble → Solo collapses back
  to a canonical provider — defaulting to the current Boss participant so the
  thread keeps its lead voice. The toggle is available on started threads when
  idle and stays disabled while a turn is active.
- **Ensemble blackboard — a shared scratchpad for your agents.** Participants can
  now post durable, bounded shared-memory entries (decisions, verified facts,
  open risks, do-not-repeat notes, concise notes) that every seat sees as a
  compact digest instead of re-deriving the same facts each turn. Agents get
  `blackboard_post` / `blackboard_read` / `blackboard_delete` tools with per-seat
  "seen" tracking, entries carry a round / session / chat lifespan, and the whole
  board is browsable — with its unseen/seen state — from the Pins panel.
- **Ensemble fan-out controls, refined.** The orchestration-row Fan-Out control is
  clearer to steer, and a parallel writer wave now lands as a single **Fan-out
  result card** that gathers each seat's contribution in one place instead of
  scattering them down the transcript.
- **Live seat-compaction progress.** When an Ensemble seat approaches its context
  ceiling, you now see its compaction happening live — an in-progress indicator
  on the participant and a boss-facing cue — rather than only a card after the fact.
- **File-change hover diffs.** Hovering a changed file in a run now previews a
  compact per-file diff summary (added / removed line counts and the change
  shape), so you can gauge what a step touched without opening the editor.
- **Transcript rail reading lens.** The user-message marker rail now carries a
  slide-rule-style "lens": a frosted carriage whose height shows how much of the
  thread is on screen and whose position tracks your scroll. Ticks it has swept
  past settle into an "inked" spent state, marking the done/upcoming boundary as
  a second, colour-independent cue.
- **Rail jumps now glide.** Clicking a go-to-message tick or the ↑ / ↓ arrows
  animates the transcript to the target (distance-scaled, eased) instead of
  teleporting. Any wheel / touch / key input mid-glide cancels it instantly, and
  reduced-motion settings restore the instant jump.
- **Collapsed rounds keep their rail markers.** In Ensemble chats, user prompts
  hidden inside a collapsed round card still appear on the go-to-message rail,
  anchored at the round's header; clicking one auto-expands the round and glides
  to the prompt.
- **Quick controls survive collapsing the sidebar.** Hiding the workspace sidebar
  now surfaces a bottom-left vertical glass pill with the sidebar footer's quick
  controls — Settings, Approvals, Shares, and Devices — each opening the same
  popover as its sidebar counterpart, with the same pending/collaborator/device
  glows.
- **iOS: richer notification banners.** Turn-complete and status banners on the
  companion carry more context at a glance, while genuinely noisy remote
  notifications are dialled back so the ones that arrive are worth reading.

### Changed
- **Provider / model / reasoning switching no longer stops at first send.** In
  normal chats, the composer provider and model / reasoning pickers stay usable
  after a thread has history. Idle changes apply immediately; while a turn is
  active they queue and apply at turn end. The same-provider case keeps the live
  session; only a genuine provider switch resets provider-linked session state.
  The iOS companion mid-thread switch got the same session-hygiene treatment.
- **Continuous-mode ensembles keep going on their own.** A Continuous round no
  longer stops the moment agents stop explicitly handing off. When the roster
  drains with an active goal, TaskWraith re-dispatches another pass automatically
  — up to the handoff-turn budget — and stops cleanly when the goal is completed,
  blocked, or paused, when the hop budget runs out, or when a round makes no
  progress.
- **Ensemble roster is easier to shape.** The old minimum-two-participant floor is
  gone, so you can pare a roster down freely, and collapsing or reworking the
  roster no longer discards participants you meant to keep.
- **Guest participants removed.** The older Guest helper path has been removed from
  desktop, iOS, bridge, and live docs. Historical guest transcript rows remain
  render-safe and inert.
- **Corner-pill polish.** The bottom-left column pill's dividers span the full pill
  width and its icons are larger. Active pill buttons swapped the old
  left-weighted blue gradient — whose near-white glyph vanished on light themes —
  for the neutral glass blob + hairline ring the hover state already used.
- **Quieter sidebar and calmer flourishes.** The sidebar's model-usage heatmap was
  retired, the masthead and New button line up with the brand row, transcript
  item separators read as a softer silver, and the sky-diff easter egg is pared
  back to just its drifting +/− line counts.

### Fixed
- **Priority @-mentions reach the Boss even after they've spoken.** Directing a
  round back to the Boss — or the acting Captain when the Boss is away — after
  that authority had already taken its turn printed a "takes routing priority"
  note but then silently dropped the route. The authority is now genuinely
  re-summoned (bounded by the handoff budget so it can't loop), and when a
  re-summon truly can't be delivered the note reports the real reason.
- **Dedicated writers fan out in parallel again.** Two round-start gating bugs let
  stage reviewers and read-only workers falsely veto a parallel writer wave,
  forcing writers back to a slower serial pass; parallel writer fan-out now runs
  when it's warranted.
- **Ensemble steering and recovery hardened.** A steer issued during a parked
  window is now honoured, zombie dispatch after a cancel is stopped, and an
  ensemble participant recovered after an app restart is labelled as itself
  rather than mislabelled as a solo run.
- **Stale run-queue rows no longer linger.** Active-run queue entries left behind
  by a finished or interrupted run are suppressed, so the queue reflects what's
  actually running.
- **Chat titles and summaries stay honest.** Chat-list summaries are validated
  against each chat's own file so a title can't drift away from its conversation,
  index churn is throttled to keep the list steady, and session checkpoints
  persist more reliably across compaction.
- **A pending question now sits at the live tail.** In Ensemble chats an
  `ask_user_question` card could strand itself above the speaker; it now pins to
  the bottom of the live conversation where you'd expect to answer it.
- **Rail no longer bleeds under the composer.** With the workspace sidebar
  collapsed, the go-to-message rail could overlap the floating composer's left
  edge; it now anchors to the leftmost mounted lane, stays fully to the
  composer's left, and re-measures when layout transitions settle.
- **Settings is reachable with the sidebar collapsed.** Opening Settings while the
  sidebar was hidden left no tab navigation and no "Back to app"; the sidebar slot
  that hosts the Settings nav now force-mounts for the takeover and slides back
  out on close, without touching the user's collapsed preference.
- **Right-dock panels no longer stack from the top pill.** The rim buttons (Run
  rail, Media, Notes / Pins, Terminal, File editor, Inspector) route through the
  dock's exclusive lifecycle: opening one surface replaces the previous, and
  closing the active surface collapses the whole dock in a single click.
- **Remote approvals that over-shoot the offered tier are honoured.** Tapping
  "Accept for workspace" on an iOS approval that only offered a narrower accept no
  longer silently drops it; the accept is down-clamped to the strongest offered
  tier and the command actually runs.

### Security
- **Roster permission changes respect the workspace auto-edit gate.** Setting an
  ensemble participant to an auto-edit-tier posture (workspace-write or full
  access) from a remote device now requires the workspace to permit auto-edit,
  closing an escalation path that bypassed the gate the composer already enforces.
- **Cursor native shell and writes unlock only under a real Full access grant.** A
  write-capable Cursor run keeps its native shell / write deny-list — routing
  through the TaskWraith broker — unless it's running under a genuine, signed Full
  access grant, matching how Codex full-access is treated.

## 1.7.3 - 2026-07-03

### Fixed
- **Full Access agents can build, sign and ship.** A Codex agent running under
  the **Full access** permission preset now launches without the workspace
  sandbox (`danger-full-access`) instead of being confined to the repository.
  Under the previous `workspace-write` confinement it could not reach the login
  keychain (code-signing identities), `~/Library` caches (SwiftPM / DerivedData),
  or paths outside the workspace — so an approved release task (iOS
  archive / notarize / TestFlight upload) failed at signing even after the user
  approved it. The sandbox now drops **only** for a genuine, signed Full access
  grant; every other run stays workspace-confined, and a global "deny shell
  commands" setting still overrides it.

### Added
- **iOS: grant Full access from your phone.** The iOS participant permission
  picker now offers **Full access**, matching the desktop permission picker, so
  a phone-driven ensemble participant can be given the full-access posture that
  lets it build, sign, and ship.

## 1.7.2 - 2026-07-03

### Added
- **iOS ensemble orchestration parity.** The iOS companion can now adjust
  ensemble controls that were previously desktop-only: designate the
  **Captain** (second-in-command who steps in when the Boss is unavailable),
  switch between **Turn** and **Continuous** mode, set the **max handoff
  turns** (hop limit) for continuous rounds, choose the **Fan-Out** policy
  (Off / Read / Write, where Write resolves to the Boss-gated or
  user-preflight writer lane), and set the **shared-transcript character
  budget**. Each change round-trips to the Mac and takes effect on the next
  round.

### Changed
- **Question routing.** The agent runtime preamble now steers agents to the
  TaskWraith `ask_user_question` tool instead of a provider-native question
  prompt, which silently auto-resolves without reaching the user in this
  harness (desktop or the iOS companion).

## 1.7.1 - 2026-07-03

### Added
- **Context compaction, made visible.** Solo Claude and Codex chats now show a
  glass compaction card when a context reset completes or fails, and the
  composer context donut grows a pressure state (amber at 80%, red at 95%) with
  a **Compact context now** button once a linked session is under pressure.
  `/compact` stops being a cosmetic prompt template and dispatches a real
  provider-native compaction, falling back to the template only for busy or
  session-less chats. Overflow errors get a named remedy hint instead of a raw
  wall of provider text.
- **Ensemble seat compaction.** Long-running Ensemble seats no longer stall at
  their context ceiling. Each participant carries a rolling summary, the
  orchestrator materializes per-seat compaction cards and boss-facing pressure
  cues, and a post-round auto-trigger keeps Claude, Codex, Cursor, Kimi, and
  Grok seats healthy across a long session with a cooldown so it never thrashes.
- **Ensemble stage roles.** Participants can now be assigned a **scout**,
  **worker**, or **reviewer** stage. Reviewers wait for the writers instead of
  running against work that does not exist yet, then run together in a closing
  **Review wave** once only reviewers remain. Stage roles round-trip through
  roster presets, Boss roster edits, and the iOS Roster page picker.
- **Message feedback.** Assistant messages now take a thumbs-up / thumbs-down
  from the action row or right-click menu, with optional reason chips on a poor
  rating. Votes persist with the message and roll up into per-model casting
  summaries in Settings, laying the groundwork for recasting a weak answer with
  a different model.
- **Redesigned right dock.** The two-tier glyph strip is replaced with a clean
  surface switcher: a slim header whose active-surface button opens a grouped
  Session / Work / Inspect popover, the Inspector's sub-views regain text
  labels, and a ⌘K command palette searches across every dock surface. The
  active surface is now remembered per chat, and the iOS companion mirrors the
  per-thread inspector memory.
- **Agent Pool gets its own page.** The reusable Agent Pool moves out of the
  foot of the Ensemble Roster tab into a dedicated **AI & Providers -> Agent
  pool** settings page, so it has room to grow and is no longer squashed under a
  large roster. The roster tab keeps its per-participant *Save to pool* action.
- **Projects sidebar, finished.** The Projects tab added in 1.7.0 gets a full
  polish pass: archived member chats stay visible with an **Archived** chip,
  expand state persists, chat rows drag straight onto a project, search is truly
  scoped per tab, and the whole tablist is keyboard- and screen-reader-navigable.
  A `migrateProjects()` step means schema drift no longer drops project data.
- **Collaboration contribution rules.** Shared chats can now carry a contribution
  preset (read-only, comments, request host action, or auto-draft). Collaborators
  on an enabled share can submit a structured **action request** that goes to the
  host for review and is never dispatched to a provider, optionally pre-filling
  the host's composer as an external-untrusted draft. A bounded, redacted
  collaboration audit log records share, invite, and contribution events.
- **Collaborator reconnect.** A dropped collaborator can rejoin their last shared
  chat with a pinned, encrypted identity — no fresh invite token and no repeated
  safety-number compare — while still signing fresh session keys every reconnect.
  Reconnection survives host restarts; revoked participants stay locked out.
- **Clickable tool-call file paths.** File paths in tool-call rows are now
  clickable and open directly in your editor, with a hover preview. The
  user-message transcript rail also gains a scroll-spy highlight, a progress
  track, and a hover bulge for moving between prompts in a long conversation.

### Changed
- **Local models follow the standard permission role.** Ollama's bespoke
  tool-control tier ladder is retired. Local models now get the full tool
  surface and obey the same Plan / Read-Only / Default / Full Workspace Access
  role as every other provider, governed at the shared approval gate. Read-only
  web search and fetch are now permitted under Read-Only and Plan for all
  providers, so a local model can finally search the web in a General chat.
- **Managed-enterprise readiness.** The B5 items previously tracked as pending
  have now landed: scoped and redacted audit-bundle export with signed
  verification receipts, managed-policy loading and clamps (settings, update,
  safety, bridge, MCP, and user-MCP allowlisting), encrypted storage for MCP and
  runtime-profile secrets, and dispatch receipts stamped through the queue and
  scheduled-run lifecycle. The claim stays deliberately bounded to local safety
  plus partial managed policy and redacted audit export — no SSO/SCIM, SIEM
  integration, WORM or append-only export, or organization-wide retention is
  implied.
- **Claude/Codex-parity scroll follow.** Lock-to-bottom now behaves like the
  Claude and Codex apps: a **Jump to latest** pill appears while a single answer
  streams into view, the jump reliably re-locks even as content grows mid-flight,
  sending a prompt while scrolled up re-arms follow, and any upward gesture always
  wins.
- **Sidebar running vs. selection.** A running thread now shows a slow-pulsing
  monoline "ghost" mark, and the accent rim is reserved strictly for the selected
  thread — the two were nearly indistinguishable before. Each sidebar section
  previews its first few threads with a *show more* affordance, and on macOS the
  corner-controls pill clears the window traffic lights when the sidebar is
  closed.
- **Ensemble roster controls.** Orchestration controls move onto a labeled
  roster-presets second row, the participant chip strip reflows into balanced
  rows of five, and the roster cap is raised from 18 to 20. The composer's
  Ensemble toggle moves to the footer.
- **Persistent Grok seats and slimmer resumes.** Per-seat Grok ACP sessions and
  slimmed resumed-seat turn prompts are now enabled by default, trimming repeated
  context on long multi-turn Ensemble rounds.
- **Composer polish.** Diff counters animate as they change, cost estimates line
  up with the remote projection shown on the companion, and working-text glow is
  softened.

### Fixed
- **Ensemble reliability.** A cluster of round-lifecycle fixes: the composer and
  queued-row **Steer** now act on the first click, queued-row Steer and Delete
  recover after an app restart, seat changes hand over cleanly and preserve their
  stage role, duplicate yield-activity rows are removed, and a clean exit with
  streamed content finalizes as *answered* instead of hanging.
- **Startup opens a fresh chat.** Launch no longer restores the most recent
  global chat into a stale, un-hydrated transcript. The app now opens a fresh
  single General chat on your default provider every time; workspaces and
  ensembles remain one click away in the sidebar.
- **Right-dock resizing.** The inspector divider resizes reliably again, and the
  dock's surfaces are now mutually exclusive so opening one no longer leaves
  another stranded behind it.
- **Local tool-call repair.** The Ollama tool-call repair loop is hardened: the
  decode grammar allows the full tool catalog rather than only advertised names,
  harness-gate blocks count toward the retry ceiling, argument validation matches
  the executor gate, and each Ensemble seat keeps isolated tool memory.
- **Duplicated assistant text.** The legacy delta lane now defers to the run-item
  sidecar, so streamed assistant answers no longer render twice.
- **Permission honesty.** Network-deny is honored for web tools, evidence-pack
  and observability tools are classified as orchestration, and Plan-workflow
  posture is now visibly distinct from Read-Only in labels and over the iOS
  bridge.
- **Usage meters.** The Claude Fable weekly quota meter reads the current
  session-group payload shape, the Grok `/usage` probe works against the new
  CLI's terminal queries, and all four Claude quota windows survive on the iOS
  first-launch card.
- **iOS companion parity.** New task starts preserve their permissions,
  Plan-workflow posture carries correctly over the bridge, and Agent Pool
  transcript identity is de-boxed to match the desktop.

### Removed
- **Ollama tier machinery.** With local models now on the standard permission
  role, the dead tier resolvers, tier tables, mid-run tier-bump path, the
  now-inert tier and run-profile picker UI, and the unused global run-profile
  settings surface are all deleted.
- **Retired messaging gateway.** The old messaging gateway and its cleanup
  residue are removed.

## 1.7.0 - 2026-07-01

### Added
- **Plan Mode workflow.** Composer mode now separates Plan workflow from
  Read-only recon. Plan chats can surface a single proposed plan from the
  designated owner, approve / customize / dismiss it, and carry the approved
  artifact path into implementation.
- **Plan artifact writes.** Plan workflow can write markdown plan files under
  validated workspace paths while the signed workflow posture prevents ordinary
  read-only recon runs from unlocking that carve-out.
- **Codex native-review status cards.** Native Codex review progress now flows
  into review/status cards so transcript activity shows review findings and
  state without burying the signal in raw provider events.
- **Ensemble read fan-out skip.** Active read-only scout lanes can be stopped
  before the writer step when the panel has enough evidence.
- **Boss roster-swap choices.** Boss participants can inspect live participant
  ids, provider/model catalogues, context windows, and coarse quota bands before
  swapping an inactive seat.
- **iOS proposed-plan file handoff.** The companion now receives plan artifact
  paths, shows them on proposed-plan cards, and can jump straight into Files
  mode for that plan artifact when the paired Mac exposes a workspace scope.
- **Projects sidebar tab.** The workspace sidebar now switches between
  **Threads** (the existing grouped layout) and **Projects**, a user-defined
  hierarchy for organizing chats across workspaces, providers, or any folder
  tree you want. Create, rename, nest, reorder, and delete project groups;
  assign each project an icon and hue with the same picker used for Roster
  Preset Agent Pool customization; add chats from an overflow menu or by
  dragging sidebar chat rows onto a project. Search is scoped per tab, expand
  state persists, archived members stay visible with an **Archived** chip, and
  the active tab is remembered across sessions. Project data lives in
  profile-global renderer `localStorage` (not workspace-scoped). Deleting a
  chat removes its id from every project membership list; archived chats
  remain listed so unarchive can restore membership.

### Changed
- **Claude picker line-up.** Mythos 5 is retired from current Claude model
  pickers while Fable 5 and Sonnet 5 remain visible; historical Mythos chats,
  aliases, display names, rates, context windows, and CLI normalization stay
  compatible.
- **iOS Plan workflow parity.** The companion copy now names Plan workflow
  directly, and its model context reference mirrors the post-Mythos Claude
  line-up.
- **Ensemble recovery after restart.** Multiple interrupted Ensemble lanes in
  one chat now collapse into one grouped recovery system message with
  role/participant labels and provider-session hints.
- **Ensemble steering reliability.** Steered queued prompts now wait for active
  round cancellation before redispatching, avoiding overlapping fan-out teardown
  and queue-persist churn.
- **Boss and participant boundaries.** Agent-driven roster edits and Boss
  replacement are capped so agents cannot assign Full Workspace Access; only the
  user can elevate to that level.
- **Ensemble read-only review posture.** Read-only ensemble seats are now
  instructed to produce findings and review in place, separate from plan-workflow
  ownership, so review lanes no longer emit plan artifacts when asked to inspect
  work.
- **Ollama Ensemble context.** Local lanes preserve their assigned participant
  role and Lead/Boss routing across tool loops, retries, and compaction.
- **Enterprise-readiness boundary.** B1-B4 readiness work is documented as
  shipped for network-policy honesty, durable permission-posture proof, iOS Plan
  workflow parity, and label/copy honesty. B5 managed-enterprise work remains
  explicit: secrets, audit export/retention, managed policy, user-managed MCP
  allowlisting, dispatch receipts, and feedback receipts are tracked without
  implying SSO/SCIM, SIEM integration, WORM or append-only audit export,
  organization-wide retention, or a complete managed organization control plane.

### Fixed
- **Plan Mode security.** Workflow mode is signed into run permission posture,
  and plan-artifact paths reject symlink / realpath escapes.
- **Recovery transcript noise.** Restarting after interrupted parallel fan-out no
  longer appends one nearly identical system row per lane.
- **Brokered MCP transcript labels.** Brokered MCP tool calls now render with the
  MCP plug icon and uppercase label.
- **Inactive participant pickers.** Ensemble participant provider/model pickers
  stay editable for inactive seats while a round is running, so quota relief and
  seat swaps do not get blocked by the active speaker.
- **Ensemble Boss close-out.** When the assigned Boss yields to the user, the
  round now definitively finalizes instead of letting queued mention turns keep
  the panel alive and bounce turns back.
- **Ensemble mention rendering.** Transcript mention chips now use the same
  alias-aware tokenizer as the composer and routing layer, so multi-word model
  names, role aliases, and mixed words no longer get split or revert to the bare
  provider name.
- **Ensemble lifecycle after completion.** Stop glyphs and steer-queue behavior
  no longer stick around after a round has finished; terminal rounds also clear
  queued prompts and stale run-queue jobs so the Active Runs sidebar drains
  correctly.
- **Task Complete card during live runs.** The "Task Complete / Final Summary"
  card is hidden whenever the current chat has fresh run evidence, preventing a
  stale notice from sitting at the bottom of an active round.
- **Latest Ensemble round collapse.** The transcript no longer collapses the
  currently live Ensemble round into a card after a cancel or seat change; only
  genuinely older rounds get the compact card treatment.

### Known Open
- **Grok interrupted-lane resume.** Grok session-id persistence remains
  evidence-first after the steering fix; no source patch is claimed without a
  fresh post-fix recovery capture.
- **Ollama literal write-artifact probe.** The Ollama retention/probe item stays
  accepted-open until a controlled artifact-backed repro says otherwise.

For matching release-tagged artifacts, the macOS build should be notarized +
stapled (universal) and verified against the published checksums/update feed.
Windows (unsigned) and Linux artifacts are attached by CI after the release is
published.

## 1.6.9 - 2026-06-28

### Added
- **Ornith local Ollama models.** Local / Ollama now includes Ornith 1.0
  (9B Param) and Ornith 1.0 (35B Param), with model labels, context-window
  estimates, setup hints, preflight checks, run profiles, rate estimates, and
  iOS companion metadata wired through the desktop and companion surfaces.
- **Liquid LFM local Ollama model.** Local / Ollama now includes Liquid LFM 2.5
  (8B-A1B) with model labels, context-window estimates, setup hints, and iOS
  companion metadata alongside the existing local-model picker surfaces.
- **Model usage workspace matrix.** Settings -> Model Usage now adds a
  provider/model by workspace matrix for the busiest workspaces, showing diffs,
  tokens, and cost estimates alongside the existing aggregate table.
- **Current-chat search and transcript jump controls.** Threads now have a
  current-chat search surface and compact transcript gutter controls for moving
  between user prompts in long conversations.

### Changed
- **Cleaner welcome notices.** Welcome / first-launch notices are dismissible and
  swipeable, with the carousel now focused on local Ollama models (Ornith + LFM),
  the AntiGravity policy notice, and rotating changelog highlights instead of
  older Gemini/Grok cards.
- **Composer shell polish.** Queue and Steer controls stay out of non-native
  composer shells, review popovers open within the visible area, Claude action
  glyphs are adjusted, Codex reasoning now uses the current "Light" label, dark
  Codex / Claude shell surfaces use matched neutral fills, and Ultracode effort
  labels have clearer purple sparkle treatment.
- **Visual and attachment polish.** PDF attachments can render as image previews,
  composer image placeholders are more useful, sky effects are softer, and the
  optional weather UFO flyby is present in the renderer layer. The Electron
  transcript Working indicator now uses the monoline TaskWraith ghost with a
  softer provider glow and ambient sparkle treatment.

### Fixed
- **Ollama reliability.** Ollama transport failures are handled more cleanly, and
  local-model routing now carries Ornith-specific context, memory, retrieval, and
  preflight behavior instead of falling through generic defaults.
- **Collaboration, sharing, and remote access.** Share hosts can recopy
  collaborator invites, ensemble handoffs and role boundaries are stricter,
  ensemble timestamps preserve their original transcript times, and Tailscale
  cellular setup can repair the detected relay door.
- **Desktop workflow fixes.** Sidebar rename editing is scoped to the active row,
  spellcheck suggestions appear in editable context menus, current workspace
  search moved to key commands, and composer plan state stays fresh after todo
  changes.

## 1.6.8 - 2026-06-28

### Added
- **Scheduled messages in the visible queue.** The composer Schedule clock now
  creates a timer-locked queued message instead of a separate hidden scheduled
  task. Scheduled rows keep Edit/Delete, show a live countdown where Steer
  usually appears, and dispatch automatically when due.
- **Larger composer uploads.** Drag/drop, paste, and attachment picker flows now
  keep up to 15 composer attachments.
- **Detected Tailscale relay setup.** The iOS bridge settings now show this
  Mac's detected `wss://` Tailscale relay door with Use this, Copy, and Test
  actions so cellular pairing no longer depends on users hand-entering the
  MagicDNS URL and port.

### Changed
- **Cleaner trust-mode UX.** YOLO / Trust This Session now appears as a compact
  composer chip with an explanatory tooltip and click-to-disable behavior,
  replacing the warning-style banner.
- **Clearer approval affordances.** Permission, elevation, unattended workflow,
  Ollama parity, and provider sign-in actions now have tooltips that explain the
  consequence and lifetime of each choice.
- **Softer visual polish.** Sky visual effects have softer orb edges, and image
  attachments show better placeholder behavior while previews load.
- **Message actions moved into timestamp footers.** Transcript copy/delete
  actions now sit in the message footer area instead of floating over the
  message body.

### Fixed
- **Share invite reliability.** Shared-chat invite copy and relay setup are more
  robust, including stronger validation around collaborator join payloads.
- **iOS relay pairing fallback.** Tailscale and relay pairing paths recover more
  reliably when the initially advertised route is not usable, and release builds
  honor the configured Tailscale Serve front-door port during startup and
  self-heal.
- **Desktop polish fixes.** Helper subprocesses no longer appear as extra app
  icons, spellcheck context menus behave correctly in editable fields, thread
  rename persistence is more reliable, and the sidebar rename editor is harder
  to trip up.

## 1.6.7 - 2026-06-28

### Added
- **Universal composer scheduling.** Workspace-backed single and Ensemble chats
  now have a Schedule clock in the composer controls. It opens a glass date/time
  picker with quick presets and uses the existing scheduled-task pipeline so
  delayed prompts stay restart-safe and run through the same unattended-authority
  guardrails.

### Changed
- **Scheduled task visibility.** Scheduled-task pills now show a live countdown
  and switch to "due / waiting" when the timer has elapsed but the chat is still
  busy.
- **More flexible iOS relay pairing.** Device pairing can include a manually
  configured relay door alongside LAN/Tailscale discovery, making release builds
  less likely to get stuck on the wrong network path.

### Fixed
- **Sidebar rename reliability.** Inline chat rename fields focus and select
  consistently, rename can be started deliberately from the row or menu, and
  renamed titles avoid unnecessary truncation in edit fields.
- **Scheduled-task validation.** The main process now rejects invalid or already
  elapsed schedule times before saving delayed work.

## 1.6.6 - 2026-06-27

### Added
- **Decomposition groundwork.** App and main-process orchestration have started
  moving out of the large root files into focused helper, hook, and IPC modules,
  making future changes easier to review without changing user-facing behavior.
- **Sidebar workspace path actions.** Workspace path controls are easier to reach
  from the sidebar during local project work.

### Changed
- **More robust iOS remote access.** Dev and release builds recover Tailscale /
  relay routing more reliably, retry transient status probes, prefer recently
  successful relay doors on reconnect, and restart the embedded bridge on demand
  when pairing needs it.
- **Smoother desktop transcript streaming.** Electron transcript reveal and scroll
  ownership now stay active during provider output so streamed text feels less
  chunky and long-running replies do not fight the user's scroll position.
- **Navigable app notices.** Welcome / first-launch notification cards can now be
  dismissed permanently and moved through with explicit carousel controls.

### Fixed
- **Ensemble orchestration reliability.** Role and Boss mention routing now
  takes priority over ambiguous provider tags, stale round lifecycle state
  recovers cleanly, and shared-chat invite joins are harder to trip up.
- **Cursor MCP bridge compatibility.** Cursor and compatible runtimes can use the
  brokered TaskWraith MCP tool names that include hyphens while reserved
  TaskWraith tool namespaces remain protected from repo-provided collisions.
- **Security hardening.** Release 1.6.6 tightens agent trust boundaries across
  approval actions, Cursor MCP allowlisting, favicon fetching, external path
  grants, raw provider event persistence, PTY session ownership, git IPC scope,
  transcript local-link opening, relay connection caps, and encrypted relay
  resume/ACK handling. Retired Gemini OAuth profile material is purged instead of
  being recreated.

## 1.6.5 - 2026-06-27

### Added
- **User MCP server manager.** Settings can now manage user-defined MCP servers,
  import/export provider snippets, show per-server readiness, and copy
  provider-specific config for Codex, Claude, Cursor, and compatible JSON/TOML
  targets. Remote server URLs, bearer headers, naming collisions, and invalid
  exports are validated before they reach provider runtimes.
- **iOS diff review sheet.** The companion's files-changed / diff summary rows
  now open a dedicated glass diff sheet for quick review from the composer area.
- **Shared chats on iOS.** Shared-human chat projections and the shared-chat type
  chooser now appear on the companion, with sidebar actions restored on desktop.
- **Transcript user gutter.** User messages gain a compact gutter/jump affordance
  so long transcripts can move back to the originating request more reliably.

### Fixed
- **iOS thread rename parity.** Chat renames from the iOS companion sync back to
  the Mac, full titles are preserved across the bridge, and headers/sidebar rows
  avoid unnecessary truncation in rename fields and wide-enough title areas.
- **iOS Boss removal.** Roster updates from the iOS companion now distinguish
  old clients that omit the Boss marker from current clients explicitly sending
  `isBossman: false`, so turning Boss off clears the Mac-side assignment and
  removes the crown instead of preserving the previous participant.
- **Transcript jump stability.** Message jump targets now converge more reliably
  through virtualized transcript rendering and stay anchored when navigating to a
  specific user message.
- **Transcript table readability.** Wide Markdown tables wrap and align more
  consistently across Electron and iOS transcripts.
- **Claude picker availability.** Fable remains visible but disabled while
  unavailable, and reasoning options such as Extra / Ultracode stay visible but
  unselectable on models that do not support them.

### Changed
- **MCP setup copy is clearer.** Provider-tool setup now labels active MCP
  servers, routes settings searches to the right config panes, and explains the
  Cursor/Grok bridge fallback without implying retired Gemini setup work.
- **Media previews are richer.** Electron previews and inline audio waveform clips
  gained focused preview affordances and cleaner transcript presentation.

## 1.6.4 - 2026-06-26

### Added
- **Composer-aligned slash picker.** Slash commands now open in a wider,
  composer-width picker with grouped sections, richer command descriptions, and
  custom monoline icons for review, planning, side-chat, ensemble, Gemini,
  workflow, settings, and utility commands.
- **More slash command coverage.** Multiview side panes, ensemble controls,
  workflow helpers, Gemini passthrough commands, prompt templates, model/context
  tools, and settings shortcuts can be run from typed slash commands or picker
  selection.

### Changed
- **Consistent theme opacity.** Every named system theme now obeys Settings ->
  Appearance -> Main pane opacity, instead of only Light, Dark, Alabaster, and
  Obsidian honoring the slider.
- **More readable popovers.** The Settings menu, Approvals, Shares, and Devices
  mini pickers now use a 75% background material so their contents stay legible
  across glass-heavy themes.
- **iOS display scaling.** The companion gained a display-size scaling control for
  tuning the remote UI density on-device.

### Fixed
- **Slash routing hardening.** Typed slash commands now route through the shared
  registry, preserve drafts when a pane handler redirects, resolve participants
  per focused pane, refresh Gemini command discovery after `/commands reload`, and
  handle discovered commands with argument placeholders.
- **Share reconnect polish.** Shared chat discovery and reconnect signals are more
  resilient when a linked device or collaborator returns after a brief disconnect.

## 1.6.3 - 2026-06-26

### Added
- **Shared chats.** You can now invite other people into a chat. Sharing runs over
  the same end-to-end-encrypted relay as the iOS companion: invitees join by
  confirming a short verification code, see a live projection of the conversation,
  and you stay in control from a People header with per-participant revoke and a
  one-click "Stop sharing." A new Shared section in the sidebar, a "New Shared
  Chat" entry in the + New menu, and a dedicated Shares settings tab manage the
  whole lifecycle; collaborator comments are clearly marked as external/untrusted.
- **A bigger media toolkit for agents.** Agents can now mix multitrack audio and
  encode, overlay and concatenate video natively (VideoToolbox, no ffmpeg),
  transcribe audio on-device, and inspect audio segments and video frames with an
  interactive scrubber, an NLE-style filmstrip and a DAW-style waveform player —
  all over the un-forgeable trusted-media channel. Producer outputs gain automatic
  posters, badges, an expand-to-view viewer and Finder/copy/save actions, and any
  player can be torn off into its own resizable pane.
- **Audio & video playback on iOS.** The companion streams and plays audio and
  video inline in the transcript over the encrypted link — chunked so it seeks and
  plays without downloading the whole asset first — with posters and metadata.
- **Model context lengths.** A new Context lengths view (in the sidebar Model Usage
  overlay and a Settings table, on both desktop and iOS) shows each model's
  official context window, and the composer context meter is now a clickable
  popover with per-participant detail.
- **Sidebar control cluster.** A traffic-light footer — Approvals, Shares and
  Devices — with at-a-glance popovers for pending approvals, active shares, and
  paired devices with a live-connected indicator.
- **Composer plan popover.** A plan control in the composer for setting a run's
  plan inline.
- **Trust guide & setup docs.** A top-level trust-and-safety guide (safe first-run
  path, capability matrix, local storage/reset notes, provider data boundaries,
  release-verification commands and known limits), an advanced optional-setup
  guide, a composer-variant gallery and refreshed README screenshots.

### Changed
- **Codex surfaces media.** Codex runs now show their generated images and trusted
  audio/video in the transcript, at parity with the other providers.
- **Looping workflows show live progress.** A looping workflow reports per-iteration
  progress as it runs, and its verifier can run on a different provider than the
  maker.
- **Media tools are gated like shell and file access.** Media editing is now its
  own audited, approvable capability with read-only presets, rather than riding
  along with general tool access.
- **Cursor/Grok bridge clarity.** Write-capable Cursor and Grok runs use
  TaskWraith's scoped MCP broker without manual provider-side config, and the
  shared bridge copy no longer names retired Gemini as an active setup target.

### Fixed
- **No more repeated notification banner (iOS).** The companion no longer raises a
  banner every time it registers for push notifications.
- **iOS recovers instead of bricking.** A keychain identity error (-34018) now
  recovers the device identity instead of leaving remote unusable, plus sidebar
  polish — single-line chat rows and the workspace utility icons unified into one
  glass pill.
- **Collaboration hardening.** Shared projections scrub secrets and collapse
  sensitive paths, appends are rate-limited, display-name impersonation is
  tightened, and shares are revoked when their chat is deleted.
- **Composer plan control.** Stays visible and renders its participant plan lanes
  correctly, and the side-chat composer gained the same parity controls.

## 1.6.2 - 2026-06-25

### Added
- **Refractive "liquid glass."** An optional refractive-glass material that brings a
  subtle liquid-glass refraction to the composer, sidebars, pickers, dashboard and
  first-launch sheet in place of the flat frosted look. Toggle it under
  Settings → Appearance — it's independent of the other visual effects.
- **Workflows can loop.** A workflow can now run a maker → verifier → decide loop:
  each iteration is independently judged (accept / revise / reject), with a durable
  run history. Desktop shows per-iteration history in the sidebar; iOS shows a
  "N× · accepted" loop-progress badge.
- **Audio, video & image tools for agents.** Agents can play audio and video inline
  in the transcript, run waveform-backed audio analysis and native single-frame
  video decode, and generate images with a bring-your-own image-API-key UI — all
  over an un-forgeable trusted media channel.
- **Boss — ensemble manager.** An opt-in manager that can reorder or replace
  ensemble participants and drive a shared goal, gated by an auto-approval policy
  with a full audit ledger.

### Changed
- **General chats are friendlier.** "Global Chat" is now "General" across desktop and
  iOS, with a less technical welcome and softer chrome for non-coding conversations.
- **App-icon picker (macOS).** The Monoline and WWDC26 variants now render the correct
  canonical artwork in the Dock, and the picker thumbnails are colour-managed
  (8-bit sRGB).
- **Branded macOS installer.** The DMG now uses a branded background from the brand kit.

### Fixed
- **The transcript stays where you put it.** Scrolling up is no longer overridden by an
  auto-snap to the bottom on new activity, and the streaming tail no longer flashes;
  the side-chat panel gained the same scroll-up release (desktop).
- **No more dropped characters.** Several per-keystroke text fields — ensemble role and
  goal/brief, the roster preset name, audit budgets and the guest model id — no longer
  drop or jumble characters as you type.
- **More reliable iOS ↔ Mac pairing.** Dev and release builds use distinct serve ports,
  dead relay doors are dropped from the QR code, and off-LAN pairing tries the right
  door first with clearer, actionable error copy.
- **iOS polish.** Smoother streaming with a reliable "Show more", a fixed transcript
  scroll crash on ensemble send, and no more false "Mac busy or asleep" banner when a
  request times out while still connected.
- **Empty "New Chat" tabs are tidied up.** Never-used New Chat tombstones are reaped
  automatically (drafts, ensembles and workflow-compose are left alone).
- **Grok remembers across turns.** Grok's default transport re-injects cross-turn
  context instead of starting fresh each turn.
- **Composer glass polish.** The native-glass composer renders its exact shell variant
  (no stale replica) with a smooth top edge.

## 1.6.1 - 2026-06-23

### Added
- **Composer drafts persist.** Typed-but-unsent prompt text now survives switching
  threads, backgrounding, and even an app restart — on both desktop and iOS. Send
  clears the draft, and a prompt you already sent never resurrects.
- **Per-participant context meter.** The composer's context donut is now clickable,
  opening a context-meter popover re-based on the honest current context. In
  ensembles the donut follows the focused participant and live-ticks whichever one
  is actively running (desktop + iOS).
- **iOS — rich completion notifications.** When a task finishes, the phone shows a
  banner with the first line of the final message and a coloured "N files · +A −B"
  diff summary, composed on-device over the encrypted link (the push itself stays
  content-free).
- **iOS — inline @mention tinting in the composer.** @mentions now tint by provider
  hue as you type, matching the transcript, via a new text-view-backed composer
  input — in single-provider and guest chats too.
- **Provider API rate limits in Model Usage.** A reference table of each provider's
  current API rate metadata.

### Changed
- **Smoother streaming.** A matched type-out reveal (closer to the Codex / Claude
  cadence) plus render-coalescing and scroll / markdown perf retunes make streamed
  replies read more evenly on desktop and iOS.
- **Kimi defaults to K2.7 Code.**
- **Grok native goals.** Grok can drive the Goal panel through its own slash
  commands.
- **Codex long-context.** Honest long-context estimates, with the long-context
  configuration passed through to the agent.

### Fixed
- **Ensemble completion alerts fire once.** A finished ensemble round now sends a
  single "task complete" notification instead of one per participant.
- **Multiview diff stats are per-pane.** Each pane's "files changed / diff" in the
  Create-PR row now reflects that pane's own workspace, not the focused one.
- **Live usage meters.** Codex usage now reads live from disk (no more meters
  frozen at 0%), and a stale usage window no longer shows a false 0%.
- **iOS transcript stability.** Fixed a crash when scrolling during an ensemble
  send, reduced flicker during streaming, and kept the @mention hue while typing
  after a mention.

## 1.6.0 - 2026-06-22

### Added
- **Multiview — split the workbench into up to four live panes.** Open several
  chats side by side over one shared environment, each with its own composer,
  agent aura, and ambient FX; drag the dividers to resize. Welcome and split
  states render correctly per pane.
- **Workflows are now a first-class chat type.** A dedicated Workflows welcome
  screen with its own compose controls and a "Run as ensemble" toggle where the
  ensemble feature gate is enabled, plus a Workflows sidebar section. Scheduled
  workflows recover after a restart, and workflows project to paired iOS devices
  (read/view).
- **Reusable notification area.** The welcome and first-launch screens now host
  a dismissable notice card for significant changes — provider deprecations, new
  models or providers, shipped features — rotating through more than one with the
  same swipe effect as the activity heatmaps.
- **Hover labels on the composer footer icons.** Screen Watch, Goal, Copy
  transcript, and Multiview reveal a frosted glass label on hover/focus, so the
  icon-only buttons are discoverable without taking up resting space.
- **Grok Composer 2.5 Fast.** Grok now runs on Composer 2.5 Fast — the new
  default — selectable from the Grok model picker.
- **iOS — offline Demo Mode.** Explore the companion with no paired Mac:
  interactive sample replies, a populated Inspector (Changes / Agents / Side
  chats / Notes / Usage), an offline File Editor + Diff Studio, and demo chat
  creation. Also new on iOS: a Workflows section, an iPad sidebar that opens
  collapsed to headers, a live "still working" anchor during tool calls, and
  attached images that render inline in the transcript.
- **Ollama local models — per-chat tool tiers, run profiles, and Cloud
  sign-in.** A two-pane composer picker sets how much tool access a local model
  gets per chat (a four-step tier ladder, Tier 4 = full provider parity) with an
  independent run profile; the run path and mid-run tool gates honor the per-chat
  tier, and the chip warns when a Tier 4 selection can't take effect. You can
  also sign in to Ollama's hosted Cloud models from the provider login terminal,
  Settings → Providers, and onboarding.
- **TaskWraith Canvas — a live web surface agents can see and drive.** A
  read-only preview surface, then ref-based click / fill and Set-of-Mark
  annotation, plus signed-elevated evaluation behind a dedicated, non-grantable
  approval lockbox. Open it as a floating window or an embedded multiview pane
  from the composer; read-only Canvas previews project to paired iPhones with
  close / reload controls, and an iOS-simulator device driver can drive a
  screenshot-only canvas.
- **Multi-host iOS pairing.** One iPhone can pair with several Macs or PCs —
  per-host session management and per-OS host glyphs — plus optional Tailscale
  tailnet discovery and on-demand pairing.
- **Settings → Roster, plus a dedicated iOS Roster page.** A full
  ensemble-roster preset manager: per-participant provider, model, reasoning,
  permissions, role, brief, and turn order, with orchestration controls and
  cross-device preset load / save / delete on iOS.
- **App icon switcher.** Choose between Regular, WWDC26, Monoline, and Glass app
  icons from Settings → Appearance (the desktop dock) and the iOS Settings sheet.
- **Proposed plans.** An agent can propose a structured plan that appears as an
  inline card you approve before it implements — and the approve / respond /
  dismiss round-trip works from paired iPhones too.
- **Cross-thread recall.** An agent can resolve a vague reference to a past run
  on another thread and read how far it got, through gated tools: zero-prompt for
  your own workspace, gated across workspaces, allowlist-scoped from a phone, and
  with verifiable citations.
- **Inline transcript media.** Provider image outputs, tool image results, and
  workspace images embedded in markdown become first-class transcript media with
  full-size preview, and project to iOS.
- **Run and launch targets.** Discover and run VS Code shell tasks and Xcode run
  targets, and open previews straight from launch-output URLs, with launch
  attempts surfaced in the run rail.
- **Inline questions + an iOS first-launch guide.** `ask_user_question` renders
  as an inline transcript card on desktop and iOS, and a new iOS first-launch
  guide mirrors the desktop onboarding with live provider readiness from your Mac.

### Changed
- **Gemini has been retired.** Google ended the Gemini CLI sign-in, so Gemini is
  no longer available for new runs and is removed from new-run and picker
  surfaces, the sidebar usage meter, Settings (Providers + MCP), onboarding, and
  new iOS run surfaces. Existing Gemini chats, labels/glyphs, transcripts, and
  usage history are preserved; new chats default to Claude with sticky last-used.
- **Grok and Cursor are full first-class providers.** The experimental
  eligibility gate has been removed — both are accepted everywhere like the other
  providers, write-capable and gated by approval mode.
- **Cleaner startup.** The window stays masked until the renderer finishes
  hydrating, so there is no flash of half-loaded UI.
- **Readability + performance polish.** Slash / mention / context / palette
  popovers are frosted; welcome heading sizing is consistent across composer
  shells; the iOS Pair-with-Mac screen was rebuilt in TaskWraith chrome;
  re-visiting a chat reuses its cached hydrated state to skip a redundant render;
  and iOS streaming auto-follow is smoother.
- **Automatic provider failover (opt-in).** When a provider hits a quota wall,
  TaskWraith can pause and reroute the run to a healthy provider without
  escalating its permissions. Off by default, behind a setting.
- **Settings, reorganised.** A more discoverable settings sidebar and a safety
  overview on desktop and iOS, and the Tailscale remote-access helper now sits
  above Bridge networking on the pairing screen.

### Fixed
- **iOS image attachments work end to end.** Attached photos now reach the agent
  and render inline in the transcript, and the encoder no longer silently drops a
  dense image.
- **iOS Grok composer keeps focus.** The composer shell no longer flips its
  layout — losing the tucked tabs and focus — when you tap in.
- **Multiview robustness.** Per-pane composer parity and routing, a
  reasoning-options crash, focused-state leaking into resting panes, per-pane
  Screen Watch gating, and welcome cards/dashboard hiding when the view is split.
- **iOS polish.** The roster editor no longer dismisses when you focus the role
  field, the jump-to-latest pill stops sticking, long markdown list/quote items
  wrap instead of truncating, and demo mode can't contaminate a real paired
  session.
- **iOS no longer gets stuck "running" after backgrounding.** A run that finishes
  while the app is backgrounded now reconciles its streaming state on reconnect,
  so the thread leaves the running state and shows the final message.
- **Read-only Grok seats can't hard-cancel a run.** The Composer `Shell` tool is
  denied on read-only seats instead of cancelling the whole run.
- **Clearer activity diffs.** Inline tool-diff add / delete lines read as red and
  green through theme-aware tokens.

## 1.5.9 - 2026-06-18

### Changed
- **iOS composer collapses to one line when idle.** On the phone, when the
  composer isn't focused (keyboard down) it now collapses to a single-line
  input + model pill + send — the diff/changes rows, participant roster, queued
  prompts, and telemetry rail all tuck away and reappear when you tap in.

### Fixed
- **Ensemble "Task Complete" summary covers the whole round.** The end-of-round
  completion card now sums tokens and cost across every participant, unions
  their file changes, and spans the full round duration — previously it showed
  only the last participant's numbers, which badly understated long continuous
  ensembles.

## 1.5.8 - 2026-06-18

### Changed
- **Turn-based guest participation.** When a chat has a guest agent, the primary
  agent now answers first and the guest replies on its turn — so each sees and
  can build on the other's response, instead of both answering at once. Tag
  `@guest` to address the guest alone, or `@parent` for the host alone. Phone-
  originated turns now drive the guest too (through the Mac bridge), not just
  desktop turns.

### Fixed
- **iOS companion.** Removing a guest now reliably clears the composer chip
  (bigger tap target plus an explicit "Remove guest" item in the guest picker);
  each composer shell collapses to a single line when you're not typing;
  changing a setting on the phone no longer drops your active chat, sidebar, or
  open Settings sheet; and creating a new global/ensemble chat surfaces why it
  was declined instead of spinning indefinitely.

## 1.5.7 - 2026-06-18

### Added
- **Guided Tailscale device linking.** Settings → Devices now walks you through
  connecting a phone over Tailscale — a setup signposting section plus guided
  auth-key linking — so remote access is reachable without hand-editing config.
  The standalone APNs credentials section is hidden; push wake is handled through
  the relay path.
- **Plan import.** Bring an external plan into a chat and TaskWraith makes it
  actionable: it grounds `@`-file mentions against your workspace, rewrites
  defensive/uncertain phrasing into concrete steps, and estimates the execution
  risk before anything runs — with intake-safety guards on the way in.
- **iOS companion — composer shells, welcome dashboard, transcript font.** The
  phone composer now matches the Mac's per-shell *layout* (Codex, Claude, Cursor,
  Grok, Gemini and the rest — rows, tucked tabs, rims, corner radii); the New
  Chat welcome screen shows a compact usage dashboard mirrored live from the Mac;
  and Settings adds a Transcript response-font picker (Avenir Next, SF Pro, Serif,
  Monospaced, Rounded).
- **Richer iOS transcripts.** Tool calls render with their family glyphs and true
  tool names on the phone, matching the desktop transcript.

### Fixed
- **Run permission posture.** Hardened how a run's permissions are resolved so it
  can't end up with a broader posture than intended.
- **Welcome dashboard robustness.** The Mac→remote dashboard broadcast no longer
  swallows errors silently, numeric fields are rounded before they cross the wire,
  and remote clients decode partial payloads defensively.
- **Sidebar typography.** Thread titles and section headers were unified and
  tightened, and thread labels normalize cleanly under the shell themes.
- **Windows CI.** Transcript path redaction and update-service test determinism
  were fixed so the Windows build stays green.

The macOS build is notarized + stapled (universal). Windows (unsigned) and Linux
(AppImage/deb) installers are attached by CI.

## 1.5.6 - 2026-06-17

### Added
- **iOS composer shells.** The phone composer now mirrors the Mac's composer
  style — Default, Codex, Claude, Cursor, Grok, Gemini, Kimi, Modular, Terminal,
  Ticket Stub, Satellite, Obsidian, and Alabaster — following the Mac by default,
  with a per-device override in Settings → Composer Shell.
- **Multiview panes.** Open several chats side by side in a pane grid, with a
  composer layout picker, per-pane focus/close, and simultaneous streaming.

### Fixed
- **Ensemble runaway loop.** A participant that kept choosing "continue" with the
  same restatement (no new work) could loop for dozens of rounds. It now stops
  after a couple of identical continuations and reports no progress, asking the
  model to finish, report blocked, or take a genuinely different next step.
- **iOS Ensemble Stop.** Stop on an Ensemble chat now cancels the whole round
  (halting the rotation) and cancels each participant by its true provider —
  matching the desktop. Previously it only cancelled the current participant, so
  the round kept advancing and you had to tap Stop repeatedly.
- **Repeated messages on iOS.** Consecutive identical assistant restatements are
  now collapsed into a single bubble on the phone (and every remote client),
  matching how the desktop transcript already reads.
- **Local (Ollama) models re-reading the same file.** A local model that re-issued
  an identical read (same file, unchanged contents) would burn its whole local
  tool budget before it ever edited, then fail at the cap. Identical repeat calls
  now get a short redirect to act on what they already have, leaving budget to
  actually make the edits.
- **Ensemble Work Session: stuck-file halt.** If a participant fails to edit the
  same file several times in a row with no successful write in between, the Work
  Session now halts with a clear status instead of burning rounds retrying an
  unfixable file — fix the file or give guidance, then start a new round.

The macOS build is notarized + stapled (universal). Windows (unsigned) and Linux
(AppImage/deb) installers are attached by CI.

## 1.5.5 - 2026-06-16

### Fixed
- **iOS Ensemble participant editing.** Each participant chip can now set its own
  approval mode (Plan / Default / Full workspace) and reasoning/thinking (effort
  for Codex/Claude/Grok, extended thinking for Kimi, plus fast mode) from the
  phone — previously only provider / model / role were editable there.
- **iOS Ensemble reorder.** The Earlier / Later (and drag) participant reorder no
  longer snaps back: the new speaking order is confirmed to the phone immediately
  and held until the desktop echoes it.
- **Ensemble reasoning on concurrent rounds.** Per-participant reasoning / thinking
  is now applied on concurrent (fan-out) rounds too, not only serial turns.

The macOS build is notarized + stapled (universal). Windows (unsigned) and Linux
(AppImage/deb) installers are attached by CI.

## 1.5.4 - 2026-06-16

### Fixed
- **Local (Ollama) models can now edit files.** Choosing a file-edit tier (or
  Tier 4 / Provider parity) reliably grants edit tools: the per-workspace parity
  grant is matched tolerant of path form, and when Tier 4 is selected but the
  current workspace isn't granted you now get a clear in-run warning instead of a
  silent read-only downgrade. Small local models are also prompted to make
  focused edits directly at edit tiers rather than only drafting a plan to hand
  off.
- **iOS "always running" sub-thread tombstones.** Deleting a parent chat now
  cascades to its sub-threads / side-chats (and already-orphaned ones are
  reaped), so the phone no longer shows long-dead sub-threads stuck as "running."
- **iOS thread count.** Archived chats are hidden from the phone's lists and
  counts, matching the desktop sidebar.

### Changed
- **iOS notification banners.** Warnings, errors and confirmations now use a
  translucent glass style with a top-lit rim and consistently appear pinned at
  the top of the screen instead of crowding the composer.
- **iOS Ensemble @-mentions.** Tagging a single participant scopes the round to
  them, so the "Participants reachable" card narrows to the tagged participant
  (desktop parity).
- **iOS usage inspector.** Added 90-day daily token bar charts (TaskWraith Tokens
  and External Tokens) below the activity heatmaps.
- **Discord context.** Runs can be supplied with Discord channel context,
  including across ensemble participants.

The macOS build is notarized + stapled (universal). Windows (unsigned) and Linux
(AppImage/deb) installers are attached by CI.

## 1.5.3 - 2026-06-16

### Fixed
- **iOS Stop button.** Stop now targets the live run the moment streaming starts
  (rather than the throttled projection), and works on global chats and
  experimental providers — the desktop honors the cancel for those paths too.
- **iOS composer state.** Opening an existing thread re-syncs the composer's
  model / provider / reasoning picker to that thread instead of leaking the
  previously open thread's selection, and the new-chat welcome screen now follows
  the chosen provider's theme as you change it.
- **iOS new-chat workspace + global handling.** New chats can switch their
  workspace before the first message (the desktop relocates the still-empty
  draft), and global chats are classified by an authoritative scope check so the
  plan-mode pin and read-only treatment stay correct.
- **Stray draft cleanup.** Opening "New Chat" on iPhone and backing out no longer
  leaves a phantom "New Chat" row in the desktop sidebar or the phone list —
  unstarted drafts are hidden from chat lists and reaped on reconnect, including
  ones that had picked up a goal or pin.
- **iOS transcript crash.** Hardened the run-completion transcript scroll on
  iPhone to avoid a UICollectionView abort seen over cellular.

### Changed
- **App Store export compliance.** The iOS companion declares standard, exempt
  encryption (`ITSAppUsesNonExemptEncryption = NO`) per App Store Connect's
  questionnaire result, and TestFlight export entitlements are verified in the
  archive path.

## 1.5.2 - 2026-06-15

### Added
- **iOS companion TestFlight path.** The companion now has a release archive
  script, app lifecycle readiness coverage, lifted remote-pairing flags, APNs
  wake/reconnect hardening, and foreground/background reconnect fixes for paired
  iPhone and iPad sessions.
- **Remote composer parity.** iOS receives projected secondary workspace rows,
  richer mobile thread metadata, queue prompt projection/pumping, inspector
  affordances, and compact telemetry when the available rail is narrow.
- **Remote file and transcript parity.** iOS can lazily browse workspace files,
  load older transcript chunks, receive transcript chunks in ACK responses, and
  show run file changes in task-complete summaries.
- **Usage activity depth.** Model Usage gained stacked and 90-day activity
  heatmaps so provider activity history is easier to scan.

### Changed
- **Runtime prompt compaction.** The TaskWraith runtime preamble is more compact
  and carries an explicit persisted version so future prompt upgrades can be
  reasoned about and migrated deliberately.
- **iOS material polish.** Remote welcome, inspector, status banners, composer
  shell rows, run controls, streaming tails, and activity panels now track the
  desktop visual model more closely.
- **Desktop transcript polish.** Returned sub-thread cards, Diff/guest state,
  roster preset saving, composer shell themes, notes dock, activity viewport
  masks, and run-summary copy labelling were tightened.

### Fixed
- **Remote security and allowlists.** Explicit workspace capabilities now persist,
  secondary workspace writes require write allowlist coverage, APNs attention
  payloads are sanitized, stale bridge state is cleaned up, and workspace file
  list envelopes are capped more narrowly.
- **iOS E2EE and lifecycle safety.** Cipher validation rejects invalid sequence
  and key inputs predictably, and wake/reconnect paths avoid stale or slow bridge
  state after notification-driven launches.
- **Provider and cost projections.** Cache-aware cost estimates now propagate to
  iOS, Grok empty ACP tool failures surface correctly, welcome activity panels
  keep cycling, and iOS preserves composer model/workspace state across empty
  drafts.

## 1.5.1 - 2026-06-13

### Added
- **Persistent thread goals.** Use `/goal <objective>` or the new composer goal
  control to set an active objective and stopping condition for a chat. Codex can
  mirror goals into native app-server goal state when supported; other providers
  use TaskWraith-steered goal context plus `goal_read`, `goal_update`,
  `goal_complete`, and `goal_blocked` tools.
- **Audit orchestration.** `/audit` now runs a policy-aware multi-agent review
  pipeline with provider-selection controls, live progress cards, dismissible
  completion banners, structured findings/verdicts, and safer failure reporting.
- **Expanded local-model roster.** Ollama support now includes Qwen 3.6, Granite,
  MiniCPM-V, and Nemotron presets alongside the existing GPT-OSS, Gemma, and Qwen
  profiles.
- **Provider failover controls.** Providers can be paused so queued or recovered
  work can move to an available fallback rather than silently retrying a blocked
  runtime.

### Changed
- **GPT-OSS/Ollama coding harness.** Local models get richer model metadata,
  profile-aware context budgets, native-first tool calling, safer loop stopping
  around goal lifecycle tools, workspace symbols/git context, and stricter
  explore-before-edit/read-before-edit discipline.
- **Provider and transcript parity.** Cursor, Grok, Ollama, and native provider
  tool results now render with closer markdown/tool-card parity in the transcript
  pane, including expanded tool-result prose.
- **Model usage accounting.** Cursor IDE Composer activity, external provider
  usage, cached-token pricing, manual refresh, and local Ollama RAM samples are
  surfaced in the model-usage table with clearer provider rows.
- **Brand and onboarding polish.** The first-launch sheet and workspace mastheads
  use the theme-aware monoline ghost mark, clearer provider availability LEDs, and
  updated copy for the current seven-provider surface.

### Fixed
- **Audit runs no longer assume Claude.** Audit provider selection respects the
  configured provider set instead of spawning a provider the user may not have.
- **Audit banners are dismissible.** Completed audit run cards can be hidden after
  the user has seen the result.
- **Cursor cache stat handling.** External Cursor usage scans use the correct file
  stat helper and avoid crashing the cache prewarm path.
- **Light-mode sky reveal.** Weather/sky effects retain the visible sky band
  without washing out the transcript reading surface.

## 1.5.0 - 2026-06-13

### Added
- **iOS companion source publication.** The Swift package, iOS app target, assets,
  privacy manifest, entitlements, and interop fixtures are now tracked while
  signing-local state, build outputs, and provisioning material remain ignored.
- **Remote companion hardening.** Paired iPhone/iPad sessions gained richer
  transcript fidelity, reconnect recovery, Git workflow actions, global-chat
  visibility, and stricter bridge routing under the encrypted transport.
- **Release hardening.** macOS update-feed validation now checks artifact sha512
  and size parity, Swift bridge tests run in the macOS release path, and CI has
  unsigned Windows and Linux artifact jobs.

### Changed
- **Public provider/MCP docs.** The docs now describe the seven first-class
  providers and distinguish full brokered MCP providers from narrower Cursor,
  Grok, and Ollama tool surfaces.
- **Startup and persistence performance.** Chat hydration, workspace-change
  caching, and persisted raw-event compaction reduce launch and selection cost on
  large workspaces.

### Security
- **Public build boundary maintained.** Remote/iOS user-facing surfaces remain
  gated behind `IOS_REMOTE_TRUE` while TestFlight/export-compliance work
  continues.
- **Package hygiene.** The shipped app excludes internal docs, local-only folders,
  scripts, tests, and signing material from the production bundle.

## 1.4.8 — 2026-06-11

### Added
- **Remote companion preview groundwork.** Paired iPhone/iPad sessions now carry
  richer thread snapshots, run telemetry, tool transcript segments, model usage
  quota windows, thread notes, pinned messages, side-chat creation, guest
  participants, queued prompt controls, and ensemble roster/steering updates over
  the encrypted bridge.
- **Multi-device remote pairing.** The Devices panel can list multiple paired iOS
  devices and the workspace sidebar remote button now glows when a paired device
  is actively connected.
- **iOS shell parity polish.** The companion app picked up desktop-aligned
  thinking indicators, 90-day heatmap variants, manual swipe control for heatmap
  cycling, iPad rotation support, and a frosted composer shell pass.
- **Usage dashboard bridge data.** Usage rollups and model-quota windows now flow
  into the remote bridge feed, with refreshed heatmap labels.

### Changed
- **Remote run continuity.** Phone-initiated continuations now inherit the chat's
  model/session context, preserve interleaved tool transcripts, keep readable MCP
  tool details, and use the canonical compatibility vocabulary.
- **Remote reliability.** Bridge resume/reconnect paths were hardened against
  stale replay epochs, empty post-restart snapshots, heartbeat gaps, terminal run
  status races, and attachment-temp cleanup issues.
- **Weather FX fog polish.** Fog/mist weather effects now use warped, blurred
  bands for a softer naturalistic atmosphere.

### Fixed
- **Remote provider inheritance.** Gemini auth/session state, Ollama memory, and
  ensemble steering now preserve the expected provider context across phone runs.
- **Remote payload size.** Diff envelopes and thread projections were tightened
  so large workspaces stay within relay frame limits.

## 1.4.7 — 2026-06-10

### Added
- **Flag-gated iOS remote transport foundation.** End-to-end encrypted pairing,
  trusted reconnect, in-process relay hosting, ghost-branded QR pairing, remote
  workspace allowlists, live transcript streaming, model catalogs, ensemble roster
  editing, and image attachment transport landed behind the iOS remote build flag.
- **Ensemble identity polish.** Same-provider participants now carry
  model-labelled identities and can be addressed by role or model name.

### Changed
- **Ollama harness routing.** Small-talk prompts skip the heavier agentic scaffold,
  while `todo_write` routes to its real MCP handler.
- **Composer and sky polish.** Schedule/runtime rows, composer accessory rails, sky
  clouds, and the sun/moon orb received visual refinement.

## 1.4.6 — 2026-06-09

### Added
- **Local Servers.** TaskWraith detects workspace dev servers (Vite, Next, etc.),
  surfaces them in a new sidebar section and Settings tab, and maps legacy AGBench
  workspace labels to TaskWraith.
- **iOS transport foundation (T0–T3).** `taskwraith-e2ee-v1` protocol library +
  relay, Mac transport client, identity store, pairing flow, and the bridge
  runtime piping projections/actions through the encrypted channel — proven
  end-to-end by a fake-iPhone harness (pair → snapshot → actions → drop/resume).
  Dark by default; enabled via `IOS_REMOTE_TRUE=1` + `TASKWRAITH_RELAY_URL`.
- **Claude Fable 5.** Anthropic's new frontier tier (above Opus) joins the Claude
  model/reasoning picker as Claude Fable 5 and Claude Fable 5 1M, with context
  meter, usage rates, and ensemble support. Claude usage rates refreshed to the
  published pricing (Opus $5/$25, Haiku $1/$5, no 1M premium).
- **WWDC26 ghost mascot.** App chrome uses the new chrome PNG with cyan glow;
  source artwork lives under `design-assets/`.
- **Sidebar section reorder.** Drag to rearrange hierarchy sections (Pinned,
  Recents, Workspaces, etc.).

### Changed
- **Composer above-bar polish across every shell.** Canonical element order
  restored (git → files/diff → action); secondary rows group trailing controls as
  Push/Review → access icon → revoke; Cursor secondary workspaces render as
  detached satellite pills; Codex/Grok primary rows centre the files cluster;
  Claude ensemble above-rows use detached pills; native composer glass bezel and
  textarea chrome refined; attach/send glyphs doubled in size.
- **Transcript chrome.** Corner pills restyled as rim highlights; glass-pill
  dividers, hover glow, and title spacing polished; Agent Aura / Living Workspace
  background glows neutralised; top-edge chroma wash and side glows removed.

### Fixed
- **Above-bar trailing order regressions.** Push/Review no longer sits after the
  read/write and ✕ icons on secondary workspace rows.
- **Codex secondary workspace divider.** Hairline appears above the 2nd workspace
  row only (not duplicated on roster presets).
- **Grok roster presets divider.** Upper divider removed per shell design.

## 1.4.5 — 2026-06-09

### Added
- **Ollama explore-before-edit harness.** Local models are gated through an
  explore→read→edit workflow with a `todo_write` scaffold, replacing the narrower
  retrieval-first read policy — fewer blind edits, more grounded local runs.
- **Grok tucked above-row shell.** The Grok composer adopts the Codex-style
  tucked-tab stack (a narrower row nested under the composer lip), with matching
  Settings and First-Launch previews and a "Create PR" preview label.

### Changed
- **Accurate Ollama token chips in ensembles.** Per-participant token spend now
  reads the same canonical totals (snake_case + camelCase reconciled) as usage
  recording and the composer tally.

### Fixed
- **Ensemble participant chips collapsing to slivers.** On every composer shell,
  ensembles of 1–6 participants rendered as ~2px status-dot slivers (and, in an
  earlier state, overlapping labels). Chips now size to their content — short
  roles stay compact, long roles truncate with an ellipsis — and the Work Session
  band no longer crushes the strip. Root cause was inline-size containment on the
  chip zeroing its content-derived width in the single-row flex layout.

## 1.4.4 — 2026-06-09

### Added
- **Ollama context engineering.** Per-model conversation budgets (Qwen 4B vs 9B vs
  GPT-OSS vs Gemma differ), a pre-run workspace index (shallow file tree + symbol
  sample), retrieval-first read policy (search before unfamiliar `read_file`),
  heuristic tool-result summarization, and rolling working-memory compaction after
  every few tool turns so locals keep generation headroom.
- **Ollama session continuity.** Pruned tool trajectory (calls + summaries, not full
  file bodies) persists on each chat and re-injects on the next solo run.
- **GPT-OSS tool protocol hardening.** Compact tool schemas, one-tool-per-turn,
  JSON response mode when supported, and few-shot search→read→patch trajectories in
  the system prompt.
- **Mid-run Ollama tier guidance.** When a tool exceeds the active tier, the run
  surfaces a provider warning with the tier to raise instead of failing opaquely.
- **Ensemble Ollama reliability.** Dynamic transcript budgeting, degenerate-turn
  retry, compact tool schemas in ensemble runs, composer context-pressure hints,
  and concurrent fan-out lanes on by default with serial fallback when disabled.
- **One-click update pill.** When a new build is available, a rim-highlight pill
  appears at the top of the workspaces sidebar — click to download, then restart
  to install. The app also polls for updates every 15 minutes in the background.

### Changed
- **Concurrent ensemble lanes** default on (`TASKWRAITH_CONCURRENT_LANES` opt-out).
- **Ensemble thinking state** survives chat switches without losing the in-flight
  indicator.

### Fixed
- **Renderer crash** when reading Ollama feature gates from `process.env` in the
  packaged app (gates now come from the native capability snapshot).
- **Ensemble Ollama brand spoofing** no longer clobbers other participants' labels
  or merges provider assistant deltas into the orchestrator-owned transcript.

## 1.4.3 — 2026-06-09

### Added
- **Saved ensemble roster presets** with a recall picker above the work-in-folder row.
- **Role presets and goal brief** in the participant overflow popover; **apply-to-all**
  permissions control.
- **External-path grant preflight** in the composer when panelists need signed grants
  for connected workspaces (Ollama excluded from dispatch issuance).
- **Paste image/file attachments** into the composer; **Open in Finder** on the
  workspace picker; dismiss workspaces from the welcome folder row.
- **Composer context menu** and model-usage resize grip; dedicated git status counts
  row in the PR popover.

### Changed
- **Liquid-glass native composer** outer frame; agent aura fans to detached above-bar
  rows; Satellite shell flattens roster + ensemble rows; Cursor above-rows match the
  merged frosted instrument frame.
- **Continuous ensemble mode** max handoff cap raised to 100; welcome ensemble
  hierarchy provider icons enlarged.

### Fixed
- **Composer glass/aura** polish on default and native instrument shells (neutral
  smoked glass, no blue wash on above-bar stacks).
- **IPC schema** for `shell:reveal-in-finder`; external-path grant preflight types
  and `deferPersist` preload contract.

## 1.4.2 — 2026-06-08

### Added
- **Goal-step checklist (`todo_write`).** Universal TaskWraith MCP tool with a
  compact transcript card and live-viewport pin (Ollama from approved-edits tier).
- **Ollama local-model tuning.** Per-model preflight, model-aware prompts and
  compaction, tier suggestions, struggle handoff, health chip, and scout→implementer
  workflow hint.

### Changed
- **Live activity viewport** gains overflow-aware top/bottom edge fades and fixed
  jump/expand overlays while streaming.

## 1.4.1 — 2026-06-08

### Added
- **Native Ollama tool-calling** via Ollama's `tools` API (structured `tool_calls`
  instead of JSON-in-prose only).
- **Cursor-style live activity viewport** for in-flight tool calls and thinking
  (Settings → Density; on by default).
- **Cross-provider reasoning notes** — Ollama, Gemini API, and Claude stream
  internal reasoning as first-class thinking activity.

### Fixed
- **GPT-OSS empty replies** when answers land in the reasoning channel only.
- **Tool-intent stubs** and **malformed tool JSON** (tolerant re-parse + re-prompt
  instead of leaking protocol blobs to the user).
- **Multi-step Ollama tool loops** — raised cap and clearer follow-up prompting.

## 1.4.0 — 2026-06-08

### Added
- **Live web access for local models.** Local Ollama runs can now use `web_search`
  and `web_fetch`. Search returns ranked result links; fetch downloads a page and
  returns its readable text (HTML markup, scripts, and styles are stripped) so the
  model can summarize real content instead of raw markup.
- **Tiered tool control for Ollama.** A new tool-control tier ladder — read-only →
  approved edits → approved shell → provider parity — lets you decide how much
  local models can do, with a Settings surface and per-workspace grants. Read-only
  stays the default.
- **Qwen 3.5 (9B) preset.** Added to the curated local model line-up alongside the
  existing Qwen, Gemma, and GPT OSS presets.
- **Discord channel context.** Attach a scoped, run-only snapshot of the most recent
  messages from a Discord channel (you choose how many) as untrusted model context
  for collaborative projects. Reads only — agents don't post back.
- **Link favicons.** Links in prompts and transcripts now show a favicon for quicker
  visual scanning.
- **Local memory telemetry in the composer.** Ollama threads show the latest
  llama-server peak RAM (e.g. `17.0GB`) in the composer telemetry row, in place of
  the cost estimate shown for metered cloud providers.

### Fixed
- **GPT OSS replies again.** Harmony-format models (e.g. GPT OSS) that stream their
  answer into the reasoning channel no longer finish with an empty response;
  TaskWraith now surfaces that text when the normal content channel is empty.
- **Readable `web_fetch` results.** Page HTML is converted to readable text before
  truncation, so local models receive prose within the character budget rather than
  a head full of CSS and scripts. Non-HTML responses (JSON, plain text) pass through
  unchanged.
- **Local models recognize their web tools.** The Ollama system prompt now states
  explicitly that `web_search`/`web_fetch` reach the live internet, so models stop
  denying the capability and use the search → fetch → summarize flow.
- **Ollama run-card model labels.** Corrected the model label shown on local run
  cards.

### Changed
- **Ollama approval previews tightened.** Clearer previews before approved-edit and
  approved-shell tool calls.
- **Provider parity scoped to workspace grants.** Ollama provider-parity tooling is
  gated behind explicit per-workspace grants.

### Security
- **Local web + workspace tools stay policy-gated.** `web_search`/`web_fetch` are
  read-only and routed through TaskWraith policy; workspace tools keep every path
  inside the active workspace, and write/shell tiers require explicit approval.

## 1.3.0 — 2026-06-08

### Added
- **Local Ollama provider.** TaskWraith can talk to a local Ollama runtime without
  a cloud API key, starting with curated presets for Qwen 3 4B, Gemma 4 12B, and
  GPT OSS 20B. Local transcript labels present those models by their upstream
  family — Qwen, Google/Gemma, and OpenAI/GPT OSS — while the runtime remains
  the local Ollama provider.
- **Read-only tools for Ollama.** Local Ollama runs can now request
  TaskWraith-controlled workspace list/read/search tools. Shell and write tools
  are not exposed, and every path stays scoped to the active workspace.
- **Channel gateway foundation.** The dev/debug-only message bridge has been
  renamed into a broader Channels architecture with a canonical inbound event,
  adapter descriptors, route targets for existing chats / new provider threads /
  workspace default agents / ensembles / approval-status endpoints, and portable
  commands such as `approve`, `deny`, `status`, `pause`, `resume`, `show diff`,
  `open thread`, `send file`, and provider handoff.
- **Free/BYO channel adapters.** Telegram bot long polling, Matrix room polling,
  and local web/PWA chat now sit beside the experimental local iMessage adapter.
  Signal CLI, email, Discord, and Slack are represented as planned adapters so
  future work plugs into the same contract rather than a one-off bridge.
- **Guest participants in normal chats.** Standard chats can now invite linked
  provider guests for focused side replies, with deduped side-chat chips and
  clearer linked-chat sidecar presentation.
- **Pinned messages dock.** Important transcript messages can be pinned and
  reviewed from a dedicated dock/settings surface.

### Changed
- **Side-chat UX polish.** Linked sidecars have cleaner copy, sizing, and run
  presentation so they read as attached work surfaces rather than stray chats.
- **Faster chat hydration.** Thread selection and chat-list IPC are now hydrated
  after paint, reducing initial selection stalls on heavier workspaces.
- **First-launch local-model signposting.** Onboarding now includes a minimal
  Ollama card and install hint without treating local models like a cloud sign-in
  provider.
- **Seven-provider channel routing.** Channel handoff and provider-target choices
  cover Codex, Claude, Gemini, Kimi, Grok, Cursor, and local Ollama.

### Security
- **Channel gateway remains gated.** Channel user surfaces and bridge runtime are
  available only in development/debug builds while the remote message pipeline
  settles, preserving the 1.2.1 public-build boundary.
- **Channel-originated work stays policy-gated.** Inbound channel messages go
  through contact allow-lists, workspace allow-lists, provider policy, approval
  ledger handling, file/path checks, rate limits, and audit logging before a run
  can start or a file can be sent back.

## 1.2.1 — 2026-06-07

### Changed
- **Messages bridge is dev/debug-only.** The local Messages.app / iMessage relay is
  hidden from public release builds and its IPC surface returns a clear disabled
  status outside development or the packaged TaskWraith Debug app.
- **Cleaner transcript chrome.** The workspace toggle now owns the left pill, the
  remaining transcript controls sit in one right-side pill, and Diff Studio /
  File Editor / Pop-Out Chat are grouped behind one picker.
- **Help controls use real glyphs.** The changelog, onboarding, and bug-report
  controls now use info-circle, question-circle, and shield-warning symbols.

### Fixed
- **Dropdown pickers render again.** The condensed glass pill no longer clips the
  popout-tools picker or side-chat layout menu.
- **Changelog freshness.** Old downloaded-update notes no longer override the
  running app's bundled release notes after the app has moved past that version.

## 1.2.0 — 2026-06-07

### Added
- **First-class side chats.** Side chats are now durable and flexible — pop one out
  into its own window, dock it back, or promote it to a top-level chat, with draft
  text, scroll position, and presentation preserved across the move.
- **Approval-mode elevation failsafe.** Raising a chat's permission mode now asks
  first: a one-time notice per workspace when you enable Default Approval, and a
  sterner "only on disposable VMs or recoverable devices" confirm each time you
  enable Full Workspace Access. The acknowledgement is recorded in the approval ledger.
- **Smarter ensemble defaults.** A new ensemble seeds one participant per provider
  you actually have set up, instead of all six.
- **Windows testing installer.** Unsigned x64 + arm64 Windows installers are now
  produced on demand and attached to releases — a testing channel ahead of signed builds.

### Changed
- **Clearer MCP surface.** Settings → MCP no longer mislabels working providers:
  Cursor shows its TaskWraith web bridge (web_fetch + web_search) and Grok shows
  provider-managed status, replacing the misleading "unsupported / not installed" tags.
- **Tidier README.** Screenshots are now a grid instead of a long stack.

### Fixed
- **Grok no longer dead-ends.** A write/Default-mode Grok turn that reached for a
  shell command (e.g. `mkdir`) could cancel with no output; Grok is now steered to the
  Write/Edit tools and to adapt rather than end the turn when a tool is refused.
- **Windows CI launch smoke** now passes on the windows-latest runner.
- Side-chat composer, above-row, and presentation-lifecycle fixes.

### Security
- **Untrusted-input hardening.** External iMessage content is wrapped and replayed to
  the model as untrusted; IPC validation, shell-open policy, and prompt-composition
  sanitizers were extended for the new message surface.

## 1.1.0 — 2026-06-06

### Added
- **First-class workspace rows.** Every connected workspace row (primary and
  additional) now carries the full action set — Review changes → Push → Create PR
  + commit — scoped to that folder, with a compact read/edit access icon.
- **Adjustable ensemble history.** A shared-history budget slider (5K–500K
  characters) in the ensemble Turn picker controls how much recent panel context
  each agent sees.
- **Ensemble mode picker.** Turn / Continuous / Work Session moved into a
  hierarchical picker (matching the model picker); Fan-out (parallel read-only
  lanes) stays a separate toggle beside it.
- **Resizable side chat.** The side-chat split view resizes by drag or keyboard,
  with per-chat width persistence.
- **Top-center pop-out controls.** Diff Studio / File Editor / pop-out chat sit
  in their own glass pill row; the corner control pills are larger (1.6×) with a
  blurred backdrop.

### Changed
- **Provider-tinted composer pills.** Gemini (blue) and Kimi (olive) controls now
  carry the provider highlight; the native and other shells drop the redundant
  outer pill chrome for a cleaner row.
- **More transcript breathing room.** The clearance below the last message scales
  with the live composer height, so dense ensemble / multi-workspace composers
  never overlap the most recent message.

### Fixed
- **Grok no longer stalls.** A write-enabled Grok turn that ran a shell command
  was cancelling with no output; write mode now allows Bash, and read-only turns
  get a steer so they answer directly instead of dead-ending.
- **Ensemble context.** The shared transcript now keeps the most-recent messages
  when it has to truncate, and the default turn count is consistent.
- **Live usage meters.** Sidebar and settings usage totals refresh the moment a
  run finishes instead of going stale.
- **Kimi light mode + changelog rendering polish.**

## 1.0.75 — 2026-06-05

### Fixed
- **No more runaway background processes.** Fixed a loop where leftover Gemini
  MCP bridge registrations from before the rename could relaunch the app
  repeatedly in the background. Bridge detection is now rename-proof, and stale
  registrations are cleaned up automatically on launch.

## 1.0.74 — 2026-06-05

### Changed
- **AGBench is now TaskWraith.** The app is renamed end to end — name, icon,
  bundle ID, updater, MCP services, and docs. Your existing data carries over
  automatically on first launch: chats, settings, usage history, and saved state
  are migrated from the previous install.
- **Git-grounded workspace status.** The composer's "N files changed / +A −B"
  now reflects the real working tree via Git instead of tallying a thread's tool
  activity — so it drops to 0 the moment you commit, the way Codex/Claude desktop
  apps behave. Applies to the primary workspace and every additional workspace.
- **One clean row per additional workspace.** Adding a secondary/tertiary folder
  now shows a single native row per folder (with a combined read/edit access
  pill) instead of one row per participating provider, and revoking removes the
  whole folder in a click.

### Added
- **Push from the composer.** The Review changes menu now has a Push step
  between commit and Create PR — publish a new branch (sets its upstream) or push
  ahead commits in a click — and the primary action button names the real next
  step (Review changes → Push → Create PR) from live Git state.
- **Branch state at a glance.** The composer branch chip shows a
  merge / rebase / cherry-pick badge and a conflict count when the tree is
  mid-operation, and the CI check rollup is now clickable (opens the PR or the
  failing run).

### Fixed
- **Delegation cards read as one agent.** Sub-agent cards and the inspector
  timeline are tinted with each agent's identity colour as a full rim, replacing
  the left-edge accent sliver.
- **Composer above-rows.** The Git-status row stacks correctly in every composer
  shell (including Codex's tucked-tab layout), and a transcript render crash from
  a missing snapshot field is fixed.

## 1.0.73 — 2026-06-04

### Added
- **Commit & open PRs from the composer** — the Review changes menu now drives a
  real Git flow: see your branch and changed files, write a message and Stage all
  & Commit, then Create PR once the branch is pushed and ready (gated on a live
  readiness check).
- **Clearer Ensemble cost & escalation** — each round shows real vs. estimated
  spend (a latency line + an "API-equivalent" badge on estimates), and the
  orchestrator's escalation signals surface inline, so a multi-seat panel's value
  is visible rather than guessed.
- **Optional "why?" on approvals** — attach a short intent note when you allow or
  deny an agent action; it's recorded in the approval ledger.

### Changed
- **Refined native composer** — the TaskWraith shell is now a cohesive console: the
  input sits in a framed module (solid black/white outer frame, theme-tone inner
  panel + provider rim, full-bleed and squared), the Ensemble / Create-PR / Steer
  rows match the same solid frame, and the permission picker sits up front beside
  the + button. Onboarding and Settings → Appearance previews reflect the new look.
- **Deleting a chat tidies up after itself** — removing a chat now also clears
  that chat's own run-forensic artifacts (and only those).

### Fixed
- **Kimi tool calls** — repeated calls coalesce into a single inline card that
  updates in place (instead of stacking) and now show the target filename,
  matching the other providers.
- **Bug Report Refinement** — tidied how the in-app reporter shows your workspace
  (now a friendly `~/…` label).
- Onboarding, empty states, the welcome dashboard, provider accent colours, and
  the Diff Studio / File Editor light themes all got polish + readability fixes.

## 1.0.72 — 2026-06-04

### Security
- **Read-only means read-only** — choosing "Plan / read-only" for a run is now a
  hard floor that nothing downstream can quietly loosen: full-auto can't override
  it, delegated sub-agents inherit it, and uncategorised tools fail closed. The
  posture is enforced identically across Gemini, Claude, Kimi, Codex, and Grok.
- **Grok joins the read-only contract** — Grok now runs under read-only through a
  scoped, fail-closed tool bridge that exposes only non-mutating (read / list /
  search) tools, with the host denying any write the agent attempts.

### Added
- **Read-only that's still useful** — read-only agents keep full read parity
  (list / read / search) without prompts, and the run surface explains what a
  read-only seat can and can't do, by tool class.
- **Welcome dashboard controls** — a compact dashboard mode plus Settings →
  Appearance controls for heatmap layout, with swipeable heatmap cycles and
  animated transitions.
- **Clearer onboarding** — consistent provider hover states, all six usage
  meters, and a one-line role flow.
- **Bug reports as pre-filled GitHub issues** — the in-app reporter now opens a
  ready-to-file issue.

### Changed
- **Denied writes stay honest** — a blocked or rejected edit is no longer counted
  or shown as an applied file change; it reads "attempted (not applied)", and a
  read-only agent is told its posture up front so a refused write doesn't
  dead-end the turn.
- **Steadier transcript** — the Ensemble transcript no longer fights your
  scroll-up, agent questions resolve exactly once, and a message that anchors an
  open prompt can't be deleted out from under it.
- **Sturdier Codex** — a bad `config.toml` is surfaced clearly, a newer Codex CLI
  warns instead of breaking silently, and resuming no longer trips on a
  non-standard thread id; retired models were removed from the picker.
- **Settings & sidebar persistence** — general settings and sidebar section
  collapse now persist across launches.

### Fixed
- Ensemble: the "interrupted checkpoint" prompt no longer re-fires on every
  message, and stale checkpoint cards were removed from the composer.
- The MCP tool broker is confirmed up before a Claude run starts, with start
  failures surfaced instead of silently degrading.

## 1.0.71 — 2026-06-02

### Added
- **Onboarding clarity** — the first-launch sheet now shows copyable official
  install commands for each provider CLI, a sign-in primer (terminal-login vs
  in-app OAuth vs API key), a status-dot legend, and new "You stay in control"
  and "Track your usage & spend" sections. The Ensemble preview shows all six
  providers.
- **"Out of usage" provider state** — a provider that's signed in but at 100% of
  its quota now says so (with the reset time) instead of looking broken, in both
  onboarding and Settings.

### Changed
- **Confirmations** — deleting a chat or removing a workspace now asks first.
- **Failed runs explain themselves** — the completion card shows the exit code
  and last error instead of a bare "check Raw Events"; cancelled runs read "Run
  cancelled" rather than "code 130".
- **Consistent copy feedback** — copy buttons across the transcript, diffs,
  inspector, and media paths now confirm with "Copied".
- **Clearer states** — empty states for the Raw Events tab and the model picker,
  a loading state for the Gemini MCP test, and a mention popover that no longer
  runs off-screen.
- **Truer copy & numbers** — corrected file-mention syntax (`-@`), a shell-aware
  permission-colour hint, humanised byte sizes, pluralised counts, and clearer
  Gemini profile labels.
- **Ensemble** — Work Session presets show which is active, completed sessions
  reopen as "Restart" instead of silently restarting, finished strips no longer
  say "0s left", and failed participants offer an inline retry.

### Accessibility
- Search is focusable with ⌘F; sidebar menus support arrow-key navigation; the
  onboarding sheet now traps focus and focuses its first control on open.

## 1.0.7 — 2026-06-01

### Added
- **Ensemble shared blackboard** — a compact, scoped scratchpad of agreed facts,
  decisions, open risks, and do-not-repeat notes that panel participants consume
  instead of re-deriving context every round.
- **Session checkpoints** — long-running ensemble sessions snapshot their state
  and offer a transparent, timestamped resume after a crash or restart (it asks,
  it never silently auto-resumes).
- **Sticky screen-watch attachments** — a chat remembers the window it was
  watching and offers one-tap "Resume watching" when you return to it.
- **Solo scratchpad recall** — solo chats carry forward a recap of the last
  substantive turn and its tool trace across pause/resume.

### Changed
- **Long-transcript performance** — the transcript is virtualized, so dense
  ensemble threads stay smooth as they grow.
- **Usage & cost tracking** — ensemble runs now count toward the cumulative
  wall-clock and the activity heatmaps, and ensemble chats appear in Recents.
- **Ensemble coordination** — heuristics detect stuck / looping / disagreement
  patterns and *recommend* extending a round or synthesizing (never autonomous).
- More robust content-filter retries and provider rate-refresh fallbacks.

### Accessibility
- Status and indicator animations honour the in-app reduce-motion setting; the
  keyboard focus ring on message actions was restored.

### Security
- Signed and notarized macOS build.

## 1.0.6 — 2026-05-31

### Added
- **Two new first-class providers** — Grok (xAI agent CLI) and Cursor
  (Composer 2.5 CLI) — wired through composer shells, model pickers, sign-in
  flows, usage meters, and sub-thread inference alongside the existing lineup.
- **Scheduled pause / resume** — participants (and solo chats) can pause
  mid-run and resume later, with state surviving an app restart.
- **Workspace popout windows** — Diff Studio and the file editor in their own
  native windows with live refresh.
- **Currency layer** — display-currency picker, live FX refresh, and
  per-provider rate handling for cost estimates.
- Activity heatmaps (workspace / app / external), sub-agent identicons,
  provider glyphs, and an app-shell stats toolbar.

### Changed
- Welcome, dashboard, and composer polish; light-mode contrast fixes; a
  consolidated participant-health header for ensemble panels.

> 1.0.5 was an internal development milestone whose work rolled into 1.0.6.

## 1.0.4 — 2026-05-27

### Added
- **Ensemble mode** — run several coding agents as a panel with a chair /
  synthesizer, structured rounds, and per-participant review.
- **Work sessions** — grouped, resumable units of agent work.

## 1.0.3

### Added
- Local-first desktop workbench for running and reviewing coding-agent CLIs
  across multiple providers: workspace trust state, approval modes, activity
  timelines, command-output and status review, and run-scoped diff review.

---

See [`README.md`](README.md) for setup and [`SAFETY.md`](SAFETY.md) /
[`SECURITY.md`](SECURITY.md) for the safety and security boundaries.
