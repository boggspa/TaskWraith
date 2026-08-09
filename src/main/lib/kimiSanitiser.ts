/**
 * 1.0.5-EW26 — Kimi (Moonshot) compatibility filter.
 *
 * Moonshot's hosted API content filter is documented to be
 * sensitive to a small set of topics — primarily China political
 * sovereignty, Tiananmen / Tank Man references, Xinjiang /
 * Uyghur questions, Hong Kong protest history, Tibet sovereignty
 * / Dalai Lama, Taiwan independence, Falun Gong. When a prompt
 * to Kimi contains content matching these themes, the API
 * returns a 400 with `type: 'content_filter'` and the
 * participant's run ends in failure rather than producing a
 * response. The same opt-in sentence redaction also supports the DeepSeek
 * and Z.ai upstreams when they are selected through Pi; the Pi target list is
 * explicit so every other Pi upstream keeps its original prompt untouched.
 *
 * In an ensemble panel where the user is having a casual
 * conversation, this is annoying — Codex/Claude/Gemini happily
 * discuss world news containing one of these topics as a passing
 * mention, and then Kimi's turn dies upstream over an accidental
 * digression. the maintainer's framing: "providers sitting a session out
 * because of an accidental or overt digression seems a bit
 * overkill". This module is the compromise — the user's actual
 * transcript stays untouched (free speech wins for the user +
 * three other panelists), but Kimi's prompt context can be
 * filtered when the toggle is on so Kimi can still participate
 * on the non-flagged parts of the conversation.
 *
 * Design decisions (per the maintainer's choices in the design Q&A):
 *
 *   - **Default: OFF.** The feature exists for users who want
 *     it. Users who never run mixed ensembles with global-chat
 *     world-news topics never see this surface.
 *
 *   - **Curated + user-editable list.** We ship a documented
 *     default list (this file) with citations for each entry's
 *     reason for inclusion. Users can ADD entries (`customKeywords`
 *     in settings) to handle topics they've personally seen
 *     trigger Moonshot's filter, but they cannot remove built-in
 *     defaults (we don't want a "I removed Tiananmen so Kimi
 *     blew up" support burden).
 *
 *   - **Redact matched sentences, not paragraphs or whole
 *     prompts.** Sentence-level granularity preserves more
 *     context for Kimi while removing the trigger. Each matched
 *     sentence is replaced with a clear placeholder so Kimi
 *     understands content was filtered (rather than being
 *     mystified by missing context).
 *
 *   - **Transparency in the transcript.** When sanitisation
 *     fires, the orchestrator emits a `provider_diagnostic`
 *     event listing what got redacted so the maintainer always knows
 *     when the feature kicked in and on which keywords.
 *
 * What this is NOT:
 *
 *   - **Not a policy statement.** TaskWraith is not asserting that
 *     these topics are off-limits. We're describing what we
 *     observe Moonshot's API to refuse, and offering a tool to
 *     keep Kimi productive on workflows where those topics come
 *     up incidentally. Users who disagree with Moonshot's
 *     filter choices have full agency to disable Kimi
 *     participants, switch providers, or use a non-Kimi panel.
 *
 *   - **Not a sufficient solution.** Moonshot's filter uses ML
 *     classifiers, not just keyword matches. This module catches
 *     the obvious cases (literal "Tiananmen", "Xinjiang", etc.);
 *     it WILL miss euphemistic / contextual triggers ("June
 *     Fourth", "the events of 1989", "western Chinese
 *     re-education"). Users who hit a content_filter rejection
 *     despite this filter being enabled are still seeing the
 *     EW23 friendly notice — they should add the specific
 *     trigger phrase to `customKeywords`.
 */

/**
 * Curated default keyword list. Each entry has a comment noting
 * the topic family and why Moonshot's filter rejects content
 * containing it. Additions should be empirically-grounded —
 * something the maintainer or a user has seen trigger an actual
 * `content_filter` 400 — not speculative.
 *
 * Word-boundary matching (case-insensitive) — partial matches
 * don't fire (`Tibet` does NOT match `Tibetan` unless we add
 * `Tibetan` explicitly, intentionally avoiding the "tibetan
 * mastiff dog breed" false positive).
 *
 * Multi-word entries match as exact substrings (still case-
 * insensitive). For "Hong Kong" a sentence like "I love Hong
 * Kong cinema" WILL trigger — that's a known false-positive
 * cost of the keyword approach. The user-editable layer lets
 * folks customise if false positives bother them more than the
 * benefit.
 */
export const KIMI_DEFAULT_TRIGGER_KEYWORDS: ReadonlyArray<string> = [
  // China-political-sovereignty cluster — pretty consistent
  // Moonshot trigger across multiple anecdotal repros.
  'Tiananmen',
  'Tank Man',
  'June Fourth',
  // Xinjiang / Uyghur cluster.
  'Xinjiang',
  'Uyghur',
  'Uighur',
  // Hong Kong protests history.
  'Hong Kong protest',
  'Umbrella Movement',
  // Tibet sovereignty cluster.
  'Tibet independence',
  'Free Tibet',
  'Dalai Lama',
  // Taiwan sovereignty cluster (just the loaded phrasings —
  // "Taiwan" alone is too broad and trips on benign tech /
  // travel discussion).
  'Taiwan independence',
  'Republic of China',
  // Falun Gong (consistent filter trigger).
  'Falun Gong',
  // CCP leadership in negative contexts. "Xi Jinping" alone is
  // too broad (trips on benign factual discussion); the meme
  // reference is a more reliable filter signal.
  'Winnie the Pooh',
  // Catch-all for the news-cycle pattern the maintainer hit:
  // US/China-relations-themed multi-source summaries.
  'US-China relations',
  'China-US relations',
  'US China tensions',
  'China US tensions',
  // 1.0.5-EW26b — additional headline phrasings observed in a
  // real transcript that didn't match the "relations"/"tensions"
  // variants above but still tripped Moonshot's filter. The
  // pattern is: any diplomatic-summit / arms-package framing
  // involving China + an adversary (Taiwan, US). We
  // intentionally do NOT include bare "Taiwan" or "Beijing"
  // here — those produce heavy false-positives on benign
  // mentions (Taiwanese food, Beijing dumplings, business
  // trips, etc.). The compound phrasings below are tight
  // enough to specifically catch the geopolitical headline
  // shape without grabbing innocent uses.
  'Beijing summit',
  'Taiwan arms',
  'Taiwan arms package',
  'US-China ties',
  'China-US ties',
  'US China ties',
  'China US ties',
  'Trump-Xi',
  'Xi summit',
  'China summit'
]

/** Providers that reuse this compatibility pass need recipient-specific
 * placeholders and diagnostics, while the Kimi default remains backwards
 * compatible for existing retry paths. */
export type CompatibilityFilterRecipient = 'Kimi' | 'DeepSeek' | 'Z.ai'

const PI_COMPATIBILITY_FILTER_RECIPIENTS: Readonly<Record<string, CompatibilityFilterRecipient>> = {
  deepseek: 'DeepSeek',
  zai: 'Z.ai'
}

/**
 * Return the compatibility-filter recipient for a Pi upstream, or null when
 * that upstream must retain its unfiltered prompt.
 */
export function resolvePiCompatibilityFilterRecipient(
  upstream: string
): CompatibilityFilterRecipient | null {
  return PI_COMPATIBILITY_FILTER_RECIPIENTS[upstream] ?? null
}

export interface KimiSanitiserResult {
  /** The sanitised text — matched sentences replaced with the
   * placeholder. */
  text: string
  /** True iff at least one match fired (caller can decide to
   * emit a diagnostic or skip emission). */
  redacted: boolean
  /** Per-match record: the exact trigger keyword found + the
   * sentence (truncated to 120 chars) that was redacted. Used by
   * the orchestrator to emit a transcript diagnostic the user
   * can read. */
  matches: ReadonlyArray<{ trigger: string; sentenceExcerpt: string }>
}

export interface KimiClassifierInput {
  text: string
  sentences: ReadonlyArray<string>
}

export interface KimiClassifierMatch {
  sentenceIndex: number
  trigger: string
  confidence?: number
}

export type KimiClassifierResult =
  | {
      available: true
      matches: ReadonlyArray<KimiClassifierMatch>
      source?: string
    }
  | {
      available: false
      unavailableReason: 'disabled' | 'unavailable' | 'error'
      message?: string
      source?: string
    }

export type KimiContentClassifier = (input: KimiClassifierInput) => KimiClassifierResult

export interface KimiClassifierRedactionResult extends KimiSanitiserResult {
  classifierAvailable: boolean
  unavailableReason?: 'disabled' | 'unavailable' | 'error'
  source?: string
}

export type KimiContentFilterRetryFailureReason =
  | 'classifier_unavailable'
  | 'classifier_no_redaction'
  | 'keyword_unavailable'
  | 'retry_passes_exhausted'

const SENTENCE_BOUNDARY_REGEX = /(?<=[.!?。！？])\s+/g
const PLACEHOLDER =
  '[sentence redacted: TaskWraith Kimi compatibility filter detected content Moonshot rejects]'
const CLASSIFIER_PLACEHOLDER =
  '[sentence redacted: TaskWraith Kimi classifier flagged content Moonshot may reject]'
const KIMI_CONTENT_FILTER_REJECTION_PATTERN =
  /Error code:\s*400[\s\S]*content_filter|["']?type["']?\s*:\s*["']content_filter["']?|content[_ -]?filter|considered high risk/i
const KIMI_CLASSIFIER_PATTERNS: ReadonlyArray<{ trigger: string; pattern: RegExp }> = [
  {
    trigger: '1989 Beijing events',
    pattern: /\b(1989\s+(beijing|student|square)|events?\s+(of|in)\s+1989)\b/i
  },
  {
    trigger: 'western China detention framing',
    pattern: /\b(re[-\s]?education camps?|mass internment|western china camps?)\b/i
  },
  {
    trigger: 'cross-strait sovereignty framing',
    pattern: /\bcross[-\s]?strait\b[\s\S]{0,80}\b(sovereignty|independence|status)\b/i
  },
  {
    trigger: 'security-law protest framing',
    pattern: /\b(national security law|one country[, ]+two systems)\b[\s\S]{0,80}\b(protest|crackdown|dissent)\b/i
  }
]

export function isKimiContentFilterRejection(value: unknown): boolean {
  if (!value) return false
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return KIMI_CONTENT_FILTER_REJECTION_PATTERN.test(text)
}

/**
 * Parse the user's `customKeywords` settings string into a
 * keyword array. Accepts newline-separated entries; trims each;
 * drops blank lines and comments (lines starting with `#`).
 */
export function parseCustomKeywords(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

export interface CompatibilitySanitiserOptions {
  defaultKeywords?: ReadonlyArray<string>
  customKeywords?: ReadonlyArray<string>
  /** Kimi is the legacy/default caller; Pi recipients receive an accurate
   * placeholder rather than a reference to Moonshot. */
  recipient?: CompatibilityFilterRecipient
}

function placeholderForCompatibilityRecipient(recipient: CompatibilityFilterRecipient): string {
  if (recipient === 'Kimi') return PLACEHOLDER
  return `[sentence redacted: TaskWraith ${recipient} compatibility filter detected content ${recipient} may reject]`
}

/**
 * Sanitise a prompt for a compatibility-filter participant. Returns the
 * modified text plus a list of matches the caller can use to surface a
 * transcript diagnostic. Kimi remains the default recipient for the existing
 * Kimi-specific call sites.
 *
 * Algorithm:
 *   1. Split text into sentences via punctuation boundary.
 *   2. For each sentence, check whether ANY trigger keyword
 *      appears in it (case-insensitive). Single match per
 *      sentence is enough — we don't try to count multiple
 *      keywords per sentence.
 *   3. Replace matched sentences with `PLACEHOLDER`.
 *   4. Rejoin with the original whitespace (single space — the
 *      original newline patterns are lost, but Kimi reading
 *      prose with collapsed whitespace is fine).
 *
 * Time complexity is O(sentences × keywords). Keyword list is
 * fixed-small (~20-50 typical), sentences are bounded by prompt
 * length, so this runs in negligible time even on multi-MB
 * prompts.
 */
export function sanitiseForCompatibility(
  text: string,
  options: CompatibilitySanitiserOptions = {}
): KimiSanitiserResult {
  if (!text) return { text, redacted: false, matches: [] }
  const recipient = options.recipient ?? 'Kimi'
  const placeholder = placeholderForCompatibilityRecipient(recipient)
  const triggers = [
    ...(options.defaultKeywords ?? KIMI_DEFAULT_TRIGGER_KEYWORDS),
    ...(options.customKeywords ?? [])
  ]
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (triggers.length === 0) {
    return { text, redacted: false, matches: [] }
  }
  // Precompute lowercase trigger array for cheap case-insensitive
  // includes(). We don't use regex word-boundary because trigger
  // phrases contain whitespace and special characters.
  const triggersLower = triggers.map((t) => t.toLowerCase())
  const sentences = text.split(SENTENCE_BOUNDARY_REGEX)
  const matches: { trigger: string; sentenceExcerpt: string }[] = []
  const out: string[] = []
  for (const sentence of sentences) {
    const sentenceLower = sentence.toLowerCase()
    let matchedTrigger: string | null = null
    for (let i = 0; i < triggersLower.length; i++) {
      if (sentenceLower.includes(triggersLower[i])) {
        matchedTrigger = triggers[i]
        break
      }
    }
    if (matchedTrigger) {
      const excerpt = sentence.length > 120 ? `${sentence.slice(0, 117).trim()}…` : sentence.trim()
      matches.push({ trigger: matchedTrigger, sentenceExcerpt: excerpt })
      out.push(placeholder)
    } else {
      out.push(sentence)
    }
  }
  return {
    text: out.join(' '),
    redacted: matches.length > 0,
    matches
  }
}

/** Legacy Kimi entry point retained for the classifier/retry path. */
export function sanitiseForKimi(
  text: string,
  options: Omit<CompatibilitySanitiserOptions, 'recipient'> = {}
): KimiSanitiserResult {
  return sanitiseForCompatibility(text, { ...options, recipient: 'Kimi' })
}

function defaultKimiContentClassifier(input: KimiClassifierInput): KimiClassifierResult {
  const matches: KimiClassifierMatch[] = []
  input.sentences.forEach((sentence, sentenceIndex) => {
    const pattern = KIMI_CLASSIFIER_PATTERNS.find((entry) => entry.pattern.test(sentence))
    if (!pattern) return
    matches.push({ sentenceIndex, trigger: pattern.trigger, confidence: 0.72 })
  })
  return {
    available: true,
    matches,
    source: 'local-heuristic'
  }
}

export function classifyAndRedactForKimi(
  text: string,
  options: {
    enabled?: boolean
    classifier?: KimiContentClassifier
  } = {}
): KimiClassifierRedactionResult {
  if (!text) {
    return { text, redacted: false, matches: [], classifierAvailable: Boolean(options.enabled) }
  }
  if (!options.enabled) {
    return {
      text,
      redacted: false,
      matches: [],
      classifierAvailable: false,
      unavailableReason: 'disabled',
      source: 'disabled'
    }
  }

  const sentences = text.split(SENTENCE_BOUNDARY_REGEX)
  let classifierResult: KimiClassifierResult
  try {
    classifierResult = (options.classifier || defaultKimiContentClassifier)({ text, sentences })
  } catch (error) {
    return {
      text,
      redacted: false,
      matches: [],
      classifierAvailable: false,
      unavailableReason: 'error',
      source: error instanceof Error ? error.message : 'classifier-error'
    }
  }
  if (!classifierResult.available) {
    return {
      text,
      redacted: false,
      matches: [],
      classifierAvailable: false,
      unavailableReason: classifierResult.unavailableReason,
      source: classifierResult.source
    }
  }

  const matchBySentence = new Map<number, KimiClassifierMatch>()
  for (const match of classifierResult.matches) {
    if (!Number.isInteger(match.sentenceIndex)) continue
    if (match.sentenceIndex < 0 || match.sentenceIndex >= sentences.length) continue
    if (!matchBySentence.has(match.sentenceIndex)) {
      matchBySentence.set(match.sentenceIndex, match)
    }
  }
  const matches: { trigger: string; sentenceExcerpt: string }[] = []
  const out = sentences.map((sentence, index) => {
    const match = matchBySentence.get(index)
    if (!match) return sentence
    const excerpt = sentence.length > 120 ? `${sentence.slice(0, 117).trim()}…` : sentence.trim()
    matches.push({ trigger: match.trigger, sentenceExcerpt: excerpt })
    return CLASSIFIER_PLACEHOLDER
  })

  return {
    text: out.join(' '),
    redacted: matches.length > 0,
    matches,
    classifierAvailable: true,
    source: classifierResult.source || 'local-heuristic'
  }
}

/**
 * Format the matches array as a human-readable diagnostic
 * suitable for a transcript note. Used by the dispatch path
 * when sanitisation fires so the user sees both that
 * sanitisation happened AND what specifically got hidden.
 */
export function formatCompatibilitySanitiserDiagnostic(
  recipient: CompatibilityFilterRecipient,
  result: KimiSanitiserResult
): string {
  if (!result.redacted || result.matches.length === 0) return ''
  const lines: string[] = [
    `${recipient} compatibility filter redacted ${result.matches.length} sentence${
      result.matches.length === 1 ? '' : 's'
    } from ${recipient}'s view of this round:`
  ]
  for (const m of result.matches.slice(0, 8)) {
    lines.push(`  · Trigger "${m.trigger}" — "${m.sentenceExcerpt}"`)
  }
  if (result.matches.length > 8) {
    lines.push(`  · …and ${result.matches.length - 8} more`)
  }
  lines.push('Other participants (Codex / Claude / Gemini) saw the full unfiltered prompt.')
  return lines.join('\n')
}

/** Legacy Kimi diagnostic formatter retained for Kimi's retry path. */
export function formatKimiSanitiserDiagnostic(result: KimiSanitiserResult): string {
  return formatCompatibilitySanitiserDiagnostic('Kimi', result)
}

export function formatKimiRetryDiagnostic(
  pass: 'keyword' | 'classifier',
  result: KimiSanitiserResult
): string {
  const passLabel = pass === 'keyword' ? 'keyword compatibility filter' : 'classifier redaction'
  const lines = [
    `Kimi rejected this prompt with Moonshot's content filter. TaskWraith is retrying once with ${passLabel}.`
  ]
  const sanitiserDiagnostic = formatKimiSanitiserDiagnostic(result)
  if (sanitiserDiagnostic) lines.push(sanitiserDiagnostic)
  return lines.join('\n\n')
}

export function formatKimiRetryFailureDiagnostic(input: {
  attemptedPasses: ReadonlyArray<'keyword' | 'classifier'>
  reason: KimiContentFilterRetryFailureReason
}): string {
  const attempted = input.attemptedPasses.length
    ? input.attemptedPasses.join(' → ')
    : 'none'
  const reasonText =
    input.reason === 'classifier_unavailable'
      ? 'the classifier pass is disabled or unavailable, so no second redaction pass could be produced'
      : input.reason === 'classifier_no_redaction'
        ? 'the classifier did not identify any additional sentence to redact'
        : input.reason === 'retry_passes_exhausted'
          ? 'both retry passes were already attempted'
          : 'the keyword sanitiser could not produce a changed prompt'
  return [
    "Kimi (Moonshot) rejected this turn with a content-filter response after TaskWraith's retry envelope ran.",
    `Retry passes attempted: ${attempted}.`,
    `Final reason: ${reasonText}.`,
    'No user transcript content was changed; only Kimi retry prompts are sanitised.'
  ].join('\n')
}
