import type { ChatListItem, ProviderId } from './types'
import type { ThreadCatalogueProjection } from './ThreadCatalogue'
import { catalogueEditBase } from '../../shared/threadCatalogueMerge'
import { ThreadCatalogueMirror as ProjectionMirror } from '../../host-shared/thread-catalogue/ThreadCatalogueMirror'
export type {
  ThreadCatalogueReadPort,
  ThreadCatalogueListPage
} from '../../host-shared/thread-catalogue/ThreadCatalogueMirror'
/** One-way adapter: no caller may save this display projection as canonical history. */
export function catalogueChatListItem(
  projection: ThreadCatalogueProjection,
  sourceWitness?: string
): ChatListItem {
  const s = projection.summary
  const row: ChatListItem = {
    ...s.chrome,
    appChatId: s.chatId,
    title: s.title,
    provider: s.provider as ProviderId,
    scope: s.scope,
    chatKind: s.chatKind,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    archived: s.archived,
    workspaceId: s.workspaceId,
    workspacePath: s.workspacePath,
    parentChatId: s.parentChatId,
    parentChatRelation: s.parentChatRelation,
    persistenceRevision: projection.revision,
    messages: [],
    runs: [],
    summaryOnly: true,
    catalogueProjection: true,
    cataloguePresentation: s.presentation,
    catalogueControl: s.control,
    catalogueViewKey: sourceWitness,
    messageCount: s.messageCount,
    runCount: s.runCount,
    // Thread wall time travels as a scalar because this row's `runs` is `[]`
    // above: without it the composer's TOTAL THREAD timecode has nothing to
    // measure and paints 00:00:00:00 over the thread's whole history.
    ...(s.runWallMs === undefined ? {} : { runWallMs: s.runWallMs }),
    lastRun: s.lastRun as ChatListItem['lastRun'],
    ensembleWakeupCount: projection.recovery.ensembleWakeups,
    soloWakeupCount: projection.recovery.soloWakeups
  }
  row.catalogueEditBase = catalogueEditBase(row)
  return row
}

export class ThreadCatalogueMirror extends ProjectionMirror {
  presentationPage(options: {
    workspaceId?: string
    parentChatId?: string
    before?: { updatedAt: number; chatId: string }
    limit?: number
  }) {
    const rows = this.projections()
      .filter(
        ({ summary: s }) =>
          (options.workspaceId === undefined || s.workspaceId === options.workspaceId) &&
          (options.parentChatId === undefined || s.parentChatId === options.parentChatId) &&
          (!options.before ||
            s.updatedAt < options.before.updatedAt ||
            (s.updatedAt === options.before.updatedAt && s.chatId > options.before.chatId))
      )
      .sort(
        (a, b) =>
          b.summary.updatedAt - a.summary.updatedAt ||
          (a.summary.chatId < b.summary.chatId ? -1 : a.summary.chatId > b.summary.chatId ? 1 : 0)
      )
    const entries: Array<{ projection: ThreadCatalogueProjection }> = []
    let bytes = 0
    for (const projection of rows) {
      const size = Buffer.byteLength(JSON.stringify(projection)) + 32
      if (
        entries.length >= Math.min(100, options.limit ?? 100) ||
        bytes + size > 2 * 1024 * 1024 - 4096
      )
        break
      entries.push({ projection })
      bytes += size
    }
    const last = entries.at(-1)?.projection.summary
    return {
      entries,
      next:
        entries.length < rows.length && last
          ? { updatedAt: last.updatedAt, chatId: last.chatId }
          : null,
      coverage: this.complete ? 'complete' : 'partial',
      repairPending: []
    }
  }

  list(workspaceId?: string): ChatListItem[] {
    return this.projections()
      .filter((row) => workspaceId === undefined || row.summary.workspaceId === workspaceId)
      .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)
      .map((row) => catalogueChatListItem(row, this.sourceWitnessFor(row.summary.chatId)))
  }
}
