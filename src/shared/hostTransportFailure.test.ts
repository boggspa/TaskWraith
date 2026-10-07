import { describe, expect, it } from 'vitest'
import { isHostCatalogueTransportFailure, isHostTransportFailureText } from './hostTransportFailure'
import { ThreadCatalogueRequestError } from './threadCatalogueRequestError'

describe('Host transport failure classification', () => {
  it.each([
    'TaskWraith Host disconnected.',
    "Error invoking remote method 'thread-catalogue:read': Error: TaskWraith Host disconnected.",
    'TaskWraith Host projection client closed.',
    'TaskWraith Host is not connected.',
    'Timed out connecting to the TaskWraith Host.',
    'Host projection connection was superseded',
    'Host is not running; only an explicit start brings it back.'
  ])('names %j as Host transport loss', (text) => {
    expect(isHostTransportFailureText(text)).toBe(true)
    expect(isHostTransportFailureText(new Error(text))).toBe(true)
    expect(isHostCatalogueTransportFailure(new Error(text))).toBe(true)
  })

  it.each([
    '',
    'History is being erased',
    'History page was invalidated by erasure.',
    'History object changed during reading',
    'History changed during indexing.',
    'connect ECONNREFUSED 127.0.0.1:443',
    'disk exploded'
  ])('does not name %j as Host transport loss', (text) => {
    expect(isHostTransportFailureText(text)).toBe(false)
  })

  it('treats raw Host-socket errno failures as catalogue transport loss only', () => {
    for (const text of ['read ECONNRESET', 'write EPIPE', 'connect ENOENT /tmp/twh2-501/s']) {
      expect(isHostCatalogueTransportFailure(new Error(text))).toBe(true)
      // No Host name in the text, so user-facing copy must not claim one.
      expect(isHostTransportFailureText(text)).toBe(false)
    }
    expect(
      isHostCatalogueTransportFailure(new Error("ENOENT: no such file or directory, open 'x'"))
    ).toBe(false)
  })

  it('never treats an answer from the index as transport loss', () => {
    expect(isHostCatalogueTransportFailure(new ThreadCatalogueRequestError('lease_erased'))).toBe(
      false
    )
    // The wire form of a typed refusal, rebuilt on the far side of a process hop.
    expect(
      isHostCatalogueTransportFailure({ name: 'ThreadCatalogueRequestError', code: 'lease_erased' })
    ).toBe(false)
    expect(isHostCatalogueTransportFailure(new Error('History is being erased'))).toBe(false)
    expect(isHostCatalogueTransportFailure(null)).toBe(false)
    expect(isHostCatalogueTransportFailure(undefined)).toBe(false)
  })
})
