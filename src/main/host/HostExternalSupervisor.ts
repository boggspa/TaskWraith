import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import {
  HostProjectionClient,
  HostProjectionIncompatibleProtocolError,
  HostProjectionTransportError,
  type HostProjectionDiscoveryProcessIdentity
} from '../../host-client/HostProjectionClient'
import {
  HOST_TERMINATION_ACK_MS,
  HOST_TERMINATION_DRAIN_MS,
  HOST_TERMINATION_SUCCESS_KINDS,
  hostTerminationExpectation,
  hostTerminationTargetPid,
  isHostServeCommandFor,
  readHostTerminationEvidence,
  terminateHostProcess,
  type HostTerminationExpectedHost,
  type HostTerminationOutcome
} from '../../host-client/HostProcessTermination'
import { HostShutdownClient, HostShutdownIdentityError } from '../../host-client/HostShutdownClient'
import { canonicalHostProfilePath, resolveHostRegistryRoot } from '../../host-runtime/HostRegistry'
import {
  matchProcessBirth,
  observeProcessBirthIdentity,
  observeProcessCommandLine
} from '../../host-runtime/ProcessBirthIdentity'
import type { HostLifecycleHostIdentity } from '../../shared/hostLifecycle'
import type { HostCapability, HostBootstrapWelcome } from '../../shared/hostProtocol'
import {
  holdExternalHostForBoot,
  releaseExternalHostBootHold,
  type HostExternalHeldConnection
} from './HostExternalBootHold'
import type { HostExternalLaunchCommand } from './HostExternalLaunchResolver'

/** The Host used to be spawned with stdio:'ignore', so a refusal to start was
 *  invisible and the app silently fell back to the in-process Host — whose
 *  projection reconciler then re-reads the chat list on a 1s main-process
 *  timer. Keep a bounded tail so the failure can name itself. */
const STDERR_TAIL_LIMIT = 2_000

/**
 * How long a launch waits for a Host that is still stopping to let go of the
 * profile authority (S1a review A2/C2). A Host stops on its own now — its last
 * lease went, or its registry entry did — and for that whole stop its listener
 * is closed while it still holds the authority, so a Host spawned in that
 * window exits at once with "The profile authority is held by pid N (owner is
 * live)". Such a stop ends within the Host's HOST_LIFETIME_STOP_DEADLINE_MS
 * (120 s; `src/host-node/HostNodeProductionServer.ts`), and a stop that fails
 * or overruns ends the process. This literal keeps a margin over that
 * deadline; `HostExternalSupervisor.test.ts` pins it against the Host's
 * constant so the two cannot drift apart. It is a literal because importing
 * the Host server here would pull the whole Host into main's bootstrap bundle.
 */
export const HOST_EXTERNAL_AUTHORITY_WAIT_MS = 135_000

/** Poll cadence while waiting on a stopping Host: two `ps` reads per poll. */
const AUTHORITY_POLL_MS = 500

/** One launch, plus a respawn after each stopping Host a launch had to wait out. */
const DEFAULT_MAX_LAUNCH_ATTEMPTS = 3

/**
 * The Host's refusal to start while another live process holds the profile
 * authority (`HostProfileAuthorityLeaseBusyError`, printed by the Host CLI).
 * An indeterminate owner is not matched: nothing waits on what it cannot
 * verify.
 */
export const HOST_AUTHORITY_BUSY_PATTERN =
  /The profile authority is held by pid (\d+) \(owner is live\)/

const FLOOR: readonly HostCapability[] = [
  'commands',
  'receipts',
  'setup',
  'provider-catalog',
  'provider-auth',
  'history',
  'health'
]

export type HostExternalSupervisorStatus =
  | 'idle'
  | 'probing'
  | 'launching'
  | 'waiting-for-authority'
  | 'restarting'
  | 'attached-existing'
  | 'attached-launched'
  | 'failed'
  | 'closed'
export type HostExternalEnsureResult =
  | {
      readonly kind: 'existing'
      readonly welcome: HostBootstrapWelcome
      /** From the discovery record the probe authenticated through. */
      readonly host?: HostLifecycleHostIdentity
    }
  | {
      readonly kind: 'launched'
      readonly pid: number | null
      readonly welcome: HostBootstrapWelcome
      readonly host?: HostLifecycleHostIdentity
    }

export class HostExternalProductionModeError extends HostProjectionIncompatibleProtocolError {
  constructor() {
    super('External Host is App-mode, diagnostic, or missing production capabilities.')
    this.name = 'HostExternalProductionModeError'
  }
}

/**
 * Who holds this profile's authority lease, judged by the pid it names:
 * `none` when there is no record or its pid is dead or reused (the next Host
 * reclaims it), `host` when that pid is alive with the recorded birth and runs
 * a Host serving this profile, `unverifiable` otherwise (identity unavailable,
 * no birth evidence, or not a Host — the in-process lane records Electron
 * main's own pid).
 */
export type HostExternalAuthorityOwner =
  | { readonly kind: 'none' }
  | { readonly kind: 'host'; readonly pid: number }
  | { readonly kind: 'unverifiable'; readonly pid: number; readonly detail: string }

export interface HostExternalSupervisorOptions {
  readonly profilePath: string
  readonly probe?: (timeoutMs: number) => Promise<HostBootstrapWelcome | HostExternalProbeResult>
  readonly resolveLaunch: () => Promise<HostExternalLaunchCommand | null>
  readonly shutdownExisting?: (
    profilePath: string,
    expected: HostTerminationExpectedHost
  ) => Promise<unknown>
  /**
   * Verified termination (D9) after `shutdownExisting` failed: identity-checked
   * TERM then KILL. `cause` is the socket failure, so the socket stop is not
   * asked twice.
   */
  readonly terminateExisting?: (
    profilePath: string,
    cause: unknown,
    expected: HostTerminationExpectedHost
  ) => Promise<Pick<HostTerminationOutcome, 'kind' | 'pid' | 'detail'>>
  readonly observeAuthorityOwner?: (profilePath: string) => Promise<HostExternalAuthorityOwner>
  readonly spawn?: (
    executable: string,
    args: readonly string[],
    options: SpawnOptions
  ) => ChildProcess
  readonly now?: () => number
  readonly delay?: (milliseconds: number) => Promise<void>
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly probeTimeoutMs?: number
  readonly authorityWaitMs?: number
  readonly authorityPollMs?: number
  readonly maxLaunchAttempts?: number
  readonly log?: (line: string) => void
}

export interface HostExternalProbeResult {
  readonly welcome: HostBootstrapWelcome
  readonly payloadVersion?: string
  /** Captured while this probe's authenticated socket names the process. */
  readonly expected?: HostTerminationExpectedHost
  /** The discovery record's process identity (pid, start, install id, payload). */
  readonly process?: HostProjectionDiscoveryProcessIdentity
  /**
   * The probe's still-open authenticated connection. The supervisor keeps the
   * one behind the result it returns as the boot hold (`HostExternalBootHold`)
   * and closes every other.
   */
  readonly connection?: HostExternalHeldConnection
}

function assertProduction(welcome: HostBootstrapWelcome): void {
  if (
    welcome.hostVersion !== 'node-host-v1' ||
    !FLOOR.every((item) => welcome.capabilities.includes(item))
  ) {
    throw new HostExternalProductionModeError()
  }
}

function normalizeProbeResult(
  value: HostBootstrapWelcome | HostExternalProbeResult
): HostExternalProbeResult {
  return 'welcome' in value ? value : { welcome: value }
}

/** The snapshot's identity block, only when the discovery named everything it needs. */
function hostIdentityOf(result: HostExternalProbeResult): HostLifecycleHostIdentity | undefined {
  const process = result.process
  const hostId = process?.hostId ?? result.welcome.hostId
  if (!process || !Number.isSafeInteger(process.pid) || process.pid < 1 || !hostId) {
    return undefined
  }
  return {
    pid: process.pid,
    hostId,
    startedAt: process.startedAt,
    ...(result.expected?.birthIdentity ? { birthIdentity: result.expected.birthIdentity } : {}),
    ...(process.payloadVersion ? { payloadVersion: process.payloadVersion } : {})
  }
}

/** Pin recorded process birth without changing the process selected by the probe. */
async function readHostExternalTerminationExpectation(
  profilePath: string,
  process: Pick<HostProjectionDiscoveryProcessIdentity, 'pid' | 'startedAt'>
): Promise<HostTerminationExpectedHost | undefined> {
  try {
    const evidence = readHostTerminationEvidence(profilePath, resolveHostRegistryRoot())
    const target = hostTerminationTargetPid(evidence)
    if (
      target.inconsistent ||
      target.pid !== process.pid ||
      evidence.discovery?.pid !== process.pid ||
      evidence.discovery.startedAt !== process.startedAt
    ) {
      return undefined
    }
    const birth = await observeProcessBirthIdentity(process.pid)
    if (
      birth.state !== 'live' ||
      matchProcessBirth(birth, hostTerminationExpectation(evidence)) !== 'match' ||
      (evidence.lease &&
        matchProcessBirth(
          birth,
          hostTerminationExpectation({ discovery: null, registry: null, lease: evidence.lease })
        ) !== 'match')
    ) {
      return undefined
    }
    // Capture the observed digest even for a legacy lease that records only
    // process start. Later socket/signal checks must retain this exact birth.
    return { pid: process.pid, birthIdentity: birth.birthIdentity, startedAt: process.startedAt }
  } catch {
    return undefined
  }
}

async function defaultProbe(
  profilePath: string,
  timeoutMs: number
): Promise<HostExternalProbeResult> {
  const client = new HostProjectionClient({
    userDataPath: profilePath,
    client: {
      clientId: `desktop-external-${randomUUID()}`,
      clientClass: 'desktop',
      clientVersion: 'external-host-v1'
    },
    capabilities: ['bootstrap', ...FLOOR],
    connectTimeoutMs: timeoutMs,
    requestTimeoutMs: timeoutMs
  })
  try {
    const welcome = await client.connect()
    const process = client.discoveryProcessIdentity ?? undefined
    const payloadVersion = process?.payloadVersion
    // Pin before asking this socket for status: a later status reply must
    // never let a reused pid supply its birth for the first time.
    const pinned = process
      ? await readHostExternalTerminationExpectation(profilePath, process)
      : undefined
    let expected: HostTerminationExpectedHost | undefined
    try {
      const status = await client.getHostStatus()
      // Status is read on the authenticated probe socket. Listener start is
      // kept separately from OS birth, since those clocks name different events.
      if (
        status.pid === process?.pid &&
        status.startedAt === process.startedAt &&
        status.profilePath === canonicalHostProfilePath(profilePath) &&
        status.hostId === welcome.hostId &&
        pinned
      ) {
        const current = await readHostExternalTerminationExpectation(profilePath, process)
        if (current?.birthIdentity === pinned.birthIdentity) expected = pinned
      }
    } catch (error) {
      // Only an explicit authenticated unsupported response permits the
      // legacy evidence path. Malformed replies and timeouts cannot grant it.
      if (
        error instanceof HostProjectionTransportError &&
        error.code === 'unknown_request_kind' &&
        process &&
        pinned &&
        (!process.hostId || process.hostId === welcome.hostId)
      ) {
        const current = await readHostExternalTerminationExpectation(profilePath, process)
        if (current?.birthIdentity === pinned.birthIdentity) expected = pinned
      }
    }
    // Left open: the supervisor decides whether this connection holds the
    // Host across main's boot or closes now.
    return {
      welcome,
      ...(payloadVersion ? { payloadVersion } : {}),
      ...(process ? { process } : {}),
      ...(expected ? { expected } : {}),
      connection: client
    }
  } catch (error) {
    client.close()
    throw error
  }
}

async function defaultTerminateExisting(
  profilePath: string,
  cause: unknown,
  expected: HostTerminationExpectedHost
): Promise<HostTerminationOutcome> {
  return terminateHostProcess({
    profilePath,
    expected,
    // The socket stop already failed on this very path; go straight to the
    // identity-verified signals instead of asking the same socket again.
    ports: {
      shutdown: async () => {
        throw cause instanceof Error ? cause : new Error(String(cause))
      }
    }
  })
}

async function defaultObserveAuthorityOwner(
  profilePath: string
): Promise<HostExternalAuthorityOwner> {
  const { lease } = readHostTerminationEvidence(profilePath, resolveHostRegistryRoot())
  if (!lease) return { kind: 'none' }
  const birth = await observeProcessBirthIdentity(lease.pid)
  if (birth.state === 'dead') return { kind: 'none' }
  if (birth.state === 'identity_unavailable') {
    return { kind: 'unverifiable', pid: lease.pid, detail: 'its identity cannot be observed' }
  }
  const match = matchProcessBirth(
    birth,
    hostTerminationExpectation({ discovery: null, lease, registry: null })
  )
  // Born at another time: a reused pid, and a lease the next Host reclaims.
  if (match === 'mismatch') return { kind: 'none' }
  if (match !== 'match') {
    return { kind: 'unverifiable', pid: lease.pid, detail: 'its lease carries no birth evidence' }
  }
  const command = await observeProcessCommandLine(lease.pid)
  if (command.state === 'dead') return { kind: 'none' }
  if (command.state !== 'live') {
    return { kind: 'unverifiable', pid: lease.pid, detail: 'its command line cannot be observed' }
  }
  return isHostServeCommandFor(command, profilePath)
    ? { kind: 'host', pid: lease.pid }
    : { kind: 'unverifiable', pid: lease.pid, detail: 'it is not a Host serving this profile' }
}

function closeProbe(result: HostExternalProbeResult | null): void {
  try {
    result?.connection?.close()
  } catch {
    // A probe connection that cannot close is already gone.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type LaunchOutcome =
  | { readonly kind: 'ready'; readonly result: HostExternalEnsureResult }
  | { readonly kind: 'authority-busy'; readonly error: Error }

export class HostExternalSupervisor {
  private statusValue: HostExternalSupervisorStatus = 'idle'
  private operation: Promise<HostExternalEnsureResult> | null = null
  private closed = false
  private generation = 0
  private readonly closeSignal: Promise<void>
  private signalClose!: () => void

  constructor(private readonly options: HostExternalSupervisorOptions) {
    if (
      !options.profilePath ||
      options.profilePath.trim() !== options.profilePath ||
      !isAbsolute(options.profilePath) ||
      resolve(options.profilePath) !== options.profilePath ||
      typeof options.resolveLaunch !== 'function'
    )
      throw new Error('External Host options are invalid.')
    for (const value of [
      options.timeoutMs,
      options.pollMs,
      options.probeTimeoutMs,
      options.authorityWaitMs,
      options.authorityPollMs,
      options.maxLaunchAttempts
    ])
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        throw new Error('External Host timing option is invalid.')
    this.closeSignal = new Promise((resolve) => {
      this.signalClose = resolve
    })
  }

  get status(): HostExternalSupervisorStatus {
    return this.statusValue
  }

  ensureAvailable(): Promise<HostExternalEnsureResult> {
    if (this.closed) return Promise.reject(new Error('External Host supervisor is closed.'))
    if (!this.operation)
      this.operation = this.ensure().finally(() => {
        this.operation = null
      })
    return this.operation
  }

  close(): void {
    if (!this.closed) {
      this.closed = true
      this.generation += 1
      this.statusValue = 'closed'
      this.signalClose()
      // Teardown, an explicit stop or a failed preparation: this supervisor's
      // hold on the Host (if main's lease never took over) goes with it.
      releaseExternalHostBootHold(this.options.profilePath, this)
    }
  }

  private async ensure(): Promise<HostExternalEnsureResult> {
    const generation = this.generation
    const assertOpen = () => {
      if (this.closed || generation !== this.generation)
        throw new Error('External Host supervisor is closed.')
    }
    const log = this.options.log ?? (() => undefined)
    const now = this.options.now ?? (() => Date.now())
    const delay =
      this.options.delay ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const pause = async (ms: number): Promise<void> => {
      await Promise.race([delay(ms), this.closeSignal])
      assertOpen()
    }
    const probe =
      this.options.probe ?? ((timeout: number) => defaultProbe(this.options.profilePath, timeout))
    const probeTimeout = this.options.probeTimeoutMs ?? 1_500
    const probeProduction = async (): Promise<HostExternalProbeResult> => {
      const result = normalizeProbeResult(await probe(probeTimeout))
      try {
        assertProduction(result.welcome)
      } catch (error) {
        closeProbe(result)
        throw error
      }
      return result
    }
    /** A production Host answered, or nothing did (every other failure). */
    const tryProbe = async (): Promise<HostExternalProbeResult | null> => {
      try {
        return await probeProduction()
      } catch (error) {
        if (error instanceof HostProjectionIncompatibleProtocolError) {
          this.statusValue = 'failed'
          throw error
        }
        return null
      }
    }
    // The connection behind the result this supervisor returns stays open:
    // the Host must not start its last-lease grace before main's own lease
    // exists, and main's first socket waits for all of main's synchronous
    // start-up. Every other probe connection closes on its own path.
    const holdForBoot = (result: HostExternalProbeResult): void => {
      if (result.connection) {
        holdExternalHostForBoot(this.options.profilePath, this, result.connection)
      }
    }
    const attachExisting = (result: HostExternalProbeResult): HostExternalEnsureResult => {
      this.statusValue = 'attached-existing'
      holdForBoot(result)
      const host = hostIdentityOf(result)
      return { kind: 'existing', welcome: result.welcome, ...(host ? { host } : {}) }
    }
    /**
     * Replaces a Host serving another payload: its own authenticated stop
     * first, then (D9) identity-verified termination when the socket path
     * fails — a wedged or refusing Host no longer fails the launch outright.
     */
    const replaceExisting = async (selected: HostExternalProbeResult): Promise<void> => {
      this.statusValue = 'restarting'
      const expected = selected.expected
      if (!expected) {
        this.statusValue = 'failed'
        throw new Error('External Host identity could not be verified for replacement.')
      }
      try {
        await (
          this.options.shutdownExisting ??
          ((profilePath: string, target: HostTerminationExpectedHost) =>
            new HostShutdownClient({
              profilePath: canonicalHostProfilePath(profilePath),
              expected: target,
              timeoutMs: HOST_TERMINATION_ACK_MS,
              removalTimeoutMs: HOST_TERMINATION_DRAIN_MS
            }).shutdown())
        )(this.options.profilePath, expected)
      } catch (shutdownError) {
        assertOpen()
        if (shutdownError instanceof HostShutdownIdentityError) throw shutdownError
        let outcome: Pick<HostTerminationOutcome, 'kind' | 'pid' | 'detail'>
        try {
          outcome = await (this.options.terminateExisting ?? defaultTerminateExisting)(
            this.options.profilePath,
            shutdownError,
            expected
          )
        } catch (error) {
          this.statusValue = 'failed'
          throw new Error(
            `External Host could not be replaced: its stop failed (${describe(
              shutdownError
            )}) and verified termination failed (${describe(error)}).`
          )
        }
        if (!HOST_TERMINATION_SUCCESS_KINDS.has(outcome.kind)) {
          this.statusValue = 'failed'
          throw new Error(
            `External Host could not be replaced: its stop failed (${describe(
              shutdownError
            )}) and verified termination ended ${outcome.kind}${
              outcome.detail ? ` (${outcome.detail})` : ''
            }.`
          )
        }
        log(
          `[host-external] replaced Host pid ${outcome.pid ?? 'unknown'} by verified termination (${outcome.kind})`
        )
      }
      assertOpen()
    }

    this.statusValue = 'probing'
    let existing: HostExternalProbeResult | null = await tryProbe()
    let command: HostExternalLaunchCommand | null
    try {
      command = await this.options.resolveLaunch()
      assertOpen()
    } catch (error) {
      closeProbe(existing)
      if (!this.closed) this.statusValue = 'failed'
      throw error
    }
    if (existing && (!command || existing.payloadVersion === command.payloadVersion)) {
      return attachExisting(existing)
    }
    if (existing) {
      // Never hold a Host this supervisor is about to replace.
      closeProbe(existing)
      try {
        await replaceExisting(existing)
      } catch (error) {
        if (!(error instanceof HostShutdownIdentityError)) throw error
        const replacement = await tryProbe()
        assertOpen()
        if (replacement && replacement.payloadVersion === command?.payloadVersion) {
          return attachExisting(replacement)
        }
        closeProbe(replacement)
        this.statusValue = 'failed'
        throw error
      }
      existing = null
    }
    if (!command) {
      this.statusValue = 'failed'
      throw new Error('External Host launch command is unavailable.')
    }
    const launchCommand = command

    /**
     * A Host that exited because another one still holds the profile authority
     * is waited out when that holder is a Host we can verify (it is stopping,
     * or a peer launcher's Host is coming up): a Host that answers meanwhile
     * is attached or replaced, and once the holder is gone the launch
     * respawns. Anything unverifiable ends the launch with the original error.
     */
    const waitOutAuthorityHolder = async (
      busy: Error
    ): Promise<
      | { readonly kind: 'released' }
      | { readonly kind: 'attached'; readonly result: HostExternalEnsureResult }
    > => {
      const observeOwner = this.options.observeAuthorityOwner ?? defaultObserveAuthorityOwner
      const waitMs = this.options.authorityWaitMs ?? HOST_EXTERNAL_AUTHORITY_WAIT_MS
      const pollMs = this.options.authorityPollMs ?? AUTHORITY_POLL_MS
      const deadline = now() + waitMs
      this.statusValue = 'waiting-for-authority'
      let announced: number | null = null
      for (;;) {
        const owner = await observeOwner(this.options.profilePath)
        assertOpen()
        if (owner.kind === 'none') return { kind: 'released' }
        if (owner.kind === 'unverifiable') {
          this.statusValue = 'failed'
          throw new Error(
            `${busy.message} The holder, pid ${owner.pid}, was not waited for: ${owner.detail}.`
          )
        }
        if (announced !== owner.pid) {
          announced = owner.pid
          log(
            `[host-external] the profile authority is held by Host pid ${owner.pid}; waiting up to ${waitMs} ms for it to exit`
          )
        }
        if (now() >= deadline) {
          this.statusValue = 'failed'
          throw new Error(
            `${busy.message} Host pid ${owner.pid} still held the profile authority after ${waitMs} ms.`
          )
        }
        await pause(pollMs)
        const answered = await tryProbe()
        assertOpen()
        if (answered) {
          if (answered.payloadVersion === launchCommand.payloadVersion) {
            return { kind: 'attached', result: attachExisting(answered) }
          }
          closeProbe(answered)
          try {
            await replaceExisting(answered)
          } catch (error) {
            if (!(error instanceof HostShutdownIdentityError)) throw error
            // A peer changed the Host after this probe. Re-probe on the next
            // bounded authority iteration; never apply the old target to it.
          }
          this.statusValue = 'waiting-for-authority'
        }
      }
    }

    const maxAttempts = this.options.maxLaunchAttempts ?? DEFAULT_MAX_LAUNCH_ATTEMPTS
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.launchOnce(launchCommand, {
        assertOpen,
        now,
        delay,
        pause,
        tryProbe,
        holdForBoot
      })
      if (outcome.kind === 'ready') return outcome.result
      if (attempt >= maxAttempts) {
        this.statusValue = 'failed'
        throw outcome.error
      }
      const waited = await waitOutAuthorityHolder(outcome.error)
      if (waited.kind === 'attached') return waited.result
      log('[host-external] the profile authority was released; launching the Host again')
    }
  }

  private async launchOnce(
    command: HostExternalLaunchCommand,
    ports: {
      readonly assertOpen: () => void
      readonly now: () => number
      readonly delay: (ms: number) => Promise<void>
      readonly pause: (ms: number) => Promise<void>
      readonly tryProbe: () => Promise<HostExternalProbeResult | null>
      readonly holdForBoot: (result: HostExternalProbeResult) => void
    }
  ): Promise<LaunchOutcome> {
    const { assertOpen, now, delay, pause, tryProbe, holdForBoot } = ports
    this.statusValue = 'launching'
    const spawn = this.options.spawn ?? ((exe, args, opts) => nodeSpawn(exe, [...args], opts))
    let child: ChildProcess
    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: command.env,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      if (!this.closed) this.statusValue = 'failed'
      throw error
    }
    let stderrTail = ''
    const stderrStream = child.stderr
    if (stderrStream) {
      stderrStream.setEncoding('utf8')
      stderrStream.on('data', (chunk: string) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT)
      })
      // A dead pipe must never surface as an unhandled error, and it must not
      // hold the parent's event loop open for a detached child.
      stderrStream.on('error', () => {})
      // Typed Readable, but a piped stdio stream is a Socket at runtime.
      ;(stderrStream as unknown as { unref?: () => void }).unref?.()
    }
    // Two different releases. The child is DETACHED and outlives readiness, so
    // destroying the read end after a successful launch would EPIPE the Host's
    // next stderr write — trading blindness for a crash. Drain instead, and
    // only close the pipe on paths where the child is already gone or being
    // abandoned.
    const drainStderr = (): void => {
      if (!stderrStream) return
      stderrStream.removeAllListeners('data')
      stderrStream.on('error', () => {})
      stderrStream.resume()
    }
    const closeStderr = (): void => {
      stderrStream?.destroy()
    }
    const withStderr = (message: string): string =>
      stderrTail.trim().length > 0 ? `${message} stderr: ${stderrTail.trim()}` : message
    let childError: Error | null = null
    // Read through a call: control-flow narrowing cannot see an assignment made
    // inside the 'error' callback below, and a const would inherit the narrowed
    // (null) type even with a wider annotation.
    const spawnFailure = (): Error | null => childError
    let childExit: number | null = null
    let childExited = false
    let childClosed = false
    let signalChildClosed: () => void = () => undefined
    const childClosedSignal = new Promise<void>((resolve) => {
      signalChildClosed = resolve
    })
    child.once('error', (error) => {
      childError = error
    })
    child.once('exit', (code) => {
      childExited = true
      childExit = code
    })
    // 'exit' can come before the child's last stderr bytes are read; 'close'
    // comes after its stdio has ended.
    child.once('close', () => {
      childClosed = true
      signalChildClosed()
    })
    child.unref()
    const deadline = now() + (this.options.timeoutMs ?? 120_000)
    // Every abnormal exit closes the pipe, including the assertOpen() throws
    // that fire when the supervisor is closed mid-launch. Only the success
    // path leaves it open, drained.
    try {
      while (now() < deadline) {
        await pause(this.options.pollMs ?? 250)
        const failure = spawnFailure()
        if (failure) {
          this.statusValue = 'failed'
          closeStderr()
          throw new Error(withStderr(failure.message))
        }
        if (childExited) {
          if (!childClosed) await Promise.race([childClosedSignal, delay(250)])
          closeStderr()
          const error = new Error(
            withStderr(`External Host exited ${childExit ?? 'without a code'} before readiness.`)
          )
          // Refused because a live Host still holds the profile authority: the
          // caller may wait that Host out. Any other exit fails the launch.
          if (HOST_AUTHORITY_BUSY_PATTERN.test(stderrTail)) return { kind: 'authority-busy', error }
          this.statusValue = 'failed'
          throw error
        }
        const ready = await tryProbe()
        if (!ready) continue
        if (ready.payloadVersion !== command.payloadVersion) {
          closeProbe(ready)
          continue
        }
        try {
          assertOpen()
        } catch (error) {
          closeProbe(ready)
          throw error
        }
        this.statusValue = 'attached-launched'
        drainStderr()
        holdForBoot(ready)
        const host = hostIdentityOf(ready)
        return {
          kind: 'ready',
          result: {
            kind: 'launched',
            pid: child.pid ?? null,
            welcome: ready.welcome,
            ...(host ? { host } : {})
          }
        }
      }
    } catch (error) {
      closeStderr()
      throw error
    }
    this.statusValue = 'failed'
    closeStderr()
    throw new Error(withStderr('Timed out waiting for external Host production readiness.'))
  }
}
