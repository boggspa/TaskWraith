#!/usr/bin/env node
/*
 * Prettier, scoped to files this working tree actually changed.
 *
 * WHY THIS EXISTS: `npm run format` is `prettier --write .`, and the repo's
 * baseline is ~44% unformatted (1094 of 2472 tracked src ts/tsx files as of
 * 2026-07-25). So a repo-wide write is not a tidy-up — it is a ~30k-line mass
 * reformat that rewrites `git blame` for a thousand files and conflicts with
 * every open branch and fan-out worktree. That has been tripped accidentally
 * more than once. This gives the useful 1% of that command without the blast
 * radius, so nobody has to reach for the repo-wide one.
 *
 * Covers staged, unstaged AND untracked files, because a brand-new file is
 * exactly the case worth formatting before it becomes part of the baseline.
 *
 * `--check` verifies instead of writing, which is what a CI format gate should
 * use: it holds new work to the standard without demanding the backlog be fixed
 * first.
 */

const { execFileSync } = require('child_process')
const { existsSync } = require('fs')

const PRETTIER_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.cjs',
  '.mjs',
  '.css',
  '.json',
  '.md',
  '.yml',
  '.yaml'
])

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function changedFiles() {
  const tracked = git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'])
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
  const unique = new Set([...tracked, ...untracked])
  return [...unique].filter((file) => {
    const dot = file.lastIndexOf('.')
    if (dot < 0) return false
    if (!PRETTIER_EXTENSIONS.has(file.slice(dot))) return false
    // A path can be listed but gone (deleted, or a rename's old side).
    return existsSync(file)
  })
}

const checkOnly = process.argv.includes('--check')
const files = changedFiles()

if (files.length === 0) {
  console.log('[format-changed] no changed files to format')
  process.exit(0)
}

console.log(`[format-changed] ${checkOnly ? 'checking' : 'formatting'} ${files.length} file(s)`)
try {
  execFileSync('npx', ['prettier', checkOnly ? '--check' : '--write', ...files], {
    stdio: 'inherit'
  })
} catch {
  // prettier already printed which files fail; don't bury it in a stack trace.
  process.exit(1)
}
