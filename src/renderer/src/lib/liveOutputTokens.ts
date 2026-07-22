/** A deliberately modest, renderer-only fallback for providers that do not
 * stream authoritative token usage until their turn ends. Re-exported from the
 * shared chars→tokens authority so main-process estimators (Grok, Kimi-ACP,
 * the live stream-estimate lane) and this fallback can never drift apart. */
export {
  APPROX_CHARS_PER_TOKEN,
  estimateTokensFromChars as estimateLiveOutputTokensFromChars
} from '../../../shared/tokenEstimate'
