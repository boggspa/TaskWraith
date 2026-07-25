/**
 * IANA-zone wall-time conversion built on the runtime's full ICU (present in
 * both Node and Chromium here) — no timezone database dependency. Pure and
 * zone-parameterized so tests pin explicit zones instead of the host's.
 *
 * The wall→epoch direction uses the classic two-pass fixpoint: guess the
 * epoch as if the wall time were UTC, read back what that instant looks like
 * in the target zone, and correct by the difference. DST-ambiguous or
 * nonexistent wall times resolve deterministically to one side.
 */

export interface WallTimeParts {
  year: number
  /** 1-12 */
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(zone)
  if (cached) return cached
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
    formatterCache.set(zone, formatter)
    return formatter
  } catch {
    return null
  }
}

export function isValidTimeZone(zone: string): boolean {
  return zoneFormatter(zone) !== null
}

/** What the given instant reads as on a wall clock in `zone`. */
export function epochToWallTime(zone: string, epochMs: number): WallTimeParts | null {
  const formatter = zoneFormatter(zone)
  if (!formatter || !Number.isFinite(epochMs)) return null
  const parts: Record<string, number> = {}
  for (const piece of formatter.formatToParts(epochMs)) {
    if (piece.type === 'literal') continue
    parts[piece.type] = Number.parseInt(piece.value, 10)
  }
  if (
    [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].some(
      (value) => !Number.isFinite(value)
    )
  ) {
    return null
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    // hourCycle h23 still yields 24 for midnight in some ICU versions.
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second
  }
}

const partsToUtcEpoch = (parts: WallTimeParts): number =>
  Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)

/** The instant at which a wall clock in `zone` shows `parts`. */
export function wallTimeToUtcEpoch(zone: string, parts: WallTimeParts): number | null {
  if (!isValidTimeZone(zone)) return null
  const target = partsToUtcEpoch(parts)
  let guess = target
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const wall = epochToWallTime(zone, guess)
    if (!wall) return null
    const diff = target - partsToUtcEpoch(wall)
    if (diff === 0) return guess
    guess += diff
  }
  // Nonexistent wall time (spring-forward gap): the fixpoint oscillates;
  // the final guess lands on a deterministic neighbouring instant.
  return guess
}

/** Re-expresses a wall time from one zone as the wall time of another. */
export function convertWallTime(
  fromZone: string,
  toZone: string,
  parts: WallTimeParts
): WallTimeParts | null {
  const epoch = wallTimeToUtcEpoch(fromZone, parts)
  if (epoch === null) return null
  return epochToWallTime(toZone, epoch)
}

/** Wall time in `zone` for a UTC instant expressed as wall parts. */
export function utcWallTimeToZone(zone: string, parts: WallTimeParts): WallTimeParts | null {
  return epochToWallTime(zone, partsToUtcEpoch(parts))
}

/** The host's IANA zone (renderer and main share the user's machine zone). */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
