import { threadCatalogueRequestError } from './threadCatalogueRequestError'

/**
 * Host transport loss, named by the strings the Host client and lifecycle
 * actually produce (src/host-client/HostProjectionClient.ts,
 * src/main/host/HostProjectionBroker.ts, src/main/host/HostLifecycleController.ts).
 *
 * Every phrase names the Host itself, so a provider's own network failure
 * ("ECONNREFUSED" from an API call) never reads as "TaskWraith lost its
 * Host". A request the Host ANSWERED -- including a typed refusal -- is not
 * transport loss and never matches.
 */
const HOST_TRANSPORT_FAILURE_PATTERN =
  /TaskWraith Host disconnected|Host projection client closed|TaskWraith Host is not connected|Timed out connecting to the TaskWraith Host|Host projection connection was superseded|\bHost is not running\b/i

/**
 * Node socket failures on the Host's local socket. The client rejects pending
 * requests with the raw socket error (`read ECONNRESET`, `write EPIPE`,
 * `connect ENOENT <socket>`) when the peer resets rather than closes. These
 * carry no Host name, so they are only trusted on a path whose sole transport
 * IS the Host socket -- see `isHostCatalogueTransportFailure`.
 */
const HOST_SOCKET_ERRNO_PATTERN =
  /^(?:read|write|connect) (?:ECONNRESET|EPIPE|ECONNREFUSED|ENOENT)\b/

function failureText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return ''
}

/**
 * True when text (or an error) says TaskWraith lost contact with its Host.
 * Safe for user-facing copy: it matches only phrases that name the Host.
 */
export function isHostTransportFailureText(value: unknown): boolean {
  const text = failureText(value)
  return text.length > 0 && HOST_TRANSPORT_FAILURE_PATTERN.test(text)
}

/**
 * True when a Host-backed history catalogue read failed because the
 * transport was lost, so the read never produced an answer and the canonical
 * record read may stand in for it.
 *
 * Deliberately NOT transport loss, so the caller still rejects:
 * - every typed `ThreadCatalogueRequestError`, above all `lease_erased`: the
 *   Host answered that the page was invalidated by erasure, and a fallback
 *   would read around a deletion the user asked for;
 * - "History is being erased" and every other answer the index gave;
 * - integrity failures ("History object changed during reading"), which are
 *   computed renderer-side and never pass through this predicate.
 */
export function isHostCatalogueTransportFailure(error: unknown): boolean {
  if (threadCatalogueRequestError(error)) return false
  if (isHostTransportFailureText(error)) return true
  return HOST_SOCKET_ERRNO_PATTERN.test(failureText(error))
}
