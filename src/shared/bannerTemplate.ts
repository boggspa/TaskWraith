/*
 * bannerTemplate — the TS side of the iOS notification banner template.
 *
 * SINGLE SOURCE OF TRUTH for both main and renderer. Do NOT re-declare the
 * token list, the default template, or the validator in a renderer module: the
 * provider-catalogue duplication taught us that main being correct is not
 * sufficient when the renderer keeps its own copy.
 *
 * MIRRORS ios/TaskWraithKit/Sources/TaskWraithKit/TWBannerTemplate.swift. The
 * JSON shape is the wire contract for `bridge.broadcastBannerTemplate`. The
 * Swift decoder falls back to ITS default on any mismatch, so a shape change
 * here degrades wording on-device rather than breaking the banner — but it DOES
 * silently stop honouring the user's template, so change both in lockstep.
 *
 * `renderBannerPreview` is a deliberate re-implementation of the Swift
 * CompletionBannerRenderer for the settings live preview. Two implementations of
 * one algorithm drift unless something forces them together — that is what
 * bannerTemplateFixtures.json is for: ONE input/output corpus, asserted by both
 * this module's test and the Swift TWBannerFixtureTests. Add a case there, not a
 * hand-written assertion in either language.
 */

export const BANNER_TEMPLATE_VERSION = 1

export type BannerStatusKey = 'success' | 'warning' | 'error' | 'quota' | 'cancelled'

export const BANNER_STATUS_KEYS: readonly BannerStatusKey[] = [
  'success',
  'warning',
  'error',
  'quota',
  'cancelled'
] as const

/** The CLOSED token set. A template referencing anything else is rejected by
 * the editor and stripped on-device. Keep in sync with the `substitutions`
 * dictionary in CompletionBannerRenderer.render. */
export const BANNER_TOKENS = ['statusEmoji', 'agent', 'status', 'summary', 'diff'] as const
export type BannerToken = (typeof BANNER_TOKENS)[number]

/** Tokens available inside a diff segment's `format` (NOT the body tokens). */
export const DIFF_SEGMENT_TOKENS = ['value', 's'] as const

export type DiffField = 'files' | 'additions' | 'deletions'

export interface DiffSegment {
  field: DiffField
  /** `{value}` → grouped number, `{s}` → "" when exactly 1 else "s". */
  format: string
}

export interface BannerTemplate {
  version: number
  titleFormat: string
  bodyLines: string[]
  statusEmoji: Record<string, string>
  statusFallback: Record<string, string>
  diffSegments: DiffSegment[]
  diffSeparator: string
  previewSentences: number
  previewCap: number
}

/** Live Activity layouts. Mirrors `TWActivityArchetype` in TWRunActivity.swift;
 * a layout is compiled SwiftUI in the widget extension, so only the id travels. */
export const ACTIVITY_ARCHETYPES = ['minimal', 'diff', 'attention', 'ensemble'] as const
export type ActivityArchetype = (typeof ACTIVITY_ARCHETYPES)[number]

export const DEFAULT_ACTIVITY_ARCHETYPE: ActivityArchetype = 'diff'

/**
 * Live Activity appearance, synced alongside the banner template.
 *
 * `successColor` / `failureColor` are the user's DIFF palette
 * (`settings.diffStatColors`), not a second colour setting. The phone's theme
 * is local-only — `TWTheme` on iOS reads its own UserDefaults and has no idea
 * the Mac's diff colours were customised — so without this the lock screen
 * would paint a finished run in the stock green while the desktop showed the
 * user's own.
 */
export interface ActivityAppearance {
  enabled: boolean
  archetype: ActivityArchetype
  /** `#RRGGBB`, upper case. */
  successColor: string
  failureColor: string
}

export interface BannerTemplateMessage {
  template: BannerTemplate
  /** Optional in BOTH directions: an older phone ignores the field, and a
   * newer phone must tolerate a Mac that never sends it. */
  activity?: ActivityAppearance
}

function sanitizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const match = value.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!match) return fallback
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

export interface ActivityArchetypePreset {
  readonly id: ActivityArchetype
  readonly label: string
  readonly description: string
}

/** The picker's copy. Order is the order shown. */
export const ACTIVITY_ARCHETYPE_PRESETS: readonly ActivityArchetypePreset[] = [
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Agent, a status dot and elapsed time. The quietest option.'
  },
  {
    id: 'diff',
    label: 'Changes',
    description: 'Adds live file, insertion and deletion counts as the run works.'
  },
  {
    id: 'attention',
    label: 'Attention',
    description: 'Leads with the status word — built for runs that stop and wait for you.'
  },
  {
    id: 'ensemble',
    label: 'Ensemble',
    description:
      'A dot per seat and a real finished/total bar. Ensemble chats always use this, whichever you pick.'
  }
]

export function sanitizeActivityAppearance(input: unknown): ActivityAppearance {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const archetype = record.archetype
  return {
    // Absent ⇒ on, matching `TWActivityPreferences.isEnabled`. iOS already
    // gives the user a system-level Live Activities switch that outranks this.
    enabled: record.enabled === undefined ? true : record.enabled !== false,
    archetype: ACTIVITY_ARCHETYPES.includes(archetype as ActivityArchetype)
      ? (archetype as ActivityArchetype)
      : DEFAULT_ACTIVITY_ARCHETYPE,
    successColor: sanitizeHexColor(record.successColor, '#2DB777'),
    failureColor: sanitizeHexColor(record.failureColor, '#EC3D35')
  }
}

/** Byte-identical to the Swift `TWBannerTemplate.default`. Changing a string
 * here changes what every un-customised user sees. */
export const DEFAULT_BANNER_TEMPLATE: BannerTemplate = {
  version: BANNER_TEMPLATE_VERSION,
  titleFormat: '{statusEmoji} {agent}',
  bodyLines: ['{summary}', '{diff}'],
  statusEmoji: {
    success: '✅',
    warning: '⚠️',
    error: '⚠️',
    quota: '❌',
    cancelled: '⚠️'
  },
  statusFallback: {
    success: 'Run finished.',
    warning: 'Run finished with warnings.',
    error: 'Run needs your attention.',
    quota: 'Rate limit or quota wall.',
    cancelled: 'Run cancelled.'
  },
  diffSegments: [
    { field: 'files', format: '📝 {value} file{s}' },
    { field: 'additions', format: '🟩 +{value}' },
    { field: 'deletions', format: '🟥 -{value}' }
  ],
  diffSeparator: ' · ',
  previewSentences: 2,
  previewCap: 180
}

const DIFF_FIELDS: readonly DiffField[] = ['files', 'additions', 'deletions']

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** Mirrors `TWBannerTemplate.sanitized()`. Applied before broadcast AND before
 * persist, so a hand-edited settings file can't emit a pathological banner. */
export function sanitizeBannerTemplate(input: unknown): BannerTemplate {
  const raw = (input ?? {}) as Partial<BannerTemplate>
  const d = DEFAULT_BANNER_TEMPLATE

  const statusMap = (value: unknown, fallback: Record<string, string>): Record<string, string> => {
    const source = (value ?? {}) as Record<string, unknown>
    const out: Record<string, string> = {}
    // Allowlisted keys only — an arbitrary key would be dead weight on the wire
    // and could collide with a future status.
    for (const key of BANNER_STATUS_KEYS) {
      const v = source[key]
      out[key] = typeof v === 'string' ? v.slice(0, 60) : fallback[key]
    }
    return out
  }

  const segments = Array.isArray(raw.diffSegments) ? raw.diffSegments : d.diffSegments
  const diffSegments = segments
    .filter(
      (s): s is DiffSegment =>
        !!s && typeof s === 'object' && DIFF_FIELDS.includes((s as DiffSegment).field)
    )
    .slice(0, 6)
    .map((s) => ({ field: s.field, format: String(s.format ?? '').slice(0, 60) }))

  const bodyLines = (Array.isArray(raw.bodyLines) ? raw.bodyLines : d.bodyLines)
    .filter((line) => typeof line === 'string')
    .slice(0, 4)
    .map((line) => line.slice(0, 200))

  return {
    version: BANNER_TEMPLATE_VERSION,
    titleFormat: (typeof raw.titleFormat === 'string' ? raw.titleFormat : d.titleFormat).slice(
      0,
      120
    ),
    bodyLines: bodyLines.length > 0 ? bodyLines : d.bodyLines,
    statusEmoji: statusMap(raw.statusEmoji, d.statusEmoji),
    statusFallback: statusMap(raw.statusFallback, d.statusFallback),
    diffSegments: diffSegments.length > 0 ? diffSegments : d.diffSegments,
    diffSeparator: (typeof raw.diffSeparator === 'string'
      ? raw.diffSeparator
      : d.diffSeparator
    ).slice(0, 8),
    previewSentences: clampInt(raw.previewSentences, 1, 6, d.previewSentences),
    previewCap: clampInt(raw.previewCap, 20, 400, d.previewCap)
  }
}

/** Every `{token}` in a format string, in order of appearance. */
export function extractTokens(format: string): string[] {
  const out: string[] = []
  const re = /\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(format)) !== null) out.push(match[1])
  return out
}

export interface BannerTemplateProblem {
  field: string
  message: string
}

/** Editor-side validation. The DEVICE strips unknown tokens defensively; this
 * is what stops them being saved in the first place, so the user sees the typo
 * in the settings tab instead of on a lock screen. */
export function validateBannerTemplate(template: BannerTemplate): BannerTemplateProblem[] {
  const problems: BannerTemplateProblem[] = []
  const known = new Set<string>(BANNER_TOKENS)

  for (const token of extractTokens(template.titleFormat)) {
    if (!known.has(token)) {
      problems.push({ field: 'titleFormat', message: `Unknown token {${token}}` })
    }
  }
  template.bodyLines.forEach((line, i) => {
    for (const token of extractTokens(line)) {
      if (!known.has(token)) {
        problems.push({ field: `bodyLines.${i}`, message: `Unknown token {${token}}` })
      }
    }
  })
  const diffKnown = new Set<string>(DIFF_SEGMENT_TOKENS)
  template.diffSegments.forEach((segment, i) => {
    for (const token of extractTokens(segment.format)) {
      if (!diffKnown.has(token)) {
        problems.push({
          field: `diffSegments.${i}`,
          message: `Unknown token {${token}} — diff segments only support {value} and {s}`
        })
      }
    }
  })
  // Not a hard error on-device (the title falls back to the agent name), but in
  // the editor it's always a mistake worth surfacing.
  if (extractTokens(template.titleFormat).length === 0 && template.titleFormat.trim() === '') {
    problems.push({ field: 'titleFormat', message: 'Title cannot be empty' })
  }
  return problems
}

// ---------------------------------------------------------------------------
// Preview renderer — MIRRORS CompletionBannerRenderer.swift.
// Any change here needs the same change there plus a fixture case.
// ---------------------------------------------------------------------------

export type BannerStatus = BannerStatusKey

export interface BannerRenderInput {
  title?: string | null
  preview?: string | null
  filesChanged: number
  additions: number
  deletions: number
  status: BannerStatus
}

export interface RenderedBanner {
  title: string
  body: string
}

/** Mirrors the Swift `substitute`. The whitespace collapse is GATED on an
 * actually-empty substitution — collapsing unconditionally would squash double
 * spaces inside the user's own preview text and break byte-parity with the
 * pre-template wording. */
function substitute(format: string, values: Record<string, string>): string {
  let out = ''
  let token = ''
  let inToken = false
  let didEmptySubstitution = false
  for (const ch of format) {
    if (ch === '{') {
      if (inToken) out += '{' + token
      inToken = true
      token = ''
    } else if (ch === '}' && inToken) {
      const value = values[token] ?? ''
      if (value === '') didEmptySubstitution = true
      out += value
      inToken = false
      token = ''
    } else if (inToken) {
      token += ch
    } else {
      out += ch
    }
  }
  if (inToken) out += '{' + token
  if (!didEmptySubstitution) return out.trim()
  return out
    .split(' ')
    .filter((part) => part !== '')
    .join(' ')
    .trim()
}

/** Mirrors the Swift `grouped` (NumberFormatter .decimal). Pinned to en-US so
 * the preview matches the device regardless of the Mac's locale — the phone
 * formats with ITS locale, but a thousands separator that flips between "," and
 * "." in a live preview reads as a bug. */
function grouped(value: number): string {
  return value.toLocaleString('en-US')
}

/** Mirrors `CompletionBannerRenderer.bannerSentences`. */
export function bannerSentences(
  text: string | null | undefined,
  maxSentences = 2,
  cap = 180
): string | null {
  const raw = (text ?? '').trim()
  if (raw === '') return null
  const flattened = raw.split(/[\n\r]/).join(' ')
  let assembled = ''
  let sentences = 0
  let pending = ''
  for (const ch of flattened) {
    pending += ch
    if (ch === '.' || ch === '!' || ch === '?') {
      assembled += pending
      pending = ''
      sentences += 1
      if (sentences >= maxSentences) break
    }
  }
  if (assembled === '') assembled = pending
  let trimmed = assembled.trim()
  // Swift's String.count is GRAPHEME clusters, not UTF-16 units — [...str]
  // iterates code points, which agrees for everything a banner realistically
  // carries. A multi-scalar emoji (flag, ZWJ sequence) would differ by a few
  // under an exact-cap edge case; not worth an Intl.Segmenter for a preview.
  const chars = [...trimmed]
  if (chars.length > cap) {
    trimmed = chars.slice(0, cap).join('').trim() + '…'
  }
  return trimmed === '' ? null : trimmed
}

/** Mirrors `CompletionBannerRenderer.diffBannerLine`. */
export function diffBannerLine(
  files: number,
  additions: number,
  deletions: number,
  template: BannerTemplate = DEFAULT_BANNER_TEMPLATE
): string | null {
  const parts: string[] = []
  for (const segment of template.diffSegments) {
    const value =
      segment.field === 'files' ? files : segment.field === 'additions' ? additions : deletions
    if (value <= 0) continue
    parts.push(substitute(segment.format, { value: grouped(value), s: value === 1 ? '' : 's' }))
  }
  if (parts.length === 0) return null
  return parts.join(template.diffSeparator)
}

/** Mirrors `CompletionBannerRenderer.render(_:template:)`. Drives the settings
 * tab's live preview. */
export function renderBannerPreview(
  input: BannerRenderInput,
  template: BannerTemplate = DEFAULT_BANNER_TEMPLATE
): RenderedBanner {
  const t = sanitizeBannerTemplate(template)
  const name = input.title && input.title !== '' ? input.title : 'TaskWraith'
  const statusKey = input.status
  const diff =
    statusKey === 'success'
      ? diffBannerLine(input.filesChanged, input.additions, input.deletions, t)
      : null

  const substitutions: Record<string, string> = {
    statusEmoji: t.statusEmoji[statusKey] ?? '',
    agent: name,
    status: statusKey,
    summary: bannerSentences(input.preview, t.previewSentences, t.previewCap) ?? '',
    diff: diff ?? ''
  }

  const title = substitute(t.titleFormat, substitutions)
  const lines = t.bodyLines.map((line) => substitute(line, substitutions)).filter((l) => l !== '')
  if (lines.length === 0) {
    lines.push(t.statusFallback[statusKey] ?? 'Run finished.')
  }
  return { title: title === '' ? name : title, body: lines.join('\n') }
}

// ---------------------------------------------------------------------------
// Presets — the "allowlisted seeds" the settings tab offers.
//
// Deliberately a closed list rather than a free-text token editor: the schema
// supports arbitrary templates (and the validator guards them), but the surface
// a user actually touches is a handful of curated wordings that are known to
// fit a lock screen and to read correctly in all five status states. A raw
// editor can wait until someone asks for it.
// ---------------------------------------------------------------------------

export interface BannerPreset {
  id: string
  label: string
  description: string
  template: BannerTemplate
}

const withOverrides = (overrides: Partial<BannerTemplate>): BannerTemplate => ({
  ...structuredClone(DEFAULT_BANNER_TEMPLATE),
  ...overrides
})

export const BANNER_PRESETS: readonly BannerPreset[] = [
  {
    id: 'default',
    label: 'Standard',
    description: 'Status glyph, agent name, summary, and full diff counts.',
    template: DEFAULT_BANNER_TEMPLATE
  },
  {
    id: 'compact',
    label: 'Compact',
    description: 'Summary only — no diff line. Best if you get a lot of runs.',
    template: withOverrides({ bodyLines: ['{summary}'] })
  },
  {
    id: 'stats-first',
    label: 'Stats first',
    description: 'Diff counts above the summary, for review-heavy work.',
    template: withOverrides({ bodyLines: ['{diff}', '{summary}'] })
  },
  {
    id: 'plain',
    label: 'Plain text',
    description: 'No emoji anywhere — just the agent, the summary, and the numbers.',
    template: withOverrides({
      titleFormat: '{agent}',
      diffSegments: [
        { field: 'files', format: '{value} file{s}' },
        { field: 'additions', format: '+{value}' },
        { field: 'deletions', format: '-{value}' }
      ],
      diffSeparator: ', '
    })
  },
  {
    id: 'terse',
    label: 'Terse',
    description: 'One short sentence and nothing else. Quietest option.',
    template: withOverrides({
      titleFormat: '{statusEmoji} {agent}',
      bodyLines: ['{summary}'],
      previewSentences: 1,
      previewCap: 80
    })
  }
] as const

/** Which preset a stored template corresponds to, or null when it matches none
 * (a template synced from a newer build, or one hand-edited in settings.json). */
export function matchBannerPreset(template: BannerTemplate | undefined): string | null {
  const target = JSON.stringify(sanitizeBannerTemplate(template))
  for (const preset of BANNER_PRESETS) {
    if (JSON.stringify(sanitizeBannerTemplate(preset.template)) === target) return preset.id
  }
  return null
}
