/**
 * Agent-writable theme tokens — the allowlist and its validators.
 *
 * This is a DATA channel, deliberately not a code channel. An agent names a
 * token from the fixed list below and supplies a value that must parse as the
 * token's declared TYPE; nothing here accepts a CSS selector, a rule, a
 * declaration, `var(...)`, `url(...)`, or arbitrary text. That is what keeps
 * "the user asked the agent to restyle the app" from becoming "an agent can
 * author CSS that reaches the approval chrome".
 *
 * WHY AN ALLOWLIST RATHER THAN "ANY --custom-property":
 * TaskWraith's approval and permission cards are ordinary DOM in the same
 * document as everything else, and their LAYOUT is a security surface — an
 * elevation card that renders wrong is a consent-forgery vector, strictly worse
 * than a forged claim because it looks like the real gate. Sizing tokens
 * (`--sidebar-width`, `--control-hit-*`) can move that chrome; colour tokens
 * cannot. So the list is curated per token, and the two groups are typed
 * differently rather than lumped together.
 *
 * Node-builtin-free: BOTH processes import this (main sanitises the write, the
 * renderer applies it), and a node import reachable from the renderer blanks the
 * window. Same discipline as `shared/retiredProviders` and `shared/piBrandTable`.
 */

/** How a token's value is parsed and bounded. */
export type AgentThemeTokenKind = 'color' | 'pixels' | 'ratio'

export interface AgentThemeTokenSpec {
  /** CSS custom property name, without the leading `--`. */
  readonly token: string
  readonly kind: AgentThemeTokenKind
  /** Inclusive bounds for `pixels` / `ratio`. Ignored for `color`. */
  readonly min?: number
  readonly max?: number
  /** Shown to the model so it can choose sensibly without guessing. */
  readonly describe: string
}

/**
 * The writable set. Additions are a deliberate decision, not housekeeping:
 * every entry widens what an agent can change about the window the human
 * approves things in.
 *
 * Deliberately ABSENT, and why:
 *  - `--provider-*-color`: brand identity that doubles as run provenance. An
 *    agent recolouring Claude to look like Codex misattributes whose output you
 *    are reading. These are contrast-tuned and test-pinned; they are not skin.
 *  - `--focus-ring`, `--accent`: focus visibility is an accessibility floor.
 *  - `--header-height`, `--composer-min-height`: geometry the approval sheet
 *    and composer chrome are laid out against.
 *  - Anything shadow/gradient/filter shaped: those take free-form CSS function
 *    syntax, which is a parser surface rather than a typed value.
 */
export const AGENT_THEME_TOKENS: readonly AgentThemeTokenSpec[] = [
  {
    token: 'radius-sm',
    kind: 'pixels',
    min: 0,
    max: 24,
    describe: 'Corner radius for small controls (chips, buttons).'
  },
  {
    token: 'radius-md',
    kind: 'pixels',
    min: 0,
    max: 32,
    describe: 'Corner radius for cards and popovers.'
  },
  {
    token: 'radius-lg',
    kind: 'pixels',
    min: 0,
    max: 48,
    describe: 'Corner radius for large surfaces (panels, sheets).'
  },
  {
    token: 'space-xs',
    kind: 'pixels',
    min: 0,
    max: 16,
    describe: 'Smallest spacing step.'
  },
  { token: 'space-sm', kind: 'pixels', min: 0, max: 24, describe: 'Small spacing step.' },
  { token: 'space-md', kind: 'pixels', min: 0, max: 32, describe: 'Medium spacing step.' },
  { token: 'space-lg', kind: 'pixels', min: 0, max: 48, describe: 'Large spacing step.' },
  { token: 'space-xl', kind: 'pixels', min: 0, max: 64, describe: 'Largest spacing step.' },
  {
    token: 'sidebar-width',
    kind: 'pixels',
    // Floored well above zero: the sidebar is how you reach settings and the
    // approval history, so an agent must not be able to collapse it to nothing.
    min: 180,
    max: 520,
    describe: 'Sidebar width. Cannot be collapsed below a usable minimum.'
  },
  {
    token: 'inspector-width',
    kind: 'pixels',
    min: 240,
    max: 720,
    describe: 'Inspector / right dock width.'
  },
  {
    token: 'scrollbar-thumb',
    kind: 'color',
    describe: 'Scrollbar thumb colour, as #RGB or #RRGGBB.'
  },
  {
    token: 'scrollbar-track',
    kind: 'color',
    describe: 'Scrollbar track colour, as #RGB or #RRGGBB.'
  }
]

const TOKEN_SPECS: ReadonlyMap<string, AgentThemeTokenSpec> = new Map(
  AGENT_THEME_TOKENS.map((spec) => [spec.token, spec])
)

/** Every writable token name, for schema enums and docs. */
export const AGENT_THEME_TOKEN_NAMES: readonly string[] = AGENT_THEME_TOKENS.map((s) => s.token)

export function isAgentWritableThemeToken(token: string): boolean {
  return TOKEN_SPECS.has(token)
}

export function agentThemeTokenSpec(token: string): AgentThemeTokenSpec | undefined {
  return TOKEN_SPECS.get(token)
}

export type AgentThemeTokenRejection =
  | 'unknown-token'
  | 'not-a-string'
  | 'malformed-value'
  | 'out-of-range'

export type AgentThemeTokenResult =
  | { readonly ok: true; readonly token: string; readonly cssValue: string }
  | { readonly ok: false; readonly token: string; readonly reason: AgentThemeTokenRejection }

/** `#abc` / `#AABBCC` -> canonical `#AABBCC`. Null when it is not a plain hex. */
function normalizeHex(raw: string): string | null {
  const match = raw.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!match) return null
  const body = match[1]
  const expanded =
    body.length === 3
      ? body
          .split('')
          .map((ch) => `${ch}${ch}`)
          .join('')
      : body
  return `#${expanded.toUpperCase()}`
}

/**
 * Validate one token/value pair and return the exact CSS text to apply.
 *
 * REJECTS rather than coerces on anything structural. `diffStatColors` coerces
 * to a default because it is a user picker where silently keeping the old colour
 * is friendlier than an error; here the caller is a model, and a silent
 * substitution would let it believe a write landed when it did not. Bounds are
 * the one exception — a number outside range is clamped intent, not malformed
 * input, so it is reported as out-of-range instead of being quietly clipped.
 *
 * Numeric values are accepted as a bare number or with an explicit `px` suffix,
 * because a model will produce both. Everything else — `calc(...)`, `var(...)`,
 * `1em`, `50%`, `red`, `url(...)` — is malformed by design: the unit is implied
 * by the token's kind, so accepting arbitrary CSS text would reintroduce the
 * parser surface this module exists to avoid.
 */
export function validateAgentThemeToken(token: unknown, value: unknown): AgentThemeTokenResult {
  const name = typeof token === 'string' ? token.trim().replace(/^--/, '') : ''
  const spec = TOKEN_SPECS.get(name)
  if (!spec) return { ok: false, token: name, reason: 'unknown-token' }

  if (spec.kind === 'color') {
    if (typeof value !== 'string') return { ok: false, token: name, reason: 'not-a-string' }
    const hex = normalizeHex(value)
    if (!hex) return { ok: false, token: name, reason: 'malformed-value' }
    return { ok: true, token: name, cssValue: hex }
  }

  // pixels | ratio
  let numeric: number
  if (typeof value === 'number') {
    numeric = value
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    const match = trimmed.match(/^(-?\d+(?:\.\d+)?)(px)?$/i)
    if (!match) return { ok: false, token: name, reason: 'malformed-value' }
    numeric = Number(match[1])
  } else {
    return { ok: false, token: name, reason: 'not-a-string' }
  }
  if (!Number.isFinite(numeric)) return { ok: false, token: name, reason: 'malformed-value' }

  const min = spec.min ?? Number.NEGATIVE_INFINITY
  const max = spec.max ?? Number.POSITIVE_INFINITY
  if (numeric < min || numeric > max) return { ok: false, token: name, reason: 'out-of-range' }

  const rounded = spec.kind === 'pixels' ? Math.round(numeric) : numeric
  return {
    ok: true,
    token: name,
    cssValue: spec.kind === 'pixels' ? `${rounded}px` : String(rounded)
  }
}

/** Stored shape: token name (no `--`) -> already-validated CSS value. */
export type AgentThemeTokenOverrides = Record<string, string>

/**
 * Re-validate a whole stored map. Called on LOAD as well as on write, because a
 * map persisted by an older build must not bypass today's allowlist or bounds —
 * the same reasoning as re-clamping an unsigned run posture. Unknown or invalid
 * entries are dropped silently here (this path has no caller to report to);
 * the write path uses `validateAgentThemeToken` directly so a model gets told.
 */
export function normalizeAgentThemeTokenOverrides(value: unknown): AgentThemeTokenOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: AgentThemeTokenOverrides = {}
  for (const [token, raw] of Object.entries(value as Record<string, unknown>)) {
    const result = validateAgentThemeToken(token, raw)
    if (result.ok) out[result.token] = result.cssValue
  }
  return out
}
