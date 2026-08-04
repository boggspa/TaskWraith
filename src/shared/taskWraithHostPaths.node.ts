import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'

/**
 * Host Arc v2 local-control paths.
 *
 * Mirrors the shipped v1 module (`taskWraithControlPaths.node.ts`) structurally
 * but uses a **DISTINCT v2 namespace** to guarantee zero collision with the v1
 * control-socket family.  The directory name encodes `host-v2` so that even
 * when both v1 and v2 are active on the same machine they never share a socket,
 * token, or discovery path.
 *
 * # Collision-avoidance (risk C, PIN W3-P1)
 *
 * | Surface          | v1 path                                          | v2 path                                                     |
 * |------------------|--------------------------------------------------|-------------------------------------------------------------|
 * | Directory        | `tw-{uid}-{sha16}`                               | `twh2-{uid}-{sha16}`                                        |
 * | Socket file      | `taskwraith-control-v1.sock`                      | `taskwraith-host-v2.sock`                                   |
 * | Token file       | `taskwraith-control-v1.token` (in userData)       | `taskwraith-host-v2.token` (in userData)                    |
 * | Discovery file   | `taskwraith-control-v1.json` (in userData)        | `taskwraith-host-v2.json` (in userData)                     |
 *
 * The directory prefix `twh2` encodes "host v2" in 4 chars so the overall
 * path stays within the macOS sockaddr_un limit (~104 bytes).  Every filename
 * carries the full `host-v2` literal, and both mechanisms together make
 * collision structurally impossible regardless of `uid` or `sha16` overlap.
 *
 * Pure Node — zero Electron imports.  All path constructors accept an
 * injected base directory for testability; the module that applies file-system
 * permissions (0700 directories, 0600 files) lives with the server.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Join using the SEMANTICS OF THE REQUESTED PLATFORM, not the host's.
 *
 * These helpers take a `platform` argument, which promises a caller can
 * derive another platform's path. `node:path`'s bare `join` always uses the
 * host's separator, so asking for a darwin path on Windows returned
 * `\\Users\\example\\...` and the promise was false. Production always passes
 * the host platform, so this is behaviour-preserving there; it only makes the
 * cross-platform case — which the signature already advertised — actually work.
 */
function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32' ? win32.join(...parts) : posix.join(...parts)
}

// ---------------------------------------------------------------------------
// File-name constants (distinct v2 namespace — see header table)
// ---------------------------------------------------------------------------

export const TASKWRAITH_HOST_DISCOVERY_FILE = 'taskwraith-host-v2.json'
export const TASKWRAITH_HOST_TOKEN_FILE = 'taskwraith-host-v2.token'
export const TASKWRAITH_HOST_SOCKET_FILE = 'taskwraith-host-v2.sock'

// ---------------------------------------------------------------------------
// Discovery payload
// ---------------------------------------------------------------------------

/**
 * Written to `TASKWRAITH_HOST_DISCOVERY_FILE` by the Host local server on
 * start.  Clients read this file to locate the socket and token.
 *
 * The shape mirrors v1's `TaskWraithControlDiscovery` but pins `protocolVersion`
 * to the Host Arc wire protocol version (2).
 */
export interface TaskWraithHostDiscovery {
  /** Host Arc wire protocol version (= `HOST_PROTOCOL_VERSION`). */
  protocolVersion: 2
  /** Absolute path to the Unix-domain socket or Windows named pipe. */
  socketPath: string
  /** Absolute path to the token file the client must read for authentication. */
  tokenPath: string
  /** PID of the Host process that wrote this discovery record. */
  pid: number
  /** ISO-8601 timestamp of when the server started. */
  startedAt: string
}

// ---------------------------------------------------------------------------
// Decoder (typed, fail-closed)
// ---------------------------------------------------------------------------

export type TaskWraithHostDiscoveryDecodeResult =
  | { ok: true; discovery: TaskWraithHostDiscovery }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown, max = 16_000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/**
 * Validate and coerce a raw JSON parse result into a `TaskWraithHostDiscovery`.
 * Fails closed on any shape or type mismatch — no partial reads, no defaults.
 */
export function decodeTaskWraithHostDiscovery(value: unknown): TaskWraithHostDiscoveryDecodeResult {
  if (!isRecord(value)) return { ok: false, error: 'discovery must be an object' }

  if (value.protocolVersion !== 2) {
    return { ok: false, error: 'unsupported protocol version' }
  }

  if (!isNonEmptyString(value.socketPath, 1_000)) {
    return { ok: false, error: 'socketPath must be a non-empty bounded string' }
  }

  if (!isNonEmptyString(value.tokenPath, 1_000)) {
    return { ok: false, error: 'tokenPath must be a non-empty bounded string' }
  }

  if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid < 1) {
    return { ok: false, error: 'pid must be a positive integer' }
  }

  if (!isNonEmptyString(value.startedAt, 100)) {
    return { ok: false, error: 'startedAt must be a non-empty bounded string' }
  }

  return {
    ok: true,
    discovery: {
      protocolVersion: 2,
      socketPath: value.socketPath as string,
      tokenPath: value.tokenPath as string,
      pid: value.pid as number,
      startedAt: value.startedAt as string
    }
  }
}

// ---------------------------------------------------------------------------
// Path constructors
// ---------------------------------------------------------------------------

/**
 * Absolute path to the Host discovery JSON file inside `userDataPath`.
 */
export function taskWraithHostDiscoveryPath(userDataPath: string): string {
  return join(userDataPath, TASKWRAITH_HOST_DISCOVERY_FILE)
}

/**
 * Absolute path to the Host token file inside `userDataPath`.
 *
 * The server writes a `randomBytes(32)` hex token here with 0600 permissions
 * before accepting connections (per PIN W3-P1 auth-reuse pattern).
 */
export function taskWraithHostTokenPath(userDataPath: string): string {
  return join(userDataPath, TASKWRAITH_HOST_TOKEN_FILE)
}

/**
 * Absolute path to the Host v2 socket (Unix-domain or Windows named pipe).
 *
 * # POSIX (macOS / Linux)
 *
 * Returns a path inside a short, per-user private temp directory to keep the
 * overall length under the ~104-byte sockaddr_un limit (macOS).  The directory
 * is `twh2-{uid}-{suffix}` where `suffix` is the first 16 hex chars of
 * SHA-256(userDataPath).  The `h2` encodes "host v2" in the directory prefix
 * (saving 5 chars vs the full literal) to stay under the limit; the full
 * `host-v2` literal lives in every filename.
 *
 * # Windows
 *
 * Returns a named-pipe path `\\.\pipe\taskwraith-host-v2-{suffix}`.
 * The `host-v2` literal in the pipe name guarantees non-collision with v1's
 * `taskwraith-control-{suffix}` pipe.
 *
 * # Testability
 *
 * `userDataPath` is injected — callers pass the same value the Host runtime
 * uses.  This keeps the function pure and trivially testable without
 * filesystem side effects.
 */
export function taskWraithHostSocketPath(
  userDataPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const suffix = createHash('sha256').update(userDataPath).digest('hex').slice(0, 16)
  if (platform === 'win32') {
    return `\\\\.\\pipe\\taskwraith-host-v2-${suffix}`
  }
  // POSIX: short tmpdir path to stay within macOS sockaddr_un limit (~104 bytes).
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return join(tmpdir(), `twh2-${uid}-${suffix}`, TASKWRAITH_HOST_SOCKET_FILE)
}
