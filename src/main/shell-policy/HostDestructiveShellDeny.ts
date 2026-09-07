/**
 * Host-destructive bash deny-wall.
 *
 * Restricting polarity: these commands are non-grantable host actions
 * (disk wipe, device overwrite, power-off). They deny in every permission
 * preset, including Full Access. Ordinary developer commands are out of
 * scope — they follow the run's shell policy instead.
 *
 * This module classifies strings only. It never spawns a process.
 */

const STRIPPABLE_BIN_PREFIX = /^(?:\/usr\/bin\/|\/bin\/|\/usr\/local\/bin\/|\/opt\/homebrew\/bin\/)/
const POWER_HEADS = new Set(['shutdown', 'reboot', 'halt'])
const SHELL_HEADS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-C', '--user', '--group', '--close-from'])

export function isHostDestructiveShellCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed) return false
  if (substitutionIsDestructive(trimmed)) return true
  const segments = chainSegmentsOf(trimmed)
  if (!segments) return substitutionIsDestructive(trimmed)
  return segments.some((segment) => segmentIsDestructive(segment, false))
}

function substitutionIsDestructive(command: string): boolean {
  let quote: 'single' | 'double' | null = null
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (quote === 'single') {
      if (character === "'") quote = null
      continue
    }
    if (quote === 'double') {
      if (character === '\\' && index + 1 < command.length) {
        index += 1
        continue
      }
      if (character === '"') quote = null
      continue
    }
    if (character === "'") {
      quote = 'single'
      continue
    }
    if (character === '"') {
      quote = 'double'
      continue
    }
    if (character === '`') {
      const end = command.indexOf('`', index + 1)
      if (end === -1) return looksLikeDestroyHead(command.slice(index + 1))
      if (isHostDestructiveShellCommand(command.slice(index + 1, end))) return true
      index = end
      continue
    }
    if (character === '$' && command[index + 1] === '(') {
      const end = matchingParen(command, index + 1)
      if (end === -1) return looksLikeDestroyHead(command.slice(index + 2))
      if (isHostDestructiveShellCommand(command.slice(index + 2, end))) return true
      index = end
    }
  }
  return false
}

function matchingParen(command: string, openIndex: number): number {
  let depth = 0
  let quote: 'single' | 'double' | null = null
  for (let index = openIndex; index < command.length; index += 1) {
    const character = command[index]
    if (quote === 'single') {
      if (character === "'") quote = null
      continue
    }
    if (quote === 'double') {
      if (character === '"') quote = null
      continue
    }
    if (character === "'") {
      quote = 'single'
      continue
    }
    if (character === '"') {
      quote = 'double'
      continue
    }
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function looksLikeDestroyHead(text: string): boolean {
  const head = (text.trim().split(/\s+/)[0] ?? '').replace(STRIPPABLE_BIN_PREFIX, '')
  return (
    POWER_HEADS.has(head) ||
    head.startsWith('mkfs') ||
    head === 'diskutil' ||
    head === 'dd' ||
    head === 'rm'
  )
}

function chainSegmentsOf(command: string): string[] | null {
  const segments: string[] = []
  let quote: 'single' | 'double' | null = null
  let segmentStart = 0

  const push = (end: number): boolean => {
    const segment = command.slice(segmentStart, end).trim()
    if (!segment) return false
    segments.push(segment)
    return true
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (quote === 'single') {
      if (character === "'") quote = null
      continue
    }
    if (quote === 'double') {
      if (character === '"') quote = null
      continue
    }
    if (character === "'") {
      quote = 'single'
      continue
    }
    if (character === '"') {
      quote = 'double'
      continue
    }
    if (character === '\n' || character === '\r' || character === ';') {
      if (!push(index)) return null
      segmentStart = index + 1
      continue
    }
    if (character === '&') {
      if (command[index + 1] !== '&') return null
      if (!push(index)) return null
      index += 1
      segmentStart = index + 1
      continue
    }
    if (character === '|') {
      const isOr = command[index + 1] === '|'
      if (!push(index)) return null
      if (isOr) index += 1
      segmentStart = index + 1
    }
  }

  if (quote !== null) return null
  if (!push(command.length)) return null
  return segments
}

function tokenize(command: string): string[] | null {
  const tokens: string[] = []
  let token = ''
  let started = false
  let quote: 'single' | 'double' | null = null

  const pushToken = (): void => {
    if (started) tokens.push(token)
    token = ''
    started = false
  }

  for (const character of command.trim()) {
    if (quote === 'single') {
      if (character === "'") quote = null
      else token += character
      started = true
      continue
    }
    if (quote === 'double') {
      if (character === '"') quote = null
      else token += character
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
      pushToken()
      continue
    }
    token += character
    started = true
  }

  if (quote !== null) return null
  pushToken()
  return tokens
}

function segmentIsDestructive(segment: string, hadSudo: boolean): boolean {
  const tokens = tokenize(segment)
  if (!tokens || tokens.length === 0) return false
  return argvIsDestructive(tokens, hadSudo)
}

function argvIsDestructive(tokens: string[], hadSudo: boolean): boolean {
  const unwrapped = unwrap(tokens, hadSudo)
  if (!unwrapped) return false
  const { argv, sudo } = unwrapped
  if (argv.length === 0) return false
  const head = argv[0].replace(STRIPPABLE_BIN_PREFIX, '')
  if (POWER_HEADS.has(head)) return true
  if (head.startsWith('mkfs')) return true
  if (head === 'diskutil') return diskutilIsDestructive(argv.slice(1))
  if (head === 'dd') return ddWritesDevice(argv.slice(1))
  if (head === 'rm') return rmWipesHost(argv.slice(1), sudo)
  if (SHELL_HEADS.has(head)) return shellScriptIsDestructive(argv.slice(1))
  return false
}

function unwrap(tokens: string[], hadSudo: boolean): { argv: string[]; sudo: boolean } | null {
  let index = 0
  let sudo = hadSudo
  while (index < tokens.length) {
    const head = tokens[index].replace(STRIPPABLE_BIN_PREFIX, '')
    if (head === 'sudo' || head === 'doas') {
      sudo = true
      index += 1
      while (index < tokens.length) {
        const flag = tokens[index]
        if (flag === '--') {
          index += 1
          break
        }
        if (!flag.startsWith('-')) break
        if (SUDO_VALUE_FLAGS.has(flag)) index += 2
        else index += 1
      }
      continue
    }
    if (head === 'env') {
      index += 1
      while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
        index += 1
      }
      continue
    }
    if (head === 'nohup' || head === 'nice' || head === 'command' || head === 'builtin') {
      index += 1
      if (tokens[index]?.startsWith('-')) index += 1
      continue
    }
    break
  }
  return { argv: tokens.slice(index), sudo }
}

function diskutilIsDestructive(args: readonly string[]): boolean {
  if (args[0]?.startsWith('erase')) return true
  return args[0] === 'apfs' && Boolean(args[1]?.startsWith('delete'))
}

function ddWritesDevice(args: readonly string[]): boolean {
  return args.some((token) => /^of=\/dev\//.test(token))
}

function rmWipesHost(args: readonly string[], sudo: boolean): boolean {
  let recursive = false
  const targets: string[] = []
  let seenDashDash = false
  for (const token of args) {
    if (!seenDashDash && token === '--') {
      seenDashDash = true
      continue
    }
    if (!seenDashDash && token.startsWith('-')) {
      if (token === '--recursive' || token === '--force') {
        if (token === '--recursive') recursive = true
        continue
      }
      if (/^-[A-Za-z]+$/.test(token) && /[rR]/.test(token)) recursive = true
      continue
    }
    targets.push(token)
  }
  if (!recursive) return false
  return targets.some((target) => isHostWipeTarget(target, sudo))
}

function isHostWipeTarget(target: string, sudo: boolean): boolean {
  if (target === '/' || target === '/*' || target.startsWith('/*')) return true
  if (target.startsWith('~')) return true
  if (target === '$HOME' || target.startsWith('$HOME/') || target.startsWith('${HOME}')) {
    return true
  }
  return sudo && target === '*'
}

function shellScriptIsDestructive(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '-c' || token === '--command' || token.startsWith('--command=')) {
      const script = token.startsWith('--command=')
        ? token.slice('--command='.length)
        : args[index + 1]
      return Boolean(script) && isHostDestructiveShellCommand(script)
    }
  }
  return false
}
