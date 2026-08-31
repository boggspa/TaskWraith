import * as fs from 'node:fs'
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
const STANDARD_EXECUTABLE_PREFIX = /^(?:\/usr\/bin\/|\/bin\/|\/usr\/local\/bin\/|\/opt\/homebrew\/bin\/)/
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

export interface WorkspaceInspectionShellContext {
  workspacePath?: string | null
  cwd?: string | null
}

export interface WorkspaceInspectionExecutionPlan {
  reason: PromptFreeReadOnlyShellReason
  executableRealPath: string
  argv: string[]
  cwd: string
  environment?: Readonly<Record<string, string>>
  unsetEnvironment?: readonly string[]
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
    // Redirection is deliberately outside the prompt-free workspace tier. The
    // syntax-only classifier may prove a /dev/null redirect non-mutating, but
    // this layer promises path confinement and avoids another filename grammar.
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
}

function shellWords(segment: string): ShellWord[] | null {
  const words: ShellWord[] = []
  let word = ''
  let started = false
  let hasUnquotedGlob = false
  let unquotedEqualsExpansion = false
  let quote: 'single' | 'double' | null = null
  let escaped = false

  const push = (): void => {
    if (started) words.push({ value: word, hasUnquotedGlob, unquotedEqualsExpansion })
    word = ''
    started = false
    hasUnquotedGlob = false
    unquotedEqualsExpansion = false
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
      continue
    }
    if (character === '"') {
      quote = 'double'
      started = true
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

function hasSymlinkFollowingFlags(head: string, args: readonly string[]): boolean {
  if (head === 'grep' || head === 'egrep' || head === 'fgrep') {
    return args.some(
      (token) => /^-[^-]*R/.test(token) || token.startsWith('--d')
    )
  }
  if (head === 'rg' || head === 'fd') {
    return args.some(
      (token) =>
        /^-[^-]*[Lz]/.test(token) ||
        token.startsWith('--fol') ||
        token.startsWith('--search-z')
    )
  }
  if (head === 'find') return args.includes('-L') || args.includes('-follow')
  if (head === 'tree') {
    return args.some((token) => /^-[^-]*l/.test(token) || token === '--follow-links')
  }
  if (head === 'ls') {
    return args.some(
      (token) => /^-[^-]*L/.test(token) || token.startsWith('--d')
    )
  }
  if (head === 'du') return args.some((token) => /^-[^-]*[HL]/.test(token))
  return false
}

function exposesProcessEnvironment(head: string, args: readonly string[]): boolean {
  if (head !== 'jq') return false
  return args.some(
    (token) =>
      /\$ENV\b/.test(token) || /(^|[^A-Za-z0-9_$])env(?=$|[^A-Za-z0-9_])/.test(token)
  )
}

function jqLoadsCodeOrExternalFilter(args: readonly string[]): boolean {
  return args.some(
    (token) =>
      /^-[^-]*[fL]/.test(token) ||
      token.startsWith('--from') ||
      token.startsWith('--lib') ||
      token.startsWith('--run-t') ||
      /(^|[^A-Za-z0-9_])(?:include|import|module|modulemeta)(?=$|[^A-Za-z0-9_])/.test(token)
  )
}

function isLongLivedFollowMode(head: string, args: readonly string[]): boolean {
  if (head !== 'tail') return false
  return args.some(
    (token) =>
      /^-[^-]*[fF]/.test(token) ||
      token.startsWith('--f') ||
      token.startsWith('--r')
  )
}

function usesIndirectPathList(head: string, args: readonly string[]): boolean {
  if (head === 'find') return args.some((token) => token.startsWith('-files0'))
  if (head === 'wc') return args.some((token) => token.startsWith('--f'))
  return false
}

function resolveTrustedExecutable(
  requested: string,
  workspaceRealPath: string
): string | null {
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
  if (token.startsWith('@')) return token.slice(1)
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

function existingGlobPrefix(value: string, cwd: string): string {
  const wildcard = value.search(/[?*\[]/)
  if (wildcard < 0) return value
  const prefix = value.slice(0, wildcard)
  const separator = prefix.lastIndexOf('/')
  return separator >= 0 ? prefix.slice(0, separator + 1) || '.' : '.'
}

function tokenStaysInsideWorkspace(
  word: ShellWord,
  workspaceRealPath: string,
  cwd: string
): boolean {
  const token = word.value
  if (word.hasUnquotedGlob || word.unquotedEqualsExpansion) return false
  const value = possiblePathValue(token)
  if (!value || value.startsWith('-')) return true
  if (value.startsWith('~') || value.startsWith('file://')) return false
  if (value.split(/[\\/]/).includes('..')) return false
  const pathValue = existingGlobPrefix(value, cwd)
  const lexical = path.isAbsolute(pathValue)
    ? path.resolve(pathValue)
    : path.resolve(cwd, pathValue)
  if (!isInside(workspaceRealPath, lexical)) return false
  try {
    return isInside(workspaceRealPath, fs.realpathSync(lexical))
  } catch {
    // Non-existent relative patterns/operands remain lexically inside the
    // workspace. Existing parents were checked above for glob prefixes.
    return true
  }
}

/**
 * Add workspace/confidentiality proof to the existing non-mutation parser.
 * The returned reason is suitable for prompt-free audit only while this exact
 * context still revalidates; callers must check again immediately before spawn.
 */
export function workspaceInspectionShellReason(
  rawCommand: unknown,
  context: WorkspaceInspectionShellContext
): PromptFreeReadOnlyShellReason | null {
  const reason = promptFreeReadOnlyShellReason(rawCommand)
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
  if (!isInside(workspaceRealPath, cwd)) return null
  const segments = commandSegments(command)
  if (!segments || segments.length !== 1) return null

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
      usesIndirectPathList(head, args)
    ) {
      return null
    }
    for (const word of words.slice(1)) {
      if (!tokenStaysInsideWorkspace(word, workspaceRealPath, cwd)) return null
      const attachedPath = attachedPathOptionValue(head, word.value)
      if (
        attachedPath &&
        !tokenStaysInsideWorkspace(
          {
            value: attachedPath,
            hasUnquotedGlob: word.hasUnquotedGlob,
            unquotedEqualsExpansion: false
          },
          workspaceRealPath,
          cwd
        )
      ) {
        return null
      }
    }
  }
  return reason
}

export function workspaceInspectionExecutionPlan(
  rawCommand: unknown,
  context: WorkspaceInspectionShellContext
): WorkspaceInspectionExecutionPlan | null {
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
    ...(unsetEnvironment.length > 0 ? { unsetEnvironment } : {})
  }
}

export function isWorkspaceInspectionShellCommand(
  rawCommand: unknown,
  context: WorkspaceInspectionShellContext
): boolean {
  return workspaceInspectionShellReason(rawCommand, context) !== null
}
