/**
 * Muse opaque-exec provider adapter (not registered yet).
 *
 * Wires CliArgs + IsolatedHome + skill pin + ExecJson + Usage + CronAssert
 * into one launch/teardown sequence. Compiles against a Muse-local descriptor
 * that mirrors `ProviderAdapter` / mistral+cursor shapes without requiring a
 * `ProviderId` union member.
 *
 * Do NOT import this from `index.ts` until identity + intent land.
 */

import type { ProviderCapabilityRequest, ProviderRunContext } from '../ProviderAdapters'
import {
  buildMuseLaunchPlan,
  createMuseOrchestrationStubs,
  type MuseOrchestrationModules
} from './MuseOrchestrationContracts'
import { resolveMuseExecSessionId } from './MuseCliArgs'
import {
  MUSE_FORBIDDEN_ARGV_FLAGS,
  MUSE_METERING_EXCLUSIVE_ARGV_FLAGS,
  MUSE_EXPECTED_TOOL_SURFACE_VERSION,
  MUSE_PROVIDER_KEY,
  MUSE_TRANSPORT_ID,
  type MuseLaunchPlan,
  type MuseProviderKey,
  type MuseRunRequest,
  type MuseRunResult,
  type MuseTokenUsage,
  type NormalizedMuseRunEvent
} from './MuseTypes'
import {
  isMuseBinaryResolvable,
  isMuseConfiguredForAdmission,
  isMuseCredentialPresent,
  type MuseProbeDeps
} from './MuseProbe'
import { runMuseProvider, type MuseRunSpawn } from './MuseRun'
import type { MuseExecNormalizedEvent } from './MuseExecJson'

/**
 * Local stand-in for `ProviderCapabilityContract` until `ProviderId` includes
 * `'muse'`. Field names mirror the shared contract so registration is a thin
 * remap later.
 */
export interface MuseCapabilityContract {
  provider: MuseProviderKey
  label: string
  refreshedAt: string
  workspacePath?: string
  availability: {
    available: boolean
    setupRequired?: boolean
    binaryPath?: string | null
    error?: string
  }
  approvals: {
    inAppApprovals: false
    modes: MuseAdapterCapabilities['approvalModes']
  }
  mcp: {
    state: 'unsupported'
    source: 'unsupported'
    available: false
    enabled: false
    tools: string[]
    message: string
  }
  warnings: Array<{ id: string; severity: 'info' | 'warning'; message: string }>
}

export interface MuseAdapterFeatureFlags {
  persistentSessions: boolean
  appManagedApprovals: boolean
  workspaceGrants: boolean
  agentBenchMcpBridge: boolean
  providerManagedMcp: boolean
  nativeThreadTools: boolean
  hostCommandFallback: boolean
}

export interface MuseAdapterCapabilities {
  approvalModes: Array<'default' | 'plan' | 'allow-all'>
  reasoningEffort: boolean
  speedTiers: string[]
  imageAttachments: boolean
  contextInjection: boolean
  sessionResumption: boolean
  perThreadMcp: boolean
  assistantTextStreaming: 'token' | 'turn' | 'none'
}

export interface MuseAdapterCapabilityCaveat {
  id: string
  severity: 'info' | 'warning'
  capability: 'taskwraithMcpBridge' | 'providerMcp' | 'approvalModes'
  title: string
  message: string
}

/**
 * Descriptor shape mirrors `ProviderAdapterDescriptor` but keeps `provider`
 * as the Muse-local key until `ProviderId` grows `'muse'`.
 */
export interface MuseProviderAdapterDescriptor {
  provider: MuseProviderKey
  label: string
  transport: typeof MUSE_TRANSPORT_ID
  runChannel: 'run-agent'
  capabilitySource: 'taskwraith' | 'provider' | 'bridge' | 'mixed'
  features: MuseAdapterFeatureFlags
  capabilities: MuseAdapterCapabilities
  capabilityCaveats?: MuseAdapterCapabilityCaveat[]
}

/** Payload subset the opaque exec path needs (avoids ProviderId coupling). */
export interface MuseAdapterRunPayload {
  prompt: string
  workspace?: string
  model?: string
  reasoningEffort?: string | null
  approvalMode?: string
  providerSessionId?: string | null
  appRunId?: string
  /** Optional BYOK; never placed on argv. */
  museApiKey?: string | null
}

export interface MuseProviderAdapter<
  TPayload = MuseAdapterRunPayload,
  TEvent = unknown
> extends MuseProviderAdapterDescriptor {
  run(context: ProviderRunContext<TPayload, TEvent>): Promise<void>
  cancel(runId?: string): Promise<boolean>
  getStatus(): Promise<unknown>
  getMcpStatus(): Promise<unknown>
  getCapabilityContract(request?: ProviderCapabilityRequest): Promise<MuseCapabilityContract>
}

export interface MuseProviderAdapterDeps {
  readonly modules: MuseOrchestrationModules
  readonly probe: MuseProbeDeps
  readonly temporaryRoot: string
  /**
   * Production spawn for `runMuseProvider`. When omitted, falls back to
   * `modules.process.spawn` (stub/harness path).
   */
  readonly spawn?: MuseRunSpawn
  /** Resolve absolute workspace for the run; defaults to payload.workspace. */
  resolveWorkspacePath?: (payload: MuseAdapterRunPayload) => string
  /** Emit normalized events to RunManager (composition root wires this). */
  onEvent?: (runId: string, event: NormalizedMuseRunEvent) => void
  /** Optional cancel registry hook. */
  registerCancel?: (runId: string, cancel: () => void) => void
  clearCancel?: (runId: string) => void
  now?: () => number
  createSessionId?: () => string
}

function mapMuseExecEventToNormalized(event: MuseExecNormalizedEvent): NormalizedMuseRunEvent {
  if (event.type === 'content') {
    return {
      type: 'content',
      text: event.text,
      sessionId: event.sessionId,
      raw: event.raw
    }
  }
  if (event.type === 'terminal') {
    const failed =
      event.terminal === 'failed' || event.terminal === 'error' || event.terminal === 'cancelled'
    return {
      type: 'result',
      text: event.text,
      status: failed ? 'failed' : 'success',
      sessionId: event.sessionId,
      raw: event.raw
    }
  }
  if (event.type === 'run_started' || event.type === 'command_accepted') {
    return {
      type: 'init',
      sessionId: event.sessionId,
      raw: event.raw
    }
  }
  return {
    type: 'provider_warning',
    text: event.payloadType,
    sessionId: event.sessionId,
    raw: event.raw
  }
}

export interface MuseArgvValidationResult {
  readonly ok: boolean
  readonly forbidden: readonly string[]
  readonly meteringConflicts: readonly string[]
}

export function museProviderAdapterDescriptor(): MuseProviderAdapterDescriptor {
  return {
    provider: MUSE_PROVIDER_KEY,
    label: 'Muse',
    transport: MUSE_TRANSPORT_ID,
    runChannel: 'run-agent',
    capabilitySource: 'provider',
    features: {
      // Resume via `--session-id` is supported; durable seat policy still open.
      persistentSessions: true,
      // Native Muse tools are provider-owned; no TW per-tool approval cards in v1.
      appManagedApprovals: false,
      workspaceGrants: false,
      agentBenchMcpBridge: false,
      // No TaskWraith MCP broker for muse exec in v1.
      providerManagedMcp: false,
      nativeThreadTools: true,
      hostCommandFallback: false
    },
    capabilities: {
      approvalModes: ['plan', 'default'],
      reasoningEffort: true,
      speedTiers: [],
      imageAttachments: true,
      contextInjection: true,
      sessionResumption: true,
      perThreadMcp: false,
      assistantTextStreaming: 'token'
    },
    capabilityCaveats: [
      {
        id: 'muse-native-tools-opaque-cli',
        severity: 'info',
        capability: 'approvalModes',
        title: 'Muse containment is argv + isolated home',
        message:
          'Muse runs as an opaque `muse exec --json` seat. TaskWraith contains via hard-pinned argv (no --yolo / --disable-sandbox), relocated XDG/HOME, skill pin, and cron empty-at-teardown. Native tool effects are not individually mediated by TaskWraith approval cards in v1.'
      },
      {
        id: 'muse-no-taskwraith-mcp-broker',
        severity: 'info',
        capability: 'taskwraithMcpBridge',
        title: 'No TaskWraith MCP broker for Muse v1',
        message:
          'muse exec has no per-run MCP config surface. Do not invent a bridge; unique @-mention routing is the only Ensemble path if Muse is ever ensemble-admitted.'
      }
    ]
  }
}

export function validateMuseLaunchArgv(argv: readonly string[]): MuseArgvValidationResult {
  const forbidden: string[] = []
  for (const flag of MUSE_FORBIDDEN_ARGV_FLAGS) {
    if (argv.includes(flag)) forbidden.push(flag)
  }
  // Never emit `--reasoning-effort none` (meta rejects it).
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--reasoning-effort' && argv[i + 1] === 'none') {
      forbidden.push('--reasoning-effort none')
    }
  }
  const meteringConflicts = MUSE_METERING_EXCLUSIVE_ARGV_FLAGS.filter((flag) => argv.includes(flag))
  return {
    ok: forbidden.length === 0,
    forbidden,
    meteringConflicts
  }
}

function scrubInheritedMuseEnv(base: Readonly<Record<string, string>>): Record<string, string> {
  const env = { ...base }
  // Prefer seat-local auth / --api-key-stdin; never forward a host META_API_KEY
  // that happened to land on the plan env map. Lease-local MUSE_AUTH_PATH stays.
  delete env.META_API_KEY
  delete env.MUSE_MODEL
  env.MUSE_NO_AUTO_UPDATE = '1'
  return env
}

export async function prepareMuseLaunchPlan(
  request: MuseRunRequest,
  modules: MuseOrchestrationModules
): Promise<MuseLaunchPlan> {
  const home = modules.isolatedHome.create({
    temporaryRoot: request.temporaryRoot,
    runId: request.runId
  })
  // Skill pin against the lease before argv is considered launchable.
  const pin = await modules.skillPin.applyAndAssert(home)
  if (!pin.ok) {
    home.cleanup()
    throw new Error(pin.warning || 'Muse skill pin failed')
  }

  const plan = buildMuseLaunchPlan(request, modules, {
    skillPinHash: pin.pinHash,
    isolatedHome: home
  })
  const pinnedPlan: MuseLaunchPlan = {
    ...plan,
    env: scrubInheritedMuseEnv(plan.env),
    skillPinHash: pin.pinHash
  }

  const validation = validateMuseLaunchArgv(pinnedPlan.argv)
  if (!validation.ok) {
    home.cleanup()
    throw new Error(
      `Muse launch argv rejected (forbidden: ${validation.forbidden.join(', ') || 'none'})`
    )
  }
  if (validation.meteringConflicts.length > 0) {
    home.cleanup()
    throw new Error(
      `Muse launch argv rejected (metering exclusive: ${validation.meteringConflicts.join(', ')})`
    )
  }
  return pinnedPlan
}

export async function runMuseOpaqueExec(input: {
  readonly binaryPath: string
  readonly request: MuseRunRequest
  readonly modules: MuseOrchestrationModules
  readonly onEvent?: (event: NormalizedMuseRunEvent) => void
  readonly shouldCancel?: () => boolean
}): Promise<MuseRunResult> {
  const warnings: string[] = []
  let assistantText = ''
  let usage: MuseTokenUsage | null = null
  let toolSurfaceVersion: string | null = null
  let buildSha: string | null = null
  let sessionId: string | null = input.request.sessionId ?? input.request.runId
  let terminalStatus: MuseRunResult['status'] = 'failed'
  let exitCode: number | null = null

  const plan = await prepareMuseLaunchPlan(input.request, input.modules)
  sessionId = plan.sessionId
  const parser = input.modules.execJson.createParser()

  const handleEvents = (events: NormalizedMuseRunEvent[]): void => {
    for (const event of events) {
      if (event.sessionId) sessionId = event.sessionId
      if (event.type === 'content' && event.text) assistantText += event.text
      if (event.type === 'result') {
        if (event.text) assistantText = event.text
        terminalStatus = event.status === 'failed' ? 'failed' : 'success'
        if (event.usage) usage = event.usage
      }
      if (event.type === 'usage' && event.usage) usage = event.usage
      if (event.type === 'init' || event.toolSurfaceVersion || event.buildSha) {
        if (event.toolSurfaceVersion) toolSurfaceVersion = event.toolSurfaceVersion
        if (event.buildSha) buildSha = event.buildSha
        const surface = input.modules.execJson.assertToolSurface(
          event,
          MUSE_EXPECTED_TOOL_SURFACE_VERSION
        )
        if (!surface.ok) {
          warnings.push(surface.reason)
          terminalStatus = 'failed'
        }
        if (plan.buildShaExpected && event.buildSha && event.buildSha !== plan.buildShaExpected) {
          warnings.push(
            `build.sha mismatch: got ${event.buildSha}, expected ${plan.buildShaExpected}`
          )
        }
      }
      if (event.type === 'provider_warning' && event.text) warnings.push(event.text)
      input.onEvent?.(event)
    }
  }

  let handle: ReturnType<MuseOrchestrationModules['process']['spawn']> | null = null
  try {
    if (input.shouldCancel?.()) {
      terminalStatus = 'cancelled'
      return {
        status: 'cancelled',
        sessionId,
        exitCode: null,
        assistantText,
        usage,
        warnings,
        toolSurfaceVersion,
        buildSha
      }
    }

    handle = input.modules.process.spawn({
      binaryPath: input.binaryPath,
      argv: plan.argv,
      cwd: plan.cwd,
      env: plan.env,
      stdin: plan.apiKeyStdin ? (input.request.apiKey ?? null) : null
    })

    handle.onStdout((chunk) => handleEvents(parser.push(chunk)))
    handle.onStderr((_chunk) => {
      // stderr retained only as warnings when non-empty lines appear later
    })

    const waited = await handle.wait()
    exitCode = waited.code
    handleEvents(parser.flush())

    // Parser callbacks mutate `terminalStatus`; cast widens past CFA's
    // stuck `'failed'` literal before reconcile.
    const observedTerminal = terminalStatus as MuseRunResult['status']
    if (input.shouldCancel?.()) {
      terminalStatus = 'cancelled'
    } else if (
      observedTerminal !== 'success' &&
      exitCode === 0 &&
      !warnings.some((w) => w.includes('tool_surface_version'))
    ) {
      // Process success with no explicit result event still counts as success.
      terminalStatus = assistantText || exitCode === 0 ? 'success' : 'failed'
    } else if (exitCode !== 0 && observedTerminal === 'success') {
      terminalStatus = 'failed'
    }

    const usageProjection = await input.modules.usage.projectFromSession({
      dataHome: plan.isolatedHome.env.XDG_DATA_HOME,
      sessionId: plan.sessionId
    })
    if (usageProjection.usage) usage = usageProjection.usage

    const cron = await input.modules.cronAssert.assertEmptyAtTeardown({
      dataHome: plan.isolatedHome.env.XDG_DATA_HOME,
      sessionId: plan.sessionId
    })
    if (!cron.ok) {
      warnings.push(
        cron.warning ||
          `Muse cron_jobs not empty at teardown (count=${cron.jobCount}); fail-closed warning until model-reachability is proven`
      )
    }
  } finally {
    const cleanup = plan.isolatedHome.cleanup()
    if (!cleanup.ok) {
      warnings.push(cleanup.reason)
    }
  }

  return {
    status: terminalStatus,
    sessionId,
    exitCode,
    assistantText,
    usage,
    warnings,
    toolSurfaceVersion,
    buildSha
  }
}

export function createMuseProviderAdapter<TPayload extends MuseAdapterRunPayload, TEvent = unknown>(
  deps: MuseProviderAdapterDeps
): MuseProviderAdapter<TPayload, TEvent> {
  const activeCancels = new Map<string, () => void>()
  const descriptor = museProviderAdapterDescriptor()

  return {
    ...descriptor,
    async run(context) {
      const payload = context.payload as MuseAdapterRunPayload
      const runId =
        typeof payload.appRunId === 'string' && payload.appRunId.trim()
          ? payload.appRunId.trim()
          : deps.createSessionId?.() || `muse-run-${deps.now?.() ?? Date.now()}`
      const workspacePath =
        deps.resolveWorkspacePath?.(payload) ||
        (typeof payload.workspace === 'string' ? payload.workspace : '')
      if (!workspacePath) {
        throw new Error('Muse adapter requires a workspace path')
      }

      const binaryOk = await isMuseBinaryResolvable(deps.probe)
      if (!binaryOk) {
        throw new Error('Muse binary is not resolvable')
      }
      const credOk = await isMuseCredentialPresent(deps.probe)
      if (!credOk) {
        throw new Error('Muse credential is not present')
      }
      const resolved = await deps.probe.resolveBinary()
      if (!resolved.binaryPath) {
        throw new Error(resolved.error || 'Muse binary is not resolvable')
      }

      let cancelled = false
      const cancel = () => {
        cancelled = true
      }
      activeCancels.set(runId, cancel)
      deps.registerCancel?.(runId, cancel)

      try {
        const spawn: MuseRunSpawn =
          deps.spawn ?? ((spawnInput) => deps.modules.process.spawn(spawnInput))
        await runMuseProvider({
          binaryPath: resolved.binaryPath,
          workspacePath,
          prompt: payload.prompt,
          runId,
          temporaryRoot: deps.temporaryRoot,
          sessionId: resolveMuseExecSessionId(payload.providerSessionId),
          model: payload.model,
          reasoningEffort: payload.reasoningEffort,
          approvalMode: payload.approvalMode,
          apiKey: payload.museApiKey,
          spawn,
          shouldCancel: () => cancelled,
          onEvent: (event) => deps.onEvent?.(runId, mapMuseExecEventToNormalized(event))
        })
      } finally {
        activeCancels.delete(runId)
        deps.clearCancel?.(runId)
      }
    },
    async cancel(runId) {
      if (runId && activeCancels.has(runId)) {
        activeCancels.get(runId)?.()
        activeCancels.delete(runId)
        deps.clearCancel?.(runId)
        return true
      }
      if (!runId) {
        for (const [id, cancel] of activeCancels) {
          cancel()
          activeCancels.delete(id)
          deps.clearCancel?.(id)
        }
        return true
      }
      return false
    },
    async getStatus() {
      const configured = await isMuseConfiguredForAdmission(deps.probe)
      const resolved = await deps.probe.resolveBinary()
      const credentialPresent = await isMuseCredentialPresent(deps.probe)
      return {
        provider: MUSE_PROVIDER_KEY,
        available: configured,
        setupRequired: !configured,
        binaryPath: resolved.binaryPath,
        binaryResolvable: Boolean(resolved.binaryPath),
        credentialPresent,
        // Honest: native approvals are Muse-owned; TW cards do not mediate them.
        inAppApprovals: false,
        transport: MUSE_TRANSPORT_ID
      }
    },
    async getMcpStatus() {
      return {
        provider: MUSE_PROVIDER_KEY,
        available: false,
        enabled: false,
        source: 'none',
        serverName: null,
        tools: [] as string[],
        sections: [] as unknown[],
        message:
          'Muse v1 has no TaskWraith MCP broker. Native Muse tools remain provider-owned under argv + isolated-home containment.'
      }
    },
    async getCapabilityContract(request = {}): Promise<MuseCapabilityContract> {
      const status = (await this.getStatus()) as {
        available?: boolean
        setupRequired?: boolean
        binaryPath?: string | null
      }
      const mcpStatus = (await this.getMcpStatus()) as { message?: string }
      return {
        provider: MUSE_PROVIDER_KEY,
        label: descriptor.label,
        refreshedAt: new Date().toISOString(),
        workspacePath: request.workspacePath,
        availability: {
          available: Boolean(status.available),
          setupRequired: Boolean(status.setupRequired),
          binaryPath: status.binaryPath ?? null
        },
        approvals: {
          inAppApprovals: false,
          modes: descriptor.capabilities.approvalModes
        },
        mcp: {
          state: 'unsupported',
          source: 'unsupported',
          available: false,
          enabled: false,
          tools: [],
          message: mcpStatus.message || 'Muse v1 has no TaskWraith MCP broker.'
        },
        warnings:
          descriptor.capabilityCaveats?.map((caveat) => ({
            id: caveat.id,
            severity: caveat.severity,
            message: caveat.message
          })) ?? []
      }
    }
  }
}

/** Convenience factory with in-folder orchestration stubs (unit tests / harness). */
export function createStubWiredMuseProviderAdapter(
  input: Omit<MuseProviderAdapterDeps, 'modules'> & {
    modules?: Partial<MuseOrchestrationModules>
  }
): MuseProviderAdapter {
  return createMuseProviderAdapter({
    ...input,
    modules: createMuseOrchestrationStubs(input.modules)
  })
}
