import {
  emptyMessageActivity,
  type MessageActivityProvider
} from '../../shared/messageActivityAggregate'
import type { ThreadCatalogueActivityPage } from '../../shared/threadCatalogueTypes'
import type { ThreadCatalogueReadPort } from '../store/ThreadCatalogueMirror'

/** The full-chat reference runs in the decoder; main combines day totals only. */
export function createThreadCatalogueMessageActivity(
  port: ThreadCatalogueReadPort
): MessageActivityProvider {
  return async (request) => {
    const aggregate = emptyMessageActivity()
    const lifetimeDays = new Set<string>()
    const rangeDays = new Set<string>()
    const rangeChats = new Set<string>()
    let after: ThreadCatalogueActivityPage['next'] = null
    do {
      const page = await port.query<ThreadCatalogueActivityPage>({
        method: 'message-activity',
        request,
        ...(after ? { after } : {})
      })
      if (page.coverage !== 'complete') throw new Error('Message activity is still indexing')
      for (const row of page.rows) {
        aggregate.hasAnyMessage ||= row.hasAny
        if (row.lifetimeCount > 0) lifetimeDays.add(row.dayKey)
        if (row.rangeCount > 0) {
          aggregate.rangeMessageCount += row.rangeCount
          rangeDays.add(row.dayKey)
          rangeChats.add(row.chatId)
        }
      }
      if (page.next && after && JSON.stringify(page.next) === JSON.stringify(after))
        throw new Error('Message activity cursor did not advance')
      after = page.next
    } while (after)
    aggregate.lifetimeDayKeys = [...lifetimeDays].sort()
    aggregate.rangeDayKeys = [...rangeDays].sort()
    aggregate.rangeChatIds = [...rangeChats].sort()
    return aggregate
  }
}
