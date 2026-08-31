/**
 * MCP executor for the fixed packaged emulator surface.
 *
 * This is deliberately narrower than generic Canvas: it has no URL, ROM,
 * JavaScript, raw-memory, or arbitrary-driver input. Main opens only the
 * reviewed homebrew demo and projects only its bounded observation contract.
 */
import { createHash } from 'node:crypto'
import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import { readPngDimensions } from '../canvas/canvasTypes'
import type {
  CanvasCallContext,
  CanvasController,
  CanvasEmulatorController,
  CanvasEmulatorObservationResult,
  CanvasEmulatorStepResult,
  CanvasFrame
} from '../canvas/canvasTypes'
import {
  EMULATOR_MAX_FRAME_BYTES,
  EMULATOR_STEP_MAX_TOTAL_FRAMES,
  validateEmulatorObservation,
  validateEmulatorStepToolInput,
  type EmulatorObservation,
  type EmulatorObservationState,
  type EmulatorStepToolInput
} from '../../shared/emulatorCanvas'
import {
  EMULATOR_MCP_TOOL_NAMES,
  type EmulatorMcpToolName
} from '../../shared/taskWraithMcpCatalog'

export { EMULATOR_MCP_TOOL_NAMES }
export type { EmulatorMcpToolName }

const EMULATOR_TOOL_NAME_SET: ReadonlySet<string> = new Set(EMULATOR_MCP_TOOL_NAMES)
const EMULATOR_HOME_BREW_GAME_ID = 'homebrew-demo' as const
const EMULATOR_HOME_BREW_TITLE = 'TaskWraith Homebrew Demo' as const
const CANONICAL_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const MAX_ENCODED_FRAME_CHARS = 4 * Math.ceil(EMULATOR_MAX_FRAME_BYTES / 3)
const STEP_OUTCOMES = new Set(['completed', 'refused', 'interrupted'])
const STEP_REFUSAL_REASONS = new Set([
  'stale_observation',
  'stale_input_epoch',
  'user_active',
  'appdrive_lease_required',
  'appdrive_lease_expired',
  'appdrive_step_budget_exhausted',
  'appdrive_binding_mismatch',
  'appdrive_independent_verifier_required'
])
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

export interface EmulatorToolContext {
  appChatId?: string
  appRunId?: string
  workspacePath?: string
  participantId?: string
  ensembleRun?: { participantId?: string | null } | null
}

export interface EmulatorToolExecutorDeps {
  controller: CanvasController & CanvasEmulatorController
}

export interface EmulatorToolExecutors {
  executeEmulatorTool: (
    toolName: EmulatorMcpToolName,
    rawArgs: unknown,
    context: EmulatorToolContext,
    parentProvider: string
  ) => Promise<McpToolExecutionResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function canonicalString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    CANONICAL_OPAQUE_ID.test(value)
    ? value
    : undefined
}

function boundedError(): string {
  return 'Emulator operation failed. Re-observe or reopen the reviewed emulator surface before retrying.'
}

function jsonResult(value: Record<string, unknown>, image?: CanvasFrame): McpToolExecutionResult {
  const text = JSON.stringify(value)
  const content: McpToolContentBlock[] = [{ type: 'text', text }]
  if (image) content.push({ type: 'image', mimeType: image.mimeType, data: image.data })
  return { text, structuredContent: value, content }
}

function fail(toolName: EmulatorMcpToolName, error: string): McpToolExecutionResult {
  return {
    ...jsonResult({ ok: false, tool: toolName, error }),
    isError: true
  }
}

function canvasContext(
  context: EmulatorToolContext,
  parentProvider: string
): CanvasCallContext | null {
  const chatId = canonicalString(context.appChatId, 256)
  const runId = canonicalString(context.appRunId, 256)
  if (!chatId || !runId) return null
  return {
    provider: parentProvider,
    chatId,
    runId,
    ...(context.workspacePath ? { workspacePath: context.workspacePath } : {}),
    ...((context.participantId ?? context.ensembleRun?.participantId)
      ? { participantId: context.participantId ?? context.ensembleRun?.participantId ?? undefined }
      : {})
  }
}

function projectObservationState(state: EmulatorObservationState): EmulatorObservationState {
  if (state.kind === 'unavailable') {
    return Object.freeze({ kind: 'unavailable' as const, reason: 'no_verified_adapter' as const })
  }
  return Object.freeze({
    kind: 'mapped' as const,
    adapterId: state.adapterId,
    adapterRevision: state.adapterRevision,
    schemaSha256: state.schemaSha256,
    fields: Object.freeze(
      state.fields.map((field) =>
        Object.freeze(
          field.kind === 'integer'
            ? {
                key: field.key,
                kind: 'integer' as const,
                value: field.value,
                ...(field.unit ? { unit: field.unit } : {})
              }
            : field.kind === 'boolean'
              ? { key: field.key, kind: 'boolean' as const, value: field.value }
              : { key: field.key, kind: 'enum' as const, value: field.value }
        )
      )
    ),
    truncated: state.truncated
  })
}

function projectFrame(frame: CanvasFrame, observation: EmulatorObservation): CanvasFrame {
  const expected = observation.frame
  if (
    frame.mimeType !== 'image/png' ||
    typeof frame.data !== 'string' ||
    frame.data.length === 0 ||
    frame.data.length > MAX_ENCODED_FRAME_CHARS
  ) {
    throw new Error('Emulator frame has an invalid PNG payload.')
  }
  const bytes = Buffer.from(frame.data, 'base64')
  const hasPngSignature = PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  const hasIhdr =
    bytes.byteLength >= 24 &&
    bytes[8] === 0 &&
    bytes[9] === 0 &&
    bytes[10] === 0 &&
    bytes[11] === 13 &&
    bytes[12] === 0x49 &&
    bytes[13] === 0x48 &&
    bytes[14] === 0x44 &&
    bytes[15] === 0x52
  const dimensions = hasPngSignature && hasIhdr ? readPngDimensions(bytes) : { width: 0, height: 0 }
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > EMULATOR_MAX_FRAME_BYTES ||
    bytes.toString('base64') !== frame.data ||
    !hasPngSignature ||
    !hasIhdr ||
    dimensions.width !== expected.width ||
    dimensions.height !== expected.height ||
    frame.byteLength !== bytes.byteLength ||
    frame.byteLength !== expected.byteLength ||
    frame.width !== expected.width ||
    frame.height !== expected.height ||
    frame.hash !== expected.hash ||
    frame.capturedAt !== expected.capturedAt ||
    createHash('sha256').update(bytes).digest('hex') !== expected.hash
  ) {
    throw new Error('Emulator frame does not match its atomic observation metadata.')
  }
  return Object.freeze({
    mimeType: 'image/png' as const,
    data: frame.data,
    width: expected.width,
    height: expected.height,
    byteLength: expected.byteLength,
    hash: expected.hash,
    capturedAt: expected.capturedAt
  })
}

function projectDriveObservation(
  result: CanvasEmulatorObservationResult,
  canvasId: string,
  ctx: CanvasCallContext,
  expectedReportId?: string,
  expectedActionId?: string
): Record<string, unknown> | undefined {
  const driveObservation = result.driveObservation
  if (!driveObservation) return undefined
  const observationId = canonicalString(driveObservation.observationId, 256)
  const reportId = canonicalString(driveObservation.reportId, 256)
  const actionId = canonicalString(driveObservation.actionId, 256)
  const surfaceId = canonicalString(driveObservation.surfaceId, 256)
  const runId = canonicalString(driveObservation.observer.runId, 256)
  const provider = canonicalString(driveObservation.observer.provider, 96)
  const participantId =
    driveObservation.observer.participantId === null
      ? null
      : canonicalString(driveObservation.observer.participantId, 256)
  if (
    !observationId ||
    !reportId ||
    !actionId ||
    !surfaceId ||
    !runId ||
    !provider ||
    (driveObservation.observer.participantId !== null && !participantId) ||
    !Number.isSafeInteger(driveObservation.observedAt) ||
    driveObservation.observedAt < 0 ||
    surfaceId !== canvasId ||
    runId !== ctx.runId ||
    provider !== ctx.provider ||
    participantId !== (ctx.participantId ?? null) ||
    (expectedReportId !== undefined && reportId !== expectedReportId) ||
    (expectedActionId !== undefined && actionId !== expectedActionId)
  ) {
    throw new Error('Emulator drive observation receipt is invalid.')
  }
  return Object.freeze({
    observationId,
    reportId,
    actionId,
    surfaceId,
    observer: Object.freeze({
      runId,
      provider,
      participantId
    }),
    observedAt: driveObservation.observedAt
  })
}

function projectObservationResult(
  result: CanvasEmulatorObservationResult,
  canvasId: string,
  ctx: CanvasCallContext,
  expectedReportId?: string,
  expectedActionId?: string
): {
  observation: EmulatorObservation
  frame: CanvasFrame
  driveObservation?: Record<string, unknown>
} {
  const validated = validateEmulatorObservation(result.observation)
  if (!validated.ok) throw new Error(`Emulator observation is invalid: ${validated.reason}`)
  const observation = Object.freeze({
    schemaVersion: validated.value.schemaVersion,
    token: Object.freeze({ ...validated.value.token }),
    capturedAt: validated.value.capturedAt,
    humanActive: validated.value.humanActive,
    frame: Object.freeze({ ...validated.value.frame }),
    state: projectObservationState(validated.value.state)
  })
  const frame = projectFrame(result.frame, observation)
  const driveObservation = projectDriveObservation(
    result,
    canvasId,
    ctx,
    expectedReportId,
    expectedActionId
  )
  return driveObservation ? { observation, frame, driveObservation } : { observation, frame }
}

function observationProjection(
  toolName: EmulatorMcpToolName,
  canvasId: string,
  result: CanvasEmulatorObservationResult,
  ctx: CanvasCallContext
): { value: Record<string, unknown>; frame: CanvasFrame } {
  const projected = projectObservationResult(result, canvasId, ctx)
  return {
    value: {
      ok: true,
      tool: toolName,
      canvasId,
      observation: projected.observation,
      ...(projected.driveObservation ? { driveObservation: projected.driveObservation } : {})
    },
    frame: projected.frame
  }
}

function stepProjection(
  canvasId: string,
  result: CanvasEmulatorStepResult,
  ctx: CanvasCallContext,
  requestedFrames: number,
  requestedIndependentVerification: boolean
): { value: Record<string, unknown>; frame: CanvasFrame; completed: boolean } {
  const driveReportId = canonicalString(result.driveReportId, 256)
  const driveActionId = canonicalString(result.driveActionId, 256)
  const hasDriveAction = driveReportId !== undefined || driveActionId !== undefined
  const hasVerifierFlag = result.independentVerificationRequired !== undefined
  if (
    (result.driveReportId !== undefined && !driveReportId) ||
    (result.driveActionId !== undefined && !driveActionId) ||
    (driveReportId === undefined) !== (driveActionId === undefined) ||
    (hasVerifierFlag && typeof result.independentVerificationRequired !== 'boolean') ||
    hasDriveAction !== hasVerifierFlag ||
    (hasDriveAction &&
      result.independentVerificationRequired !== requestedIndependentVerification) ||
    (result.driveObservation !== undefined && (!driveReportId || !driveActionId))
  ) {
    throw new Error('Emulator step has an invalid AppDrive receipt binding.')
  }
  const projected = projectObservationResult(result, canvasId, ctx, driveReportId, driveActionId)
  if (!STEP_OUTCOMES.has(result.outcome)) throw new Error('Emulator step has an invalid outcome.')
  if (
    !Number.isSafeInteger(result.framesRequested) ||
    result.framesRequested !== requestedFrames ||
    result.framesRequested > EMULATOR_STEP_MAX_TOTAL_FRAMES ||
    !Number.isSafeInteger(result.framesCompleted) ||
    result.framesCompleted < 0 ||
    result.framesCompleted > result.framesRequested
  ) {
    throw new Error('Emulator step has invalid frame counts.')
  }
  const expectedExecuted = result.framesCompleted > 0
  if (typeof result.executed !== 'boolean' || result.executed !== expectedExecuted) {
    throw new Error('Emulator step has inconsistent executed state.')
  }
  const expectedPartial = expectedExecuted && result.framesCompleted < result.framesRequested
  if (typeof result.partial !== 'boolean' || result.partial !== expectedPartial) {
    throw new Error('Emulator step has inconsistent partial state.')
  }
  if (
    result.outcome === 'completed' &&
    (!result.executed ||
      result.framesCompleted !== result.framesRequested ||
      result.refusalReason !== undefined)
  ) {
    throw new Error('Completed emulator step has inconsistent execution state.')
  }
  if (
    result.outcome === 'refused' &&
    (result.executed || result.framesCompleted !== 0 || !result.refusalReason)
  ) {
    throw new Error('Refused emulator step has inconsistent execution state.')
  }
  if (
    result.outcome === 'interrupted' &&
    (!result.executed || result.framesCompleted === 0 || !result.refusalReason)
  ) {
    throw new Error('Interrupted emulator step has inconsistent execution state.')
  }
  if (result.refusalReason !== undefined && !STEP_REFUSAL_REASONS.has(result.refusalReason)) {
    throw new Error('Emulator step has an invalid refusal reason.')
  }
  if (
    (result.outcome === 'completed' &&
      (!hasDriveAction || result.driveObservation === undefined)) ||
    (result.outcome === 'interrupted' &&
      (!hasDriveAction || result.driveObservation !== undefined)) ||
    (result.outcome === 'refused' && result.driveObservation !== undefined)
  ) {
    throw new Error('Emulator step has an inconsistent AppDrive outcome binding.')
  }
  return {
    value: {
      ok: result.outcome === 'completed',
      tool: 'emulator_step',
      canvasId,
      observation: projected.observation,
      outcome: result.outcome,
      framesRequested: result.framesRequested,
      framesCompleted: result.framesCompleted,
      executed: result.executed,
      partial: result.partial,
      ...(result.refusalReason ? { refusalReason: result.refusalReason } : {}),
      ...(driveReportId ? { driveReportId } : {}),
      ...(driveActionId ? { driveActionId } : {}),
      ...(hasVerifierFlag
        ? { independentVerificationRequired: result.independentVerificationRequired }
        : {}),
      ...(projected.driveObservation ? { driveObservation: projected.driveObservation } : {})
    },
    frame: projected.frame,
    completed: result.outcome === 'completed'
  }
}

export function isEmulatorMcpToolName(name: string): name is EmulatorMcpToolName {
  return EMULATOR_TOOL_NAME_SET.has(name)
}

export function createEmulatorToolExecutors(deps: EmulatorToolExecutorDeps): EmulatorToolExecutors {
  return {
    async executeEmulatorTool(toolName, rawArgs, context, parentProvider) {
      const ctx = canvasContext(context, parentProvider)
      if (!ctx) {
        return fail(toolName, 'Emulator tools require an active main-owned chat and run context.')
      }
      const suppliedArgs = rawArgs === undefined && toolName === 'emulator_open' ? {} : rawArgs
      if (!isRecord(suppliedArgs))
        return fail(toolName, 'Emulator tool arguments must be an object.')

      try {
        if (toolName === 'emulator_open') {
          if (Object.keys(suppliedArgs).length !== 0) {
            return fail(toolName, 'emulator_open accepts no arguments or overrides.')
          }
          const opened = await deps.controller.open(
            {
              driver: 'emulator',
              gameId: EMULATOR_HOME_BREW_GAME_ID,
              embed: true,
              presentation: 'dock'
            },
            ctx
          )
          const canvasId = canonicalString(opened.canvasId, 256)
          if (!canvasId) throw new Error('Emulator open returned an invalid canvas id.')
          return jsonResult({
            ok: true,
            tool: toolName,
            canvasId,
            title: EMULATOR_HOME_BREW_TITLE,
            presentation: 'dock'
          })
        }

        const canvasId = canonicalString(suppliedArgs.canvasId, 256)
        if (!canvasId) return fail(toolName, '`canvasId` must be a bounded canonical id.')

        if (toolName === 'emulator_observe') {
          if (!exactKeys(suppliedArgs, ['canvasId'])) {
            return fail(toolName, 'emulator_observe accepts only `canvasId`.')
          }
          const result = await deps.controller.observeEmulator(canvasId, ctx)
          const projection = observationProjection(toolName, canvasId, result, ctx)
          return jsonResult(projection.value, projection.frame)
        }

        if (
          !exactKeys(suppliedArgs, [
            'canvasId',
            'expectedObservationId',
            'segments',
            'requireIndependentVerifier'
          ])
        ) {
          return fail(toolName, 'emulator_step received unsupported arguments.')
        }
        const validated = validateEmulatorStepToolInput({
          expectedObservationId: suppliedArgs.expectedObservationId,
          segments: suppliedArgs.segments,
          ...(suppliedArgs.requireIndependentVerifier !== undefined
            ? { requireIndependentVerifier: suppliedArgs.requireIndependentVerifier }
            : {})
        })
        if (!validated.ok) return fail(toolName, validated.reason)
        const result = await deps.controller.stepEmulator(
          canvasId,
          validated.value as EmulatorStepToolInput,
          ctx
        )
        const requestedFrames = validated.value.segments.reduce(
          (total, segment) => total + segment.frames,
          0
        )
        const step = stepProjection(
          canvasId,
          result,
          ctx,
          requestedFrames,
          validated.value.requireIndependentVerifier === true
        )
        const projection = jsonResult(step.value, step.frame)
        return step.completed ? projection : { ...projection, isError: true }
      } catch {
        return fail(toolName, boundedError())
      }
    }
  }
}
