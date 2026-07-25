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
 * Defaults to STAGED files only. That is deliberate and it matters in this repo:
 * concurrent sessions routinely have unrelated uncommitted work in the same tree,
 * and formatting the whole working tree would rewrite another session's in-flight
 * files — mixing formatting noise into someone else's diff, which is the exact
 * confusion this script exists to prevent. Staged is the best available proxy for
 * "mine, about to be committed", and it matches the house rule of staging by
 * explicit path and committing in slices.
 *
 * `--working-tree` opts into unstaged and untracked files too, for when you know
 * you are the only session touching the tree.
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

function changedFiles(includeWorkingTree) {
  const staged = git(['diff', '--name-only', '--diff-filter=ACMR', '--cached'])
  const unstaged = includeWorkingTree
    ? [
        ...git(['diff', '--name-only', '--diff-filter=ACMR']),
        ...git(['ls-files', '--others', '--exclude-standard'])
      ]
    : []
  const unique = new Set([...staged, ...unstaged])
  return [...unique].filter((file) => {
    const dot = file.lastIndexOf('.')
    if (dot < 0) return false
    if (!PRETTIER_EXTENSIONS.has(file.slice(dot))) return false
    // A path can be listed but gone (deleted, or a rename's old side).
    return existsSync(file)
  })
}

const checkOnly = process.argv.includes('--check')
const includeWorkingTree = process.argv.includes('--working-tree')
const files = changedFiles(includeWorkingTree)
const scope = includeWorkingTree ? 'working tree' : 'staged'

if (files.length === 0) {
  console.log(
    `[format-changed] no ${scope} files to format` +
      (includeWorkingTree ? '' : ' (use --working-tree to include unstaged/untracked)')
  )
  process.exit(0)
}

console.log(
  `[format-changed] ${checkOnly ? 'checking' : 'formatting'} ${files.length} ${scope} file(s)`
)
try {
  execFileSync('npx', ['prettier', checkOnly ? '--check' : '--write', ...files], {
    stdio: 'inherit'
  })
} catch {
  // prettier already printed which files fail; don't bury it in a stack trace.
  process.exit(1)
}
