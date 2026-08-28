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
  `unattested_pass` report for human review.

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
`reviewed`.
A `--live` Cursor run produces review evidence for the sandbox differential; it
is not required to flip a desktop availability gate.

## Hosted release attestation — removed 2026-07-21

The hosted release-attestation apparatus (the
`provider-containment-canaries.yml` dispatch workflow, the exact-SHA
`provider-permission-attestation` CI job, the 24-hour freshness verifier, the
`REQUIRED_PROVIDERS` release aggregate, and the
`PROVIDER_CANARY_ENVIRONMENT_CONFIGURED` / `RELEASE_TAG_PROTECTION_CONFIGURED`
commissioning variables) was removed by user decision on 2026-07-21 under
AGENTS.md "Capability governance — the user decides": it hard-blocked signed
release publication on external commissioning state the user never chose,
against an empty required-fingerprint manifest, and the project's actual
release path is the local notary runbook. Live containment canaries remain
fully supported as local, user-invoked qualification evidence
(`verify:provider-permissions:live`, `verify:provider-compatibility`); they
inform review, they do not gate publication. The signed release jobs keep their
own artifact verification and remote-tag integrity checks
(`gh release create --verify-tag` plus fetch-and-peel equality immediately
before creation and upload).

## Fingerprint review

The Kimi qualification fingerprint list is intentionally empty until live reports
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
change returns the provider to `UNRECOGNIZED`.

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

The `verify:provider-permissions:live` reviewed tuple targets Kimi. The
exact-fingerprint manifest's Kimi list and the generated embedded Kimi runtime
roster are still empty; desktop Kimi admission is not gated on them and
proceeds in labelled `unattested-development` mode, and since 2026-07-21
nothing downstream blocks release publication on that state. Cursor is
product-enabled (Path-B always-on contained argv) and carries a reviewed
`cursor-native-sandbox-readonly-v1` fingerprint minted from a live canary pass;
both fingerprints are qualification evidence for human review, not spawn or
release switches.

## Evidence and privacy

Published artifacts are limited to:

- `artifacts/provider-permission-conformance.json`; and
- `artifacts/provider-permission-conformance.xml`.

Raw Vitest reports are parsed from a private temporary directory and deleted.
Provider stdout, stderr, prompts, raw frames, model answers, account identity,
and credentials are not copied into the aggregate artifacts. The report records
only binary/capability metadata, reviewed-suite names, assertion counts, bounded
status reasons, and the final disposition.

The live runner gives Vitest a runner-owned private root for every
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
