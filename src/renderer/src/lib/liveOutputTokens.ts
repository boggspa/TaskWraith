/** A deliberately modest, renderer-only fallback for providers that do not
 * stream authoritative token usage until their turn ends. */
export const APPROX_CHARS_PER_TOKEN = 4

export function estimateLiveOutputTokensFromChars(charCount: number): number {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0
  return Math.ceil(charCount / APPROX_CHARS_PER_TOKEN)
}
