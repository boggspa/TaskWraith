import type { ThreadCatalogueReadQuery } from '../../shared/threadCatalogueProtocol'
import type { ThreadCatalogueReadContext } from '../../shared/threadCatalogueTypes'
import type { ThreadCatalogueReadPort } from './ThreadCatalogueMirror'

/**
 * Stamp the caller's read context onto every `open`, and forward everything
 * else — including the request's LANE — untouched.
 *
 * Extracted from `installThreadCatalogue` for one reason: this wrapper sits
 * between `ThreadCatalogueMirror`/`ThreadCatalogueRecovery` and the worker
 * client, it declared a single parameter, and it therefore silently dropped
 * the `{ priority: 'background' }` the recovery drain passes. The optional
 * second parameter on `ThreadCatalogueReadPort.query` makes a one-argument
 * implementation assignable, so nothing in the type system objected and the
 * whole priority lane was inert in production while its tests were green —
 * they stubbed a port that forwarded more than the real one did.
 *
 * A wrapper that forwards is not worth a file on its own. A wrapper that
 * forwards *and had no test* is, because the next argument added here would go
 * the same way.
 */
export function withThreadCatalogueReadContext(
  transport: ThreadCatalogueReadPort,
  readContext: () => ThreadCatalogueReadContext
): ThreadCatalogueReadPort {
  return {
    query: <T>(
      query: ThreadCatalogueReadQuery,
      options?: { priority?: 'foreground' | 'background' }
    ): Promise<T> =>
      transport.query<T>(
        query.method === 'open' ? { ...query, readContext: readContext() } : query,
        options
      )
  }
}
