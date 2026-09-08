import { ThreadCatalogueSourcePublisher as SourcePublisher } from '../../host-shared/thread-catalogue/ThreadCatalogueSourcePublisher'
import { projectThreadCatalogueRecord } from './ThreadCatalogueFromRecord'
import type { ChatRecord } from './types'
export class ThreadCatalogueSourcePublisher extends SourcePublisher<ChatRecord> {
  constructor(
    options: Omit<ConstructorParameters<typeof SourcePublisher<ChatRecord>>[0], 'project'>
  ) {
    super({ ...options, project: projectThreadCatalogueRecord })
  }
}
