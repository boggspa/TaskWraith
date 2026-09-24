import type { ThreadCatalogueMirror } from '../store/ThreadCatalogueMirror'
import type {
  CatalogueRemoteOptions,
  CatalogueRemoteProjection
} from '../store/ThreadCatalogueRemote'
import type {
  ThreadCatalogueOpenResult,
  ThreadIndexedObject
} from '../../shared/threadCatalogueTypes'

/** Bounded display projections are populated asynchronously; no canonical read occurs here. */
export class ThreadCatalogueRemoteCache {
  private readonly entries = new Map<string, { key: string; value: CatalogueRemoteProjection }>()
  private subscribed = false
  private readonly pending = new Set<string>()
  constructor(
    private readonly mirror: () => ThreadCatalogueMirror | null,
    private readonly changed: () => void
  ) {}

  get(chatId: string, options: CatalogueRemoteOptions): CatalogueRemoteProjection | undefined {
    const mirror = this.mirror()
    if (!mirror || !mirror.get(chatId)) {
      this.entries.delete(chatId)
      return undefined
    }
    if (!this.subscribed) {
      this.subscribed = true
      mirror.subscribe((row, id) => {
        if (!row) this.entries.delete(id)
      })
    }
    const projectionOptions: CatalogueRemoteOptions = options.includeViewport
      ? options
      : { includeViewport: false }
    const key = JSON.stringify([
      mirror.sourceWitnessFor(chatId),
      mirror.get(chatId)?.revision,
      mirror.get(chatId)?.summary.updatedAt,
      projectionOptions
    ])
    const cached = this.entries.get(chatId)
    if (cached?.key === key) return cached.value
    if (!this.pending.has(chatId)) {
      this.pending.add(chatId)
      void this.load(mirror, chatId, key, projectionOptions)
        .catch(() => undefined)
        .finally(() => this.pending.delete(chatId))
    }
    return undefined
  }

  private async load(
    mirror: ThreadCatalogueMirror,
    chatId: string,
    key: string,
    options: CatalogueRemoteOptions
  ): Promise<void> {
    const opened = await mirror.port.query<ThreadCatalogueOpenResult | null>({
      method: 'open',
      chatId,
      mode: 'remote',
      projectionOptions: JSON.stringify(options)
    })
    if (!opened || opened.entry.snapshot) return
    try {
      const rows = await mirror.port.query<ThreadIndexedObject[] | null>({
        method: 'objects',
        leaseId: opened.leaseId,
        kind: 'remote',
        maxObjects: 1,
        maxBytes: 2 * 1024 * 1024
      })
      if (rows?.[0]?.kind !== 'inline')
        throw new Error('Remote history projection exceeds its display budget')
      const current = await mirror.port.query<{ sourceWitness: string } | null>({
        method: 'summary',
        chatId
      })
      if (
        mirror.sourceWitnessFor(chatId) !== opened.entry.sourceWitness ||
        current?.sourceWitness !== opened.entry.sourceWitness
      )
        return
      this.entries.set(chatId, { key, value: rows[0].value as CatalogueRemoteProjection })
      // Derived projections are disposable; old/deleted chats cannot be read
      // from this cache because get requires current mirror identity below.
      for (const id of this.entries.keys()) if (!mirror.get(id)) this.entries.delete(id)
      this.changed()
    } finally {
      await mirror.port.query({ method: 'release', leaseId: opened.leaseId })
    }
  }
}
