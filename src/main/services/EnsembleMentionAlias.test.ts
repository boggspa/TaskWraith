import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../store/types'
import {
  buildParticipantAliasMap,
  findAllMentions,
  findFirstMention,
  generateModelAliases,
  getParticipantAliases,
  hasMention,
  isReservedMentionToken,
  isUserMentionToken,
  normalizeAlias,
  resolvePhraseToParticipant,
  resolveSingleEnsembleDmTarget
} from './EnsembleMentionAlias'

/**
 * Smoke + behaviour tests for the shared `@`-mention alias resolver.
 *
 * The resolver underpins three production surfaces (composer overlay
 * tokeniser, send-side DM routing, orchestrator auto-promotion) so
 * coverage here doubles as a regression net for all three. Tests are
 * deliberately tied to realistic 1.0.3+ model strings so that when
 * 1.0.4 introduces same-provider participants (two Claudes, two
 * Codexes, etc.), the model-name disambiguation keeps working.
 */

function participant(
  p: Partial<EnsembleParticipant> & Pick<EnsembleParticipant, 'id' | 'provider'>
): EnsembleParticipant {
  return {
    enabled: true,
    role: '',
    instructions: '',
    order: 0,
    ...p
  } as EnsembleParticipant
}

const CODEX = participant({
  id: 'ensemble-codex',
  provider: 'codex',
  role: 'Planner',
  model: 'gpt-5.5'
})
const CODEX_MINI = participant({
  id: 'ensemble-codex-mini',
  provider: 'codex',
  role: 'Reviewer',
  model: 'gpt-5.4-mini',
  order: 1
})
const CLAUDE = participant({
  id: 'ensemble-claude',
  provider: 'claude',
  role: 'Critic',
  model: 'claude-sonnet-4-7',
  order: 2
})
const GEMINI = participant({
  id: 'ensemble-gemini',
  provider: 'gemini',
  role: 'Researcher',
  model: 'gemini-2.5-flash-lite',
  order: 3
})
const KIMI = participant({
  id: 'ensemble-kimi',
  provider: 'kimi',
  role: 'Coder',
  model: 'kimi-k2.7-code-thinking',
  order: 4
})

const QUARTET = [CODEX, CLAUDE, GEMINI, KIMI]

describe('normalizeAlias', () => {
  it('lowercases and collapses whitespace + hyphens + underscores', () => {
    expect(normalizeAlias('GPT-5.5')).toBe('gpt 5.5')
    expect(normalizeAlias('Sonnet  4.7')).toBe('sonnet 4.7')
    expect(normalizeAlias('Kimi_K2.7_Code')).toBe('kimi k2.7 code')
    expect(normalizeAlias('  Flash--Lite  ')).toBe('flash lite')
  })
})

describe('generateModelAliases', () => {
  it('codex: includes bare version + gpt-prefixed + suffix variants', () => {
    const aliases = generateModelAliases('codex', 'gpt-5.5')
    expect(aliases).toContain('5.5')
    expect(aliases).toContain('gpt 5.5')
    // Concat form for fast typists.
    expect(aliases).toContain('gpt5.5')
  })

  it('codex: handles mini / suffix variants', () => {
    const aliases = generateModelAliases('codex', 'gpt-5.4-mini')
    expect(aliases).toContain('5.4 mini')
    expect(aliases).toContain('gpt 5.4 mini')
    expect(aliases).toContain('5.4')
  })

  it('claude: includes family + family+version + claude-prefixed forms', () => {
    const aliases = generateModelAliases('claude', 'claude-sonnet-4-7')
    expect(aliases).toContain('sonnet')
    expect(aliases).toContain('sonnet 4.7')
    expect(aliases).toContain('claude sonnet 4.7')
  })

  it('claude: fable single-digit version — the -1m marker is a suffix, not a minor version', () => {
    const aliases = generateModelAliases('claude', 'claude-fable-5-1m')
    expect(aliases).toContain('fable')
    expect(aliases).toContain('fable 5')
    expect(aliases).toContain('claude fable 5')
    expect(aliases).toContain('fable 5 1m')
    // Must NOT parse the context marker as a version (no "fable 5.1").
    expect(aliases).not.toContain('fable 5.1')
  })

  it('claude: mythos single-digit version aliases resolve like other Claude families', () => {
    const aliases = generateModelAliases('claude', 'claude-mythos-5')
    expect(aliases).toContain('mythos')
    expect(aliases).toContain('mythos 5')
    expect(aliases).toContain('claude mythos 5')
  })

  it('kimi: K2.7 Code + Kimi K2.7 Code + suffix forms', () => {
    const aliases = generateModelAliases('kimi', 'kimi-k2.7-code-thinking')
    expect(aliases).toContain('k2.7')
    expect(aliases).toContain('kimi k2.7')
    expect(aliases).toContain('k2.7 code')
    expect(aliases).toContain('kimi k2.7 code')
    expect(aliases).toContain('k2.7 code thinking')
  })

  it('kimi: legacy K2.6 aliases still resolve for old participants', () => {
    const aliases = generateModelAliases('kimi', 'kimi-k2.6-thinking')
    expect(aliases).toContain('k2.6')
    expect(aliases).toContain('kimi k2.6')
    expect(aliases).toContain('k2.6 thinking')
  })

  it('gemini: variant + tail-only aliases for Flash Lite et al.', () => {
    const aliases = generateModelAliases('gemini', 'gemini-2.5-flash-lite')
    expect(aliases).toContain('2.5 flash lite')
    expect(aliases).toContain('flash lite')
    expect(aliases).toContain('gemini 2.5 flash lite')
    // Final-word alias so two Geminis distinguished by Pro / Flash /
    // Lite can be tagged by the trailing word alone.
    expect(aliases).toContain('lite')
  })

  it('ollama: supports Qwen colon tags as mentionable model aliases', () => {
    const aliases = generateModelAliases('ollama', 'qwen3.5:9b')
    expect(aliases).toContain('qwen 3.5 9b')
    expect(aliases).toContain('qwen3.5 9b')
    expect(aliases).toContain('qwen')
    expect(aliases).toContain('qwen 3.5')
  })

  it('ollama: supports Ornith as a branded mention alias', () => {
    const aliases = generateModelAliases('ollama', 'ornith:35b')
    expect(aliases).toContain('ornith 35b')
    expect(aliases).toContain('ornith')
  })
})

describe('getParticipantAliases', () => {
  it('includes id, provider, role, and model aliases', () => {
    const aliases = new Set(getParticipantAliases(CODEX))
    expect(aliases.has('ensemble codex')).toBe(true)
    expect(aliases.has('codex')).toBe(true)
    expect(aliases.has('planner')).toBe(true)
    expect(aliases.has('gpt 5.5')).toBe(true)
    expect(aliases.has('5.5')).toBe(true)
  })

  it('skips reserved tokens that might land in role slot', () => {
    const sneaky = participant({
      id: 'ensemble-user',
      provider: 'codex',
      role: 'me',
      model: 'gpt-5.5'
    })
    const aliases = new Set(getParticipantAliases(sneaky))
    expect(aliases.has('me')).toBe(false)
  })
})

describe('isReservedMentionToken', () => {
  it('reserves the user-referencing pronouns', () => {
    expect(isReservedMentionToken('me')).toBe(true)
    expect(isReservedMentionToken('self')).toBe(true)
    // 1.0.4 — `user` / `human` / `you` are NO LONGER in
    // RESERVED_TOKENS. They now resolve to a UserMentionMatch
    // instead of being blackholed. See USER_ALIASES + the
    // `user-mention resolution` describe block.
    expect(isReservedMentionToken('user')).toBe(false)
    expect(isReservedMentionToken('human')).toBe(false)
    expect(isReservedMentionToken('codex')).toBe(false)
  })
})

describe('isUserMentionToken', () => {
  it('matches the user-mention aliases (user / human / you)', () => {
    expect(isUserMentionToken('user')).toBe(true)
    expect(isUserMentionToken('human')).toBe(true)
    expect(isUserMentionToken('you')).toBe(true)
    // Case + surrounding whitespace are normalised away.
    expect(isUserMentionToken('  USER ')).toBe(true)
  })
  it('does not match participants or the self-reserved tokens', () => {
    expect(isUserMentionToken('codex')).toBe(false)
    expect(isUserMentionToken('me')).toBe(false)
    expect(isUserMentionToken('self')).toBe(false)
    expect(isUserMentionToken('')).toBe(false)
  })
})

describe('buildParticipantAliasMap', () => {
  it('points each alias to the claiming participant(s)', () => {
    const map = buildParticipantAliasMap(QUARTET)
    expect(map.byAlias.get('codex')?.[0]).toBe(CODEX)
    expect(map.byAlias.get('gpt 5.5')?.[0]).toBe(CODEX)
    expect(map.byAlias.get('sonnet 4.7')?.[0]).toBe(CLAUDE)
    expect(map.byAlias.get('flash lite')?.[0]).toBe(GEMINI)
    expect(map.byAlias.get('k2.7 code')?.[0]).toBe(KIMI)
  })

  it('tracks word counts so longest-prefix wins', () => {
    const map = buildParticipantAliasMap(QUARTET)
    expect(map.aliasWordCount.get('codex')).toBe(1)
    expect(map.aliasWordCount.get('gpt 5.5')).toBe(2)
    expect(map.aliasWordCount.get('claude sonnet 4.7')).toBe(3)
  })
})

describe('findFirstMention — legacy single-token (back-compat)', () => {
  it('matches @codex by provider name', () => {
    const result = findFirstMention('@codex go ahead', QUARTET)
    expect(result?.kind).toBe('participant')
    if (result?.kind === 'participant') expect(result.participant.id).toBe(CODEX.id)
    expect(result?.text).toBe('codex')
    expect(result?.consumedLength).toBe('@codex'.length)
  })

  it('matches @Planner by role', () => {
    const result = findFirstMention('@Planner can you draft this?', QUARTET)
    expect(result?.kind).toBe('participant')
    if (result?.kind === 'participant') expect(result.participant.id).toBe(CODEX.id)
    expect(result?.text).toBe('Planner')
  })

  it('rejects email-style @ inside a word', () => {
    expect(findFirstMention('email chris@example.com', QUARTET)).toBeNull()
  })

  it('rejects reserved @me / @self', () => {
    // `@user` USED to be rejected (returned null) but as of 1.0.4
    // it resolves to a UserMentionMatch. See the
    // `user-mention resolution` block below for the new behaviour.
    expect(findFirstMention('thanks @me', QUARTET)).toBeNull()
    expect(findFirstMention('back to @self', QUARTET)).toBeNull()
  })
})

describe('findFirstMention — multi-word model aliases (the 1.0.4 lift)', () => {
  it('resolves @GPT 5.5 to the codex participant', () => {
    const result = findFirstMention('Hey @GPT 5.5 take a look', QUARTET)
    expect(result?.kind).toBe('participant')
    if (result?.kind === 'participant') expect(result.participant.id).toBe(CODEX.id)
    expect(result?.text).toBe('GPT 5.5')
    expect(result?.consumedLength).toBe('@GPT 5.5'.length)
  })

  it('resolves @Sonnet 4.7 to the claude participant', () => {
    const result = findFirstMention('plz review @Sonnet 4.7', QUARTET)
    expect(result?.kind).toBe('participant')
    if (result?.kind === 'participant') expect(result.participant.id).toBe(CLAUDE.id)
    expect(result?.text).toBe('Sonnet 4.7')
  })

  it('resolves @Flash Lite to the gemini participant', () => {
    const result = findFirstMention('@Flash Lite please summarise', QUARTET)
    expect(result?.kind).toBe('participant')
    if (result?.kind === 'participant') expect(result.participant.id).toBe(GEMINI.id)
    expect(result?.text).toBe('Flash Lite')
  })

  it('resolves @Kimi K2.7 Code to the kimi participant', () => {
    const result = findFirstMention('@Kimi K2.7 Code weigh in', QUARTET)
    expect(result?.kind).toBe('participant')
    if (result?.kind === 'participant') expect(result.participant.id).toBe(KIMI.id)
    expect(result?.text).toBe('Kimi K2.7 Code')
  })

  it('prefers longest-prefix when shorter prefixes also resolve', () => {
    // "kimi" alone resolves to KIMI, but "kimi k2.7 code thinking" is a
    // 4-word alias that must win when present.
    const result = findFirstMention('@Kimi K2.7 Code Thinking please', QUARTET)
    expect(result?.kind).toBe('participant')
    if (result?.kind === 'participant') expect(result.participant.id).toBe(KIMI.id)
    expect(result?.text).toBe('Kimi K2.7 Code Thinking')
  })

  it('falls back to shorter prefix when the longer one does not match', () => {
    // "@codex super-duper" — no "codex super-duper" alias, so it
    // resolves "codex" alone and leaves "super-duper" as trailing text.
    const result = findFirstMention('@codex super-duper move', QUARTET)
    expect(result?.kind).toBe('participant')
    if (result?.kind === 'participant') expect(result.participant.id).toBe(CODEX.id)
    expect(result?.text).toBe('codex')
  })

  it('excludes self-mentions via excludeIds', () => {
    const result = findFirstMention('@codex I am Codex, deferring', QUARTET, new Set([CODEX.id]))
    // Codex narrating itself by provider name → null when excluded.
    expect(result).toBeNull()
  })

  it('handles hyphen + concat alias forms', () => {
    // `@gpt-5.5` should resolve as well as `@GPT 5.5` and `@gpt5.5`.
    const checks = ['@gpt-5.5 hi', '@gpt5.5 hi', '@GPT 5.5 hi']
    for (const text of checks) {
      const match = findFirstMention(text, QUARTET)
      expect(match?.kind).toBe('participant')
      if (match?.kind === 'participant') expect(match.participant.id).toBe(CODEX.id)
    }
  })
})

describe('findAllMentions', () => {
  it('returns multiple mentions in order', () => {
    const all = findAllMentions('First @codex then @Sonnet 4.7 and @Flash Lite', QUARTET)
    expect(all).toHaveLength(3)
    expect(all[0].kind).toBe('participant')
    expect(all[1].kind).toBe('participant')
    expect(all[2].kind).toBe('participant')
    if (all[0].kind === 'participant') expect(all[0].participant.id).toBe(CODEX.id)
    if (all[1].kind === 'participant') expect(all[1].participant.id).toBe(CLAUDE.id)
    if (all[2].kind === 'participant') expect(all[2].participant.id).toBe(GEMINI.id)
  })

  it('preserves indices that point at the `@` character', () => {
    const text = 'hi @codex go'
    const all = findAllMentions(text, QUARTET)
    expect(text[all[0].atIndex]).toBe('@')
  })
})

describe('hasMention', () => {
  it('short-circuits with no @ in the text', () => {
    expect(hasMention('plain text', QUARTET)).toBe(false)
  })
  it('returns true for resolved mentions', () => {
    expect(hasMention('hi @codex', QUARTET)).toBe(true)
    expect(hasMention('hi @GPT 5.5', QUARTET)).toBe(true)
  })
  it('returns false for emails / unresolved tokens', () => {
    expect(hasMention('chris@example.com', QUARTET)).toBe(false)
    expect(hasMention('@unknownmodel', QUARTET)).toBe(false)
  })
})

describe('resolvePhraseToParticipant (legacy single-phrase entry point)', () => {
  it('resolves bare provider name', () => {
    expect(resolvePhraseToParticipant('codex', QUARTET)?.id).toBe(CODEX.id)
  })
  it('resolves multi-word model phrase', () => {
    expect(resolvePhraseToParticipant('gpt 5.5', QUARTET)?.id).toBe(CODEX.id)
    expect(resolvePhraseToParticipant('sonnet 4.7', QUARTET)?.id).toBe(CLAUDE.id)
  })
  it('honours excludeIds', () => {
    expect(resolvePhraseToParticipant('codex', QUARTET, new Set([CODEX.id]))).toBeNull()
  })
})

describe('Same-provider disambiguation (1.0.4 forward-look)', () => {
  it('GPT 5.5 vs GPT 5.4 Mini route to the right Codex participant', () => {
    const set = [CODEX, CODEX_MINI]
    const m1 = findFirstMention('@GPT 5.5 go', set)
    expect(m1?.kind).toBe('participant')
    if (m1?.kind === 'participant') expect(m1.participant.id).toBe(CODEX.id)
    const m2 = findFirstMention('@GPT 5.4 Mini go', set)
    expect(m2?.kind).toBe('participant')
    if (m2?.kind === 'participant') expect(m2.participant.id).toBe(CODEX_MINI.id)
    // The shared "codex" alias is intentionally non-routeable when
    // more than one enabled Codex participant exists. The mention
    // resolver still returns the candidate set so orchestrator callers
    // can warn instead of silently dropping the bad tag.
    const match = findFirstMention('@codex go', set)
    expect(match?.kind).toBe('participant')
    if (match?.kind === 'participant') {
      expect(match.participant.id).toBe(CODEX.id)
      expect(match.ambiguousAmong?.map((p) => p.id)).toEqual([CODEX_MINI.id])
    }
    expect(resolvePhraseToParticipant('codex', set)).toBeNull()
  })

  it('marks @codex ambiguous between two Codex peers', () => {
    // The 1.0.4 repro: speaker is Kimi, the ensemble has two Codex
    // participants, the model writes plain `@codex`. This must not
    // auto-promote either Codex lane; role/model/id mentions remain
    // the explicit routing surface.
    const set = [CODEX, CODEX_MINI, KIMI]
    const match = findFirstMention('@codex go', set, new Set([KIMI.id]))
    expect(match?.kind).toBe('participant')
    if (match?.kind === 'participant') {
      expect(match.participant.id).toBe(CODEX.id)
      expect(match.ambiguousAmong?.map((p) => p.id)).toEqual([CODEX_MINI.id])
    }
    expect(resolvePhraseToParticipant('codex', set, new Set([KIMI.id]))).toBeNull()
  })

  it('drops ambiguity flag once speaker-exclusion narrows to a single Codex', () => {
    // Speaker IS one of the Codex peers — excluding them leaves just
    // the OTHER Codex, so there is no actual ambiguity for the user
    // to disambiguate. No warning should fire.
    const set = [CODEX, CODEX_MINI]
    const match = findFirstMention('@codex go', set, new Set([CODEX.id]))
    expect(match?.kind).toBe('participant')
    if (match?.kind === 'participant') {
      expect(match.participant.id).toBe(CODEX_MINI.id)
      expect(match.ambiguousAmong).toBeUndefined()
    }
  })

  it('unambiguous role-name mention does not flag ambiguity', () => {
    // `@Reviewer` is unique to CODEX_MINI — only one candidate before
    // speaker-exclusion even runs, no warning.
    const set = [CODEX, CODEX_MINI]
    const match = findFirstMention('@Reviewer please', set)
    expect(match?.kind).toBe('participant')
    if (match?.kind === 'participant') {
      expect(match.participant.id).toBe(CODEX_MINI.id)
      expect(match.ambiguousAmong).toBeUndefined()
    }
  })
})

describe('user-mention resolution', () => {
  /**
   * `@user` / `@human` / `@you` are visible user-address tokens.
   * The resolver returns a UserMentionMatch (no `participant` field)
   * so routing code can distinguish them from participant targets.
   *
   * Resolved even when the ensemble has no participants — these
   * aliases are panel-independent.
   */
  const CODEX: EnsembleParticipant = participant({
    id: 'codex',
    provider: 'codex',
    role: 'Worker',
    model: 'gpt-5.5'
  })

  it('resolves @user to a UserMentionMatch', () => {
    const match = findFirstMention('@user back to you', [CODEX])
    expect(match?.kind).toBe('user')
    expect(match?.text.toLowerCase()).toBe('user')
  })

  it('resolves @human and @you the same way', () => {
    const matchHuman = findFirstMention('@human ready?', [CODEX])
    expect(matchHuman?.kind).toBe('user')

    const matchYou = findFirstMention('@you should approve this', [CODEX])
    expect(matchYou?.kind).toBe('user')
  })

  it('resolves user-mentions even when the ensemble has no participants', () => {
    // The user-mention path must be panel-independent — a chat
    // with no ensemble participants should still recognise the
    // token so the renderer can style it consistently.
    const match = findFirstMention('@user thoughts?', [])
    expect(match?.kind).toBe('user')
  })

  it('still does NOT resolve @me / @self (self-references stay reserved)', () => {
    expect(findFirstMention('@me speaking', [CODEX])).toBeNull()
    expect(findFirstMention('@self note', [CODEX])).toBeNull()
  })

  it('strips trailing punctuation before matching user aliases', () => {
    // `@user.` and `@user,` both resolve — same trailing-punct
    // strip as participant aliases.
    expect(findFirstMention('@user.', [CODEX])?.kind).toBe('user')
    expect(findFirstMention('@user,', [CODEX])?.kind).toBe('user')
  })

  it('participant mentions before a user mention are still resolved in order', () => {
    // `findAllMentions` should yield both — runtime routing ignores
    // the user-address token, and the renderer overlay still styles it.
    const matches = findAllMentions('@codex then @user', [CODEX])
    expect(matches.length).toBe(2)
    expect(matches[0].kind).toBe('participant')
    expect(matches[1].kind).toBe('user')
  })
})

describe('resolveSingleEnsembleDmTarget', () => {
  const panel = [CODEX, CLAUDE, GEMINI, KIMI]

  it('returns the id when exactly one participant is tagged (provider or role)', () => {
    expect(resolveSingleEnsembleDmTarget('@codex look at this', panel)).toBe('ensemble-codex')
    expect(resolveSingleEnsembleDmTarget('hey @Critic thoughts?', panel)).toBe('ensemble-claude')
  })

  it('returns null when two or more participants are tagged (panel round)', () => {
    expect(resolveSingleEnsembleDmTarget('@codex and @Critic compare', panel)).toBeNull()
  })

  it('returns null when no participant is tagged', () => {
    expect(resolveSingleEnsembleDmTarget('just a normal message', panel)).toBeNull()
    expect(resolveSingleEnsembleDmTarget('', panel)).toBeNull()
  })

  it('ignores user-address mentions (not a DM target)', () => {
    expect(resolveSingleEnsembleDmTarget('@user what do you think', panel)).toBeNull()
  })

  it('returns null for ambiguous provider mentions', () => {
    expect(resolveSingleEnsembleDmTarget('@codex review this', [CODEX, CODEX_MINI])).toBeNull()
  })

  it('dedupes repeated mentions of one participant to a single target', () => {
    expect(resolveSingleEnsembleDmTarget('@codex @codex urgent', panel)).toBe('ensemble-codex')
  })
})
