// Pure classifier: is a JSON-RPC error on `session/prompt` a TRANSIENT upstream
// failure — one that a bounded same-session retry can clear — as opposed to a
// condition that will fail identically forever?
//
// WHY THIS EXISTS. An ACP `session/prompt` error terminalizes the turn: the run
// dies with `rpc_error:session/prompt` and the participant produces nothing. For
// a provider-side blip that is the wrong outcome — the agent process and its ACP
// session are both healthy, only the model call behind them failed. Observed on
// 2026-08-07 with grok, which surfaces xAI's 500 as a generic JSON-RPC
// "Internal error" whose `data` carries the real status:
//
//   Internal error: {"message":"API error (status 500 Internal Server Error):
//   error: Service temporarily unavailable.","http_status":500}
//
// SCOPE — deliberately narrow, and it FAILS CLOSED (unrecognized ⇒ not
// transient). Two classes are excluded on purpose, both checked BEFORE the
// transient patterns so they always win:
//
//   1. Auth. `Auth(AuthorizationRequired)`, 401/403 — a retry cannot mint a
//      credential, it only delays copy the user must act on.
//   2. Quota / rate-limit walls, INCLUDING 429 and Anthropic-style 529
//      `overloaded_error`. Those belong to ProviderQuotaWallClassifier and the
//      auto-failover path; retrying in-session would burn the turn's clock in
//      front of the machinery that already knows how to hop providers. A wall
//      that outlives our budget still terminalizes, so failover keeps its input.
//
// Modeled on ProviderQuotaWallClassifier: pure, side-effect free, unit-tested
// against real captured bodies rather than invented prose.

// CHANNEL SPLIT (the reason the first cut of this file did not fire). grok does
// NOT put the upstream body in the JSON-RPC error. Captured from run
// grok-1786112089519 / -1786115061135 on 2026-08-07, 13ms apart:
//
//   stderr  15:11:24.082Z  ERROR error=Internal error: {"message":"API error
//                          (status 500 ...): Service temporarily unavailable.",
//                          "http_status":500}
//   rpc     15:11:24.095Z  {"id":3,"error":{"code":-32603,
//                          "message":"Internal error"}}
//
// The frame is a bare envelope; every classifiable token is on stderr. So the
// caller passes recent stderr as `evidence`, and classification runs over both
// channels. That correlation is what lets the exclusions work too: an auth
// failure also arrives as a bare -32603, and only the stderr line distinguishes
// it from a 500.

/** The `error` member of a JSON-RPC error response. */
export interface AcpRpcErrorLike {
  code?: unknown
  message?: unknown
  data?: unknown
}

/** JSON-RPC 2.0 reserved code for a server-side internal error. */
const JSON_RPC_INTERNAL_ERROR = -32603

export interface AcpTransientClassificationOptions {
  /**
   * Corroborating text from another channel — in practice the provider's recent
   * stderr. The caller owns the freshness window; anything passed here is
   * treated as describing THIS failure.
   */
  evidence?: string | null
}

/**
 * Conditions a retry can never clear. Checked first so an upstream body that
 * mentions both (a 503 page describing a rate limit, say) fails closed.
 */
const NEVER_TRANSIENT: RegExp[] = [
  // Authentication / authorization — needs a human, not a wait.
  /authorizationrequired/i,
  /\bunauthenticated\b/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\binvalid[_ ]api[_ ]key\b/i,
  /\bauthentication[_ ](?:error|failed|required)\b/i,
  /\b(?:status|code)\s*[:=]?\s*40[13]\b/i,
  /"(?:http_)?status"\s*:\s*40[13]\b/i,
  // Quota / rate-limit walls — owned by ProviderQuotaWallClassifier + failover.
  /\brate[_ ]?limit/i,
  /\bquota\b/i,
  /\busage limit\b/i,
  /\bspending limit\b/i,
  /\bout of credits\b/i,
  /\boverloaded\b/i,
  /\b(?:status|code)\s*[:=]?\s*(?:429|529)\b/i,
  /"(?:http_)?status"\s*:\s*(?:429|529)\b/i,
  // Malformed / oversized request — deterministic, and re-sending an oversized
  // prompt twice is the one retry that is not cheap.
  /\bcontext[_ ]length[_ ]exceeded\b/i,
  /\bmaximum context length\b/i,
  /\b(?:prompt|context|input) (?:is )?too long\b/i,
  /\binvalid[_ ]request(?:[_ ]error)?\b/i
]

/**
 * Upstream failures that routinely clear on their own. Anchored on structured
 * status tokens and stable vendor prose, not on bare numbers (a "500" can
 * appear in any tool output) and not on the JSON-RPC envelope's own generic
 * "Internal error", which carries no information about whether a retry helps.
 */
const TRANSIENT: RegExp[] = [
  // Structured 5xx, either as a status field or in an SDK's message template.
  /"(?:http_)?status"\s*:\s*5\d{2}\b/i,
  /\b(?:status|code)\s*[:=]?\s*5\d{2}\b/i,
  /\b5\d{2}\s+(?:internal server error|bad gateway|service unavailable|gateway time-?out)\b/i,
  // Vendor prose for a capacity/availability blip.
  /\bservice (?:is )?temporarily unavailable\b/i,
  /\btemporarily unavailable\b/i,
  /\bservice unavailable\b/i,
  /\binternal server error\b/i,
  /\bbad gateway\b/i,
  /\bgateway time-?out\b/i,
  /\btry again later\b/i,
  // Transport-level faults between the agent and its upstream.
  /\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|ENETDOWN|EAI_AGAIN|ENOTFOUND|EPIPE)\b/,
  /\bsocket hang ?up\b/i,
  /\bconnection (?:reset|closed|aborted)\b/i,
  /\b(?:request|connection|read|stream) timed out\b/i,
  /\bnetwork (?:error|failure)\b/i
]

/**
 * Flatten a JSON-RPC error into one searchable string. `data` is the payload
 * that actually carries the upstream status — providers put it there as a
 * string, an object, or a nested envelope — so it must be serialized, not
 * stringified via String() (which yields "[object Object]" and classifies
 * nothing).
 */
export function acpRpcErrorText(error: AcpRpcErrorLike | null | undefined): string {
  if (!error) return ''
  const parts: string[] = []
  if (typeof error.message === 'string') parts.push(error.message)
  const { data } = error
  if (typeof data === 'string') parts.push(data)
  else if (data !== undefined && data !== null) {
    try {
      parts.push(JSON.stringify(data))
    } catch {
      // A circular or unserializable payload contributes nothing; the message
      // alone still classifies.
    }
  }
  return parts.join(' ')
}

/**
 * True only for a failure a bounded same-session retry can plausibly clear.
 *
 * Order matters. An excluded signal anywhere in the combined evidence wins, so
 * a 503 page describing a rate limit — or a bare envelope whose stderr says
 * `Auth(AuthorizationRequired)` — is refused. Only then does a recognized
 * transient token, or the JSON-RPC internal-error code, license a retry.
 */
export function isTransientAcpPromptFailure(
  error: AcpRpcErrorLike | null | undefined,
  options?: AcpTransientClassificationOptions
): boolean {
  const evidence = typeof options?.evidence === 'string' ? options.evidence : ''
  const text = `${acpRpcErrorText(error)} ${evidence}`.trim()
  if (!text) return false
  if (NEVER_TRANSIENT.some((re) => re.test(text))) return false
  if (TRANSIENT.some((re) => re.test(text))) return true
  // Nothing named the cause. JSON-RPC reserves -32603 for a fault inside the
  // server — the canonical retryable class — and by here no exclusion matched
  // on either channel. The asymmetry decides it: a wrong retry costs one
  // bounded backoff, a wrong refusal costs the entire turn.
  return toRpcErrorCode(error) === JSON_RPC_INTERNAL_ERROR
}

function toRpcErrorCode(error: AcpRpcErrorLike | null | undefined): number | null {
  const code = error?.code
  return typeof code === 'number' && Number.isFinite(code) ? code : null
}
