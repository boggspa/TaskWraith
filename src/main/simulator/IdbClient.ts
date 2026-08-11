/**
 * Argv-array execFile wrapper for Facebook's `idb` / `idb_companion`.
 * Never shells. Deps are injectable so unit tests never touch a real device.
 */
import { execFile } from 'child_process'
import { findExecutableOnHost } from '../HostToolResolver'
import {
  isSimulatorHardwareButton,
  isSimulatorRotateDirection,
  type SimulatorHardwareButton,
  type SimulatorInspectResult,
  type SimulatorRotateDirection
} from '../../shared/simulatorCanvas'

const IDB_TIMEOUT_MS = 60_000
/** Truncate AX dumps before they swamp MCP/transcript budgets. */
const DESCRIBE_ALL_MAX_CHARS = 200_000
const DESCRIBE_ALL_MAX_NODES = 500
/** Per-udid TTL for best-effort companion pre-warm (`idb connect`). */
const CONNECT_PREWARM_TTL_MS = 30_000

export type IdbExecRunner = (
  binary: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr: string }>

export interface IdbClientDeps {
  platform?: NodeJS.Platform
  resolveBinary?: (name: string) => string | null
  run?: IdbExecRunner
  now?: () => number
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

function tryParseJson(stdout: string): unknown | undefined {
  const trimmed = stdout.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

function countTreeNodes(value: unknown, budget: number): number {
  if (budget <= 0) return 0
  if (value === null || typeof value !== 'object') return 1
  if (Array.isArray(value)) {
    let count = 1
    for (const child of value) {
      count += countTreeNodes(child, budget - count)
      if (count >= budget) return count
    }
    return count
  }
  let count = 1
  for (const child of Object.values(value as Record<string, unknown>)) {
    count += countTreeNodes(child, budget - count)
    if (count >= budget) return count
  }
  return count
}

function truncateAxTree(tree: unknown): { tree: unknown; truncated: boolean } {
  const serialized = JSON.stringify(tree)
  if (serialized.length > DESCRIBE_ALL_MAX_CHARS) {
    if (Array.isArray(tree)) {
      const kept: unknown[] = []
      let chars = 2 // []
      for (const node of tree) {
        const piece = JSON.stringify(node)
        const next = chars + piece.length + (kept.length > 0 ? 1 : 0)
        if (next > DESCRIBE_ALL_MAX_CHARS || kept.length >= DESCRIBE_ALL_MAX_NODES) {
          return { tree: kept, truncated: true }
        }
        kept.push(node)
        chars = next
      }
      return { tree: kept, truncated: true }
    }
    return {
      tree: {
        truncated: true,
        preview: serialized.slice(0, DESCRIBE_ALL_MAX_CHARS),
        originalChars: serialized.length
      },
      truncated: true
    }
  }
  const nodes = countTreeNodes(tree, DESCRIBE_ALL_MAX_NODES + 1)
  if (nodes > DESCRIBE_ALL_MAX_NODES && Array.isArray(tree)) {
    return { tree: tree.slice(0, DESCRIBE_ALL_MAX_NODES), truncated: true }
  }
  if (nodes > DESCRIBE_ALL_MAX_NODES) {
    return {
      tree: {
        truncated: true,
        preview: serialized.slice(0, Math.min(serialized.length, DESCRIBE_ALL_MAX_CHARS)),
        originalNodes: nodes
      },
      truncated: true
    }
  }
  return { tree, truncated: false }
}

export class IdbClient {
  private readonly platform: NodeJS.Platform
  private readonly resolveBinary: (name: string) => string | null
  private readonly run: IdbExecRunner
  private readonly now: () => number
  private readonly connectCache = new Map<string, number>()
  private readonly connectInFlight = new Map<string, Promise<void>>()

  constructor(deps: IdbClientDeps = {}) {
    this.platform = deps.platform ?? process.platform
    this.resolveBinary = deps.resolveBinary ?? ((name) => findExecutableOnHost(name))
    this.run = deps.run ?? defaultRunner
    this.now = deps.now ?? (() => Date.now())
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

  /**
   * Serialises every idb CLI invocation from this client. Concurrent `idb`
   * processes each auto-spawn an `idb_companion` when none is live, racing on
   * the same /tmp/idb/<udid>_companion.sock path (observed on-host: three
   * companions, one udid, one socket, same start second). One invocation at a
   * time keeps companion acquisition single-threaded and gesture order
   * deterministic. A failed command never jams the queue.
   */
  private execQueue: Promise<void> = Promise.resolve()

  private exec(args: readonly string[]): Promise<IdbExecResult> {
    const result = this.execQueue.then(() => this.execSerialized(args))
    this.execQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async execSerialized(args: readonly string[]): Promise<IdbExecResult> {
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

  /**
   * Best-effort companion pre-warm: `idb connect <udid>` at most once per TTL
   * per target, deduped while in flight. Never throws — a failed pre-warm must
   * not block or fail the gesture that follows.
   */
  async ensureConnected(udid: string): Promise<void> {
    const id = typeof udid === 'string' ? udid.trim() : ''
    if (!id) return
    const last = this.connectCache.get(id)
    if (typeof last === 'number' && this.now() - last < CONNECT_PREWARM_TTL_MS) return
    const inFlight = this.connectInFlight.get(id)
    if (inFlight) return inFlight
    const pending = (async () => {
      try {
        await this.connect(id)
      } catch {
        // Pre-warm is best-effort; swallow so the gesture can proceed.
      } finally {
        this.connectCache.set(id, this.now())
        this.connectInFlight.delete(id)
      }
    })()
    this.connectInFlight.set(id, pending)
    return pending
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

  /**
   * Accessibility tree dump via `idb ui describe-all`. Prefer JSON stdout;
   * retry with `--json` when the first parse fails. Large trees are truncated.
   */
  async describeAll(udid: string): Promise<SimulatorInspectResult> {
    const id = typeof udid === 'string' ? udid.trim() : ''
    if (!id) {
      return { ok: false, error: 'idb describe-all requires a udid.' }
    }
    const first = await this.exec(withUdid(['ui', 'describe-all'], id))
    let parsed = first.ok ? tryParseJson(first.stdout) : undefined
    if (parsed === undefined) {
      const retry = await this.exec(withUdid(['ui', 'describe-all', '--json'], id))
      if (!retry.ok) {
        return {
          ok: false,
          error: retry.error || first.error || 'idb ui describe-all failed (stdout was not JSON).'
        }
      }
      parsed = tryParseJson(retry.stdout)
      if (parsed === undefined) {
        return {
          ok: false,
          error: 'idb ui describe-all returned non-JSON output.'
        }
      }
    }
    const { tree, truncated } = truncateAxTree(parsed)
    return { ok: true, tree, truncated }
  }

  async hardwareButton(udid: string, button: SimulatorHardwareButton): Promise<IdbExecResult> {
    if (!isSimulatorHardwareButton(button)) {
      return {
        ok: false,
        stdout: '',
        stderr: '',
        error:
          'idb ui button requires an allowlisted HID name (APPLE_PAY|HOME|LOCK|SIDE_BUTTON|SIRI).'
      }
    }
    const id = typeof udid === 'string' ? udid.trim() : ''
    if (!id) {
      return { ok: false, stdout: '', stderr: '', error: 'idb ui button requires a udid.' }
    }
    return this.exec(withUdid(['ui', 'button', button], id))
  }

  /**
   * Absolute rotate via `idb ui rotate PORTRAIT|PORTRAIT_UPSIDE_DOWN|LANDSCAPE_LEFT|LANDSCAPE_RIGHT`.
   * Relative CLOCKWISE/COUNTER_CLOCKWISE are rejected — Facebook idb expects absolutes.
   */
  async rotate(udid: string, direction: SimulatorRotateDirection): Promise<IdbExecResult> {
    if (!isSimulatorRotateDirection(direction)) {
      return {
        ok: false,
        stdout: '',
        stderr: '',
        error:
          'idb ui rotate requires an allowlisted orientation (PORTRAIT|PORTRAIT_UPSIDE_DOWN|LANDSCAPE_LEFT|LANDSCAPE_RIGHT).'
      }
    }
    const id = typeof udid === 'string' ? udid.trim() : ''
    if (!id) {
      return { ok: false, stdout: '', stderr: '', error: 'idb ui rotate requires a udid.' }
    }
    return this.exec(withUdid(['ui', 'rotate', direction], id))
  }
}
