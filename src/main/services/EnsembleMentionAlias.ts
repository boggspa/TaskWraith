/**
 * Shared @-mention alias resolver for ensemble chats.
 *
 * Used by:
 *   - `src/renderer/src/lib/mentionHighlight.ts` — composer overlay,
 *     transcript user-bubble, queued-row body tokenisation.
 *   - `src/renderer/src/lib/ComposerMentionTrigger.ts` — send-side
 *     `dmTargetParticipantId` resolution.
 *   - `src/main/services/EnsembleOrchestrator.ts` — auto-promotion
 *     in `runRound` when one participant tags another mid-round.
 *
 * Three independent files used to keep their own copies of a single-
 * word regex and a tiny `id → provider → role` resolver. That was
 * fine while the only mention forms were `@codex` / `@Planner` /
 * `@ensemble-codex` — short, single-token. Once the user asked for
 * model-name tagging (`@GPT 5.5`, `@Sonnet 4.7`, `@Flash Lite`,
 * `@Kimi K2.7 Code`), the resolver needed to support **multi-word
 * mentions**, which is too much logic to duplicate three ways
 * without drifting.
 *
 * This module owns:
 *   1. The canonical regex that picks `@` plus up to 4 whitespace-
 *      separated word chunks. Each chunk allows letters / digits /
 *      `._-` so dots in version numbers (`5.5`, `4.7`, `K2.7`) and
 *      hyphens in model ids (`gpt-5.5-mini`) both flow through.
 *   2. Alias generation per participant — id, provider, role, plus
 *      pretty model forms in spaced + hyphenated + concat variants.
 *      The model-name parsing replicates the per-provider rules from
 *      `composerChipFormat.shortModelName` inline so this module
 *      doesn't have to cross the renderer process boundary (main
 *      can't safely import from renderer-only files at runtime, and
 *      both processes need to call this).
 *   3. Longest-prefix matching — when a user writes `@GPT 5.5 mini
 *      can you`, we want the resolver to consume "gpt 5.5 mini"
 *      (3 words) before falling back to "gpt 5.5" (2) and finally
 *      "gpt" (1). Whichever participant's alias set is the longest
 *      that matches the prefix wins.
 *
 * Boundary rules match the pre-existing renderer + orchestrator
 * tokenisers so coverage stays aligned: word boundary before `@`
 * (start-of-string OR whitespace OR a small set of punctuation),
 * letter-led first chunk, so email addresses like `chris@example.com`
 * don't fire false positives.
 *
 * Reserved tokens (me/self/user/human) always fail resolution so
 * agents that say "no @me, I won't" don't get treated as a self-
 * mention that promotes the speaker.
 */

import type { EnsembleParticipant, ProviderId } from '../store/types'

/**
 * Word-boundary characters that can immediately precede `@` for a
 * mention to count. Start-of-string counts too. Punctuation includes
 * the common sentence-tail and bracket forms an agent might emit.
 *
 * `.` is in here so `Note. @codex` resolves cleanly, but the per-
 * chunk regex below allows `.` *inside* the token too — so `@GPT-5.5`
 * resolves as a single token, not `@GPT-5` + `.5`.
 */
const BOUNDARY_CHARS = `\\s(\\[{<>"'\`!?,;:.`

/**
 * Multi-word mention regex. Matches:
 *   - A boundary (start-of-string OR one of BOUNDARY_CHARS)
 *   - `@`
 *   - First chunk: letter-led, then letters/digits/dot/underscore/
 *     dash/hash, max 33 chars
 *   - Up to 3 additional chunks, each preceded by whitespace, allowing
 *     letters/digits/dot/underscore/dash/hash; max 33 chars each.
 *
 * 4 chunks total covers the longest realistic alias ("gpt 5 codex
 * spark" = 4) without being so greedy that it eats normal prose.
 * After the regex matches, `resolveMentionMatch` decides how many of
 * the captured chunks actually resolve to a participant.
 *
 * `#` is in the continuation chunks' lead-char class so role names
 * like "Chodex #2" / "Captain K #3" resolve correctly — without it,
 * `@Chodex #2` captured only `@Chodex` and the bare token failed to
 * match the multi-word alias `chodex #2`. 1.0.4 fix.
 */
const MENTION_REGEX = new RegExp(
  `(^|[${BOUNDARY_CHARS}])@([A-Za-z][A-Za-z0-9._#-]{0,32}(?:\\s+[A-Za-z0-9#][A-Za-z0-9._#-]{0,32}){0,3})`,
  'g'
)

/**
 * Tokens that should NEVER resolve to a participant. `me` and
 * `self` are speaker self-references — an agent narrating its
 * own role shouldn't accidentally promote itself.
 *
 * `user` / `human` / `you` are EXCLUDED from this set as of 1.0.4
 * — they now resolve to a special `UserMentionMatch` rather than
 * being blackholed. See `USER_ALIASES` below.
 */
const RESERVED_TOKENS = new Set(['me', 'self'])

/**
 * 1.0.4 — explicit user-mention aliases. When an agent writes
 * `@user`, `@human`, or `@you`, the resolver returns a
 * `UserMentionMatch` (no `participant` field) instead of falling
 * back to participant-alias matching. Runtime routing treats these
 * as informational address tokens; explicit handback is handled by
 * structured yield-to-user actions.
 *
 * Surface treatment in the transcript / composer overlay: user
 * mentions render with `var(--user-bubble-color)` (the appearance-
 * setting tint the user picked for their own message bubble) so
 * the @-mention chip visually echoes their identity.
 */
const USER_ALIASES = new Set(['user', 'human', 'you'])

/**
 * Normalise a candidate alias string for case-insensitive matching.
 * Lowercase, trim, collapse runs of whitespace + hyphen + underscore
 * to a single space. So "GPT-5.5", "gpt 5.5", "gpt_5.5", "GPT  5.5"
 * all normalise to "gpt 5.5".
 */
export function normalizeAlias(s: string): string {
  return s.toLowerCase().trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
}

/**
 * Generate the lowercase alias strings that resolve to a participant
 * by model identity. The rules mirror `shortModelName` in
 * `composerChipFormat.ts` per provider:
 *
 *   - Codex (`gpt-5.5`, `gpt-5.4-mini`): aliases include the bare
 *     version (`5.5`), the family + version (`gpt 5.5`), and any
 *     suffix joined back in (`gpt 5.4 mini`, `5.4 mini`).
 *   - Claude (`claude-opus-4-7`): aliases include `opus 4.7`,
 *     `claude opus 4.7`, plus the family alone (`opus`) — useful for
 *     same-provider 1.0.4 where two Claudes might differ only by
 *     family.
 *   - Gemini (`gemini-2.5-flash-lite`): aliases include the parts
 *     space-joined (`2.5 flash lite`, `flash lite`), with + without
 *     the `gemini` prefix.
 *   - Kimi (`kimi-k2.7-code`, `kimi-k2-thinking`): aliases include the
 *     compact form (`k2.7 code`, `k2 thinking`) with + without `kimi`.
 *
 * Each generated alias is also added in "concat" form (whitespace
 * stripped) so users can type `@gpt5.5` and `@flashlite` without
 * spaces and still match.
 */
export function generateModelAliases(provider: ProviderId, model: string | undefined): string[] {
  if (!model) return []
  const id = model.toLowerCase()
  const out = new Set<string>()
  const push = (s: string): void => {
    const n = normalizeAlias(s)
    if (n && n.length >= 2) {
      out.add(n)
      // Concat form (no spaces) — `@gpt5.5`, `@flashlite`. Helps
      // mobile-style fast typists who don't want to space-separate.
      const concat = n.replace(/\s+/g, '')
      if (concat !== n && concat.length >= 3) out.add(concat)
    }
  }

  // Always include the raw model id and a space-form of it.
  push(id)

  if (provider === 'codex') {
    // gpt-5.5 → 5.5 / gpt 5.5; gpt-5.4-mini → 5.4 mini / gpt 5.4 mini
    const match = id.match(/^gpt-([\d.]+)(.*)$/)
    if (match) {
      const version = match[1]
      const suffix = match[2].replace(/^-/, '').split('-').filter(Boolean).join(' ')
      push(version)
      push(`gpt ${version}`)
      if (suffix) {
        push(`${version} ${suffix}`)
        push(`gpt ${version} ${suffix}`)
        push(suffix)
      }
    }
  } else if (provider === 'claude') {
    // claude-opus-4-7, claude-sonnet-4-6-thinking → Opus 4.7, Sonnet 4.6.
    // Fable/Mythos have a single version digit (claude-fable-5 → Fable 5); the
    // optional minor group uses a `$|-` lookahead so claude-fable-5-1m
    // yields version 5 + suffix "1m" rather than version 5.1.
    const match = id.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?(?=$|-)(.*)$/)
    if (match) {
      const family = match[1]
      const version = match[3] ? `${match[2]}.${match[3]}` : match[2]
      const suffix = match[4].replace(/^-/, '').split('-').filter(Boolean).join(' ')
      push(family)
      push(`${family} ${version}`)
      push(`claude ${family} ${version}`)
      if (suffix) {
        push(`${family} ${version} ${suffix}`)
        push(`claude ${family} ${version} ${suffix}`)
      }
    }
  } else if (provider === 'kimi') {
    // kimi-k2.7-code, kimi-k2.7-code-thinking, kimi-k2-thinking
    const match = id.match(/^kimi-(k[\d.]+)(.*)$/)
    if (match) {
      const ver = match[1]
      const suffixParts = match[2].replace(/^-/, '').split('-').filter(Boolean)
      const suffix = suffixParts.join(' ')
      push(ver)
      push(`kimi ${ver}`)
      if (suffix) {
        push(`${ver} ${suffix}`)
        push(`kimi ${ver} ${suffix}`)
        for (let i = 1; i < suffixParts.length; i++) {
          const prefix = suffixParts.slice(0, i).join(' ')
          push(`${ver} ${prefix}`)
          push(`kimi ${ver} ${prefix}`)
        }
      }
    }
  } else if (provider === 'gemini') {
    // gemini-2.5-pro, gemini-flash-lite, gemini-2.5-flash-lite, gemini-1.5-flash
    const match = id.match(/^gemini-(.+)$/)
    if (match) {
      const parts = match[1].split('-').filter(Boolean)
      const joined = parts.join(' ')
      push(joined)
      push(`gemini ${joined}`)
      // Drop leading version if it looks like a version (e.g.
      // "2.5 flash" → also accept "flash" alone). Two Geminis in a
      // 1.0.4 ensemble might share the version digits and differ
      // only by Flash / Pro / Flash Lite.
      if (parts.length > 1 && /^[\d.]+$/.test(parts[0])) {
        const tail = parts.slice(1).join(' ')
        push(tail)
        push(`gemini ${tail}`)
      }
      // Final tail word (Pro / Flash / Lite) is often diagnostic on
      // its own — accept it as a single-word alias.
      if (parts.length >= 1) {
        push(parts[parts.length - 1])
      }
    }
  } else if (provider === 'ollama') {
    // qwen3.5:9b, qwen3:4b-instruct, gemma4:12b, ornith:35b, gpt-oss, lfm2.5:8b
    const parts = id.replace(/[:/]+/g, '-').split('-').filter(Boolean)
    if (parts.length > 0) {
      push(parts.join(' '))
      const qwen = parts[0].match(/^qwen([\d.]+)$/)
      if (qwen) {
        const version = qwen[1]
        const tail = parts.slice(1).join(' ')
        push('qwen')
        push(`qwen ${version}`)
        if (tail) push(`qwen ${version} ${tail}`)
      }
      if (parts[0].startsWith('gemma')) push('gemma')
      if (parts[0] === 'ornith') push('ornith')
      if (parts[0] === 'gpt' && parts[1] === 'oss') push('gpt oss')
      if (parts[0] === 'lfm2.5') {
        push('lfm')
        push('lfm 2.5')
        push('liquid')
      }
    }
  }

  return Array.from(out)
}

/**
 * Lowercase normalised aliases that resolve to this participant. Covers
 * id, provider, role, and all model-name variants from
 * `generateModelAliases`.
 */
export function getParticipantAliases(p: EnsembleParticipant): string[] {
  const out = new Set<string>()
  const push = (s: string | undefined): void => {
    if (!s) return
    const n = normalizeAlias(s)
    if (n && n.length >= 2 && !RESERVED_TOKENS.has(n)) {
      out.add(n)
      const concat = n.replace(/\s+/g, '')
      if (concat !== n && concat.length >= 3) out.add(concat)
    }
  }
  push(p.id)
  push(p.provider)
  push(p.role)
  for (const m of generateModelAliases(p.provider, p.model)) {
    out.add(m)
  }
  return Array.from(out)
}

/**
 * Reverse alias map: normalised alias → participants that claim it.
 * A single alias can be claimed by multiple participants in 1.0.4
 * (e.g. two Codex participants both claim `codex`); we keep all of
 * them and rank by **alias specificity** at resolution time —
 * longer aliases (more words) win over shorter ones, and aliases
 * unique to one participant win over shared ones.
 */
export interface ParticipantAliasMap {
  /** alias → participants ordered by ensemble order. */
  byAlias: Map<string, EnsembleParticipant[]>
  /** Per-participant alias word counts, used to score longest match. */
  aliasWordCount: Map<string, number>
}

export function buildParticipantAliasMap(participants: EnsembleParticipant[]): ParticipantAliasMap {
  const byAlias = new Map<string, EnsembleParticipant[]>()
  const aliasWordCount = new Map<string, number>()
  for (const p of participants) {
    for (const alias of getParticipantAliases(p)) {
      const list = byAlias.get(alias)
      if (list) {
        if (!list.includes(p)) list.push(p)
      } else {
        byAlias.set(alias, [p])
      }
      if (!aliasWordCount.has(alias)) {
        aliasWordCount.set(alias, alias.split(' ').length)
      }
    }
  }
  return { byAlias, aliasWordCount }
}

/**
 * Common shape for any mention match in the transcript.
 */
interface BaseMentionMatch {
  /** Index in the source string where `@` sits. */
  atIndex: number
  /** Total characters consumed by the match, including `@` and any
   * trailing words. Used by the tokeniser to advance past the match. */
  consumedLength: number
  /** The matched phrase WITHOUT the leading `@`. e.g. "GPT 5.5". */
  text: string
}

export interface ParticipantMentionMatch extends BaseMentionMatch {
  kind: 'participant'
  /** Resolved participant. */
  participant: EnsembleParticipant
  /**
   * Other participants that claimed the SAME alias as `participant`,
   * after `excludeIds` (the speaker) has been filtered out. Empty /
   * undefined when the resolution was unambiguous.
   *
   * Populated for 1.0.4 same-provider ensembles: when Kimi writes
   * `@codex` and two Codex participants both claim the `codex` alias,
   * the resolver still picks `eligible[0]` deterministically (ensemble
   * order), but stashes the rest here so the orchestrator can (a)
   * decide whether to re-pick based on round state (e.g. prefer a
   * candidate still in `remaining`) and (b) emit a transcript
   * disambiguation warning so the user sees that the routing choice
   * was non-deterministic from the agent's perspective.
   */
  ambiguousAmong?: EnsembleParticipant[]
}

/**
 * User-address mention. Returned when the resolver hits a
 * `USER_ALIASES` token (`user` / `human` / `you`). No `participant`
 * field — the orchestrator ignores this for routing while the
 * renderer can still style it as a user-address chip.
 */
export interface UserMentionMatch extends BaseMentionMatch {
  kind: 'user'
}

export type MentionMatch = ParticipantMentionMatch | UserMentionMatch

/**
 * Type predicate for callers that need to narrow MentionMatch
 * down to the participant variant before accessing `.participant`.
 * Cleaner than `match.kind === 'participant'` at every call site.
 */
export function isParticipantMention(match: MentionMatch): match is ParticipantMentionMatch {
  return match.kind === 'participant'
}

export function isUserMention(match: MentionMatch): match is UserMentionMatch {
  return match.kind === 'user'
}

/**
 * Walk the input string and yield every resolved mention, longest-
 * match first per anchor `@`. Mentions whose resolved participant is
 * in `excludeIds` are skipped (used by the orchestrator to filter out
 * self-mentions when promoting).
 */
export function findAllMentions(
  text: string,
  participants: EnsembleParticipant[],
  excludeIds?: ReadonlySet<string>
): MentionMatch[] {
  if (!text || !text.includes('@')) return []
  // User-mentions (`@user` / `@human` / `@you`) resolve even when
  // the ensemble has no participants — they're address tokens
  // independent of the panel. The participant alias map
  // remains the right structure for the rest of the resolution
  // path, but we early-out before building it when there's no
  // panel AND no user-mention possible (the loop below covers
  // both cases).
  const aliasMap = participants.length > 0 ? buildParticipantAliasMap(participants) : null
  const matches: MentionMatch[] = []
  MENTION_REGEX.lastIndex = 0
  let regexMatch: RegExpExecArray | null
  while ((regexMatch = MENTION_REGEX.exec(text)) !== null) {
    const prefix = regexMatch[1]
    const phrase = regexMatch[2]
    const atIndex = regexMatch.index + prefix.length

    // 1.0.4 — user-mention check. The first word of the phrase is
    // checked against USER_ALIASES; if it matches, we emit a
    // UserMentionMatch consuming only that word (`@user this is
    // ready` consumes `@user` and leaves `this is ready` for
    // following tokenisation). We don't multi-word-match user
    // aliases (no `@you and codex` ambiguity) — keeps the resolver
    // predictable.
    const firstWordRaw = phrase.split(/\s+/)[0] || ''
    const firstWordNormalised = normalizeAlias(firstWordRaw.replace(TRAILING_PUNCT_RE, ''))
    if (USER_ALIASES.has(firstWordNormalised)) {
      matches.push({
        kind: 'user',
        atIndex,
        consumedLength: 1 + firstWordRaw.length, // `@` + the matched alias
        text: firstWordRaw
      })
      MENTION_REGEX.lastIndex = atIndex + 1 + firstWordRaw.length
      continue
    }

    if (!aliasMap) continue
    const resolved = resolveMentionPhrase(phrase, aliasMap, excludeIds)
    if (!resolved) {
      // Don't advance lastIndex artificially — the regex's own forward
      // movement is sufficient (it consumed at least the `@` + first
      // chunk). The next iteration will pick up further candidates.
      continue
    }
    matches.push({
      kind: 'participant',
      atIndex,
      consumedLength: 1 + resolved.consumedText.length, // `@` + phrase
      text: resolved.consumedText,
      participant: resolved.participant,
      ...(resolved.ambiguousAmong && resolved.ambiguousAmong.length > 0
        ? { ambiguousAmong: resolved.ambiguousAmong }
        : {})
    })
    // Walk regex lastIndex back so it picks up text right after our
    // resolved consumption, not after the (potentially-longer) regex
    // capture. The regex may have consumed "GPT 5.5 mini and then" but
    // we may have resolved only "GPT 5.5" — the "mini and then" should
    // remain available for further tokenisation.
    MENTION_REGEX.lastIndex = atIndex + 1 + resolved.consumedText.length
  }
  return matches
}

/**
 * The single DM target for a steer/send: the participant id when `text`
 * @-tags EXACTLY ONE participant, else null (0 or 2+ tags = a panel round,
 * not a DM). Mirrors the renderer's `extractFirstEnsembleDmTarget` participant
 * branch so the bridge steer path scopes the round identically — this is what
 * narrows the "Participants reachable" card to the tagged participant (iOS
 * parity: the phone sends raw "@Role …" text and the Mac resolves it here).
 */
export function resolveSingleEnsembleDmTarget(
  text: string,
  participants: EnsembleParticipant[]
): string | null {
  const ids = [
    ...new Set(
      findAllMentions(text, participants)
        .filter(isParticipantMention)
        .filter((match) => !match.ambiguousAmong || match.ambiguousAmong.length === 0)
        .map((match) => match.participant.id)
    )
  ]
  return ids.length === 1 ? ids[0] : null
}

/**
 * Trailing-sentence-punctuation we strip from the LAST word of a
 * candidate prefix before matching it against the alias map. The
 * per-chunk regex allows `.` inside the chunk so model versions
 * like `5.5` or `K2.7` survive — but that means a normal sentence
 * `Calling @Planner.` captures `Planner.` (trailing dot). The
 * alias map has `planner`, not `planner.`, so the match would
 * silently fail. Strip these post-capture instead of complicating
 * the regex further.
 */
const TRAILING_PUNCT_RE = /[.,!?;:]+$/

/**
 * Resolve a single captured phrase against the alias map using
 * longest-prefix matching. Returns the resolved participant and the
 * exact substring of `phrase` that was consumed.
 */
function resolveMentionPhrase(
  phrase: string,
  aliasMap: ParticipantAliasMap,
  excludeIds?: ReadonlySet<string>
): {
  participant: EnsembleParticipant
  consumedText: string
  ambiguousAmong?: EnsembleParticipant[]
} | null {
  const rawWords = phrase.split(/\s+/).filter(Boolean)
  if (rawWords.length === 0) return null
  // Try longest-first: 4-word, 3-word, 2-word, 1-word prefixes. For
  // each candidate prefix, also try a punctuation-trimmed variant on
  // the LAST word so `Planner.` and `Planner` both resolve. We try
  // raw first so model strings that genuinely contain trailing dots
  // (none in the current line-up, but future-proof) get a shot.
  for (let len = Math.min(rawWords.length, 4); len >= 1; len -= 1) {
    const prefix = rawWords.slice(0, len)
    const raw = normalizeAlias(prefix.join(' '))
    const trimmedLast = prefix.slice()
    trimmedLast[len - 1] = trimmedLast[len - 1].replace(TRAILING_PUNCT_RE, '')
    const trimmed = normalizeAlias(trimmedLast.join(' '))
    for (const key of trimmed === raw ? [raw] : [raw, trimmed]) {
      if (!key || RESERVED_TOKENS.has(key)) continue
      const candidates = aliasMap.byAlias.get(key)
      if (!candidates || candidates.length === 0) continue
      const eligible = excludeIds ? candidates.filter((p) => !excludeIds.has(p.id)) : candidates
      if (eligible.length === 0) continue
      // Ambiguous aliases are advisory only. Routing `@codex` to the
      // first Codex lane when the ensemble has multiple Codex seats is
      // deterministic, but it is still the wrong failure mode for
      // orchestration. Return a non-routeable match with the full
      // candidate set so callers can warn and force a unique role/model/id
      // alias instead.
      // Reconstruct the consumed text from the original `phrase`
      // (preserving the user's original casing / spacing) by taking
      // the first `len` words from it. Trailing sentence punctuation
      // on the final word is dropped so the consumed length matches
      // the *meaningful* mention boundary — the `.` after `Planner`
      // stays in the surrounding text where it belongs.
      const consumedText = reconstructPrefix(phrase, len).replace(TRAILING_PUNCT_RE, '')
      if (eligible.length > 1) {
        return {
          participant: eligible[0],
          consumedText,
          ambiguousAmong: eligible.slice(1)
        }
      }
      return { participant: eligible[0], consumedText }
    }
  }
  return null
}

/**
 * Take the first `wordCount` whitespace-separated words from `phrase`,
 * preserving the original spacing between them. Used so the consumed
 * mention text retains the user's casing for display.
 */
function reconstructPrefix(phrase: string, wordCount: number): string {
  let consumed = 0
  let inWord = false
  for (let i = 0; i < phrase.length; i += 1) {
    const ch = phrase[i]
    const isSpace = /\s/.test(ch)
    if (!isSpace && !inWord) {
      consumed += 1
      inWord = true
      if (consumed > wordCount) {
        // Trim trailing whitespace from the cut point so we don't
        // hold onto a dangling space.
        return phrase.slice(0, i).replace(/\s+$/, '')
      }
    } else if (isSpace) {
      inWord = false
    }
  }
  return phrase
}

/**
 * Convenience: find the first mention in `text` that doesn't resolve
 * to a participant in `excludeIds`. Used by the orchestrator's auto-
 * promotion path where the speaker is filtered out to avoid self-
 * loops.
 */
export function findFirstMention(
  text: string,
  participants: EnsembleParticipant[],
  excludeIds?: ReadonlySet<string>
): MentionMatch | null {
  const all = findAllMentions(text, participants, excludeIds)
  return all[0] ?? null
}

/**
 * Predicate: does this text contain at least one resolved mention?
 * Faster than `findAllMentions` because it short-circuits on the
 * first hit. Used by the composer overlay to decide whether to
 * activate the transparent-textarea overlay layer.
 */
export function hasMention(text: string, participants: EnsembleParticipant[]): boolean {
  if (!text || !text.includes('@') || participants.length === 0) return false
  return findFirstMention(text, participants) !== null
}

/**
 * Resolve a plain phrase (no leading `@`) against the participant
 * alias set. Used by callers that have already stripped the `@`
 * (e.g. the legacy single-token `resolveParticipantToken` path).
 */
export function resolvePhraseToParticipant(
  phrase: string,
  participants: EnsembleParticipant[],
  excludeIds?: ReadonlySet<string>
): EnsembleParticipant | null {
  if (!phrase || participants.length === 0) return null
  const aliasMap = buildParticipantAliasMap(participants)
  const resolved = resolveMentionPhrase(phrase, aliasMap, excludeIds)
  if (resolved?.ambiguousAmong && resolved.ambiguousAmong.length > 0) return null
  return resolved?.participant ?? null
}

/** Mirror of the orchestrator's reserved-token gate so legacy
 * single-token callers stay in sync. Exported for tests. */
export function isReservedMentionToken(token: string): boolean {
  return RESERVED_TOKENS.has(token.trim().toLowerCase())
}

/** Companion to `isReservedMentionToken`: is this bare token one of the
 * user-mention aliases (`user` / `human` / `you`)? The assistant-side
 * `ParticipantMention` chip uses it to style an `@user` address
 * distinctly instead of letting it fall through to plain text. Reuses
 * the canonical `USER_ALIASES` set so renderer + orchestrator can't
 * drift. Exported for tests. */
export function isUserMentionToken(token: string): boolean {
  return USER_ALIASES.has(token.trim().toLowerCase())
}
