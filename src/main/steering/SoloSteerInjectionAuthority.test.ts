import { describe, expect, it } from 'vitest'
import { midRunQueuedMessageId } from '../../shared/midRunSteeringQueue'
import type { ChatMessage, RunQueueJob, RunQueueRequestSnapshot } from '../store/types'
import { resolveSoloSteerInjectionAuthority } from './SoloSteerInjectionAuthority'

const RUN_ID = 'queued-run-1'
const CHAT_ID = 'chat-1'
const OWNER_TOKEN = 'owner-1'
const MESSAGE_ID = midRunQueuedMessageId(RUN_ID)

const request = (): RunQueueRequestSnapshot => ({
  scope: 'workspace',
  prompt: 'Inspect the exact retry path.',
  displayPrompt: 'Inspect the exact retry path.',
  selectedModelType: 'default',
  customModel: '',
  approvalMode: 'default',
  sessionTrust: false,
  imageAttachments: []
})

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: MESSAGE_ID,
  role: 'user',
  content: '  Inspect the exact retry path.  ',
  timestamp: '2026-08-26T21:30:00.000Z',
  metadata: {
    kind: 'midRunSteering',
    midRunQueueRunId: RUN_ID,
    midRunQueueSource: 'soloSteer',
    imageAttachments: []
  },
  ...overrides
})

const job = (overrides: Partial<RunQueueJob> = {}): RunQueueJob => ({
  id: RUN_ID,
  runId: RUN_ID,
  provider: 'codex',
  chatId: CHAT_ID,
  workspacePath: '/repo',
  source: 'manual',
  status: 'steer_promoting',
  priority: 0,
  attempt: 1,
  request: request(),
  promotionOwnerToken: OWNER_TOKEN,
  promotionToken: OWNER_TOKEN,
  promotionAttempt: 1,
  transitionVersion: 1,
  promotedAt: '2026-08-26T21:30:01.000Z',
  queueMessageId: MESSAGE_ID,
  createdAt: '2026-08-26T21:29:00.000Z',
  updatedAt: '2026-08-26T21:30:01.000Z',
  ...overrides
})

const resolve = (
  overrides: Partial<Parameters<typeof resolveSoloSteerInjectionAuthority>[0]> = {}
) =>
  resolveSoloSteerInjectionAuthority({
    queuedRunId: RUN_ID,
    chatId: CHAT_ID,
    provider: 'codex',
    ownerToken: OWNER_TOKEN,
    job: job({
      steerPreparationKind: 'solo_steer_transcript_barrier'
    }),
    messages: [message()],
    ...overrides
  })

describe('resolveSoloSteerInjectionAuthority', () => {
  it('verifies a first-write transcript barrier without changing its authority model', () => {
    const queuedJob = job({
      steerPreparationKind: 'solo_steer_transcript_barrier'
    })
    const transcriptMessage = message()

    const result = resolve({ job: queuedJob, messages: [transcriptMessage] })

    expect(result).toEqual({
      kind: 'verified',
      jobClass: 'prepared-transcript-barrier',
      job: queuedJob,
      request: queuedJob.request,
      message: transcriptMessage,
      messageId: MESSAGE_ID,
      text: 'Inspect the exact retry path.'
    })
  })

  it('verifies an ordinary durable queued job promoted by main', () => {
    const queuedJob = job({
      enqueuedAt: '2026-08-26T21:29:00.000Z'
    })

    expect(resolve({ job: queuedJob })).toMatchObject({
      kind: 'verified',
      jobClass: 'promoted-queued-job',
      job: queuedJob,
      request: queuedJob.request,
      messageId: MESSAGE_ID,
      text: 'Inspect the exact retry path.'
    })
  })

  it('injects the authoritative request prompt instead of a transcript display preview', () => {
    const queuedJob = job({
      steerPreparationKind: 'solo_steer_transcript_barrier',
      request: {
        ...request(),
        prompt: 'Use the exact durable provider instruction.',
        displayPrompt: 'Review the attached design.',
        imageAttachments: [
          {
            id: 'image-1',
            name: 'design.png',
            path: '/repo/design.png'
          }
        ]
      }
    })
    const transcriptMessage = message({ content: 'Review the attached design.' })

    expect(resolve({ job: queuedJob, messages: [transcriptMessage] })).toMatchObject({
      kind: 'verified',
      request: queuedJob.request,
      message: transcriptMessage,
      text: 'Use the exact durable provider instruction.'
    })
  })

  it('uses the verified transcript summary for a context-only request', () => {
    const queuedJob = job({
      steerPreparationKind: 'solo_steer_transcript_barrier',
      request: {
        ...request(),
        prompt: '   ',
        displayPrompt: 'Attached design.png',
        imageAttachments: [
          {
            id: 'image-1',
            name: 'design.png',
            path: '/repo/design.png'
          }
        ]
      }
    })
    const transcriptMessage = message({ content: '  Attached design.png  ' })

    expect(resolve({ job: queuedJob, messages: [transcriptMessage] })).toMatchObject({
      kind: 'verified',
      request: queuedJob.request,
      message: transcriptMessage,
      text: 'Attached design.png'
    })
  })

  it.each([
    ['wrong status', { status: 'queued' as const }],
    ['wrong run', { runId: 'another-run' }],
    ['wrong chat', { chatId: 'another-chat' }],
    ['wrong provider', { provider: 'claude' as const }]
  ])('rejects %s before trusting promotion metadata', (_label, patch) => {
    expect(
      resolve({ job: job({ ...patch, steerPreparationKind: 'solo_steer_transcript_barrier' }) })
    ).toEqual({ kind: 'invalid', reason: 'job_identity_mismatch' })
  })

  it.each([
    ['wrong queue message', { queueMessageId: 'queued-row-renderer-id' }],
    ['wrong owner', { promotionOwnerToken: 'another-owner' }],
    ['wrong promotion token', { promotionToken: 'another-owner' }],
    ['missing promoted time', { promotedAt: undefined }],
    ['missing promotion attempt', { promotionAttempt: undefined }],
    ['missing transition version', { transitionVersion: undefined }]
  ])('rejects %s', (_label, patch) => {
    expect(
      resolve({ job: job({ ...patch, steerPreparationKind: 'solo_steer_transcript_barrier' }) })
    ).toEqual({ kind: 'invalid', reason: 'invalid_promotion_authority' })
  })

  it('requires durable queued provenance for an ordinary promoted job', () => {
    expect(resolve({ job: job() })).toEqual({
      kind: 'invalid',
      reason: 'invalid_job_origin'
    })
  })

  it('rejects unknown preparation markers instead of treating them as ordinary queue provenance', () => {
    const forged = job({
      enqueuedAt: '2026-08-26T21:29:00.000Z',
      steerPreparationKind: 'renderer_claimed_barrier' as RunQueueJob['steerPreparationKind']
    })

    expect(resolve({ job: forged })).toEqual({
      kind: 'invalid',
      reason: 'invalid_job_origin'
    })
  })

  it('requires the exact persisted request snapshot', () => {
    expect(
      resolve({
        job: job({ request: undefined, steerPreparationKind: 'solo_steer_transcript_barrier' })
      })
    ).toEqual({ kind: 'invalid', reason: 'missing_request' })
  })

  it.each([
    ['missing row', []],
    ['duplicate id', [message(), message({ content: 'A second candidate.' })]],
    ['wrong role', [message({ role: 'system' })]],
    ['empty content', [message({ content: '   ' })]],
    ['non-string content', [message({ content: null as unknown as string })]],
    [
      'wrong kind',
      [
        message({
          metadata: { kind: 'ordinary', midRunQueueRunId: RUN_ID, midRunQueueSource: 'soloSteer' }
        })
      ]
    ],
    [
      'wrong metadata run',
      [
        message({
          metadata: {
            kind: 'midRunSteering',
            midRunQueueRunId: 'another-run',
            midRunQueueSource: 'soloSteer'
          }
        })
      ]
    ],
    [
      'wrong metadata source',
      [
        message({
          metadata: {
            kind: 'midRunSteering',
            midRunQueueRunId: RUN_ID,
            midRunQueueSource: 'scheduledRun'
          }
        })
      ]
    ]
  ])('rejects an invalid transcript correlation: %s', (_label, messages) => {
    expect(resolve({ messages })).toEqual({
      kind: 'invalid',
      reason: 'invalid_transcript_row'
    })
  })

  it('does not let unrelated transcript rows affect an exact match', () => {
    const exact = message()
    const result = resolve({
      messages: [
        message({ id: 'some-other-row', role: 'assistant' }),
        exact,
        message({ id: midRunQueuedMessageId('another-run') })
      ]
    })

    expect(result.kind).toBe('verified')
    if (result.kind === 'verified') expect(result.message).toBe(exact)
  })

  it.each([
    ['queuedRunId', { queuedRunId: '   ' }],
    ['chatId', { chatId: '' }],
    ['provider', { provider: '' as 'codex' }],
    ['ownerToken', { ownerToken: '\t' }]
  ])('rejects an empty %s', (_label, patch) => {
    expect(resolve(patch)).toEqual({ kind: 'invalid', reason: 'invalid_input' })
  })
})
