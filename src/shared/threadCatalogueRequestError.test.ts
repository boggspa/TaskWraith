import { describe, expect, it } from 'vitest'

import {
  isThreadCatalogueRequestErrorCode,
  threadCatalogueRequestError,
  ThreadCatalogueRequestError
} from './threadCatalogueRequestError'

describe('ThreadCatalogueRequestError', () => {
  it('reconstructs only closed request-local codes with fixed messages', () => {
    const reconstructed = threadCatalogueRequestError({
      name: 'ThreadCatalogueRequestError',
      code: 'source_changed',
      message: 'untrusted worker detail'
    })

    expect(reconstructed).toMatchObject({
      name: 'ThreadCatalogueRequestError',
      code: 'source_changed',
      message: 'History changed during indexing.'
    })
    expect(
      threadCatalogueRequestError({ name: 'ThreadCatalogueRequestError', code: 'other' })
    ).toBe(null)
    expect(isThreadCatalogueRequestErrorCode('source_unsettled')).toBe(true)
  })

  it('keeps an erasure-invalidated lease distinct from retryable contention', () => {
    expect(new ThreadCatalogueRequestError('source_changed').retryable).toBe(true)
    expect(new ThreadCatalogueRequestError('lease_superseded').retryable).toBe(true)
    expect(new ThreadCatalogueRequestError('lease_erased').retryable).toBe(false)
  })
})
