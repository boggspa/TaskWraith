/**
 * Pure verifier for a process-ancestry proof.
 *
 * Native-window ownership is decided by exact PID plus canonical process-birth
 * receipt. That is correct but, on its own, too narrow: the PID TaskWraith
 * records for a launch is the direct child of the spawn (`npm`), while the
 * window the user attaches belongs to a descendant several generations down
 * (`npm` -> `node` -> `electron`). Refusing that window means an agent can
 * never drive the app it just started.
 *
 * A process group is still not an identity — unrelated processes can join one —
 * so this module verifies an explicit parent chain instead. Each link carries
 * its own proc_bsdinfo birth receipt, and the chain is only a proof when every
 * link joins up and no child predates its parent. That last rule is what makes
 * PID reuse unusable: a recycled PID carries a later birth receipt than the
 * child that claims it as a parent.
 *
 * The daemon resolves the chain; this module is the authority on whether it
 * proves anything. Nothing here performs a process lookup.
 */

/** Depth cap for a launch -> window chain. `npm run dev` needs about four. */
export const NATIVE_WINDOW_ANCESTRY_MAX_DEPTH = 8 as const

const CANONICAL_PROCESS_STARTED_AT_PATTERN =
  /^(?:procBSDInfo|nsRunningApplication):([1-9][0-9]{0,18})$/

/** One verified generation: a process, its parent, and its birth receipt. */
export interface NativeWindowProcessAncestryLink {
  readonly pid: number
  readonly ppid: number
  readonly processStartedAt: string
}

/**
 * A verified descent from `rootPid` to `leafPid`. Carried on the ownership
 * input so the synchronous revalidator can recheck it without a daemon call.
 */
export interface NativeWindowProcessAncestryProof {
  readonly rootPid: number
  readonly rootProcessStartedAt: string
  readonly leafPid: number
  readonly leafProcessStartedAt: string
  /** Generations traversed; 0 when the window process is the launch process. */
  readonly depth: number
  readonly chain: readonly NativeWindowProcessAncestryLink[]
}

export type NativeWindowProcessAncestryFailureCode =
  | 'invalid-input'
  | 'malformed-chain'
  | 'leaf-mismatch'
  | 'root-mismatch'
  | 'broken-link'
  | 'birth-order-violation'
  | 'depth-exceeded'
  | 'protected-process'

export interface NativeWindowProcessAncestryFailure {
  readonly ok: false
  readonly code: NativeWindowProcessAncestryFailureCode
  readonly message: string
}

export interface NativeWindowProcessAncestrySuccess {
  readonly ok: true
  readonly proof: NativeWindowProcessAncestryProof
}

export type NativeWindowProcessAncestryResult =
  | NativeWindowProcessAncestrySuccess
  | NativeWindowProcessAncestryFailure

export interface NativeWindowProcessAncestryInput {
  /** Daemon-supplied chain, leaf first. Untrusted until this module says so. */
  readonly chain: unknown
  readonly leafPid: number
  readonly leafProcessStartedAt: string
  readonly rootPid: number
  readonly rootProcessStartedAt: string
  readonly hostProtectedPids?: ReadonlySet<number> | readonly number[]
  readonly maxDepth?: number
}

/**
 * Verify that `leafPid` descends from `rootPid`.
 *
 * Protected host PIDs are refused only at the leaf: driving TaskWraith's own
 * window is the thing the invariant forbids. Appearing further up the chain is
 * an ancestry fact and carries no authority — process adoption deliberately
 * anchors on the TaskWraith process itself.
 */
export function verifyNativeWindowProcessAncestry(
  input: NativeWindowProcessAncestryInput | null | undefined
): NativeWindowProcessAncestryResult {
  try {
    return verify(input)
  } catch {
    return fail('invalid-input', 'The process-ancestry proof could not be evaluated.')
  }
}

function verify(
  input: NativeWindowProcessAncestryInput | null | undefined
): NativeWindowProcessAncestryResult {
  if (!isRecord(input)) {
    return fail('invalid-input', 'A process-ancestry proof requires exact inputs.')
  }

  const maxDepth = input.maxDepth ?? NATIVE_WINDOW_ANCESTRY_MAX_DEPTH
  if (!isPositiveInteger(maxDepth) || maxDepth > NATIVE_WINDOW_ANCESTRY_MAX_DEPTH) {
    return fail('invalid-input', 'The process-ancestry depth cap is invalid.')
  }
  if (
    !isPositiveInteger(input.leafPid) ||
    !isPositiveInteger(input.rootPid) ||
    !isCanonicalProcessStartedAt(input.leafProcessStartedAt) ||
    !isCanonicalProcessStartedAt(input.rootProcessStartedAt)
  ) {
    return fail('invalid-input', 'The process-ancestry endpoints are not exact identities.')
  }

  const chain = normalizeChain(input.chain)
  if (!chain) {
    return fail('malformed-chain', 'The process-ancestry chain is malformed.')
  }
  // A chain of N entries crosses N-1 generations, so the cap bounds the links.
  if (chain.length - 1 > maxDepth) {
    return fail(
      'depth-exceeded',
      `The window process is more than ${maxDepth} generations below the launch process.`
    )
  }

  const leaf = chain[0]
  if (leaf.pid !== input.leafPid || leaf.processStartedAt !== input.leafProcessStartedAt) {
    return fail('leaf-mismatch', 'The chain does not start at the attached window process.')
  }

  const root = chain[chain.length - 1]
  if (root.pid !== input.rootPid || root.processStartedAt !== input.rootProcessStartedAt) {
    return fail('root-mismatch', 'The chain does not reach the exact launch process.')
  }

  if (protectedPidSet(input.hostProtectedPids).has(leaf.pid)) {
    return fail('protected-process', 'The attached window belongs to a protected host process.')
  }

  for (let index = 0; index < chain.length - 1; index += 1) {
    const child = chain[index]
    const parent = chain[index + 1]
    if (child.ppid !== parent.pid) {
      return fail('broken-link', 'The process-ancestry chain has a missing generation.')
    }
    // A live parent cannot have been born after its child. A recycled PID
    // fails here, which is what keeps the chain from being forgeable.
    if (birthMicros(parent) > birthMicros(child)) {
      return fail(
        'birth-order-violation',
        'A process in the chain started after its own child; the identity was recycled.'
      )
    }
  }

  return {
    ok: true,
    proof: Object.freeze({
      rootPid: root.pid,
      rootProcessStartedAt: root.processStartedAt,
      leafPid: leaf.pid,
      leafProcessStartedAt: leaf.processStartedAt,
      depth: chain.length - 1,
      chain: Object.freeze(chain.map((link) => Object.freeze({ ...link })))
    })
  }
}

/** Structural narrowing plus the cycle guard; returns null on anything odd. */
function normalizeChain(value: unknown): NativeWindowProcessAncestryLink[] | null {
  if (!Array.isArray(value) || value.length < 1) return null
  const seen = new Set<number>()
  const chain: NativeWindowProcessAncestryLink[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return null
    const { pid, ppid, processStartedAt } = entry
    if (
      !isPositiveInteger(pid) ||
      !isNonNegativeInteger(ppid) ||
      !isCanonicalProcessStartedAt(processStartedAt)
    ) {
      return null
    }
    if (seen.has(pid)) return null
    seen.add(pid)
    chain.push({ pid, ppid, processStartedAt })
  }
  return chain
}

export function isCanonicalProcessStartedAt(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_PROCESS_STARTED_AT_PATTERN.test(value)
}

function birthMicros(link: NativeWindowProcessAncestryLink): number {
  const match = CANONICAL_PROCESS_STARTED_AT_PATTERN.exec(link.processStartedAt)
  // normalizeChain already rejected anything this cannot parse.
  return match ? Number(match[1]) : Number.NaN
}

function protectedPidSet(
  value: ReadonlySet<number> | readonly number[] | undefined
): ReadonlySet<number> {
  if (!value) return new Set<number>()
  return value instanceof Set ? value : new Set(value as readonly number[])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function fail(
  code: NativeWindowProcessAncestryFailureCode,
  message: string
): NativeWindowProcessAncestryFailure {
  return Object.freeze({ ok: false as const, code, message })
}
