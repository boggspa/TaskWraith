# Authorized site sessions - persistent web logins the user owns

**Status: design, 2026-08-29. Slices P1-P5 in Section 12.**
**Scope: AppDrive Tier 2 only** - the any-origin Canvas Browser. Nothing here
changes Tier 3 (Simulator), Tier 4 (managed native) or Tier 5.

This document is the re-proposal that [design.md](design.md) Section 13 Q3 asks
for. The Tier 1 loopback fence was never built, 1.9.5 shipped any-origin
browsing over a durable signed-in profile, and Section 0a is explicit that the
fence must be re-proposed against the shipped product rather than restored. What
follows is that re-proposal. It is narrower than the original fence and it is
load-bearing in a way the original was not: the original protected a surface
that had no cookies, this one protects a surface that has all of them.

---

## 1. What already shipped, so nobody rebuilds it

| Capability | Where |
|---|---|
| Durable browser profile - cookies and sign-ins survive restart | `CANVAS_BROWSER_PARTITION` = `persist:taskwraith-canvas-browser-v1`, [CanvasBrowserProfile.ts](../../src/main/canvas/CanvasBrowserProfile.ts) |
| Session hardening on that profile - all permissions denied, downloads blocked, per-surface request routing | `installSessionHooks`, same file |
| Agent actuation verbs under an expiring exact lease | `canvas_click` / `fill` / `key` / `scroll` / `hover` / `select` / `wait_for`, `AppDriveLeaseRegistry` |
| Secret-field refusal - `fill` hard-refuses password, `autocomplete=*password*`, `one-time-code`, `[data-tw-secret]` | [CanvasWebDriver.ts](../../src/main/canvas/CanvasWebDriver.ts) - S6 |
| Screenshot secret protection - refuse on focused secret field, paint over visible ones | same file, `capturePage` path |
| Snapshot value redaction for password and hidden inputs | same file |
| Consequential-verb confirmation on destructive and financial labels | [CanvasConsequentialTarget.ts](../../src/main/canvas/CanvasConsequentialTarget.ts) - S12 |
| Human-only sign-in window with a validated capture and a wiped ephemeral partition | [WebSessionBrowser.ts](../../src/main/providers/WebSessionBrowser.ts) - provider usage import |
| A safeStorage envelope with fail-closed behaviour when encryption is unavailable | [ExtensionSecretStore.ts](../../src/main/ExtensionSecretStore.ts) |

**Persistent web login is therefore already half-shipped, by accident.** A user
who signs in inside the Canvas Browser today stays signed in across restarts.
What is missing is not persistence. It is everything around it.

---

## 2. The gap - and it is not the password

### 2.1 Ambient authority. This is the real defect.

One shared cookie jar, and navigation carries no host allowlist. The comment at
the navigation gate states it plainly: the same open gate and DNS policy as the
initial load, http(s) only, with a fixed link-local and cloud-metadata deny rule
**and no host allowlist**.

So an agent leased to update a ticket on an internal Jira is, at the same
moment, carrying the user's bank cookies, their email cookies and every other
session in that jar, and one `canvas_navigate` call away from any of them. It
does not need to escape the sandbox. The sandbox is working exactly as designed;
the authority inside it is simply too wide.

Today the only things between a mis-aimed agent and that navigation are the
permission posture and the consequential-verb check - and that check's own
header says it is a speed bump against agent judgment errors, explicitly **not
an authorization boundary**, because the label comes from the page.

Section 10.7 already names judgment error as the dominant residual. Ambient
cross-site authority is what turns a judgment error into an account compromise.

### 2.2 There is no management surface

Sign-ins accumulate invisibly. The user cannot see what they are signed into,
cannot tell a live session from an expired one, and cannot remove one. The only
control is `clearBrowserProfile`, surfaced as a single "Clear browsing data..."
action in the Canvas dock - all or nothing, every site at once.

### 2.3 There is no re-authentication route

When a session expires mid-task the agent lands on a login wall it is
structurally forbidden to fill in (S6, correctly). Nothing routes the human back
in. The agent has no vocabulary for "this needs you" and no place to say it, so
it retries, or improvises, or reports a task as failed for a reason the user
could have fixed in ten seconds.

---

## 3. Invariants

Three, in dependency order. I1 is the security work; I2 is what makes the
product claim honest; I3 is what makes it usable without widening I1.

### I1 - One partition per site

Each authorized site gets `persist:taskwraith-site-<siteId>`. A canvas surface
binds to exactly one site at construction and can **never** be re-bound.
Cross-origin **document** navigation inside a bound surface is refused with a
do-not-retry reason.

The fence covers **main-frame** document navigation. Sub-resource requests are
not origin-checked: third-party CDNs, fonts and analytics are how the web works,
and an allowlist that breaks every real site gets turned off, which protects
nothing. **Sub-FRAME documents fall on the sub-resource side of that cut** -
fencing them would break payment iframes, SSO frames and captchas. That is a
deliberate exemption with a real consequence, recorded in Section 11.4.

`extraOrigins` exists for the identity-provider hop - a site whose sign-in
bounces through `accounts.google.com` or an SSO host needs those origins in its
own fence or the flow cannot complete. Each entry is user-visible in the site
row, because it is a widening of that site's fence.

The unbound legacy surface keeps today's behaviour on the shared partition. P1
must not regress the existing Canvas Browser.

### I2 - A password never exists in the process

Sign-in happens in a human-only `BrowserWindow` that no canvas driver can
resolve. This is the same **structural** argument as Section 6a - not a policy
check, not a refusal list, but the absence of any path from a `canvas_*` verb,
a lease, or a `driverId` to that `webContents`. Section 6a's rule ("do not add a
driver that resolves TaskWraith's own webContents as a target") extends here
verbatim, and P2 owes it the same style of invariant test.

The S6 secret-field refusal stays exactly as it is. It becomes
defence-in-depth rather than the primary control, which is the right role for a
policy check that has to run inside a page the site controls.

### I3 - Authorization is per-site, revocable, and named up front

A site carries `agentAccess`, set by the user:

| Value | Meaning |
|---|---|
| `off` | Default for a newly added site. The session exists for the human; no agent verb may bind to it. |
| `read` | Agents may open and snapshot. `click` / `fill` / `key` / `scroll` / `select` are refused. |
| `act` | Agents may actuate, still requiring the ordinary AppDrive lease and the Section 7 consequential check. |

**`off` is the default, and promotion is a separate deliberate action.** The
alternative - "added means drivable" - re-creates the ambient-authority problem
inside a smaller boundary, and the user's act of signing in is consent to *be
signed in*, not consent to be acted for.

A run's lease names its site set. Binding a surface to a site outside that set
fails closed, before any navigation.

---

## 4. Model

`src/shared/webSiteLogin.ts`. A catalogue entry, shaped like
`ProjectReference`, holding **no secret**:

```ts
export interface WebSiteLogin {
  id: string                       // opaque, stable; names the partition
  label: string                    // user-editable display name
  origin: string                   // scheme + host + optional port
  extraOrigins: string[]           // IdP / SSO hops, user-visible
  agentAccess: 'off' | 'read' | 'act'
  status: 'never' | 'signed-in' | 'expired' | 'unknown'
  createdAt: string
  lastSignedInAt?: string
  lastVerifiedAt?: string
  verify?: { url: string; okSelector: string }   // optional liveness probe
}
```

The partition is derived, never stored: `persist:taskwraith-site-${id}`. Storing
it would let a corrupt or hand-edited catalogue point two sites at one jar,
which is precisely the state I1 exists to prevent.

**Scope is app-global, not per-Project.** A login is an account, not a project
asset - the same reasoning that makes the Canvas Browser profile app-wide. A
Project may later *reference* a login (a `ProjectReferenceKind` of `'login'` is
the natural join), but the catalogue is owned by main and lives once.

---

## 5. Where the secret actually lives

In Chromium's own cookie store for that partition, which is encrypted at rest
under an OS-provided key: the login keychain on macOS, DPAPI on Windows. On
Linux it depends on the available secret-service backend - the same caveat
`safeStorage` already carries throughout this codebase, and it should be stated
in the same words rather than a new set.

This is the honest version of "keychain logins", and it is a stronger claim than
a hand-rolled vault would be, because **there is no plaintext credential
anywhere in TaskWraith's address space to leak** - not in a store, not in an
envelope, not in an IPC payload, not in a tool result.

The catalogue itself stays plaintext JSON alongside the other main-owned
catalogues. A site list is not a secret, and encrypting it would cost
readability during incident review for no threat it actually answers.

---

## 6. Sign-in flow

1. User presses **Sign in** on a site row.
2. Main opens a plain `BrowserWindow` on that site's **persistent** partition.
   This is where it differs from [WebSessionBrowser.ts](../../src/main/providers/WebSessionBrowser.ts),
   which deliberately uses an in-memory partition and captures the cookie header
   out. Here there is no capture at all.
3. A TaskWraith-owned header states the origin being signed into and that
   TaskWraith does not read what is typed. The origin shown is the one the fence
   will enforce, so the consent and the mechanism describe the same thing.
4. The user authenticates. Their password manager - iCloud Keychain, 1Password,
   whatever the OS offers a real browser surface - works here normally. That is
   the intended answer to "what about my password": TaskWraith does not need one.
5. Window closes. Main runs the optional liveness probe. The row flips to
   `signed-in` with `lastSignedInAt` stamped.

No polling, no cookie export, no renderer projection of anything but status.

---

## 7. Agent binding

- `CanvasWebDriver` takes a `siteId` at construction; the `CanvasBrowserProfile`
  it receives is the site's, not the shared one. The profile partition is
  already a constructor argument, so this is a threading change, not a new
  mechanism.
- The navigation gate grows a per-surface origin check for document
  navigations, refusing with a do-not-retry reason. Sub-resources are untouched
  (I1).
- Two new tools, deliberately minimal:
  - `web_login_list` - the catalogue projection. Id, label, origin,
    `agentAccess`, status. **Never a cookie, never a header, never a secret.**
  - `web_login_open` - open a canvas bound to that site. Refuses a site whose
    `agentAccess` is `off` or one outside the run's lease set.
- `agentAccess: 'read'` refuses every actuation verb at the executor, not at the
  driver, so the refusal is uniform across every verb rather than re-derived per
  driver method.
- Tool placement: the highest minted generation is **v17** (plus its `-mesh`
  twin), and existing generations are immutable, pinned by exact-membership and
  sha256 tests. The established route for a tool that does not need to be
  directly advertised is a **FULL-only placement** - add the name to
  `FULL_MCP_ADVERTISE_TOOLS` and nothing else, since every hidden generation is
  a `filter()` off FULL and therefore picks it up on every generation ever
  shipped. That also keeps the two new schemas out of `*_DIRECT_TOOLS`, where
  they would count against the 40,000-char fresh-gateway transport budget.
  Re-pinning the affected length + hash assertions is part of the slice.

---

## 8. Re-authentication

When a bound surface lands on a login wall, the driver refuses with a distinct
`signin_required` reason, do-not-retry. Main raises a user-facing prompt naming
the site with a **Sign in** action, and the task pauses rather than flailing.

This is the piece that makes the feature usable unattended, and it is the honest
consequence of choosing option A in Section 10: TaskWraith cannot fix an expired
session by itself, so it must be excellent at telling the user, in the moment,
exactly which site needs them.

Detecting a login wall is a heuristic - a redirect to an origin in
`extraOrigins`, or the liveness probe failing. It is allowed to be a heuristic
because its only consequence is asking the user a question. It must never be
allowed to become an authorization input.

---

## 9. Product surface - the Work tab

A `logins` right-dock panel, in the Work group beside References, modelled on
`ProjectReferencesDockPanel`.

A row shows label, origin, status pill, and the access selector
(Off / Read only / Can act), with three actions:

- **Sign in** - Section 6.
- **Sign out** - clear that partition's cookies, keep the catalogue row.
- **Forget site** - `clearStorageData()` on the partition, **then** drop the row.
  That order is load-bearing and the store cannot enforce it, because the store
  owns no profile. The id is retired on removal as the backstop: a re-added site
  gets a fresh id and therefore a fresh partition, so getting the order wrong
  costs one orphaned directory on disk instead of handing a re-added site a
  cookie jar the user believes they deleted.

The panel is also where a `signin_required` prompt lands, so the notification
and the fix are one click apart.

---

## 10. Deliberately not built

Recorded so the next session does not re-litigate it.

**A - session only. CHOSEN.** TaskWraith stores no credential. Meets the
product goal; makes "agents cannot see or type passwords" structural rather than
policy; matches the existing connector doctrine ("the app never stores or sees
connector credentials"). Cost: on expiry, TaskWraith can only tell the user.

**B - password vault plus main-process autofill. HELD.** Would give truly
unattended re-auth. Costs: TaskWraith becomes a password manager, acquiring form
heuristics, a 2FA story, phishing-origin binding, an at-rest secret worth
stealing, and a new "main types a password into a page" code path that must be
provably unreachable from every tool - a considerable proof obligation against a
capability nothing else in this codebase has. Revisit only with evidence about
how often real sessions actually expire, and only after A is in production.

**C - delegate to the user's password manager. THE STATED UX ANSWER.** The
sign-in window is a real browser surface, so OS and extension autofill work
there. Zero storage. Free once A ships. This is what the product should say when
a user asks where their password goes.

**A per-site "always allow" that outlives the lease.** Not proposed. The lease
is the mechanism that makes actuation bounded in time and steps; `agentAccess`
widens *which* sites a lease may cover, never how long one lasts.

---

## 11. Residual risk

Added to design.md Section 10, not replacing it.

1. **In-origin destructive actions remain possible** on an authorized site. I1
   removes the cross-site case; within the fence, Section 7 remains the only
   mitigation and remains a speed bump, not a boundary.
2. **The fence trusts the catalogue.** A site row the user misread when adding -
   a lookalike origin - is authorized as written. Origin display in the row must
   be the exact punycode-safe origin, not a prettified one.
3. **`extraOrigins` is a real widening.** An SSO host added for convenience
   grants document navigation to that host. It is user-visible for this reason.
4. **A cross-origin SUB-FRAME renders inside a bound surface.** The fence is
   main-frame only (I1), so a page on an authorized origin can embed any
   origin it likes. Two consequences worth stating rather than discovering:
   the embedded document loads in the site's partition, and its rendered
   pixels reach an agent through `canvas_screenshot`, which captures
   cross-origin frames that page script could never read. Bounded by the
   per-site split (the jar holds one site's cookies, not every site's) and by
   actuation being main-frame only. `will-frame-navigate` is the hook that
   would close it if evidence says it should be closed.
5. **Login-wall detection is heuristic** (Section 8). Bounded to asking a
   question; must never gate authorization.
6. **Sub-resources are unfenced by design** (I1). A compromised third-party
   script inside an authorized origin remains inside that origin's authority.
   This is the ordinary web threat model and is not made worse here. Note that
   a service worker an authorized origin registered persists in that site's
   partition and can keep making unfenced cross-origin sub-resource fetches
   after the canvas closes - the exemption outlives the surface.
7. **Sign-out is best-effort against server-side sessions.** Clearing the
   partition ends the client's session; a token the site already minted
   elsewhere is beyond TaskWraith's reach.

---

## 12. Slice plan

Each slice is independently shippable with gates green. Stage by explicit path
and commit in slices - no `stash`, no bulk `git add`; concurrent sessions share
this index.

| # | Slice | Notes |
|---|---|---|
| **P0** | This document, plus the design.md pointers | Closes Section 13 Q3 as re-proposed rather than moot. |
| **P1** | Per-site partitions and the navigation fence | The security spine, no UI. `webSiteLogin` model, main-owned catalogue store, `siteId` threaded through the canvas stack, document-navigation origin fence. Unbound surfaces keep today's behaviour. |
| **P2** | Human-only sign-in window | Plus the Section 6a-style invariant test: no canvas executor can resolve its `webContents`. |
| **P3** | Work-tab panel and IPC | Handler module, main registration, preload runtime and types, renderer IPC policy, dock tab, panel. |
| **P4** | Agent surface | `web_login_list` and `web_login_open`; a **new** gateway profile generation; auto-allow and profile membership; approval preview; regenerated tool docs. |
| **P5** | Re-authentication signalling and the liveness probe | `signin_required`, the Work-tab prompt, optional per-site probe. |

P1 is the bulk of the work and the only slice that carries regression risk to
the shipped Canvas Browser.

---

## 13. Open questions

1. Should a site be promotable to `act` at all for a class of high-value
   origins - banking, and email-as-identity in particular, since email is the
   password-reset root for everything else? A hard "never `act`" class is
   cheap to add and impossible to add later without breaking someone's
   workflow.
2. Should `web_login_list` be visible to a run whose lease names no sites?
   Listing is not acting, but it is reconnaissance, and it tells a model which
   accounts exist.
3. ~~Does the fence belong at the navigation gate only, or also at
   `CanvasBrowserProfile.shouldBlock` for the main-frame request?~~
   **ANSWERED in P1: both.** They fail differently and neither covers the
   other - `will-navigate` is the only hook that can refuse an in-page cause
   before Chromium commits it, and the request layer is the only one that sees
   a 30x hop at all, because a redirect never fires `will-navigate`. The
   request-layer block records the refused URL so the cancelled load reports
   the named refusal instead of a bare `ERR_BLOCKED_BY_CLIENT`.
