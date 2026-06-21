import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { LocalServerEntry } from '../localServers/types'
import type {
  LaunchTarget,
  LaunchTargetCommand,
  LaunchTargetKind,
  LaunchTargetPlatform,
  LaunchTargetsSnapshot
} from './types'

export interface DiscoverLaunchTargetsOptions {
  workspacePath: string
  workspaceId?: string
  localServers?: LocalServerEntry[]
  platform?: NodeJS.Platform
  now?: () => Date
}

const SKIP_DIRS = new Set([
  '.build',
  '.git',
  '.next',
  '.turbo',
  '.vite',
  'DerivedData',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out'
])

const PACKAGE_SCRIPT_NAMES = new Set([
  'dev',
  'start',
  'preview',
  'serve',
  'watch',
  'build',
  'test',
  'typecheck',
  'check',
  'lint',
  'ios',
  'macos',
  'desktop',
  'electron'
])

const SOURCE_RANK: Record<LaunchTarget['source'], number> = {
  'local-server': 0,
  'package-script': 10,
  'vscode-launch': 20,
  'vscode-compound': 21,
  'vscode-task': 30,
  swiftpm: 40,
  xcode: 50
}

const KIND_RANK: Record<LaunchTargetKind, number> = {
  preview: 0,
  'dev-server': 1,
  run: 2,
  debug: 3,
  build: 4,
  test: 5,
  typecheck: 6,
  lint: 7,
  task: 8
}

export async function discoverLaunchTargets(
  options: DiscoverLaunchTargetsOptions
): Promise<LaunchTargetsSnapshot> {
  const workspacePath = path.resolve(options.workspacePath)
  const now = options.now ?? (() => new Date())
  const platform = options.platform ?? process.platform
  const targets: LaunchTarget[] = []

  try {
    const stat = await fs.stat(workspacePath)
    if (!stat.isDirectory()) {
      return {
        sampledAt: now().toISOString(),
        workspacePath,
        workspaceId: options.workspaceId,
        targets: [],
        platform,
        detectionAvailable: false
      }
    }

    targets.push(...buildLocalServerTargets(workspacePath, options))
    targets.push(...(await discoverPackageScripts(workspacePath, options.workspaceId)))
    targets.push(...(await discoverVsCodeTargets(workspacePath, options.workspaceId)))
    targets.push(...(await discoverSwiftPackageTargets(workspacePath, options.workspaceId)))
    targets.push(...(await discoverXcodeTargets(workspacePath, options.workspaceId)))

    return {
      sampledAt: now().toISOString(),
      workspacePath,
      workspaceId: options.workspaceId,
      targets: targets.sort(compareTargets),
      platform,
      detectionAvailable: true
    }
  } catch {
    return {
      sampledAt: now().toISOString(),
      workspacePath,
      workspaceId: options.workspaceId,
      targets: [],
      platform,
      detectionAvailable: false
    }
  }
}

function buildLocalServerTargets(
  workspacePath: string,
  options: DiscoverLaunchTargetsOptions
): LaunchTarget[] {
  const workspaceId = options.workspaceId
  return (options.localServers ?? [])
    .filter((server) => server.primaryPort != null && localServerBelongsToWorkspace(server, workspacePath))
    .map((server) => {
      const port = server.primaryPort as number
      const url = `http://localhost:${port}`
      return {
        id: stableId('local-server', workspaceId || workspacePath, url),
        label: `${server.name || 'Local server'} :${port}`,
        subtitle: server.origin === 'agent-spawned' ? 'running from TaskWraith' : 'running locally',
        workspaceId,
        workspacePath,
        source: 'local-server',
        kind: 'preview',
        platform: inferPlatformFromText(`${server.name} ${server.command}`),
        confidence: 1,
        url,
        primaryPort: port,
        localServerPid: server.pid,
        localServer: server,
        evidence: [
          {
            path: server.cwd || server.workspacePath || workspacePath,
            reason: `listening on localhost:${port}`
          }
        ],
        blockers: []
      } satisfies LaunchTarget
    })
}

async function discoverPackageScripts(
  workspacePath: string,
  workspaceId?: string
): Promise<LaunchTarget[]> {
  const packageFiles = await findNamedEntries(workspacePath, new Set(['package.json']), 3, 25)
  const targets: LaunchTarget[] = []

  for (const packagePath of packageFiles) {
    const text = await readText(packagePath)
    if (!text) continue
    const parsed = parseJson(text)
    if (!isObject(parsed) || !isObject(parsed.scripts)) continue
    const cwd = path.dirname(packagePath)
    const manager = packageManagerForPackage(parsed)
    for (const [scriptName, scriptValue] of Object.entries(parsed.scripts)) {
      if (typeof scriptValue !== 'string' || !shouldIncludePackageScript(scriptName)) continue
      const kind = packageScriptKind(scriptName, scriptValue)
      const command = packageScriptCommand(manager, scriptName, cwd, kind)
      const relativePackagePath = path.relative(workspacePath, packagePath) || 'package.json'
      targets.push({
        id: stableId('package-script', relativePackagePath, scriptName),
        label: `${manager.display} ${scriptName}`,
        subtitle: `${relativePackagePath} script`,
        workspaceId,
        workspacePath,
        source: 'package-script',
        kind,
        platform: inferPlatformFromText(`${scriptName} ${scriptValue}`),
        confidence: packageScriptConfidence(kind, scriptName),
        command,
        evidence: [
          {
            path: packagePath,
            line: findLineNumber(text, `"${scriptName}"`),
            reason: scriptValue
          }
        ],
        blockers: []
      })
    }
  }

  return targets
}

async function discoverVsCodeTargets(
  workspacePath: string,
  workspaceId?: string
): Promise<LaunchTarget[]> {
  const targets: LaunchTarget[] = []
  const vscodeDir = path.join(workspacePath, '.vscode')
  const launchPath = path.join(vscodeDir, 'launch.json')
  const tasksPath = path.join(vscodeDir, 'tasks.json')

  const launchText = await readText(launchPath)
  if (launchText) {
    const parsed = parseJsonc(launchText)
    const configurations = isObject(parsed) && Array.isArray(parsed.configurations) ? parsed.configurations : []
    const compounds = isObject(parsed) && Array.isArray(parsed.compounds) ? parsed.compounds : []
    for (const config of configurations) {
      if (!isObject(config) || typeof config.name !== 'string') continue
      const command = vsCodeLaunchCommand(config, workspacePath)
      const request = typeof config.request === 'string' ? config.request : 'launch'
      const blockers =
        request === 'attach' ? ['Attach configurations require a running process selection.'] : []
      targets.push({
        id: stableId('vscode-launch', config.name),
        label: config.name,
        subtitle: 'VS Code launch configuration',
        workspaceId,
        workspacePath,
        source: 'vscode-launch',
        kind: 'debug',
        platform: inferPlatformFromText(`${config.type ?? ''} ${config.program ?? ''}`),
        confidence: command ? 0.86 : 0.68,
        ...(command ? { command } : {}),
        evidence: [
          {
            path: launchPath,
            line: findLineNumber(launchText, `"${config.name}"`),
            reason: typeof config.type === 'string' ? config.type : undefined
          }
        ],
        blockers
      })
    }
    for (const compound of compounds) {
      if (!isObject(compound) || typeof compound.name !== 'string') continue
      const configNames = asStringArray(compound.configurations)
      targets.push({
        id: stableId('vscode-compound', compound.name, ...configNames),
        label: compound.name,
        subtitle: 'VS Code compound launch',
        workspaceId,
        workspacePath,
        source: 'vscode-compound',
        kind: 'debug',
        platform: 'unknown',
        confidence: 0.76,
        evidence: [
          {
            path: launchPath,
            line: findLineNumber(launchText, `"${compound.name}"`),
            reason: configNames.length ? configNames.join(', ') : undefined
          }
        ],
        blockers: ['Compound launches require orchestrating multiple child configurations.']
      })
    }
  }

  const tasksText = await readText(tasksPath)
  if (tasksText) {
    const parsed = parseJsonc(tasksText)
    const tasks = isObject(parsed) && Array.isArray(parsed.tasks) ? parsed.tasks : []
    for (const task of tasks) {
      if (!isObject(task) || typeof task.label !== 'string') continue
      const command = vsCodeTaskCommand(task, workspacePath)
      const kind = vsCodeTaskKind(task)
      targets.push({
        id: stableId('vscode-task', task.label),
        label: task.label,
        subtitle: 'VS Code task',
        workspaceId,
        workspacePath,
        source: 'vscode-task',
        kind,
        platform: inferPlatformFromText(`${task.label} ${task.command ?? ''}`),
        confidence: command ? 0.82 : 0.6,
        ...(command ? { command } : {}),
        evidence: [
          {
            path: tasksPath,
            line: findLineNumber(tasksText, `"${task.label}"`),
            reason: typeof task.type === 'string' ? task.type : undefined
          }
        ],
        blockers: command ? [] : ['Task command could not be represented from tasks.json.']
      })
    }
  }

  return targets
}

async function discoverSwiftPackageTargets(
  workspacePath: string,
  workspaceId?: string
): Promise<LaunchTarget[]> {
  const packageFiles = await findNamedEntries(workspacePath, new Set(['Package.swift']), 4, 20)
  const targets: LaunchTarget[] = []

  for (const packagePath of packageFiles) {
    const text = await readText(packagePath)
    if (!text) continue
    const cwd = path.dirname(packagePath)
    const relativePackagePath = path.relative(workspacePath, packagePath) || 'Package.swift'
    const baseEvidence = { path: packagePath, line: 1, reason: 'Swift package manifest' }

    targets.push({
      id: stableId('swiftpm', relativePackagePath, 'build'),
      label: `swift build (${path.basename(cwd)})`,
      subtitle: relativePackagePath,
      workspaceId,
      workspacePath,
      source: 'swiftpm',
      kind: 'build',
      platform: 'swiftpm',
      confidence: 0.78,
      command: command(['swift', 'build'], cwd, false),
      evidence: [baseEvidence],
      blockers: []
    })
    targets.push({
      id: stableId('swiftpm', relativePackagePath, 'test'),
      label: `swift test (${path.basename(cwd)})`,
      subtitle: relativePackagePath,
      workspaceId,
      workspacePath,
      source: 'swiftpm',
      kind: 'test',
      platform: 'swiftpm',
      confidence: 0.74,
      command: command(['swift', 'test'], cwd, false),
      evidence: [baseEvidence],
      blockers: []
    })

    for (const executableName of swiftExecutableProducts(text)) {
      targets.push({
        id: stableId('swiftpm', relativePackagePath, 'run', executableName),
        label: `swift run ${executableName}`,
        subtitle: relativePackagePath,
        workspaceId,
        workspacePath,
        source: 'swiftpm',
        kind: 'run',
        platform: 'swiftpm',
        confidence: 0.82,
        command: command(['swift', 'run', executableName], cwd, false),
        evidence: [
          {
            path: packagePath,
            line: findLineNumber(text, executableName),
            reason: 'Swift executable product'
          }
        ],
        blockers: []
      })
    }
  }

  return targets
}

async function discoverXcodeTargets(
  workspacePath: string,
  workspaceId?: string
): Promise<LaunchTarget[]> {
  const xcodeEntries = await findNamedEntries(
    workspacePath,
    new Set(['.xcodeproj', '.xcworkspace']),
    4,
    20,
    'directory-suffix'
  )
  const targets: LaunchTarget[] = []

  for (const xcodePath of xcodeEntries) {
    const schemes = await xcodeSchemes(xcodePath)
    const relativeXcodePath = path.relative(workspacePath, xcodePath) || path.basename(xcodePath)
    const xcodeFlag = xcodePath.endsWith('.xcworkspace') ? '-workspace' : '-project'
    const platform = inferPlatformFromText(relativeXcodePath)

    if (schemes.length === 0) {
      targets.push({
        id: stableId('xcode', relativeXcodePath),
        label: path.basename(xcodePath),
        subtitle: 'Xcode project',
        workspaceId,
        workspacePath,
        source: 'xcode',
        kind: 'build',
        platform,
        confidence: 0.58,
        evidence: [{ path: xcodePath, reason: 'Xcode project bundle' }],
        blockers: ['Scheme selection is required before building or running.']
      })
      continue
    }

    for (const scheme of schemes) {
      const schemeEvidence = {
        path: path.join(
          xcodePath,
          'xcshareddata',
          'xcschemes',
          `${scheme}.xcscheme`
        ),
        reason: 'shared Xcode scheme'
      }
      targets.push({
        id: stableId('xcode', relativeXcodePath, scheme),
        label: `${scheme} (Xcode build)`,
        subtitle: relativeXcodePath,
        workspaceId,
        workspacePath,
        source: 'xcode',
        kind: 'build',
        platform,
        confidence: 0.8,
        command: command(['xcodebuild', xcodeFlag, xcodePath, '-scheme', scheme, 'build'], workspacePath, false),
        evidence: [schemeEvidence],
        blockers: []
      })
      targets.push({
        id: stableId('xcode', relativeXcodePath, scheme, 'run'),
        label: `${scheme} (Xcode run)`,
        subtitle: `${relativeXcodePath} - destination required`,
        workspaceId,
        workspacePath,
        source: 'xcode',
        kind: 'run',
        platform,
        confidence: 0.72,
        evidence: [schemeEvidence],
        blockers: ['Run destination selection is required before launching an Xcode scheme.']
      })
    }
  }

  return targets
}

async function findNamedEntries(
  root: string,
  names: Set<string>,
  maxDepth: number,
  limit: number,
  mode: 'file-name' | 'directory-suffix' = 'file-name'
): Promise<string[]> {
  const found: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (found.length >= limit || depth < 0) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (found.length >= limit) return
      const fullPath = path.join(dir, entry.name)
      if (entry.isFile() && mode === 'file-name' && names.has(entry.name)) {
        found.push(fullPath)
        continue
      }
      if (!entry.isDirectory()) continue
      if (mode === 'directory-suffix' && [...names].some((suffix) => entry.name.endsWith(suffix))) {
        found.push(fullPath)
        continue
      }
      if (depth === 0 || SKIP_DIRS.has(entry.name)) continue
      await walk(fullPath, depth - 1)
    }
  }

  await walk(root, maxDepth)
  return found
}

function localServerBelongsToWorkspace(server: LocalServerEntry, workspacePath: string): boolean {
  const normalizedWorkspace = normalizePathForCompare(workspacePath)
  return (
    normalizePathForCompare(server.workspacePath) === normalizedWorkspace ||
    pathIsInside(server.cwd, normalizedWorkspace)
  )
}

function pathIsInside(candidate: string | undefined, normalizedRoot: string): boolean {
  const normalizedCandidate = normalizePathForCompare(candidate)
  return Boolean(
    normalizedCandidate &&
      normalizedRoot &&
      (normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`))
  )
}

function normalizePathForCompare(value: string | undefined): string {
  if (!value) return ''
  const normalized = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function packageScriptKind(scriptName: string, scriptValue: string): LaunchTargetKind {
  const name = scriptName.toLowerCase()
  const value = scriptValue.toLowerCase()
  if (name.includes('test')) return 'test'
  if (name.includes('typecheck') || name === 'check' || name.endsWith(':check')) return 'typecheck'
  if (name.includes('lint')) return 'lint'
  if (name.includes('build') || value.includes(' build')) return 'build'
  if (name.includes('preview') || name.includes('serve')) return 'preview'
  if (name.includes('dev') || name.includes('start') || name.includes('watch')) return 'dev-server'
  if (name.includes('ios') || name.includes('macos') || name.includes('electron')) return 'run'
  return 'task'
}

function shouldIncludePackageScript(scriptName: string): boolean {
  const normalized = scriptName.toLowerCase()
  if (PACKAGE_SCRIPT_NAMES.has(normalized)) return true
  return [...PACKAGE_SCRIPT_NAMES].some(
    (name) => normalized.startsWith(`${name}:`) || normalized.endsWith(`:${name}`)
  )
}

function packageScriptConfidence(kind: LaunchTargetKind, scriptName: string): number {
  if (kind === 'dev-server' || kind === 'preview') return 0.9
  if (['build', 'test', 'run', 'typecheck', 'lint'].includes(kind)) return 0.78
  return scriptName === 'start' ? 0.74 : 0.64
}

function packageManagerForPackage(pkg: Record<string, unknown>): {
  binary: string
  display: string
  argsForScript: (script: string) => string[]
} {
  const packageManager = typeof pkg.packageManager === 'string' ? pkg.packageManager : ''
  if (packageManager.startsWith('pnpm@')) {
    return { binary: 'pnpm', display: 'pnpm', argsForScript: (script) => [script] }
  }
  if (packageManager.startsWith('yarn@')) {
    return { binary: 'yarn', display: 'yarn', argsForScript: (script) => [script] }
  }
  if (packageManager.startsWith('bun@')) {
    return { binary: 'bun', display: 'bun run', argsForScript: (script) => ['run', script] }
  }
  return { binary: 'npm', display: 'npm run', argsForScript: (script) => ['run', script] }
}

function packageScriptCommand(
  manager: ReturnType<typeof packageManagerForPackage>,
  scriptName: string,
  cwd: string,
  kind: LaunchTargetKind
): LaunchTargetCommand {
  const argv = [manager.binary, ...manager.argsForScript(scriptName)]
  return command(argv, cwd, kind === 'dev-server' || kind === 'preview')
}

function vsCodeLaunchCommand(
  config: Record<string, unknown>,
  workspacePath: string
): LaunchTargetCommand | undefined {
  if (config.request === 'attach') return undefined
  const cwd = substituteWorkspaceFolder(
    typeof config.cwd === 'string' ? config.cwd : workspacePath,
    workspacePath
  )
  const runtimeExecutable =
    typeof config.runtimeExecutable === 'string' ? config.runtimeExecutable : undefined
  const runtimeArgs = asStringArray(config.runtimeArgs).map((arg) =>
    substituteWorkspaceFolder(arg, workspacePath)
  )
  const program =
    typeof config.program === 'string'
      ? substituteWorkspaceFolder(config.program, workspacePath)
      : undefined

  if (runtimeExecutable) {
    return command([runtimeExecutable, ...runtimeArgs, ...(program ? [program] : [])], cwd, false)
  }
  if (program) {
    return command(['node', program], cwd, false)
  }
  return undefined
}

function vsCodeTaskCommand(
  task: Record<string, unknown>,
  workspacePath: string
): LaunchTargetCommand | undefined {
  if (typeof task.command !== 'string') return undefined
  const args = asStringArray(task.args).map((arg) => substituteWorkspaceFolder(arg, workspacePath))
  const rawCommand = substituteWorkspaceFolder(task.command, workspacePath)
  const isShell = task.type !== 'process'
  const raw = [rawCommand, ...args].join(' ')
  return {
    raw,
    ...(isShell ? {} : { argv: [rawCommand, ...args] }),
    cwd: workspacePath,
    longRunning: vsCodeTaskKind(task) === 'dev-server',
    shell: isShell
  }
}

function vsCodeTaskKind(task: Record<string, unknown>): LaunchTargetKind {
  const label = String(task.label ?? '').toLowerCase()
  const group =
    typeof task.group === 'string'
      ? task.group.toLowerCase()
      : isObject(task.group) && typeof task.group.kind === 'string'
        ? task.group.kind.toLowerCase()
        : ''
  if (group === 'test' || label.includes('test')) return 'test'
  if (group === 'build' || label.includes('build')) return 'build'
  if (label.includes('dev') || label.includes('serve') || label.includes('watch')) return 'dev-server'
  return 'task'
}

function inferPlatformFromText(text: string): LaunchTargetPlatform {
  const value = text.toLowerCase()
  if (value.includes('electron')) return 'electron'
  if (/\b(vite|next|astro|remix|svelte|webpack|react-scripts)\b/.test(value)) return 'web'
  if (/\b(ios|iphone|ipad|xcode|xcodebuild)\b/.test(value)) return 'ios'
  if (/\b(macos|mac catalyst)\b/.test(value)) return 'macos'
  if (/\b(swift|swiftpm)\b/.test(value)) return 'swiftpm'
  if (/\b(node|ts-node|tsx)\b/.test(value)) return 'node'
  return 'unknown'
}

function swiftExecutableProducts(text: string): string[] {
  return Array.from(
    new Set(
      [...text.matchAll(/\.executable\s*\(\s*name:\s*"([^"]+)"/g)].map((match) => match[1])
    )
  )
}

async function xcodeSchemes(xcodePath: string): Promise<string[]> {
  const schemeDir = path.join(xcodePath, 'xcshareddata', 'xcschemes')
  try {
    const entries = await fs.readdir(schemeDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.xcscheme'))
      .map((entry) => entry.name.replace(/\.xcscheme$/, ''))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function command(argv: string[], cwd: string, longRunning: boolean): LaunchTargetCommand {
  return {
    raw: argv.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' '),
    argv,
    cwd,
    longRunning
  }
}

function substituteWorkspaceFolder(value: string, workspacePath: string): string {
  return value.replace(/\$\{workspaceFolder\}/g, workspacePath)
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function parseJsonc(text: string): unknown {
  return parseJson(removeJsonTrailingCommas(stripJsonComments(text)))
}

function stripJsonComments(text: string): string {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      output += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 1
      continue
    }
    output += char
  }
  return output
}

function removeJsonTrailingCommas(text: string): string {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === ',') {
      let lookahead = index + 1
      while (/\s/.test(text[lookahead] || '')) lookahead += 1
      if (text[lookahead] === '}' || text[lookahead] === ']') continue
    }
    output += char
  }
  return output
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function findLineNumber(text: string, needle: string): number | undefined {
  const index = text.indexOf(needle)
  if (index < 0) return undefined
  return text.slice(0, index).split('\n').length
}

function stableId(...parts: string[]): string {
  return `launch-${createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 12)}`
}

function compareTargets(a: LaunchTarget, b: LaunchTarget): number {
  return (
    SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    b.confidence - a.confidence ||
    a.label.localeCompare(b.label)
  )
}
