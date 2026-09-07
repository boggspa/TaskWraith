import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  promptFreeReadOnlyShellReason,
  type PromptFreeReadOnlyShellReason
} from './PromptFreeReadOnlyShell'
import { shellCommandFromRawCommand } from './ReadOnlyGitShellCommand'

const SYSTEM_CONFIDENTIAL_INSPECTION_HEADS = new Set([
  'env',
  'printenv',
  'ps',
  'lsof',
  'netstat',
  'whoami',
  'id',
  'groups'
])
const STANDARD_EXECUTABLE_PREFIX =
  /^(?:\/usr\/bin\/|\/bin\/|\/usr\/local\/bin\/|\/opt\/homebrew\/bin\/)/
const WORKSPACE_INSPECTION_HEADS = new Set([
  'pwd',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'readlink',
  'realpath',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'find',
  'sed',
  'jq',
  'git',
  'which',
  'uname',
  'arch',
  'sw_vers'
])
const TRUSTED_EXECUTABLE_DIRECTORIES = [
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/usr/local/bin',
  '/opt/homebrew/bin'
] as const

/**
 * THE OWNER MAY EDIT OR REMOVE ANY ENTRY IN THIS ARRAY — it is deliberately
 * the single, self-contained place this policy lives.
 *
 * Owner decision (2026-09-07): a command the read-only classifier has ALREADY
 * proven non-mutating may read outside the workspace — but only inside the
 * provider WORKING-STATE subtrees named here. This is an ALLOWLIST, not a
 * blocklist: a location nobody thought of stays behind the ordinary approval
 * card instead of being readable by default. WHICH commands count as read-only
 * is untouched; only WHERE a proven read may point.
 *
 * Every entry names a SUBDIRECTORY of a provider root. The provider roots
 * themselves are deliberately absent, because they hold live credentials at
 * their own top level — `~/.gemini/oauth_creds.json`,
 * `~/.gemini/google_accounts.json`,
 * `~/.gemini/jetski-standalone-oauth-token`, `~/.gemini/antigravity-oauth-token`
 * and `~/.gemini/antigravity-cli/antigravity-oauth-token` were all verified
 * present on the owner's host. A single root entry would make every one of
 * them readable with no card, so widen this list one named subtree at a time
 * and never by promoting an entry to its parent.
 *
 * Matching runs against the fully RESOLVED absolute path (`..` rejected
 * outright, symlinks collapsed by `realpath`), never against the raw command
 * token, and only for an existing REGULAR FILE — so no traversal spelling,
 * symlink, or recursive directory walk can carry a read back out of an entry.
 */
const PROMPT_FREE_OUTSIDE_READ_ROOTS: readonly string[] = [
  // Stalled lane read: `antigravity-cli/brain/<uuid>/.system_generated/steps/64/output.txt`.
  '.gemini/antigravity-cli/brain',
  // Stalled lane read: `antigravity-cli/mcp/TaskWraith/ensemble_yield.json`.
  '.gemini/antigravity-cli/mcp',
  '.gemini/antigravity-cli/conversations',
  '.gemini/antigravity-cli/scratch',
  // Stalled lane read: `antigravity/brain/<uuid>/scratch/fix_docs.js`.
  '.gemini/antigravity/brain',
  '.gemini/antigravity/mcp',
  '.gemini/antigravity/conversations',
  '.gemini/antigravity/scratch'
  // `log` subtrees are deliberately ABSENT: verified 2026-09-07 that agy CLI
  // logs carry the signed-in account address and auth state (`email=…`,
  // `authMethod=…`, `loaded token`). No observed lane stall reads a log, so the
  // grant would buy nothing. Re-add both entries here if that changes.
]

/**
 * macOS and Windows resolve paths case-insensitively, so `realpath` hands back
 * whatever case the operand was spelled with rather than the on-disk case.
 * Compare allowlist roots the way the host filesystem does, or
 * `~/.Gemini/antigravity-cli/brain/…` would name an allowlisted file this check
 * could not recognise. The direction of the risk is inverted from a blocklist:
 * a case mismatch can only ever LOSE the grant (→ approval card), never open
 * one, so either answer is fail-closed.
 */
const HOST_PATHS_ARE_CASE_INSENSITIVE =
  process.platform === 'darwin' || process.platform === 'win32'

function comparablePath(value: string): string {
  return HOST_PATHS_ARE_CASE_INSENSITIVE ? value.toLowerCase() : value
}

export interface WorkspaceInspectionShellContext {
  workspacePath?: string | null
  cwd?: string | null
}

export interface WorkspaceInspectionOutsideReadFingerprint {
  resolvedPath: string
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

export interface WorkspaceInspectionExecutionPlan {
  reason: PromptFreeReadOnlyShellReason
  workspaceRealPath: string
  executableRealPath: string
  argv: string[]
  cwd: string
  environment?: Readonly<Record<string, string>>
  unsetEnvironment?: readonly string[]
  outsideReadFingerprints?: readonly WorkspaceInspectionOutsideReadFingerprint[]
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function commandSegments(command: string): string[] | null {
  const segments: string[] = []
  let segment = ''
  let quote: 'single' | 'double' | null = null
  let escaped = false

  const push = (): boolean => {
    const value = segment.trim()
    segment = ''
    if (!value) return false
    segments.push(value)
    return true
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (escaped) {
      if (character === '\n' || character === '\r') return null
      segment += character
      escaped = false
      continue
    }
    if (quote === 'single') {
      segment += character
      if (character === "'") quote = null
      continue
    }
    if (character === '\\') {
      segment += character
      escaped = true
      continue
    }
    if (quote === 'double') {
      segment += character
      if (character === '"') quote = null
      continue
    }
    if (character === "'") {
      quote = 'single'
      segment += character
      continue
    }
    if (character === '"') {
      quote = 'double'
      segment += character
      continue
    }
    // Redirection is deliberately outside the prompt-free tier. The
    // syntax-only classifier may prove a /dev/null redirect non-mutating, but
    // a redirect target is a WRITE path, and this layer resolves read operands
    // rather than taking on another filename grammar. Untouched by the
    // 2026-09-07 read allowlist and by lifting the single-segment cap: both
    // moved READS only, and `||` stays rejected below for the same reason.
    if (character === '<' || character === '>') return null
    if (character === '&') {
      if (command[index + 1] !== '&' || !push()) return null
      index += 1
      continue
    }
    if (character === '|' || character === ';') {
      if (character === '|' && command[index + 1] === '|') return null
      if (!push()) return null
      continue
    }
    if (character === '\n' || character === '\r') return null
    segment += character
  }
  if (quote || escaped || !push()) return null
  return segments
}

interface ShellWord {
  value: string
  hasUnquotedGlob: boolean
  unquotedEqualsExpansion: boolean
  hadShellQuote: boolean
}

function shellWords(segment: string): ShellWord[] | null {
  const words: ShellWord[] = []
  let word = ''
  let started = false
  let hasUnquotedGlob = false
  let unquotedEqualsExpansion = false
  let hadShellQuote = false
  let quote: 'single' | 'double' | null = null
  let escaped = false

  const push = (): void => {
    if (started) {
      words.push({ value: word, hasUnquotedGlob, unquotedEqualsExpansion, hadShellQuote })
    }
    word = ''
    started = false
    hasUnquotedGlob = false
    unquotedEqualsExpansion = false
    hadShellQuote = false
  }

  for (const character of segment) {
    if (escaped) {
      word += character
      started = true
      escaped = false
      continue
    }
    if (quote === 'single') {
      if (character === "'") quote = null
      else word += character
      started = true
      continue
    }
    if (character === '\\') {
      escaped = true
      started = true
      continue
    }
    if (quote === 'double') {
      if (character === '"') quote = null
      else word += character
      started = true
      continue
    }
    if (character === "'") {
      quote = 'single'
      started = true
      hadShellQuote = true
      continue
    }
    if (character === '"') {
      quote = 'double'
      started = true
      hadShellQuote = true
      continue
    }
    if (/\s/.test(character)) {
      push()
      continue
    }
    word += character
    if (character === '=' && word.length === 1) unquotedEqualsExpansion = true
    if (character === '?' || character === '*' || character === '[' || character === '^') {
      hasUnquotedGlob = true
    }
    started = true
  }
  if (quote || escaped) return null
  push()
  return words.length > 0 ? words : null
}

function executableHead(value: string): string {
  return value.replace(STANDARD_EXECUTABLE_PREFIX, '')
}

/**
 * The global syntax-only Git proof rejects every `-C` because it cannot bind
 * the requested repository. This workspace-aware layer can: remove one
 * literal `-C <path>` only for subcommand classification, then validate the
 * original path token below and execute the original argv directly. `-C` names
 * a DIRECTORY, so the 2026-09-07 outside-read allowlist never clears one: it
 * admits resolved regular files only. Kept single-segment on purpose — this
 * rewrite exists to hand ONE normalized git invocation to the syntax-only
 * proof, and a pipeline has no single invocation to normalize.
 */
function gitCommandWithoutWorkspaceC(command: string): string | null {
  const segments = commandSegments(command)
  const words = segments?.length === 1 ? shellWords(segments[0]) : null
  if (
    !words ||
    words.some((word) => word.hadShellQuote) ||
    executableHead(words[0].value) !== 'git'
  ) {
    return null
  }
  const normalized: string[] = [words[0].value]
  let removedC = false
  let index = 1
  for (; index < words.length; index += 1) {
    const token = words[index]
    if (token.value === '-C') {
      if (removedC || token.hasUnquotedGlob || token.unquotedEqualsExpansion) return null
      const target = words[index + 1]
      if (
        !target ||
        target.value.startsWith('-') ||
        target.hasUnquotedGlob ||
        target.unquotedEqualsExpansion
      ) {
        return null
      }
      removedC = true
      index += 1
      continue
    }
    normalized.push(token.value)
    if (!token.value.startsWith('-')) {
      normalized.push(...words.slice(index + 1).map((word) => word.value))
      break
    }
  }
  return removedC ? normalized.join(' ') : null
}

function hasSymlinkFollowingFlags(head: string, args: readonly string[]): boolean {
  if (head === 'grep' || head === 'egrep' || head === 'fgrep') {
    return args.some((token) => /^-[^-]*R/.test(token) || token.startsWith('--d'))
  }
  if (head === 'rg' || head === 'fd') {
    return args.some(
      (token) =>
        /^-[^-]*[Lz]/.test(token) || token.startsWith('--fol') || token.startsWith('--search-z')
    )
  }
  if (head === 'find') return args.includes('-L') || args.includes('-follow')
  if (head === 'tree') {
    return args.some((token) => /^-[^-]*l/.test(token) || token === '--follow-links')
  }
  if (head === 'ls') {
    return args.some((token) => /^-[^-]*L/.test(token) || token.startsWith('--d'))
  }
  if (head === 'du') return args.some((token) => /^-[^-]*[HL]/.test(token))
  return false
}

function exposesProcessEnvironment(head: string, args: readonly string[]): boolean {
  if (head !== 'jq') return false
  return args.some(
    (token) => /\$ENV\b/.test(token) || /(^|[^A-Za-z0-9_$])env(?=$|[^A-Za-z0-9_])/.test(token)
  )
}

function jqLoadsCodeOrExternalFilter(args: readonly string[]): boolean {
  return args.some(
    (token) =>
      /^-[^-]*[fL]/.test(token) ||
      token.startsWith('--from') ||
      token.startsWith('--lib') ||
      token.startsWith('--run-t') ||
      token.startsWith('--rawfile') ||
      token.startsWith('--slurpfile') ||
      token.startsWith('--argfile') ||
      /(^|[^A-Za-z0-9_])(?:include|import|module|modulemeta)(?=$|[^A-Za-z0-9_])/.test(token)
  )
}

function isLongLivedFollowMode(head: string, args: readonly string[]): boolean {
  if (head !== 'tail') return false
  return args.some(
    (token) => /^-[^-]*[fF]/.test(token) || token.startsWith('--f') || token.startsWith('--r')
  )
}

function usesIndirectPathList(head: string, args: readonly string[]): boolean {
  if (head === 'find') return args.some((token) => token.startsWith('-files0'))
  if (head === 'wc') return args.some((token) => token.startsWith('--f'))
  return false
}

function usesFileLoadingOption(head: string, args: readonly string[]): boolean {
  if (head === 'grep' || head === 'egrep' || head === 'fgrep' || head === 'rg') {
    return args.some(
      (token) =>
        /^-[^-]*f/.test(token) ||
        token.startsWith('--file') ||
        token.startsWith('--ignore-f') ||
        token.startsWith('--exclude-f')
    )
  }
  if (head === 'find') {
    return args.some((token) =>
      ['-newer', '-anewer', '-cnewer', '-samefile'].some((option) => token.startsWith(option))
    )
  }
  if (head === 'realpath') {
    return args.some(
      (token) => token.startsWith('--relative-t') || token.startsWith('--relative-b')
    )
  }
  return false
}

function resolveTrustedExecutable(requested: string, workspaceRealPath: string): string | null {
  const candidates = requested.includes('/')
    ? [path.resolve(requested)]
    : TRUSTED_EXECUTABLE_DIRECTORIES.map((directory) => path.join(directory, requested))
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      const realPath = fs.realpathSync(candidate)
      if (!fs.statSync(realPath).isFile() || isInside(workspaceRealPath, realPath)) continue
      return realPath
    } catch {
      // Try the next fixed executable directory.
    }
  }
  return null
}

function gitInspectionEnvironment(): Readonly<Record<string, string>> {
  return {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: '/bin/cat',
    PAGER: '/bin/cat',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'diff.external',
    GIT_CONFIG_VALUE_1: '/usr/bin/false',
    GIT_CONFIG_KEY_2: 'core.pager',
    GIT_CONFIG_VALUE_2: '/bin/cat'
  }
}

function gitSubcommandIndex(argv: readonly string[]): number {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '-c' || token === '-C' || token === '--config-env') {
      index += 1
      continue
    }
    if (token.startsWith('-')) continue
    return index
  }
  return -1
}

function hardenedGitArgv(argv: readonly string[]): string[] {
  const result = [...argv]
  const subcommandIndex = gitSubcommandIndex(result)
  if (subcommandIndex < 0) return result
  const subcommand = result[subcommandIndex]
  const additions: string[] = []
  if (subcommand === 'diff' || subcommand === 'log' || subcommand === 'show') {
    if (!result.includes('--no-ext-diff')) additions.push('--no-ext-diff')
    if (!result.includes('--no-textconv')) additions.push('--no-textconv')
  } else if (subcommand === 'grep' && !result.includes('--no-textconv')) {
    additions.push('--no-textconv')
  }
  result.splice(subcommandIndex + 1, 0, ...additions)
  return result
}

function inspectionUnsetEnvironment(head: string): readonly string[] {
  if (head === 'git') {
    return [
      ...new Set([
        ...Object.keys(process.env).filter((key) => key.startsWith('GIT_')),
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_COMMON_DIR',
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_EXTERNAL_DIFF',
        'GIT_DIFF_OPTS',
        'GIT_CONFIG_PARAMETERS',
        'GIT_CONFIG_GLOBAL',
        'GIT_EXEC_PATH'
      ])
    ]
  }
  if (head === 'rg') return ['RIPGREP_CONFIG_PATH']
  if (head === 'grep' || head === 'egrep' || head === 'fgrep') return ['GREP_OPTIONS']
  return []
}

function possiblePathValue(token: string): string {
  if (!token.startsWith('-')) return token
  const equals = token.indexOf('=')
  const marker = equals >= 0 ? equals : token.startsWith('-') ? token.indexOf(':') : -1
  return marker >= 0 && marker < token.length - 1 ? token.slice(marker + 1) : token
}

function attachedPathOptionValue(head: string, token: string): string | null {
  if (!/^-[^-]/.test(token)) return null
  const shortFlags = token.slice(1)
  const attachedAfter = (letters: string): string | null => {
    for (let index = 0; index < shortFlags.length; index += 1) {
      if (!letters.includes(shortFlags[index])) continue
      const value = shortFlags.slice(index + 1).replace(/^=/, '')
      if (value) return value
    }
    return null
  }
  if (head === 'grep' || head === 'egrep' || head === 'fgrep' || head === 'rg') {
    return attachedAfter('f')
  }
  if (head === 'jq') {
    return attachedAfter('fL')
  }
  return null
}

function existingGlobPrefix(value: string): string {
  const wildcard = value.search(/[?*[]/)
  if (wildcard < 0) return value
  const prefix = value.slice(0, wildcard)
  const separator = prefix.lastIndexOf('/')
  return separator >= 0 ? prefix.slice(0, separator + 1) || '.' : '.'
}

/**
 * `PROMPT_FREE_OUTSIDE_READ_ROOTS`, resolved against this host's home
 * directory. Each entry contributes its lexical location and, when the location
 * exists, its real location too — so a home or provider root that is itself a
 * symlink cannot be spelled around in either direction. `null` means the home
 * directory could not be resolved at all, which fails the whole outside-read
 * allowance closed rather than guessing where the allowlist points.
 */
function promptFreeOutsideReadRoots(): readonly string[] | null {
  let home: string
  try {
    home = fs.realpathSync(os.homedir())
  } catch {
    return null
  }
  const roots: string[] = []
  for (const relativeRoot of PROMPT_FREE_OUTSIDE_READ_ROOTS) {
    const lexical = path.resolve(home, relativeRoot)
    roots.push(lexical)
    try {
      const real = fs.realpathSync(lexical)
      if (real !== lexical) roots.push(real)
    } catch {
      // The subtree does not exist on this host yet. Its lexical root is still
      // recorded, so a read lands inside the allowlist once the provider
      // creates it, without a second policy edit.
    }
  }
  return roots
}

/**
 * May an already-proven read-only command point at this absolute path when it
 * lands OUTSIDE the workspace? Only inside `PROMPT_FREE_OUTSIDE_READ_ROOTS`,
 * and every uncertainty fails closed to the ordinary approval card:
 *
 * - the path must resolve to an EXISTING REGULAR FILE. A directory operand is
 *   walked recursively by `rg`, `grep -r` and `find`, so admitting one would
 *   hand a whole subtree to a single proof;
 * - the RESOLVED path must sit under an allowlisted root. A symlink NAMED
 *   inside one that points at `~/.gemini/oauth_creds.json` resolves straight
 *   back out of the allowlist and keeps its card;
 * - anything unresolvable (missing path, unreadable parent, unresolvable home)
 *   keeps its card.
 */
/**
 * Bytes scanned for credential material before an outside-workspace read is
 * allowed to skip its approval card. Measured 2026-09-07 on this host's
 * `~/.gemini/antigravity-cli/brain`: 9,190 `steps/N/output.txt` files, median
 * 1.9 KB and p95 25 KB, so this ceiling reads the whole of all but a handful
 * and bounds the worst case rather than the common one.
 */
const OUTSIDE_READ_CREDENTIAL_SCAN_BYTES = 256 * 1024

/**
 * Secret shapes that disqualify a file from the prompt-free outside-workspace
 * read tier.
 *
 * The allowlist above was scoped against the wrong datum. Its comment excludes
 * the `log` subtrees because those carry the signed-in account address — true,
 * and that exclusion does hold — but the granted `brain` subtree turned out to
 * carry the credentials themselves: on 2026-09-07, 102 of 9,190
 * `steps/N/output.txt` files held `Authorization`/`Bearer` material, including
 * TaskWraith's own hook bearer token and a GitHub PAT-shaped string. That file
 * shape is exactly the stalled lane read the grant exists to serve, so the
 * grant cannot be narrowed by path without giving the capability back.
 *
 * A path allowlist answers "where may a read point"; this answers "is THIS
 * file safe to hand over without asking". A match is not a refusal — the read
 * falls back to the ordinary approval card, so the user still decides.
 */
const OUTSIDE_READ_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // TaskWraith's own hook bearer token: the sole authenticator on the approval
  // bridge (`AntigravityHookBridge`), so a lane reading it could arbitrate its
  // own tool calls.
  /x-taskwraith-hook-token/i,
  /\bauthorization\s*[:=]/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  // GitHub PAT families (classic, fine-grained, OAuth, refresh, server).
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\b(?:access|refresh|id|bearer)[_-]?token\b/i,
  /\bapi[_-]?key\b/i,
  /\bclient[_-]?secret\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  // JWT: header.payload. prefix is enough; the signature adds nothing here.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./
]

/**
 * True when the file looks like it carries a secret, or when that cannot be
 * determined. Fails CLOSED: an unreadable or unstattable file keeps its card.
 *
 * Residuals, stated rather than implied:
 * - The scan opens, reads, and closes the fd. The consumer (`cat`/`rg`)
 *   reopens the path at spawn. Typed single-segment plans and compiled
 *   `&&`/`;` sequences re-stat and re-scan immediately before spawn
 *   against a fingerprint taken at classify. A swap in the remaining
 *   close→child-open window is still possible; closing it would mean
 *   holding the fd or replacing the child path-open, which this layer
 *   does not do. Pipelines stay env-only and do not get that re-hold.
 * - The regex list is a heuristic. A novel secret shape that matches none
 *   of the patterns stays prompt-free until a pattern is added. A match
 *   still cards; it never refuses.
 * - The first and last 256 KiB are scanned. A secret living only in the
 *   unscanned middle of a file larger than 512 KiB would stay prompt-free.
 */
let outsideReadFingerprintSink: WorkspaceInspectionOutsideReadFingerprint[] | null = null

function scanOpenedOutsideReadForCredentials(handle: number, size: number): boolean {
  const window = Math.min(OUTSIDE_READ_CREDENTIAL_SCAN_BYTES, Math.max(size, 0))
  if (window === 0) return false
  const buffer = Buffer.allocUnsafe(window)
  const headRead = fs.readSync(handle, buffer, 0, window, 0)
  const head = buffer.subarray(0, headRead).toString('utf8')
  if (OUTSIDE_READ_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(head))) return true
  if (size <= OUTSIDE_READ_CREDENTIAL_SCAN_BYTES) return false
  const tailRead = fs.readSync(
    handle,
    buffer,
    0,
    window,
    size - OUTSIDE_READ_CREDENTIAL_SCAN_BYTES
  )
  const tail = buffer.subarray(0, tailRead).toString('utf8')
  return OUTSIDE_READ_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(tail))
}

function inspectOutsideRead(resolvedPath: string): {
  credentialBearing: boolean
  fingerprint: WorkspaceInspectionOutsideReadFingerprint | null
} {
  let handle: number | null = null
  try {
    handle = fs.openSync(resolvedPath, 'r')
    const stats = fs.fstatSync(handle)
    const credentialBearing = scanOpenedOutsideReadForCredentials(handle, stats.size)
    return {
      credentialBearing,
      fingerprint: credentialBearing
        ? null
        : {
            resolvedPath,
            dev: stats.dev,
            ino: stats.ino,
            size: stats.size,
            mtimeMs: stats.mtimeMs
          }
    }
  } catch {
    return { credentialBearing: true, fingerprint: null }
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle)
      } catch {
        // Nothing actionable; the decision above already stands.
      }
    }
  }
}

/**
 * True when every allowlisted outside read still names the same inode that
 * was scanned at classify, and a fresh content scan still finds no known
 * secret shape. Fail-closed: a missing, unreadable, or drifted file is a
 * hold failure — the same class as "the inspection boundary changed", not
 * a new refuse-at-classify. Empty/absent fingerprints hold (no outside
 * read was admitted).
 */
export function workspaceInspectionOutsideReadsStillHold(
  fingerprints: readonly WorkspaceInspectionOutsideReadFingerprint[] | undefined
): boolean {
  if (!fingerprints || fingerprints.length === 0) return true
  for (const fingerprint of fingerprints) {
    let handle: number | null = null
    try {
      handle = fs.openSync(fingerprint.resolvedPath, 'r')
      const stats = fs.fstatSync(handle)
      if (
        stats.dev !== fingerprint.dev ||
        stats.ino !== fingerprint.ino ||
        stats.size !== fingerprint.size ||
        stats.mtimeMs !== fingerprint.mtimeMs
      ) {
        return false
      }
      if (scanOpenedOutsideReadForCredentials(handle, stats.size)) return false
    } catch {
      return false
    } finally {
      if (handle !== null) {
        try {
          fs.closeSync(handle)
        } catch {
          // The hold already failed or succeeded above.
        }
      }
    }
  }
  return true
}

function outsideWorkspaceReadIsPromptFree(absolutePath: string): boolean {
  const allowedRoots = promptFreeOutsideReadRoots()
  if (!allowedRoots) return false
  let resolved: string
  try {
    resolved = fs.realpathSync(absolutePath)
    if (!fs.statSync(resolved).isFile()) return false
  } catch {
    return false
  }
  const comparableResolved = comparablePath(resolved)
  if (!allowedRoots.some((root) => isInside(comparablePath(root), comparableResolved))) return false
  // Path says where a read MAY point; content says whether this particular file
  // may be handed over without asking. Both must pass.
  const inspection = inspectOutsideRead(resolved)
  if (inspection.credentialBearing) return false
  if (outsideReadFingerprintSink && inspection.fingerprint) {
    outsideReadFingerprintSink.push(inspection.fingerprint)
  }
  return true
}

/**
 * The single confinement chokepoint for every operand of a proven read-only
 * command: both the ordinary token walk and the attached `-f<path>` option
 * value go through here, so there is no second route to a path.
 *
 * Workspace-internal behaviour is unchanged. What changed (owner decision, see
 * `PROMPT_FREE_OUTSIDE_READ_ROOTS`) is the former outright rejection of a token
 * landing outside the workspace: it now defers to
 * `outsideWorkspaceReadIsPromptFree`, which admits only the allowlisted
 * provider working-state subtrees. Shape rejections above that deferral —
 * unquoted globs, `=`-expansions, `@`, `~`, `file://` and any literal `..`
 * component — are kept for outside paths exactly as they were, because each is
 * an expansion this layer cannot resolve with confidence.
 */
function tokenPathIsPromptFree(
  word: ShellWord,
  workspaceRealPath: string,
  workspaceLexicalPath: string,
  cwd: string,
  forcePath = false
): boolean {
  const token = word.value
  if (word.hasUnquotedGlob || word.unquotedEqualsExpansion || token.startsWith('@')) return false
  const value = possiblePathValue(token)
  const optionCarriesValue = value !== token
  if (!value || (!forcePath && !optionCarriesValue && value.startsWith('-'))) return true
  if (value.startsWith('~') || value.startsWith('file://')) return false
  if (value.split(/[\\/]/).includes('..')) return false
  const pathValue = existingGlobPrefix(value)
  const lexical = path.isAbsolute(pathValue)
    ? path.resolve(pathValue)
    : path.resolve(cwd, pathValue)
  if (isInside(workspaceRealPath, lexical) || isInside(workspaceLexicalPath, lexical)) {
    try {
      if (isInside(workspaceRealPath, fs.realpathSync(lexical))) return true
    } catch {
      // Non-existent relative patterns/operands remain lexically inside the
      // workspace. Existing parents were checked above for glob prefixes.
      return isInside(workspaceRealPath, lexical)
    }
  }
  return outsideWorkspaceReadIsPromptFree(lexical)
}

/**
 * Add workspace/confidentiality proof to the existing non-mutation parser.
 * The returned reason is suitable for prompt-free audit only while this exact
 * context still revalidates; callers must check again immediately before spawn.
 *
 * A workspace binding is still mandatory (no `workspacePath` → no reason) and
 * the cwd must still resolve inside it. Two things were relaxed, both for
 * READS only: where an operand may point (`tokenPathIsPromptFree`), and how
 * many segments a command may have.
 *
 * A pipeline is prompt-free only when EVERY segment is. `promptFreeReadOnlyShellReason`
 * already proves each `|` segment read-only on its own
 * (`isInspectionShellCommand` → `inspectionPipelineSegmentsOf(...).every(...)`),
 * and the loop below re-runs the full head / trusted-executable / flag / operand
 * checks — including the outside-read allowlist — once per segment. One failing
 * segment fails the whole command. `<`/`>` redirects and `||` are still rejected
 * outright in `commandSegments`.
 */
export function workspaceInspectionShellReason(
  rawCommand: unknown,
  context: WorkspaceInspectionShellContext
): PromptFreeReadOnlyShellReason | null {
  const command = shellCommandFromRawCommand(rawCommand)
  if (command === null || !context.workspacePath) return null
  const reason =
    promptFreeReadOnlyShellReason(command) ||
    (() => {
      const normalizedGitCommand = gitCommandWithoutWorkspaceC(command)
      return normalizedGitCommand ? promptFreeReadOnlyShellReason(normalizedGitCommand) : null
    })()
  if (!reason) return null

  let workspaceRealPath: string
  let workspaceLexicalPath: string
  let cwd: string
  try {
    workspaceLexicalPath = path.resolve(context.workspacePath)
    workspaceRealPath = fs.realpathSync(workspaceLexicalPath)
    cwd = fs.realpathSync(path.resolve(context.cwd || context.workspacePath))
  } catch {
    return null
  }
  if (!isInside(workspaceRealPath, cwd)) return null
  const segments = commandSegments(command)
  if (!segments || segments.length === 0) return null

  for (const segment of segments) {
    const words = shellWords(segment)
    if (!words) return null
    const head = executableHead(words[0].value)
    if (
      !head ||
      head.includes('/') ||
      SYSTEM_CONFIDENTIAL_INSPECTION_HEADS.has(head) ||
      !WORKSPACE_INSPECTION_HEADS.has(head) ||
      !resolveTrustedExecutable(words[0].value, workspaceRealPath)
    ) {
      return null
    }
    const args = words.slice(1).map((word) => word.value)
    if (
      hasSymlinkFollowingFlags(head, args) ||
      exposesProcessEnvironment(head, args) ||
      (head === 'jq' && jqLoadsCodeOrExternalFilter(args)) ||
      isLongLivedFollowMode(head, args) ||
      usesIndirectPathList(head, args) ||
      usesFileLoadingOption(head, args)
    ) {
      return null
    }
    let afterOptionTerminator = false
    for (const word of words.slice(1)) {
      if (word.value === '--' && !afterOptionTerminator) {
        afterOptionTerminator = true
        continue
      }
      if (
        !tokenPathIsPromptFree(
          word,
          workspaceRealPath,
          workspaceLexicalPath,
          cwd,
          afterOptionTerminator
        )
      ) {
        return null
      }
      const attachedPath = attachedPathOptionValue(head, word.value)
      if (
        attachedPath &&
        !tokenPathIsPromptFree(
          {
            value: attachedPath,
            hasUnquotedGlob: word.hasUnquotedGlob,
            unquotedEqualsExpansion: false,
            hadShellQuote: false
          },
          workspaceRealPath,
          workspaceLexicalPath,
          cwd
        )
      ) {
        return null
      }
    }
  }
  return reason
}

/**
 * The typed direct-execution plan for a proven inspection command: one trusted
 * executable and one argv, spawned without a shell.
 *
 * Deliberately still single-segment. A pipeline has no single executable or
 * argv to describe, so `null` here means "prompt-free, but run it the ordinary
 * brokered way" — never "not allowed". The approval gate reads that
 * distinction (see `ApprovalOrchestration.ts`) and only claims the
 * `brokered-direct-inspection` boundary when this returns a plan.
 */
export function workspaceInspectionExecutionPlan(
  rawCommand: unknown,
  context: WorkspaceInspectionShellContext
): WorkspaceInspectionExecutionPlan | null {
  const fingerprints: WorkspaceInspectionOutsideReadFingerprint[] = []
  outsideReadFingerprintSink = fingerprints
  try {
    const reason = workspaceInspectionShellReason(rawCommand, context)
    const command = shellCommandFromRawCommand(rawCommand)
    if (!reason || command === null || !context.workspacePath) return null
    let workspaceRealPath: string
    let cwd: string
    try {
      workspaceRealPath = fs.realpathSync(path.resolve(context.workspacePath))
      cwd = fs.realpathSync(path.resolve(context.cwd || context.workspacePath))
    } catch {
      return null
    }
    const segments = commandSegments(command)
    const words = segments?.length === 1 ? shellWords(segments[0]) : null
    if (!words) return null
    const executableRealPath = resolveTrustedExecutable(words[0].value, workspaceRealPath)
    if (!executableRealPath) return null
    const head = executableHead(words[0].value)
    const unsetEnvironment = inspectionUnsetEnvironment(head)
    return {
      reason,
      workspaceRealPath,
      executableRealPath,
      argv:
        head === 'git'
          ? hardenedGitArgv(words.slice(1).map((word) => word.value))
          : words.slice(1).map((word) => word.value),
      cwd,
      ...(head === 'git'
        ? {
            environment: gitInspectionEnvironment()
          }
        : {}),
      ...(unsetEnvironment.length > 0 ? { unsetEnvironment } : {}),
      ...(fingerprints.length > 0
        ? { outsideReadFingerprints: fingerprints.slice() }
        : {})
    }
  } finally {
    outsideReadFingerprintSink = null
  }
}

export interface WorkspaceInspectionBrokeredHardening {
  environment?: Readonly<Record<string, string>>
  unsetEnvironment?: readonly string[]
}

/**
 * Env hardening for a prompt-free multi-segment command that has no typed
 * direct plan. Single-segment plans already carry this at construction;
 * compiled `&&` / `;` sequences now ride `workspaceInspectionSequencePlan`
 * so argv flags can spawn. `|` pipelines still classify prompt-free and
 * then spawn as a raw shell string, so this is the only place those
 * git/rg env blocks can ride a pipe. Returns null when a typed plan
 * exists or the command is not prompt-free — callers must not treat
 * null as "refuse".
 */
export function workspaceInspectionBrokeredShellHardening(
  rawCommand: unknown,
  context: WorkspaceInspectionShellContext
): WorkspaceInspectionBrokeredHardening | null {
  if (workspaceInspectionShellReason(rawCommand, context) === null) return null
  if (workspaceInspectionExecutionPlan(rawCommand, context) !== null) return null
  const command = shellCommandFromRawCommand(rawCommand)
  if (command === null) return null
  const segments = commandSegments(command)
  if (!segments || segments.length < 2) return null
  const unset = new Set<string>()
  let needsGitEnv = false
  for (const segment of segments) {
    const words = shellWords(segment)
    if (!words?.length) return null
    const head = executableHead(words[0].value)
    if (!head) return null
    for (const key of inspectionUnsetEnvironment(head)) unset.add(key)
    if (head === 'git') needsGitEnv = true
  }
  if (!needsGitEnv && unset.size === 0) return null
  return {
    ...(needsGitEnv ? { environment: gitInspectionEnvironment() } : {}),
    ...(unset.size > 0 ? { unsetEnvironment: [...unset] } : {})
  }
}

export function isWorkspaceInspectionShellCommand(
  rawCommand: unknown,
  context: WorkspaceInspectionShellContext
): boolean {
  return workspaceInspectionShellReason(rawCommand, context) !== null
}
