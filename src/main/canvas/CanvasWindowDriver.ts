/**
 * Tier-4 native-window Canvas adapter.
 *
 * This file deliberately contains no LaunchManager lookup, attached-window
 * singleton access, Electron IPC, or raw JSON-RPC method names. Main must first
 * turn a user-picked window into an exact, run-owned lease and inject:
 *
 *  - the immutable lease identity;
 *  - an authority that revalidates that identity before and after every await;
 *  - a bridge already bound to the user's opaque attached-window handle.
 *
 * Merely constructing this driver is therefore not authority to operate an
 * arbitrary desktop window. CanvasService receives one only through the
 * private, exact-run target factory; raw agent-facing canvas_open never can.
 */
import { createHash } from 'crypto'
import type {
  CanvasActionInput,
  CanvasActRefusalReason,
  CanvasActResult,
  CanvasActVerification,
  CanvasConsoleEntry,
  CanvasDriver,
  CanvasElementDetail,
  CanvasElementNode,
  CanvasElementTree,
  CanvasEvalResult,
  CanvasFrame,
  CanvasMark,
  CanvasNetworkEntry,
  CanvasOpenInput,
  CanvasSessionHandle,
  CanvasSketchDocument,
  CanvasSketchUpdateInput,
  CanvasViewport
} from './canvasTypes'

export interface CanvasWindowLeaseIdentity {
  chatId: string
  runId: string
  attemptId: string
  pid: number
  windowId: number
  processStartedAt: string
  instanceEpoch: string
  consentEpoch: string
  generation: number
}

export interface CanvasWindowLeaseAuthority {
  /**
   * Return the exact currently-live lease, or null after any revocation.
   *
   * Production wiring must derive this from main-owned RunManager,
   * LaunchManager, consent, and instance state. It must not echo caller input.
   */
  current(): CanvasWindowLeaseIdentity | null | Promise<CanvasWindowLeaseIdentity | null>
}

export interface CanvasWindowLeaseEnvelope {
  lease: CanvasWindowLeaseIdentity
}

export interface CanvasWindowAdoptResult extends CanvasWindowLeaseEnvelope {
  pid: number
  title: string
  viewport: CanvasViewport
}

export interface CanvasWindowActionVerification {
  actionId: string
  verified: CanvasActVerification
}

export interface CanvasWindowObserveResult extends CanvasWindowLeaseEnvelope {
  observationId: string
  inputEpoch: number
  tree: CanvasElementTree
  /** Required on the first observation after every action attempt. */
  actionVerification?: CanvasWindowActionVerification
}

export interface CanvasWindowCaptureResult extends CanvasWindowLeaseEnvelope {
  frame: CanvasFrame
}

export interface CanvasWindowInspectResult extends CanvasWindowLeaseEnvelope {
  observationId: string
  detail: CanvasElementDetail
}

export type CanvasWindowRefusalReason =
  | CanvasActRefusalReason
  | 'consequential_confirmation_required'

export interface CanvasWindowNativeActionResult {
  ok: boolean
  found: boolean
  executed: boolean
  refusalReason?: CanvasWindowRefusalReason
  message?: string
}

export type CanvasWindowActionResult = Omit<CanvasActResult, 'refusalReason'> & {
  refusalReason?: CanvasWindowRefusalReason
}

export interface CanvasWindowActResult extends CanvasWindowLeaseEnvelope {
  observationId: string
  /** Opaque, one-use native action identity verified by the next observation. */
  actionId: string
  result: CanvasWindowNativeActionResult
}

export interface CanvasWindowReleaseResult extends CanvasWindowLeaseEnvelope {
  released: boolean
}

export type CanvasWindowObserveRequest = CanvasWindowLeaseEnvelope

export interface CanvasWindowInspectRequest extends CanvasWindowLeaseEnvelope {
  observationId: string
  inputEpoch: number
  ref: string
}

export interface CanvasWindowClickRequest extends CanvasWindowInspectRequest {
  /** Opaque, factory-minted one-use receipt. It never reaches the native daemon. */
  clickReceipt: string
}

export interface CanvasWindowFillRequest extends CanvasWindowInspectRequest {
  value: string
}

/**
 * Narrow typed boundary implemented by the Electron → Swift JSON-RPC adapter.
 *
 * The implementation should map these calls to nativeWindow.adopt/observe/
 * capture/inspect/click/fill/release. It must already be closed over the opaque
 * attached-window handle; the handle never enters CanvasOpenInput or MCP args.
 */
export interface CanvasWindowNativeBridge {
  adopt(request: CanvasWindowLeaseEnvelope): Promise<CanvasWindowAdoptResult>
  observe(request: CanvasWindowObserveRequest): Promise<CanvasWindowObserveResult>
  capture(request: CanvasWindowLeaseEnvelope): Promise<CanvasWindowCaptureResult>
  inspect(request: CanvasWindowInspectRequest): Promise<CanvasWindowInspectResult>
  click(request: CanvasWindowClickRequest): Promise<CanvasWindowActResult>
  fill(request: CanvasWindowFillRequest): Promise<CanvasWindowActResult>
  release(request: CanvasWindowLeaseEnvelope): Promise<CanvasWindowReleaseResult>
}

export interface CanvasWindowDriverDeps {
  lease: CanvasWindowLeaseIdentity
  authority: CanvasWindowLeaseAuthority
  bridge: CanvasWindowNativeBridge
  /**
   * Factory-owned authorization broker for native clicks. It requests human
   * confirmation using only the public scope/summary and returns an opaque,
   * one-use receipt. Missing/false/error always fails closed before the bridge.
   */
  clickAuthorization?: CanvasWindowClickAuthorization
}

export interface CanvasWindowClickAuthorizationScope {
  readonly chatId: string
  readonly runId: string
  readonly attemptId: string
  readonly consentEpoch: string
  readonly generation: number
}

export interface CanvasWindowClickAuthorizationRequest {
  /** No PID/window/process-start/attachment data crosses this UI boundary. */
  readonly scope: CanvasWindowClickAuthorizationScope
  readonly observationId: string
  readonly inputEpoch: number
  readonly ref: string
  /** Human-displayable, value-free summary of the exact target. */
  readonly semanticSummary: string
  /** Conservative lexical hint for the approval UI, never an authorization boundary. */
  readonly consequentialHint: boolean
}

export interface CanvasWindowClickAuthorizationReceipt {
  /** Opaque factory token; the driver must not inspect or persist it. */
  readonly receipt: string
}

export interface CanvasWindowClickAuthorization {
  authorize(
    request: CanvasWindowClickAuthorizationRequest
  ):
    | CanvasWindowClickAuthorizationReceipt
    | null
    | Promise<CanvasWindowClickAuthorizationReceipt | null>
}

export interface CanvasWindowInspectInput {
  ref?: string
  selector?: string
  styles?: string[]
  /** The observationId returned by observe/snapshot. Required for this driver. */
  expectedObservationId?: string
}

export interface CanvasWindowActionInput extends CanvasActionInput {
  /** The observationId returned by observe/snapshot. Required for this driver. */
  expectedObservationId?: string
}

export interface CanvasWindowElementTree extends CanvasElementTree {
  observationId: string
  /** Present only on the mandatory observation immediately following an action. */
  lastActionVerification?: CanvasWindowActionVerification
}

export class CanvasWindowLeaseError extends Error {
  readonly code = 'CANVAS_WINDOW_LEASE_INVALID'

  constructor(message = 'Native-window authority is absent, stale, or mismatched.') {
    super(message)
    this.name = 'CanvasWindowLeaseError'
  }
}

const LEASE_FIELDS: ReadonlyArray<keyof CanvasWindowLeaseIdentity> = [
  'chatId',
  'runId',
  'attemptId',
  'pid',
  'windowId',
  'processStartedAt',
  'instanceEpoch',
  'consentEpoch',
  'generation'
]

const REFUSAL_REASONS: ReadonlySet<string> = new Set([
  'not_found',
  'stale_target',
  'occluded',
  'not_fillable',
  'secret_field',
  'user_active',
  'stale_input_epoch',
  'consequential_confirmation_required'
])

// Advisory UI signal only. English/AX labels can be localized, icon-only, or
// misleading, so this list never authorizes or secures a native click. Every
// click independently requires a one-use, content-bound confirmation callback.
const CONSEQUENTIAL_ACTION_WORDS = new Set([
  'delete',
  'remove',
  'send',
  'publish',
  'transfer',
  'pay',
  'payment',
  'purchase',
  'buy',
  'checkout',
  'order',
  'confirm',
  'submit',
  'approve',
  'approval',
  'authorize',
  'authorise',
  'authorization',
  'authorisation',
  'cancel',
  'subscription',
  'account',
  'security',
  'password',
  'credential',
  'credentials',
  'billing',
  'invoice',
  'card',
  'bank'
])
const PNG_SIGNATURE_HEX = '89504e470d0a1a0a'

type DriverState = 'new' | 'opening' | 'open' | 'closing' | 'closed'

interface ObservedTarget {
  role: string
  name?: string
  tag: string
  secure: boolean
}

interface CurrentObservation {
  observationId: string
  inputEpoch: number
  targets: ReadonlyMap<string, ObservedTarget>
}

interface PendingAction {
  /** Null means dispatch may have happened but the bridge returned no correlatable id. */
  actionId: string | null
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty canonical string.`)
  }
  return value
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return Number(value)
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer.`)
  }
  return Number(value)
}

function requireCanonicalTimestamp(value: unknown, label: string): string {
  const timestamp = requireNonEmptyString(value, label)
  const parsed = new Date(timestamp)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp.`)
  }
  return timestamp
}

function requireViewport(value: unknown, label: string): CanvasViewport {
  const candidate = value as Partial<CanvasViewport> | null
  return {
    width: requirePositiveInteger(candidate?.width, `${label}.width`),
    height: requirePositiveInteger(candidate?.height, `${label}.height`)
  }
}

function canonicalLease(value: CanvasWindowLeaseIdentity): CanvasWindowLeaseIdentity {
  return Object.freeze({
    chatId: requireNonEmptyString(value.chatId, 'lease.chatId'),
    runId: requireNonEmptyString(value.runId, 'lease.runId'),
    attemptId: requireNonEmptyString(value.attemptId, 'lease.attemptId'),
    pid: requirePositiveInteger(value.pid, 'lease.pid'),
    windowId: requirePositiveInteger(value.windowId, 'lease.windowId'),
    processStartedAt: requireNonEmptyString(value.processStartedAt, 'lease.processStartedAt'),
    instanceEpoch: requireNonEmptyString(value.instanceEpoch, 'lease.instanceEpoch'),
    consentEpoch: requireNonEmptyString(value.consentEpoch, 'lease.consentEpoch'),
    generation: requireNonNegativeInteger(value.generation, 'lease.generation')
  })
}

function sameLease(
  expected: CanvasWindowLeaseIdentity,
  actual: CanvasWindowLeaseIdentity | null | undefined
): boolean {
  return Boolean(actual && LEASE_FIELDS.every((field) => actual[field] === expected[field]))
}

function assertLeaseEcho(
  expected: CanvasWindowLeaseIdentity,
  response: CanvasWindowLeaseEnvelope
): void {
  if (!sameLease(expected, response?.lease)) {
    throw new CanvasWindowLeaseError('Native bridge returned a mismatched lease identity.')
  }
}

function unsupported(verb: string): never {
  throw new Error(
    `canvas_${verb} is not available for the native window driver. ` +
      'This bounded adapter exposes screenshot/observe/inspect/click/fill only.'
  )
}

function indexObservedTargets(root: CanvasElementNode): ReadonlyMap<string, ObservedTarget> {
  const targets = new Map<string, ObservedTarget>()
  const stack: CanvasElementNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    const ref = requireNonEmptyString(node?.ref, 'nativeWindow.observe.tree.node.ref')
    if (targets.has(ref)) {
      throw new Error('Native observation returned duplicate AX refs.')
    }
    const role = requireNonEmptyString(node.role, `nativeWindow.observe.tree.${ref}.role`)
    const tag = requireNonEmptyString(node.tag, `nativeWindow.observe.tree.${ref}.tag`)
    if (node.name !== undefined && typeof node.name !== 'string') {
      throw new Error(`nativeWindow.observe.tree.${ref}.name must be a string.`)
    }
    if (node.secure !== undefined && typeof node.secure !== 'boolean') {
      throw new Error(`nativeWindow.observe.tree.${ref}.secure must be a boolean.`)
    }
    targets.set(ref, {
      role,
      tag,
      secure: node.secure === true,
      ...(node.name !== undefined ? { name: node.name } : {})
    })
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) {
        throw new Error(`nativeWindow.observe.tree.${ref}.children must be an array.`)
      }
      stack.push(...node.children)
    }
  }
  return targets
}

function normalizedAxWords(value: string | undefined): string[] {
  if (!value) return []
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function looksConsequential(target: ObservedTarget): boolean {
  return [...normalizedAxWords(target.role), ...normalizedAxWords(target.name)].some((word) =>
    CONSEQUENTIAL_ACTION_WORDS.has(word)
  )
}

function isStandardNonSecureFillTarget(target: ObservedTarget): boolean {
  const role = target.role.toLowerCase().replace(/[^a-z0-9]/g, '')
  return [
    'axtextfield',
    'textfield',
    'axtextarea',
    'textarea',
    'axcombobox',
    'combobox',
    'axsearchfield',
    'searchfield'
  ].includes(role)
}

function semanticSummary(target: ObservedTarget): string {
  const pieces = [target.role, target.tag, target.name].filter(
    (value): value is string => typeof value === 'string' && Boolean(value.trim())
  )
  const summary = pieces.join(' — ').replace(/\s+/g, ' ').trim()
  return (summary || 'Unlabelled native control').slice(0, 300)
}

function looksLikeSecureField(target: ObservedTarget): boolean {
  if (target.secure) return true
  const words = [
    ...normalizedAxWords(target.role),
    ...normalizedAxWords(target.tag),
    ...normalizedAxWords(target.name)
  ]
  return (
    words.includes('securetextfield') ||
    (words.includes('secure') && words.includes('text') && words.includes('field')) ||
    words.includes('password')
  )
}

/**
 * Native window driver with an observe → one action → observe transaction.
 *
 * The bridge performs native target freshness, secure-field, recent-human-input,
 * and AX ownership checks. This adapter adds the main-owned authority checks and
 * prevents a second action until a matching post-action observation arrives.
 */
export class CanvasWindowDriver implements CanvasDriver {
  readonly kind = 'window' as const

  private readonly lease: CanvasWindowLeaseIdentity
  private readonly authority: CanvasWindowLeaseAuthority
  private readonly bridge: CanvasWindowNativeBridge
  private readonly clickAuthorization?: CanvasWindowClickAuthorization
  private readonly syntheticUrl: string
  private state: DriverState = 'new'
  private title = ''
  private adopted = false
  private currentObservation: CurrentObservation | null = null
  private pendingAction: PendingAction | null = null
  private readonly terminalSecureRefs = new Set<string>()
  private operationTail: Promise<void> = Promise.resolve()
  private closePromise: Promise<void> | null = null

  constructor(deps: CanvasWindowDriverDeps) {
    this.lease = canonicalLease(deps.lease)
    this.authority = deps.authority
    this.bridge = deps.bridge
    this.clickAuthorization = deps.clickAuthorization
    const digest = createHash('sha256')
      .update(
        [
          this.lease.chatId,
          this.lease.runId,
          this.lease.attemptId,
          String(this.lease.pid),
          String(this.lease.windowId),
          this.lease.processStartedAt,
          this.lease.instanceEpoch,
          this.lease.consentEpoch,
          String(this.lease.generation)
        ].join('\u0000')
      )
      .digest('hex')
      .slice(0, 20)
    this.syntheticUrl = `window://managed/${digest}`
  }

  async open(input: CanvasOpenInput): Promise<CanvasSessionHandle> {
    if (this.state !== 'new') throw new Error('Native window driver is single-use.')
    if (input.driver !== 'window') {
      throw new Error('Native window open requires the main-owned window driver route.')
    }
    this.state = 'opening'
    try {
      await this.assertLeaseCurrent()
      // The native call is an acquisition uncertainty boundary: even if its
      // response is lost, release the exact lease before abandoning this driver.
      this.adopted = true
      const adopted = await this.bridge.adopt({ lease: this.lease })
      assertLeaseEcho(this.lease, adopted)
      if (adopted.pid !== this.lease.pid) {
        throw new CanvasWindowLeaseError('Native bridge adopted a different process.')
      }
      if (typeof adopted.title !== 'string') {
        throw new Error('nativeWindow.adopt.title must be a string.')
      }
      const title = adopted.title || 'Managed native window'
      const viewport = requireViewport(adopted.viewport, 'nativeWindow.adopt.viewport')
      await this.assertLeaseCurrent()
      this.title = title
      this.state = 'open'
      return { url: this.syntheticUrl, title, viewport }
    } catch (error) {
      this.state = this.adopted ? 'closing' : 'closed'
      if (this.adopted) {
        try {
          await this.releaseAdoption()
          this.state = 'closed'
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Native window adoption failed and its capability could not be released.'
          )
        }
      }
      throw error
    }
  }

  async observe(): Promise<CanvasWindowElementTree> {
    return this.enqueue(async () => {
      if (this.pendingAction?.actionId === null) {
        throw new Error(
          'The preceding native action could not be correlated; close and re-adopt the window.'
        )
      }
      await this.assertLeaseCurrent()
      const response = await this.bridge.observe({ lease: this.lease })
      assertLeaseEcho(this.lease, response)
      const observationId = requireNonEmptyString(
        response.observationId,
        'nativeWindow.observe.observationId'
      )
      const inputEpoch = requireNonNegativeInteger(
        response.inputEpoch,
        'nativeWindow.observe.inputEpoch'
      )
      if (response.tree.inputEpoch !== undefined && response.tree.inputEpoch !== inputEpoch) {
        throw new Error('Native observation returned conflicting input epochs.')
      }

      let lastActionVerification: CanvasWindowActionVerification | undefined
      if (this.pendingAction) {
        const verification = response.actionVerification
        if (!verification || verification.actionId !== this.pendingAction.actionId) {
          throw new Error('Native observation did not verify the immediately preceding action.')
        }
        if (
          verification.verified !== 'changed' &&
          verification.verified !== 'unchanged' &&
          verification.verified !== 'unknown'
        ) {
          throw new Error('Native observation returned an invalid action verification.')
        }
        lastActionVerification = {
          actionId: verification.actionId,
          verified: verification.verified
        }
      } else if (response.actionVerification) {
        throw new Error('Native observation returned an unexpected action verification.')
      }

      const tree = this.validateObservationTree(
        response.tree,
        observationId,
        inputEpoch,
        lastActionVerification
      )
      const targets = indexObservedTargets(tree.root)
      if (targets.size !== tree.nodeCount) {
        throw new Error('Native observation nodeCount does not match its AX tree.')
      }
      await this.assertLeaseCurrent()
      this.currentObservation = { observationId, inputEpoch, targets }
      if (lastActionVerification) this.pendingAction = null
      this.title = tree.title
      return tree
    })
  }

  snapshot(): Promise<CanvasWindowElementTree> {
    return this.observe()
  }

  async inspect(args: CanvasWindowInspectInput): Promise<CanvasElementDetail> {
    return this.enqueue(async () => {
      const observation = this.requireObservation(args.expectedObservationId)
      const ref = requireNonEmptyString(args.ref, 'canvas_inspect.ref')
      if (args.selector || (args.styles && args.styles.length > 0)) {
        throw new Error('Native window inspection supports AX refs only.')
      }
      await this.assertLeaseCurrent()
      const response = await this.bridge.inspect({
        lease: this.lease,
        observationId: observation.observationId,
        inputEpoch: observation.inputEpoch,
        ref
      })
      assertLeaseEcho(this.lease, response)
      if (response.observationId !== observation.observationId) {
        throw new Error('Native bridge inspected a different observation.')
      }
      if (!response.detail || typeof response.detail.found !== 'boolean') {
        throw new Error('Native bridge returned an invalid inspection result.')
      }
      await this.assertLeaseCurrent()
      return {
        ...response.detail,
        ref,
        selector: undefined
      }
    })
  }

  click(action: CanvasWindowActionInput): Promise<CanvasWindowActionResult> {
    return this.performAction({ ...action, kind: 'click' })
  }

  fill(action: CanvasWindowActionInput): Promise<CanvasWindowActionResult> {
    return this.performAction({ ...action, kind: 'fill' })
  }

  act(action: CanvasActionInput): Promise<CanvasActResult> {
    const result =
      action.kind === 'fill'
        ? this.fill(action as CanvasWindowActionInput)
        : this.click(action as CanvasWindowActionInput)
    // CanvasWindowActionResult is wider only by the Tier-4 confirmation
    // refusal. Integration must add that literal to CanvasActRefusalReason;
    // this isolated adapter intentionally does not edit the shared type.
    return result as Promise<CanvasActResult>
  }

  private async performAction(action: CanvasWindowActionInput): Promise<CanvasWindowActionResult> {
    return this.enqueue(async () => {
      if (this.pendingAction) {
        if (this.pendingAction.actionId === null) {
          throw new Error(
            'The preceding native action could not be correlated; close and re-adopt the window.'
          )
        }
        throw new Error('Re-observe the native window before performing another action.')
      }
      const observation = this.requireObservation(action.expectedObservationId)
      const ref = requireNonEmptyString(action.ref, `canvas_${action.kind}.ref`)
      if (action.selector || action.x !== undefined || action.y !== undefined) {
        throw new Error(
          'Native window actions are AX-ref-only; selectors and pixel coordinates are refused.'
        )
      }
      if (
        !Number.isSafeInteger(action.expectedInputEpoch) ||
        action.expectedInputEpoch !== observation.inputEpoch
      ) {
        throw new Error(
          'Native window actions require the exact inputEpoch from the targeted observation.'
        )
      }
      if (action.kind === 'fill' && typeof action.value !== 'string') {
        throw new Error('canvas_fill requires a string value.')
      }

      await this.assertLeaseCurrent()
      const target = observation.targets.get(ref)
      if (!target) {
        return this.localRefusal(
          action.kind,
          ref,
          'not_found',
          'AX ref is absent from the current observation.'
        )
      }
      if (this.terminalSecureRefs.has(ref) || looksLikeSecureField(target)) {
        this.terminalSecureRefs.add(ref)
        return this.localRefusal(
          action.kind,
          ref,
          'secret_field',
          'Secure fields are human-only. Do not retry or work around this refusal.'
        )
      }
      if (action.kind === 'fill' && !isStandardNonSecureFillTarget(target)) {
        return this.localRefusal(
          action.kind,
          ref,
          'not_fillable',
          'Native fill is limited to structurally known, non-secure standard text fields.'
        )
      }
      let clickReceipt: string | null = null
      if (action.kind === 'click') {
        clickReceipt = await this.requestClickAuthorization(observation, target, ref)
        if (!clickReceipt) {
          return this.localRefusal(
            action.kind,
            ref,
            'consequential_confirmation_required',
            'Native clicks require a one-use, content-bound user confirmation for this exact observed target. Nothing was dispatched.'
          )
        }
        // Confirmation may have waited for the human. Revalidate main-owned
        // authority immediately before the native dispatch boundary.
        await this.assertLeaseCurrent()
      }
      // Crossing the native call is the dispatch uncertainty boundary. From this
      // point onward no second action is admissible until a correlatable action id
      // has been observed and verified. A transport/protocol failure therefore
      // requires close + re-adopt rather than a blind retry.
      this.currentObservation = null
      this.pendingAction = { actionId: null }
      const request = {
        lease: this.lease,
        observationId: observation.observationId,
        inputEpoch: observation.inputEpoch,
        ref
      }
      let response: CanvasWindowActResult
      if (action.kind === 'fill') {
        try {
          response = await this.bridge.fill({ ...request, value: action.value as string })
        } catch {
          // A bridge/provider error can contain serialized request arguments.
          // Never let fill content escape through an exception or durable log.
          throw new Error(
            'Native fill dispatch failed with an indeterminate outcome; close and re-adopt the window.'
          )
        }
      } else {
        // The receipt is deliberately opaque to this driver. It is forwarded
        // only to the bound bridge, which claims it synchronously before it
        // consumes native action budget or sends the daemon RPC.
        if (!clickReceipt) {
          throw new Error('Native click confirmation was lost before dispatch.')
        }
        response = await this.bridge.click({ ...request, clickReceipt })
      }

      assertLeaseEcho(this.lease, response)
      if (response.observationId !== observation.observationId) {
        throw new Error('Native bridge acted on a different observation.')
      }
      const actionId = requireNonEmptyString(response.actionId, 'nativeWindow.action.actionId')
      const result = this.validateNativeActionResult(response.result)
      if (result.refusalReason === 'secret_field') {
        this.terminalSecureRefs.add(ref)
      }
      this.pendingAction = { actionId }
      await this.assertLeaseCurrent()

      const suffix =
        result.refusalReason === 'secret_field'
          ? 'Secure fields are human-only; this refusal is terminal. Do not retry or work around it. Re-observe the window before any other action.'
          : 'Re-observe the window before planning or performing another action.'
      const message =
        action.kind === 'fill' ? suffix : result.message ? `${result.message} ${suffix}` : suffix
      return {
        ok: result.ok,
        action: action.kind,
        ref,
        found: result.found,
        executed: result.executed,
        // Immediate native dispatch is not verification. Only the mandatory next
        // observation may report changed/unchanged for this actionId.
        verified: 'unknown',
        ...(result.refusalReason ? { refusalReason: result.refusalReason } : {}),
        message,
        url: this.syntheticUrl,
        title: this.title
      }
    })
  }

  private localRefusal(
    action: 'click' | 'fill',
    ref: string,
    refusalReason: CanvasWindowRefusalReason,
    message: string
  ): CanvasWindowActionResult {
    return {
      ok: false,
      action,
      ref,
      found: refusalReason !== 'not_found',
      executed: false,
      verified: 'unknown',
      refusalReason,
      message,
      url: this.syntheticUrl,
      title: this.title
    }
  }

  private async requestClickAuthorization(
    observation: CurrentObservation,
    target: ObservedTarget,
    ref: string
  ): Promise<string | null> {
    if (!this.clickAuthorization) return null
    const request: CanvasWindowClickAuthorizationRequest = Object.freeze({
      // This is the entire cross-UI scope. In particular, do not add PID,
      // window ID, process-start identity, attachment data, or raw AX target
      // objects here: the UI needs only an exact run/consent generation plus
      // a human-displayable, value-free target summary.
      scope: Object.freeze({
        chatId: this.lease.chatId,
        runId: this.lease.runId,
        attemptId: this.lease.attemptId,
        consentEpoch: this.lease.consentEpoch,
        generation: this.lease.generation
      }),
      observationId: observation.observationId,
      inputEpoch: observation.inputEpoch,
      ref,
      semanticSummary: semanticSummary(target),
      consequentialHint: looksConsequential(target)
    })
    try {
      // The receipt is intentionally not parsed, logged, or retained. Only
      // the factory can validate and consume it at the dispatch boundary.
      const response = await this.clickAuthorization.authorize(request)
      return typeof response?.receipt === 'string' ? response.receipt : null
    } catch {
      // The callback may represent a dismissed UI or unavailable receipt store.
      // Neither condition is a reason to try a native click without consent.
      return null
    }
  }

  private validateNativeActionResult(
    result: CanvasWindowNativeActionResult
  ): CanvasWindowNativeActionResult {
    if (
      !result ||
      typeof result.ok !== 'boolean' ||
      typeof result.found !== 'boolean' ||
      typeof result.executed !== 'boolean'
    ) {
      throw new Error('Native bridge returned an invalid action result.')
    }
    if (result.executed && result.refusalReason) {
      throw new Error('Native bridge reported both dispatch and refusal.')
    }
    if (result.refusalReason !== undefined && !REFUSAL_REASONS.has(result.refusalReason)) {
      throw new Error('Native bridge returned an unknown refusal reason.')
    }
    return {
      ...result,
      // Fail honest: `ok` can only be true if an action was actually dispatched.
      ok: result.ok === true && result.executed === true
    }
  }

  private validateCaptureFrame(frame: CanvasFrame): CanvasFrame {
    if (!frame || frame.mimeType !== 'image/png' || typeof frame.data !== 'string') {
      throw new Error('Native bridge returned an invalid PNG frame.')
    }
    if (
      frame.data.length === 0 ||
      frame.data.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)
    ) {
      throw new Error('Native bridge returned non-canonical PNG base64.')
    }
    const png = Buffer.from(frame.data, 'base64')
    if (
      png.length < 24 ||
      png.toString('hex', 0, 8) !== PNG_SIGNATURE_HEX ||
      png.toString('ascii', 12, 16) !== 'IHDR'
    ) {
      throw new Error('Native bridge returned bytes that are not a PNG.')
    }
    if (png.toString('base64') !== frame.data) {
      throw new Error('Native bridge returned non-canonical PNG base64.')
    }
    const width = requirePositiveInteger(frame.width, 'nativeWindow.capture.frame.width')
    const height = requirePositiveInteger(frame.height, 'nativeWindow.capture.frame.height')
    if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
      throw new Error('Native bridge PNG dimensions do not match frame metadata.')
    }
    const byteLength = requirePositiveInteger(
      frame.byteLength,
      'nativeWindow.capture.frame.byteLength'
    )
    if (byteLength !== png.byteLength) {
      throw new Error('Native bridge PNG byteLength does not match its base64 payload.')
    }
    if (
      typeof frame.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(frame.hash) ||
      createHash('sha256').update(png).digest('hex') !== frame.hash
    ) {
      throw new Error('Native bridge PNG hash does not match its payload.')
    }
    const capturedAt = requireCanonicalTimestamp(
      frame.capturedAt,
      'nativeWindow.capture.frame.capturedAt'
    )
    let secretsRedacted: number | undefined
    if (frame.secretsRedacted !== undefined) {
      secretsRedacted = requireNonNegativeInteger(
        frame.secretsRedacted,
        'nativeWindow.capture.frame.secretsRedacted'
      )
    }
    return {
      mimeType: 'image/png',
      data: frame.data,
      width,
      height,
      byteLength,
      hash: frame.hash,
      capturedAt,
      ...(secretsRedacted !== undefined ? { secretsRedacted } : {})
    }
  }

  private validateObservationTree(
    tree: CanvasElementTree,
    observationId: string,
    inputEpoch: number,
    lastActionVerification?: CanvasWindowActionVerification
  ): CanvasWindowElementTree {
    if (
      !tree ||
      !tree.root ||
      typeof tree.nodeCount !== 'number' ||
      typeof tree.truncated !== 'boolean' ||
      typeof tree.capturedAt !== 'string'
    ) {
      throw new Error('Native bridge returned an invalid element tree.')
    }
    const viewport = requireViewport(tree.viewport, 'nativeWindow.observe.tree.viewport')
    return {
      ...tree,
      // Never let the bridge turn its metadata into an arbitrary URL/capability.
      url: this.syntheticUrl,
      title: typeof tree.title === 'string' && tree.title ? tree.title : this.title,
      viewport,
      inputEpoch,
      observationId,
      ...(lastActionVerification ? { lastActionVerification } : {})
    }
  }

  private requireObservation(expectedObservationId: unknown): CurrentObservation {
    if (!this.currentObservation) {
      throw new Error('Observe the native window before inspecting or acting.')
    }
    if (
      typeof expectedObservationId !== 'string' ||
      expectedObservationId !== this.currentObservation.observationId
    ) {
      throw new Error('Native operation is not bound to the current observation.')
    }
    return this.currentObservation
  }

  private async assertLeaseCurrent(): Promise<void> {
    let current: CanvasWindowLeaseIdentity | null
    try {
      current = await this.authority.current()
    } catch {
      throw new CanvasWindowLeaseError('Native-window authority could not be revalidated.')
    }
    if (!sameLease(this.lease, current)) throw new CanvasWindowLeaseError()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state !== 'open') {
      return Promise.reject(new Error('Native window Canvas is not open.'))
    }
    const run = async (): Promise<T> => {
      if (this.state !== 'open') throw new Error('Native window Canvas is closing.')
      return operation()
    }
    const result = this.operationTail.then(run, run)
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  screenshot(): Promise<CanvasFrame> {
    return this.enqueue(async () => {
      await this.assertLeaseCurrent()
      const response = await this.bridge.capture({ lease: this.lease })
      assertLeaseEcho(this.lease, response)
      const frame = this.validateCaptureFrame(response.frame)
      await this.assertLeaseCurrent()
      return frame
    })
  }

  async network(): Promise<CanvasNetworkEntry[]> {
    return unsupported('network')
  }

  async console(): Promise<CanvasConsoleEntry[]> {
    return unsupported('console')
  }

  async resize(_viewport: CanvasViewport): Promise<CanvasViewport> {
    return unsupported('resize')
  }

  async annotate(_marks: CanvasMark[]): Promise<{ count: number }> {
    return unsupported('annotate')
  }

  async sketchDocument(): Promise<CanvasSketchDocument> {
    return unsupported('sketch_get')
  }

  async sketchUpdate(_update: CanvasSketchUpdateInput): Promise<CanvasSketchDocument> {
    return unsupported('sketch_update')
  }

  async evaluate(_args: { script: string }): Promise<CanvasEvalResult> {
    return unsupported('eval')
  }

  async reload(): Promise<void> {
    return unsupported('reload')
  }

  close(): Promise<void> {
    if (this.state === 'closed') return Promise.resolve()
    if (this.closePromise) return this.closePromise
    if (this.state === 'new') {
      this.state = 'closed'
      return Promise.resolve()
    }
    this.state = 'closing'
    const attempt = (async () => {
      await this.operationTail
      await this.releaseAdoption()
      this.currentObservation = null
      this.pendingAction = null
      this.terminalSecureRefs.clear()
      this.state = 'closed'
    })()
    this.closePromise = attempt
    void attempt.then(
      () => {},
      () => {
        // Keep the exact adoption identity for a later cleanup retry.
        if (this.closePromise === attempt) this.closePromise = null
      }
    )
    return attempt
  }

  private async releaseAdoption(): Promise<void> {
    if (!this.adopted) return
    const response = await this.bridge.release({ lease: this.lease })
    assertLeaseEcho(this.lease, response)
    if (response.released !== true) {
      throw new Error('Native bridge did not confirm capability release; retry close.')
    }
    this.adopted = false
  }
}
