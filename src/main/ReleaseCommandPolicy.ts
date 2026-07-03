import { basename } from 'path'

export interface ReleaseCommandBlock {
  commandClass: string
  reason: string
}

const SHELL_RELEASE_PATTERNS: Array<{ commandClass: string; pattern: RegExp }> = [
  { commandClass: 'codesign', pattern: commandTokenPattern('codesign') },
  { commandClass: 'notarytool', pattern: commandTokenPattern('notarytool') },
  { commandClass: 'xcrun notarytool', pattern: commandSequencePattern('xcrun', 'notarytool') },
  { commandClass: 'altool', pattern: commandTokenPattern('altool') },
  { commandClass: 'xcrun altool', pattern: commandSequencePattern('xcrun', 'altool') },
  { commandClass: 'git push', pattern: commandSequencePattern('git', 'push') },
  { commandClass: 'gh release', pattern: commandSequencePattern('gh', 'release') },
  { commandClass: 'gh pr create', pattern: commandSequencePattern('gh', 'pr', 'create') },
  { commandClass: 'gh workflow run', pattern: commandSequencePattern('gh', 'workflow', 'run') },
  {
    commandClass: 'npm publish',
    pattern: commandSequencePattern('npm', 'publish')
  },
  {
    commandClass: 'pnpm publish',
    pattern: commandSequencePattern('pnpm', 'publish')
  },
  {
    commandClass: 'bun publish',
    pattern: commandSequencePattern('bun', 'publish')
  },
  {
    commandClass: 'yarn publish',
    pattern: commandSequencePattern('yarn', 'publish')
  },
  {
    commandClass: 'yarn npm publish',
    pattern: commandSequencePattern('yarn', 'npm', 'publish')
  },
  {
    commandClass: 'notarized package script',
    pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[A-Za-z0-9:_-]*notariz(?:e|ed)[A-Za-z0-9:_-]*\b/i
  },
  {
    commandClass: 'electron-builder publish/notarize',
    pattern:
      /\belectron-builder\b[^\n;&|]*(?:--publish(?:=|\s+)(?!never\b|false\b|off\b)|-p\s+(?!never\b|false\b|off\b)|publish\s+always\b|notarize\s*=)/i
  }
]

export function classifyReleaseCommand(command: unknown): ReleaseCommandBlock | null {
  if (Array.isArray(command) && command.length > 0) {
    return classifyArgv(command.map((part) => String(part)))
  }
  const text = String(command || '').trim()
  if (!text) return null
  for (const argv of shellCommandArgvSegments(text)) {
    const block = classifyArgv(argv)
    if (block) return block
  }
  for (const item of SHELL_RELEASE_PATTERNS) {
    if (item.pattern.test(text)) return block(item.commandClass)
  }
  return null
}

export function releaseCommandBlockReason(command: unknown): string | null {
  return classifyReleaseCommand(command)?.reason || null
}

export function releaseScriptBlockReason(taskName: string, scriptBody: string): string | null {
  const normalizedTask = String(taskName || '').trim()
  if (/\b(?:release|publish|deploy|notariz(?:e|ed)|sign(?:ed|ing)?)\b/i.test(normalizedTask)) {
    return block(`package script ${normalizedTask}`).reason
  }
  return releaseCommandBlockReason(scriptBody)
}

export function releasePackageScriptBlockReason(
  command: unknown,
  scripts: Record<string, unknown> | null | undefined
): string | null {
  if (!scripts) return null
  const taskName = packageScriptNameFromCommand(command)
  if (!taskName) return null
  const scriptBody = scripts[taskName]
  return releaseScriptBlockReason(taskName, typeof scriptBody === 'string' ? scriptBody : '')
}

function classifyArgv(argv: string[]): ReleaseCommandBlock | null {
  const binary = normalizeBinaryName(argv[0])
  const args = argv.slice(1).map((arg) => String(arg || '').trim()).filter(Boolean)

  if (binary === 'codesign' || binary === 'notarytool' || binary === 'altool') return block(binary)
  if (binary === 'xcrun') {
    const xcrunTool = commandAfterGlobalOptions(args, new Set(['--sdk', '--toolchain', '--find']))?.command
    if (xcrunTool === 'notarytool' || xcrunTool === 'altool') return block(`xcrun ${xcrunTool}`)
  }
  if (binary === 'git') {
    const gitCommand = commandAfterGlobalOptions(
      args,
      new Set([
        '-C',
        '-c',
        '--config-env',
        '--exec-path',
        '--git-dir',
        '--namespace',
        '--super-prefix',
        '--work-tree'
      ])
    )?.command
    if (gitCommand === 'push') return block('git push')
  }
  if (binary === 'gh') {
    const first = commandAfterGlobalOptions(
      args,
      new Set(['-R', '--repo', '--hostname', '--config', '--git-protocol'])
    )
    const ghCommand = first?.command
    const rest = first ? args.slice(first.index + 1) : []
    const second = commandAfterGlobalOptions(rest, new Set(['-R', '--repo', '--json', '--template']))?.command
    if (ghCommand === 'release') return block('gh release')
    if (ghCommand === 'pr' && second === 'create') return block('gh pr create')
    if (ghCommand === 'workflow' && second === 'run') return block('gh workflow run')
    if (
      ghCommand === 'api' &&
      args.some((arg) => /\/repos\/[^/\s]+\/[^/\s]+\/(?:releases|pulls)(?:\b|\/)/i.test(arg))
    ) {
      return block('gh api release/pr')
    }
  }
  if (binary === 'npm' || binary === 'pnpm' || binary === 'bun') {
    const first = commandAfterGlobalOptions(packageManagerArgsWithoutRunnerOptions(args), PACKAGE_OPTION_VALUE_FLAGS)
    const command = first?.command
    if (command === 'publish') return block(`${binary} publish`)
    if ((command === 'run' || command === 'run-script') && releaseScriptName(first ? args[first.index + 1] : '')) {
      return block(`package script ${args[first!.index + 1]}`)
    }
    if (binary !== 'npm' && command && command !== 'install' && releaseScriptName(command)) {
      return block(`package script ${command}`)
    }
  }
  if (binary === 'yarn') {
    const first = commandAfterGlobalOptions(args, YARN_OPTION_VALUE_FLAGS)
    const command = first?.command
    const rest = first ? args.slice(first.index + 1) : []
    const second = commandAfterGlobalOptions(rest, YARN_OPTION_VALUE_FLAGS)?.command
    if (command === 'publish') return block('yarn publish')
    if (command === 'npm' && second === 'publish') return block('yarn npm publish')
    if ((command === 'run' && releaseScriptName(first ? args[first.index + 1] : '')) || releaseScriptName(command)) {
      return block(`package script ${command === 'run' ? args[first!.index + 1] : command}`)
    }
  }
  if (binary === 'npx' || (binary === 'pnpm' && args[0] === 'dlx') || (binary === 'yarn' && args[0] === 'dlx')) {
    const runnerArgs = binary === 'npx' ? args : args.slice(1)
    const command = commandAfterGlobalOptions(runnerArgs, PACKAGE_OPTION_VALUE_FLAGS)?.command
    if (command === 'semantic-release' || command === 'release-it') return block(command)
  }
  if (
    (binary === 'npm' || binary === 'pnpm' || binary === 'yarn' || binary === 'bun') &&
    args.some((arg) => /notariz(?:e|ed)/i.test(arg))
  ) {
    return block('notarized package script')
  }
  if (
    binary === 'electron-builder' &&
    args.some((arg, index) =>
      (arg === '--publish' && !['never', 'false', 'off'].includes(args[index + 1] || '')) ||
      /^--publish=(?!never\b|false\b|off\b)/i.test(arg) ||
      (arg === '-p' && !['never', 'false', 'off'].includes(args[index + 1] || '')) ||
      /notarize\s*=|publish\s+always/i.test(arg)
    )
  ) {
    return block('electron-builder publish/notarize')
  }
  return null
}

const PACKAGE_OPTION_VALUE_FLAGS = new Set([
  '-C',
  '--cache',
  '--config',
  '--cwd',
  '--prefix',
  '--registry',
  '--userconfig',
  '--workspace'
])

const YARN_OPTION_VALUE_FLAGS = new Set([
  '--cache-folder',
  '--cwd',
  '--modules-folder',
  '--mutex',
  '--registry'
])

function releaseScriptName(value: unknown): boolean {
  return /\b(?:release|publish|deploy|notariz(?:e|ed)|sign(?:ed|ing)?)\b/i.test(
    String(value || '')
  )
}

function packageManagerArgsWithoutRunnerOptions(args: string[]): string[] {
  return args.filter((arg) => arg !== '-r' && arg !== '--recursive')
}

function commandAfterGlobalOptions(
  args: string[],
  valueOptions: Set<string>
): { command: string; index: number } | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue
    if (arg === '--') {
      const command = args[index + 1]
      return command ? { command, index: index + 1 } : null
    }
    if (arg.startsWith('-')) {
      const [name] = arg.split('=', 1)
      if (valueOptions.has(name) && !arg.includes('=')) index += 1
      continue
    }
    return { command: arg, index }
  }
  return null
}

function shellCommandArgvSegments(text: string): string[][] {
  const segments: string[][] = []
  let current: string[] = []
  let token = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  const pushToken = () => {
    if (token) current.push(token)
    token = ''
  }
  const pushSegment = () => {
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

function packageScriptNameFromCommand(command: unknown): string | null {
  if (Array.isArray(command) && command.length > 1) {
    const argv = command.map((part) => String(part || '').trim()).filter(Boolean)
    const binary = normalizeBinaryName(argv[0])
    const args = argv.slice(1)
    return packageScriptNameFromArgv(binary, args)
  }
  const text = String(command || '').trim()
  if (!text) return null
  const match = text.match(
    /(?:^|[\s;&|()])(?:npm|pnpm|bun)\s+(?:run(?:-script)?\s+)?([A-Za-z0-9:_-]+)(?:\s|$|[;&|()])|(?:^|[\s;&|()])yarn\s+(?:run\s+)?([A-Za-z0-9:_-]+)(?:\s|$|[;&|()])/i
  )
  return (match?.[1] || match?.[2] || '').trim() || null
}

function packageScriptNameFromArgv(binary: string, args: string[]): string | null {
  if ((binary === 'npm' || binary === 'pnpm' || binary === 'bun') && args[0] === 'run') {
    return args[1] || null
  }
  if (binary === 'npm' && args[0] === 'run-script') return args[1] || null
  if ((binary === 'pnpm' || binary === 'bun') && args[0] && args[0] !== 'publish') {
    return args[0]
  }
  if (binary === 'yarn') {
    if (args[0] === 'run') return args[1] || null
    if (args[0] && args[0] !== 'npm' && args[0] !== 'publish') return args[0]
  }
  return null
}

function normalizeBinaryName(value: string): string {
  return basename(value || '')
    .replace(/\.(?:exe|cmd|bat)$/i, '')
    .toLowerCase()
}

function commandTokenPattern(...tokens: string[]): RegExp {
  return commandSequencePattern(...tokens)
}

function commandSequencePattern(...tokens: string[]): RegExp {
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(?:^|[\\s;&|()])${escaped.join('\\s+')}(?:\\s|$|[;&|()])`, 'i')
}

function block(commandClass: string): ReleaseCommandBlock {
  return {
    commandClass,
    reason: `Blocked release-class command (${commandClass}). Use TaskWraith's external publishing / release approval path so the action has an explicit approval receipt.`
  }
}
