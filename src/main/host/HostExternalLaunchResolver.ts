import { access } from 'node:fs/promises'
import { posix, win32, type PlatformPath } from 'node:path'

export interface HostExternalLaunchCommand {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

export interface ResolveHostExternalLaunchInput {
  readonly profilePath: string
  readonly packaged: boolean
  readonly resourcesPath?: string
  readonly repoRoot?: string
  readonly platform?: NodeJS.Platform
  readonly architecture?: NodeJS.Architecture
  readonly env?: NodeJS.ProcessEnv
  readonly nodeExecutable?: string
  readonly pathExists?: (path: string) => Promise<boolean>
  readonly isOrdinaryNode?: (path: string) => boolean
}

function paths(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? win32 : posix
}

function hostArgs(cli: string, profile: string): string[] {
  return [cli, 'serve', '--mode', 'production', '--profile', profile]
}

function cleanEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env }
  delete result.ELECTRON_RUN_AS_NODE
  return result
}

function ordinaryNode(path: string, platform: NodeJS.Platform): boolean {
  const name = paths(platform).basename(path).toLowerCase()
  return (name === 'node' || name === 'node.exe') && !/electron/i.test(path)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Pure desktop-side resolver for the external production Node Host. */
export async function resolveHostExternalLaunch(
  input: ResolveHostExternalLaunchInput
): Promise<HostExternalLaunchCommand | null> {
  const platform = input.platform ?? process.platform
  const api = paths(platform)
  const profile = input.profilePath
  if (
    !profile ||
    profile.trim() !== profile ||
    !api.isAbsolute(profile) ||
    api.resolve(profile) !== profile
  ) {
    throw new Error('External Host requires a canonical absolute profile path.')
  }
  const environment = cleanEnvironment(input.env ?? process.env)
  const pathExists = input.pathExists ?? exists
  let executable: string
  let cli: string
  if (input.packaged) {
    const resources = input.resourcesPath
    if (!resources || !api.isAbsolute(resources) || api.resolve(resources) !== resources)
      throw new Error('Packaged external Host requires resourcesPath.')
    const arch = input.architecture ?? process.arch
    executable = api.resolve(
      resources,
      'tui-runtime',
      `${platform}-${arch}`,
      platform === 'win32' ? 'node.exe' : 'node'
    )
    cli = api.resolve(resources, 'host', 'host-runtime', 'cli.js')
  } else {
    executable = input.nodeExecutable ?? process.execPath
    const verify =
      input.isOrdinaryNode ??
      ((path: string) => ordinaryNode(path, platform) && !process.versions.electron)
    if (!verify(executable))
      throw new Error('Development external Host requires an ordinary Node executable.')
    const root = input.repoRoot
    if (!root || !api.isAbsolute(root) || api.resolve(root) !== root)
      throw new Error('Development external Host requires repoRoot.')
    cli = api.resolve(root, 'out', 'host', 'host-runtime', 'cli.js')
  }
  if (!(await pathExists(executable)) || !(await pathExists(cli))) return null
  return { executable, args: hostArgs(cli, profile), cwd: api.dirname(cli), env: environment }
}
