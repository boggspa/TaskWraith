import { createHash } from 'node:crypto'
import type { ThreadCatalogueMirror } from '../store/ThreadCatalogueMirror'
import type {
  ThreadCatalogueOpenResult,
  ThreadIndexedObject
} from '../../shared/threadCatalogueTypes'
import {
  clampTaskWraithControlThreadLimit,
  type TaskWraithControlThreadProjection,
  type TaskWraithControlThreadProjectionProvider
} from '../../shared/taskWraithControlProjection'

/** A selected pane is a lazy, bounded worker view; a revision alone is not a source witness. */
export function createCatalogueControlProjection(
  getMirror: () => ThreadCatalogueMirror | null
): TaskWraithControlThreadProjectionProvider {
  const held = new Map<string, { witness: string; limit: number; revision: number }>()
  return async (request) => {
    const mirror = getMirror()
    if (!mirror) throw new Error('History is starting')
    const limit = clampTaskWraithControlThreadLimit(request.limit)
    const current = await mirror.port.query<{ sourceWitness: string } | null>({
      method: 'summary',
      chatId: request.threadId
    })
    const prior = held.get(request.threadId)
    if (
      prior &&
      request.knownRevision &&
      prior.revision === request.knownRevision &&
      prior.limit === limit &&
      prior.witness === current?.sourceWitness
    )
      return { kind: 'unchanged', revision: prior.revision }
    const opened = await mirror.port.query<ThreadCatalogueOpenResult | null>({
      method: 'open',
      chatId: request.threadId,
      mode: 'control',
      projectionOptions: JSON.stringify({ limit })
    })
    if (!opened) {
      held.delete(request.threadId)
      return { kind: 'missing' }
    }
    try {
      const rows = await mirror.port.query<ThreadIndexedObject[] | null>({
        method: 'objects',
        leaseId: opened.leaseId,
        kind: 'control',
        maxObjects: 1,
        maxBytes: 2 * 1024 * 1024
      })
      const row = rows?.[0]
      if (!row) throw new Error('Control projection is unavailable')
      let value: unknown
      if (row.kind === 'inline') value = row.value
      else {
        // This is a fixed-size display DTO (200 bounded previews), not a chat
        // record. Keep each wire read bounded even for multibyte previews.
        if (row.reference.byteLength > 8 * 1024 * 1024)
          throw new Error('Control projection exceeds its display budget')
        const chunks: Buffer[] = []
        const hash = createHash('sha256')
        let offset = 0
        while (offset < row.reference.byteLength) {
          const bytes = await mirror.port.query<Uint8Array>({
            method: 'chunk',
            leaseId: opened.leaseId,
            reference: row.reference,
            offset,
            maximum: 48 * 1024
          })
          if (!bytes?.byteLength) throw new Error('Control projection is incomplete')
          const chunk = Buffer.from(bytes)
          chunks.push(chunk)
          hash.update(chunk)
          offset += chunk.byteLength
        }
        if (offset !== row.reference.byteLength || hash.digest('hex') !== row.reference.sha256)
          throw new Error('Control projection changed')
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }
      const projection = value as TaskWraithControlThreadProjection
      held.set(request.threadId, {
        witness: opened.entry.sourceWitness,
        limit,
        revision: projection.revision
      })
      if (held.size > 512) held.delete(held.keys().next().value!)
      return { kind: 'projection', projection }
    } finally {
      await mirror.port.query({ method: 'release', leaseId: opened.leaseId })
    }
  }
}
