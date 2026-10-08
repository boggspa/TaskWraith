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

Windows also retains the published beta's NSIS installer GUID
(`47ec134f-b60a-536f-9f7e-125e215054fe`). The GUID selects the existing install
location and uninstall registration independently of the new app ID. Letting
electron-builder derive a new GUID from the public app ID would lose that
registration and could leave two uninstall entries pointing at one directory.
Installer replacement keeps `deleteAppDataOnUninstall: false`.
The Windows handoff build lanes install the final beta in a custom directory,
then run the hash-pinned public installer without specifying a destination.
On both x64 and native arm64 they check that the existing directory and one
uninstall registration are retained, the app launches, an opaque profile
fixture survives, and uninstall removes the registration. This is installer
replacement evidence; the complete user-facing handoff matrix remains required.

`allowDowngrade` remains disabled. The new Release app uses the generic provider
at `https://taskwraith.dev/updates/release/` and requests `release-mac.yml`,
`release-win-{x64,arm64}.yml` or `release-linux.yml`. Its metadata contains
absolute, versioned GitHub installer URLs. The legacy beta keeps GitHub's
repository-wide Latest discovery, which must remain pointed at `v1.9.9` after
the bridge is published. Different channel filenames in the same GitHub
provider do not separate discovery: that provider picks Latest before finding
the requested channel file.

The packaging inventory covers macOS universal, Windows x64 and arm64, and
Linux x64. Protocol support for a Linux arm64 filename is not evidence of a
distributed Linux arm64 package.

## Product journey

1. A pre-1.9.9 beta updates normally to 1.9.9 through `latest`.
2. The 1.9.9 app reads its embedded `identity-handoff.json`. That payload
   pins the exact size and SHA-256 of each 0.1.0 installer; there is no mutable
   remote manifest.
3. The user explicitly downloads the selected platform/architecture artifact.
   A partial download stays under `userData/identity-handoff-v1` and resumes
   with a validated HTTP range response after interruption or relaunch.
4. TaskWraith hashes the complete artifact, atomically records `downloaded`,
   waits for active work through the existing update-restart coordinator, then
   records `awaiting-target`, and asks the OS to open the installer. Beta quits
   only after process creation is acknowledged (or macOS accepts the disk image).
   Linux schedules the retained AppImage through Electron's relaunch helper,
   which starts it after beta exits and releases the shared-profile lock.
   An isolated packaged instance carries its validated profile selector into
   Release; unrelated launch arguments are not forwarded.
   A launch error keeps beta open with the repair/retry path available.
5. The first launch of the `com.taskwraith.desktop` identity writes `complete`,
   removes disposable cached installers when possible and maps the historical beta `nightly` setting
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

Keep `taskwraithRelease.distribution` set to `beta` in that frozen source. The
debut config extends the reusable `electron-builder.release.yml` and overrides
only the packaged version and output directory. Ordinary package commands use
the source's declared distribution through `run-electron-builder.cjs`.

```bash
npm run build:debut:mac:notarized
npm run build:debut:win
npm run build:debut:linux
```

The macOS command is the notarized local path. Windows intentionally ships
unsigned under the maintainer's release policy; its command runs the real silent
install → launch → uninstall smoke. The manifest accepts unsigned PE installers
and explicitly discloses that Windows cannot verify their publisher. Their exact
size and SHA-256 remain pinned by the beta handoff. Linux uses AppImage/deb.

Collect the exact final artifacts from those platform builders under
`.local-only/identity-handoff/artifacts`, then prepare the external payload:

```bash
npm run prepare:identity-handoff

TASKWRAITH_REQUIRE_PREPARED_HANDOFF=1 \
  node scripts/identity-handoff-manifest.cjs verify \
  --manifest .local-only/identity-handoff/identity-handoff.json \
  --artifact-dir .local-only/identity-handoff/artifacts

npm run build:handoff:mac:notarized
npm run build:handoff:win
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
copies the external prepared payload beside the 1.9.9 app resources and removes it
from every other identity, including 0.1.0. This prevents the public artifact
from containing the hash that is supposed to describe that same artifact (an
impossible self-reference) and lets both packages be built from one source
commit without committing a future-artifact hash. The package smoke verifies the embedded distribution metadata and, on
macOS, cross-checks it against the actual bundle identifier.

Do not rebuild, rename, staple or otherwise mutate an artifact after preparing
the manifest. Any byte change requires regenerating the payload and repeating
the rehearsal.

For the 1.9.9 throwaway rehearsal, publish the same hash-pinned artifact names
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
Publish the already-approved macOS, unsigned Windows and Linux bytes plus their
`release-*` feeds under `v0.1.0`; then verify the remote asset sizes/hashes
against the external payload before making the release the public debut route.
This deliberately does not activate the policy-disabled hosted signing jobs or
upload signing credentials to GitHub Actions.

### Separate discovery and publication order

Before final tags or publication, Windows/Linux can build from the frozen source
SHA with `unsigned_distribution=debut`. Stage the target installers and prepared
`identity-handoff.json` in a private `v0.1.0-handoff-rc.N` GitHub draft. Dispatch
`unsigned_distribution=handoff` with `handoff_download_tag` naming that draft and
the approved `handoff_payload_sha256`. CI verifies all pinned bytes and the
source commit; the embedded manifest still names the final `v0.1.0` URLs. This
permits both package identities to finish validation before the draft is promoted
to the final tag and made public. Do not rebuild or modify the approved bytes
during promotion.

1. Keep both dated changelog sections in the frozen source: `1.9.9` first and
   `0.1.0` below it. Validate `v1.9.9` normally, and validate `v0.1.0` with
   `node scripts/verify-release-tag.cjs --distribution=debut v0.1.0`.
   Generate the public identity's notes with
   `node scripts/prepare-release-notes.cjs --distribution=debut 0.1.0 <notes-path>`.
   Both tags identify the same source commit; the root lockfile remains `1.9.9`.
2. Publish the immutable `v0.1.0` installer assets with GitHub `make_latest=false`
   (`gh release create/edit ... --latest=false`). Verify remote sizes and hashes
   against the final local bytes before making an update feed visible.
3. Prepare the four Release manifests from the complete final platform outputs:

   ```bash
   npm run prepare:release-update-feed -- --version 0.1.0 \
     --output .local-only/identity-handoff/prepared-release-feed \
     <mac-output> <windows-output> <linux-output>
   ```

   The output directory must be new and separate from the inputs. The preparer
   checks the exact inventory, versions, artifact sizes and SHA-512 digests,
   requires updater blockmaps, and rejects beta feeds and unexpected paths.
   It stages metadata only; it does not publish or overwrite existing output.

4. Copy that verified metadata into the website's `updates/release/` directory
   and publish it in one website deployment. Check each live YAML response and
   its immutable asset URLs. Point new-user download links directly at the
   public identity's versioned release, never at GitHub's Latest shortcut.
5. Publish the prepared `v1.9.9` bridge and explicitly mark it GitHub Latest.
   Every subsequent public Release uses `--latest=false`. An older beta that
   returns months later must still discover and download the bridge.
6. Prove both paths from installed candidates: `1.9.8 → 1.9.9 → 0.1.0` and
   `0.1.0 →` a later Release candidate. A development provider test proves
   routing logic, not the installed application's signing or preservation.

After the crossing, begin a new source commit with the next public package and
lockfile version and `taskwraithRelease.distribution: "release"`. The ordinary
build commands then use `electron-builder.release.yml` and the Release feed.
The public line retains that identity even when its major version reaches 1
or 2; identity is never inferred from semver ordering. Keep the two original
tags and frozen debut configuration available as provenance.

Retain the legacy release, its feeds, installers and blockmaps, plus the exact
`v0.1.0` installers pinned inside 1.9.9. Do not delete them to hide updates.
Independent discovery keeps legacy releases out of the public updater, while
retained bytes preserve late migration and repair. The handoff already removes
disposable cached installers after a successful target launch; its receipt is retained.
The Linux AppImage is retained because it is the application itself, not an
installer. Locked installer cleanup is deferred without preventing target startup.

## Required 1.9.9 rehearsal matrix

Every row uses disposable copies of production-shaped profiles and the exact
candidate bytes (notarized macOS, unsigned Windows, Linux). Record the candidate commit, artifact hashes,
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

1. Repeat the complete matrix on the exact 1.9.9 and 0.1.0 candidates with their declared signing posture.
2. Verify the prepared manifest against the final published installer bytes.
3. Confirm all preservation-surface digests and the target `complete` receipt.
4. Exercise retry from the retained beta installation and the visible support
   route on each platform.
5. Confirm a new user reaches the same 0.1.0 Release artifacts without
   installing the beta identity.

No successful unit test or development build closes this gate. Closure requires
the installed-build evidence above.
