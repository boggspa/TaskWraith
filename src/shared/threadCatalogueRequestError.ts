export const THREAD_CATALOGUE_REQUEST_ERROR_CODES = [
  'source_unsettled',
  'source_changed',
  'lease_expired',
  'lease_superseded',
  'lease_erased'
] as const

export type ThreadCatalogueRequestErrorCode = (typeof THREAD_CATALOGUE_REQUEST_ERROR_CODES)[number]

const messages: Record<ThreadCatalogueRequestErrorCode, string> = {
  source_unsettled: 'History source is not yet verified for indexing.',
  source_changed: 'History changed during indexing.',
  lease_expired: 'History page lease expired.',
  lease_superseded: 'History recovery page was superseded.',
  lease_erased: 'History page was invalidated by erasure.'
}

export function isThreadCatalogueRequestErrorCode(
  value: unknown
): value is ThreadCatalogueRequestErrorCode {
  return (
    typeof value === 'string' &&
    (THREAD_CATALOGUE_REQUEST_ERROR_CODES as readonly string[]).includes(value)
  )
}

/**
 * Closed request-local catalogue failure. Messages are fixed by code so no
 * transcript, path, parser, or provider detail can cross a process boundary.
 */
export class ThreadCatalogueRequestError extends Error {
  readonly name = 'ThreadCatalogueRequestError'

  constructor(readonly code: ThreadCatalogueRequestErrorCode) {
    super(messages[code])
  }

  get retryable(): boolean {
    return this.code !== 'lease_erased'
  }
}

export function threadCatalogueRequestError(value: unknown): ThreadCatalogueRequestError | null {
  if (value instanceof ThreadCatalogueRequestError) return value
  if (
    value &&
    typeof value === 'object' &&
    (value as { name?: unknown }).name === 'ThreadCatalogueRequestError' &&
    isThreadCatalogueRequestErrorCode((value as { code?: unknown }).code)
  ) {
    return new ThreadCatalogueRequestError(
      (value as { code: ThreadCatalogueRequestErrorCode }).code
    )
  }
  return null
}
