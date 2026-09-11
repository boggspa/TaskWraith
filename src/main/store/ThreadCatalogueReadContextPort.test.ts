import { describe, expect, it } from 'vitest'
import { withThreadCatalogueReadContext } from './ThreadCatalogueReadContextPort'
import type { ThreadCatalogueReadPort } from './ThreadCatalogueMirror'

function recordingTransport(): {
  transport: ThreadCatalogueReadPort
  calls: { query: { method: string; readContext?: unknown }; options?: unknown }[]
} {
  const calls: { query: { method: string; readContext?: unknown }; options?: unknown }[] = []
  const transport: ThreadCatalogueReadPort = {
    query: async <T>(query: unknown, options?: unknown): Promise<T> => {
      calls.push({ query: query as { method: string }, options })
      return null as T
    }
  }
  return { transport, calls }
}

const readContext = (): never =>
  ({ runtimeInstanceId: 'runtime', defaultProvider: 'claude' }) as never

describe('withThreadCatalogueReadContext', () => {
  it('stamps the read context onto an open', async () => {
    const { transport, calls } = recordingTransport()
    const port = withThreadCatalogueReadContext(transport, readContext)

    await port.query({ method: 'open', chatId: 'chat-1', mode: 'metadata' } as never)

    expect(calls[0].query.readContext).toEqual({
      runtimeInstanceId: 'runtime',
      defaultProvider: 'claude'
    })
  })

  it('leaves every other query alone', async () => {
    const { transport, calls } = recordingTransport()
    const port = withThreadCatalogueReadContext(transport, readContext)

    await port.query({ method: 'summary', chatId: 'chat-1' } as never)

    expect(calls[0].query).toEqual({ method: 'summary', chatId: 'chat-1' })
  })

  // The defect this file exists for: the wrapper took one parameter, so the
  // recovery drain's lane never reached the client and the whole priority
  // change was inert in production while its own tests passed.
  it('forwards the request lane on an open', async () => {
    const { transport, calls } = recordingTransport()
    const port = withThreadCatalogueReadContext(transport, readContext)

    await port.query({ method: 'open', chatId: 'chat-1', mode: 'metadata' } as never, {
      priority: 'background'
    })

    expect(calls[0].options).toEqual({ priority: 'background' })
  })

  it('forwards the request lane on a non-open query too', async () => {
    const { transport, calls } = recordingTransport()
    const port = withThreadCatalogueReadContext(transport, readContext)

    await port.query({ method: 'objects', chatId: 'chat-1' } as never, {
      priority: 'background'
    })

    expect(calls[0].options).toEqual({ priority: 'background' })
  })

  it('passes nothing along when the caller named no lane', async () => {
    const { transport, calls } = recordingTransport()
    const port = withThreadCatalogueReadContext(transport, readContext)

    await port.query({ method: 'summary', chatId: 'chat-1' } as never)

    expect(calls[0].options).toBeUndefined()
  })
})
