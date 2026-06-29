const toDateTimeLocalValue = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const formatScheduledRunTime = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'unscheduled'
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const startOfDayMs = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

/**
 * Transcript clock label for a message/event timestamp. Keeps recent
 * items compact while disambiguating older ones:
 *
 *   - Today (or a future stamp): `HH:MM`
 *   - A previous day within the last 7 days: `Weekday HH:MM`
 *     (e.g. `Monday 13:21`) — the weekday is unambiguous within a week.
 *   - More than 7 days ago: `DD/MM/YYYY HH:MM` (weekday would repeat,
 *     so we fall back to the explicit calendar date).
 *
 * The time portion uses `toLocaleTimeString` so it honours the user's
 * locale clock (12h/24h) exactly as before; only the day/date prefix is
 * added. Returns `null` for missing/unparseable input so callers can
 * skip rendering. `now` is injectable for deterministic tests.
 */
const formatTranscriptClock = (
  value: string | number | Date | undefined | null,
  now: Date = new Date()
): string | null => {
  if (value === undefined || value === null) return null
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const dayDiff = Math.round((startOfDayMs(now) - startOfDayMs(date)) / 86_400_000)

  if (dayDiff <= 0) return time
  if (dayDiff <= 7) {
    return `${date.toLocaleDateString([], { weekday: 'long' })} ${time}`
  }
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${time}`
}

export { toDateTimeLocalValue, formatScheduledRunTime, formatTranscriptClock }
