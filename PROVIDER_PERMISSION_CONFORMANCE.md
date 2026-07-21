# Provider permission-conformance canaries

TaskWraith separates hermetic pull-request checks from credentialed live provider
checks. Ordinary CI never invokes a provider binary, consumes a provider
credential, or treats a skipped live suite as a pass.

## Local entry points

- `npm run verify:provider-compatibility` performs bounded, non-mutating
  binary/version/help/auth probes and writes sanitized aggregate JSON and JUnit.
  `runtimeAvailable`, `reviewedSuiteAvailable`, and `executionPosture` are
  separate. Cursor's binary surfaces are probed in a fresh unauthenticated root;
  product Path-B managed runs are always-enabled with contained `--sandbox`
  argv (separate from this probe-only inventory path).
- `npm run verify:provider-permissions:live` runs the explicit reviewed-suite
  allowlist serially. Unknown binary/capability tuples may produce an
  `unattested_pass` report for human review; they are not release-qualified.
- `npm run validate:release:provider-permissions` runs the strict local check.
  Every required provider must be available, have an exact reviewed fingerprint,
  and execute every reviewed live assertion without skips. Signed
  release-artifact publication is gated separately on an exact-SHA successful
  protected run of this check.
- Set `TASKWRAITH_VALIDATE_PROVIDER_PERMISSIONS=1` to include that strict gate in
  the broader `npm run validate:release` pipeline on the provider-canary worker.

Live execution is never inferred from credentials being present. It requires the
explicit `--live` entry point, and the runner executes only files listed in
`REVIEWED_LIVE_TESTS` in `scripts/provider-containment-canary.cjs`. That allowlist
contains Kimi's reviewed ACP containment suite and Cursor's reviewed
native-sandbox Path-B suite. **Product admission for Cursor is Path-B
always-enabled** (contained argv on `runCursorProvider`); the live suite is
containment *evidence*, not the desktop spawn switch. Kimi desktop admission is
likewise always-enabled and structural (packaged builds included); while the
embedded reviewed roster stays empty, managed runs are labelled
`unattested-development`, and only a reviewed exact runtime tuple can mark them
`reviewed` or satisfy release attestation.
A `--live` Cursor run produces review evidence for the sandbox differential; it
is not required to flip a desktop availability gate.

## Protected worker workflow

`.github/workflows/provider-containment-canaries.yml` accepts only two
`repository_dispatch` event types:

- `provider-permission-qualification` produces review evidence for a candidate
  tuple.
- `provider-permission-release` requires an already reviewed exact tuple.

`repository_dispatch` keeps workflow code on the repository's default branch.
The workflow additionally verifies that the checkout is the exact current
`master` tip and gives release runs the deterministic title
`provider-permission-release @ <full SHA>`. The GitHub Environment named
`provider-containment-canaries` must be configured to:

1. allow deployments only from the protected default branch;
2. require the designated release/security reviewers, prevent self-review, and
   disallow administrator bypass of the protection rules; and
3. expose only the protected non-rotating Kimi API-key secret to the ephemeral
   GitHub-hosted `macos-15` job. OAuth refresh credentials are not supported on
   this fresh-home worker.

After verifying all of those external controls, set the repository Actions
variable `PROVIDER_CANARY_ENVIRONMENT_CONFIGURED=true` as the final commissioning
step. Until then, a separate hosted gate fails and the credentialed hosted
`macos-15` job is skipped; the workflow cannot produce an acceptable successful release
attestation. A final hosted completion gate also rejects a failed or skipped
credentialed job. Removing the variable decommissions the lane fail closed.

Do not move this workflow to a persistent/self-hosted runner or add
`workflow_dispatch`, `pull_request`, `push`, or scheduled triggers.

For signed release artifacts built from a `v*` tag, `.github/workflows/ci.yml`
uses `actions:read` to query completed runs of this workflow. Its attestation
parser requires a successful `repository_dispatch` release run with the exact
deterministic title, protected `master` head branch, and `head_sha` equal to the
checked-out (peeled, for annotated tags) artifact-source commit. The successful
run must also have completed no more than 24 hours before the release gate; a
missing, malformed, stale, or future completion timestamp is rejected. Run the
release canary immediately before creating the release tag. Both notarized macOS
and signed Windows jobs depend on that attestation. The explicitly named unsigned
Windows/Linux testing jobs have no release-write permission: they upload only
immutable, SHA/run-labelled Actions artifacts with short retention and are not
part of this gate.

GitHub can rerun a failed publisher without rerunning successful dependency
jobs. Each signed publisher therefore rechecks that both
`PROVIDER_CANARY_ENVIRONMENT_CONFIGURED` and
`RELEASE_TAG_PROTECTION_CONFIGURED` are still `true`, then repeats the exact-SHA
workflow-run query and 24-hour freshness verification immediately before any
release mutation. Decommissioning either external boundary invalidates a
publisher rerun even when its earlier dependency job was green.

Release-tag protection is a second external commissioning boundary. Configure a
repository tag ruleset for `v*` that restricts creation to the release authority,
rejects tag updates and deletion, and disallows administrator bypass. Enable
GitHub release immutability for future published releases. Only after verifying
both controls should an administrator set the repository Actions variable
`RELEASE_TAG_PROTECTION_CONFIGURED=true`. With that variable absent, the exact-SHA
attestation job fails and signed publishers cannot start. The macOS and Windows
publishers also fetch and peel the remote tag immediately before release creation
and again before asset upload, require it to equal the checked-out commit, and use
`gh release create --verify-tag`. These code checks fail closed but cannot remove
an administrator tag-move race on an externally mutable repository; the ruleset
and release-immutability settings are therefore part of the boundary, not
optional hardening.

## Fingerprint review

The qualification fingerprint manifest is intentionally empty until live reports
have been reviewed. Each accepted entry must match all of the following exactly:

- qualification scope (`acp-synthetic-cwd-gateway-v1` for Kimi;
  `cursor-native-sandbox-readonly-v1` for Cursor Path-B / native-sandbox
  posture);
- provider version;
- normalized capability fingerprint;
- binary SHA-256;
- operating-system platform; and
- CPU architecture.

Ranges and partial tuples are rejected. Any binary or advertised-capability
change returns the provider to `UNRECOGNIZED` and blocks strict release.

The Kimi scope covers its ACP synthetic-cwd production posture: no ACP client
filesystem capability, the exact nine-tool native deny wall, and workspace
access only through the authenticated per-run TaskWraith HTTP gateway.

Cursor's `cursor-native-sandbox-readonly-v1` scope covers its Path-B posture:
cursor-agent runs against the user's real `~/.cursor` login, contained by the
native OS sandbox (`--sandbox enabled`, Seatbelt). Read-only seats add a
read-only `--mode`; write-capable seats use Cursor's default write+shell mode
still sandboxed. Both production argv builders hard-pin sandbox enablement and
place an end-of-options `--` guard immediately before the prompt so a
flag-shaped prompt cannot re-widen tools or disable the sandbox. The reviewed
live suite proves the differential: with Write pre-approved, an in-workspace
write lands while a write to the user's HOME is sandbox-blocked for a normal
project workspace, and the contained argv the runtime actually spawns never
emits write-widening or sandbox-disabling flags. HONEST SCOPE (egress and
workspace-placement caveats): the sandbox is validated primarily as a FILE WRITE
impact bound; it is NOT proven to block NETWORK EGRESS, and cursor-agent uses
the network normally (its own web tools, npx-installed language servers), so a
non-scrubbed env secret is egress-exfiltratable by a compromised session —
bounded by own-account trust (Path B), not by the sandbox. A workspace placed
directly under `$HOME` can leave `$HOME` writable. The account's own
skills/plugins/MCP load but are sandbox-bounded; a malicious repo is the main
residual threat, handled by the sandbox + read-only mode + prompt guard.
Product Path-B managed runs are always-enabled on the production spawn path
(not gated on minting a fingerprint at desktop launch). Any legacy
`plan-no-tools` probe/fingerprint is non-admissible inventory for Path-B, not
the production containment story.

The live suite must force each of the nine denied Kimi native tools individually
(`Bash`, `Glob`, `Grep`, `Read`, `Write`, `Edit`, `WebSearch`, `FetchURL`, and
`AgentSwarm`). Every attempt must return a structured terminal denial carrying
the same tool-call id; a missing request, an id mismatch, or an unstructured
failure is not acceptable evidence.

Native tool *titles* are provider-internal and can drift across Kimi builds, so
every row additionally proves a real attempt occurred (an empty tool-call set is
never acceptable evidence). For the `Write` row specifically — which on
kimi-code 0.27.0 a rigid "invoke the built-in Write tool, no alternative" prompt
does not reliably elicit — the fixture uses a natural create-a-file prompt and
accepts a structured terminal permission-denial of either sibling write-capable
roster title (`Write` or `Edit`), together with the bounded-local-effect proof
that no unmediated write landed. This stays non-vacuous: an attempt must occur, a
write-capable native tool must be denied, and no file may be written.

The active required live/release tuple contains Kimi only. The exact-fingerprint
manifest and generated embedded Kimi runtime roster are still empty, so strict
release attestation remains red until a reviewed tuple is added; desktop Kimi
admission is not gated on it and proceeds in labelled `unattested-development`
mode. The exact-SHA dependency therefore blocks signed release-artifact
publication. Cursor is product-enabled (Path-B always-on contained argv) but
sits outside the required release tuple, so its absence does not block a
release; its reviewed canary roster also ships empty, and adding a live test
alone cannot add Cursor to the required lists — that takes a reviewed
exact-build suite, an admissible exact scope tuple, and an explicit change to
both required-provider lists. A Plan-only tuple could never qualify Cursor tool
mode.

## Evidence and privacy

Published artifacts are limited to:

- `artifacts/provider-permission-conformance.json`; and
- `artifacts/provider-permission-conformance.xml`.

Raw Vitest reports are parsed from a private temporary directory and deleted.
Provider stdout, stderr, prompts, raw frames, model answers, account identity,
and credentials are not copied into the aggregate artifacts. The report records
only binary/capability metadata, reviewed-suite names, assertion counts, bounded
status reasons, and the final disposition.

The hosted live runner gives Vitest a runner-owned private root for every
temporary workspace and Kimi source/ephemeral home. It starts Vitest as a
separate POSIX process group, terminates the group on timeout/output overflow,
strictly verifies Kimi-home deletion, and removes the complete root before
returning. The single reviewed Kimi suite has 16 exact assertion names; missing,
extra, or skipped assertions are rejected.

## Coverage baseline

`npm run test:coverage:baseline` writes Vitest coverage reports to
`artifacts/coverage`. This is a measured, non-gating baseline: it has no minimum
threshold and is not a per-PR ratchet. Provider permission conformance remains a
separate release decision and outranks aggregate coverage percentage.
