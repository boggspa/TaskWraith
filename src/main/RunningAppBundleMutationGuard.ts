import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'

export interface RunningAppBundleMutationCheck {
  command: unknown
  cwd: string
  executablePath: string
  packageScripts?: Record<string, unknown> | null
}

interface MutationMatch {
  action: 'move' | 'remove'
  targetPath: string
}

/**
 * Refuse a host command that would unlink the packaged macOS app currently
 * executing it. This is deliberately narrower than a general destructive
 * command policy: ordinary build-output cleanup remains allowed whenever the
 * running TaskWraith bundle lives somewhere else.
 */
export function runningAppBundleMutationBlockReason(
  input: RunningAppBundleMutationCheck
): string | null {
  const bundlePath = enclosingAppBundle(input.executablePath)
  if (!bundlePath) return null

  const match = findMutation(input.command, {
    bundlePath,
    cwd: resolve(input.cwd),
    packageScripts: input.packageScripts || null,
    visitedScripts: new Set<string>()
  })
  if (!match) return null

  const displayPath = displayBundlePath(bundlePath, input.cwd)
  return `TaskWraith blocked a command that would ${match.action} the app bundle currently hosting this run (${displayPath}). Quit this copy or launch TaskWraith outside that build output before cleaning it.`
}

function enclosingAppBundle(executablePath: string): string | null {
  if (!executablePath) return null
  let cursor = dirname(resolve(executablePath))
  const root = parse(cursor).root
  while (cursor !== root) {
    if (basename(cursor).toLowerCase().endsWith('.app')) return cursor
    cursor = dirname(cursor)
  }
  return null
}

function displayBundlePath(bundlePath: string, cwd: string): string {
  const rel = relative(resolve(cwd), bundlePath)
  if (rel && !isOutside(rel)) return rel
  return basename(bundlePath)
}

function findMutation(
  command: unknown,
  context: {
    bundlePath: string
    cwd: string
    packageScripts: Record<string, unknown> | null
    visitedScripts: Set<string>
  }
): MutationMatch | null {
  const segments = Array.isArray(command)
    ? [command.map((part) => String(part || '')).filter(Boolean)]
    : shellCommandArgvSegments(String(command || ''))

  for (const argv of segments) {
    const direct = directMutation(argv, context.bundlePath, context.cwd)
    if (direct) return direct

    const taskName = packageScriptName(argv)
    if (!taskName || !context.packageScripts || context.visitedScripts.has(taskName)) continue
    const script = context.packageScripts[taskName]
    if (typeof script !== 'string') continue
    context.visitedScripts.add(taskName)
    const indirect = findMutation(script, context)
    if (indirect) return indirect
  }
  return null
}

function directMutation(argv: string[], bundlePath: string, cwd: string): MutationMatch | null {
  if (argv.length === 0) return null
  const binary = normalizeBinary(argv[0])

  if (binary === 'rm' || binary === 'rmdir') {
    for (const operand of pathOperands(argv.slice(1))) {
      const targetPath = resolveShellPath(operand, cwd)
      if (targetPath && pathsOverlap(targetPath, bundlePath)) {
        return { action: 'remove', targetPath }
      }
    }
  }

  if (binary === 'mv' || binary === 'move') {
    for (const operand of pathOperands(argv.slice(1))) {
      const targetPath = resolveShellPath(operand, cwd)
      if (targetPath && pathsOverlap(targetPath, bundlePath)) {
        return { action: 'move', targetPath }
      }
    }
  }

  const cleanScriptIndex = argv.findIndex(
    (part) => basename(part).toLowerCase() === 'clean-dist.cjs'
  )
  if (cleanScriptIndex >= 0) {
    const targets = pathOperands(argv.slice(cleanScriptIndex + 1))
    for (const operand of targets.length > 0 ? targets : ['dist']) {
      const targetPath = resolveShellPath(operand, cwd)
      if (targetPath && pathsOverlap(targetPath, bundlePath)) {
        return { action: 'remove', targetPath }
      }
    }
  }

  return null
}

function pathOperands(args: string[]): string[] {
  const operands: string[] = []
  let optionsEnded = false
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && arg.startsWith('-')) continue
    operands.push(arg)
  }
  return operands
}

function resolveShellPath(rawPath: string, cwd: string): string | null {
  const trimmed = rawPath.trim()
  if (!trimmed || /[$`]/.test(trimmed)) return null
  const wildcardIndex = trimmed.search(/[?*[\]]/)
  const stablePrefix = wildcardIndex >= 0 ? trimmed.slice(0, wildcardIndex) : trimmed
  if (!stablePrefix) return cwd
  const candidate =
    wildcardIndex >= 0 && !stablePrefix.endsWith(sep) ? dirname(stablePrefix) : stablePrefix
  return resolve(cwd, candidate)
}

function pathsOverlap(first: string, second: string): boolean {
  return pathContains(first, second) || pathContains(second, first)
}

function pathContains(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || !isOutside(rel)
}

function isOutside(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

function packageScriptName(argv: string[]): string | null {
  const binary = normalizeBinary(argv[0] || '')
  const args = argv.slice(1)
  if (binary === 'npm') {
    if (args[0] === 'run' || args[0] === 'run-script') return args[1] || null
    return null
  }
  if (binary === 'pnpm' || binary === 'bun' || binary === 'yarn') {
    if (args[0] === 'run') return args[1] || null
    return args[0] && !args[0].startsWith('-') ? args[0] : null
  }
  return null
}

function normalizeBinary(value: string): string {
  return basename(value)
    .replace(/\.(?:exe|cmd|bat)$/i, '')
    .toLowerCase()
}

function shellCommandArgvSegments(text: string): string[][] {
  const segments: string[][] = []
  let current: string[] = []
  let token = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  const pushToken = (): void => {
    if (token) current.push(token)
    token = ''
  }
  const pushSegment = (): void => {
    pushToken()
    if (current.length > 0) segments.push(current)
    current = []
  }

  for (const char of text) {
    if (escaping) {
      token += char
      escaping = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaping = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else token += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      pushToken()
      continue
    }
    if (char === ';' || char === '&' || char === '|' || char === '(' || char === ')') {
      pushSegment()
      continue
    }
    token += char
  }
  pushSegment()
  return segments
}
