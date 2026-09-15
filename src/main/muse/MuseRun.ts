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
import {
  createMuseIsolatedHome,
  projectMuseAuthJson,
  type MuseIsolatedHomeLease
} from './MuseIsolatedHome'
import type { MuseMcpSettings } from './MuseMcpConfig'
import { buildMuseSkillPinSettings, type MuseSkillPinSettings } from './MuseSkillPin'
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
import { composeMuseLaunchPrompt } from './MuseLongTurnProgress'
import { createMuseReasoningProjector } from './MuseReasoningProjection'
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
  /**
   * Vestigial: the pre-turn introduction pass that used to supply this is gone,
   * so nothing populates it any more. Kept only because `composeMuseLaunchPrompt`
   * still takes the parameter for `MuseMspRun`; both retire together.
   */
  readonly introductionText?: string | null
  readonly approvalMode?: string | null
  /** Derived only from the main-signed UltraTask delegation consent. */
  readonly ultraTaskDelegationAutoAllow?: boolean
  /** BYOK for `--api-key-stdin` only — never placed on argv. */
  readonly apiKey?: string | null
  /**
   * Validated Muse-owned auth.json for account OAuth. It is projected only
   * into the private run home and deleted with that lease at teardown.
   */
  readonly authJsonText?: string | null
  /** App-owned, route-bound MCP entries for this one isolated Muse run. */
  readonly mcpSettings?: MuseMcpSettings
  readonly sourceEnvironment?: NodeJS.ProcessEnv
  /** Directory placed first on the Muse launch PATH; see MuseIsolatedHome. */
  readonly developerToolsBinPath?: string
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
    readonly developerToolsBinPath?: string
    readonly skillPinSettings?: MuseSkillPinSettings
    readonly mcpSettings?: MuseMcpSettings
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
  const effort = normalizeMuseReasoningEffort(input.reasoningEffort, input.model)
  const apiKeyStdin = Boolean(input.apiKey && input.apiKey.length > 0)
  const ultraTaskDelegationAutoAllow = input.ultraTaskDelegationAutoAllow === true
  const warnings: string[] = []
  const events: MuseExecNormalizedEvent[] = []

  const createHome = input.createHome ?? createMuseIsolatedHome
  const lease = createHome({
    temporaryRoot,
    runId,
    sourceEnvironment: input.sourceEnvironment,
    ...(input.developerToolsBinPath ? { developerToolsBinPath: input.developerToolsBinPath } : {}),
    ...(ultraTaskDelegationAutoAllow
      ? {
          skillPinSettings: buildMuseSkillPinSettings('off', {
            ultraTaskDelegationAutoAllow: true
          })
        }
      : {}),
    ...(input.mcpSettings ? { mcpSettings: input.mcpSettings } : {})
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
  const projectReasoning = createMuseReasoningProjector()
  const pendingSessionEvents: { event: MuseExecNormalizedEvent; recordedAt: number }[] = []
  let terminalEvent: MuseExecNormalizedEvent | undefined
  const logReadWarnings = new Set<string>()
  const warnLogRead = (error: unknown): void => {
    const warning = `Muse session-log read failed: ${error instanceof Error ? error.message : String(error)}`
    if (logReadWarnings.has(warning)) return
    logReadWarnings.add(warning)
    warnings.push(warning)
  }

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
    for (const event of [...projectReasoning(envelope), ...projectMuseEnvelopeTools(envelope)]) {
      pendingSessionEvents.push({ event, recordedAt: envelope.recorded_at })
    }
    const linked = museLinkedSubagentSessionLogPath(envelope)
    if (linked) pendingSubagentPaths.add(linked)
  }

  // Stdout and the session log are separate transports. Drain older log
  // records before assistant text so a polling delay cannot put Thinking
  // below the answer or collapse reasoning across an intervening tool call.
  const flushSessionEvents = (through = Infinity): void => {
    pendingSessionEvents.sort((a, b) => a.recordedAt - b.recordedAt)
    while (pendingSessionEvents.length && pendingSessionEvents[0].recordedAt <= through) {
      emitEvent(pendingSessionEvents.shift()!.event)
    }
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
      await tailer.poll().catch(warnLogRead)
    }
    if (mainSessionLogPath) openPendingSubagentTailers(mainSessionLogPath)
    // Newly attached subagent tailers need an immediate poll.
    for (const tailer of sessionTailers.values()) {
      await tailer.poll().catch(warnLogRead)
    }
  }

  const flushSessionLogs = async (mainSessionLogPath: string | null): Promise<void> => {
    for (const tailer of sessionTailers.values()) {
      await tailer.flushFinal().catch(warnLogRead)
    }
    if (mainSessionLogPath) openPendingSubagentTailers(mainSessionLogPath)
    for (const tailer of sessionTailers.values()) {
      await tailer.flushFinal().catch(warnLogRead)
    }
  }

  const handleStdoutEvents = (chunk: string): void => {
    const parsed = parseMuseExecJsonChunk(chunk, stdoutCarry)
    stdoutCarry = parsed.carry
    for (const line of parsed.lines) {
      flushSessionEvents(line.envelope?.recorded_at)
      for (const event of museExecLineToEvents(line)) {
        if (event.type === 'terminal') terminalEvent = event
        else emitEvent(event)
      }
      // Defensive: if Muse ever emits runtime.session tool commits on stdout,
      // project them the same way as the durable session log.
      if (line.envelope) {
        for (const reasoning of projectReasoning(line.envelope)) emitEvent(reasoning)
        for (const toolEvent of projectMuseEnvelopeTools(line.envelope)) {
          emitEvent(toolEvent)
        }
      }
    }
  }

  // Isolated-home exec has no native resume. Host-side only; never shown.
  const argv = buildMuseExecArgv({
    prompt: composeMuseLaunchPrompt(input.prompt, input.introductionText),
    workspace: workspacePath,
    sessionId,
    model: input.model,
    reasoningEffort: effort,
    readOnlySeat: !writeCapable,
    apiKeyStdin,
    ultraTaskDelegationAutoAllow
  })
  assertSafeMuseArgv(argv)

  const env = stringEnv(lease.env)
  const museDataHome = lease.museDataDir

  try {
    if (input.authJsonText != null) {
      projectMuseAuthJson(lease, input.authJsonText)
    }

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

    handle.onStderr((chunk) => {
      const text = chunk.trim()
      if (text) warnings.push(`muse stderr: ${text.slice(0, 500)}`)
    })

    // Stop must end the turn, not just relabel it. The cancel flag is polled
    // for the life of the child (on the session-log timer below) and the first
    // observation kills it. Before this, cancellation was consulted once at
    // spawn and once after exit, so a stopped Muse run kept executing — and
    // billing — to completion.
    let killRequested = false
    const spawnedHandle = handle
    const killIfCancelled = (): void => {
      if (killRequested || !input.shouldCancel?.()) return
      killRequested = true
      spawnedHandle.kill('SIGTERM')
    }
    killIfCancelled()

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

    // The launcher/keychain can outlast the first bounded lookup. Keep
    // discovery alive until the log appears, including one final lookup for
    // short runs, instead of silently losing all tools, summaries and usage.
    let nextLogLookupAt = 0
    const refreshSessionLog = async (force = false): Promise<void> => {
      await attachPromise
      if (mainSessionLogPath || (!force && Date.now() < nextLogLookupAt)) return
      nextLogLookupAt = Date.now() + 1_000
      try {
        const result = await resolveSessionLog({ dataHome: museDataHome, sessionId })
        if (result.sessionLogPath) attachMainSessionLog(result.sessionLogPath)
      } catch (error) {
        warnLogRead(error)
      }
    }

    let streamWork = Promise.resolve()
    let streamError: unknown
    const enqueueStreamWork = (work: () => Promise<void>): void => {
      streamWork = streamWork.then(work).catch((error: unknown) => {
        streamError ??= error
        spawnedHandle.kill('SIGTERM')
      })
    }
    handle.onStdout((chunk) => {
      enqueueStreamWork(async () => {
        await refreshSessionLog()
        await pollSessionLogs(mainSessionLogPath)
        handleStdoutEvents(chunk)
      })
    })

    pollTimer = setInterval(() => {
      killIfCancelled()
      enqueueStreamWork(async () => {
        await refreshSessionLog()
        await pollSessionLogs(mainSessionLogPath)
        flushSessionEvents()
      })
    }, pollMs)

    const waited = await handle.wait()
    exitCode = waited.code

    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }

    await streamWork
    if (streamError) throw streamError
    if (stdoutCarry.trim()) handleStdoutEvents('\n')
    await refreshSessionLog(true)
    if (mainSessionLogPath) {
      await flushSessionLogs(mainSessionLogPath)
      meter =
        (usageReducer as MuseUsageReducer | null)?.snapshot() ??
        unavailableMuseMeterSnapshot(sessionId)
    } else {
      warnings.push('Muse session.jsonl was not resolved for metering; usage marked unavailable')
      meter = unavailableMuseMeterSnapshot(sessionId)
    }
    flushSessionEvents()
    if (terminalEvent) emitEvent(terminalEvent)

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
