export const ENSEMBLE_FANOUT_LANE_BRIEFS_GUIDANCE =
  'laneBriefs gives each lane its OWN task text, e.g. {"Reviewer":"Read src/router.ts and report risks","Worker":"Implement the fix in src/router.ts"}. Keys are the same target aliases writeScopes uses — participant IDs or role names, not model aliases — plus "*"/"all" as a catch-all. Values are plain strings. Prefer this over one broad prompt whenever the lanes are doing different things: a target with no key receives the shared prompt instead, and every lane that shares a prompt also reads the other lanes\' instructions.'

// Shared with Pi's generated extension, exactly as the writeScopes schema is.
// The `anyOf` union matters: a bare `{type:'object'}` is coerced to STRING by
// the Gemini declaration mapper, which would silently flatten the map.
export const ENSEMBLE_FANOUT_LANE_BRIEFS_SCHEMA = {
  anyOf: [
    { type: 'object' },
    { type: 'string', description: 'Compatibility transport: a JSON-encoded brief map.' }
  ],
  description: ENSEMBLE_FANOUT_LANE_BRIEFS_GUIDANCE
}
