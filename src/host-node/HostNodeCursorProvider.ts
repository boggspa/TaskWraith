/**
 * Node-owned Cursor provider adapter — status/auth/selection only.
 *
 * RUN PATH IS DELIBERATELY NOT IMPLEMENTED. This is a safety decision, not an
 * omission of effort.
 *
 * Cursor's argv is containment-coupled. In the App, `buildCursorCliArgs`
 * (src/main/cursor/CursorCliArgs.ts:113-167) only permits a write-capable
 * invocation when `containmentAttested === true` AND the MCP deny-list bridge
 * is active; otherwise it clamps the run to `--mode plan`. The comment at
 * :143-150 is explicit that a read-only seat is safe only because a
 * deny-list + read-only-only broker is proven to be in place.
 *
 * The pure-Node Host has no MCP bridge and therefore cannot produce that
 * attestation. Re-authoring the argv builder here would either (a) construct an
 * uncontained write-capable Cursor process, or (b) silently clamp every Host
 * Cursor run to plan mode, which executes no tools and would read as a broken
 * provider. Neither is acceptable, so this adapter rejects `run()` with a typed
 * error until a Host-side containment attestation exists.
 *
 * Everything that can be answered honestly IS answered: a missing binary is a
 * present `unavailable` row (never an omission), auth state and flows come from
 * the wave-A resource port, and thread selection is validated against the
 * catalog offers.
 *
 * Control characters are detected numerically so this file carries no literal
 * control bytes.
 */

import { spawn as nodeSpawn } from 'node:child_process'

import { hostProviderAuthFlows, hostProviderOffers } from '../host-shared/HostProviderCatalog'
import { normalizeGrok46ReasoningEffort } from '../shared/grok45Models'
import {
  createHostNodeProviderResourcePort,
  hostNodeProviderAuthFlows,
  hostNodeProviderAuthStatus,
  normalizeHostNodeProviderStatus,
  type HostNodeProviderResourcePort
} from './HostNodeProviderResources'
import type { HostNodeProviderTerminalLauncher } from './HostNodeTerminalLauncher'
import {
  normalizeHostProviderRunThread,
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

const CURSOR_PROVIDER_ID = 'cursor'
const SAFE_IDENTIFIER_MAX_CHARS = 512
const CONTROL_MAX_CODE_POINT = 0x1f
const DELETE_CODE_POINT = 0x7f
/**
 * Contract-probed in this environment: `cursor-agent --help` lists
 * `status|whoami` as one authentication-status command. The Host probes
 * `status` by exit code only; `whoami` is the same command, not a second probe.
 */
const CURSOR_AUTH_PROBE_ARGS = ['status'] as const
const CURSOR_LOGIN_ARGV_SUFFIX = ['login'] as const

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= CONTROL_MAX_CODE_POINT || codePoint === DELETE_CODE_POINT) return true
  }
  return false
}

function isCanonicalIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SAFE_IDENTIFIER_MAX_CHARS &&
    value.trim() === value &&
    !hasControlCharacter(value)
  )
}

export class HostNodeCursorValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostNodeCursorValidationError'
  }
}

/**
 * Typed refusal for a run path that is not implemented. It is deliberately a
 * distinct error type so the domain, tests, and reviewers can tell "Cursor
 * cannot run here yet" apart from "the Cursor run failed".
 */
export class HostNodeCursorRunNotImplementedError extends Error {
  readonly providerId = CURSOR_PROVIDER_ID
  readonly reason =
    'Cursor requires a containment attestation that the pure-Node Host cannot produce.'
  constructor() {
    super(
      'Host Cursor runs are not implemented: a write-capable Cursor argv requires MCP deny-list containment attestation, which the Node Host does not have.'
    )
    this.name = 'HostNodeCursorRunNotImplementedError'
  }
}

export interface HostNodeCursorAuthProbeInput {
  readonly binaryPath: string
  readonly args: readonly string[]
}

export interface HostNodeCursorAuthProbeResult {
  readonly exitCode: number | null
}

export type HostNodeCursorAuthProbe = (
  input: HostNodeCursorAuthProbeInput
) => Promise<HostNodeCursorAuthProbeResult>

/** Exit-code-only Cursor auth probe. Stdio is discarded so credential text never enters the Host. */
export const hostNodeCursorAuthProbe: HostNodeCursorAuthProbe = (input) =>
  new Promise((resolve) => {
    const child = nodeSpawn(input.binaryPath, [...input.args], {
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: false,
      windowsHide: true
    })
    child.once('error', () => resolve({ exitCode: null }))
    child.once('close', (code) => resolve({ exitCode: code ?? null }))
  })

export interface HostNodeCursorProviderOptions {
  readonly runPort: HostProviderRunPort
  readonly offers: HostProviderOffersProjection
  readonly resources?: HostNodeProviderResourcePort
  readonly terminalLauncher?: HostNodeProviderTerminalLauncher
  readonly probeAuth?: HostNodeCursorAuthProbe
}

/**
 * Top-of-ladder tiers other seats persist that Cursor has never offered. These
 * fold onto Cursor's ceiling; every other off-ladder value still fails closed.
 */
const CURSOR_FOLDABLE_TOP_TIER_STOPS: ReadonlySet<string> = new Set([
  'max',
  'ultra',
  'ultracode',
  'ultratask'
])

export class HostNodeCursorProvider implements HostNodeProviderInstance {
  readonly providerId = CURSOR_PROVIDER_ID
  private readonly resources: HostNodeProviderResourcePort

  constructor(private readonly options: HostNodeCursorProviderOptions) {
    this.resources = options.resources ?? createHostNodeProviderResourcePort(CURSOR_PROVIDER_ID)
  }

  private async probeAuthState(
    binaryPath: string
  ): Promise<'authenticated' | 'unauthenticated' | 'unknown'> {
    try {
      const probe = this.options.probeAuth ?? hostNodeCursorAuthProbe
      const result = await probe({ binaryPath, args: [...CURSOR_AUTH_PROBE_ARGS] })
      if (result.exitCode === 0) return 'authenticated'
      if (typeof result.exitCode === 'number') return 'unauthenticated'
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  private async resolveAuthState(
    resourceAuthState: 'authenticated' | 'unauthenticated' | 'unknown',
    binaryPath: string | null
  ): Promise<'authenticated' | 'unauthenticated' | 'unknown'> {
    if (resourceAuthState === 'authenticated' || resourceAuthState === 'unauthenticated') {
      return resourceAuthState
    }
    if (!binaryPath) return 'unknown'
    return this.probeAuthState(binaryPath)
  }

  private async runtimeStatus() {
    const [binary, resourceAuthState] = await Promise.all([
      this.resources.resolveBinary().catch(() => ({ binaryPath: null as string | null })),
      this.resources.getAuthState().catch(() => 'unknown' as const)
    ])
    const binaryAvailable = Boolean(binary.binaryPath)
    const authState = await this.resolveAuthState(resourceAuthState, binary.binaryPath)
    return {
      providerId: CURSOR_PROVIDER_ID,
      available: binaryAvailable && authState === 'authenticated',
      binaryAvailable,
      authState
    }
  }

  /**
   * A missing binary is a present `unavailable` row, never an omission.
   * Signed-in Cursor is degraded, not ready: run() stays a typed hard-stop until
   * the Node Host can produce MCP deny-list containment attestation.
   */
  async getStatus(): Promise<HostProviderStatusProjection> {
    const runtime = await this.runtimeStatus()
    if (runtime.binaryAvailable && runtime.authState === 'authenticated') {
      return {
        providerId: CURSOR_PROVIDER_ID,
        status: 'degraded',
        label: 'Cursor',
        detail:
          'Cursor sign-in succeeded, but Host Cursor runs stay blocked until MCP deny-list containment attestation exists.'
      }
    }
    return normalizeHostNodeProviderStatus(CURSOR_PROVIDER_ID, runtime)
  }

  async getAuthStatus(): Promise<HostProviderAuthStatusProjection> {
    return hostNodeProviderAuthStatus(CURSOR_PROVIDER_ID, await this.runtimeStatus())
  }

  async getAuthFlows(): Promise<readonly HostProviderAuthFlowProjection[]> {
    if (!this.options.terminalLauncher) return []
    return hostNodeProviderAuthFlows(CURSOR_PROVIDER_ID, await this.runtimeStatus())
  }

  async beginAuth(operationId: string): Promise<void> {
    if (!isCanonicalIdentifier(operationId)) {
      throw new HostNodeCursorValidationError('Cursor auth operation id is not canonical.')
    }
    const launcher = this.options.terminalLauncher
    if (!launcher) {
      throw new HostNodeCursorValidationError('Cursor interactive terminal login is unavailable.')
    }
    const status = await this.runtimeStatus()
    if (!status.binaryAvailable || status.authState !== 'unauthenticated') {
      throw new HostNodeCursorValidationError('Cursor sign-in is not currently available.')
    }
    if (hostProviderAuthFlows(CURSOR_PROVIDER_ID).length === 0) {
      throw new HostNodeCursorValidationError('Cursor has no manual sign-in flow.')
    }
    const binary = await this.resources.resolveBinary()
    if (!binary.binaryPath) {
      throw new HostNodeCursorValidationError('Cursor CLI is unavailable.')
    }
    // Handoff close is not authentication; getAuthStatus still probes `status`.
    await launcher.launchForProvider(CURSOR_PROVIDER_ID, {
      argv: [binary.binaryPath, ...CURSOR_LOGIN_ARGV_SUFFIX]
    })
  }

  async cancelAuth(): Promise<boolean> {
    return false
  }

  /**
   * Validate a thread's Cursor selection against the catalog offers. Exposed so
   * the domain and tests can check selection without a run path.
   */
  validateThread(thread: HostProviderRunThread): HostProviderRunThread {
    const normalized = normalizeHostProviderRunThread(thread)
    if (!normalized) {
      throw new HostNodeCursorValidationError('Cursor thread configuration is invalid.')
    }
    if (normalized.providerId !== CURSOR_PROVIDER_ID) {
      throw new HostNodeCursorValidationError('Thread is not configured for Cursor.')
    }
    const model = this.options.offers.models.find((entry) => entry.modelId === normalized.modelId)
    if (!model) {
      throw new HostNodeCursorValidationError('Cursor model is not offered by the Host catalog.')
    }
    if (
      normalized.reasoningId !== undefined &&
      !model.reasoning.some((entry) => entry.reasoningId === normalized.reasoningId)
    ) {
      // Reasoning is persisted per CHAT, not per provider, so a thread that ran
      // on Claude, Ollama or Pi arrives here carrying `max` — a stop Cursor's
      // STANDARD_REASONING ladder (low/medium/high/xhigh) has never offered.
      // `19db454b6` folded exactly this for Ollama and Pi and left Cursor
      // throwing because its ladder "did not narrow": true, but the stop comes
      // from another seat rather than from a narrowing, so the exemption did
      // not hold. Refusing strands the run — HostNodeDomainPorts turns the
      // rejection into failed('run_not_started') — which reads in the UI as the
      // model selection snapping back to the previous one.
      //
      // Fold only the recognised top-of-ladder tiers, through the same clamp
      // the renderer already applies (normalizeGrok46ReasoningEffort), so host
      // and renderer cannot disagree about the ceiling. A value that was never
      // a stop still fails closed — the normalizer is total, so gating on the
      // recognised set is what stops it laundering junk into 'xhigh'.
      const folded = CURSOR_FOLDABLE_TOP_TIER_STOPS.has(normalized.reasoningId)
        ? normalizeGrok46ReasoningEffort(normalized.reasoningId)
        : undefined
      if (!folded || !model.reasoning.some((entry) => entry.reasoningId === folded)) {
        throw new HostNodeCursorValidationError('Cursor reasoning is not offered for this model.')
      }
      return { ...normalized, reasoningId: folded }
    }
    return normalized
  }

  /**
   * Typed refusal. Nothing is persisted: no run row, no transcript, no events.
   * A caller therefore never sees a phantom run that appears to have started.
   */
  async run(request: HostNodeProviderRunRequest): Promise<HostNodeProviderRunResult> {
    void request
    throw new HostNodeCursorRunNotImplementedError()
  }

  cancel(): boolean {
    return false
  }

  async shutdown(): Promise<void> {
    // No process is ever started by this adapter.
  }
}

export interface HostNodeCursorProviderFactoryOptions {
  readonly offers?: HostProviderOffersProjection
  readonly resources?: HostNodeProviderResourcePort
  readonly terminalLauncher?: HostNodeProviderTerminalLauncher
  readonly probeAuth?: HostNodeCursorAuthProbe
}

/** Static Cursor factory implementing the generic HostNodeProvider contract. */
export function createHostNodeCursorProviderFactory(
  options: HostNodeCursorProviderFactoryOptions = {}
): HostNodeProvider {
  const offers = options.offers ?? hostProviderOffers(CURSOR_PROVIDER_ID, true)
  if (!offers || offers.providerId !== CURSOR_PROVIDER_ID) {
    throw new Error('Cursor provider factory requires Cursor offers')
  }
  return {
    providerId: CURSOR_PROVIDER_ID,
    displayProvider: 'Cursor',
    shortCode: 'CU',
    offers,
    supportsApprovals: false,
    supportsQuestions: false,
    create({ runPort, interactions }) {
      void interactions
      return new HostNodeCursorProvider({
        runPort,
        offers,
        ...(options.resources ? { resources: options.resources } : {}),
        ...(options.terminalLauncher ? { terminalLauncher: options.terminalLauncher } : {}),
        ...(options.probeAuth ? { probeAuth: options.probeAuth } : {})
      })
    }
  }
}
