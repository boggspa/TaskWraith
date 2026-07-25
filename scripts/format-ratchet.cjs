#!/usr/bin/env node
/*
 * Formatting ratchet: fails CI when the number of unformatted tracked files goes
 * UP. It never asks for the backlog to be fixed.
 *
 * WHY NOT `format:check` IN CI: that script scopes to staged files, and a CI
 * checkout has nothing staged — it would pass unconditionally, which is worse
 * than no gate because it looks like coverage. A count-based ratchet cannot be
 * vacuous: it compares the whole tree against a committed number.
 *
 * WHY NOT REQUIRE ZERO: the baseline is ~1100 files. Demanding zero means a
 * repo-wide reformat, which rewrites git blame for a thousand files and
 * conflicts with every open branch and fan-out worktree — the exact thing
 * AGENTS.md forbids. The ratchet gets the useful property (new work is
 * formatted) without the destructive one.
 *
 * Respects .prettierignore, so the three files Prettier cannot converge on are
 * excluded and cannot be counted or "fixed" into corruption.
 *
 * When the count drops, lower the baseline in the same commit:
 *   npm run format:ratchet -- --write
 */

const prettier = require('prettier')
const { execFileSync } = require('child_process')
const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')

const BASELINE_PATH = join(__dirname, 'format-baseline.json')
const IGNORE_PATH = '.prettierignore'

function trackedCandidates() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function countUnformatted() {
  const unformatted = []
  let considered = 0
  for (const file of trackedCandidates()) {
    let info
    try {
      info = await prettier.getFileInfo(file, { ignorePath: IGNORE_PATH })
    } catch {
      continue
    }
    if (info.ignored || !info.inferredParser) continue
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    considered += 1
    const config = (await prettier.resolveConfig(file)) || {}
    try {
      const ok = await prettier.check(source, { ...config, filepath: file })
      if (!ok) unformatted.push(file)
    } catch {
      // Unparseable by Prettier is a different problem; not this gate's job.
    }
  }
  return { unformatted, considered }
}

;(async () => {
  const { unformatted, considered } = await countUnformatted()
  const count = unformatted.length

  if (process.argv.includes('--write')) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(
        {
          unformattedFiles: count,
          consideredFiles: considered,
          note: 'Ratchet baseline. Lower this when the count drops; never raise it. See scripts/format-ratchet.cjs.'
        },
        null,
        2
      )}\n`
    )
    console.log(
      `[format-ratchet] baseline written: ${count} unformatted of ${considered} considered`
    )
    return
  }

  let baseline
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).unformattedFiles
  } catch {
    console.error(
      `[format-ratchet] FAILED — missing or unreadable ${BASELINE_PATH}. Recreate with: npm run format:ratchet -- --write`
    )
    process.exit(1)
  }

  if (count > baseline) {
    console.error(
      `[format-ratchet] FAILED — unformatted files rose from ${baseline} to ${count} (of ${considered} considered).`
    )
    console.error(
      '\nFormat the files you changed and nothing else:\n  npm run format            (staged)\n  npm run format -- --working-tree\n\nDo NOT run format:all or a repo-wide Prettier glob to satisfy this gate.'
    )
    process.exit(1)
  }

  if (count < baseline) {
    console.log(
      `[format-ratchet] ok — improved: ${count} unformatted, baseline ${baseline}. Lower it in this commit: npm run format:ratchet -- --write`
    )
    return
  }

  console.log(`[format-ratchet] ok — ${count} unformatted of ${considered} considered, at baseline`)
})()
