import type { HostProfileThreadSummary } from '../host-runtime/HostProfileDomainStore'
import { hostCatalogueThreadSummary } from '../host-runtime/HostCatalogueThreadProjection'
import type { ThreadCatalogueMirror } from '../host-shared/thread-catalogue/ThreadCatalogueMirror'
import type { ThreadCatalogueClient } from '../host-shared/thread-catalogue/ThreadCatalogueClient'
import type {
  ThreadCatalogueRequestOptions,
  ThreadCatalogueReadQuery,
  ThreadCatalogueWireReply
} from '../shared/threadCatalogueProtocol'
import { threadCatalogueRequestError } from '../shared/threadCatalogueRequestError'

export { projectHostCatalogueThread } from '../host-runtime/HostCatalogueThreadProjection'

export function hostCatalogueSummaries(mirror: ThreadCatalogueMirror): HostProfileThreadSummary[] {
  return mirror.projections().map((projection) => hostCatalogueThreadSummary(projection))
}

export async function queryHostCatalogue(
  client: ThreadCatalogueClient,
  request: ThreadCatalogueReadQuery,
  options: ThreadCatalogueRequestOptions = {}
): Promise<ThreadCatalogueWireReply> {
  try {
    const data = await client.query(request, options)
    return {
      data:
        data instanceof Uint8Array
          ? { encoding: 'base64', bytes: Buffer.from(data).toString('base64') }
          : data
    }
  } catch (error) {
    const requestError = threadCatalogueRequestError(error)
    if (!requestError) throw error
    return { data: null, error: { code: requestError.code } }
  }
}
