/*
 * greeting — the single source of truth for the time-of-day greeting shown in
 * the New General Chat welcome heading, shared by BOTH platforms. The Swift twin
 * (ios/TaskWraithKit/Sources/TaskWraithKit/Greeting.swift) mirrors these EXACT
 * boundaries + strings and is kept honest by a drift-guard test (same pattern as
 * src/shared/revealParams.ts + its Swift twin).
 *
 * Boundaries are on LOCAL hour-of-day (0-23): morning [0,12), afternoon [12,18),
 * evening [18,24). The greeting is purely presentational — each platform computes
 * it from its OWN device-local clock (no timezone is propagated phone<->Mac), so
 * a name edit reaches the phone but the hour is always device-local.
 *
 * This module is intentionally node-free and dependency-free.
 */

/** Local hour (0-23) at/after which the greeting becomes "Good afternoon". */
export const GREETING_AFTERNOON_START_HOUR = 12
/** Local hour (0-23) at/after which the greeting becomes "Good evening". */
export const GREETING_EVENING_START_HOUR = 18

export const GREETING_MORNING = 'Good morning'
export const GREETING_AFTERNOON = 'Good afternoon'
export const GREETING_EVENING = 'Good evening'

/** Map a local hour (0-23) to a time-of-day greeting. */
export function greetingForHour(hour: number): string {
  if (hour < GREETING_AFTERNOON_START_HOUR) return GREETING_MORNING
  if (hour < GREETING_EVENING_START_HOUR) return GREETING_AFTERNOON
  return GREETING_EVENING
}

/**
 * Build the full greeting line, appending the user's name when present.
 * Empty / whitespace-only names are omitted, so the result is e.g.
 * "Good morning" or "Good morning, Chris". The name is never sanitized here —
 * callers render it as inert text (React escapes / SwiftUI Text), so control
 * chars are displayed, never executed.
 */
export function buildGreeting(hour: number, name?: string | null): string {
  const greeting = greetingForHour(hour)
  const trimmed = (name ?? '').trim()
  return trimmed ? `${greeting}, ${trimmed}` : greeting
}
