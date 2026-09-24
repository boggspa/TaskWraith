#!/usr/bin/env node
/*
 * Source-pin ratchet: fails CI when the number of BYTE-EXACT MULTI-LINE source
 * assertions goes UP. It never asks for the backlog to be fixed.
 *
 * THE FAILURE MODE. A test that cannot import its subject reads the file and
 * asserts `toContain` on the text. When the expected string embeds a newline,
 * it pins the formatter's output rather than the code's meaning, so a reindent
 * or a call collapsing onto one line reds a test whose subject never changed.
 * Measured on 2026-09-19: eight such suites were red at once, every one of them
 * from pure reformatting, and three separate pins had to be repaired by hand
 * that day (see also 63f4f200c, "unwind the 1.9.7 ratchet pay-down that broke
 * byte-pinned files").
 *
 * WHAT TO WRITE INSTEAD.
 *   - TypeScript/TSX subject: `MainSourceProbe` (src/main/mainSourceProbe.testutil.ts)
 *     walks the real AST. It anchors on declared names and call structure, and
 *     THROWS when its subject is renamed or deleted rather than quietly passing
 *     — which a text scan cannot do.
 *   - CSS or other non-AST subject: compare with whitespace collapsed on BOTH
 *     sides, so the pin survives reformatting.
 *
 * WHY A RATCHET AND NOT ZERO: the baseline is real work spread over many
 * peer-owned suites, and each migration is semantic — it needs whoever owns the
 * claim to say what the assertion is really for. Demanding zero in one commit
 * would mean rewriting dozens of other sessions' tests at once. The ratchet
 * gets the useful property (new pins are written the durable way) without that.
 *
 * NOTE ON DIRECTION: collapsing whitespace makes a match MORE likely, so a
 * `not.toContain` converted that way can start failing where it used to pass.
 * Convert negatives deliberately, never mechanically.
 *
 * When the count drops, lower the baseline in the same commit:
 *   npm run guard:source-pins -- --write
 */

const { execFileSync } = require('child_process')
const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')

const BASELINE_PATH = join(__dirname, 'source-pin-baseline.json')

/** A test only pins SOURCE when it reads a file as text. */
const READS_SOURCE = /readFileSync\s*\(/

/**
 * `toContain('...\n...')` / `toContain("...\n...")` — an escaped newline inside
 * a quoted expected string.
 */
const QUOTED_MULTILINE = /\.toContain\(\s*(['"])(?:\\.|(?!\1)[^\\])*?\\n/g

/** toContain(`...`) whose template literal spans more than one physical line. */
const TEMPLATE_MULTILINE = /\.toContain\(\s*`[^`]*\n[^`]*`/g

function trackedTestFiles() {
  return execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function countIn(source) {
  if (!READS_SOURCE.test(source)) return 0
  const quoted = source.match(QUOTED_MULTILINE)
  const template = source.match(TEMPLATE_MULTILINE)
  return (quoted ? quoted.length : 0) + (template ? template.length : 0)
}

function scan(files) {
  const byFile = []
  let total = 0
  for (const file of files) {
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const count = countIn(source)
    if (count > 0) {
      byFile.push({ file, count })
      total += count
    }
  }
  byFile.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
  return { byFile, total, considered: files.length }
}

function main() {
  const write = process.argv.includes('--write')
  const { byFile, total, considered } = scan(trackedTestFiles())
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))

  if (write) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ ...baseline, byteExactSourcePins: total }, null, 2)}\n`
    )
    console.log(`[source-pin-ratchet] baseline set to ${total}`)
    return
  }

  if (total > baseline.byteExactSourcePins) {
    console.error(
      `[source-pin-ratchet] FAILED — byte-exact multi-line source pins rose from ` +
        `${baseline.byteExactSourcePins} to ${total} (of ${considered} test files considered).`
    )
    console.error('')
    console.error('A newline inside a toContain() expected string pins the formatter, not the')
    console.error('code. Reindenting the subject reds it while nothing about the behaviour moved.')
    console.error('')
    console.error(
      '  TypeScript/TSX subject : use MainSourceProbe (src/main/mainSourceProbe.testutil.ts).'
    )
    console.error(
      '                           It walks the AST and THROWS when its subject is gone.'
    )
    console.error('  CSS or non-AST subject : compare with whitespace collapsed on BOTH sides.')
    console.error('')
    console.error('Highest-count files:')
    for (const entry of byFile.slice(0, 10)) {
      console.error(`  ${String(entry.count).padStart(3)}  ${entry.file}`)
    }
    process.exitCode = 1
    return
  }

  if (total < baseline.byteExactSourcePins) {
    console.log(
      `[source-pin-ratchet] ok — ${total} byte-exact multi-line source pins, ` +
        `BELOW the baseline of ${baseline.byteExactSourcePins}. Lower it in this commit: ` +
        'npm run guard:source-pins -- --write'
    )
    return
  }

  console.log(
    `[source-pin-ratchet] ok — ${total} byte-exact multi-line source pins of ` +
      `${considered} test files considered, at baseline`
  )
}

module.exports = { countIn, scan }

if (require.main === module) main()
