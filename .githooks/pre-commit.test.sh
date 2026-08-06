#!/usr/bin/env bash

set -euo pipefail

hook_source="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pre-commit"
suite_root="$(mktemp -d "${TMPDIR:-/tmp}/taskwraith-pre-commit.XXXXXX")"
foreign_pid=""
assertions=0
host_platform="$(node -p 'process.platform')"

cleanup() {
  if [ -n "$foreign_pid" ]; then
    kill "$foreign_pid" 2>/dev/null || true
    wait "$foreign_pid" 2>/dev/null || true
  fi
  rm -rf "$suite_root"
}
trap cleanup EXIT

sleep 300 &
foreign_pid=$!

new_repo() {
  local name="$1"
  local repo="$suite_root/$name"
  mkdir -p "$repo/src/lib/deep" "$repo/src/library" "$repo/docs" "$repo/.githooks"
  git -C "$repo" init -q
  git -C "$repo" config user.name 'TaskWraith hook test'
  git -C "$repo" config user.email 'hook-test@taskwraith.invalid'
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" config core.hooksPath /dev/null

  printf 'baseline\n' > "$repo/src/manual.ts"
  printf 'baseline\n' > "$repo/src/hunk.ts"
  printf 'baseline\n' > "$repo/src/lib/deep/file.ts"
  printf 'baseline\n' > "$repo/src/library/not-in-tree.ts"
  printf 'baseline\n' > "$repo/docs/readme.md"
  git -C "$repo" add \
    src/manual.ts \
    src/hunk.ts \
    src/lib/deep/file.ts \
    src/library/not-in-tree.ts \
    docs/readme.md
  git -C "$repo" commit -qm baseline

  cp "$hook_source" "$repo/.githooks/pre-commit"
  chmod +x "$repo/.githooks/pre-commit"
  git -C "$repo" config core.hooksPath .githooks
  printf '%s' "$repo"
}

stage_file() {
  local repo="$1" path="$2"
  printf 'staged change\n' >> "$repo/$path"
  git -C "$repo" add -- "$path"
}

stage_new_file() {
  local repo="$1" path="$2"
  mkdir -p "$(dirname "$repo/$path")"
  printf 'new staged file\n' > "$repo/$path"
  git -C "$repo" add -- "$path"
}

json_string() {
  MARKER_TEST_VALUE="$1" node -e \
    'process.stdout.write(JSON.stringify(process.env.MARKER_TEST_VALUE))'
}

sha256_string() {
  MARKER_TEST_VALUE="$1" node -e \
    "process.stdout.write(require('node:crypto').createHash('sha256').update(process.env.MARKER_TEST_VALUE, 'utf8').digest('hex'))"
}

# Fixtures must stamp a FRESH `started`: a lease is now capped at 15 minutes from
# it, so the old hard-coded 2026-07-29 start made every `expires: 2099-…` marker
# decay instantly and stop blocking anything.
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

write_manual_marker() {
  local repo="$1" marker_pid="$2" path="$3"
  printf '%s\n' \
    '---' \
    'session: manual-test' \
    'agent: test-agent' \
    "pid: $marker_pid" \
    "started: $(now_iso)" \
    'expires: 2099-07-29T00:00:00Z' \
    "worktree: $repo" \
    'paths:' \
    "  - $path" \
    '---' \
    'manual test marker' > "$repo/.WORK-IN-PROGRESS-manual-test.md"
}

# A manual claim raised by a sandboxed seat: no pid (it cannot inspect one),
# authenticated instead by the per-seat TASKWRAITH_LOCK_OWNER_ID it already
# carries in its environment.
write_owner_id_marker() {
  local repo="$1" owner_id="$2" path="$3"
  printf '%s\n' \
    '---' \
    'session: seat-test' \
    'agent: test-seat' \
    "lockOwnerId: $owner_id" \
    "started: $(now_iso)" \
    'expires: 2099-07-29T00:00:00Z' \
    'paths:' \
    "  - $path" \
    '---' \
    'sandboxed seat marker' > "$repo/.WORK-IN-PROGRESS-manual-test.md"
}

write_derived_marker() {
  local repo="$1" owner_id="$2" workspace_wide="$3" tree="$4" path="$5"
  local marker_pid="${6:-$$}"
  local marker_expires="${7:-2099-07-29T00:00:00.000Z}"
  local marker
  marker="$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md"
  printf '%s\n' '---' 'derived: true' > "$marker"
  printf 'lockOwnerId: %s\n' "$(json_string "$owner_id")" >> "$marker"
  printf '%s\n' \
    'session: "runtime-test"' \
    'agent: "taskwraith-runtime"' \
    "pid: $marker_pid" \
    'started: "2026-07-29T00:00:00.000Z"' \
    "expires: \"$marker_expires\"" \
    'birthReceiptHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' >> "$marker"
  printf 'worktree: %s\n' "$(json_string "$repo")" >> "$marker"
  printf '%s\n' "workspaceWide: $workspace_wide" 'trees:' >> "$marker"

  if [ -n "$tree" ]; then
    printf '  - %s\n' "$(json_string "$tree")" >> "$marker"
  fi

  printf '%s\n' 'paths:' >> "$marker"
  if [ -n "$path" ]; then
    printf '  - %s\n' "$(json_string "$path")" >> "$marker"
  fi
  printf '%s\n' 'treeDigests:' >> "$marker"
  if [ -n "$tree" ]; then
    printf '  - "%s"\n' "$(sha256_string "$tree")" >> "$marker"
  fi
  printf '%s\n' 'pathDigests:' >> "$marker"
  if [ -n "$path" ]; then
    printf '  - "%s"\n' "$(sha256_string "$path")" >> "$marker"
  fi
  printf '%s\n' '---' 'derived runtime test marker' >> "$marker"
}

expire_marker() {
  local marker="$1"
  sed -E 's/^expires:.*/expires: "2000-01-01T00:00:00.000Z"/' "$marker" > "$marker.next"
  mv "$marker.next" "$marker"
}

# An empty value deletes the field outright; anything else replaces it. Both
# shapes are how a lease stops being readable in practice.
set_marker_expires() {
  local marker="$1" value="$2"
  if [ -z "$value" ]; then
    sed -E '/^expires:/d' "$marker" > "$marker.next"
  else
    sed -E "s|^expires:.*|expires: $value|" "$marker" > "$marker.next"
  fi
  mv "$marker.next" "$marker"
}

hook_output=""
hook_status=0
run_hook() {
  local repo="$1" owner_id="${2:-}"
  local output_file
  output_file="$repo/hook-output.txt"
  if (
    cd "$repo"
    TASKWRAITH_LOCK_OWNER_ID="$owner_id" .githooks/pre-commit
  ) > "$output_file" 2>&1; then
    hook_status=0
  else
    hook_status=$?
  fi
  hook_output="$(< "$output_file")"
}

run_hook_without_sha256() {
  local repo="$1"
  local output_file="$repo/hook-output.txt"
  local fake_bin="$repo/no-sha-bin"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/bin/sh' \
    "printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'" \
    'exit 1' > "$fake_bin/sha256sum"
  chmod +x "$fake_bin/sha256sum"
  ln -s /usr/bin/false "$fake_bin/shasum"
  ln -s /usr/bin/false "$fake_bin/openssl"
  if (
    cd "$repo"
    PATH="$fake_bin:$PATH" TASKWRAITH_LOCK_OWNER_ID='' .githooks/pre-commit
  ) > "$output_file" 2>&1; then
    hook_status=0
  else
    hook_status=$?
  fi
  hook_output="$(< "$output_file")"
}

expect_block() {
  local label="$1" repo="$2" owner_id="${3:-}"
  run_hook "$repo" "$owner_id"
  if [ "$hook_status" -ne 1 ] || [[ "$hook_output" != *BLOCKED* ]]; then
    printf 'FAIL: %s (status=%s)\n%s\n' "$label" "$hook_status" "$hook_output" >&2
    exit 1
  fi
  assertions=$((assertions + 1))
}

expect_allow() {
  local label="$1" repo="$2" owner_id="${3:-}"
  run_hook "$repo" "$owner_id"
  if [ "$hook_status" -ne 0 ] || [[ "$hook_output" == *BLOCKED* ]]; then
    printf 'FAIL: %s (status=%s)\n%s\n' "$label" "$hook_status" "$hook_output" >&2
    exit 1
  fi
  assertions=$((assertions + 1))
}

repo="$(new_repo manual-foreign)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$foreign_pid" src/manual.ts
expect_block 'manual foreign exact-path claims still block' "$repo"

repo="$(new_repo manual-own)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$$" src/manual.ts
expect_allow 'manual ancestor-owned claims still pass' "$repo"

repo="$(new_repo manual-body)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$$" src/manual.ts
printf '%s\n' \
  'derived: true' \
  'lockOwnerId: "not-the-owner"' \
  'workspaceWide: true' \
  'paths:' \
  '  - docs/readme.md' >> "$repo/.WORK-IN-PROGRESS-manual-test.md"
expect_allow 'manual body text cannot masquerade as derived frontmatter' "$repo"

repo="$(new_repo derived-shared-pid)"
stage_file "$repo" src/hunk.ts
write_derived_marker "$repo" owner-run-1 false '' src/hunk.ts
expect_block 'derived claims do not inherit shared Electron pid ownership' "$repo"
expect_block 'derived owner ids require exact equality' "$repo" owner-run
expect_allow 'exact derived owner id passes its own claim' "$repo" owner-run-1

repo="$(new_repo workspace-wide)"
stage_file "$repo" docs/readme.md
write_derived_marker "$repo" owner-workspace true '' ''
expect_block 'workspace-wide derived claims cover every staged workspace path' "$repo"

repo="$(new_repo tree-descendant)"
stage_file "$repo" src/lib/deep/file.ts
write_derived_marker "$repo" owner-tree false src/lib ''
expect_block 'tree digests cover descendants' "$repo"

repo="$(new_repo tree-prefix)"
stage_file "$repo" src/library/not-in-tree.ts
write_derived_marker "$repo" owner-tree false src/lib ''
expect_allow 'tree claims do not cover sibling path prefixes' "$repo"

repo="$(new_repo hunk-file-projection)"
stage_file "$repo" src/hunk.ts
write_derived_marker "$repo" owner-hunk false '' src/hunk.ts
expect_block 'hunk projections under paths block their whole staged file' "$repo"

repo="$(new_repo unrelated-file)"
stage_file "$repo" docs/readme.md
write_derived_marker "$repo" owner-hunk false '' src/hunk.ts
expect_allow 'file and hunk projections do not cover unrelated files' "$repo"

repo="$(new_repo expired-derived)"
stage_file "$repo" src/hunk.ts
write_derived_marker "$repo" owner-expired false '' src/hunk.ts
expire_marker "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md"
expect_block 'expired derived markers fail closed while their runtime pid is live' "$repo"
if [[ "$hook_output" == *adoptable* ]] || [[ "$hook_output" == *'then delete it'* ]]; then
  printf 'FAIL: expired live derived marker was described as adoptable/deletable\n%s\n' \
    "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))

repo="$(new_repo expired-manual)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$foreign_pid" src/manual.ts
expire_marker "$repo/.WORK-IN-PROGRESS-manual-test.md"
expect_allow 'expired manual promises remain expiry-authoritative' "$repo"

# A manual claim whose lease cannot be READ must decay exactly like one that has
# expired. Otherwise it blocks for as long as its host pid lives — and agent
# session hosts idle alive for hours, so `expires` is the only decay signal that
# fires in practice. Both shapes below are immortal claims without this.
repo="$(new_repo unreadable-lease-manual)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$foreign_pid" src/manual.ts
set_marker_expires "$repo/.WORK-IN-PROGRESS-manual-test.md" 'tomorrow-ish'
expect_allow 'manual claims with an unreadable lease decay instead of blocking' "$repo"
if [[ "$hook_output" != *'no readable expires'* ]]; then
  printf 'FAIL: unreadable manual lease was not surfaced for cleanup\n%s\n' \
    "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))

repo="$(new_repo missing-lease-manual)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$foreign_pid" src/manual.ts
set_marker_expires "$repo/.WORK-IN-PROGRESS-manual-test.md" ''
expect_allow 'manual claims with no lease at all decay instead of blocking' "$repo"
if [[ "$hook_output" != *'no readable expires'* ]]; then
  printf 'FAIL: missing manual lease was not surfaced for cleanup\n%s\n' \
    "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))

# A RUNTIME-derived projection must NOT gain the same escape hatch: durable lock
# authority owns its cleanup, so an unreadable lease there still fails closed.
repo="$(new_repo unreadable-lease-derived)"
stage_file "$repo" src/hunk.ts
write_derived_marker "$repo" owner-unreadable false '' src/hunk.ts "$foreign_pid"
set_marker_expires "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md" 'tomorrow-ish'
expect_block 'derived projections with an unreadable lease still fail closed' "$repo"

# A marker whose fields are NOT wrapped in `---` parses every field empty — pid,
# expires, worktree and the whole paths list — so it claims nothing at all. The
# hook used to report that as "has no pid", which sent its author hunting for a
# line that was already there. Observed in the wild 2026-08-06: two live markers
# in this shape, one of them otherwise perfectly formed.
write_delimiterless_marker() {
  local repo="$1" marker_pid="$2" path="$3"
  printf '%s\n' \
    "pid: $marker_pid" \
    'expires: 2099-07-29T00:00:00Z' \
    'paths:' \
    "  - $path" \
    'no delimiters anywhere' > "$repo/.WORK-IN-PROGRESS-manual-test.md"
}

repo="$(new_repo delimiterless-marker)"
stage_file "$repo" src/manual.ts
write_delimiterless_marker "$repo" "$foreign_pid" src/manual.ts
expect_allow 'a marker with no --- delimiters cannot block' "$repo"
if [[ "$hook_output" != *'claims NOTHING'* ]]; then
  printf 'FAIL: delimiterless marker was not diagnosed honestly\n%s\n' "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))
if [[ "$hook_output" == *'has no pid'* ]]; then
  printf 'FAIL: delimiterless marker still misreported as "has no pid"\n%s\n' \
    "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))

# A marker that genuinely omits pid keeps the historical advisory wording.
repo="$(new_repo genuinely-pidless)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$foreign_pid" src/manual.ts
sed '/^pid:/d' "$repo/.WORK-IN-PROGRESS-manual-test.md" \
  > "$repo/.WORK-IN-PROGRESS-manual-test.md.next"
mv "$repo/.WORK-IN-PROGRESS-manual-test.md.next" "$repo/.WORK-IN-PROGRESS-manual-test.md"
expect_allow 'a marker that genuinely omits pid stays advisory' "$repo"
if [[ "$hook_output" != *'has no pid'* ]]; then
  printf 'FAIL: genuinely pidless marker lost its advisory note\n%s\n' "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))

# SANDBOXED SEATS. A TaskWraith provider seat cannot inspect its own pid, so it
# cannot satisfy the pid lane at all — ownership there is pid ancestry and
# liveness is `kill -0`. It does carry a per-seat opaque id in its environment
# (TASKWRAITH_LOCK_OWNER_ID, scoped to runId+laneId+participantId), which the
# derived lane already trusts. These pin the same identity working for a manual,
# intent-length claim, since derived markers are lease-transient and cannot
# express "I am working on these files for the next two hours".
repo="$(new_repo seat-claim-foreign)"
stage_file "$repo" src/manual.ts
write_owner_id_marker "$repo" seat-owner-1 src/manual.ts
expect_block 'a lock-owner-id claim blocks a session that is not that seat' "$repo" seat-owner-2

repo="$(new_repo seat-claim-empty-env)"
stage_file "$repo" src/manual.ts
write_owner_id_marker "$repo" seat-owner-1 src/manual.ts
# An absent env var must never satisfy an owner id. Anything else would let any
# process outside TaskWraith inherit every seat's bypass at once.
expect_block 'an empty lock-owner env never matches a claim' "$repo"

repo="$(new_repo seat-claim-own)"
stage_file "$repo" src/manual.ts
write_owner_id_marker "$repo" seat-owner-1 src/manual.ts
expect_allow 'the exact seat owns its own lock-owner-id claim' "$repo" seat-owner-1
# Section 4 must recognise the same identity, or a seat holding a perfectly good
# claim gets told it has none — which would teach seats to ignore the nag.
if [[ "$hook_output" == *'no live claim of yours'* ]]; then
  printf 'FAIL: seat with a live lock-owner-id claim was nagged as markerless\n%s\n' \
    "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))
if [[ "$hook_output" != *'your claim'* ]]; then
  printf 'FAIL: seat was not told its own lock-owner-id claim is still up\n%s\n' \
    "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))

# Liveness with no pid rests entirely on `expires`, so it must still decay.
repo="$(new_repo seat-claim-expired)"
stage_file "$repo" src/manual.ts
write_owner_id_marker "$repo" seat-owner-1 src/manual.ts
expire_marker "$repo/.WORK-IN-PROGRESS-manual-test.md"
expect_allow 'an expired lock-owner-id claim decays without any pid' "$repo" seat-owner-2

# And an unreadable lease must decay it too, exactly like the pid lane.
repo="$(new_repo seat-claim-unreadable-lease)"
stage_file "$repo" src/manual.ts
write_owner_id_marker "$repo" seat-owner-1 src/manual.ts
set_marker_expires "$repo/.WORK-IN-PROGRESS-manual-test.md" 'tomorrow-ish'
expect_allow 'an unreadable lease decays a lock-owner-id claim too' "$repo" seat-owner-2

# A marker carrying BOTH identities: ownership is either, so a seat that matches
# the owner id owns the claim even though the pid belongs to someone else.
repo="$(new_repo seat-claim-both-identities)"
stage_file "$repo" src/manual.ts
printf '%s\n' \
  '---' 'session: manual-test' 'agent: test-agent' \
  "pid: $foreign_pid" 'lockOwnerId: seat-owner-1' \
  "started: $(now_iso)" 'expires: 2099-07-29T00:00:00Z' \
  'paths:' '  - src/manual.ts' '---' 'both identities' \
  > "$repo/.WORK-IN-PROGRESS-manual-test.md"
expect_allow 'a matching owner id owns a claim whose pid is foreign' "$repo" seat-owner-1
expect_block 'that same claim still blocks a different seat' "$repo" seat-owner-2

# SHIP-HOLD and SESSION-IN-PROGRESS are evaluated in a DIFFERENT loop from
# .WORK-IN-PROGRESS, and the suite had no coverage of either — which is how the
# decay and identity fixes reached only one of the three marker types AGENTS.md
# presents as equivalent. An unreadable lease left them immortal.
write_named_marker() {
  local repo="$1" file="$2" marker_pid="$3" expires="$4" owner="$5" path="$6"
  {
    printf -- '---\n'
    printf 'session: named-test\nagent: test-agent\n'
    [ -n "$marker_pid" ] && printf 'pid: %s\n' "$marker_pid"
    [ -n "$owner" ] && printf 'lockOwnerId: %s\n' "$owner"
    printf 'started: %s\n' "$(now_iso)"
    [ -n "$expires" ] && printf 'expires: %s\n' "$expires"
    printf 'paths:\n  - %s\n---\nnamed marker\n' "$path"
  } > "$repo/$file"
}

for named in SHIP-HOLD-test.md SESSION-IN-PROGRESS-test.md; do
  repo="$(new_repo "named-live-${named%%-test.md}")"
  stage_file "$repo" src/manual.ts
  write_named_marker "$repo" "$named" "$foreign_pid" '2099-07-29T00:00:00Z' '' src/manual.ts
  expect_block "$named still blocks on a live foreign claim" "$repo"

  repo="$(new_repo "named-unreadable-${named%%-test.md}")"
  stage_file "$repo" src/manual.ts
  write_named_marker "$repo" "$named" "$foreign_pid" 'tomorrow-ish' '' src/manual.ts
  expect_allow "$named decays on an unreadable lease, like every other claim" "$repo"

  repo="$(new_repo "named-noexp-${named%%-test.md}")"
  stage_file "$repo" src/manual.ts
  write_named_marker "$repo" "$named" "$foreign_pid" '' '' src/manual.ts
  expect_allow "$named decays with no lease at all" "$repo"

  repo="$(new_repo "named-owner-${named%%-test.md}")"
  stage_file "$repo" src/manual.ts
  write_named_marker "$repo" "$named" '' '2099-07-29T00:00:00Z' seat-owner-1 src/manual.ts
  expect_block "$named accepts a seat's lock-owner-id claim" "$repo" seat-owner-2
  expect_allow "$named recognises the seat that owns it" "$repo" seat-owner-1
done

# A session whose ONLY claim is a legitimately-owned runtime lock still holds a
# live claim. Nagging it to "raise a marker" is the cry-wolf case the hook's own
# preamble warns about, and it would fire on every commit under a durable lock.
repo="$(new_repo own-derived-not-nagged)"
stage_file "$repo" src/hunk.ts
write_derived_marker "$repo" owner-run-1 false '' src/hunk.ts
expect_allow 'a session owning only a runtime lock is not nagged' "$repo" owner-run-1
if [[ "$hook_output" == *'no live claim of yours'* ]]; then
  printf 'FAIL: session holding its own runtime lock was nagged as markerless\n%s\n' \
    "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))

# THE 15-MINUTE LEASE CEILING. Nothing bounded a lease before: `expires: 2099-…`
# held a path for 73 years, and an owner-id claim has no pid to decay it, so the
# lease was its only decay signal and that signal was unbounded. The cap is
# anchored to `started` — anchoring to "now" would push the expiry forward on
# every evaluation and never expire at all.
set_marker_started() {
  sed -E "s|^started:.*|started: $2|" "$1" > "$1.next" && mv "$1.next" "$1"
}
iso_ago() { date -u -v-"$1"M +%Y-%m-%dT%H:%M:%SZ; }

repo="$(new_repo lease-within-ceiling)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$foreign_pid" src/manual.ts
set_marker_started "$repo/.WORK-IN-PROGRESS-manual-test.md" "$(iso_ago 5)"
expect_block 'a claim inside its 15m ceiling still blocks' "$repo"

repo="$(new_repo lease-past-ceiling)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$foreign_pid" src/manual.ts
set_marker_started "$repo/.WORK-IN-PROGRESS-manual-test.md" "$(iso_ago 20)"
expect_allow 'a 2099 lease decays at 15m from started' "$repo"
if [[ "$hook_output" != *'15m ceiling'* ]]; then
  printf 'FAIL: ceiling decay was not explained to its owner\n%s\n' "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))

# The explanation must NOT fire when the claim died on its own stated expiry —
# otherwise every long-dead marker nags every commit by everyone forever.
repo="$(new_repo lease-own-expiry)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$foreign_pid" src/manual.ts
set_marker_started "$repo/.WORK-IN-PROGRESS-manual-test.md" "$(iso_ago 20)"
expire_marker "$repo/.WORK-IN-PROGRESS-manual-test.md"
expect_allow 'a claim past its own expires decays quietly' "$repo"
if [[ "$hook_output" == *'15m ceiling'* ]]; then
  printf 'FAIL: ceiling note fired for a claim that died on its own expiry\n%s\n' \
    "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))

# An unbounded lease with no readable start cannot be capped at all.
repo="$(new_repo lease-unbounded-no-start)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$foreign_pid" src/manual.ts
sed '/^started:/d' "$repo/.WORK-IN-PROGRESS-manual-test.md" > "$repo/m.next"
mv "$repo/m.next" "$repo/.WORK-IN-PROGRESS-manual-test.md"
expect_allow 'a 2099 lease with no started cannot be bounded, so it decays' "$repo"

# ...but a SHORT lease needs no start to be inside the ceiling.
repo="$(new_repo lease-short-no-start)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$foreign_pid" src/manual.ts
sed '/^started:/d' "$repo/.WORK-IN-PROGRESS-manual-test.md" > "$repo/m.next"
mv "$repo/m.next" "$repo/.WORK-IN-PROGRESS-manual-test.md"
set_marker_expires "$repo/.WORK-IN-PROGRESS-manual-test.md" "$(date -u -v+5M +%Y-%m-%dT%H:%M:%SZ)"
expect_block 'a short lease needs no started to hold' "$repo"

# A seat claim is capped too — it is the case with no pid to decay it.
repo="$(new_repo lease-seat-capped)"
stage_file "$repo" src/manual.ts
write_owner_id_marker "$repo" seat-owner-1 src/manual.ts
set_marker_started "$repo/.WORK-IN-PROGRESS-manual-test.md" "$(iso_ago 20)"
expect_allow 'a seat claim decays at the ceiling like any other' "$repo" seat-owner-2

# A RUNTIME lease is NOT capped: durable lock authority owns its lifetime, and
# clamping a projection would decay a lock its owner still holds.
repo="$(new_repo lease-derived-uncapped)"
stage_file "$repo" src/hunk.ts
write_derived_marker "$repo" owner-run false '' src/hunk.ts
expect_block 'a runtime projection is not subject to the manual ceiling' "$repo"

# Section 4's mirror: the hook must say something to a session that is committing
# with no claim of its own. Path COVERAGE is deliberately not checked here —
# work-guard section 6 already owns "dirty path no live claim covers"; this owns
# the orthogonal case of no claim existing at all, reported immediately rather
# than after ORPHAN_WARN_MS.
repo="$(new_repo markerless-commit)"
stage_file "$repo" src/manual.ts
expect_allow 'a markerless commit is nagged, never blocked' "$repo"
if [[ "$hook_output" != *'no live claim of yours'* ]]; then
  printf 'FAIL: markerless commit produced no marker nag\n%s\n' "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))

repo="$(new_repo claimed-commit-quiet)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$$" src/manual.ts
expect_allow 'a session holding its own live claim is not nagged' "$repo"
if [[ "$hook_output" == *'no live claim of yours'* ]]; then
  printf 'FAIL: marker nag fired at a session that holds a live claim\n%s\n' \
    "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))

# A claim of yours that has DECAYED must not buy silence — that is the forgot-to-
# renew case, and it is exactly when the nag is worth having.
repo="$(new_repo own-decayed-claim-nagged)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$$" src/manual.ts
expire_marker "$repo/.WORK-IN-PROGRESS-manual-test.md"
expect_allow 'a decayed own claim still earns the markerless nag' "$repo"
if [[ "$hook_output" != *'no live claim of yours'* ]]; then
  printf 'FAIL: decayed own claim silenced the marker nag\n%s\n' "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))

sleep 300 &
dead_runtime_pid=$!
kill "$dead_runtime_pid"
wait "$dead_runtime_pid" 2>/dev/null || true
repo="$(new_repo expired-dead-derived)"
stage_file "$repo" src/hunk.ts
write_derived_marker "$repo" owner-dead false '' src/hunk.ts "$dead_runtime_pid"
expire_marker "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md"
expect_block 'dead derived owners remain blocked until authority reconciliation' "$repo"
if [[ "$hook_output" != *'needs TaskWraith recovery reconciliation'* ]] ||
  [[ "$hook_output" == *adoptable* ]] ||
  [[ "$hook_output" == *'then delete it'* ]]; then
  printf 'FAIL: dead derived marker lacked safe recovery guidance\n%s\n' \
    "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))
expect_allow 'the exact inherited derived owner remains authorized after leader death' \
  "$repo" owner-dead

repo="$(new_repo derived-missing-owner)"
stage_file "$repo" docs/readme.md
write_derived_marker "$repo" owner-missing false '' src/hunk.ts
sed '/^lockOwnerId:/d' "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md" \
  > "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md.next"
mv "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md.next" \
  "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md"
expect_block 'derived markers with missing owner ids fail closed for the checkout' "$repo"

repo="$(new_repo derived-missing-birth)"
stage_file "$repo" docs/readme.md
write_derived_marker "$repo" owner-missing-birth false '' src/hunk.ts
sed '/^birthReceiptHash:/d' "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md" \
  > "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md.next"
mv "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md.next" \
  "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md"
expect_block 'derived markers with missing birth receipts fail closed for the checkout' "$repo"

repo="$(new_repo derived-invalid-pid)"
stage_file "$repo" docs/readme.md
write_derived_marker "$repo" owner-invalid-pid false '' src/hunk.ts
sed -E 's/^pid:.*/pid: not-a-pid/' "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md" \
  > "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md.next"
mv "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md.next" \
  "$repo/.WORK-IN-PROGRESS-taskwraith-runtime-test.md"
expect_block 'derived markers with invalid pids fail closed for the checkout' "$repo"

repo="$(new_repo deleted-file)"
git -C "$repo" rm -q -- src/hunk.ts
write_derived_marker "$repo" owner-delete false '' src/hunk.ts
expect_block 'file claims cover staged deletions' "$repo"

repo="$(new_repo renamed-source)"
git -C "$repo" mv -- src/hunk.ts docs/moved.ts
write_derived_marker "$repo" owner-rename-source false '' src/hunk.ts
expect_block 'file claims cover rename sources' "$repo"

repo="$(new_repo renamed-destination)"
git -C "$repo" mv -- src/hunk.ts docs/moved.ts
write_derived_marker "$repo" owner-rename-destination false '' docs/moved.ts
expect_block 'file claims cover rename destinations' "$repo"

repo="$(new_repo tree-rename-out)"
git -C "$repo" mv -- src/lib/deep/file.ts docs/moved.ts
write_derived_marker "$repo" owner-tree-rename false src/lib ''
expect_block 'tree claims cover files renamed out of the tree' "$repo"

repo="$(new_repo unicode-path)"
path='src/café.ts'
stage_new_file "$repo" "$path"
write_derived_marker "$repo" owner-unicode false '' "$path"
expect_block 'path digests preserve Unicode filenames' "$repo"

repo="$(new_repo leading-dash-path)"
path='-locked.ts'
stage_new_file "$repo" "$path"
write_derived_marker "$repo" owner-leading-dash false '' "$path"
expect_block 'path digests preserve leading-dash filenames' "$repo"

# Win32 cannot create these exact filename bytes, so the hook cannot receive
# them from a real Windows worktree. POSIX hosts retain the digest coverage.
if [ "$host_platform" != 'win32' ]; then
  repo="$(new_repo trailing-space-path)"
  path='src/trailing-space.ts '
  stage_new_file "$repo" "$path"
  write_derived_marker "$repo" owner-trailing-space false '' "$path"
  expect_block 'path digests preserve trailing-space filenames' "$repo"

  repo="$(new_repo newline-path)"
  path=$'src/line\nbreak.ts'
  stage_new_file "$repo" "$path"
  write_derived_marker "$repo" owner-newline false '' "$path"
  expect_block 'path digests preserve newline filenames' "$repo"

  repo="$(new_repo tab-backslash-path)"
  path=$'src/tab\tand\\backslash.ts'
  stage_new_file "$repo" "$path"
  write_derived_marker "$repo" owner-controls false '' "$path"
  expect_block 'path digests preserve tab and backslash filenames' "$repo"
fi

repo="$(new_repo typechange)"
symlink_blob="$(
  printf '%s' '../docs/readme.md' | git -C "$repo" hash-object -w --stdin
)"
git -C "$repo" update-index --cacheinfo 120000 "$symlink_blob" src/hunk.ts
write_derived_marker "$repo" owner-typechange false '' src/hunk.ts
expect_block 'file claims cover staged type changes' "$repo"

repo="$(new_repo missing-sha-backend)"
stage_file "$repo" src/hunk.ts
write_derived_marker "$repo" owner-no-sha false '' src/hunk.ts
run_hook_without_sha256 "$repo"
if [ "$hook_status" -eq 1 ] && [[ "$hook_output" == *'SHA-256 unavailable'* ]]; then
  assertions=$((assertions + 1))
else
  printf 'FAIL: missing SHA-256 backend did not fail closed (status=%s)\n%s\n' \
    "$hook_status" "$hook_output" >&2
  exit 1
fi

repo="$(new_repo manual-override)"
stage_file "$repo" src/manual.ts
write_manual_marker "$repo" "$foreign_pid" src/manual.ts
if (
  cd "$repo"
  TW_ALLOW_CLAIMED=1 .githooks/pre-commit
) >/dev/null 2>&1; then
  assertions=$((assertions + 1))
else
  printf 'FAIL: TW_ALLOW_CLAIMED no longer overrides a manual claim\n' >&2
  exit 1
fi

# ── gitignored force-add guard ──────────────────────────────────────────────
# `git add -f` is the only way a gitignored path reaches the index, and this
# hook runs AFTER staging — at which point a plain `git check-ignore` reports
# the path as NOT ignored, because it is now in the index. `--no-index` is
# therefore load-bearing: without it the guard is vacuous and blocks nothing
# while looking entirely correct. The first case below is what proves it fires;
# the third is what proves it does not break the docs/how-to workflow.
setup_ignored_repo() {
  local name="$1" repo
  repo="$(new_repo "$name")"
  printf 'private/\n' > "$repo/.gitignore"
  mkdir -p "$repo/private"
  printf 'tracked despite the rule\n' > "$repo/private/force-added.md"
  git -C "$repo" add .gitignore
  git -C "$repo" add -f -- private/force-added.md
  git -C "$repo" commit -qm ignored-baseline --no-verify
  printf '%s' "$repo"
}

stage_ignored_new_file() {
  local repo="$1"
  mkdir -p "$repo/private"
  printf 'e2ee review findings\n' > "$repo/private/dossier.md"
  git -C "$repo" add -f -- private/dossier.md
}

repo="$(setup_ignored_repo ignored-add-blocks)"
stage_ignored_new_file "$repo"
expect_block 'force-adding a gitignored path blocks' "$repo"

repo="$(setup_ignored_repo ignored-add-ordinary)"
stage_new_file "$repo" src/ordinary.ts
expect_allow 'an ordinary new file is unaffected' "$repo"

# `git add -- <path>` REFUSES a tracked-but-ignored file ("paths are ignored,
# use -f"); only `-u` or `-f` stages it. That is the real docs/how-to workflow,
# so it is what this case must exercise — the guard must let the resulting
# status-M change through untouched.
repo="$(setup_ignored_repo ignored-add-tracked-modify)"
printf 'staged change\n' >> "$repo/private/force-added.md"
git -C "$repo" add -u -- private/force-added.md
expect_allow 'modifying an already-tracked ignored path still passes' "$repo"

# The same edit staged with -f is still a modification, not an addition, so it
# must also pass — otherwise the guard would fire on ordinary docs edits.
repo="$(setup_ignored_repo ignored-modify-via-force)"
printf 'staged change\n' >> "$repo/private/force-added.md"
git -C "$repo" add -f -- private/force-added.md
expect_allow 'a -f staged MODIFICATION is not an addition and still passes' "$repo"

repo="$(setup_ignored_repo ignored-add-tracked-delete)"
git -C "$repo" rm -q -- private/force-added.md
expect_allow 'deleting an already-tracked ignored path still passes' "$repo"

# The two overrides must stay distinct. Overriding a coordination conflict must
# never also authorise publishing a private document to a public remote.
repo="$(setup_ignored_repo ignored-add-claimed-override)"
stage_ignored_new_file "$repo"
if (
  cd "$repo"
  TW_ALLOW_CLAIMED=1 .githooks/pre-commit
) >/dev/null 2>&1; then
  printf 'FAIL: TW_ALLOW_CLAIMED must NOT bypass the gitignored force-add guard\n' >&2
  exit 1
else
  assertions=$((assertions + 1))
fi

repo="$(setup_ignored_repo ignored-add-own-override)"
stage_ignored_new_file "$repo"
if (
  cd "$repo"
  TW_ALLOW_IGNORED_ADD=1 .githooks/pre-commit
) >/dev/null 2>&1; then
  assertions=$((assertions + 1))
else
  printf 'FAIL: TW_ALLOW_IGNORED_ADD no longer overrides the gitignored force-add guard\n' >&2
  exit 1
fi

write_monolith() {
  local repo="$1" body="$2"
  node -e "process.stdout.write('$body\\n'.repeat(6000))" > "$repo/src/monolith.css"
}

# Section 2's REMEDY, not just its trigger. `git add -p` cannot be completed
# safely in this repo: a pathspec commit rebuilds the tree from HEAD plus the
# WORKING-TREE content of the named path, discarding the hunk selection, and a
# bare commit takes the whole shared index. It is also interactive, which the
# agent harnesses this hook exists to bind cannot run.
repo="$(new_repo monolith-advice)"
write_monolith "$repo" '.a{color:red}'
git -C "$repo" add src/monolith.css
git -C "$repo" commit -qm monolith
write_monolith "$repo" '.b{color:blue}'
git -C "$repo" add src/monolith.css
expect_allow 'whole-file staging of a monolith is flagged' "$repo"
if [[ "$hook_output" != *'staged all of'* ]]; then
  printf 'FAIL: monolith staging was not flagged\n%s\n' "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))
if [[ "$hook_output" == *'add -p'* ]]; then
  printf 'FAIL: section 2 still recommends `git add -p`, which cannot be completed safely\n%s\n' \
    "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))
if [[ "$hook_output" != *'GIT_INDEX_FILE'* ]]; then
  printf 'FAIL: section 2 does not point at the private-index route\n%s\n' \
    "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))

# An unstaged remainder means hunks were picked — the healthy case. Stay quiet.
repo="$(new_repo monolith-partial)"
write_monolith "$repo" '.a{color:red}'
git -C "$repo" add src/monolith.css
git -C "$repo" commit -qm monolith
write_monolith "$repo" '.b{color:blue}'
git -C "$repo" add src/monolith.css
printf '.trailing{color:green}\n' >> "$repo/src/monolith.css"
expect_allow 'a monolith with an unstaged remainder stays quiet' "$repo"
if [[ "$hook_output" == *'staged all of'* ]]; then
  printf 'FAIL: monolith note fired despite an unstaged remainder\n%s\n' \
    "$hook_output" >&2
  exit 1
fi
assertions=$((assertions + 1))

printf 'pre-commit marker tests passed (%s assertions)\n' "$assertions"
