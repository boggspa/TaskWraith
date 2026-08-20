import { DEFAULT_MAX_WAVE_AGENTS } from '../../shared/fleetWave'

/**
 * The Max Wave Agents value builds shipped before 2026-08-20.
 *
 * Every settings write persists the whole merged settings object, so this
 * landed on disk for every install whether or not the user ever opened the
 * slider. Raising the default alone would therefore have reached nobody.
 */
export const SUPERSEDED_MAX_WAVE_AGENTS = 8

/**
 * Read Max Wave Agents, lifting a stored value that is exactly the superseded
 * default onto the current one.
 *
 * This cannot distinguish "never touched the slider" from "deliberately chose
 * 8", and does not try to: 8 was the shipped default for the twelve days the
 * setting existed, so the former is overwhelmingly the likelier reading. A
 * user who genuinely wants 8 can set it again — the write persists 8 while the
 * default is now 12, so it sticks from then on. Every other stored value is
 * honoured and merely clamped into the 2–64 band.
 *
 * Kept out of `store/index.ts` so it can be tested without booting Electron,
 * and so the delegation constant stays the single source of the number.
 */
export function adoptSupersededMaxWaveAgents(stored: unknown): number {
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return DEFAULT_MAX_WAVE_AGENTS
  const clamped = Math.max(2, Math.min(64, Math.floor(stored)))
  return clamped === SUPERSEDED_MAX_WAVE_AGENTS ? DEFAULT_MAX_WAVE_AGENTS : clamped
}
