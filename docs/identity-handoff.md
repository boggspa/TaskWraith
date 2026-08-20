# TaskWraith 1.9.9 → 0.1.0 identity handoff

## Frozen V1 contract

The public debut is a one-way application-identity handoff, not a semver
downgrade:

| Boundary              | Final beta                  | Public Release           |
| --------------------- | --------------------------- | ------------------------ |
| Version               | `1.9.9`                     | `0.1.0`                  |
| Desktop app id        | `com.chrisizatt.taskwraith` | `com.taskwraith.desktop` |
| Distribution identity | `beta`                      | `release`                |
| Stable feed           | `latest`                    | `release`                |
| Product/profile name  | `TaskWraith`                | `TaskWraith`             |

Keeping the product/profile name preserves the existing TaskWraith user-data
root. The handoff does **not** copy, rewrite or schema-migrate chats, journals,
settings, encrypted secrets, bridge/pairing identities, audit keys, usage,
workflows, media, Canvas state or Browser profile data. The 0.1.0 candidate must
therefore remain storage-compatible with 1.9.9. Unreadable identities are never
regenerated as part of this route.

`allowDowngrade` remains disabled. The new Release app uses `release-mac.yml`,
`release-win-{x64,arm64}.yml` and `release-linux.yml`; it cannot accidentally
consume the beta `latest` feed.

## Product journey

1. A pre-1.9.9 beta updates normally to 1.9.9 through `latest`.
2. The signed 1.9.9 app reads its embedded `identity-handoff.json`. That payload
   pins the exact size and SHA-256 of each 0.1.0 installer; there is no mutable
   remote manifest.
3. The user explicitly downloads the selected platform/architecture artifact.
   A partial download stays under `userData/identity-handoff-v1` and resumes
   with a validated HTTP range response after interruption or relaunch.
4. TaskWraith hashes the complete artifact, atomically records `downloaded`,
   waits for active work through the existing update-restart coordinator, then
   records `awaiting-target`, opens the installer and exits the beta app.
5. The first launch of the `com.taskwraith.desktop` identity writes `complete`,
   removes the cached installer and maps the historical beta `nightly` setting
   to `stable`/Release. The public identity always clamps that retired beta
   choice back to Release, including a manual repair install whose receipt was
   lost; a fresh 0.1.0 profile already defaults to `stable`.
6. Until `complete` exists, 1.9.9 remains a bounded retry/repair surface. It
   re-hashes cached bytes before reopening them and links to the 0.1.0 support
   release when the platform, payload or current identity is unsupported.

The durable evidence record is:

```text
<TaskWraith userData>/identity-handoff-v1/state.json
```

It contains phases, versions, the selected artifact, normalized-manifest and
artifact SHA-256 evidence, byte progress, attempts and timestamps—never
installer bytes, secrets or profile content. Receipt writes fsync the file and,
where the platform permits it, the parent directory after atomic rename.

## Release preparation

After the final beta source is committed with `package.json` exactly `1.9.9`,
build the public identity from that same commit using
`electron-builder.debut.yml`:

```bash
npm run build:debut:mac:notarized
npm run build:debut:win
npm run build:debut:linux
```

The macOS command is the notarized local path. The Windows command requires the
local Authenticode environment and runs the real silent install → launch →
uninstall smoke; `build:debut:win:unsigned-rehearsal` exists only for the
throwaway exercise and cannot supply final manifest bytes—the manifest builder
rejects a Windows PE without an embedded Authenticode certificate table. Linux remains the
release-shaped AppImage/deb path.

Collect the exact final artifacts from those platform builders under
`.local-only/identity-handoff/artifacts`, then prepare the external payload:

```bash
npm run prepare:identity-handoff

TASKWRAITH_REQUIRE_PREPARED_HANDOFF=1 \
  node scripts/identity-handoff-manifest.cjs verify \
  --manifest .local-only/identity-handoff/identity-handoff.json \
  --artifact-dir .local-only/identity-handoff/artifacts

npm run build:handoff:mac:notarized
npm run build:handoff:win:signed
npm run build:handoff:linux
```

The wrapper re-verifies all four target artifacts, injects the external payload
path into the existing beta release build and refuses any byte changed after
preparation. The payload records the exact source commit and the wrapper refuses
to run unless both `HEAD` and `package.json` still match that final-beta source.
A normal 1.9.9 package build has no payload path and fails in
`afterPack`; only these wrapper commands can produce the final handoff package.
Normal `build` and `ci` still validate the tracked, unprepared contract template
without needing future release artifacts.

The manifest is deliberately excluded from `app.asar`. The packaging hook
copies the external prepared payload beside the signed 1.9.9 app resources and removes it
from every other identity, including 0.1.0. This prevents the public artifact
from containing the hash that is supposed to describe that same artifact (an
impossible self-reference) and lets both packages be built from one source
commit without committing a future-artifact hash. The package smoke verifies the embedded distribution metadata and, on
macOS, cross-checks it against the actual bundle identifier.

Do not rebuild, rename, staple or otherwise mutate an artifact after preparing
the manifest. Any byte change requires regenerating the payload and repeating
the rehearsal.

For the 1.9.8 throwaway rehearsal, publish the same hash-pinned artifact names
under a temporary tag in the same GitHub repository, then prepare/verify with
that exact base URL:

```bash
REHEARSAL_BASE=https://github.com/boggspa/TaskWraith/releases/download/v0.1.0-handoff-rc.1
node scripts/identity-handoff-manifest.cjs prepare \
  --artifact-dir /path/to/rehearsal-artifacts \
  --base-url "$REHEARSAL_BASE" \
  --output .local-only/identity-handoff/rehearsal.json
TASKWRAITH_HANDOFF_REHEARSAL_BASE_URL="$REHEARSAL_BASE" \
  TASKWRAITH_REQUIRE_PREPARED_HANDOFF=1 \
  node scripts/identity-handoff-manifest.cjs verify \
  --manifest .local-only/identity-handoff/rehearsal.json \
  --artifact-dir /path/to/rehearsal-artifacts

node scripts/run-identity-handoff-build.cjs \
  --script build:mac:notarized \
  --payload .local-only/identity-handoff/rehearsal.json \
  --artifact-dir /path/to/rehearsal-artifacts \
  --base-url "$REHEARSAL_BASE"
```

The ordinary 1.9.9 verifier accepts only the final `v0.1.0` URL, so a rehearsal
payload cannot accidentally become the ship payload.

Publication remains the canonical local/manual release path in
`.local-only/RELEASING.md`: signing credentials are never uploaded to GitHub.
Publish the already-approved macOS, signed Windows and Linux bytes plus their
`release-*` feeds under `v0.1.0`; then verify the remote asset sizes/hashes
against the external payload before making the release the public debut route.
This deliberately does not activate the policy-disabled hosted signing jobs or
upload signing credentials to GitHub Actions.

## Required 1.9.8 rehearsal matrix

Every row uses disposable copies of production-shaped profiles and the exact
signed/notarized candidate bytes. Record the candidate commit, artifact hashes,
platform/architecture, source profile fixture and final receipt.

| Case                                       | Expected result                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Fresh 0.1.0 install                        | No handoff state is invented; Release feed is active.                                         |
| Normal 1.9.9 handoff                       | Download → verified → installer → target launch → `complete`; profile digests stay unchanged. |
| Interrupted download                       | Partial bytes and attempt count persist; a valid 206 response resumes at the exact offset.    |
| Relaunch before install                    | Cached bytes are re-hashed before the installer can open.                                     |
| Relaunch after installer open              | 1.9.9 offers bounded reopen/repair; 0.1.0 completes the same receipt idempotently.            |
| Duplicate action                           | One in-flight download and one durable phase transition; no duplicate installer mutation.     |
| Unsupported platform/arch                  | No download or launch; visible support route and error code.                                  |
| Wrong source/target identity               | Fail closed; no profile mutation and no installer launch.                                     |
| Size/hash/URL mismatch                     | Artifact rejected and never executed.                                                         |
| Target launch with beta `nightly` selected | Setting becomes `stable`; updater requests only the Release feed.                             |

For each supported platform, separately verify that the packaged metadata,
actual bundle/application identity and generated feed agree. On macOS the
package smoke cross-checks `CFBundleIdentifier`; the release validators enforce
the target version and `release` feed names on every platform.

## 1.9.9 ship gate

1. Repeat the complete matrix on the exact signed 1.9.9 and 0.1.0 candidates.
2. Verify the prepared manifest against the final published installer bytes.
3. Confirm all preservation-surface digests and the target `complete` receipt.
4. Exercise retry from the retained beta installation and the visible support
   route on each platform.
5. Confirm a new user reaches the same 0.1.0 Release artifacts without
   installing the beta identity.

No successful unit test or development build closes this gate. Closure requires
the installed-build evidence above.
