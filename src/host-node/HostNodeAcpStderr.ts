/**
 * ACP providers (Vibe, Kimi, Grok) share stderr with their own logging: DEBUG
 * telemetry, Sentry flush chatter, progress hints. Only a line that reads like
 * an error should ever become a run's recorded reason, and never over a
 * protocol-level failure the JSON-RPC frames already explained.
 */

import { normalizeHostProviderRunPresentationText } from '../host-runtime/HostProviderRunPort'

const ACP_STDERR_NOISE =
  /^(DEBUG|INFO|TRACE)\b|^Sentry is attempting|^Waiting up to \d|^Press Ctrl-C to quit/i

/** The last stderr line of a chunk worth keeping as a failure reason, or ''. */
export function meaningfulAcpStderrLine(chunk: string, maxChars = 300): string {
  let kept = ''
  for (const raw of chunk.split(/\r?\n/)) {
    const line = normalizeHostProviderRunPresentationText(raw, maxChars)?.trim() ?? ''
    if (line && !ACP_STDERR_NOISE.test(line)) kept = line
  }
  return kept
}
