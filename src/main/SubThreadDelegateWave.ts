/*
 * SubThreadDelegateWave — pure helpers for the `delegate_wave` MCP tool.
 *
 * Spawn-only batch delegation: validate workers, allocate a wave id, and bind
 * one shared join policy whose groupId is ALWAYS that wave id (never the
 * parent appRunId, never a caller-supplied groupId). Execution / approval /
 * catalog wiring live elsewhere; this module stays free of AppStore and IPC.
 */

import type { PermissionPresetId, ProviderId, SubThreadJoinPolicy } from './store/types'
import { resolveSubThreadJoinPolicy, type SubThreadJoinPolicyRequest } from './SubThreadJoinPolicy'
import {
  normalizeFleetLifecycle,
  parseFleetWaveRole,
  type FleetWaveLifecycle,
  type FleetWaveRole
} from './SubThreadEphemeralFleet'

export const DELEGATE_WAVE_MIN_WORKERS = 2
/** Ephemeral fleets may be a singleton scout ("spin up one worker"). */
export const DELEGATE_WAVE_EPHEMERAL_MIN_WORKERS = 1
/**
 * Structural wave size ceiling. Literal — deliberately NOT aliased to
 * MAX_SUBTHREAD_JOIN_QUORUM (keep both ≥ each other when raising either).
 */
export const DELEGATE_WAVE_MAX_WORKERS = 64
/** Settings → General default for Max Wave Agents. */
export const DEFAULT_MAX_WAVE_AGENTS = 8

/**
 * Clamp the Settings → General `maxWaveAgents` value into the structural
 * wave range [DELEGATE_WAVE_MIN_WORKERS, DELEGATE_WAVE_MAX_WORKERS].
 * Malformed / missing values fall back to DEFAULT_MAX_WAVE_AGENTS.
 */
export function clampMaxWaveAgents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_WAVE_AGENTS
  return Math.max(
    DELEGATE_WAVE_MIN_WORKERS,
    Math.min(DELEGATE_WAVE_MAX_WORKERS, Math.floor(value))
  )
}

/**
 * Skip the subThreadDelegation approval card for `delegate_wave` when the
 * caller is a configured Ensemble Boss/Captain AND the seat permission tier
 * is Accept Edits (`default`), Full WS Access (`workspace_write`), or Full
 * Access (`full_access`). Plan / Ask (`read_only`) / custom always prompt —
 * even for Boss/Captain. Non-authority seats always prompt.
 */
export function shouldSkipDelegateWaveApproval(input: {
  isBossOrCaptain: boolean
  permissionPresetId?: PermissionPresetId | string | null
}): boolean {
  if (!input.isBossOrCaptain) return false
  const preset = typeof input.permissionPresetId === 'string' ? input.permissionPresetId : ''
  return preset === 'default' || preset === 'workspace_write' || preset === 'full_access'
}

export interface DelegateWaveWorkerSpec {
  provider: ProviderId
  prompt: string
  model?: string
  reasoningEffort?: string
  kimiThinking?: boolean
  /**
   * Agent-assigned fleet role. Parallel to EnsembleStageRole — do NOT unify
   * (no `background`; does not drive Ensemble dispatch).
   */
  role?: FleetWaveRole
  label?: string
}

export interface ParsedDelegateWaveArgs {
  workers: DelegateWaveWorkerSpec[]
  joinRequest?: SubThreadJoinPolicyRequest
  joinPolicy: SubThreadJoinPolicy
  waveId: string
  returnResultToParent: true
  lifecycle: FleetWaveLifecycle
  allowMultiProvider: boolean
}

export type ParseDelegateWaveResult =
  | { ok: true; value: ParsedDelegateWaveArgs }
  | { ok: false; message: string }

export interface DelegateWaveChildSpawned {
  subThreadId: string
  provider: ProviderId
  status: 'spawned'
}

export interface DelegateWaveResult {
  waveId: string
  children: DelegateWaveChildSpawned[]
}

export interface ParseDelegateWaveOptions {
  parentChatId: string
  /** Used only to prove the wave join group is not the parent run. */
  parentAppRunId?: string
  /** Parent seat provider — used when a worker omits `provider`. */
  parentProvider?: string
  nowMs?: number
  createWaveId?: () => string
  isAllowedProvider: (provider: string) => boolean
  allowedProvidersLabel?: string
  /**
   * Cap from Settings → General `maxWaveAgents` (clamped 2–64). When omitted,
   * defaults to DEFAULT_MAX_WAVE_AGENTS (8), not the absolute wave ceiling.
   */
  maxWorkers?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function error(message: string): ParseDelegateWaveResult {
  return { ok: false, message }
}

/** Strip non-join knobs (especially smuggled groupId) before resolving policy. */
function sanitizeJoinRequest(raw: Record<string, unknown>): SubThreadJoinPolicyRequest {
  const request: SubThreadJoinPolicyRequest = {}
  if (typeof raw.required === 'boolean') request.required = raw.required
  if (typeof raw.quorum === 'number') request.quorum = raw.quorum
  if (typeof raw.deadlineMs === 'number') request.deadlineMs = raw.deadlineMs
  if (typeof raw.debounceMs === 'number') request.debounceMs = raw.debounceMs
  return request
}

export function createDelegateWaveId(
  parentChatId: string,
  options: { nowMs?: number; randomId?: () => string } = {}
): string {
  const parent = parentChatId.trim() || 'parent'
  const suffix =
    typeof options.randomId === 'function'
      ? options.randomId().trim()
      : `${options.nowMs ?? Date.now()}`
  return `wave-${parent}-${suffix}`
}

/**
 * Resolve the wave-level join policy. `groupId` is ALWAYS `waveId` — a
 * caller-supplied join.groupId (or parent appRunId) is ignored.
 */
export function resolveDelegateWaveJoinPolicy(
  joinRequest: SubThreadJoinPolicyRequest | null | undefined,
  waveId: string,
  nowMs?: number
): SubThreadJoinPolicy {
  const normalizedWaveId = waveId.trim()
  if (!normalizedWaveId) {
    throw new Error('delegate_wave: waveId is required for join policy binding.')
  }
  return resolveSubThreadJoinPolicy(joinRequest, {
    groupId: normalizedWaveId,
    nowMs
  })
}

function parseWorker(
  raw: unknown,
  index: number,
  options: ParseDelegateWaveOptions,
  allowMultiProvider: boolean,
  parentProvider: string
): { ok: true; value: DelegateWaveWorkerSpec } | { ok: false; message: string } {
  if (!isRecord(raw)) {
    return {
      ok: false,
      message: `delegate_wave: workers[${index}] must be an object.`
    }
  }
  if (raw.subThreadId !== undefined) {
    return {
      ok: false,
      message:
        'delegate_wave: workers cannot include subThreadId — waves are spawn-only; use delegate_to_subthread for recall.'
    }
  }
  const providerRaw =
    typeof raw.provider === 'string' && raw.provider.trim()
      ? raw.provider.trim()
      : parentProvider.trim()
  if (!providerRaw) {
    return {
      ok: false,
      message: `delegate_wave: workers[${index}].provider is required (omit to inherit the parent provider).`
    }
  }
  if (!options.isAllowedProvider(providerRaw)) {
    const supported =
      options.allowedProvidersLabel || 'a live selectable provider (ollama excluded)'
    return {
      ok: false,
      message: `delegate_wave: workers[${index}].provider must be ${supported} (got: ${providerRaw}).`
    }
  }
  if (!allowMultiProvider && parentProvider && providerRaw !== parentProvider) {
    return {
      ok: false,
      message:
        `delegate_wave: workers[${index}].provider "${providerRaw}" differs from parent "${parentProvider}". ` +
        `Pass allowMultiProvider=true only when the user explicitly requested a multi-provider fleet.`
    }
  }
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
  if (!prompt) {
    return {
      ok: false,
      message: `delegate_wave: workers[${index}].prompt is required.`
    }
  }
  const role = parseFleetWaveRole(raw.role)
  if (raw.role !== undefined && role === undefined) {
    return {
      ok: false,
      message: `delegate_wave: workers[${index}].role must be scout, worker, or reviewer when set.`
    }
  }
  const label =
    typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined
  const worker: DelegateWaveWorkerSpec = {
    provider: providerRaw as ProviderId,
    prompt,
    ...(role ? { role } : {}),
    ...(label ? { label } : {})
  }
  if (typeof raw.model === 'string' && raw.model.trim()) {
    worker.model = raw.model.trim()
  }
  if (typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim()) {
    worker.reasoningEffort = raw.reasoningEffort.trim()
  }
  if (typeof raw.kimiThinking === 'boolean') {
    worker.kimiThinking = raw.kimiThinking
  }
  return { ok: true, value: worker }
}

export function parseDelegateWaveArgs(
  args: unknown,
  options: ParseDelegateWaveOptions
): ParseDelegateWaveResult {
  if (!isRecord(args)) {
    return error('delegate_wave: arguments must be an object.')
  }
  if (args.subThreadId !== undefined) {
    return error(
      'delegate_wave: subThreadId is not supported — waves are spawn-only; use delegate_to_subthread for recall.'
    )
  }
  if (args.returnResult === false) {
    return error(
      'delegate_wave: returnResult=false is not supported — waves always return results to the parent (returnResultToParent=true).'
    )
  }
  if (!Array.isArray(args.workers)) {
    return error('delegate_wave: workers must be an array.')
  }
  const lifecycle = normalizeFleetLifecycle(args.lifecycle)
  const allowMultiProvider = args.allowMultiProvider === true
  const parentProvider =
    typeof options.parentProvider === 'string' ? options.parentProvider.trim() : ''
  const minWorkers =
    lifecycle === 'ephemeral' ? DELEGATE_WAVE_EPHEMERAL_MIN_WORKERS : DELEGATE_WAVE_MIN_WORKERS
  const maxWorkers = clampMaxWaveAgents(
    options.maxWorkers === undefined ? DEFAULT_MAX_WAVE_AGENTS : options.maxWorkers
  )
  if (args.workers.length < minWorkers) {
    return error(
      lifecycle === 'ephemeral'
        ? `delegate_wave: ephemeral workers must contain at least ${minWorkers} entr${minWorkers === 1 ? 'y' : 'ies'}.`
        : `delegate_wave: durable workers must contain at least ${minWorkers} entries (use lifecycle=ephemeral for a singleton).`
    )
  }
  if (args.workers.length > maxWorkers) {
    return error(`delegate_wave: workers must contain at most ${maxWorkers} entries.`)
  }

  const workers: DelegateWaveWorkerSpec[] = []
  for (let i = 0; i < args.workers.length; i++) {
    const parsed = parseWorker(
      args.workers[i],
      i,
      options,
      allowMultiProvider,
      parentProvider
    )
    if (!parsed.ok) return error(parsed.message)
    workers.push(parsed.value)
  }

  let joinRequest: SubThreadJoinPolicyRequest | undefined
  if (args.join !== undefined) {
    if (!isRecord(args.join)) {
      return error('delegate_wave: join must be an object when provided.')
    }
    joinRequest = sanitizeJoinRequest(args.join)
  }

  const nowMs = options.nowMs ?? Date.now()
  const waveId =
    typeof options.createWaveId === 'function'
      ? options.createWaveId().trim()
      : createDelegateWaveId(options.parentChatId, { nowMs })
  if (!waveId) {
    return error('delegate_wave: failed to allocate a waveId.')
  }

  const joinPolicy = resolveDelegateWaveJoinPolicy(joinRequest, waveId, nowMs)
  if (options.parentAppRunId && joinPolicy.groupId === options.parentAppRunId) {
    return error('delegate_wave: join groupId must be the waveId, not the parent appRunId.')
  }
  if (joinPolicy.groupId !== waveId) {
    return error('delegate_wave: join groupId must equal the allocated waveId.')
  }

  return {
    ok: true,
    value: {
      workers,
      ...(joinRequest ? { joinRequest } : {}),
      joinPolicy,
      waveId,
      returnResultToParent: true,
      lifecycle,
      allowMultiProvider
    }
  }
}

export function shapeDelegateWaveResult(input: {
  waveId: string
  children: Array<{ subThreadId: string; provider: ProviderId }>
}): DelegateWaveResult {
  return {
    waveId: input.waveId,
    children: input.children.map((child) => ({
      subThreadId: child.subThreadId,
      provider: child.provider,
      status: 'spawned' as const
    }))
  }
}

/**
 * True when the calling ensemble participant id is the configured Boss or a
 * configured Captain (including legacy second-in-command). Solo threads and
 * missing caller ids are never authority.
 */
export function isDelegateWaveBossOrCaptain(input: {
  callerParticipantId?: string | null
  bossmanParticipantId?: string | null
  captainParticipantIds?: readonly string[] | null
  secondInCommandParticipantId?: string | null
}): boolean {
  const caller =
    typeof input.callerParticipantId === 'string' ? input.callerParticipantId.trim() : ''
  if (!caller) return false
  const boss =
    typeof input.bossmanParticipantId === 'string' ? input.bossmanParticipantId.trim() : ''
  if (boss && boss === caller) return true
  const captains = Array.isArray(input.captainParticipantIds)
    ? input.captainParticipantIds
    : typeof input.secondInCommandParticipantId === 'string' &&
        input.secondInCommandParticipantId.trim()
      ? [input.secondInCommandParticipantId]
      : []
  return captains.some((id) => typeof id === 'string' && id.trim() === caller)
}

/**
 * Reserve `workerCount` delegation-approval budget slots. Pre-checks
 * `remaining >= workerCount` so a short wave never partially consumes the
 * budget when the full wave cannot fit, then consumes exactly N slots.
 */
export function reserveDelegateWaveBudgetSlots(input: {
  workerCount: number
  remaining: number
  tryConsume: () => 'allowed' | 'exhausted'
}): { ok: true } | { ok: false; reason: 'insufficient' } {
  const count = Math.max(0, Math.floor(input.workerCount))
  if (count === 0) return { ok: true }
  if (!Number.isFinite(input.remaining) || input.remaining < count) {
    return { ok: false, reason: 'insufficient' }
  }
  for (let i = 0; i < count; i++) {
    if (input.tryConsume() === 'exhausted') {
      return { ok: false, reason: 'insufficient' }
    }
  }
  return { ok: true }
}

/** Refund exactly `workerCount` previously reserved slots (clamped ≥ 0). */
export function releaseDelegateWaveBudgetSlots(input: {
  workerCount: number
  release: (count: number) => void
}): void {
  const count = Math.max(0, Math.floor(input.workerCount))
  if (count === 0) return
  input.release(count)
}

function describeDelegateWaveWorkerPosture(
  role: FleetWaveRole | undefined,
  workerRoles: ReadonlyArray<FleetWaveRole | undefined>
): string {
  // Mirror resolveEphemeralFleetIsolationForWave: sole worker → capped inherit;
  // 2+ role=worker seats → all read_only (shared-checkout fail-closed).
  if (role === 'worker') {
    const workerSeatCount = workerRoles.filter((entry) => entry === 'worker').length
    if (workerSeatCount > 1) {
      return 'read_only (parallel workers; shared checkout)'
    }
    return 'capped inherit (never Full Access; same-checkout)'
  }
  return 'read_only'
}

export function buildDelegateWaveApprovalCopy(input: {
  parentProviderLabel: string
  waveId: string
  workers: Array<{
    provider: ProviderId
    prompt: string
    model?: string
    reasoningEffort?: string
    kimiThinking?: boolean
    role?: FleetWaveRole
    label?: string
  }>
  joinPolicy: SubThreadJoinPolicy
  providerLabel: (provider: ProviderId) => string
  lifecycle: FleetWaveLifecycle
  allowMultiProvider: boolean
}): { title: string; body: string } {
  const n = input.workers.length
  const title = `${input.parentProviderLabel} wants to delegate a wave of ${n} sub-threads`
  const waveRoles = input.workers.map((worker) => worker.role)
  const workerLines = input.workers.map((worker, index) => {
    const promptPreview =
      worker.prompt.length > 160
        ? `${worker.prompt.slice(0, 160)}…(${worker.prompt.length - 160} more chars)`
        : worker.prompt
    const controls = [
      worker.model ? `model=${worker.model}` : null,
      worker.reasoningEffort ? `reasoningEffort=${worker.reasoningEffort}` : null,
      typeof worker.kimiThinking === 'boolean' ? `kimiThinking=${worker.kimiThinking}` : null
    ]
      .filter((value): value is string => Boolean(value))
      .join(', ')
    const roleBits = [
      worker.role ? `role=${worker.role}` : null,
      worker.label ? `label=${worker.label}` : null,
      `posture=${describeDelegateWaveWorkerPosture(worker.role, waveRoles)}`
    ]
      .filter((value): value is string => Boolean(value))
      .join(', ')
    return (
      `${index + 1}. ${input.providerLabel(worker.provider)}` +
      (controls ? ` (${controls})` : '') +
      ` — ${roleBits}` +
      `\n   ${promptPreview}`
    )
  })
  const lifecycleLine =
    input.lifecycle === 'ephemeral'
      ? 'Lifecycle: ephemeral (die-on-return)'
      : 'Lifecycle: durable'
  const multiProviderLine = input.allowMultiProvider
    ? 'Multi-provider: allowed\n'
    : ''
  const joinLine =
    `join=${input.joinPolicy.required ? 'required' : 'optional'}, ` +
    `quorum=${input.joinPolicy.quorum ?? 'all-required'}, ` +
    `deadline=${input.joinPolicy.deadlineAt}, debounceMs=${input.joinPolicy.debounceMs}`
  const body =
    `Wave id: ${input.waveId}\n` +
    `${lifecycleLine}\n` +
    multiProviderLine +
    `${joinLine}\n` +
    `Results always return to this parent (returnResultToParent=true).\n\n` +
    `Workers:\n${workerLines.join('\n')}\n\n` +
    `Approving starts ${n} new provider runs and consumes their usage allowances.`
  return { title, body }
}

export type DelegateWaveToolOutcome =
  | { ok: true; text: string; result: DelegateWaveResult }
  | { ok: false; text: string }

export interface DelegateWaveResolvedWorkerSettings {
  requestedModel: string
  reasoningEffort?: string
  kimiThinking?: boolean
  /** Opaque provider run-payload fields from resolveSubThreadDelegationRunSettings. */
  runPayload: Record<string, unknown>
  providerMetadataPatch: Record<string, unknown>
}

export interface DelegateWaveSpawnedChild {
  subThreadId: string
  provider: ProviderId
  title: string
  /** Seeded child `appRunId` — required so all-or-nothing rollback can cancel. */
  runId: string
}

/**
 * Remove the projection-only parent `subThreadDelegation` card for a wave
 * worker. Matching is by `metadata.subThreadId` (same stamp spawnWorker writes).
 */
export function stripParentWaveDelegationCard<
  T extends { metadata?: { kind?: unknown; subThreadId?: unknown } | null }
>(messages: readonly T[], subThreadId: string): T[] {
  const id = subThreadId.trim()
  if (!id) return [...messages]
  return messages.filter(
    (message) =>
      !(
        message.metadata?.kind === 'subThreadDelegation' &&
        message.metadata?.subThreadId === id
      )
  )
}

/**
 * Control-flow for `delegate_wave`: parse → validate all workers → reserve
 * budget → optional one-card approval → all-or-nothing spawn.
 * AppStore / IPC stay in the injected ports so this module remains free of
 * composition-root imports.
 */
export async function executeDelegateWaveTool(input: {
  args: unknown
  parentChatId: string
  parentAppRunId?: string
  parentProvider?: string
  parentProviderLabel: string
  maxWorkers: number
  isAllowedProvider: (provider: string) => boolean
  allowedProvidersLabel?: string
  isBossOrCaptain: boolean
  permissionPresetId?: PermissionPresetId | string | null
  budgetRemaining: number
  tryConsumeBudgetSlot: () => 'allowed' | 'exhausted'
  /**
   * Refund previously reserved slots when the wave does not spawn (deny,
   * parent cancel, or spawn/rollback failure). Must release exactly the
   * count reserved for this wave — never a different key's budget.
   */
  releaseBudgetSlots: (count: number) => void
  budgetCap: number
  /**
   * Workspace `subThreadDelegation` policy. Authority card-skip must still
   * honor `deny` — skip only avoids the ask card, never a hard deny.
   */
  subThreadDelegationPolicy?: 'allow' | 'ask' | 'workspace' | 'deny' | null
  requestApproval: (preview: {
    title: string
    body: string
    waveId: string
    joinPolicy: SubThreadJoinPolicy
    workers: Array<{
      provider: ProviderId
      prompt: string
      model?: string
      reasoningEffort?: string
      kimiThinking?: boolean
    }>
  }) => Promise<boolean>
  assertParentStillValid: () => void
  resolveWorkerSettings: (
    worker: DelegateWaveWorkerSpec
  ) => { ok: true; value: DelegateWaveResolvedWorkerSettings } | { ok: false; message: string }
  spawnWorker: (args: {
    worker: DelegateWaveWorkerSpec
    settings: DelegateWaveResolvedWorkerSettings
    joinPolicy: SubThreadJoinPolicy
    waveId: string
    lifecycle: FleetWaveLifecycle
    /** Roles of every seat in this wave (for wave-aware isolation). */
    peerWorkerRoles: Array<FleetWaveRole | undefined>
  }) => Promise<DelegateWaveSpawnedChild>
  /** Cancel the seeded run + strip the parent card + delete the child chat. */
  rollbackWorker: (child: DelegateWaveSpawnedChild) => void
  /** Optional: project one parent fleetWave card after all workers spawn. */
  projectFleetWaveCard?: (args: {
    waveId: string
    joinPolicy: SubThreadJoinPolicy
    lifecycle: FleetWaveLifecycle
    allowMultiProvider: boolean
    workers: DelegateWaveWorkerSpec[]
    children: DelegateWaveSpawnedChild[]
  }) => void
  providerLabel: (provider: ProviderId) => string
  nowMs?: number
  createWaveId?: () => string
}): Promise<DelegateWaveToolOutcome> {
  const parsed = parseDelegateWaveArgs(input.args, {
    parentChatId: input.parentChatId,
    parentAppRunId: input.parentAppRunId,
    parentProvider: input.parentProvider,
    maxWorkers: input.maxWorkers,
    isAllowedProvider: input.isAllowedProvider,
    allowedProvidersLabel: input.allowedProvidersLabel,
    nowMs: input.nowMs,
    createWaveId: input.createWaveId
  })
  if (!parsed.ok) {
    return { ok: false, text: parsed.message }
  }

  const { workers, joinPolicy, waveId, lifecycle, allowMultiProvider } = parsed.value
  const resolvedSettings: DelegateWaveResolvedWorkerSettings[] = []
  for (const worker of workers) {
    const settings = input.resolveWorkerSettings(worker)
    if (!settings.ok) {
      return { ok: false, text: settings.message }
    }
    resolvedSettings.push(settings.value)
  }

  const reserved = reserveDelegateWaveBudgetSlots({
    workerCount: workers.length,
    remaining: input.budgetRemaining,
    tryConsume: input.tryConsumeBudgetSlot
  })
  if (!reserved.ok) {
    const targets = workers.map((worker) => input.providerLabel(worker.provider)).join('/')
    return {
      ok: false,
      text:
        `Sub-thread wave delegation to ${targets} was blocked: this run needs ${workers.length} ` +
        `delegation-approval budget slots but only ${Math.max(0, Math.floor(input.budgetRemaining))} remain ` +
        `(cap ${input.budgetCap}). ${input.parentProviderLabel} should stop delegating and continue the ` +
        `parent turn directly; the budget resets on the next turn.`
    }
  }
  const refundReservedSlots = () => {
    releaseDelegateWaveBudgetSlots({
      workerCount: workers.length,
      release: input.releaseBudgetSlots
    })
  }

  const skipApproval = shouldSkipDelegateWaveApproval({
    isBossOrCaptain: input.isBossOrCaptain,
    permissionPresetId: input.permissionPresetId
  })
  const workersForApproval = workers.map((worker, index) => ({
    provider: worker.provider,
    prompt: worker.prompt,
    model: resolvedSettings[index]?.requestedModel,
    reasoningEffort: resolvedSettings[index]?.reasoningEffort,
    kimiThinking: resolvedSettings[index]?.kimiThinking,
    ...(worker.role ? { role: worker.role } : {}),
    ...(worker.label ? { label: worker.label } : {})
  }))
  const copy = buildDelegateWaveApprovalCopy({
    parentProviderLabel: input.parentProviderLabel,
    waveId,
    workers: workersForApproval,
    joinPolicy,
    providerLabel: input.providerLabel,
    lifecycle,
    allowMultiProvider
  })
  const declineText =
    `Sub-thread wave delegation was declined by TaskWraith policy. ` +
    `${input.parentProviderLabel} continues without delegating; ` +
    `the user can change the policy in Settings → Behavior → Agentic Services → Sub-thread delegation.`
  if (skipApproval) {
    // Card skip is not immunity: a workspace deny still blocks the wave.
    if (input.subThreadDelegationPolicy === 'deny') {
      refundReservedSlots()
      return { ok: false, text: declineText }
    }
  } else {
    const approved = await input.requestApproval({
      title: copy.title,
      body: copy.body,
      waveId,
      joinPolicy,
      workers: workersForApproval
    })
    if (!approved) {
      refundReservedSlots()
      return { ok: false, text: declineText }
    }
  }

  try {
    input.assertParentStillValid()
  } catch (error) {
    refundReservedSlots()
    return {
      ok: false,
      text: error instanceof Error ? error.message : String(error)
    }
  }

  const children: DelegateWaveSpawnedChild[] = []
  try {
    const peerWorkerRoles = workers.map((worker) => worker.role)
    for (let i = 0; i < workers.length; i++) {
      const child = await input.spawnWorker({
        worker: workers[i]!,
        settings: resolvedSettings[i]!,
        joinPolicy,
        waveId,
        lifecycle,
        peerWorkerRoles
      })
      children.push(child)
    }
  } catch (error) {
    for (const child of children) {
      try {
        input.rollbackWorker(child)
      } catch {
        // Best-effort rollback; surface the original spawn failure below.
      }
    }
    refundReservedSlots()
    return {
      ok: false,
      text:
        error instanceof Error
          ? error.message
          : `delegate_wave: failed while spawning workers (${String(error)}).`
    }
  }

  try {
    input.projectFleetWaveCard?.({
      waveId,
      joinPolicy,
      lifecycle,
      allowMultiProvider,
      workers,
      children
    })
  } catch {
    // Best-effort projection card.
  }

  const result = shapeDelegateWaveResult({
    waveId,
    children: children.map((child) => ({
      subThreadId: child.subThreadId,
      provider: child.provider
    }))
  })
  const childSummary = children
    .map((child) => `${child.provider} "${child.title}" (id=${child.subThreadId})`)
    .join('; ')
  const text =
    `Spawned wave ${waveId} with ${children.length} sub-threads: ${childSummary}. ` +
    `Join groupId=${waveId}; results return to this parent as untrusted sub-thread results on completion.`
  return { ok: true, text, result }
}
