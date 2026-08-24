import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmdirSync
} from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

import type { MuseRunSpawn, MuseRunSpawnHandle } from '../main/muse/MuseRun'
import type { HostNodeMuseBinaryResolution, HostNodeMuseResourcePort } from './HostNodeMuseProvider'

const MAX_AUTH_BYTES = 1024 * 1024

export interface HostNodeMuseResourcesOptions {
  readonly executablePath?: string
  readonly path?: string
  readonly temporaryParent?: string
  readonly authPath?: string
  readonly env?: NodeJS.ProcessEnv
  readonly spawn?: typeof nodeSpawn
  readonly afterAuthRead?: () => void
}

export interface HostNodeMuseResources extends HostNodeMuseResourcePort {
  /** Removes only the exact empty Host-owned temporary root. */
  dispose(): boolean
}

function safeExecutable(path: string): string | null {
  try {
    const resolved = realpathSync(path)
    const stat = lstatSync(resolved)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    accessSync(resolved, constants.X_OK)
    return resolved
  } catch {
    return null
  }
}

function resolveMuseExecutable(options: HostNodeMuseResourcesOptions): string | null {
  const explicit = options.executablePath
  if (explicit) return isAbsolute(explicit) ? safeExecutable(explicit) : null
  const env = options.env ?? process.env
  const names = process.platform === 'win32' ? ['muse.exe'] : ['muse']
  const candidates = [
    ...(options.path ?? env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .flatMap((dir) => names.map((name) => join(dir, name))),
    ...names.flatMap((name) =>
      ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'].map((dir) => join(dir, name))
    ),
    ...names.map((name) => join(env.HOME ?? homedir(), '.local/bin', name))
  ]
  for (const candidate of candidates) {
    const resolved = safeExecutable(candidate)
    if (resolved) return resolved
  }
  return null
}

function spawnAdapter(spawnImpl: typeof nodeSpawn): MuseRunSpawn {
  return (input): MuseRunSpawnHandle => {
    const child = spawnImpl(input.binaryPath, [...input.argv], {
      cwd: input.cwd,
      env: { ...input.env },
      shell: false,
      stdio: 'pipe'
    }) as ChildProcessWithoutNullStreams
    if (input.stdin) child.stdin.end(input.stdin)
    else child.stdin.end()
    let settle!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void
    const wait = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      settle = resolve
    })
    child.once('close', (code, signal) => settle({ code, signal }))
    child.once('error', () => settle({ code: null, signal: null }))
    return {
      pid: child.pid ?? null,
      kill: (signal) => {
        child.kill(signal)
      },
      onStdout: (listener) =>
        child.stdout.on('data', (chunk: Buffer) => listener(chunk.toString('utf8'))),
      onStderr: (listener) =>
        child.stderr.on('data', (chunk: Buffer) => listener(chunk.toString('utf8'))),
      wait: () => wait
    }
  }
}

function readExact(fd: number, size: number): string {
  const bytes = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const read = readSync(fd, bytes, offset, size - offset, offset)
    if (!Number.isSafeInteger(read) || read <= 0) throw new Error('Muse auth.json changed')
    offset += read
  }
  return bytes.toString('utf8')
}

/** Real Node Muse resource port; no shell and no credential projection/logging. */
export function createHostNodeMuseResources(
  options: HostNodeMuseResourcesOptions = {}
): HostNodeMuseResources {
  const temporaryRoot = realpathSync(
    mkdtempSync(join(options.temporaryParent ?? tmpdir(), 'taskwraith-muse-'))
  )
  const temporaryStat = lstatSync(temporaryRoot)
  if (!temporaryStat.isDirectory() || temporaryStat.isSymbolicLink())
    throw new Error('Unsafe Muse temporary root')
  if (process.platform !== 'win32') chmodSync(temporaryRoot, 0o700)
  const temporaryIdentity = { dev: String(temporaryStat.dev), ino: String(temporaryStat.ino) }
  let disposed = false
  const spawn = spawnAdapter(options.spawn ?? nodeSpawn)
  return {
    async resolveBinary(): Promise<HostNodeMuseBinaryResolution> {
      const binaryPath = resolveMuseExecutable(options)
      return binaryPath
        ? { binaryPath, source: options.executablePath ? 'explicit' : 'discovered' }
        : { binaryPath: null, error: 'Muse executable unavailable' }
    },
    getTemporaryRoot: () => temporaryRoot,
    async readAuthJsonText(): Promise<string | null> {
      const env = options.env ?? process.env
      const path =
        options.authPath ??
        join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), '.config'), 'muse/auth.json')
      if (!isAbsolute(path)) throw new Error('Muse auth path must be absolute')
      if (!path || !existsSync(path)) return null
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_AUTH_BYTES)
        throw new Error('Unsafe Muse auth.json')
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      try {
        const opened = fstatSync(fd)
        if (
          String(opened.ino) !== String(stat.ino) ||
          String(opened.dev) !== String(stat.dev) ||
          opened.size !== stat.size ||
          (process.platform !== 'win32' && (opened.mode & 0o077) !== 0)
        )
          throw new Error('Muse auth.json changed')
        const text = readExact(fd, opened.size)
        options.afterAuthRead?.()
        const afterDescriptor = fstatSync(fd)
        const after = lstatSync(path)
        if (
          String(afterDescriptor.ino) !== String(opened.ino) ||
          String(afterDescriptor.dev) !== String(opened.dev) ||
          afterDescriptor.size !== opened.size ||
          String(after.ino) !== String(opened.ino) ||
          String(after.dev) !== String(opened.dev) ||
          after.size !== opened.size ||
          (process.platform !== 'win32' &&
            ((afterDescriptor.mode & 0o077) !== 0 || (after.mode & 0o077) !== 0))
        )
          throw new Error('Muse auth.json changed')
        return text
      } finally {
        closeSync(fd)
      }
    },
    readMetaApiKeyEnv: () => {
      const value = (options.env ?? process.env).META_API_KEY
      return typeof value === 'string' && value.length > 0 && value.length <= MAX_AUTH_BYTES
        ? value
        : undefined
    },
    spawn,
    dispose: () => {
      if (disposed) return true
      try {
        const current = lstatSync(temporaryRoot)
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          String(current.dev) !== temporaryIdentity.dev ||
          String(current.ino) !== temporaryIdentity.ino
        )
          return false
        if (readdirSync(temporaryRoot).length !== 0) return false
        rmdirSync(temporaryRoot)
        disposed = true
        return true
      } catch {
        return false
      }
    }
  }
}
