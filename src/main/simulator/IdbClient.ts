/**
 * Argv-array execFile wrapper for Facebook's `idb` / `idb_companion`.
 * Never shells. Deps are injectable so unit tests never touch a real device.
 */
import { execFile } from 'child_process'
import { findExecutableOnHost } from '../HostToolResolver'

const IDB_TIMEOUT_MS = 60_000

export type IdbExecRunner = (
  binary: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr: string }>

export interface IdbClientDeps {
  platform?: NodeJS.Platform
  resolveBinary?: (name: string) => string | null
  run?: IdbExecRunner
}

export interface IdbExecResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

export interface IdbTarget {
  udid: string
  name?: string
  state?: string
  raw: string
}

function defaultRunner(
  binary: string,
  args: readonly string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      { maxBuffer: 16 * 1024 * 1024, timeout: IDB_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(`idb ${args[0] ?? ''} failed: ${String(stderr || '').trim() || err.message}`)
          )
        } else {
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        }
      }
    )
  })
}

function withUdid(args: string[], udid?: string): string[] {
  if (typeof udid === 'string' && udid.trim()) {
    return [...args, '--udid', udid.trim()]
  }
  return args
}

function parseListTargets(stdout: string): IdbTarget[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const targets: IdbTarget[] = []
  for (const line of lines) {
    // Typical: "iPhone 16 | AAAAAAAA-... | Shutdown | simulator | ..."
    const parts = line.split('|').map((part) => part.trim())
    const udid =
      parts.find((part) =>
        /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(part)
      ) ?? ''
    if (!udid) continue
    targets.push({
      udid,
      name: parts[0] || undefined,
      state: parts[2] || undefined,
      raw: line
    })
  }
  return targets
}

export class IdbClient {
  private readonly platform: NodeJS.Platform
  private readonly resolveBinary: (name: string) => string | null
  private readonly run: IdbExecRunner

  constructor(deps: IdbClientDeps = {}) {
    this.platform = deps.platform ?? process.platform
    this.resolveBinary = deps.resolveBinary ?? ((name) => findExecutableOnHost(name))
    this.run = deps.run ?? defaultRunner
  }

  /** True when the `idb` client binary resolves on PATH (macOS only). */
  isAvailable(): boolean {
    if (this.platform !== 'darwin') return false
    return Boolean(this.resolveBinary('idb'))
  }

  companionAvailable(): boolean {
    if (this.platform !== 'darwin') return false
    return Boolean(this.resolveBinary('idb_companion'))
  }

  resolveIdbPath(): string | null {
    if (this.platform !== 'darwin') return null
    return this.resolveBinary('idb')
  }

  resolveCompanionPath(): string | null {
    if (this.platform !== 'darwin') return null
    return this.resolveBinary('idb_companion')
  }

  private requireIdb(): string {
    const path = this.resolveIdbPath()
    if (!path) {
      throw new Error('idb is not available on PATH. Install idb-companion and fb-idb first.')
    }
    return path
  }

  private async exec(args: readonly string[]): Promise<IdbExecResult> {
    try {
      const binary = this.requireIdb()
      const { stdout, stderr } = await this.run(binary, args)
      return { ok: true, stdout, stderr }
    } catch (error) {
      return {
        ok: false,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async listTargets(): Promise<{ ok: boolean; targets?: IdbTarget[]; error?: string }> {
    const result = await this.exec(['list-targets'])
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, targets: parseListTargets(result.stdout) }
  }

  async connect(udid: string): Promise<IdbExecResult> {
    return this.exec(['connect', udid.trim()])
  }

  async boot(udid: string): Promise<IdbExecResult> {
    return this.exec(['boot', udid.trim()])
  }

  async screenshot(udid: string, outputPath: string): Promise<IdbExecResult> {
    return this.exec(withUdid(['screenshot', outputPath], udid))
  }

  async tap(udid: string, x: number, y: number): Promise<IdbExecResult> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, stdout: '', stderr: '', error: 'idb tap requires finite x/y.' }
    }
    return this.exec(withUdid(['ui', 'tap', String(Math.round(x)), String(Math.round(y))], udid))
  }

  async text(udid: string, value: string): Promise<IdbExecResult> {
    if (typeof value !== 'string') {
      return { ok: false, stdout: '', stderr: '', error: 'idb text requires a string.' }
    }
    return this.exec(withUdid(['ui', 'text', value], udid))
  }

  async swipe(
    udid: string,
    xStart: number,
    yStart: number,
    xEnd: number,
    yEnd: number
  ): Promise<IdbExecResult> {
    const coords = [xStart, yStart, xEnd, yEnd]
    if (coords.some((value) => !Number.isFinite(value))) {
      return { ok: false, stdout: '', stderr: '', error: 'idb swipe requires finite coordinates.' }
    }
    return this.exec(
      withUdid(
        [
          'ui',
          'swipe',
          String(Math.round(xStart)),
          String(Math.round(yStart)),
          String(Math.round(xEnd)),
          String(Math.round(yEnd))
        ],
        udid
      )
    )
  }
}
