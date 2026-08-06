/**
 * Daemon client for process-ancestry proofs.
 *
 * The daemon answers a closed question — "is this window's process a live
 * descendant of the launch process, and what is the chain" — and this module
 * hands the answer straight to the pure verifier before anyone can act on it.
 * A refusal, a timeout, or anything that fails verification resolves to null,
 * which leaves ownership exactly as strict as it was before ancestry existed.
 */
import {
  NATIVE_WINDOW_ANCESTRY_MAX_DEPTH,
  isCanonicalProcessStartedAt,
  verifyNativeWindowProcessAncestry,
  type NativeWindowProcessAncestryProof
} from './NativeWindowProcessAncestry'

export interface NativeWindowProcessAncestryDaemon {
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>
}

export interface NativeWindowProcessAncestryResolverOptions {
  readonly daemon: NativeWindowProcessAncestryDaemon
  readonly platform?: NodeJS.Platform
  readonly timeoutMs?: number
  readonly maxDepth?: number
}

export interface NativeWindowProcessAncestryRequest {
  /** The attached window's process. */
  readonly leafPid: number
  readonly leafProcessStartedAt: string
  /** The launch process the window must descend from. */
  readonly rootPid: number
  readonly rootProcessStartedAt: string
  readonly hostProtectedPids?: ReadonlySet<number> | readonly number[]
}

export type NativeWindowProcessAncestryResolver = (
  request: NativeWindowProcessAncestryRequest
) => Promise<NativeWindowProcessAncestryProof | null>

export function createNativeWindowProcessAncestryResolver(
  options: NativeWindowProcessAncestryResolverOptions
): NativeWindowProcessAncestryResolver {
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? 2_000
  const maxDepth = options.maxDepth ?? NATIVE_WINDOW_ANCESTRY_MAX_DEPTH
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Native process-ancestry timeout must be a positive integer.')
  }
  if (
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 1 ||
    maxDepth > NATIVE_WINDOW_ANCESTRY_MAX_DEPTH
  ) {
    throw new Error('Native process-ancestry depth cap is invalid.')
  }

  return async (request) => {
    if (platform !== 'darwin' || !isValidRequest(request)) return null

    // The window may simply be the launch process. That needs no daemon call
    // and no chain: it is the exact match the gate already accepted.
    if (
      request.leafPid === request.rootPid &&
      request.leafProcessStartedAt === request.rootProcessStartedAt
    ) {
      return verified(
        [{ pid: request.leafPid, ppid: 0, processStartedAt: request.leafProcessStartedAt }],
        request,
        maxDepth
      )
    }

    let response: unknown
    try {
      response = await options.daemon.request(
        'nativeWindow.processAncestry',
        { pid: request.leafPid, ancestorPid: request.rootPid, maxDepth },
        { timeoutMs }
      )
    } catch {
      // The daemon refuses when the process is not a live descendant, which is
      // an ordinary answer here rather than an error worth surfacing.
      return null
    }

    if (!isRecord(response) || !Array.isArray(response.chain) || response.chain.length < 1) {
      return null
    }
    return verified(response.chain.map(narrowLink), request, maxDepth)
  }
}

/**
 * Keep only what the proof is allowed to be made of. The daemon also returns
 * `launchTimeMicros` and `source`; `processStartedAt` already carries both, and
 * a second copy of the same fact is a second thing to keep consistent.
 */
function narrowLink(value: unknown): unknown {
  if (!isRecord(value)) return value
  return { pid: value.pid, ppid: value.ppid, processStartedAt: value.processStartedAt }
}

function verified(
  chain: unknown[],
  request: NativeWindowProcessAncestryRequest,
  maxDepth: number
): NativeWindowProcessAncestryProof | null {
  const result = verifyNativeWindowProcessAncestry({
    chain,
    leafPid: request.leafPid,
    leafProcessStartedAt: request.leafProcessStartedAt,
    rootPid: request.rootPid,
    rootProcessStartedAt: request.rootProcessStartedAt,
    hostProtectedPids: request.hostProtectedPids,
    maxDepth
  })
  return result.ok ? result.proof : null
}

function isValidRequest(request: NativeWindowProcessAncestryRequest | null | undefined): boolean {
  return Boolean(
    isRecord(request) &&
    isPositiveInteger(request.leafPid) &&
    isPositiveInteger(request.rootPid) &&
    isCanonicalProcessStartedAt(request.leafProcessStartedAt) &&
    isCanonicalProcessStartedAt(request.rootProcessStartedAt)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
