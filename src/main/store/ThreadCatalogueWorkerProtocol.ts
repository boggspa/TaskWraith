import type { ThreadCatalogueReadContext } from '../../shared/threadCatalogueTypes'
import type { ThreadCatalogueProjection } from './ThreadCatalogue'
import type {
  ThreadCatalogueReaderOptions,
  ThreadCatalogueSourceWitness
} from './ThreadCatalogueDiskReader'
import type { ThreadIndexObjectFrame, ThreadIndexedObjectKind } from './ThreadCatalogueDatabase'
import type { PreparedThreadMutation, ThreadCatalogueMutation } from './ThreadCatalogueMutation'
import type { ThreadCatalogueEpoch, ThreadCatalogueSourceHeads } from './ThreadCatalogue'
import { threadCatalogueRequestError } from '../../shared/threadCatalogueRequestError'

export type ThreadDecodeMode = 'metadata' | 'pages' | 'record' | 'runs' | 'remote' | 'control'

export interface ThreadDecodeRequest {
  type: 'decode'
  requestId: number
  chatId: string
  mode: ThreadDecodeMode
  projectionOptions?: string
  readContext?: ThreadCatalogueReadContext
  options: ThreadCatalogueReaderOptions
}

export interface ThreadPrepareRequest {
  type: 'prepare'
  requestId: number
  chatId: string
  options: ThreadCatalogueReaderOptions
  sourceWitness: string
  epoch: ThreadCatalogueEpoch
  heads: ThreadCatalogueSourceHeads
  mutation: ThreadCatalogueMutation
}

export type ThreadDecodeMessage =
  | { type: 'prepared'; requestId: number; prepared: PreparedThreadMutation | null }
  | {
      type: 'begin'
      requestId: number
      sequence: number
      projection: ThreadCatalogueProjection
      source: ThreadCatalogueSourceWitness
    }
  | {
      type: 'activity'
      requestId: number
      sequence: number
      rows: Array<{
        ordinal: number
        timestamp: number | null
        dayKey: string
        count: number
        summaryOnly: boolean
      }>
    }
  | { type: 'frames'; requestId: number; sequence: number; frames: ThreadIndexObjectFrame[] }
  | {
      type: 'runs'
      requestId: number
      sequence: number
      runs: Array<{ ordinal: number; runId: string }>
    }
  | {
      type: 'complete'
      requestId: number
      source: ThreadCatalogueSourceWitness
      coverage: Partial<
        Record<ThreadIndexedObjectKind | 'run-locator' | 'message-activity', number>
      >
    }
  | { type: 'missing'; requestId: number }
  | {
      type: 'error'
      requestId: number
      reason: 'changed' | 'unreadable' | 'cancelled'
      message: string
    }

export interface ThreadDecodeAcknowledgement {
  type: 'ack'
  requestId: number
  sequence: number
  ok: boolean
}

export const THREAD_DECODE_MAX_BATCH_BYTES = 256 * 1024
export const THREAD_DECODE_MAX_BATCH_FRAMES = 256

export function classifyThreadDecodeError(
  error: unknown
): Pick<Extract<ThreadDecodeMessage, { type: 'error' }>, 'reason' | 'message'> {
  const requestError = threadCatalogueRequestError(error)
  if (requestError?.code === 'source_changed') {
    return { reason: 'changed', message: 'History changed during indexing' }
  }
  const text = error instanceof Error ? error.message : ''
  return {
    reason: text.includes('cancelled') ? 'cancelled' : 'unreadable',
    message: 'History indexing did not complete'
  }
}
