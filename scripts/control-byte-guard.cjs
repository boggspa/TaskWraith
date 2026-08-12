#!/usr/bin/env node
'use strict'

/**
 * Control-byte guard — no raw C0 control character may live in tracked source.
 *
 * PRECEDENT (2026-07-30). A literal NUL was written into a hash-key builder in
 * `ExternalContributionQueueStore.ts` where a space was intended. Nothing
 * surfaced it:
 *
 *   - `Read` rendered the byte as a SPACE, so reviewing the file looked clean.
 *   - `grep` classified the file as BINARY the moment it contained a NUL and
 *     silently reported nothing across five separate searches — the tool that
 *     would normally find the problem was the tool the problem disabled.
 *   - The code still ran. A dedupe key with a NUL separator works fine until
 *     some other writer of the same key uses the intended separator.
 *
 * The same session then found three more NULs in a test file by the same
 * mechanism. Two authors, four bytes, zero visible signal. This is a defect
 * class that the eye, the editor, and the search tool all fail at together —
 * exactly the shape that deserves a mechanical gate rather than vigilance.
 *
 * SCOPE — the C0 range minus the three whitespace controls every text file
 * legitimately contains:
 *
 *   allowed   : 0x09 TAB, 0x0A LF, 0x0D CR
 *   forbidden : 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F
 *
 * DEL (0x7F) is deliberately NOT in scope. It is equally invisible, but the
 * repository has zero instances and no defect has ever involved it; the rule
 * stays calibrated to the class that actually bit rather than to every byte
 * that theoretically could.
 *
 * NO BASELINE, NO PRAGMA. Every other ratcheted guard in this directory carries
 * accepted debt because its rules are heuristics over real code. This one is
 * not a heuristic: at the time of writing, all 3,671 scannable files contain
 * exactly zero forbidden bytes, and a source file that genuinely needs a raw
 * control character is a BINARY FIXTURE that belongs under an extension outside
 * SCANNED_EXTENSIONS. An escape hatch here would only ever be used to launder a
 * defect. If a real need appears, extend the extension list downward rather
 * than adding an exemption.
 *
 * ESCAPES ARE FINE. `'\u0000'` and `String.fromCharCode(0)` in source are
 * ordinary ASCII characters and are not flagged — only RAW bytes are. That
 * distinction is the entire value of the guard: it sees what the reviewer's
 * screen cannot.
 *
 * NEVER PASS VACUOUSLY. A scan that matched nothing because discovery broke is
 * indistinguishable from a clean tree, and that exact failure has been observed
 * in this repository (an oversized argument list silently reported zero hits
 * for patterns with hundreds of real matches). This guard therefore asserts a
 * plausible file count and re-verifies its own detector against fixtures before
 * it is allowed to report success.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO_ROOT = path.join(__dirname, '..')

/** Below this, assume discovery broke rather than that the repo shrank. */
const MIN_EXPECTED_FILES = 2000

/** Per-file cap so one pathological file cannot bury the rest of the report. */
const MAX_REPORTED_PER_FILE = 20

/**
 * Text-source extensions only. Anything absent from this list — images, fonts,
 * archives, `.icns`, compiled output — is binary by nature and would fail
 * meaninglessly.
 */
const SCANNED_EXTENSIONS = [
  '*.ts',
  '*.tsx',
  '*.js',
  '*.jsx',
  '*.cjs',
  '*.mjs',
  '*.json',
  '*.jsonc',
  '*.md',
  '*.css',
  '*.scss',
  '*.html',
  '*.svg',
  '*.yml',
  '*.yaml',
  '*.sh',
  '*.swift',
  '*.plist',
  '*.pbxproj',
  '*.xcconfig',
  '*.entitlements',
  '*.txt',
  '*.toml'
]

const TAB = 0x09
const LF = 0x0a
const CR = 0x0d

/** C0 names, indexed by byte value. */
const C0_NAMES = [
  'NUL',
  'SOH',
  'STX',
  'ETX',
  'EOT',
  'ENQ',
  'ACK',
  'BEL',
  'BS',
  'TAB',
  'LF',
  'VT',
  'FF',
  'CR',
  'SO',
  'SI',
  'DLE',
  'DC1',
  'DC2',
  'DC3',
  'DC4',
  'NAK',
  'SYN',
  'ETB',
  'CAN',
  'EM',
  'SUB',
  'ESC',
  'FS',
  'GS',
  'RS',
  'US'
]

function isForbiddenByte(byte) {
  return byte <= 0x1f && byte !== TAB && byte !== LF && byte !== CR
}

/**
 * Pure, buffer-in/findings-out. Kept separate from disk access so the detector
 * can be exercised against inline fixtures rather than the live tree.
 *
 * Line/column are 1-indexed and counted in BYTES, which is what an editor's
 * "go to line" needs to land on the offending character. Column is deliberately
 * not code-point-aware: a file containing a raw control byte is already outside
 * the domain where a text-shaped offset would be more useful.
 */
function findControlBytes(buffer, repoPath) {
  const findings = []
  let line = 1
  let lineStart = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i]
    if (byte === LF) {
      line += 1
      lineStart = i + 1
      continue
    }
    if (!isForbiddenByte(byte)) continue
    if (findings.length >= MAX_REPORTED_PER_FILE) {
      // Stop listing, but say so on the last entry rather than silently
      // trimming — a truncated report that reads as complete is the same
      // failure mode this guard exists to prevent. The flag rides a finding so
      // it survives the flat spread in scan().
      findings[findings.length - 1].truncated = true
      return findings
    }
    findings.push({
      file: repoPath,
      line,
      column: i - lineStart + 1,
      byte,
      name: C0_NAMES[byte] || `0x${byte.toString(16).padStart(2, '0')}`
    })
  }
  return findings
}

/**
 * Discovery MUST include untracked files. `git ls-files` alone lists only
 * TRACKED paths, so a brand-new file — the single most likely way a stray byte
 * enters the repo — would be invisible and the gate would pass with the defect
 * sitting in the working tree. `--cached --others --exclude-standard` adds
 * untracked files while still honouring .gitignore, so node_modules and build
 * output stay out.
 */
function listScannableFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', ...SCANNED_EXTENSIONS],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }
  )
  const deletedOut = execFileSync('git', ['ls-files', '-z', '--deleted', ...SCANNED_EXTENSIONS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024
  })
  const deleted = new Set(deletedOut.split('\0').filter(Boolean))
  return [...new Set(out.split('\0').filter(Boolean))].filter((repoPath) => !deleted.has(repoPath))
}

/**
 * A detector broken by an edit would silently stop protecting anything, and
 * because the expected result is "no findings" it would look identical to a
 * clean tree forever. Both directions are asserted: it must FIND a raw control
 * byte, and it must NOT flag the whitespace controls or an escape sequence.
 */
function selfTest() {
  const dirty = Buffer.from([0x61, 0x00, 0x62])
  const found = findControlBytes(dirty, '<selftest>')
  if (found.length !== 1 || found[0].name !== 'NUL' || found[0].column !== 2) {
    throw new Error(
      'control-byte-guard: detector no longer finds a raw NUL — the guard is broken, not the tree'
    )
  }

  const clean = Buffer.from("const s = '\\u0000'\ttab\r\n// fine\n", 'utf8')
  if (findControlBytes(clean, '<selftest>').length !== 0) {
    throw new Error(
      'control-byte-guard: detector flags TAB/CR/LF or an escape sequence — the guard is broken, not the tree'
    )
  }

  const multiline = Buffer.from([0x61, LF, 0x62, 0x0b, 0x63])
  const second = findControlBytes(multiline, '<selftest>')
  if (second.length !== 1 || second[0].line !== 2 || second[0].name !== 'VT') {
    throw new Error(
      'control-byte-guard: detector mis-reports line numbers — the guard is broken, not the tree'
    )
  }
}

function scan(files) {
  const findings = []
  for (const repoPath of files) {
    let buffer
    try {
      buffer = fs.readFileSync(path.join(REPO_ROOT, repoPath))
    } catch (error) {
      // A path git listed but we cannot read is a broken scan, not a clean
      // file. Symlinks into nowhere are the usual cause and are worth failing on.
      throw new Error(`control-byte-guard: cannot read ${repoPath}: ${error.message}`)
    }
    findings.push(...findControlBytes(buffer, repoPath))
  }
  return findings
}

function main() {
  selfTest()

  const files = listScannableFiles()
  if (files.length < MIN_EXPECTED_FILES) {
    throw new Error(
      `control-byte-guard: discovered only ${files.length} files (expected >= ${MIN_EXPECTED_FILES}). ` +
        'Discovery is broken; refusing to report a vacuous pass.'
    )
  }

  const findings = scan(files)
  if (findings.length === 0) {
    console.log(`control-byte-guard: OK — ${files.length} source files scanned, 0 control bytes.`)
    return
  }

  console.error(
    `\ncontrol-byte-guard: ${findings.length} raw control byte(s) in tracked source.\n\n` +
      'These are INVISIBLE. The editor renders most of them as a space or nothing at\n' +
      'all, and a file containing a NUL is treated as BINARY by grep — so the search\n' +
      'you would normally use to find the problem reports nothing instead.\n'
  )
  const byFile = {}
  for (const finding of findings) (byFile[finding.file] = byFile[finding.file] || []).push(finding)
  for (const [file, items] of Object.entries(byFile)) {
    console.error(`  ${file}`)
    for (const item of items) {
      console.error(
        `    ${item.line}:${item.column}  <${item.name}> (0x${item.byte
          .toString(16)
          .padStart(2, '0')})`
      )
      if (item.truncated) {
        console.error(`    … more than ${MAX_REPORTED_PER_FILE} in this file; listing stopped.`)
      }
    }
  }
  console.error(
    '\n  If the byte is meant to be a separator or a sentinel, write it as an ESCAPE\n' +
      "  ('\\u0000', String.fromCharCode(0)) so it is visible to readers and to grep —\n" +
      '  or, better, pick an encoding that needs no control character at all\n' +
      '  (length-prefixing is what replaced the NUL that motivated this guard).\n' +
      '  If the byte is an accident, delete it: nothing here is allowed to keep one.\n'
  )
  process.exitCode = 1
}

module.exports = {
  C0_NAMES,
  MAX_REPORTED_PER_FILE,
  MIN_EXPECTED_FILES,
  SCANNED_EXTENSIONS,
  findControlBytes,
  isForbiddenByte,
  listScannableFiles,
  scan,
  selfTest
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`control-byte-guard: ${error.message}`)
    process.exitCode = 1
  }
}
