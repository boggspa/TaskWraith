#!/usr/bin/env node

/**
 * Platform-portability guard — mechanical prevention of the defect class that
 * turned the 1.9.0 candidate red on three of five legs.
 *
 * PRECEDENT (2026-07, v1.9.0): five separate defects took out the Linux,
 * Windows, and macOS-Intel legs. Every one of them lived in a feature that
 * landed after v1.8.9 and had therefore never executed on those platforms, and
 * every one was a *test asserting the runner's operating system* rather than
 * asserting the code:
 *
 *   | class            | example                                              |
 *   | ---------------- | ---------------------------------------------------- |
 *   | POSIX modes      | OutlookCredentialStore expected 0600; NTFS gives 0666 |
 *   | interpreters     | '#!/bin/sh' -> realpath('D:\bin\sh') ENOENT           |
 *   | path separators  | expected '/registered/...', got 'D:\...'              |
 *   | keyring/backends | PiKeyStore degraded to encryptionUnavailable          |
 *   | inode policy     | identity-swap reused a freed inode (ext4 vs APFS)     |
 *
 * The local gate runs on macOS, so macOS is the one platform that cannot
 * observe any of them. This guard makes the macOS gate fail on the greppable
 * signature of each class instead.
 *
 * DESIGN — precision over breadth. A noisy guard gets disabled, so every rule
 * is calibrated against the real corpus rather than written from theory. The
 * decisive example: `fs.statSync(p).mode & 0o777` reads the *real* filesystem
 * and is platform-shaped, while `fakeFs.entries.get(p)?.mode` reads an
 * in-memory double and is not. A rule that cannot tell those apart would flag
 * ~230 lines, almost all of them safe. RULE_REAL_FS_MODE flags only the first.
 *
 * RATCHET — rules whose violations already exist carry a per-file baseline in
 * platform-portability-baseline.json. The count for a file may shrink, never
 * grow, and a rule with no baseline entry fails on first sight. Regenerate the
 * baseline deliberately with --update-baseline; it is a record of accepted
 * debt, not a silencer.
 *
 * NEVER PASS VACUOUSLY — a scan that matches nothing because it failed to look
 * is indistinguishable from a clean tree, and that failure mode has already
 * been observed in this repository (a 1,380-path argument list silently
 * exceeded the shell limit and reported zero hits for patterns with hundreds of
 * real matches). This guard therefore asserts it found a plausible number of
 * test files and that each rule's self-test still matches its own fixture,
 * before it is allowed to report success.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO_ROOT = path.join(__dirname, '..')
const BASELINE_PATH = path.join(__dirname, 'platform-portability-baseline.json')
const BASELINE_REPO_PATH = 'scripts/platform-portability-baseline.json'
const SCHEMA_VERSION = 1

/** Below this, assume discovery broke rather than that the repo shrank. */
const MIN_EXPECTED_TEST_FILES = 500

/**
 * A platform guard in scope means the assertion is deliberate. Checked over a
 * lookback window because the guard usually wraps the block, not the line.
 */
const PLATFORM_GUARD_PATTERN =
  /process\.platform|os\.platform\(\)|\bskipIf\b|\brunIf\b|isWindows|isLinux|isDarwin|@portability-ok/
const GUARD_LOOKBACK_LINES = 12

/**
 * File-level opt-out, reserved for FIXTURE CORPORA — files that contain the
 * offending patterns as *data* rather than as assertions about this machine.
 * In practice that is this guard's own companion test, whose fixtures must by
 * construction be examples of every pattern the rules detect; without this it
 * flags itself seven times. Do not use it to silence a real test: the per-block
 * `@portability-ok` annotation exists for deliberate platform assertions, and
 * unlike this one it forces the author to mark the specific line.
 */
const FIXTURE_CORPUS_PRAGMA = '@portability-fixtures'

const RULES = [
  {
    id: 'real-fs-mode',
    summary: 'POSIX file-mode assertion against the real filesystem',
    why: 'NTFS reports 0666 where POSIX reports 0600; macOS enforces modes so the local gate cannot see this.',
    remedy:
      "Guard with process.platform !== 'win32', or assert the intent (readable-by-owner-only) rather than the octal.",
    // Real fs stat, then an octal comparison. In-memory doubles do not match
    // because they are not reached through a stat call.
    test: (line) =>
      /(?:^|[^A-Za-z0-9_$])(?:l?stat|fstat)Sync\s*\([^;]*\)\s*(?:\.|\?\.)\s*mode/.test(line) &&
      /0o[0-7]{3,4}/.test(line),
    fixture: 'expect(fs.statSync(p).mode & 0o777).toBe(0o600)'
  },
  {
    id: 'posix-shebang',
    summary: 'POSIX shebang written into a test fixture',
    why: "Windows has no /bin/sh; realpath('D:\\bin\\sh') raises ENOENT when the fixture is executed.",
    remedy: 'Write a platform-appropriate launcher, or skip the executable-fixture case off POSIX.',
    test: (line) => /#!\/(?:bin|usr)\//.test(line),
    fixture: "writeFileSync(target, '#!/bin/sh\\necho hi\\n')"
  },
  {
    id: 'system-path-literal-expectation',
    summary: 'Expectation compares against an absolute POSIX system path',
    why: 'path.resolve() is platform-shaped; these directories do not exist on Windows.',
    remedy: 'Build the expected value with path.join/path.resolve from the same root as the code.',
    // Deliberately limited to system directories. Fixture roots such as /tmp,
    // /repo and /ws are inputs to in-memory doubles and are not defects.
    test: (line) =>
      /\.(?:toBe|toEqual|toStrictEqual|toContain)\(\s*['"`]\/(?:bin|usr|etc|var|opt|sbin)\//.test(
        line
      ),
    fixture: "expect(resolved).toBe('/usr/local/bin/tool')"
  },
  {
    id: 'executable-path-literal',
    summary: 'Absolute POSIX interpreter or binary path passed to a process call',
    why: 'The path does not resolve on Windows; the spawn fails rather than the assertion.',
    remedy: 'Resolve the interpreter per platform, or gate the case on POSIX.',
    test: (line) =>
      /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|realpath|realpathSync)\s*\(\s*['"`]\/(?:bin|usr|sbin)\//.test(
        line
      ),
    fixture: "spawnSync('/bin/sh', args)"
  },
  {
    id: 'inode-identity',
    summary: 'Assertion that an inode DIFFERS after a file was recreated',
    why: 'ext4 reuses a freed inode eagerly where APFS reuses lazily, so an unlink-then-create can hand back the same st_ino on Linux and a different one on macOS.',
    remedy:
      'Distinguish the files by content or an explicit identity token. If the recreate is a rename or copy rather than an unlink, the inode cannot be reused — say so in a comment and annotate @portability-ok.',
    // Narrowed 2026-07-30 after reviewing every hit in the corpus. Two shapes
    // are provably portable and were removed from scope:
    //   - EQUALITY assertions (`.ino).toBe(...)`) — an in-place write never
    //     changes the inode on any filesystem.
    //   - Difference after a RENAME — rename allocates the new inode before
    //     freeing the old one, so reuse cannot occur. Only unlink-then-create
    //     frees an inode that ext4 can immediately hand back.
    // The mechanism is not visible on the assertion line, so the rule flags
    // difference-assertions and the reviewer confirms which shape it is. All
    // four hits in the corpus at time of writing were rename-based and safe.
    test: (line) => /\.ino\b[^\n]*\)\s*\.not\s*\.\s*(?:toBe|toEqual|toStrictEqual)\(/.test(line),
    fixture: 'expect(after.ino).not.toBe(before.ino)'
  },
  {
    id: 'encryption-availability',
    summary: 'Assertion that OS credential encryption is available',
    why: 'Headless Linux has no libsecret, so safeStorage degrades and the assertion fails there only.',
    remedy: 'Assert the degraded path is handled, rather than that encryption is present.',
    test: (line) =>
      /isEncryptionAvailable[^\n]*\)\s*\.toBe\(\s*true\s*\)/.test(line) ||
      /encryptionUnavailable[^\n]*\)\s*\.toBe\(\s*false\s*\)/.test(line),
    fixture: 'expect(safeStorage.isEncryptionAvailable()).toBe(true)'
  },
  {
    id: 'buffer-structural-equality',
    summary: 'Binary buffer compared with toEqual',
    why: "vitest's structural differ walks the buffer byte by byte: 1961ms on a Mac Studio for the provider-logo set, a hard timeout on the Intel runner.",
    remedy: 'Use expect(a.equals(b)).toBe(true) — 2ms for the same comparison.',
    // Identifier must read as binary (buf/buffer/bytes only — 'png'/'logo'
    // match filename arrays, which are cheap to diff and not the defect), and
    // the comparand must not be an inline array or string literal.
    test: (line) =>
      /expect\(\s*[A-Za-z_$][A-Za-z0-9_$.]*(?:[Bb]uf(?:fer)?|[Bb]ytes)[A-Za-z0-9_$.]*\s*\)\s*\.toEqual\(\s*(?![['"`])/.test(
        line
      ),
    fixture: 'expect(logoBuffer).toEqual(expectedBuffer)'
  }
]

/**
 * Discovery MUST include untracked files. `git ls-files` alone lists only
 * TRACKED paths, so a brand-new test file — the single most likely way a new
 * violation enters the repo — would be invisible and the gate would pass with
 * the violation sitting in the working tree. That defect was present in this
 * guard's first version and was caught only by testing the failure path with a
 * bare exit code. `--cached --others --exclude-standard` adds untracked files
 * while still honouring .gitignore, so node_modules and build output stay out.
 */
function listTestFiles() {
  const out = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '*.test.ts',
      '*.test.tsx',
      '*.spec.ts',
      '*.spec.tsx'
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  return [...new Set(out.split('\0').filter(Boolean))]
}

function selfTest() {
  // A rule that no longer matches its own fixture has been broken by an edit
  // and would silently stop protecting anything.
  for (const rule of RULES) {
    if (!rule.test(rule.fixture)) {
      throw new Error(
        `platform-portability-guard: rule "${rule.id}" no longer matches its own fixture — the rule is broken, not the tree`
      )
    }
  }
}

/** Pure, source-in/findings-out. Kept separate from disk access so the rules
 *  can be exercised against inline fixtures rather than the live tree. */
function findViolationsInSource(source, repoPath) {
  const findings = []
  if (source.includes(FIXTURE_CORPUS_PRAGMA)) return findings
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line || line.trimStart().startsWith('//')) continue
    for (const rule of RULES) {
      if (!rule.test(line)) continue
      const windowStart = Math.max(0, i - GUARD_LOOKBACK_LINES)
      const context = lines.slice(windowStart, i + 1).join('\n')
      if (PLATFORM_GUARD_PATTERN.test(context)) continue
      findings.push({ rule: rule.id, file: repoPath, line: i + 1, text: line.trim() })
    }
  }
  return findings
}

function scan(files) {
  const findings = []
  for (const repoPath of files) {
    let text
    try {
      text = fs.readFileSync(path.join(REPO_ROOT, repoPath), 'utf8')
    } catch (error) {
      throw new Error(`platform-portability-guard: cannot read ${repoPath}: ${error.message}`)
    }
    findings.push(...findViolationsInSource(text, repoPath))
  }
  return findings
}

function tally(findings) {
  const counts = {}
  for (const finding of findings) {
    counts[finding.rule] = counts[finding.rule] || {}
    counts[finding.rule][finding.file] = (counts[finding.rule][finding.file] || 0) + 1
  }
  return counts
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return { schemaVersion: SCHEMA_VERSION, accepted: {} }
  const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `platform-portability-guard: ${BASELINE_REPO_PATH} is schema ${parsed.schemaVersion}, expected ${SCHEMA_VERSION}`
    )
  }
  return parsed
}

function main() {
  const updating = process.argv.includes('--update-baseline')

  selfTest()

  const files = listTestFiles()
  if (files.length < MIN_EXPECTED_TEST_FILES) {
    throw new Error(
      `platform-portability-guard: discovered only ${files.length} test files (expected >= ${MIN_EXPECTED_TEST_FILES}). ` +
        'Discovery is broken; refusing to report a vacuous pass.'
    )
  }

  const findings = scan(files)
  const counts = tally(findings)

  if (updating) {
    fs.writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(
        {
          schemaVersion: SCHEMA_VERSION,
          note: 'Accepted pre-existing violations, per rule and file. Counts may shrink, never grow. Regenerate only with a deliberate decision to accept new debt.',
          generatedFromTestFileCount: files.length,
          accepted: counts
        },
        null,
        2
      )}\n`
    )
    console.log(
      `platform-portability-guard: baseline written for ${findings.length} accepted violation(s) across ${Object.keys(counts).length} rule(s).`
    )
    return
  }

  const baseline = readBaseline()
  const regressions = []
  for (const finding of findings) {
    const allowed = baseline.accepted?.[finding.rule]?.[finding.file] || 0
    const seen = (regressions.seenCounts = regressions.seenCounts || {})
    const key = `${finding.rule}\u0000${finding.file}`
    seen[key] = (seen[key] || 0) + 1
    if (seen[key] > allowed) regressions.push(finding)
  }

  // A baseline entry for a file that is now clean should be removed, so the
  // ratchet cannot silently re-accept a fixed violation later.
  const stale = []
  for (const [ruleId, files_] of Object.entries(baseline.accepted || {})) {
    for (const [file, allowed] of Object.entries(files_)) {
      const actual = counts[ruleId]?.[file] || 0
      if (actual < allowed) stale.push({ ruleId, file, allowed, actual })
    }
  }

  if (regressions.length === 0 && stale.length === 0) {
    console.log(
      `platform-portability-guard: OK — ${files.length} test files scanned, ${findings.length} baselined violation(s), 0 new.`
    )
    return
  }

  if (regressions.length > 0) {
    console.error(
      `\nplatform-portability-guard: ${regressions.length} new platform-dependent assertion(s).\n` +
        'These pass on macOS and fail on Linux or Windows. See the 1.9.0 precedent in this file.\n'
    )
    const byRule = {}
    for (const r of regressions) (byRule[r.rule] = byRule[r.rule] || []).push(r)
    for (const [ruleId, items] of Object.entries(byRule)) {
      const rule = RULES.find((candidate) => candidate.id === ruleId)
      console.error(`  ${ruleId} — ${rule.summary}`)
      console.error(`    why    : ${rule.why}`)
      console.error(`    remedy : ${rule.remedy}`)
      for (const item of items) console.error(`    ${item.file}:${item.line}  ${item.text}`)
      console.error('')
    }
    console.error(
      'If an assertion is deliberate, wrap it in a process.platform guard or annotate the\n' +
        'enclosing block with @portability-ok and say why.\n'
    )
  }

  if (stale.length > 0) {
    console.error(
      'platform-portability-guard: baseline entries are now too generous — tighten them:'
    )
    for (const item of stale) {
      console.error(
        `    ${item.ruleId}  ${item.file}  baseline ${item.allowed}, actual ${item.actual}`
      )
    }
    console.error(`  Run: node ${path.relative(REPO_ROOT, __filename)} --update-baseline\n`)
  }

  process.exitCode = 1
}

module.exports = {
  RULES,
  MIN_EXPECTED_TEST_FILES,
  findViolationsInSource,
  listTestFiles,
  scan,
  selfTest,
  tally
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`platform-portability-guard: ${error.message}`)
    process.exitCode = 1
  }
}
