/**
 * Codex app-server accepts UUID thread ids (optionally `urn:uuid:` prefixed)
 * for `thread/resume`. One-shot `codex exec` runs use synthetic ids and do not
 * carry native session context, so they must never qualify a slim resumed turn.
 */
const CODEX_APP_SERVER_THREAD_ID_RE =
  /^(urn:uuid:)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function isCodexAppServerThreadId(value: string | null | undefined): boolean {
  return typeof value === 'string' && CODEX_APP_SERVER_THREAD_ID_RE.test(value.trim())
}

export function isSameCodexAppServerThreadId(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  if (!isCodexAppServerThreadId(left) || !isCodexAppServerThreadId(right)) return false
  const canonicalize = (value: string) => value.trim().replace(/^urn:uuid:/i, '').toLowerCase()
  return canonicalize(left!) === canonicalize(right!)
}

export function shouldBlockCodexExecFallbackForSlimEnsemblePrompt(input: {
  ensembleRun?: { promptMode?: 'full' | 'slim' } | null
}): boolean {
  return input.ensembleRun?.promptMode === 'slim'
}
