// The single source of truth for official agy's print-mode wall clock.
//
// Three lanes pass `--print-timeout` to agy — the desktop transport
// (`src/main/antigravity/AntigravityCli.ts`), the scheduled seal-evidence lane
// that reuses that argv builder, and the headless host lane
// (`src/host-node/HostNodeAntigravityProvider.ts`) — and a fourth
// (`AntigravityPermissionLease`) has to reason about how long a run may
// legitimately still be in flight. They were independent literals, so the two
// spawn paths could silently drift apart with no test able to see it.
//
// This module deliberately imports nothing. It is depended on by both the main
// and host bundles, so it must stay free of Electron, filesystem, and
// process-identity transitive dependencies.

const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60 * MS_PER_SECOND
const MS_PER_HOUR = 60 * MS_PER_MINUTE

/**
 * How long a single agy print-mode turn may run before agy itself kills it.
 *
 * agy's own default is `5m0s` and omitting the flag inherits it, so the flag is
 * never removed — only raised. 24h is the user-chosen ceiling: an Ensemble lane
 * died at the previous 30m value because a long turn outlived the wall clock,
 * and a run that finishes early never pays for the headroom.
 */
export const AGY_PRINT_TIMEOUT_MS = 24 * MS_PER_HOUR

/**
 * Format an exact millisecond duration as a Go `time.ParseDuration` string,
 * which is the grammar agy's `--print-timeout` accepts. Zero components are
 * omitted, so 24h renders `24h` rather than `24h0m0s`.
 */
function goDurationFromMs(totalMs: number): string {
  if (!Number.isSafeInteger(totalMs) || totalMs < 0) {
    throw new Error('An agy print-mode timeout must be a non-negative whole number of ms.')
  }
  if (totalMs % MS_PER_SECOND !== 0) {
    throw new Error('An agy print-mode timeout must be a whole number of seconds.')
  }
  const hours = Math.floor(totalMs / MS_PER_HOUR)
  const minutes = Math.floor((totalMs % MS_PER_HOUR) / MS_PER_MINUTE)
  const seconds = (totalMs % MS_PER_MINUTE) / MS_PER_SECOND
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
  return parts.join('')
}

/**
 * The wire form of {@link AGY_PRINT_TIMEOUT_MS}, passed to agy as
 * `--print-timeout`. Derived rather than written twice: the string and the
 * millisecond bound cannot disagree, so a comment claiming they match is never
 * load-bearing.
 *
 * Not read-only-specific despite the historical name: the same value is applied
 * to `plan` and `accept-edits` print turns alike.
 */
export const AGY_PRINT_TIMEOUT = goDurationFromMs(AGY_PRINT_TIMEOUT_MS)
