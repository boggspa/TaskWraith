# TaskWraith Privacy Notice

**Effective:** 26 July 2026

**Version:** 1.1

## The short version

TaskWraith is local-first. Your chats, workspace history, approvals, settings,
and run records are stored on your device by default. The prompts, files, and
tool context needed for a run still go to the AI provider or local runtime you
choose.

Electron builds configured with a first-party activity endpoint enable
privacy-minimised product observation by default. You can switch it off at any
time in **Settings → Safety & Privacy** without losing any feature. TaskWraith
uses these reports and platform-provided aggregate analytics only to understand
adoption, see an approximate current live-app count, prioritise supported
platforms, and verify release and update health. Product observation does not
include the content of your work and is not used for advertising or individual
profiling.

## Who is responsible

TaskWraith is maintained by Chris Izatt, who is the controller for optional
TaskWraith activity-reporting data. For a confidential privacy or security
question, use the repository's
[private reporting form](https://github.com/boggspa/TaskWraith/security/advisories/new).
If that form is unavailable, open a
[minimal public issue](https://github.com/boggspa/TaskWraith/issues/new) asking
for a private contact path; do not include personal data or workspace content
in the issue.

GitHub, Apple, AI providers, and other services you choose process information
under their own terms and privacy notices.

## Product observation

### Platform-provided aggregates

The maintainer may use:

- GitHub release-asset counters to distinguish update-manifest requests from
  installer and payload downloads by supported platform;
- GitHub repository statistics such as stars, forks, views, and clones; and
- App Store Connect reports for downloads, installations, deletions, sessions,
  active devices, and the share of eligible devices that opted into Apple's
  usage reporting.

These sources have different counting rules. Release-asset downloads are
cumulative request counters, not unique people or completed installations.
GitHub traffic can include automation. Apple's usage measures cover eligible
users who agreed to share analytics and may be estimated, suppressed, or
privacy-adjusted. TaskWraith does not relabel any of these figures as unique
active users.

### TaskWraith activity reporting

Electron builds with a first-party endpoint enable **Share privacy-minimised
activity and live presence** by default. The control is always available under
**Settings → Safety & Privacy**, and an explicit choice to switch it off
persists across restarts and updates. Turning it off does not limit any core
TaskWraith feature.

If a build has no TaskWraith activity endpoint configured, it sends no activity
data even when the stored preference is on. The preference can still be
switched off in that build.

#### Daily check-in

While the setting is on, TaskWraith sends at most one daily check-in per UTC
day from that installation. The check-in has one fixed schema:

| Field                   | Example      | Why it is included                             |
| ----------------------- | ------------ | ---------------------------------------------- |
| Schema                  | `1`          | Interpret the fixed report format              |
| Event                   | `app_active` | Count an activity check-in                     |
| UTC day                 | `2026-07-26` | Daily trends without a precise event timestamp |
| TaskWraith version      | `1.9.0`      | Understand release adoption                    |
| Operating-system family | `macos`      | Prioritise supported platforms                 |
| Processor family        | `arm64`      | Plan compatible builds                         |
| Release channel         | `stable`     | Separate stable and prerelease health          |

The daily check-in does not contain a stable, hashed, or rotating installation
identifier. It does not contain your name, account, advertising identifier,
precise operating-system version, location, provider or model choices, token
usage, prompts, conversations, thread metadata, workspace paths, filenames,
code, diffs, terminal output, credentials, or free-form properties.

Because there is no identifier, TaskWraith cannot reliably deduplicate
reinstalls, cloned environments, or reports from several installations. These
figures are therefore called **activity check-ins**, not daily, weekly, or
monthly active users.

#### Volatile live presence

While the setting is on and TaskWraith is running, the app also renews an
anonymous live-presence lease approximately once a minute. Its complete body is
`schema: 1`, `event: app_presence`, and a cryptographically random 128-bit lease
value. The value is generated in memory for the current app process and a
relaunch gets a different value. The live-presence body contains no version,
platform, time, user, account, installation identifier, or work content.

An approximate concurrent count cannot deduplicate successive renewals without
some temporary link. The receiver therefore holds each lease value and its
expiry only in volatile memory for 150 seconds. It does not write the value,
renewals, start or end times, duration, or a session record to disk. The
maintainer dashboard receives only the aggregate number of unexpired leases,
the time of that aggregate observation, and the expiry window; it cannot read
the lease values.

This gauge answers approximately **how many reporting-enabled TaskWraith app
processes are online now**, never who they are. Multiple app instances can count
separately, network loss can briefly undercount, and a closed or crashed app can
remain in the gauge until its lease expires. The gauge is not retained as a
session timeline.

You can turn the setting off at any time. TaskWraith then stops future
check-ins and renewals and attempts to retract its current volatile lease; if
that request cannot reach the receiver, the lease expires naturally. Turning
the setting off does not limit any core TaskWraith feature.

### Network metadata

Like any internet service, GitHub, Apple, the update host, and an optional
TaskWraith activity endpoint necessarily receive an IP address and basic
connection metadata while handling a request. An IP address is not included in
the TaskWraith activity-report body. The activity receiver does not place IP
addresses or User-Agent strings in its analytics database and is designed to
run without request-body or routine access logs.

TaskWraith does not use connection metadata to recognise installations, infer
location, or build a user profile. A hosting or security layer may temporarily
process limited network metadata to operate and protect the endpoint; its
configuration must not retain that metadata longer than 24 hours.

## Why this information is used

Product-observation information is used only to:

- understand whether people are finding and trying TaskWraith;
- prioritise operating systems and processor architectures;
- measure adoption of supported releases;
- identify broken release assets or update feeds;
- plan distribution capacity; and
- gauge whether continued maintenance and product work on the free,
  open-source project are useful.

It is not sold, rented, used for advertising, combined with data-broker
profiles, or used to make automated decisions about a person.

## Other TaskWraith data flows

- **AI providers and local runtimes.** A run sends the prompt and selected
  context to the provider or local runtime you choose. That provider's account,
  model, CLI or API terms apply.
- **Updates.** When update checks are enabled, the desktop app requests release
  metadata from GitHub. Downloading an update requests the selected release
  assets from GitHub.
- **iOS companion.** Paired task projections and actions travel over an
  end-to-end-encrypted connection. Relay and push infrastructure can see
  routing and status metadata, such as pair, device, thread/run, reason,
  timestamps, and aggregate added/deleted line counts, but not plaintext
  prompts, commands, file contents, diff contents, or model output.
- **Optional weather visuals.** When transcript sky weather effects are
  enabled, TaskWraith requests approximate location from `ipapi.co`, falling
  back to `ipwho.is`. It rounds the result to 0.1 degrees before requesting
  current conditions from Open-Meteo. Those services receive the request's IP
  address; no task, transcript, file, or workspace content is sent.
- **Optional integrations.** Features such as Discord context, Screen Watch,
  creative-app control, external MCP servers, and web or browser tools connect
  only when configured or invoked. Their visible setup and approval surfaces
  describe the relevant access, and the selected third party's terms apply.

## Storage and retention

- Local chats, run history, approvals, settings, pairing state, and usage
  records remain on your device until you delete them or apply TaskWraith's
  local retention controls.
- A valid activity report is aggregated immediately; the receiver does not keep
  a raw event table.
- Live-presence lease values exist only in receiver memory, expire after 150
  seconds without renewal, and are never written into the activity database or
  exposed to the maintainer dashboard.
- After a UTC day closes, activity cells with fewer than five check-ins are
  combined into one coarse daily bucket. Aggregate activity cells are retained
  for no more than 25 months.
- TaskWraith's private maintainer dashboard keeps collected GitHub and App Store
  aggregates for trend analysis. Source platforms apply their own retention
  rules to the data they provide.
- Any unavoidable activity-endpoint security log is limited to 24 hours.
  Backups containing activity aggregates must expire on the same schedule
  within 30 days.

## Legal basis, sharing, and transfers

Where a limited activity report or transient connection metadata constitutes
personal data, the maintainer relies on legitimate interests in understanding
adoption, maintaining compatible releases, operating the activity endpoint,
and deciding where continued work on the free, open-source project is useful.
That assessment is bounded by the fixed no-content schema, the absence of a
stable installation identifier, immediate aggregation, short retention,
RAM-only live leases, no advertising or profiling, and a prominent control that
stops future reporting without reducing app functionality.

TaskWraith's price and open-source licence are context for that maintenance
purpose; they do not remove privacy rights or themselves constitute consent.
You can object to future TaskWraith activity reporting at any time by switching
it off under **Settings → Safety & Privacy**.

Information may be processed by GitHub for repository hosting, releases, and
updates; Apple for App Store distribution and reports; the AI providers and
integrations you choose; and an infrastructure provider used to operate an
optional activity endpoint. These providers may process information outside
the United Kingdom using the safeguards described in their own privacy
documentation. TaskWraith does not add a general advertising analytics or
session-replay service under this notice.

## Your choices and rights

Depending on where you live, you may have rights to be informed, access,
correct, delete, restrict, or object to processing; to withdraw consent where a
separate processing activity relies on it; and to complain to a data-protection
authority. UK users can contact the
[Information Commissioner's Office](https://ico.org.uk/make-a-complaint/).

The in-app switch is the immediate way to object to and stop future TaskWraith
activity reports. It also retracts the current volatile live lease when the
receiver is reachable.

Because an activity check-in contains no installation or account identifier,
the maintainer will usually be unable to locate an earlier aggregate as
belonging to you. This deliberate limitation does not affect your ability to
stop future reporting by turning the setting off.

## Changes

TaskWraith will update this notice before materially expanding product
observation, including adding a linkable identifier, a new event category or
purpose, longer retention, or a new analytics recipient. A change that could
distinguish the same installation over time requires a fresh privacy review,
new disclosure, and consent where applicable; it will not be introduced as a
silent schema change.
