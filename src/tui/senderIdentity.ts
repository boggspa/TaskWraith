import { CHAT_MESSAGE_ORIGIN_TEXT_MAX_CHARS } from '../shared/messageOrigin'

/**
 * Who the host should name on a row this CLI sends.
 *
 * `pid` is the OWNING agent where one can be identified, not this process: a
 * `tw send` lives for about a second, so its own pid names nothing a human
 * could look up afterwards. `label` is absent when the runtime is unknown —
 * the host then renders "Sent from PID 1234", which is honest, rather than a
 * guessed product name.
 */
export interface SenderIdentity {
  pid: number
  label?: string
}

/**
 * Detectors are deliberately few and verified. Adding a runtime means
 * confirming the variable it actually exports into a child shell, NOT
 * guessing a plausible name: a wrong label is worse than none, because it
 * misattributes a message in someone else's transcript. Everything else is
 * served by `--from` / `TW_CLIENT_LABEL`, which are always available.
 */
const DETECTORS: ReadonlyArray<{
  label: string
  detect: (env: NodeJS.ProcessEnv) => boolean
  pidVar: string
}> = [
  {
    label: 'Claude Code',
    detect: (env) => env.CLAUDECODE === '1',
    pidVar: 'CLAUDE_PID'
  }
]

function boundedLabel(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, CHAT_MESSAGE_ORIGIN_TEXT_MAX_CHARS)
}

function positivePid(value: string | undefined): number | undefined {
  const trimmed = (value ?? '').trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Resolve the identity to present at hello. Precedence, most explicit first:
 * the `--from` flag, `TW_CLIENT_LABEL`, then a verified runtime detector.
 * The pid follows the same shape: `TW_CLIENT_PID`, the detected runtime's own
 * pid variable, then this process.
 */
export function resolveSenderIdentity(
  env: NodeJS.ProcessEnv,
  processPid: number,
  explicitLabel?: string
): SenderIdentity {
  const detected = DETECTORS.find((candidate) => candidate.detect(env))
  const label = boundedLabel(explicitLabel) ?? boundedLabel(env.TW_CLIENT_LABEL) ?? detected?.label
  const pid =
    positivePid(env.TW_CLIENT_PID) ??
    (detected ? positivePid(env[detected.pidVar]) : undefined) ??
    processPid
  return { pid, ...(label ? { label } : {}) }
}
