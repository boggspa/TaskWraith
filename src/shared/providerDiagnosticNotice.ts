/**
 * Provider diagnostic notices — the one formatter both the durable run-event
 * ledger and the Inspector agree on.
 *
 * `sendAgentCompatLine` emits `type: 'provider_diagnostic'` payloads for
 * TaskWraith's own pre-launch findings (Kimi runtime admission, the Kimi/Pi
 * compatibility filter). They name no tool, so the transcript used to render
 * them as a meaningless "Used Provider Diagnostic" card; `d53ef81f` hid that
 * card. The message itself must not disappear with it, and neither of the two
 * obvious carriers survives:
 *
 *  - `ToolActivity.parameters` — where the message lands on the live tool
 *    activity — is deleted at run-terminal by ChatToolDetailExternalization and
 *    moved behind a `detailRef`, so a renderer reading activities goes blank the
 *    moment the run seals.
 *  - The `provider_raw` run-event *payload* is dropped unless the user turned on
 *    `storeRawEvents`, which is off by default.
 *
 * The run-event `summary` is the field that survives both. So main formats the
 * notice into the summary at publish time, the renderer formats the same string
 * when it appends the live raw-log line, and the Inspector recognises either by
 * prefix. One shape, one recogniser, no payload archaeology.
 */

/** Compat payload `type` for a TaskWraith-authored provider notice. */
export const PROVIDER_DIAGNOSTIC_PAYLOAD_TYPE = 'provider_diagnostic'

/** Stable, user-readable lead-in. Also the Inspector's recognition prefix. */
export const PROVIDER_DIAGNOSTIC_LOG_PREFIX = 'Provider diagnostic'

export interface ProviderDiagnosticNoticeFields {
  provider?: string
  /** Emitting check, e.g. `kimi-runtime-admission`. Never a filesystem path. */
  source?: string
  message?: string
}

function cleanField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read the notice fields off a compat payload. Returns null when the payload is
 * not a provider diagnostic, or carries no message worth surfacing — an empty
 * notice is worse than none, since it renders as a label with nothing after it.
 */
export function readProviderDiagnosticNotice(
  payload: unknown
):
  | (Required<Pick<ProviderDiagnosticNoticeFields, 'message'>> & ProviderDiagnosticNoticeFields)
  | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (cleanField(record.type) !== PROVIDER_DIAGNOSTIC_PAYLOAD_TYPE) return null
  const message = cleanField(record.message)
  if (!message) return null
  return {
    message,
    provider: cleanField(record.provider) || undefined,
    source: cleanField(record.source) || undefined
  }
}

/**
 * One line, safe for a run-event summary and for a raw-log entry.
 *
 * `[provider/source]` is bracketed rather than bare so the source reads as the
 * label it is. The unbracketed form was the whole original confusion: the
 * transcript card put `kimi-runtime-admission` in its file-path slot, in
 * path-blue, and it read as a local file Kimi had gone and read.
 */
export function formatProviderDiagnosticNotice(fields: ProviderDiagnosticNoticeFields): string {
  const message = cleanField(fields.message)
  const scope = [cleanField(fields.provider), cleanField(fields.source)].filter(Boolean).join('/')
  const head = scope
    ? `${PROVIDER_DIAGNOSTIC_LOG_PREFIX} [${scope}]`
    : PROVIDER_DIAGNOSTIC_LOG_PREFIX
  return message ? `${head}: ${message}` : head
}

/** Whether a raw-log line is one of ours, by the prefix formatProviderDiagnosticNotice writes. */
export function isProviderDiagnosticLogLine(content: unknown): boolean {
  return (
    typeof content === 'string' && content.trimStart().startsWith(PROVIDER_DIAGNOSTIC_LOG_PREFIX)
  )
}
