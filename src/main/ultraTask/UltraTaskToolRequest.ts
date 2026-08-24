import type { ProviderId } from '../store/types'
import type { DelegateWaveWorkerSpec } from '../SubThreadDelegateWave'
import { isEnsembleSeatProvider } from '../../shared/retiredProviders'
import { getStaticProviderModels } from '../providers/StaticProviderModels'
import { resolveSubThreadDelegationRunSettings } from '../SubThreadDelegationRunSettings'
import { isUltraTaskSupported } from './UltraTaskReasoningResolver'

/**
 * The current UltraTask implementation has one primary worker plus at most one
 * independent scout and one concurrent risk reviewer. A larger number would be
 * a fictitious control: no fourth worker is currently constructed.
 */
export const ULTRA_TASK_MAX_EFFECTIVE_WORKERS = 3
export const ULTRA_TASK_DEFAULT_EFFECTIVE_WORKERS = 3

const DOCUMENTED_MAX_WORKERS = 64
const MODEL_MAX_LENGTH = 200
const DOCUMENTED_REASONING_OVERRIDES = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultracode'
])

export interface UltraTaskSignedRunContext {
  /** Main-verified provider for the active run, never a provider-authored arg. */
  provider: ProviderId
  /** Main-verified model for the active run. A sentinel resolves to its catalog default. */
  model?: string | null
  /** Configured providers the caller may target. Omit only in pure/unit callers. */
  allowedProviders?: readonly ProviderId[]
}

export interface ResolvedUltraTaskToolRequest {
  task: string
  provider: ProviderId
  model: string
  reasoningEffort?: string
  returnResult: true
  requestedMaxWorkers: number
  effectiveMaxWorkers: number
  maxWorkersClamped: boolean
  notice?: string
  /** Direct input for executeDelegateWaveTool. Results are joined by the caller. */
  waveArgs: {
    workers: DelegateWaveWorkerSpec[]
    join: {
      required: true
      quorum: number
      debounceMs: number
    }
    lifecycle: 'ephemeral'
    allowMultiProvider: boolean
  }
}

export type UltraTaskToolRequestResolution =
  | { ok: true; value: ResolvedUltraTaskToolRequest }
  | { ok: false; message: string }

function fail(message: string): UltraTaskToolRequestResolution {
  return { ok: false, message: `ultra_task: ${message}` }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function providerDefaultModel(provider: ProviderId): string | null {
  const models = getStaticProviderModels(provider, { includePreviewModels: true }) as Array<{
    id: string
    isDefault?: boolean
    disabled?: boolean
  }>
  const model =
    models.find((candidate) => candidate.isDefault && !candidate.disabled) ||
    models.find(
      (candidate) =>
        !candidate.disabled && candidate.id !== 'custom' && candidate.id !== 'cli-default'
    )
  return model?.id || null
}

function concreteCurrentModel(context: UltraTaskSignedRunContext): string | null {
  const model = typeof context.model === 'string' ? context.model.trim() : ''
  if (model && model !== 'cli-default' && model !== 'default' && model !== 'custom') {
    return model
  }
  return providerDefaultModel(context.provider)
}

function parseProvider(
  value: unknown,
  context: UltraTaskSignedRunContext
): { ok: true; provider: ProviderId } | { ok: false; message: string } {
  const raw = value === undefined ? context.provider : value
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, message: 'provider must be a non-empty string when provided.' }
  }
  const providerValue = raw.trim().toLowerCase()
  if (!isEnsembleSeatProvider(providerValue)) {
    return { ok: false, message: `provider "${providerValue}" is not live-selectable.` }
  }
  const provider = providerValue as ProviderId
  const allowed = context.allowedProviders
  if (
    allowed &&
    provider !== context.provider &&
    !allowed.some((candidate) => candidate === provider)
  ) {
    return { ok: false, message: `provider "${provider}" is not configured for this run.` }
  }
  return { ok: true, provider }
}

function parseModel(
  value: unknown,
  provider: ProviderId,
  context: UltraTaskSignedRunContext
): { ok: true; model: string } | { ok: false; message: string } {
  if (value !== undefined) {
    if (typeof value !== 'string' || !value.trim()) {
      return { ok: false, message: 'model must be a non-empty string when provided.' }
    }
    const model = value.trim()
    if (model.length > MODEL_MAX_LENGTH) {
      return { ok: false, message: `model must be ${MODEL_MAX_LENGTH} characters or fewer.` }
    }
    return { ok: true, model }
  }

  const model =
    provider === context.provider ? concreteCurrentModel(context) : providerDefaultModel(provider)
  return model
    ? { ok: true, model }
    : {
        ok: false,
        message: `model is required because ${provider} has no concrete default model.`
      }
}

function parseBoolean(
  value: unknown,
  label: string,
  fallback: boolean
): { ok: true; value: boolean } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: fallback }
  return typeof value === 'boolean'
    ? { ok: true, value }
    : { ok: false, message: `${label} must be a boolean when provided.` }
}

function parseMaxWorkers(value: unknown):
  | {
      ok: true
      requested: number
      effective: number
      clamped: boolean
    }
  | { ok: false; message: string } {
  const requested = value === undefined ? ULTRA_TASK_DEFAULT_EFFECTIVE_WORKERS : value
  if (
    typeof requested !== 'number' ||
    !Number.isInteger(requested) ||
    requested < 2 ||
    requested > DOCUMENTED_MAX_WORKERS
  ) {
    return {
      ok: false,
      message: `maxWorkers must be an integer from 2 to ${DOCUMENTED_MAX_WORKERS}.`
    }
  }
  return {
    ok: true,
    requested,
    effective: Math.min(requested, ULTRA_TASK_MAX_EFFECTIVE_WORKERS),
    clamped: requested > ULTRA_TASK_MAX_EFFECTIVE_WORKERS
  }
}

function workerWithControls(
  provider: ProviderId,
  model: string,
  reasoningEffort: string | undefined,
  kimiThinking: boolean | undefined,
  input: Pick<DelegateWaveWorkerSpec, 'prompt' | 'role' | 'label'>
): DelegateWaveWorkerSpec {
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(typeof kimiThinking === 'boolean' ? { kimiThinking } : {}),
    ...input
  }
}

/**
 * Validate the public `ultra_task` request and bind its defaults to the active,
 * already-verified run identity. The provider/model never fall back to the old
 * `parentProvider + cli-default` guess.
 *
 * This produces a concurrent wave, not a sequential reviewer pipeline. The
 * reviewer therefore supplies independent risks and acceptance criteria; it
 * never claims to have inspected a primary result that does not exist yet.
 */
export function resolveUltraTaskToolRequest(
  args: unknown,
  context: UltraTaskSignedRunContext
): UltraTaskToolRequestResolution {
  if (!isRecord(args)) return fail('arguments must be an object.')

  const task = typeof args.task === 'string' ? args.task.trim() : ''
  if (!task) return fail('task is required.')

  const providerResult = parseProvider(args.provider, context)
  if (!providerResult.ok) return fail(providerResult.message)
  const provider = providerResult.provider

  const modelResult = parseModel(args.model, provider, context)
  if (!modelResult.ok) return fail(modelResult.message)
  const model = modelResult.model

  const returnResult = parseBoolean(args.returnResult, 'returnResult', true)
  if (!returnResult.ok) return fail(returnResult.message)
  if (!returnResult.value) {
    return fail('returnResult=false is not supported; UltraTask waves always return their results.')
  }

  const enableFanout = parseBoolean(args.enableFanout, 'enableFanout', true)
  if (!enableFanout.ok) return fail(enableFanout.message)
  const enableReview = parseBoolean(args.enableReview, 'enableReview', true)
  if (!enableReview.ok) return fail(enableReview.message)
  const maxWorkers = parseMaxWorkers(args.maxWorkers)
  if (!maxWorkers.ok) return fail(maxWorkers.message)

  if (args.reasoningEffort !== undefined) {
    if (typeof args.reasoningEffort !== 'string' || !args.reasoningEffort.trim()) {
      return fail('reasoningEffort must be a non-empty string when provided.')
    }
    const override = args.reasoningEffort.trim().toLowerCase()
    if (!DOCUMENTED_REASONING_OVERRIDES.has(override)) {
      return fail(
        `reasoningEffort="${override}" is not documented. Supported overrides: ${[
          ...DOCUMENTED_REASONING_OVERRIDES
        ].join(', ')}.`
      )
    }
  }
  if (!isUltraTaskSupported(provider, model)) {
    return fail(`${provider} model "${model}" does not support UltraTask.`)
  }

  const requestedReasoningEffort =
    // Preserve the synthetic token until the provider/model-aware delegation
    // resolver sees it. Its existing CLI normalizers then map to the real
    // ceiling (Pi max, Muse ultra, Grok 4.5 high, Ollama on, etc.); the older
    // generic UltraTask resolver's provider fallback was merely `high` and
    // silently under-ran several providers.
    args.reasoningEffort === undefined ? 'ultratask' : args.reasoningEffort
  const settings = resolveSubThreadDelegationRunSettings({
    provider,
    model,
    ...(requestedReasoningEffort === 'none' ? {} : { reasoningEffort: requestedReasoningEffort })
  })
  if (!settings.ok) return fail(settings.message.replace(/^delegate_to_subthread:\s*/, ''))

  const workers: DelegateWaveWorkerSpec[] = [
    workerWithControls(
      provider,
      settings.requestedModel,
      settings.reasoningEffort,
      settings.kimiThinking,
      {
        role: 'worker',
        label: 'Primary Worker',
        prompt: task
      }
    )
  ]
  if (enableFanout.value && workers.length < maxWorkers.effective) {
    workers.push(
      workerWithControls(
        provider,
        settings.requestedModel,
        settings.reasoningEffort,
        settings.kimiThinking,
        {
          role: 'scout',
          label: 'Research Scout',
          prompt:
            `Investigate independently for the parent UltraTask: ${task}\n\n` +
            'Gather codebase facts, edge cases, and constraints. Do not modify files. Return concise evidence for the parent to combine after the wave joins.'
        }
      )
    )
  }
  if (enableReview.value && workers.length < maxWorkers.effective) {
    workers.push(
      workerWithControls(
        provider,
        settings.requestedModel,
        settings.reasoningEffort,
        settings.kimiThinking,
        {
          role: 'reviewer',
          label: 'Independent Risk Reviewer',
          prompt:
            `Review the task independently for the parent UltraTask: ${task}\n\n` +
            'Identify acceptance criteria, likely failure modes, and verification steps. This lane runs concurrently with the primary worker: do not claim to verify its eventual output. Return a checklist and risks for the parent to apply after the wave joins.'
        }
      )
    )
  }

  const notices: string[] = []
  if (maxWorkers.clamped) {
    notices.push(
      `maxWorkers=${maxWorkers.requested} was capped at ${ULTRA_TASK_MAX_EFFECTIVE_WORKERS}; the current wave constructs at most one primary, one scout, and one concurrent risk reviewer.`
    )
  }
  if (enableReview.value && !workers.some((worker) => worker.role === 'reviewer')) {
    notices.push(
      `The reviewer was omitted at maxWorkers=${maxWorkers.effective} because the primary and scout take priority; set enableFanout=false to use the second slot for the concurrent risk reviewer.`
    )
  }
  const notice = notices.length > 0 ? notices.join(' ') : undefined
  return {
    ok: true,
    value: {
      task,
      provider,
      model: settings.requestedModel,
      ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
      returnResult: true,
      requestedMaxWorkers: maxWorkers.requested,
      effectiveMaxWorkers: maxWorkers.effective,
      maxWorkersClamped: maxWorkers.clamped,
      ...(notice ? { notice } : {}),
      waveArgs: {
        workers,
        join: {
          required: true,
          quorum: workers.length,
          debounceMs: 2_000
        },
        lifecycle: 'ephemeral',
        allowMultiProvider: provider !== context.provider
      }
    }
  }
}
