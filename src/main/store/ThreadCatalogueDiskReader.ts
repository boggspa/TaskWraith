import * as fs from 'node:fs'
import * as path from 'node:path'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { createSegmentedChatStore } from './SegmentedChatStore'
import { ChatComposerSelectionOverlayStore } from './ChatComposerSelectionOverlayPersistence'
import { readCanonicalCatalogueChat } from './ThreadCatalogueCanonicalRead'
import { normalizeCatalogueChatRecord } from './ThreadCatalogueNormalize'
import type { ChatRecord, ProviderId } from './types'
import { ThreadCatalogueRequestError } from '../../shared/threadCatalogueRequestError'

export {
  captureThreadCatalogueWitness,
  flushThreadCatalogueSources
} from '../../host-shared/thread-catalogue/ThreadCatalogueWitness'
export type {
  ThreadCatalogueReaderOptions,
  ThreadCatalogueSourceWitness
} from '../../host-shared/thread-catalogue/ThreadCatalogueWitness'
import {
  captureThreadCatalogueWitness,
  type ThreadCatalogueReaderOptions,
  type ThreadCatalogueSourceWitness
} from '../../host-shared/thread-catalogue/ThreadCatalogueWitness'
export interface ThreadCatalogueDecodedChat {
  sourceComplete: boolean
  chat: ChatRecord
  /** Persisted winner before runtime defaults, with the revision-transparent composer overlay. */
  persisted: ChatRecord
  source: ThreadCatalogueSourceWitness
}

/** Decoder-isolate only: this class deliberately owns all legacy full-record decoding. */

export class ThreadCatalogueDiskReader {
  constructor(readonly options: ThreadCatalogueReaderOptions) {
    if (!path.isAbsolute(options.profilePath) || !options.runtimeInstanceId)
      throw new Error('Invalid history reader configuration')
  }

  read(chatId: string): ThreadCatalogueDecodedChat | null {
    const before = captureThreadCatalogueWitness(this.options, chatId)
    if (!before.legacyExists) return null
    const journal = createIncrementalChatJournal(
      path.join(this.options.profilePath, 'chat-journal-v2'),
      {
        canWrite: () => false,
        canRepairOnRead: () => false
      }
    )
    const segmented = createSegmentedChatStore(
      path.join(this.options.profilePath, 'chat-store-v2'),
      {
        enabled: () => this.options.segmented,
        canWrite: () => false,
        canRepairOnRead: () => false
      }
    )
    const originals = new WeakMap<ChatRecord, ChatRecord>()
    let incomplete = false
    const chat = readCanonicalCatalogueChat({
      chatId,
      legacyFileExists: true,
      normalize: (raw) => {
        const normalized = normalizeCatalogueChatRecord(
          raw,
          () => this.options.defaultProvider as ProviderId | undefined,
          this.options.runtimeInstanceId
        )
        originals.set(normalized, raw)
        return normalized
      },
      readLegacy: () => {
        try {
          const value = JSON.parse(
            fs.readFileSync(path.join(this.options.profilePath, 'chats', `${chatId}.json`), 'utf8')
          )
          return value?.appChatId === chatId ? (value as ChatRecord) : null
        } catch {
          incomplete = true
          return null
        }
      },
      readIncremental: () => {
        const record = journal.replay(chatId).record
        if (
          !record &&
          (journal.pendingReplayState(chatId).hasTail ||
            fs.existsSync(
              path.join(this.options.profilePath, 'chat-journal-v2', `${chatId}.checkpoint.json`)
            ))
        )
          incomplete = true
        return record
      },
      pendingReplayState: () => journal.pendingReplayState(chatId),
      ...(this.options.segmented
        ? { readSegmented: () => segmented.readFull(chatId)?.record ?? null }
        : {}),
      // Errors are reported by the job boundary without echoing transcript parse context.
      logger: {
        warn: () => {},
        error: () => {
          incomplete = true
        }
      }
    })
    if (!chat) throw new Error('Historical chat record could not be decoded')
    const overlay = new ChatComposerSelectionOverlayStore(
      path.join(this.options.profilePath, 'chats')
    )
    const canonical = overlay.apply(chat)
    const persisted = overlay.apply(originals.get(chat) ?? chat)
    const after = captureThreadCatalogueWitness(this.options, chatId)
    if (before.witness !== after.witness) throw new ThreadCatalogueRequestError('source_changed')
    return { chat: canonical, persisted, source: after, sourceComplete: !incomplete }
  }
}

export { projectThreadCatalogueRecord } from './ThreadCatalogueFromRecord'
