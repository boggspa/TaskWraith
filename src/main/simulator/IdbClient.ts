/**
 * Argv-array execFile wrapper for Facebook's `idb` / `idb_companion`.
 * Never shells. Deps are injectable so unit tests never touch a real device.
 */
import { execFile } from 'child_process'
import { findExecutableOnHost } from '../HostToolResolver'
import { createDefaultIdbGrpcTransport, type IdbGrpcTransport } from './IdbGrpcTransport'
import {
  isSimulatorHardwareButton,
  isSimulatorRotateDirection,
  type SimulatorHardwareButton,
  type SimulatorInspectResult,
  type SimulatorRotateDirection
} from '../../shared/simulatorCanvas'

const IDB_TIMEOUT_MS = 60_000
const IDB_ERROR_MAX_CHARS = 600
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
  grpcTransport?: IdbGrpcTransport | null
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
  args: readonly string[],
  companionPath: string | null
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      {
        env: idbChildEnvironment(companionPath),
        maxBuffer: 16 * 1024 * 1024,
        timeout: IDB_TIMEOUT_MS
      },
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

/**
 * fb-idb otherwise falls back to `/usr/local/bin/idb_companion`, which is
 * wrong for Apple Silicon Homebrew. Keep the caller's environment intact and
 * pin the exact executable already resolved by TaskWraith's host resolver.
 */
export function idbChildEnvironment(
  companionPath: string | null,
  baseEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...baseEnvironment,
    ...(companionPath ? { IDB_COMPANION: companionPath } : {})
  }
}

/** Never send a Python traceback or an unbounded subprocess error to Canvas. */
export function summarizeIdbExecutionError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const normalized = raw.replace(/\r/g, '').trim()
  if (!normalized) return 'idb command failed.'

  if (
    /(?:No such file or directory|FileNotFoundError)[\s\S]*idb_companion/i.test(normalized) ||
    /idb_companion[\s\S]*(?:No such file or directory|FileNotFoundError)/i.test(normalized)
  ) {
    return 'Simulator control could not start idb_companion. Re-run Simulator control setup and try again.'
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const lastMeaningful =
    [...lines]
      .reverse()
      .find(
        (line) =>
          line !== 'Traceback (most recent call last):' &&
          !line.startsWith('File "') &&
          !/^at\s/.test(line)
      ) || normalized
  return lastMeaningful.length <= IDB_ERROR_MAX_CHARS
    ? lastMeaningful
    : `${lastMeaningful.slice(0, IDB_ERROR_MAX_CHARS - 1)}…`
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
  private readonly grpcTransport: IdbGrpcTransport | null
  private readonly connectCache = new Map<string, number>()
  private readonly connectInFlight = new Map<string, Promise<void>>()

  constructor(deps: IdbClientDeps = {}) {
    this.platform = deps.platform ?? process.platform
    this.resolveBinary = deps.resolveBinary ?? ((name) => findExecutableOnHost(name))
    this.run =
      deps.run ?? ((binary, args) => defaultRunner(binary, args, this.resolveCompanionPath()))
    this.now = deps.now ?? (() => Date.now())
    this.grpcTransport =
      deps.grpcTransport === undefined ? createDefaultIdbGrpcTransport() : deps.grpcTransport
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

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.execQueue.then(operation)
    this.execQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private exec(args: readonly string[]): Promise<IdbExecResult> {
    return this.enqueue(() => this.execSerialized(args))
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
        error: summarizeIdbExecutionError(error)
      }
    }
  }

  /**
   * Keep the gRPC fast path and CLI fallback inside one queue operation. If
   * they used separate queues, a later gRPC gesture could overtake an earlier
   * gesture while that earlier call was falling back to the Python client.
   */
  private execGesture(
    grpcOperation: (transport: IdbGrpcTransport) => Promise<void>,
    cliArgs: readonly string[]
  ): Promise<IdbExecResult> {
    return this.enqueue(async () => {
      if (this.platform === 'darwin' && this.grpcTransport) {
        try {
          await grpcOperation(this.grpcTransport)
          return { ok: true, stdout: '', stderr: '' }
        } catch {
          // Socket absent, companion down, or schema mismatch: preserve the
          // mature CLI path rather than turning a latency win into downtime.
        }
      }
      return this.execSerialized(cliArgs)
    })
  }

  private prewarmConnection(udid: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.platform === 'darwin' && this.grpcTransport) {
        try {
          await this.grpcTransport.describe(udid)
          return
        } catch {
          // No healthy companion channel yet; let the CLI connect/spawn it.
        }
      }
      await this.execSerialized(['connect', udid])
    })
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
        await this.prewarmConnection(id)
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
    const roundedX = Math.round(x)
    const roundedY = Math.round(y)
    return this.execGesture(
      (transport) => transport.tap(udid, roundedX, roundedY),
      withUdid(['ui', 'tap', String(roundedX), String(roundedY)], udid)
    )
  }

  async text(udid: string, value: string): Promise<IdbExecResult> {
    if (typeof value !== 'string') {
      return { ok: false, stdout: '', stderr: '', error: 'idb text requires a string.' }
    }
    return this.execGesture(
      (transport) => transport.text(udid, value),
      withUdid(['ui', 'text', value], udid)
    )
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
    const rounded = coords.map((value) => Math.round(value))
    return this.execGesture(
      (transport) => transport.swipe(udid, rounded[0], rounded[1], rounded[2], rounded[3]),
      withUdid(['ui', 'swipe', ...rounded.map((value) => String(value))], udid)
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
