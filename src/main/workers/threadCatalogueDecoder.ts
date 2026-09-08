import { copyThreadCatalogueControlFacts } from '../store/ThreadCatalogueChrome'
import {
  projectTaskWraithControlThread,
  projectTaskWraithControlThreadFacts
} from '../control/TaskWraithControlProjector'
import { harvestIntrospectionEvidence } from '../introspection/IntrospectionEvidenceHarvester'
import { messageActivityDayKey } from '../../shared/messageActivityAggregate'
import { projectCatalogueRemote } from '../store/ThreadCatalogueRemote'
import { parentPort } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { isSafeChatId } from '../ChatPath'
import {
  ThreadCatalogueDiskReader,
  projectThreadCatalogueRecord
} from '../store/ThreadCatalogueDiskReader'
import { encodeThreadJsonChunks } from '../store/ThreadCatalogueJson'
import { collectThreadCatalogueRecovery } from '../store/ThreadCatalogueRecovery'
import { prepareThreadCatalogueMutation } from '../store/ThreadCatalogueMutation'
import { projectThreadCatalogueRunSummary } from '../store/ThreadCatalogueRunSummary'
import type { ChatMessage, ChatRun } from '../store/types'
import type {
  ThreadIndexObjectFrame,
  ThreadIndexedObjectKind
} from '../store/ThreadCatalogueDatabase'
import {
  THREAD_DECODE_MAX_BATCH_BYTES,
  THREAD_DECODE_MAX_BATCH_FRAMES,
  type ThreadDecodeRequest,
  type ThreadPrepareRequest,
  type ThreadDecodeAcknowledgement,
  type ThreadDecodeMessage
} from '../store/ThreadCatalogueWorkerProtocol'

let activeRequest = 0
let acknowledge: ((message: ThreadDecodeAcknowledgement) => void) | null = null

function recordId(value: unknown, ordinal: number): string {
  if (typeof value !== 'string' || !value) return `ordinal-${ordinal}`
  return value.length <= 1024 ? value : `sha256-${createHash('sha256').update(value).digest('hex')}`
}

function preview(value: unknown, id: string): string {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const result: Record<string, string | number | boolean> = { id }
  for (const [key, maximum] of Object.entries({
    role: 32,
    content: 1024,
    timestamp: 64,
    runId: 512,
    status: 64,
    endedAt: 64,
    promptMessageId: 512
  })) {
    if (typeof record[key] === 'string') result[key] = (record[key] as string).slice(0, maximum)
  }
  if (typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp)))
    result.catalogueTimestamp = Date.parse(record.timestamp)
  if (typeof record.runId === 'string') {
    const ended = Date.parse(String(record.endedAt ?? ''))
    const started = Date.parse(String(record.startedAt ?? ''))
    result.catalogueActive =
      !['completed', 'success', 'succeeded', 'failed', 'error', 'cancelled', 'canceled'].includes(
        String(record.status ?? '').toLowerCase()
      ) && !Number.isFinite(ended)
    result.catalogueRecency = Number.isFinite(ended)
      ? ended
      : Number.isFinite(started)
        ? started
        : 0
  }
  let json = JSON.stringify(result)
  if (Buffer.byteLength(json) > 16 * 1024) {
    delete result.content
    json = JSON.stringify(result)
  }
  return json
}

async function decode(request: ThreadDecodeRequest): Promise<void> {
  let sequence = 0
  type WithoutSequence<T> = T extends unknown ? Omit<T, 'sequence'> : never
  const send = (
    message: WithoutSequence<Extract<ThreadDecodeMessage, { sequence: number }>>
  ): Promise<void> => {
    const next = ++sequence
    return new Promise((resolve, reject) => {
      acknowledge = (ack) => {
        if (ack.requestId !== request.requestId || ack.sequence !== next) return
        acknowledge = null
        if (ack.ok) resolve()
        else reject(new Error('Decode request cancelled'))
      }
      const complete = { ...message, sequence: next }
      const transfers: ArrayBuffer[] =
        message.type === 'frames'
          ? message.frames.flatMap((frame) =>
              frame.type === 'chunk' ? [frame.payload.buffer as ArrayBuffer] : []
            )
          : []
      parentPort!.postMessage(complete, transfers)
    })
  }
  const reader = new ThreadCatalogueDiskReader({
    ...request.options,
    ...request.readContext,
    defaultProvider: request.readContext?.defaultProvider ?? request.options.defaultProvider
  })
  const decoded = reader.read(request.chatId)
  if (!decoded) {
    parentPort!.postMessage({
      type: 'missing',
      requestId: request.requestId
    } satisfies ThreadDecodeMessage)
    return
  }
  const projection = projectThreadCatalogueRecord(decoded.persisted)
  if (!decoded.sourceComplete) projection.sourceComplete = false
  projection.summary.control = copyThreadCatalogueControlFacts(
    projectTaskWraithControlThreadFacts(decoded.persisted)
  )
  projection.summary.chrome = {
    ...projection.summary.chrome,
    sourceChatSize: decoded.source.sourceBytes
  }
  await send({
    type: 'begin',
    requestId: request.requestId,
    projection,
    source: decoded.source
  })

  let frames: ThreadIndexObjectFrame[] = []
  let batchBytes = 0
  const flush = async (): Promise<void> => {
    if (!frames.length) return
    const batch = frames
    frames = []
    batchBytes = 0
    await send({ type: 'frames', requestId: request.requestId, frames: batch })
  }
  const frame = async (value: ThreadIndexObjectFrame): Promise<void> => {
    const bytes =
      256 +
      (value.type === 'chunk'
        ? value.payload.byteLength
        : value.type === 'start'
          ? Buffer.byteLength(value.previewJson) + Buffer.byteLength(value.recordId)
          : 64)
    if (
      frames.length &&
      (batchBytes + bytes > THREAD_DECODE_MAX_BATCH_BYTES ||
        frames.length >= THREAD_DECODE_MAX_BATCH_FRAMES)
    )
      await flush()
    frames.push(value)
    batchBytes += bytes
  }
  const object = async (
    kind: ThreadIndexedObjectKind,
    ordinal: number,
    id: string,
    value: unknown
  ): Promise<void> => {
    await frame({ type: 'start', kind, ordinal, recordId: id, previewJson: preview(value, id) })
    let byteLength = 0
    let chunkNo = 0
    const hash = createHash('sha256')
    for (const payload of encodeThreadJsonChunks(value)) {
      hash.update(payload)
      byteLength += payload.byteLength
      await frame({ type: 'chunk', kind, ordinal, chunkNo: chunkNo++, payload })
    }
    await frame({ type: 'finish', kind, ordinal, byteLength, sha256: hash.digest('hex') })
  }
  const coverage: Partial<
    Record<ThreadIndexedObjectKind | 'run-locator' | 'message-activity', number>
  > = {}
  // Timestamp facts are indexed while this isolate already owns the record.
  // Null/summary-only facts preserve the dashboard's historical hasAny rule.
  const activityMessages = decoded.persisted.messages ?? []
  const activitySummary = decoded.persisted as typeof decoded.persisted & {
    summaryOnly?: boolean
    messageCount?: number
  }
  const summaryOnly = activitySummary.summaryOnly === true
  let invalidCount = 0
  let activityCount = 0
  let activity: Array<{
    ordinal: number
    timestamp: number | null
    dayKey: string
    count: number
    summaryOnly: boolean
  }> = []
  if (!summaryOnly)
    for (let ordinal = 0; ordinal < activityMessages.length; ordinal += 1) {
      const timestamp = new Date(activityMessages[ordinal].timestamp || '').getTime()
      if (!Number.isFinite(timestamp)) {
        invalidCount += 1
        continue
      }
      activity.push({
        ordinal: ordinal + 1,
        timestamp,
        dayKey: messageActivityDayKey(timestamp),
        count: 1,
        summaryOnly: false
      })
      activityCount += 1
      if (activity.length === 256) {
        await send({ type: 'activity', requestId: request.requestId, rows: activity })
        activity = []
      }
    }
  activity.push({
    ordinal: 0,
    timestamp: null,
    dayKey: '',
    count: summaryOnly ? Math.max(0, activitySummary.messageCount ?? 0) : invalidCount,
    summaryOnly
  })
  await send({ type: 'activity', requestId: request.requestId, rows: activity })
  if (decoded.sourceComplete) coverage['message-activity'] = activityCount + 1
  const runs: ChatRun[] = Array.isArray(decoded.chat.runs) ? decoded.chat.runs : []
  for (let start = 0; start < runs.length; start += 256) {
    await send({
      type: 'runs',
      requestId: request.requestId,
      runs: runs.slice(start, start + 256).map((run, index) => ({
        ordinal: start + index,
        runId: recordId(run?.runId, start + index)
      }))
    })
  }
  if (decoded.sourceComplete) coverage['run-locator'] = runs.length
  {
    for (let ordinal = 0; ordinal < runs.length; ordinal += 1)
      await object(
        'run-summary',
        ordinal,
        recordId(runs[ordinal]?.runId, ordinal),
        projectThreadCatalogueRunSummary(runs[ordinal])
      )
    coverage['run-summary'] = runs.length
  }
  if (decoded.sourceComplete) {
    const evidence = harvestIntrospectionEvidence({
      window: {
        windowStart: new Date(-8_640_000_000_000_000).toISOString(),
        windowEnd: new Date(8_640_000_000_000_000).toISOString()
      },
      substrate: { chats: [decoded.persisted] }
    })
    for (let ordinal = 0; ordinal < evidence.length; ordinal += 1)
      await object(
        'introspection',
        ordinal,
        recordId(evidence[ordinal].id, ordinal),
        evidence[ordinal]
      )
    coverage.introspection = evidence.length
  }
  const recovery = decoded.sourceComplete ? collectThreadCatalogueRecovery(decoded.chat) : []
  for (let index = 0; index < recovery.length; index += 1) {
    await object('recovery', index, recordId(recovery[index].id, index), recovery[index].value)
  }
  if (decoded.sourceComplete) coverage.recovery = recovery.length
  if (request.mode === 'control') {
    await object(
      'control',
      0,
      request.chatId,
      projectTaskWraithControlThread(
        decoded.chat,
        JSON.parse(request.projectionOptions ?? '{"limit":100}')
      )
    )
    coverage.control = 1
  }
  if (request.mode === 'remote') {
    await object(
      'remote',
      0,
      request.chatId,
      projectCatalogueRemote(
        decoded.chat,
        JSON.parse(request.projectionOptions ?? '{}'),
        (id) => reader.read(id)?.chat ?? null
      )
    )
    coverage.remote = 1
  }
  if (request.mode === 'pages') {
    const messages: ChatMessage[] = Array.isArray(decoded.chat.messages)
      ? decoded.chat.messages
      : []
    for (let index = 0; index < messages.length; index += 1) {
      await object('message', index, recordId(messages[index]?.id, index), messages[index])
    }
    coverage.message = messages.length
    for (let index = 0; index < runs.length; index += 1) {
      await object('run', index, recordId(runs[index]?.runId, index), runs[index])
    }
    coverage.run = runs.length
    const { messages: _messages, runs: _runs, ...chrome } = decoded.chat
    await object('shell', 0, request.chatId, {
      ...chrome,
      messages: [],
      runs: [],
      summaryOnly: true,
      transcriptPaged: true,
      messageCount: messages.length,
      runCount: runs.length
    })
    coverage.shell = 1
  } else if (request.mode === 'record') {
    await object('record', 0, request.chatId, decoded.chat)
    coverage.record = 1
  }
  await flush()
  parentPort!.postMessage({
    type: 'complete',
    requestId: request.requestId,
    source: decoded.source,
    coverage
  } satisfies ThreadDecodeMessage)
}

parentPort?.on(
  'message',
  (message: ThreadDecodeRequest | ThreadPrepareRequest | ThreadDecodeAcknowledgement) => {
    if (message.type === 'ack') {
      acknowledge?.(message)
      return
    }
    if (
      !['decode', 'prepare'].includes(message.type) ||
      activeRequest ||
      !Number.isSafeInteger(message.requestId) ||
      message.requestId < 1 ||
      !isSafeChatId(message.chatId) ||
      (message.type === 'decode' &&
        !['metadata', 'pages', 'record', 'runs', 'remote', 'control'].includes(message.mode))
    ) {
      if (Number.isSafeInteger(message.requestId))
        parentPort!.postMessage({
          type: 'error',
          requestId: message.requestId,
          reason: 'unreadable',
          message: 'Invalid or concurrent history decoder request'
        } satisfies ThreadDecodeMessage)
      return
    }
    activeRequest = message.requestId
    const execute = async (): Promise<void> => {
      if (message.type === 'decode') return decode(message)
      const prepared = prepareThreadCatalogueMutation(message.options, message)
      parentPort!.postMessage({
        type: 'prepared',
        requestId: message.requestId,
        prepared
      } satisfies ThreadDecodeMessage)
    }
    void execute()
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : ''
        parentPort!.postMessage({
          type: 'error',
          requestId: message.requestId,
          reason: text.includes('changed')
            ? 'changed'
            : text.includes('cancelled')
              ? 'cancelled'
              : 'unreadable',
          message: text.includes('changed')
            ? 'History changed during indexing'
            : 'History indexing did not complete'
        } satisfies ThreadDecodeMessage)
      })
      .finally(() => {
        activeRequest = 0
        acknowledge = null
      })
  }
)
