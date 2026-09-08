import type { IntrospectionEvidenceItem } from '../store/types'
import type { IntrospectionHarvestWindow } from '../introspection/IntrospectionEvidenceHarvester'
import type { ThreadCatalogueMirror } from '../store/ThreadCatalogueMirror'
import type { ThreadIndexedObject } from '../../shared/threadCatalogueTypes'

/** Matching ran on complete messages in the decoder, including the preceding role. */
export async function catalogueIntrospectionEvidence(
  mirror: ThreadCatalogueMirror,
  window: IntrospectionHarvestWindow
): Promise<IntrospectionEvidenceItem[]> {
  type Page = {
    items: ThreadIndexedObject[]
    next: { chatId: string; ordinal: number } | null
    coverage: 'complete' | 'partial'
  }
  const evidence: IntrospectionEvidenceItem[] = []
  let after: Page['next'] = null
  for (;;) {
    const page = await mirror.port.query<Page>({
      method: 'introspection',
      window,
      ...(after ? { after } : {})
    })
    if (page.coverage !== 'complete') {
      if (mirror.status.failed || mirror.status.error)
        throw new Error('Introspection source history is unavailable')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500)
        timer.unref?.()
      })
      continue
    }
    for (const item of page.items) {
      if (item.kind !== 'inline')
        throw new Error('Introspection evidence item exceeds the read budget')
      evidence.push(item.value as IntrospectionEvidenceItem)
    }
    if (
      after &&
      page.next &&
      after.chatId === page.next.chatId &&
      after.ordinal === page.next.ordinal
    )
      throw new Error('Introspection evidence cursor did not advance')
    after = page.next
    if (!after) break
  }
  return evidence
}
