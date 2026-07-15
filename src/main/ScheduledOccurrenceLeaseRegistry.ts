const DEFAULT_MAX_ENTRIES = 4_096
const DEFAULT_TOMBSTONE_TTL_MS = 60 * 60 * 1000

declare const scheduledOccurrenceLeaseBrand: unique symbol

/** Opaque process-local capability. Authority data lives only in the registry. */
export interface ScheduledOccurrenceLease {
  readonly [scheduledOccurrenceLeaseBrand]: never
}

export type ScheduledOccurrenceRootOwner = 'solo' | 'loop-root' | 'ensemble-root'
export type ScheduledOccurrenceChildOwner =
  | Readonly<{ kind: 'loop-step'; stepId: string }>
  | Readonly<{
      kind: 'ensemble-seat'
      roundId: string
      participantId: string
      laneId?: string
    }>

interface RuntimeBinding {
  readonly provider: string | null
  readonly runtimeProfileId: string | null
  readonly dispatchAuthorityDigest: string
}

export interface ScheduledOccurrenceRootOwnershipInput {
  taskId: string
  rootRunId: string
  sealSignature: string
  owner: ScheduledOccurrenceRootOwner
}

export interface ScheduledOccurrenceChildOwnershipInput {
  owner: ScheduledOccurrenceChildOwner
}

export interface ScheduledOccurrenceFinalBindingInput {
  appRunId: string
  provider: string | null
  runtimeProfileId: string | null
  dispatchAuthorityDigest: string
}

export interface ScheduledOccurrenceAdapterAdmissionInput {
  taskId: string
  appRunId: string
}

type ScheduledOccurrenceFinalBindingSnapshot = Readonly<ScheduledOccurrenceFinalBindingInput>
type ScheduledOccurrenceAdapterAdmissionSnapshot =
  Readonly<ScheduledOccurrenceAdapterAdmissionInput>

export interface ScheduledOccurrenceRootBinding extends RuntimeBinding {
  readonly kind: 'root'
  readonly taskId: string
  readonly rootRunId: string
  readonly appRunId: string
  readonly sealSignature: string
  readonly owner: ScheduledOccurrenceRootOwner
}

export interface ScheduledOccurrenceChildBinding extends RuntimeBinding {
  readonly kind: 'child'
  readonly taskId: string
  readonly rootRunId: string
  readonly rootAppRunId: string
  readonly appRunId: string
  readonly sealSignature: string
  readonly owner: ScheduledOccurrenceChildOwner
}

export type ScheduledOccurrenceBinding =
  | ScheduledOccurrenceRootBinding
  | ScheduledOccurrenceChildBinding
export type ScheduledOccurrenceLeaseState =
  | 'reserved'
  | 'started'
  | 'terminal'
  | 'aborted'
  | 'revoked'

export interface ScheduledOccurrenceLeasePayload {
  appRunId: string
  provider: string | null
  runtimeProfileId: string | null
  /** Null is reserved for ordinary, lease-free runs. */
  dispatchAuthorityDigest: string | null
}

export type ScheduledOccurrenceLeasePayloadSnapshot = Readonly<ScheduledOccurrenceLeasePayload>

export interface ScheduledOccurrenceLeaseEntry {
  readonly binding: ScheduledOccurrenceBinding
  readonly rootBinding: ScheduledOccurrenceRootBinding
  readonly state: ScheduledOccurrenceLeaseState
}

export type ScheduledOccurrenceLiveValidator = (
  entry: ScheduledOccurrenceLeaseEntry,
  payload: ScheduledOccurrenceLeasePayloadSnapshot
) => true

export interface ScheduledOccurrenceLeaseRegistryOptions {
  validateLive: ScheduledOccurrenceLiveValidator
  now?: () => number
  maxEntries?: number
  tombstoneTtlMs?: number
}

export type ScheduledOccurrenceLeaseErrorCode =
  | 'adapter-entry-replay'
  | 'async-live-validator'
  | 'capacity-exhausted'
  | 'duplicate-run-id'
  | 'invalid-input'
  | 'invalid-lease-kind'
  | 'invalid-transition'
  | 'lease-mismatch'
  | 'lease-not-bound'
  | 'lease-not-live'
  | 'lease-not-reserved'
  | 'lease-required'
  | 'live-children'
  | 'live-validation-failed'
  | 'owner-mismatch'
  | 'payload-mismatch'
  | 'reentrant-validation'
  | 'root-not-started'
  | 'unknown-lease'

export class ScheduledOccurrenceLeaseError extends Error {
  constructor(
    readonly code: ScheduledOccurrenceLeaseErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ScheduledOccurrenceLeaseError'
  }
}

export type ScheduledOccurrenceStartResult = Readonly<{
  kind: 'ordinary' | 'scheduled'
  payload: ScheduledOccurrenceLeasePayloadSnapshot
}>

type TombstoneState = Extract<ScheduledOccurrenceLeaseState, 'terminal' | 'aborted' | 'revoked'>

interface Entry {
  readonly lease: ScheduledOccurrenceLease
  readonly ownership: ScheduledOccurrenceOwnership
  adapterAdmission?: ScheduledOccurrenceAdapterAdmissionSnapshot
  binding?: ScheduledOccurrenceBinding
  readonly runIds: Set<string>
  readonly children: Set<Entry>
  root?: Entry
  state: ScheduledOccurrenceLeaseState
  terminalAt?: number
}

interface ScheduledOccurrenceRootOwnership extends ScheduledOccurrenceRootOwnershipInput {
  readonly kind: 'root'
}

interface ScheduledOccurrenceChildOwnership {
  readonly kind: 'child'
  readonly taskId: string
  readonly rootRunId: string
  readonly rootAppRunId: string
  readonly sealSignature: string
  readonly owner: ScheduledOccurrenceChildOwner
}

type ScheduledOccurrenceOwnership =
  | ScheduledOccurrenceRootOwnership
  | ScheduledOccurrenceChildOwnership

/**
 * Bounded process-local state machine for one-shot scheduled dispatches.
 * Unexpired tombstones are never evicted to make room: capacity fails closed.
 */
export class ScheduledOccurrenceLeaseRegistry {
  private readonly validateCallback: ScheduledOccurrenceLiveValidator
  private readonly now: () => number
  private readonly maxEntries: number
  private readonly tombstoneTtlMs: number
  private readonly entries = new Set<Entry>()
  private readonly byRunId = new Map<string, Entry>()
  private readonly byLease = new WeakMap<object, Entry>()
  private validationActive = false
  private operationActive = false

  constructor(options: ScheduledOccurrenceLeaseRegistryOptions) {
    if (!options || typeof options.validateLive !== 'function') {
      fail('invalid-input', 'A synchronous live validator is required.')
    }
    this.validateCallback = options.validateLive
    this.now = options.now ?? Date.now
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 'maxEntries')
    this.tombstoneTtlMs = positiveInteger(
      options.tombstoneTtlMs,
      DEFAULT_TOMBSTONE_TTL_MS,
      'tombstoneTtlMs'
    )
  }

  reserveRoot(input: {
    taskId: string
    rootRunId: string
    appRunId: string
    sealSignature: string
    owner: ScheduledOccurrenceRootOwner
    provider: string | null
    runtimeProfileId: string | null
    dispatchAuthorityDigest: string
  }): ScheduledOccurrenceLease {
    return this.withOperation(true, () => {
      const ownership = rootOwnershipSnapshot(input)
      const finalBinding = finalBindingSnapshot(input)
      this.assertRunIdsAvailable([...new Set([ownership.rootRunId, finalBinding.appRunId])])
      const entry = this.register(ownership, [ownership.rootRunId])
      this.bind(entry, finalBinding)
      return entry.lease
    })
  }

  /**
   * Reserves the durable/root ownership identity before asynchronous runtime preflight.
   * Runtime authority is intentionally absent until bindAndStart executes.
   */
  reserveRootOwnership(input: ScheduledOccurrenceRootOwnershipInput): ScheduledOccurrenceLease {
    return this.withOperation(true, () => {
      const ownership = rootOwnershipSnapshot(input)
      this.assertRunIdsAvailable([ownership.rootRunId])
      return this.register(ownership, [ownership.rootRunId]).lease
    })
  }

  reserveChildOwnership(
    rootLease: ScheduledOccurrenceLease,
    input: ScheduledOccurrenceChildOwnershipInput
  ): ScheduledOccurrenceLease {
    return this.withOperation(true, () => {
      const root = this.known(rootLease)
      if (root.ownership.kind !== 'root') fail('invalid-lease-kind', 'A root lease is required.')
      if (root.state !== 'started') fail('root-not-started', 'The root must be started first.')
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail('invalid-input', 'Child ownership must be an object.')
      }

      const owner = childOwner(input.owner)
      assertCompatibleOwner(root.ownership.owner, owner)
      const ownership = childOwnershipSnapshot(root, owner)
      const child = this.register(ownership, [], root)
      root.children.add(child)
      return child.lease
    })
  }

  /**
   * Consumes adapter admission exactly once for a main-issued reserved lease.
   * This registers the prospective app run id without fixing any provider/runtime
   * authority; bindAndStart must later present this same app run id.
   */
  admitAdapterEntry(
    lease: ScheduledOccurrenceLease,
    input: ScheduledOccurrenceAdapterAdmissionInput
  ): true {
    return this.withOperation(false, () => {
      const snapshot = adapterAdmissionSnapshot(input)
      const entry = this.known(lease)
      if (entry.state !== 'reserved') fail('lease-not-reserved', 'Lease is not reserved.')
      this.assertRootStartedWhenChild(entry)
      if (entry.adapterAdmission) {
        fail('adapter-entry-replay', 'Lease adapter admission is already consumed.')
      }
      if (snapshot.taskId !== entry.ownership.taskId) {
        fail('lease-mismatch', 'Adapter task does not match lease ownership.')
      }
      if (entry.binding && snapshot.appRunId !== entry.binding.appRunId) {
        fail('lease-mismatch', 'Adapter run does not match the bound lease.')
      }
      this.assertRunIdAvailableFor(entry, snapshot.appRunId)

      entry.adapterAdmission = snapshot
      entry.runIds.add(snapshot.appRunId)
      this.byRunId.set(snapshot.appRunId, entry)
      return true
    })
  }

  /**
   * Atomically fixes the final runtime/run authority and starts a reserved owner.
   * Once fixed, a failed live validation may be retried only with the exact same binding.
   */
  bindAndStart(
    lease: ScheduledOccurrenceLease,
    input: ScheduledOccurrenceFinalBindingInput
  ): ScheduledOccurrenceStartResult {
    return this.withOperation(false, () => {
      const snapshot = finalBindingSnapshot(input)
      return this.startScheduled(this.known(lease), snapshot)
    })
  }

  reserveChild(
    rootLease: ScheduledOccurrenceLease,
    input: {
      appRunId: string
      owner: ScheduledOccurrenceChildOwner
      provider: string | null
      runtimeProfileId: string | null
      dispatchAuthorityDigest: string
    }
  ): ScheduledOccurrenceLease {
    return this.withOperation(true, () => {
      const root = this.known(rootLease)
      if (root.ownership.kind !== 'root') fail('invalid-lease-kind', 'A root lease is required.')
      if (root.state !== 'started') fail('root-not-started', 'The root must be started first.')

      const owner = childOwner(input.owner)
      assertCompatibleOwner(root.ownership.owner, owner)
      const ownership = childOwnershipSnapshot(root, owner)
      const finalBinding = finalBindingSnapshot(input)
      this.assertRunIdsAvailable([finalBinding.appRunId])
      const child = this.register(ownership, [], root)
      this.bind(child, finalBinding)
      root.children.add(child)
      return child.lease
    })
  }

  validateLive(
    lease: ScheduledOccurrenceLease,
    payload: ScheduledOccurrenceLeasePayload
  ): ScheduledOccurrenceLeasePayloadSnapshot {
    return this.withOperation(false, () => {
      const snapshot = snapshotPayload(payload)
      const entry = this.known(lease)
      this.assertLive(entry)
      this.assertPayload(entry, snapshot)
      this.validate(entry, snapshot)
      return snapshot
    })
  }

  assertAndStart(
    lease: ScheduledOccurrenceLease | undefined,
    payload: ScheduledOccurrenceLeasePayload
  ): ScheduledOccurrenceStartResult {
    return this.withOperation(false, () => {
      const snapshot = snapshotPayload(payload)
      if (!lease) return this.startOrdinary(snapshot)
      return this.startScheduled(this.known(lease), scheduledPayload(snapshot))
    })
  }

  abortReserved(lease: ScheduledOccurrenceLease): boolean {
    return this.withOperation(false, () => {
      const entry = this.known(lease)
      if (isTerminal(entry.state)) return false
      if (entry.state !== 'reserved') fail('invalid-transition', 'Lease is not reserved.')
      this.end(entry, 'aborted')
      return true
    })
  }

  markTerminal(lease: ScheduledOccurrenceLease): boolean {
    return this.withOperation(false, () => {
      const entry = this.known(lease)
      if (isTerminal(entry.state)) return false
      if (entry.state !== 'started') fail('invalid-transition', 'Lease is not started.')
      if (entry.ownership.kind === 'root' && hasLiveChildren(entry)) {
        fail('live-children', 'Root still has live children.')
      }
      this.end(entry, 'terminal')
      return true
    })
  }

  revokeRoot(lease: ScheduledOccurrenceLease): boolean {
    return this.withOperation(false, () => {
      const root = this.known(lease)
      if (root.ownership.kind !== 'root') fail('invalid-lease-kind', 'A root lease is required.')
      if (isTerminal(root.state)) return false
      for (const child of root.children) {
        if (isLive(child.state)) this.end(child, 'revoked')
      }
      this.end(root, 'revoked')
      return true
    })
  }

  taskIdForRun(runId: string): string | undefined {
    return this.withOperation(false, () =>
      typeof runId === 'string' && runId.trim()
        ? this.byRunId.get(runId)?.ownership.taskId
        : undefined
    )
  }

  private startScheduled(
    entry: Entry,
    snapshot: ScheduledOccurrenceFinalBindingSnapshot
  ): ScheduledOccurrenceStartResult {
    if (entry.state !== 'reserved') fail('lease-not-reserved', 'Lease is not reserved.')
    this.assertRootStartedWhenChild(entry)
    if (entry.adapterAdmission && snapshot.appRunId !== entry.adapterAdmission.appRunId) {
      fail('lease-mismatch', 'Final run does not match adapter admission.')
    }

    if (entry.binding) {
      const registered = this.byRunId.get(snapshot.appRunId)
      if (!registered || registered !== entry) fail('lease-mismatch', 'Lease and run do not match.')
      this.assertPayload(entry, snapshot)
    } else {
      this.bind(entry, snapshot)
    }

    this.validate(entry, snapshot)
    entry.state = 'started'
    return frozenResult('scheduled', snapshot)
  }

  private startOrdinary(
    snapshot: ScheduledOccurrenceLeasePayloadSnapshot
  ): ScheduledOccurrenceStartResult {
    if (this.byRunId.has(snapshot.appRunId)) {
      fail('lease-required', 'A registered scheduled run requires its lease.')
    }
    if (snapshot.dispatchAuthorityDigest !== null) {
      fail('payload-mismatch', 'Ordinary runs cannot carry scheduled authority.')
    }
    return frozenResult('ordinary', snapshot)
  }

  private register(
    ownership: ScheduledOccurrenceOwnership,
    runIds: readonly string[],
    root?: Entry
  ): Entry {
    const lease = opaqueLease()
    const entry: Entry = {
      lease,
      ownership,
      runIds: new Set(runIds),
      children: new Set(),
      root,
      state: 'reserved'
    }
    this.entries.add(entry)
    this.byLease.set(lease as object, entry)
    for (const runId of runIds) this.byRunId.set(runId, entry)
    return entry
  }

  private bind(entry: Entry, snapshot: ScheduledOccurrenceFinalBindingSnapshot): void {
    if (entry.binding) {
      this.assertPayload(entry, snapshot)
      return
    }
    this.assertRunIdAvailableFor(entry, snapshot.appRunId)
    entry.binding = bindingSnapshot(entry.ownership, snapshot)
    entry.runIds.add(snapshot.appRunId)
    this.byRunId.set(snapshot.appRunId, entry)
  }

  private validate(entry: Entry, payload: ScheduledOccurrenceLeasePayloadSnapshot): void {
    const binding = this.bound(entry)
    const rootBinding = this.bound(rootOf(entry))
    if (rootBinding.kind !== 'root') fail('invalid-lease-kind', 'Root binding is invalid.')
    this.validationActive = true
    try {
      const result = this.validateCallback(
        Object.freeze({
          binding,
          rootBinding,
          state: entry.state
        }),
        payload
      )
      if (isThenable(result)) fail('async-live-validator', 'Live validation must be synchronous.')
      if (result !== true) fail('live-validation-failed', 'Live validation did not return true.')
    } finally {
      this.validationActive = false
    }
  }

  private assertPayload(entry: Entry, payload: ScheduledOccurrenceLeasePayloadSnapshot): void {
    const binding = this.bound(entry)
    if (
      payload.appRunId !== binding.appRunId ||
      payload.provider !== binding.provider ||
      payload.runtimeProfileId !== binding.runtimeProfileId ||
      payload.dispatchAuthorityDigest !== binding.dispatchAuthorityDigest
    ) {
      fail('payload-mismatch', 'Payload authority does not match its lease.')
    }
  }

  private assertLive(entry: Entry): void {
    if (!isLive(entry.state)) fail('lease-not-live', 'Lease is not live.')
    this.assertRootStartedWhenChild(entry)
  }

  private assertRootStartedWhenChild(entry: Entry): void {
    if (entry.ownership.kind === 'child' && rootOf(entry).state !== 'started') {
      fail('lease-not-live', 'Child root is not started.')
    }
  }

  private known(lease: ScheduledOccurrenceLease): Entry {
    if ((!lease || typeof lease !== 'object') && typeof lease !== 'function') {
      fail('unknown-lease', 'Unknown lease.')
    }
    const entry = this.byLease.get(lease as object)
    if (!entry) fail('unknown-lease', 'Unknown lease.')
    return entry
  }

  private assertRunIdsAvailable(runIds: readonly string[]): void {
    for (const runId of runIds) {
      if (this.byRunId.has(runId)) fail('duplicate-run-id', `Run id already registered: ${runId}`)
    }
  }

  private assertRunIdAvailableFor(entry: Entry, runId: string): void {
    const registered = this.byRunId.get(runId)
    if (registered && registered !== entry) {
      fail('duplicate-run-id', `Run id already registered: ${runId}`)
    }
  }

  private bound(entry: Entry): ScheduledOccurrenceBinding {
    if (!entry.binding) fail('lease-not-bound', 'Lease runtime authority is not bound.')
    return entry.binding
  }

  private withOperation<T>(reserving: boolean, operation: () => T): T {
    if (this.validationActive || this.operationActive) {
      fail('reentrant-validation', 'Lease operations cannot re-enter the registry.')
    }
    this.operationActive = true
    try {
      this.prune()
      if (reserving && this.entries.size >= this.maxEntries) {
        fail('capacity-exhausted', 'Lease capacity is exhausted by live or recent entries.')
      }
      return operation()
    } finally {
      this.operationActive = false
    }
  }

  private end(entry: Entry, state: TombstoneState): void {
    entry.state = state
    entry.terminalAt = this.now()
  }

  private prune(): void {
    const now = this.now()
    for (const entry of this.entries) {
      if (entry.terminalAt === undefined || entry.terminalAt + this.tombstoneTtlMs > now) continue
      this.entries.delete(entry)
      for (const runId of entry.runIds) {
        if (this.byRunId.get(runId) === entry) this.byRunId.delete(runId)
      }
      entry.root?.children.delete(entry)
    }
  }
}

function adapterAdmissionSnapshot(
  input: ScheduledOccurrenceAdapterAdmissionInput
): ScheduledOccurrenceAdapterAdmissionSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid-input', 'Adapter admission must be an object.')
  }
  // Exactly one read per caller-owned scalar; this copy is the one-shot admission record.
  const taskId = input.taskId
  const appRunId = input.appRunId
  return Object.freeze({
    taskId: exactNonEmpty(taskId, 'admission.taskId'),
    appRunId: exactNonEmpty(appRunId, 'admission.appRunId')
  })
}

function snapshotPayload(
  payload: ScheduledOccurrenceLeasePayload
): ScheduledOccurrenceLeasePayloadSnapshot {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('invalid-input', 'Payload must be an object.')
  }
  // Exactly one read per caller-owned scalar; only this frozen copy proceeds.
  const appRunId = payload.appRunId
  const provider = payload.provider
  const runtimeProfileId = payload.runtimeProfileId
  const dispatchAuthorityDigest = payload.dispatchAuthorityDigest
  return Object.freeze({
    appRunId: nonEmpty(appRunId, 'payload.appRunId'),
    provider: nullableString(provider, 'payload.provider'),
    runtimeProfileId: nullableString(runtimeProfileId, 'payload.runtimeProfileId'),
    dispatchAuthorityDigest: nullableString(
      dispatchAuthorityDigest,
      'payload.dispatchAuthorityDigest'
    )
  })
}

function finalBindingSnapshot(
  input: ScheduledOccurrenceFinalBindingInput
): ScheduledOccurrenceFinalBindingSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid-input', 'Final binding must be an object.')
  }
  // Exactly one read per caller-owned scalar; this copy becomes the immutable binding.
  const appRunId = input.appRunId
  const provider = input.provider
  const runtimeProfileId = input.runtimeProfileId
  const dispatchAuthorityDigest = input.dispatchAuthorityDigest
  return Object.freeze({
    appRunId: nonEmpty(appRunId, 'binding.appRunId'),
    provider: nullableString(provider, 'binding.provider'),
    runtimeProfileId: nullableString(runtimeProfileId, 'binding.runtimeProfileId'),
    dispatchAuthorityDigest: nonEmpty(dispatchAuthorityDigest, 'binding.dispatchAuthorityDigest')
  })
}

function scheduledPayload(
  payload: ScheduledOccurrenceLeasePayloadSnapshot
): ScheduledOccurrenceFinalBindingSnapshot {
  if (payload.dispatchAuthorityDigest === null) {
    fail('payload-mismatch', 'A scheduled lease requires dispatch authority.')
  }
  return payload as ScheduledOccurrenceFinalBindingSnapshot
}

function rootOwnershipSnapshot(
  input: ScheduledOccurrenceRootOwnershipInput
): ScheduledOccurrenceRootOwnership {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid-input', 'Root ownership must be an object.')
  }
  const taskId = input.taskId
  const rootRunId = input.rootRunId
  const sealSignature = input.sealSignature
  const owner = input.owner
  return Object.freeze({
    kind: 'root',
    taskId: nonEmpty(taskId, 'taskId'),
    rootRunId: nonEmpty(rootRunId, 'rootRunId'),
    sealSignature: nonEmpty(sealSignature, 'sealSignature'),
    owner: rootOwner(owner)
  })
}

function childOwnershipSnapshot(
  root: Entry,
  owner: ScheduledOccurrenceChildOwner
): ScheduledOccurrenceChildOwnership {
  const rootBinding = root.binding
  if (!rootBinding || rootBinding.kind !== 'root') {
    fail('lease-not-bound', 'Root runtime authority is not bound.')
  }
  return Object.freeze({
    kind: 'child',
    taskId: rootBinding.taskId,
    rootRunId: rootBinding.rootRunId,
    rootAppRunId: rootBinding.appRunId,
    sealSignature: rootBinding.sealSignature,
    owner
  })
}

function bindingSnapshot(
  ownership: ScheduledOccurrenceOwnership,
  runtime: ScheduledOccurrenceFinalBindingSnapshot
): ScheduledOccurrenceBinding {
  if (ownership.kind === 'root') {
    return Object.freeze({
      kind: 'root',
      taskId: ownership.taskId,
      rootRunId: ownership.rootRunId,
      appRunId: runtime.appRunId,
      sealSignature: ownership.sealSignature,
      owner: ownership.owner,
      provider: runtime.provider,
      runtimeProfileId: runtime.runtimeProfileId,
      dispatchAuthorityDigest: runtime.dispatchAuthorityDigest
    })
  }
  return Object.freeze({
    kind: 'child',
    taskId: ownership.taskId,
    rootRunId: ownership.rootRunId,
    rootAppRunId: ownership.rootAppRunId,
    appRunId: runtime.appRunId,
    sealSignature: ownership.sealSignature,
    owner: ownership.owner,
    provider: runtime.provider,
    runtimeProfileId: runtime.runtimeProfileId,
    dispatchAuthorityDigest: runtime.dispatchAuthorityDigest
  })
}

function childOwner(owner: ScheduledOccurrenceChildOwner): ScheduledOccurrenceChildOwner {
  if (!owner || typeof owner !== 'object') fail('invalid-input', 'Invalid child owner.')
  if (owner.kind === 'loop-step') {
    return Object.freeze({ kind: owner.kind, stepId: nonEmpty(owner.stepId, 'owner.stepId') })
  }
  if (owner.kind === 'ensemble-seat') {
    const laneId = owner.laneId === undefined ? undefined : nonEmpty(owner.laneId, 'owner.laneId')
    return Object.freeze({
      kind: owner.kind,
      roundId: nonEmpty(owner.roundId, 'owner.roundId'),
      participantId: nonEmpty(owner.participantId, 'owner.participantId'),
      ...(laneId ? { laneId } : {})
    })
  }
  fail('invalid-input', 'Invalid child owner.')
}

function assertCompatibleOwner(
  root: ScheduledOccurrenceRootOwner,
  child: ScheduledOccurrenceChildOwner
): void {
  if (
    !(
      (root === 'loop-root' && child.kind === 'loop-step') ||
      (root === 'ensemble-root' && child.kind === 'ensemble-seat')
    )
  ) {
    fail('owner-mismatch', `${root} cannot reserve ${child.kind}.`)
  }
}

function rootOwner(value: unknown): ScheduledOccurrenceRootOwner {
  if (value === 'solo' || value === 'loop-root' || value === 'ensemble-root') return value
  fail('invalid-input', 'Invalid root owner.')
}

function rootOf(entry: Entry): Entry {
  return entry.root ?? entry
}

function hasLiveChildren(entry: Entry): boolean {
  for (const child of entry.children) if (isLive(child.state)) return true
  return false
}

function isLive(state: ScheduledOccurrenceLeaseState): boolean {
  return state === 'reserved' || state === 'started'
}

function isTerminal(state: ScheduledOccurrenceLeaseState): boolean {
  return state === 'terminal' || state === 'aborted' || state === 'revoked'
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail('invalid-input', `${label} is required.`)
  return value
}

function exactNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    fail('invalid-input', `${label} must be an exact non-empty string.`)
  }
  return value
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : nonEmpty(value, label)
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) fail('invalid-input', `${label} is invalid.`)
  return result
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function opaqueLease(): ScheduledOccurrenceLease {
  const lease = Object.create(null) as Record<string, unknown>
  Object.defineProperty(lease, 'toJSON', {
    enumerable: true,
    value: () => {
      throw new TypeError('Scheduled occurrence leases cannot be serialized.')
    }
  })
  return Object.freeze(lease) as unknown as ScheduledOccurrenceLease
}

function frozenResult(
  kind: ScheduledOccurrenceStartResult['kind'],
  payload: ScheduledOccurrenceLeasePayloadSnapshot
): ScheduledOccurrenceStartResult {
  return Object.freeze({ kind, payload })
}

function fail(code: ScheduledOccurrenceLeaseErrorCode, message: string): never {
  throw new ScheduledOccurrenceLeaseError(code, message)
}
