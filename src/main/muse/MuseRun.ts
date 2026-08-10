/**
 * Muse opaque-exec run lifecycle.
 *
 * Composition-root wires IPC via `muse/MuseIpcBridge` → `runMuseProvider`.
 *
 * Sequence:
 *   lease home (+ skill-pin seed) → build argv → spawn →
 *   pump stdout (ExecJson) + resolve/tail session.jsonl (Usage) →
 *   cron assert → isolated-home cleanup
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  buildMuseExecArgv,
  museWriteCapable,
  normalizeMuseReasoningEffort,
  resolveMuseExecSessionId,
  type MuseReasoningEffort
} from './MuseCliArgs'
import { assertMuseCronJobsEmpty, type MuseCronAssertResult } from './MuseCronAssert'
import {
  museExecLineToEvents,
  parseMuseExecJsonChunk,
  type MuseEnvelope,
  type MuseExecNormalizedEvent
} from './MuseExecJson'
import { createMuseIsolatedHome, type MuseIsolatedHomeLease } from './MuseIsolatedHome'
import {
  createMuseSessionLogTailer,
  resolveMuseSessionLogPath,
  type MuseSessionLogResolveResult,
  type MuseSessionLogTailer
} from './MuseSessionLog'
import { museLinkedSubagentSessionLogPath, projectMuseEnvelopeTools } from './MuseToolProjection'
import {
  createMuseUsageReducer,
  museMeterSnapshotToProviderStats,
  unavailableMuseMeterSnapshot,
  type MuseMeterSnapshot,
  type MuseProviderStats,
  type MuseUsageReducer
} from './MuseUsage'
import { MUSE_FORBIDDEN_ARGV_FLAGS, MUSE_METERING_EXCLUSIVE_ARGV_FLAGS } from './MuseTypes'

export interface MuseRunSpawnHandle {
  readonly pid: number | null
  kill(signal?: NodeJS.Signals): void
  onStdout(listener: (chunk: string) => void): void
  onStderr(listener: (chunk: string) => void): void
  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

export interface MuseRunSpawnInput {
  readonly binaryPath: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly stdin?: string | null
}

export type MuseRunSpawn = (input: MuseRunSpawnInput) => MuseRunSpawnHandle

export interface MuseRunInput {
  readonly binaryPath: string
  readonly workspacePath: string
  readonly prompt: string
  readonly runId: string
  readonly temporaryRoot: string
  readonly sessionId?: string | null
  readonly model?: string | null
  readonly reasoningEffort?: string | null
  readonly approvalMode?: string | null
  /** BYOK for `--api-key-stdin` only — never placed on argv. */
  readonly apiKey?: string | null
  readonly sourceEnvironment?: NodeJS.ProcessEnv
  readonly spawn: MuseRunSpawn
  readonly onEvent?: (event: MuseExecNormalizedEvent) => void
  readonly shouldCancel?: () => boolean
  /** Override session-log resolve (tests). Defaults to `resolveMuseSessionLogPath`. */
  readonly resolveSessionLog?: (input: {
    readonly dataHome: string
    readonly sessionId: string
  }) => Promise<MuseSessionLogResolveResult>
  /** Override cron assert (tests). Defaults to `assertMuseCronJobsEmpty`. */
  readonly assertCron?: (input: {
    readonly museDataHome: string
    readonly sessionId: string
    readonly leaseRoot: string
  }) => MuseCronAssertResult
  /** Bound session-log index lag wait (default 250ms for unit safety). */
  readonly sessionLogResolveTimeoutMs?: number
  /** Poll interval for live session.jsonl tool/usage projection while Muse runs. */
  readonly sessionLogPollIntervalMs?: number
  readonly createHome?: (input: {
    readonly temporaryRoot: string
    readonly runId: string
    readonly sourceEnvironment?: NodeJS.ProcessEnv
  }) => MuseIsolatedHomeLease
}

export type MuseRunStatus = 'success' | 'failed' | 'cancelled'

export interface MuseRunOutcome {
  readonly status: MuseRunStatus
  readonly sessionId: string
  readonly exitCode: number | null
  readonly assistantText: string
  readonly events: readonly MuseExecNormalizedEvent[]
  readonly meter: MuseMeterSnapshot
  readonly providerStats: MuseProviderStats
  readonly warnings: readonly string[]
  readonly argv: readonly string[]
  readonly effort: MuseReasoningEffort
  readonly writeCapable: boolean
  readonly skillPinHash: string
  readonly leasePath: string
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`MuseRun requires a non-empty ${label}`)
  return trimmed
}

function hashSkillPinSettings(settingsPath: string): string {
  try {
    const body = readFileSync(settingsPath, 'utf8')
    return createHash('sha256').update(body, 'utf8').digest('hex')
  } catch {
    return 'skill-pin-unreadable'
  }
}

function assertSafeMuseArgv(argv: readonly string[]): void {
  for (const flag of MUSE_FORBIDDEN_ARGV_FLAGS) {
    if (argv.includes(flag)) {
      throw new Error(`MuseRun refused forbidden argv flag: ${flag}`)
    }
  }
  for (const flag of MUSE_METERING_EXCLUSIVE_ARGV_FLAGS) {
    if (argv.includes(flag)) {
      throw new Error(`MuseRun refused metering-exclusive argv flag: ${flag}`)
    }
  }
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--reasoning-effort' && argv[i + 1] === 'none') {
      throw new Error('MuseRun refused --reasoning-effort none for meta')
    }
  }
}

function stringEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value
  }
  // Hard-pin seat flags even if a scrubber omitted them.
  out.MUSE_NO_AUTO_UPDATE = '1'
  delete out.META_API_KEY
  return out
}

/**
 * Production Muse turn lifecycle against the landed muse/* modules.
 */
export async function runMuseProvider(input: MuseRunInput): Promise<MuseRunOutcome> {
  const binaryPath = requireNonEmpty(input.binaryPath, 'binaryPath')
  const workspacePath = requireNonEmpty(input.workspacePath, 'workspacePath')
  const runId = requireNonEmpty(input.runId, 'runId')
  const temporaryRoot = requireNonEmpty(input.temporaryRoot, 'temporaryRoot')
  const sessionId = resolveMuseExecSessionId(input.sessionId)
  const writeCapable = museWriteCapable(input.approvalMode)
  const effort = normalizeMuseReasoningEffort(input.reasoningEffort)
  const apiKeyStdin = Boolean(input.apiKey && input.apiKey.length > 0)
  const warnings: string[] = []
  const events: MuseExecNormalizedEvent[] = []

  const createHome = input.createHome ?? createMuseIsolatedHome
  const lease = createHome({
    temporaryRoot,
    runId,
    sourceEnvironment: input.sourceEnvironment
  })
  const skillPinHash = hashSkillPinSettings(lease.settingsPath)

  let assistantText = ''
  let status: MuseRunStatus = 'failed'
  let exitCode: number | null = null
  let meter: MuseMeterSnapshot = unavailableMuseMeterSnapshot(sessionId)
  let handle: MuseRunSpawnHandle | null = null
  let stdoutCarry = ''
  let usageReducer: MuseUsageReducer | null = null
  const sessionTailers = new Map<string, MuseSessionLogTailer>()
  const pendingSubagentPaths = new Set<string>()

  const emitEvent = (event: MuseExecNormalizedEvent): void => {
    events.push(event)
    if (event.type === 'content' && event.text) assistantText += event.text
    if (event.type === 'terminal') {
      if (event.text) assistantText = event.text
      const terminal = (event.terminal || '').toLowerCase()
      status =
        terminal === 'failed' || terminal === 'error' || terminal === 'cancelled'
          ? terminal === 'cancelled'
            ? 'cancelled'
            : 'failed'
          : 'success'
    }
    input.onEvent?.(event)
  }

  const ingestSessionEnvelope = (envelope: MuseEnvelope, forUsage: boolean): void => {
    if (forUsage && usageReducer) usageReducer.ingestEnvelope(envelope)
    for (const toolEvent of projectMuseEnvelopeTools(envelope)) {
      emitEvent(toolEvent)
    }
    const linked = museLinkedSubagentSessionLogPath(envelope)
    if (linked) pendingSubagentPaths.add(linked)
  }

  const attachSessionLogTailer = (
    absolutePath: string,
    forUsage: boolean
  ): MuseSessionLogTailer | null => {
    if (sessionTailers.has(absolutePath)) return sessionTailers.get(absolutePath) || null
    try {
      const tailer = createMuseSessionLogTailer({
        sessionLogPath: absolutePath,
        onEnvelope: (envelope) => ingestSessionEnvelope(envelope, forUsage)
      })
      sessionTailers.set(absolutePath, tailer)
      return tailer
    } catch (error) {
      warnings.push(
        `Muse session-log tailer open failed for ${absolutePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return null
    }
  }

  const openPendingSubagentTailers = (mainSessionLogPath: string): void => {
    if (pendingSubagentPaths.size === 0) return
    const sessionDir = dirname(mainSessionLogPath)
    for (const relative of [...pendingSubagentPaths]) {
      pendingSubagentPaths.delete(relative)
      const absolute = join(sessionDir, relative)
      attachSessionLogTailer(absolute, false)
    }
  }

  const pollSessionLogs = async (mainSessionLogPath: string | null): Promise<void> => {
    for (const tailer of sessionTailers.values()) {
      await tailer.poll()
    }
    if (mainSessionLogPath) openPendingSubagentTailers(mainSessionLogPath)
    // Newly attached subagent tailers need an immediate poll.
    for (const tailer of sessionTailers.values()) {
      await tailer.poll()
    }
  }

  const flushSessionLogs = async (mainSessionLogPath: string | null): Promise<void> => {
    for (const tailer of sessionTailers.values()) {
      await tailer.flushFinal()
    }
    if (mainSessionLogPath) openPendingSubagentTailers(mainSessionLogPath)
    for (const tailer of sessionTailers.values()) {
      await tailer.flushFinal()
    }
  }

  const handleStdoutEvents = (chunk: string): void => {
    const parsed = parseMuseExecJsonChunk(chunk, stdoutCarry)
    stdoutCarry = parsed.carry
    for (const line of parsed.lines) {
      for (const event of museExecLineToEvents(line)) {
        emitEvent(event)
      }
      // Defensive: if Muse ever emits runtime.session tool commits on stdout,
      // project them the same way as the durable session log.
      if (line.envelope) {
        for (const toolEvent of projectMuseEnvelopeTools(line.envelope)) {
          emitEvent(toolEvent)
        }
      }
    }
  }

  const argv = buildMuseExecArgv({
    prompt: input.prompt,
    workspace: workspacePath,
    sessionId,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    readOnlySeat: !writeCapable,
    apiKeyStdin
  })
  assertSafeMuseArgv(argv)

  const env = stringEnv(lease.env)
  const museDataHome = lease.museDataDir

  try {
    if (input.shouldCancel?.()) {
      return {
        status: 'cancelled',
        sessionId,
        exitCode: null,
        assistantText: '',
        events,
        meter,
        providerStats: museMeterSnapshotToProviderStats(meter),
        warnings,
        argv,
        effort,
        writeCapable,
        skillPinHash,
        leasePath: lease.path
      }
    }

    // Start session-log resolve early — indexer lag is common.
    const resolveSessionLog =
      input.resolveSessionLog ??
      ((opts: { dataHome: string; sessionId: string }) =>
        resolveMuseSessionLogPath({
          dataHome: opts.dataHome,
          sessionId: opts.sessionId,
          timeoutMs: input.sessionLogResolveTimeoutMs ?? 250
        }))

    const sessionLogPromise = resolveSessionLog({
      dataHome: museDataHome,
      sessionId
    }).catch((error: unknown) => {
      warnings.push(
        `Muse session-log resolve failed: ${error instanceof Error ? error.message : String(error)}`
      )
      return {
        row: null,
        sessionLogPath: null,
        source: 'missing' as const
      } satisfies MuseSessionLogResolveResult
    })

    handle = input.spawn({
      binaryPath,
      argv,
      cwd: workspacePath,
      env,
      stdin: apiKeyStdin ? (input.apiKey ?? null) : null
    })

    handle.onStdout((chunk) => handleStdoutEvents(chunk))
    handle.onStderr((chunk) => {
      const text = chunk.trim()
      if (text) warnings.push(`muse stderr: ${text.slice(0, 500)}`)
    })

    if (input.shouldCancel?.()) {
      handle.kill('SIGTERM')
    }

    let mainSessionLogPath: string | null = null
    const pollMs = Math.max(10, input.sessionLogPollIntervalMs ?? 50)
    let pollTimer: ReturnType<typeof setInterval> | null = null

    const attachMainSessionLog = (sessionLogPath: string): void => {
      if (mainSessionLogPath) return
      mainSessionLogPath = sessionLogPath
      usageReducer = createMuseUsageReducer({
        museSessionId: sessionId,
        logPath: sessionLogPath
      })
      attachSessionLogTailer(sessionLogPath, true)
    }

    // Attach as soon as the path resolves so mid-run tool commits stream live.
    const attachPromise = sessionLogPromise.then((result) => {
      if (result.sessionLogPath) attachMainSessionLog(result.sessionLogPath)
      return result
    })

    pollTimer = setInterval(() => {
      void pollSessionLogs(mainSessionLogPath)
    }, pollMs)

    const waited = await handle.wait()
    exitCode = waited.code
    if (stdoutCarry.trim()) handleStdoutEvents('\n')

    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }

    const sessionLog = await attachPromise
    if (sessionLog.sessionLogPath) {
      attachMainSessionLog(sessionLog.sessionLogPath)
      await flushSessionLogs(sessionLog.sessionLogPath)
      meter = usageReducer?.snapshot() ?? unavailableMuseMeterSnapshot(sessionId)
    } else if (sessionLog.source === 'missing') {
      warnings.push('Muse session.jsonl was not resolved for metering; usage marked unavailable')
      meter = unavailableMuseMeterSnapshot(sessionId)
    }

    for (const tailer of sessionTailers.values()) {
      await tailer.close()
    }
    sessionTailers.clear()

    // Callbacks mutate `status` but CFA still sees the initial `'failed'`
    // literal — cast widens before the terminal reconcile.
    const observedStatus = status as MuseRunStatus
    if (input.shouldCancel?.()) {
      status = 'cancelled'
    } else if (observedStatus !== 'success' && observedStatus !== 'cancelled') {
      status = exitCode === 0 ? 'success' : 'failed'
    } else if (exitCode !== 0 && observedStatus === 'success') {
      status = 'failed'
    }

    const assertCron =
      input.assertCron ??
      ((opts: { museDataHome: string; sessionId: string; leaseRoot: string }) =>
        assertMuseCronJobsEmpty({
          museDataHome: opts.museDataHome,
          sessionId: opts.sessionId,
          leaseRoot: opts.leaseRoot,
          allowMissingCronDb: true
        }))

    const cron = assertCron({
      museDataHome,
      sessionId,
      leaseRoot: lease.path
    })
    if (!cron.ok) {
      warnings.push(
        `Muse cron assert: ${cron.reason}${
          typeof cron.jobCount === 'number' ? ` (jobs=${cron.jobCount})` : ''
        }`
      )
    }
  } finally {
    const cleanup = lease.cleanup()
    if (!cleanup.ok) warnings.push(cleanup.reason)
  }

  return {
    status,
    sessionId,
    exitCode,
    assistantText,
    events,
    meter,
    providerStats: museMeterSnapshotToProviderStats(meter),
    warnings,
    argv,
    effort,
    writeCapable,
    skillPinHash,
    leasePath: lease.path
  }
}

/** Alias matching wave-1 F naming (`MuseRun` lifecycle entry). */
export const runMuseOpaqueExecTurn = runMuseProvider

/** IPC bridge entry — implemented in MuseIpcBridge (deps-injected spawn/binary). */
export { runMuseProviderFromIpc } from './MuseIpcBridge'
