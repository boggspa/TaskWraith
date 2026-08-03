/**
 * Product-wide ceiling for a single Ensemble roster.
 *
 * Main-process orchestration, renderer controls, presets, bridge payloads, and
 * agent-facing schemas must all derive from this value so no surface accepts a
 * participant that another surface silently truncates.
 */
export const MAX_ENSEMBLE_PARTICIPANTS = 50
