export const ENSEMBLE_FANOUT_WRITE_SCOPES_GUIDANCE =
  'writeScopes is a writer map, e.g. {"Worker":["src/worker.ts"]}. Use target participant IDs or role names as keys, not model aliases. Values are non-empty path/glob lists, scope objects ({kind:"path",path:"src/worker.ts"}), or "workspace" for an explicitly intended workspace-wide scope. A JSON-encoded map is accepted; a bare path list is not. Omitted keys dispatch those targets read-only.'

export const ENSEMBLE_FANOUT_SCOPE_REPAIR_GUIDANCE =
  'For invalid_write_scope, inspect the error and repair, correct the arguments, and retry ensemble_fanout. Do not repeat an unchanged failing call. Preserve the intended writers, paths, and isolation; yielding or switching to read_only does not repair writer delegation. Respect a policy or user denial and do not probe another transport.'

// Share the actual schema with Pi's generated extension. Keep map values open:
// the executor accepts legacy kind/type/path spellings and mixed scope lists.
// Its live roster and scope checks remain authoritative.
export const ENSEMBLE_FANOUT_WRITE_SCOPES_SCHEMA = {
  anyOf: [
    { type: 'object' },
    { type: 'string', description: 'Compatibility transport: a JSON-encoded writer map.' }
  ],
  description: ENSEMBLE_FANOUT_WRITE_SCOPES_GUIDANCE
}
