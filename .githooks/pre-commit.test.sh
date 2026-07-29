#!/usr/bin/env bash

set -euo pipefail

hook_source="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pre-commit"
suite_root="$(mktemp -d "${TMPDIR:-/tmp}/taskwraith-pre-commit.XXXXXX")"
foreign_pid=""
assertions=0

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

write_manual_marker() {
  local repo="$1" marker_pid="$2" path="$3"
  printf '%s\n' \
    '---' \
    'session: manual-test' \
    'agent: test-agent' \
    "pid: $marker_pid" \
    'started: 2026-07-29T00:00:00Z' \
    'expires: 2099-07-29T00:00:00Z' \
    "worktree: $repo" \
    'paths:' \
    "  - $path" \
    '---' \
    'manual test marker' > "$repo/.WORK-IN-PROGRESS-manual-test.md"
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

repo="$(new_repo typechange)"
rm -- "$repo/src/hunk.ts"
ln -s ../docs/readme.md "$repo/src/hunk.ts"
git -C "$repo" add -- src/hunk.ts
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

printf 'pre-commit marker tests passed (%s assertions)\n' "$assertions"
