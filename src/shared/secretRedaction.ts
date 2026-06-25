/**
 * Node-free credential/secret scrubbing.
 *
 * Single source of truth for "strip high-entropy secrets out of free text"
 * before it crosses a trust boundary. Today the human-collaboration projection
 * (least-privilege transcript shown to an external_untrusted collaborator) uses
 * it; the markdown transcript export keeps its own copy of these patterns for
 * now and should migrate to this module so the list cannot drift (a forked
 * secret-redaction list is a security smell — one place to add a pattern).
 *
 * Patterns are intentionally conservative (anchored, length-bounded) to avoid
 * mangling ordinary prose; they target the credential shapes that actually leak
 * (provider keys, cloud keys, bearer tokens, KEY=value / "secret": "value").
 */
export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[redacted]'],
  [/\bsk_(?:live|test)_[A-Za-z0-9_-]{12,}\b/g, 'sk_[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, 'gh[redacted]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, 'xox[redacted]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted aws access key]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]'],
  [
    /\b(export\s+)?([A-Z0-9_]*(?:API[_-]?KEY|SECRET(?:_ACCESS_KEY)?|ACCESS[_-]?TOKEN|TOKEN|PASSWORD)[A-Z0-9_]*)\s*=\s*['"]?[^'"\s&]+['"]?/gi,
    '$1$2=[redacted]'
  ],
  [
    /(["']?(?:api[_-]?key|secret(?:[_-]?access[_-]?key)?|access[_-]?token|token|password)["']?\s*:\s*)["'][^"']+["']/gi,
    '$1"[redacted]"'
  ],
  [/\b(api[_-]?key|password|token|secret)\s*=\s*([^\s&]+)/gi, '$1=[redacted]'],
  [/\b(api[_-]?key|password|token|secret)\s*:\s*([^\s]+)/gi, '$1: [redacted]']
]

export function redactSecrets(value: string): string {
  if (!value) return value
  let next = value
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    next = next.replace(pattern, replacement)
  }
  return next
}
