import { spawn as nodeSpawn } from 'node:child_process'

import { antigravityVariantGroupForModel } from '../shared/antigravityAgyModelGrouping'
import { ANTIGRAVITY_PROVIDER_ID } from '../shared/retiredProviders'
import {
  discoverHostStandaloneAntigravity,
  hostStandaloneAgyProbeEnvironment,
  hostStandaloneAntigravityOffers,
  readHostStandaloneAntigravityConsent,
  type HostStandaloneAgyCaptureResult,
  type HostStandaloneAntigravityAdmission,
  type HostStandaloneAntigravityProbe
} from '../host-shared/antigravity/HostStandaloneAntigravityAdmission'
import {
  parseHostAgySessionId,
  readHostAgyConversationReceipt
} from '../host-shared/antigravity/HostAgyConversationReceipt'
import {
  HOST_PROVIDER_RUN_MAX_TEXT_CHARS,
  normalizeHostProviderRunPresentationText,
  normalizeHostProviderRunThread,
  validateHostProviderRunPrompt,
  type HostProviderRunFinish,
  type HostProviderRunPort,
  type HostProviderRunThread
} from '../host-runtime/HostProviderRunPort'
import type {
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import type {
  HostNodeProvider,
  HostNodeProviderInstance,
  HostNodeProviderRunRequest,
  HostNodeProviderRunResult
} from './HostNodeProvider'
import type { HostNodeProviderResourcePort } from './HostNodeProviderResources'
import type { HostNodeProviderTerminalLauncher } from './HostNodeTerminalLauncher'

const PROBE_CACHE_MS = 1_000
const AGY_PRINT_TIMEOUT = '30m'
const MAX_RAW_OUTPUT_CHARS = 256 * 1024
// eslint-disable-next-line no-control-regex -- Host identifiers reject C0 controls.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export interface HostNodeAntigravitySpawnInput {
  readonly binaryPath: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly onStdout: (chunk: string) => void
  readonly onStderr: (chunk: string) => void
}

export interface HostNodeAntigravitySpawnHandle {
  kill(signal: NodeJS.Signals): void
  readonly exit: Promise<{ readonly code: number | null; readonly signal: string | null }>
}

export type HostNodeAntigravitySpawn = (
  input: HostNodeAntigravitySpawnInput
) => HostNodeAntigravitySpawnHandle

export const hostNodeAntigravitySpawn: HostNodeAntigravitySpawn = (input) => {
  const child = nodeSpawn(input.binaryPath, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => input.onStdout(String(chunk)))
  child.stderr?.on('data', (chunk: string) => input.onStderr(String(chunk)))
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('error', () => resolve({ code: null, signal: null }))
    child.once('close', (code, signal) => resolve({ code, signal: signal ? String(signal) : null }))
  })
  return {
    kill(signal) {
      try {
        child.kill(signal)
      } catch {
        // The child has already exited.
      }
    },
    exit
  }
}

export interface HostNodeAntigravityProviderOptions {
  readonly profilePath: string
  readonly runPort: HostProviderRunPort
  readonly offers: HostProviderOffersProjection
  readonly resources: HostNodeProviderResourcePort
  readonly captureModels: (
    command: string,
    args: readonly string[],
    options: { readonly env: Record<string, string>; readonly timeoutMs: number }
  ) => HostStandaloneAgyCaptureResult | Promise<HostStandaloneAgyCaptureResult>
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly terminalLauncher?: HostNodeProviderTerminalLauncher
  readonly spawn?: HostNodeAntigravitySpawn
  readonly readConversationReceipt?: (
    workspacePath: string,
    options: { readonly env: Readonly<Record<string, string | undefined>> }
  ) => Promise<string | null>
  readonly now?: () => number
}

interface ActiveRun {
  cancelled: boolean
  handle: HostNodeAntigravitySpawnHandle | null
}

function canonicalIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !CONTROL_CHARACTERS.test(value)
  )
}

function wireModel(
  admission: HostStandaloneAntigravityAdmission,
  modelId: string,
  reasoningId: string | undefined
): string {
  const group = antigravityVariantGroupForModel(admission.models, modelId)
  if (!group || !reasoningId) return modelId
  return group.variants.find((variant) => variant.effort === reasoningId)?.id ?? modelId
}

function buildPlanArgs(
  prompt: string,
  modelId: string,
  reasoningId: string | undefined,
  providerSessionId: string | undefined
): string[] {
  const args = ['--sandbox', '--mode', 'plan', '--print-timeout', AGY_PRINT_TIMEOUT]
  const conversationId = parseHostAgySessionId(providerSessionId)
  if (conversationId) args.push('--conversation', conversationId)
  else args.push('--new-project')
  args.push('--model', modelId)
  if (reasoningId && ['low', 'medium', 'high'].includes(reasoningId)) {
    args.push('--effort', reasoningId)
  }
  args.push('-p', prompt)
  return args
}

export class HostNodeAntigravityProvider implements HostNodeProviderInstance {
  readonly providerId = ANTIGRAVITY_PROVIDER_ID
  private currentOffers: HostProviderOffersProjection
  private readonly activeRuns = new Map<string, ActiveRun>()
  private probeCache: {
    readonly value: HostStandaloneAntigravityProbe
    readonly expiresAt: number
  } | null = null
  private probeInFlight: Promise<HostStandaloneAntigravityProbe> | null = null
  private readonly spawnProcess: HostNodeAntigravitySpawn
  private readonly now: () => number

  constructor(private readonly options: HostNodeAntigravityProviderOptions) {
    this.currentOffers = options.offers
    this.spawnProcess = options.spawn ?? hostNodeAntigravitySpawn
    this.now = options.now ?? (() => Date.now())
  }

  private async probe(force = false): Promise<HostStandaloneAntigravityProbe> {
    if (!force && this.probeCache && this.probeCache.expiresAt > this.now()) {
      return this.probeCache.value
    }
    if (!force && this.probeInFlight) return this.probeInFlight
    const pending = discoverHostStandaloneAntigravity({
      profilePath: this.options.profilePath,
      resolveBinary: () => this.options.resources.resolveBinary(),
      capture: this.options.captureModels,
      env: this.options.environment
    })
    if (!force) this.probeInFlight = pending
    try {
      const value = await pending
      if (!force) this.probeCache = { value, expiresAt: this.now() + PROBE_CACHE_MS }
      return value
    } finally {
      if (!force) this.probeInFlight = null
    }
  }

  async getOffers(): Promise<HostProviderOffersProjection> {
    const probe = await this.probe()
    this.currentOffers =
      probe.status === 'ready' ? probe.admission.offers : hostStandaloneAntigravityOffers([])
    return this.currentOffers
  }

  async getStatus(): Promise<HostProviderStatusProjection> {
    const probe = await this.probe()
    return {
      providerId: ANTIGRAVITY_PROVIDER_ID,
      status:
        probe.status === 'ready'
          ? 'ready'
          : probe.status === 'auth_required' || probe.status === 'consent_required'
            ? 'auth_required'
            : 'unavailable',
      label: 'AntiGravity',
      detail: probe.detail
    }
  }

  async getAuthStatus(): Promise<HostProviderAuthStatusProjection> {
    const probe = await this.probe()
    return {
      providerId: ANTIGRAVITY_PROVIDER_ID,
      state:
        probe.status === 'ready'
          ? 'authenticated'
          : probe.status === 'unavailable'
            ? 'unavailable'
            : 'unauthenticated',
      detail: probe.detail
    }
  }

  async getAuthFlows(): Promise<readonly HostProviderAuthFlowProjection[]> {
    if (!this.options.terminalLauncher) return []
    const consent = readHostStandaloneAntigravityConsent(this.options.profilePath)
    if (!consent.accepted) return []
    const binary = await this.options.resources.resolveBinary()
    if (!binary.binaryPath) return []
    const probe = await this.probe()
    if (probe.status === 'ready') return []
    return [
      {
        flowId: 'antigravity:login',
        kind: 'manual',
        label: 'Sign in to AntiGravity',
        available: true,
        detail:
          'Opens the official agy browser/keyring sign-in; live models are re-probed afterward.'
      }
    ]
  }

  async beginAuth(operationId: string): Promise<void> {
    if (!canonicalIdentifier(operationId) || !this.options.terminalLauncher) {
      throw new Error('AntiGravity sign-in handoff is unavailable.')
    }
    const consent = readHostStandaloneAntigravityConsent(this.options.profilePath)
    if (!consent.accepted) throw new Error('AntiGravity consent is required before sign-in.')
    const binary = await this.options.resources.resolveBinary()
    if (!binary.binaryPath) throw new Error('The official agy CLI is unavailable.')
    this.probeCache = null
    await this.options.terminalLauncher.launchForProvider(ANTIGRAVITY_PROVIDER_ID, {
      argv: [binary.binaryPath],
      env: hostStandaloneAgyProbeEnvironment(this.options.environment)
    })
  }

  async cancelAuth(): Promise<boolean> {
    return false
  }

  private validateThread(thread: HostProviderRunThread): HostProviderRunThread {
    const normalized = normalizeHostProviderRunThread(thread)
    if (!normalized || normalized.providerId !== ANTIGRAVITY_PROVIDER_ID) {
      throw new Error('AntiGravity thread configuration is invalid.')
    }
    if (normalized.posture.postureId !== 'plan') {
      throw new Error('Standalone AntiGravity currently permits only Plan.')
    }
    const model = this.currentOffers.models.find(
      (entry) => entry.modelId === normalized.modelId && entry.available
    )
    if (
      !model ||
      (normalized.reasoningId !== undefined &&
        !model.reasoning.some(
          (entry) => entry.reasoningId === normalized.reasoningId && entry.available
        ))
    ) {
      throw new Error('AntiGravity model selection is not currently offered.')
    }
    return normalized
  }

  async run(request: HostNodeProviderRunRequest): Promise<HostNodeProviderRunResult> {
    if (
      !canonicalIdentifier(request.runId) ||
      !canonicalIdentifier(request.threadId) ||
      !validateHostProviderRunPrompt(request.prompt)
    ) {
      throw new Error('AntiGravity run input is invalid.')
    }
    const loaded = this.options.runPort.getThread(request.threadId)
    if (!loaded) throw new Error('AntiGravity thread was not found.')
    let thread = this.validateThread(loaded)
    const startedAt = new Date(this.now()).toISOString()
    const begin = this.options.runPort.beginRun({
      runId: request.runId,
      threadId: request.threadId,
      providerId: ANTIGRAVITY_PROVIDER_ID,
      modelId: thread.modelId,
      startedAt
    })
    if (begin.kind === 'duplicate')
      throw new Error(`AntiGravity run already exists: ${request.runId}`)
    const active: ActiveRun = { cancelled: false, handle: null }
    this.activeRuns.set(request.runId, active)
    let cancelRegistered = false
    let rawOutput = ''
    let stderrSeen = false
    let status: 'completed' | 'failed' | 'cancelled' = 'failed'
    let exitCode: number | null = null
    let providerSessionId: string | undefined
    try {
      this.options.runPort.appendTranscript({
        threadId: request.threadId,
        runId: request.runId,
        role: 'user',
        text: request.prompt,
        createdAt: startedAt
      })
      this.options.runPort.updateRun({
        runId: request.runId,
        phase: 'starting',
        updatedAt: startedAt
      })
      const registration = this.options.runPort.registerCancel(request.runId, () =>
        this.cancel(request.runId)
      )
      if (registration.kind !== 'registered')
        throw new Error('AntiGravity cancel registration failed.')
      cancelRegistered = true
      this.options.runPort.publishRunEvent(request.target, {
        type: 'run.started',
        runId: request.runId,
        threadId: request.threadId,
        providerId: ANTIGRAVITY_PROVIDER_ID,
        sessionId: thread.providerSessionId ?? request.runId,
        at: startedAt
      })
      this.options.runPort.publishRunEvent(request.target, {
        type: 'run.status',
        runId: request.runId,
        threadId: request.threadId,
        status: 'running',
        at: startedAt
      })
      // Persisting the run start above gives the Host an immediate durable
      // acknowledgement. Consent/auth are still re-probed before the first
      // provider process can spawn, so withdrawal wins without a launch.
      const probe = await this.probe(true)
      if (probe.status !== 'ready') throw new Error(probe.detail)
      this.currentOffers = probe.admission.offers
      const current = this.options.runPort.getThread(request.threadId)
      if (!current) throw new Error('AntiGravity thread was removed before launch.')
      thread = this.validateThread(current)
      const selectedModel = wireModel(probe.admission, thread.modelId, thread.reasoningId)
      const handle = this.spawnProcess({
        binaryPath: probe.admission.binaryPath,
        args: buildPlanArgs(
          request.prompt,
          selectedModel,
          thread.reasoningId,
          thread.providerSessionId
        ),
        cwd: thread.workspace.canonicalPath,
        env: hostStandaloneAgyProbeEnvironment(this.options.environment),
        onStdout: (chunk) => {
          if (rawOutput.length < MAX_RAW_OUTPUT_CHARS) {
            rawOutput += chunk.slice(0, MAX_RAW_OUTPUT_CHARS - rawOutput.length)
          }
        },
        onStderr: (chunk) => {
          if (chunk.trim()) stderrSeen = true
        }
      })
      active.handle = handle
      if (active.cancelled) handle.kill('SIGTERM')
      const exit = await handle.exit
      exitCode = exit.code
      status = active.cancelled ? 'cancelled' : exit.code === 0 ? 'completed' : 'failed'
      if (status === 'completed') {
        providerSessionId =
          (await (this.options.readConversationReceipt ?? readHostAgyConversationReceipt)(
            thread.workspace.canonicalPath,
            { env: this.options.environment ?? process.env }
          )) ?? undefined
      }
      const finalText = normalizeHostProviderRunPresentationText(
        rawOutput.trim(),
        HOST_PROVIDER_RUN_MAX_TEXT_CHARS
      )
      if (finalText) {
        this.options.runPort.appendTranscript({
          threadId: request.threadId,
          runId: request.runId,
          role: 'assistant',
          text: finalText,
          createdAt: new Date(this.now()).toISOString()
        })
        this.options.runPort.publishRunEvent(request.target, {
          type: 'run.content',
          runId: request.runId,
          threadId: request.threadId,
          text: finalText.slice(0, 4_000),
          at: new Date(this.now()).toISOString()
        })
      }
      const finish: HostProviderRunFinish = {
        runId: request.runId,
        status,
        finishedAt: new Date(this.now()).toISOString(),
        ...(providerSessionId ? { providerSessionId } : {}),
        warningSummaries: stderrSeen ? ['agy reported stderr during the run.'] : [],
        ...(status === 'failed' ? { errorCode: 'provider_failed' as const } : {})
      }
      this.options.runPort.finishRun(finish)
      this.options.runPort.publishRunEvent(request.target, {
        type: 'run.status',
        runId: request.runId,
        threadId: request.threadId,
        status,
        at: finish.finishedAt,
        ...(stderrSeen ? { warningCount: 1 } : {})
      })
      return {
        runId: request.runId,
        status,
        ...(providerSessionId ? { sessionId: providerSessionId } : {}),
        exitCode
      }
    } catch {
      const finish: HostProviderRunFinish = {
        runId: request.runId,
        status: active.cancelled ? 'cancelled' : 'failed',
        finishedAt: new Date(this.now()).toISOString(),
        warningSummaries: [],
        ...(active.cancelled ? {} : { errorCode: 'provider_launch_failed' as const })
      }
      this.options.runPort.finishRun(finish)
      this.options.runPort.publishRunEvent(request.target, {
        type: 'run.status',
        runId: request.runId,
        threadId: request.threadId,
        status: finish.status,
        at: finish.finishedAt
      })
      return { runId: request.runId, status: finish.status, exitCode: null }
    } finally {
      if (cancelRegistered) this.options.runPort.clearCancel(request.runId)
      this.activeRuns.delete(request.runId)
    }
  }

  cancel(runId: string): boolean {
    const active = this.activeRuns.get(runId)
    if (!active || active.cancelled) return false
    active.cancelled = true
    active.handle?.kill('SIGTERM')
    return true
  }

  async shutdown(): Promise<void> {
    for (const active of this.activeRuns.values()) {
      active.cancelled = true
      active.handle?.kill('SIGTERM')
    }
    this.activeRuns.clear()
    this.probeCache = null
    this.probeInFlight = null
  }
}

export type HostNodeAntigravityProviderFactoryOptions = Omit<
  HostNodeAntigravityProviderOptions,
  'runPort'
> & {
  /** Snapshot-only metadata; it is not used by the AGY run validator. */
  readonly getInventoryModels?: HostNodeProvider['getInventoryModels']
}

export function createHostNodeAntigravityProviderFactory(
  options: HostNodeAntigravityProviderFactoryOptions
): HostNodeProvider {
  if (options.offers.providerId !== ANTIGRAVITY_PROVIDER_ID) {
    throw new Error('AntiGravity provider factory requires AntiGravity offers.')
  }
  return {
    providerId: ANTIGRAVITY_PROVIDER_ID,
    conditionalAdmission: 'antigravity-live-guarded',
    displayProvider: 'AntiGravity',
    shortCode: 'AGY',
    offers: options.offers,
    ...(options.getInventoryModels ? { getInventoryModels: options.getInventoryModels } : {}),
    supportsApprovals: false,
    supportsQuestions: false,
    create({ runPort }) {
      const { getInventoryModels: _getInventoryModels, ...providerOptions } = options
      return new HostNodeAntigravityProvider({ ...providerOptions, runPort })
    }
  }
}
