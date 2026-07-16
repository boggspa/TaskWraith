import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildRunQueueDispatchReceipt } from './RunQueueDispatchReceipt'
import type { ScheduledOccurrenceAuthorityRoot } from './ScheduledOccurrenceAuthorityRootStore'
import {
  LEGACY_STORE_MUTATION_VALIDATION_POLICY,
  validateScheduledOccurrenceMutationIntent,
  type ScheduledOccurrenceMutationIntent
} from './ScheduledOccurrenceMutationSemantics'
import {
  decodeScheduledOccurrenceMutationWal,
  encodeScheduledOccurrenceMutationWal,
  SCHEDULED_OCCURRENCE_MUTATION_WAL_MAX_BYTES,
  type ScheduledOccurrenceMutationLedgerPrefix,
  type ScheduledOccurrenceMutationWalPayload
} from './ScheduledOccurrenceMutationWal'
import type {
  ScheduledOccurrenceSealV2,
  ScheduledTask,
  WorkflowDefinition
} from './store/types'
import type { WorkflowRunEvent } from './WorkflowRunStore'

const NOW = '2026-07-15T12:00:00.000Z'
const ROOT_ID = `twso-root-v1:${'a'.repeat(64)}`
// resolve() keeps the fixture path lexically canonical on every platform;
// the seal validator requires `resolve(p) === p`.
const WORKSPACE_PATH = resolve('/tmp/Test 1')

type StandaloneMaterializePayload = Extract<
  ScheduledOccurrenceMutationWalPayload,
  { projection: 'standalone'; kind: 'materialize' }
>
type StandaloneClaimPayload = Extract<
  ScheduledOccurrenceMutationWalPayload,
  { projection: 'standalone'; kind: 'claim' }
>
type StandaloneSettlePayload = Extract<
  ScheduledOccurrenceMutationWalPayload,
  { projection: 'standalone'; kind: 'settle' }
>
type WorkflowMaterializePayload = Extract<
  ScheduledOccurrenceMutationWalPayload,
  { projection: 'workflow'; kind: 'materialize' }
>
type WorkflowClaimPayload = Extract<
  ScheduledOccurrenceMutationWalPayload,
  { projection: 'workflow'; kind: 'claim' }
>
type WorkflowSettlePayload = Extract<
  ScheduledOccurrenceMutationWalPayload,
  { projection: 'workflow'; kind: 'settle' }
>

interface TestAuthorityRoot extends ScheduledOccurrenceAuthorityRoot {
  readonly dispose: () => void
}

function authorityRoot(rootId: string = ROOT_ID, secret = 'wal-test-secret'): TestAuthorityRoot {
  let key: Buffer | null = Buffer.from(secret)
  const mac = (domain: string, payload: Buffer): string => {
    if (key === null) throw new Error('authority root disposed')
    return createHmac('sha256', key).update(domain).update(payload).digest('hex')
  }
  const verify = (domain: string, payload: Buffer, candidate: string): boolean => {
    if (key === null) throw new Error('authority root disposed')
    if (!/^[0-9a-f]{64}$/.test(candidate)) return false
    return timingSafeEqual(
      Buffer.from(mac(domain, payload), 'hex'),
      Buffer.from(candidate, 'hex')
    )
  }
  const unavailable = (): never => {
    throw new Error('unused authority operation')
  }
  return Object.freeze({
    rootId,
    sealPayloadMac: (payload: Buffer): string => mac('seal-test\0', payload),
    verifySealPayloadMac: (payload: Buffer, candidate: string): boolean =>
      verify('seal-test\0', payload, candidate),
    walPayloadMac: (payload: Buffer): string => mac('wal-test\0', payload),
    verifyWalPayloadMac: (payload: Buffer, candidate: string): boolean =>
      verify('wal-test\0', payload, candidate),
    runtimeProfileSetHmac: unavailable,
    permissionPostureSetHmac: unavailable,
    providerLaunchHmac: unavailable,
    verifyProviderLaunchHmac: unavailable,
    dispose: (): void => {
      if (key === null) return
      key.fill(0)
      key = null
    }
  })
}

function task(
  id = 'task-1',
  overrides: Partial<ScheduledTask> = {}
): ScheduledTask {
  const record: ScheduledTask = {
    id,
    workspaceId: 'workspace-1',
    workspacePath: WORKSPACE_PATH,
    chatId: 'chat-1',
    provider: 'codex',
    prompt: 'Run the scheduled task.',
    selectedModelType: 'custom',
    customModel: 'gpt-5.6-spark',
    approvalMode: 'plan',
    sessionTrust: false,
    imageAttachments: [],
    runAt: NOW,
    timezone: 'UTC',
    status: 'due',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
  record.dispatchReceipt ??= taskDispatchReceipt(record, record.updatedAt)
  return record
}

function taskDispatchReceipt(task: ScheduledTask, generatedAt: string) {
  const workflowMode = task.workflowMode === 'plan' ? 'plan' : 'normal'
  return buildRunQueueDispatchReceipt(
    {
      runId: task.runId || task.id,
      provider: task.provider,
      source: 'scheduled',
      scope: 'workspace',
      workspaceId: task.workspaceId,
      chatId: task.chatId,
      permissionPosture: task.permissionPosture,
      request: {
        scope: 'workspace',
        prompt: task.prompt,
        selectedModelType: task.selectedModelType,
        customModel: task.customModel,
        approvalMode: task.approvalMode,
        workflowMode,
        sessionTrust: task.sessionTrust,
        imageAttachments: task.imageAttachments,
        scheduledTaskId: task.id,
        scheduledRunAt: task.runAt
      }
    },
    generatedAt
  )
}

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'workflow-1',
    name: 'Workflow 1',
    workspaceId: 'workspace-1',
    workspacePath: WORKSPACE_PATH,
    enabled: true,
    trigger: { kind: 'once', runAt: NOW },
    template: {
      workspaceId: 'workspace-1',
      workspacePath: WORKSPACE_PATH,
      chatId: 'chat-1',
      provider: 'codex',
      prompt: 'Run the scheduled task.',
      selectedModelType: 'custom',
      customModel: 'gpt-5.6-spark',
      approvalMode: 'plan',
      sessionTrust: false,
      imageAttachments: []
    },
    missedRunPolicy: 'coalesce',
    concurrencyPolicy: 'skip',
    limits: {},
    failureStreak: 0,
    history: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as WorkflowDefinition
}

function ledgerPrefix(): ScheduledOccurrenceMutationLedgerPrefix {
  return {
    schemaVersion: 1,
    fileExisted: false,
    sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
    byteLength: 0,
    eventCount: 0,
    tailSequence: 0
  }
}

function ledgerEvent(overrides: Partial<WorkflowRunEvent> = {}): WorkflowRunEvent {
  return {
    schemaVersion: 1,
    sequence: 1,
    workflowExecutionId: 'execution-1',
    workflowId: 'workflow-1',
    kind: 'running',
    timestamp: NOW,
    scheduledTaskId: 'task-1',
    runId: 'run-1',
    plannedFor: NOW,
    ...overrides
  }
}

function standaloneMaterialize(): StandaloneMaterializePayload {
  return {
    mutationId: 'mutation-1',
    kind: 'materialize',
    projection: 'standalone',
    createdAt: NOW,
    identity: {
      taskId: 'task-1',
      workflowId: null,
      executionId: null,
      plannedFor: NOW,
      runId: null
    },
    taskBefore: null,
    taskAfter: task(),
    workflowBefore: null,
    workflowAfter: null,
    ledgerBefore: null,
    ledgerAfter: null
  }
}

function standaloneClaim(root: ScheduledOccurrenceAuthorityRoot = authorityRoot()): StandaloneClaimPayload {
  const taskAfter = {
    ...task('task-1', {
      status: 'running',
      runId: 'run-1',
      firedAt: NOW,
      runningSince: NOW
    }),
    occurrenceSeal: occurrenceSeal(root, { compositeWorkflowAuthorityDigest: null })
  }
  return {
    ...standaloneMaterialize(),
    mutationId: 'mutation-claim',
    kind: 'claim',
    identity: { ...standaloneMaterialize().identity, runId: 'run-1' },
    taskBefore: task(),
    taskAfter
  }
}

function standaloneSettle(
  root: ScheduledOccurrenceAuthorityRoot = authorityRoot()
): StandaloneSettlePayload {
  const claimed = standaloneClaim(root)
  return {
    ...claimed,
    mutationId: 'mutation-settle',
    kind: 'settle',
    taskBefore: claimed.taskAfter,
    taskAfter: { ...claimed.taskAfter, status: 'completed', completedAt: NOW }
  }
}

function workflowMaterialize(): WorkflowMaterializePayload {
  const linkedTask = task('task-1', {
    workflowId: 'workflow-1',
    workflowExecutionId: 'execution-1',
    workflowOccurrenceAt: NOW
  })
  return {
    mutationId: 'mutation-workflow-materialize',
    kind: 'materialize',
    projection: 'workflow',
    createdAt: NOW,
    identity: {
      taskId: 'task-1',
      workflowId: 'workflow-1',
      executionId: 'execution-1',
      plannedFor: NOW,
      runId: null
    },
    taskBefore: null,
    taskAfter: linkedTask,
    workflowBefore: workflow(),
    workflowAfter: workflow({
      history: [
        {
          id: 'execution-1',
          workflowId: 'workflow-1',
          scheduledTaskId: 'task-1',
          plannedFor: NOW,
          status: 'queued',
          createdAt: NOW,
          updatedAt: NOW
        }
      ],
      activeExecutionId: 'execution-1',
      lastRunAt: NOW,
      lastStatus: 'queued',
      nextRunAt: NOW
    }),
    ledgerBefore: null,
    ledgerAfter: null
  }
}

function workflowClaim(root: ScheduledOccurrenceAuthorityRoot = authorityRoot()): WorkflowClaimPayload {
  const materialized = workflowMaterialize()
  const queuedTask = materialized.taskAfter
  const runningTask = {
    ...task('task-1', {
      ...queuedTask,
      status: 'running',
      runId: 'run-1',
      firedAt: NOW,
      runningSince: NOW,
      dispatchReceipt: undefined
    }),
    occurrenceSeal: occurrenceSeal(root)
  }
  const queuedExecution = materialized.workflowAfter.history[0]
  return {
    ...materialized,
    mutationId: 'mutation-workflow-claim',
    kind: 'claim',
    identity: { ...materialized.identity, runId: 'run-1' },
    taskBefore: queuedTask,
    taskAfter: runningTask,
    workflowBefore: materialized.workflowAfter,
    workflowAfter: workflow({
      ...materialized.workflowAfter,
      history: [
        {
          ...queuedExecution,
          status: 'running',
          runId: 'run-1',
          startedAt: NOW,
          updatedAt: NOW
        }
      ],
      lastStatus: 'running',
      updatedAt: NOW
    }),
    ledgerBefore: ledgerPrefix(),
    ledgerAfter: ledgerEvent()
  }
}

function workflowSettle(
  root: ScheduledOccurrenceAuthorityRoot = authorityRoot()
): WorkflowSettlePayload {
  const claimed = workflowClaim(root)
  const completedTask = {
    ...claimed.taskAfter,
    status: 'completed' as const,
    completedAt: NOW
  }
  const workflowAfter = workflow({
    ...claimed.workflowAfter,
    history: [
      {
        ...claimed.workflowAfter.history[0],
        status: 'completed',
        completedAt: NOW,
        updatedAt: NOW
      }
    ],
    lastStatus: 'completed',
    lastCompletedAt: NOW,
    failureStreak: 0,
    updatedAt: NOW
  })
  delete workflowAfter.activeExecutionId
  const prefix: ScheduledOccurrenceMutationLedgerPrefix = {
    schemaVersion: 1,
    fileExisted: true,
    sha256: createHash('sha256').update('prior-claim\n').digest('hex'),
    byteLength: Buffer.byteLength('prior-claim\n'),
    eventCount: 1,
    tailSequence: 1
  }
  return {
    ...claimed,
    mutationId: 'mutation-workflow-settle',
    kind: 'settle',
    taskBefore: claimed.taskAfter,
    taskAfter: completedTask,
    workflowBefore: claimed.workflowAfter,
    workflowAfter,
    ledgerBefore: prefix,
    ledgerAfter: ledgerEvent({ kind: 'completed', sequence: 2 })
  }
}

function legacyWorkflowClaimIntent(
  payload: WorkflowClaimPayload,
  taskAfter: ScheduledTask
): ScheduledOccurrenceMutationIntent {
  return {
    schemaVersion: 1,
    id: payload.mutationId,
    kind: payload.kind,
    createdAt: payload.createdAt,
    identity: {
      taskId: payload.identity.taskId,
      workflowId: payload.identity.workflowId,
      executionId: payload.identity.executionId,
      plannedFor: payload.identity.plannedFor,
      runId: payload.identity.runId
    },
    taskBefore: payload.taskBefore,
    taskAfter,
    workflowBefore: payload.workflowBefore,
    workflowAfter: payload.workflowAfter,
    ledgerBefore: payload.ledgerBefore,
    ledgerAfter: payload.ledgerAfter
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )
    .join(',')}}`
}

function occurrenceSeal(
  root: ScheduledOccurrenceAuthorityRoot,
  overrides: Partial<Omit<ScheduledOccurrenceSealV2, 'sealMac'>> = {}
): ScheduledOccurrenceSealV2 {
  const payload = {
    schemaVersion: 2 as const,
    rootId: root.rootId,
    issuedAt: NOW,
    ownerRunId: 'run-1',
    rootOwner: 'solo' as const,
    taskAuthorityDigest: '1'.repeat(64),
    compositeWorkflowAuthorityDigest: '2'.repeat(64),
    workspaceRealPath: WORKSPACE_PATH,
    runtimeProfileSetHmac: '3'.repeat(64),
    permissionPostureSetHmac: '4'.repeat(64),
    ...overrides
  }
  return {
    ...payload,
    sealMac: root.sealPayloadMac(Buffer.from(canonicalJson(payload), 'utf8'))
  }
}

function signedEnvelope(
  root: ScheduledOccurrenceAuthorityRoot,
  payload: unknown,
  overrides: Record<string, unknown> = {}
): string {
  const unsigned = {
    schemaVersion: 2,
    rootId: root.rootId,
    payload
  }
  const walMac = root.walPayloadMac(Buffer.from(canonicalJson(unsigned), 'utf8'))
  return canonicalJson({ ...unsigned, walMac, ...overrides })
}

function expectEncodeRejected(candidate: unknown): void {
  expect(() =>
    encodeScheduledOccurrenceMutationWal(
      authorityRoot(),
      candidate as ScheduledOccurrenceMutationWalPayload
    )
  ).toThrow()
}

describe('ScheduledOccurrenceMutationWal', () => {
  it.each([
    ['standalone materialize', standaloneMaterialize],
    ['standalone claim', standaloneClaim],
    ['standalone settle', standaloneSettle],
    ['workflow materialize', workflowMaterialize],
    ['workflow claim', workflowClaim],
    ['workflow settle', workflowSettle]
  ])('round-trips and deeply freezes %s projections', (_label, makePayload) => {
    const root = authorityRoot()
    const payload = makePayload()
    const decoded = decodeScheduledOccurrenceMutationWal(
      root,
      encodeScheduledOccurrenceMutationWal(root, payload)
    )
    expect(decoded).toEqual(payload)
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(Object.isFrozen(decoded?.identity)).toBe(true)
    expect(Object.isFrozen(decoded?.taskAfter)).toBe(true)
    expect(Object.isFrozen(decoded?.taskAfter.imageAttachments)).toBe(true)
  })

  it('canonicalizes every object key independently of insertion order', () => {
    const root = authorityRoot()
    const first = workflowClaim()
    const reverse = (value: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(value).reverse())
    const second = reverse(first as unknown as Record<string, unknown>)
    second.identity = reverse(first.identity as unknown as Record<string, unknown>)
    second.taskAfter = reverse(first.taskAfter as unknown as Record<string, unknown>)
    second.ledgerBefore = reverse(first.ledgerBefore as unknown as Record<string, unknown>)
    second.ledgerAfter = reverse(first.ledgerAfter as unknown as Record<string, unknown>)

    expect(
      encodeScheduledOccurrenceMutationWal(root, second as unknown as ScheduledOccurrenceMutationWalPayload)
    ).toBe(encodeScheduledOccurrenceMutationWal(root, first))
  })

  it('rejects non-canonical raw key order and duplicate-key collisions', () => {
    const root = authorityRoot()
    const encoded = encodeScheduledOccurrenceMutationWal(root, workflowClaim())
    const envelope = JSON.parse(encoded) as Record<string, unknown>
    const reordered = JSON.stringify({
      schemaVersion: envelope.schemaVersion,
      rootId: envelope.rootId,
      payload: envelope.payload,
      walMac: envelope.walMac
    })
    expect(reordered).not.toBe(encoded)
    expect(decodeScheduledOccurrenceMutationWal(root, reordered)).toBeNull()

    const duplicate = encoded.replace(
      `"rootId":"${ROOT_ID}"`,
      `"rootId":"${ROOT_ID}","rootId":"${ROOT_ID}"`
    )
    expect(decodeScheduledOccurrenceMutationWal(root, duplicate)).toBeNull()
  })

  it('fails closed for v1, v3, foreign roots, malformed MACs, and payload tampering', () => {
    const root = authorityRoot()
    const encoded = encodeScheduledOccurrenceMutationWal(root, workflowClaim())
    const envelope = JSON.parse(encoded) as Record<string, unknown>
    expect(
      decodeScheduledOccurrenceMutationWal(root, canonicalJson({ ...envelope, schemaVersion: 1 }))
    ).toBeNull()
    expect(
      decodeScheduledOccurrenceMutationWal(root, canonicalJson({ ...envelope, schemaVersion: 3 }))
    ).toBeNull()
    expect(
      decodeScheduledOccurrenceMutationWal(
        authorityRoot(`twso-root-v1:${'b'.repeat(64)}`),
        encoded
      )
    ).toBeNull()
    expect(
      decodeScheduledOccurrenceMutationWal(root, canonicalJson({ ...envelope, walMac: 'f'.repeat(64) }))
    ).toBeNull()
    expect(decodeScheduledOccurrenceMutationWal(root, encoded.replace('run-1', 'run-2'))).toBeNull()
    expect(decodeScheduledOccurrenceMutationWal(root, '{')).toBeNull()
  })

  it('authenticates canonical bytes before interpreting mutation semantics', () => {
    const base = authorityRoot()
    let verificationCalls = 0
    const root: ScheduledOccurrenceAuthorityRoot = Object.freeze({
      ...base,
      verifyWalPayloadMac: (): boolean => {
        verificationCalls += 1
        return false
      }
    })
    const invalidPayload = { ...workflowClaim(), kind: 'not-a-mutation' }
    const candidate = canonicalJson({
      schemaVersion: 2,
      rootId: root.rootId,
      payload: invalidPayload,
      walMac: '0'.repeat(64)
    })

    expect(decodeScheduledOccurrenceMutationWal(root, candidate)).toBeNull()
    expect(verificationCalls).toBe(1)
  })

  it('rejects unknown envelope, payload, identity, ledger, breach, and verdict keys', () => {
    const root = authorityRoot()
    const payload = workflowClaim() as unknown as Record<string, unknown>
    expect(
      decodeScheduledOccurrenceMutationWal(
        root,
        signedEnvelope(root, payload, { unexpectedEnvelopeAuthority: true })
      )
    ).toBeNull()
    expectEncodeRejected({ ...payload, unexpectedPayloadAuthority: true })
    expectEncodeRejected({
      ...payload,
      identity: { ...(payload.identity as object), unexpectedIdentityAuthority: true }
    })
    expectEncodeRejected({
      ...payload,
      ledgerBefore: { ...(payload.ledgerBefore as object), unexpectedPrefixAuthority: true }
    })
    expectEncodeRejected({
      ...payload,
      ledgerAfter: { ...(payload.ledgerAfter as object), unexpectedEventAuthority: true }
    })
    expectEncodeRejected({
      ...payload,
      ledgerAfter: {
        ...(payload.ledgerAfter as object),
        breach: { kind: 'tokens', limit: 10, observed: 11, extra: true }
      }
    })
    expectEncodeRejected({
      ...payload,
      ledgerAfter: {
        ...(payload.ledgerAfter as object),
        verdict: { decision: 'accept', extra: true }
      }
    })
  })

  it('closes task, workflow, trigger, template, and limit schemas', () => {
    const standalone = standaloneMaterialize()
    expectEncodeRejected({ ...standalone, taskAfter: { id: 'task-1', runAt: NOW } })
    expectEncodeRejected({
      ...standalone,
      taskAfter: { ...standalone.taskAfter, futureTaskAuthority: true }
    })
    expectEncodeRejected({
      ...standalone,
      taskAfter: { ...standalone.taskAfter, provider: 'not-a-provider' }
    })

    const payload = workflowMaterialize()
    expectEncodeRejected({
      ...payload,
      workflowBefore: { ...payload.workflowBefore, futureWorkflowAuthority: true }
    })
    expectEncodeRejected({
      ...payload,
      workflowBefore: {
        ...payload.workflowBefore,
        trigger: { ...payload.workflowBefore.trigger, futureTriggerAuthority: true }
      }
    })
    expectEncodeRejected({
      ...payload,
      workflowBefore: {
        ...payload.workflowBefore,
        template: { ...payload.workflowBefore.template, futureTemplateAuthority: true }
      }
    })
    expectEncodeRejected({
      ...payload,
      workflowBefore: {
        ...payload.workflowBefore,
        limits: { ...payload.workflowBefore.limits, futureLimitAuthority: 1 }
      }
    })
  })

  it('rejects contradictory materialize, claim, settle, and workflow projections', () => {
    const materialize = standaloneMaterialize()
    expectEncodeRejected({
      ...materialize,
      taskAfter: task('task-1', { status: 'running', runId: 'run-1' })
    })

    const claim = standaloneClaim()
    const futureRunAt = '2026-07-15T12:00:01.000Z'
    expectEncodeRejected({
      ...claim,
      identity: { ...claim.identity, plannedFor: futureRunAt },
      taskBefore: task('task-1', { runAt: futureRunAt }),
      taskAfter: task('task-1', {
        runAt: futureRunAt,
        status: 'running',
        runId: 'run-1',
        firedAt: NOW,
        runningSince: NOW
      })
    })
    expectEncodeRejected({
      ...claim,
      taskAfter: { ...claim.taskAfter, status: 'due' }
    })

    const settle = standaloneSettle()
    expectEncodeRejected({
      ...settle,
      taskAfter: { ...settle.taskAfter, status: 'running', completedAt: undefined }
    })
    expectEncodeRejected({
      ...settle,
      taskAfter: { ...settle.taskAfter, runId: 'run-2' }
    })

    const linked = workflowMaterialize()
    const plannedAfterRunAt = '2026-07-15T12:00:01.000Z'
    expectEncodeRejected({
      ...linked,
      identity: { ...linked.identity, plannedFor: plannedAfterRunAt },
      taskAfter: { ...linked.taskAfter, workflowOccurrenceAt: plannedAfterRunAt },
      workflowAfter: {
        ...linked.workflowAfter,
        history: [{ ...linked.workflowAfter.history[0], plannedFor: plannedAfterRunAt }]
      }
    })
    expectEncodeRejected({
      ...linked,
      workflowAfter: {
        ...linked.workflowAfter,
        history: [...linked.workflowAfter.history, linked.workflowAfter.history[0]]
      }
    })
    expectEncodeRejected({
      ...linked,
      workflowAfter: { ...linked.workflowAfter, name: 'Unrelated authority change' }
    })
    expectEncodeRejected({
      ...linked,
      workflowBefore: {
        ...linked.workflowBefore,
        template: { ...linked.workflowBefore.template, prompt: 'Different authority.' }
      }
    })
    const unsafeExecutionId = 'execution/1'
    expectEncodeRejected({
      ...linked,
      identity: { ...linked.identity, executionId: unsafeExecutionId },
      taskAfter: { ...linked.taskAfter, workflowExecutionId: unsafeExecutionId },
      workflowAfter: {
        ...linked.workflowAfter,
        activeExecutionId: unsafeExecutionId,
        history: [{ ...linked.workflowAfter.history[0], id: unsafeExecutionId }]
      }
    })
  })

  it('verifies v2 occurrence-seal shape, MAC, and lifecycle binding', () => {
    const root = authorityRoot()
    const workflowPayload = workflowClaim(root)
    expect(
      decodeScheduledOccurrenceMutationWal(
        root,
        encodeScheduledOccurrenceMutationWal(root, workflowPayload)
      )?.taskAfter.occurrenceSeal
    ).toEqual(workflowPayload.taskAfter.occurrenceSeal)

    expect(() => encodeScheduledOccurrenceMutationWal(root, standaloneClaim(root))).not.toThrow()

    const unsealedTaskAfter: ScheduledTask = { ...workflowPayload.taskAfter }
    delete unsealedTaskAfter.occurrenceSeal
    const unsealedClaim = { ...workflowPayload, taskAfter: unsealedTaskAfter }
    expectEncodeRejected(unsealedClaim)
    expect(
      decodeScheduledOccurrenceMutationWal(root, signedEnvelope(root, unsealedClaim))
    ).toBeNull()
    expectEncodeRejected({
      ...workflowPayload,
      taskBefore: {
        ...workflowPayload.taskBefore,
        occurrenceSeal: workflowPayload.taskAfter.occurrenceSeal
      }
    })

    for (const seal of [
      occurrenceSeal(root, { ownerRunId: 'run-2' }),
      occurrenceSeal(root, { issuedAt: '2026-07-15T12:00:01.000Z' }),
      occurrenceSeal(root, { rootOwner: 'loop-root' }),
      occurrenceSeal(root, { compositeWorkflowAuthorityDigest: null }),
      occurrenceSeal(root, { rootId: `twso-root-v1:${'b'.repeat(64)}` }),
      { ...occurrenceSeal(root), sealMac: 'f'.repeat(64) },
      { ...occurrenceSeal(root), futureSealAuthority: true },
      {
        schemaVersion: 1,
        issuedAt: NOW,
        taskAuthorityDigest: '1'.repeat(64),
        compositeWorkflowAuthorityDigest: '2'.repeat(64),
        workspaceRealPath: WORKSPACE_PATH,
        runtimeProfileSetHmac: '3'.repeat(64),
        permissionPostureSetHmac: '4'.repeat(64),
        sealSignature: '5'.repeat(64)
      }
    ]) {
      expectEncodeRejected({
        ...workflowPayload,
        taskAfter: { ...workflowPayload.taskAfter, occurrenceSeal: seal }
      })
    }
  })

  it('uses the shared explicit legacy-store policy to forbid claim seals', () => {
    const root = authorityRoot()
    const walClaim = workflowClaim(root)
    const unsealedTaskAfter: ScheduledTask = { ...walClaim.taskAfter }
    delete unsealedTaskAfter.occurrenceSeal

    expect(
      validateScheduledOccurrenceMutationIntent(
        legacyWorkflowClaimIntent(walClaim, unsealedTaskAfter),
        LEGACY_STORE_MUTATION_VALIDATION_POLICY
      )
    ).toBeNull()
    expect(
      validateScheduledOccurrenceMutationIntent(
        legacyWorkflowClaimIntent(walClaim, walClaim.taskAfter),
        LEGACY_STORE_MUTATION_VALIDATION_POLICY
      )
    ).toMatch(/cannot contain an occurrence seal/)
  })

  it('requires physically possible ledger prefixes and canonical task-derived events', () => {
    const payload = workflowClaim()
    expectEncodeRejected({
      ...payload,
      ledgerBefore: { ...payload.ledgerBefore, sha256: '0'.repeat(64) }
    })
    expectEncodeRejected({
      ...payload,
      ledgerBefore: {
        ...payload.ledgerBefore,
        fileExisted: false,
        byteLength: 10,
        eventCount: 1,
        tailSequence: 1
      },
      ledgerAfter: { ...payload.ledgerAfter, sequence: 2 }
    })
    expectEncodeRejected({
      ...payload,
      ledgerAfter: { ...payload.ledgerAfter, error: 'Invented error' }
    })
  })

  it('rejects ambiguous nullable projection combinations', () => {
    const standalone = standaloneMaterialize()
    expectEncodeRejected({ ...standalone, workflowBefore: workflow() })
    expectEncodeRejected({ ...standalone, taskBefore: task() })
    expectEncodeRejected({
      ...standalone,
      taskAfter: { ...standalone.taskAfter, runAt: '2026-07-15T12:00:01.000Z' }
    })
    expectEncodeRejected({ ...standaloneClaim(), identity: { ...standaloneClaim().identity, runId: null } })

    const workflowPayload = workflowClaim()
    expectEncodeRejected({ ...workflowPayload, workflowBefore: null })
    expectEncodeRejected({ ...workflowPayload, ledgerBefore: null })
    expectEncodeRejected({ ...workflowPayload, ledgerAfter: null })
    expectEncodeRejected({
      ...workflowMaterialize(),
      ledgerBefore: ledgerPrefix(),
      ledgerAfter: ledgerEvent()
    })
    expectEncodeRejected({
      ...workflowPayload,
      taskAfter: { ...workflowPayload.taskAfter, workflowOccurrenceAt: '2026-07-15T12:00:01.000Z' }
    })
    expectEncodeRejected({
      ...workflowPayload,
      ledgerAfter: { ...workflowPayload.ledgerAfter, sequence: 2 }
    })
    expectEncodeRejected({
      ...workflowPayload,
      ledgerAfter: { ...workflowPayload.ledgerAfter, scheduledTaskId: 'task-2' }
    })
    expectEncodeRejected({
      ...workflowPayload,
      ledgerAfter: { ...workflowPayload.ledgerAfter, timestamp: '2026-07-15T12:00:01.000Z' }
    })
  })

  it('rejects hostile prototypes, accessors, symbols, bigint, non-finite and negative-zero numbers', () => {
    const prototypeTask = Object.create({ inherited: true }) as Record<string, unknown>
    Object.assign(prototypeTask, task())
    expectEncodeRejected({ ...standaloneMaterialize(), taskAfter: prototypeTask })

    let getterCalled = false
    const accessorTask = { ...task() }
    Object.defineProperty(accessorTask, 'prompt', {
      enumerable: true,
      get: () => {
        getterCalled = true
        return 'stolen'
      }
    })
    expectEncodeRejected({ ...standaloneMaterialize(), taskAfter: accessorTask })
    expect(getterCalled).toBe(false)

    const symbolTask = { ...task(), [Symbol('authority')]: true }
    expectEncodeRejected({ ...standaloneMaterialize(), taskAfter: symbolTask })
    expectEncodeRejected({ ...standaloneMaterialize(), taskAfter: { ...task(), tokens: 1n } })
    expectEncodeRejected({ ...standaloneMaterialize(), taskAfter: { ...task(), cost: Number.NaN } })
    expectEncodeRejected({ ...standaloneMaterialize(), taskAfter: { ...task(), cost: Infinity } })
    expectEncodeRejected({ ...standaloneMaterialize(), taskAfter: { ...task(), cost: -0 } })
    expectEncodeRejected({ ...standaloneMaterialize(), taskAfter: { ...task(), omitted: undefined } })

    let proxyReads = 0
    const proxyTask = new Proxy(task(), {
      get: (target, key, receiver) => {
        proxyReads += 1
        return Reflect.get(target, key, receiver)
      }
    })
    expectEncodeRejected({ ...standaloneMaterialize(), taskAfter: proxyTask })
    expect(proxyReads).toBe(0)
  })

  it('rejects cycles, sparse arrays, hidden properties, array extras, and forbidden keys', () => {
    const cyclic = { ...task() } as ScheduledTask & { self?: unknown }
    cyclic.self = cyclic
    expectEncodeRejected({ ...standaloneMaterialize(), taskAfter: cyclic })

    const sparse = new Array(2)
    sparse[1] = 'attachment'
    expectEncodeRejected({
      ...standaloneMaterialize(),
      taskAfter: { ...task(), imageAttachments: sparse }
    })

    const extraArray = [] as unknown[] & { surprise?: boolean }
    extraArray.surprise = true
    expectEncodeRejected({
      ...standaloneMaterialize(),
      taskAfter: { ...task(), imageAttachments: extraArray }
    })

    const hidden = { ...task() }
    Object.defineProperty(hidden, 'hiddenAuthority', { value: true, enumerable: false })
    expectEncodeRejected({ ...standaloneMaterialize(), taskAfter: hidden })

    const polluted = JSON.parse('{"safe":true,"__proto__":{"polluted":true}}') as object
    expectEncodeRejected({ ...standaloneMaterialize(), taskAfter: { ...task(), polluted } })
  })

  it('accepts large legitimate task images but rejects inputs over the 64 MiB bound', () => {
    const root = authorityRoot()
    const payload = standaloneMaterialize()
    const large = {
      ...payload,
      taskAfter: { ...payload.taskAfter, prompt: 'x'.repeat(2 * 1024 * 1024) }
    } as ScheduledOccurrenceMutationWalPayload
    const encoded = encodeScheduledOccurrenceMutationWal(root, large)
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(2 * 1024 * 1024)
    expect(decodeScheduledOccurrenceMutationWal(root, Buffer.from(encoded))?.taskAfter.prompt).toHaveLength(
      2 * 1024 * 1024
    )

    expect(
      decodeScheduledOccurrenceMutationWal(
        root,
        Buffer.alloc(SCHEDULED_OCCURRENCE_MUTATION_WAL_MAX_BYTES + 1, 0x20)
      )
    ).toBeNull()
    expect(
      decodeScheduledOccurrenceMutationWal(
        root,
        ' '.repeat(SCHEDULED_OCCURRENCE_MUTATION_WAL_MAX_BYTES + 1)
      )
    ).toBeNull()
  })

  it('fails closed after root disposal without persisting root secrets', () => {
    const root = authorityRoot(ROOT_ID, 'DO-NOT-PERSIST-THIS-ROOT-SECRET')
    const payload = standaloneMaterialize()
    const encoded = encodeScheduledOccurrenceMutationWal(root, payload)
    expect(encoded).not.toContain('DO-NOT-PERSIST-THIS-ROOT-SECRET')
    root.dispose()
    expect(decodeScheduledOccurrenceMutationWal(root, encoded)).toBeNull()
    expect(() => encodeScheduledOccurrenceMutationWal(root, payload)).toThrow(/disposed/)
  })

  it('accepts only raw canonical UTF-8 and never pre-parsed objects', () => {
    const root = authorityRoot()
    const encoded = encodeScheduledOccurrenceMutationWal(root, standaloneMaterialize())
    expect(
      decodeScheduledOccurrenceMutationWal(root, new Uint8Array(Buffer.from(encoded)))
    ).not.toBeNull()
    expect(
      decodeScheduledOccurrenceMutationWal(
        root,
        new Uint8Array(
          Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(encoded, 'utf8')])
        )
      )
    ).toBeNull()
    expect(decodeScheduledOccurrenceMutationWal(root, JSON.parse(encoded))).toBeNull()

    let getterCalled = false
    const envelope = JSON.parse(encoded) as Record<string, unknown>
    Object.defineProperty(envelope, 'walMac', {
      enumerable: true,
      get: () => {
        getterCalled = true
        return '0'.repeat(64)
      }
    })
    expect(decodeScheduledOccurrenceMutationWal(root, envelope)).toBeNull()
    expect(getterCalled).toBe(false)
  })
})
