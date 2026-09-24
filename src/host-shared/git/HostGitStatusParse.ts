/**
 * `git status --porcelain=v1 -z` parsing, ported from the desktop donor
 * (src/main/services/GitService.ts parseStatusPorcelainZ at :1676).
 *
 * THE SUBTLETY WORTH KNOWING: -z output is NUL-separated, and a rename or copy
 * entry is TWO records — the new path in the status record, then the ORIGINAL
 * path as the very next record. A parser that advances by one silently turns the
 * rename source into a phantom untracked file. Hence the += 2 below, and the
 * explicit rename test.
 */

export type HostGitFileKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored'
  | 'conflicted'
  | 'unknown'

export interface HostGitFileStatus {
  readonly path: string
  readonly originalPath?: string
  /** Raw index (staged) status letter. */
  readonly index: string
  /** Raw working-tree (unstaged) status letter. */
  readonly workingTree: string
  readonly kind: HostGitFileKind
  readonly staged: boolean
  readonly unstaged: boolean
}

const CONFLICT_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

export function classifyHostGitStatus(index: string, workingTree: string): HostGitFileKind {
  const pair = `${index}${workingTree}`
  if (CONFLICT_PAIRS.has(pair)) return 'conflicted'
  if (index === '?' || workingTree === '?') return 'untracked'
  if (index === '!' || workingTree === '!') return 'ignored'
  if (index === 'R' || workingTree === 'R') return 'renamed'
  if (index === 'C' || workingTree === 'C') return 'copied'
  if (index === 'A' || workingTree === 'A') return 'added'
  if (index === 'D' || workingTree === 'D') return 'deleted'
  if (index === 'M' || workingTree === 'M') return 'modified'
  return 'unknown'
}

export function parseHostGitStatusPorcelainZ(output: string): HostGitFileStatus[] {
  const entries: HostGitFileStatus[] = []
  const parts = output.split('\0')
  let i = 0
  while (i < parts.length) {
    const entry = parts[i]
    // A porcelain record is 'XY <path>' — anything shorter is padding or the
    // trailing empty segment after the final NUL.
    if (!entry || entry.length < 3) {
      i++
      continue
    }
    const index = entry[0] || ' '
    const workingTree = entry[1] || ' '
    const path = entry.slice(3)
    let originalPath: string | undefined
    if ((index === 'R' || index === 'C') && i + 1 < parts.length) {
      // The NEXT record is the rename/copy source, not a separate file.
      originalPath = parts[i + 1] || undefined
      i += 2
    } else {
      i++
    }
    entries.push({
      path,
      ...(originalPath === undefined ? {} : { originalPath }),
      index,
      workingTree,
      kind: classifyHostGitStatus(index, workingTree),
      staged: index !== ' ' && index !== '?' && index !== '!',
      unstaged: workingTree !== ' ' || index === '?' || index === '!'
    })
  }
  return entries
}
