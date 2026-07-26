import { describe, expect, it } from 'vitest'
import {
  MISTRAL_BINARY_NAME,
  MISTRAL_DEFAULT_MODEL,
  MISTRAL_MODEL_DEVSTRAL_SMALL,
  MISTRAL_MODEL_MEDIUM,
  MISTRAL_UNGATED_SESSION_MODES,
  applyMistralPromptPreamble,
  buildMistralAcpCliArgs,
  mistralCredentialEnvScrubbed,
  mistralSessionModeForSeat,
  mistralSessionModeIsGated,
  mistralWriteCapable,
  normalizeMistralModel,
  normalizeMistralPlanId,
  normalizeMistralThinkingLevel,
  scrubMistralCredentialEnv
} from './MistralCliArgs'

describe('mistral binary + argv', () => {
  it('targets vibe-acp, never the interactive TUI', () => {
    // `vibe` and `vibe-acp` install side by side, so the wrong one is very easy
    // to pick — and `vibe` waits on a terminal a managed run does not have,
    // hanging the turn rather than failing it.
    expect(MISTRAL_BINARY_NAME).toBe('vibe-acp')
  })

  it('builds an EMPTY argv', () => {
    // vibe-acp's entire CLI surface is [-h] [-v] [--setup] (v2.22.0). This is
    // asserted rather than assumed so that anyone who later "fixes" the missing
    // model/mode flags by inventing them breaks a test instead of a run.
    expect(buildMistralAcpCliArgs()).toEqual([])
  })
})

describe('mistralWriteCapable', () => {
  it('treats plan as read-only, including with stray whitespace', () => {
    expect(mistralWriteCapable('plan')).toBe(false)
    expect(mistralWriteCapable('plan ')).toBe(false)
    expect(mistralWriteCapable(' plan')).toBe(false)
  })

  it('treats an empty or missing approval mode as read-only', () => {
    expect(mistralWriteCapable('')).toBe(false)
    expect(mistralWriteCapable('   ')).toBe(false)
    expect(mistralWriteCapable(null)).toBe(false)
    expect(mistralWriteCapable(undefined)).toBe(false)
  })

  it('treats other modes as write-capable', () => {
    expect(mistralWriteCapable('default')).toBe(true)
    expect(mistralWriteCapable('auto')).toBe(true)
  })
})

describe('session mode selection', () => {
  it('maps a read-only seat to plan and a write seat to default', () => {
    expect(mistralSessionModeForSeat(true)).toBe('plan')
    expect(mistralSessionModeForSeat(false)).toBe('default')
  })

  it('never selects a mode that bypasses the host approval gate', () => {
    // accept-edits and auto-approve auto-approve INSIDE the agent, so the tool
    // never raises session/request_permission and never reaches TaskWraith's
    // gate. Selecting either would silently delete the approval boundary while
    // every TaskWraith-side control still rendered as armed.
    for (const readOnly of [true, false]) {
      expect(MISTRAL_UNGATED_SESSION_MODES).not.toContain(mistralSessionModeForSeat(readOnly))
      expect(mistralSessionModeIsGated(mistralSessionModeForSeat(readOnly))).toBe(true)
    }
  })

  it('classifies the ungated modes as ungated', () => {
    expect(mistralSessionModeIsGated('auto-approve')).toBe(false)
    expect(mistralSessionModeIsGated('accept-edits')).toBe(false)
    expect(mistralSessionModeIsGated('chat')).toBe(true)
  })
})

describe('normalizeMistralModel', () => {
  it('defaults to devstral-small', () => {
    expect(MISTRAL_DEFAULT_MODEL).toBe(MISTRAL_MODEL_DEVSTRAL_SMALL)
    expect(normalizeMistralModel('')).toBe(MISTRAL_MODEL_DEVSTRAL_SMALL)
    expect(normalizeMistralModel(null)).toBe(MISTRAL_MODEL_DEVSTRAL_SMALL)
    expect(normalizeMistralModel(undefined)).toBe(MISTRAL_MODEL_DEVSTRAL_SMALL)
  })

  it('accepts both the ACP alias and the canonical Vibe name', () => {
    expect(normalizeMistralModel('mistral-medium-3.5')).toBe(MISTRAL_MODEL_MEDIUM)
    expect(normalizeMistralModel('mistral-vibe-cli-latest')).toBe(MISTRAL_MODEL_MEDIUM)
    expect(normalizeMistralModel('devstral-small')).toBe(MISTRAL_MODEL_DEVSTRAL_SMALL)
    expect(normalizeMistralModel('devstral-small-latest')).toBe(MISTRAL_MODEL_DEVSTRAL_SMALL)
    expect(normalizeMistralModel('  MISTRAL-MEDIUM-3.5  ')).toBe(MISTRAL_MODEL_MEDIUM)
  })

  it('never forwards a Pi upstream wire id', () => {
    // THE TWO-IDENTITIES COLLISION. ProviderId 'mistral' (this seat, plan OAuth)
    // and PiUpstreamId 'mistral' (BYOK, wire ids `mistral/<model>`) share a
    // runtime string. A slash means the id belongs to the OTHER provider; the
    // seat must clamp rather than forward it to Vibe, which would reject it
    // mid-turn and leave the session on an unintended model.
    expect(normalizeMistralModel('mistral/devstral-2512')).toBe(MISTRAL_DEFAULT_MODEL)
    expect(normalizeMistralModel('mistral/mistral-medium-3.5')).toBe(MISTRAL_DEFAULT_MODEL)
  })

  it('clamps an unknown id instead of passing it through', () => {
    // Stricter than grok/gemini deliberately: an id vibe-acp does not recognise
    // is rejected by session/set_config_option, silently leaving the session on
    // whatever the user's global ~/.vibe/config.toml active_model happened to be.
    expect(normalizeMistralModel('gpt-5')).toBe(MISTRAL_DEFAULT_MODEL)
    expect(normalizeMistralModel('local')).toBe(MISTRAL_DEFAULT_MODEL)
  })
})

describe('normalizeMistralThinkingLevel', () => {
  it('passes Vibe levels through', () => {
    for (const level of ['off', 'low', 'medium', 'high', 'max'] as const) {
      expect(normalizeMistralThinkingLevel(level)).toBe(level)
    }
  })

  it('clamps TaskWraith tiers Vibe has no equivalent for', () => {
    expect(normalizeMistralThinkingLevel('xhigh')).toBe('max')
    expect(normalizeMistralThinkingLevel('ultra')).toBe('max')
    expect(normalizeMistralThinkingLevel('minimal')).toBe('off')
  })

  it('returns null for an unmappable value rather than guessing', () => {
    // null means "send no thinking config option at all". Sending an
    // unrecognised value would be rejected and silently leave the model default.
    expect(normalizeMistralThinkingLevel('turbo')).toBeNull()
    expect(normalizeMistralThinkingLevel('')).toBeNull()
    expect(normalizeMistralThinkingLevel(null)).toBeNull()
  })
})

describe('credential env scrubbing', () => {
  it('removes both Mistral credential vars', () => {
    const scrubbed = scrubMistralCredentialEnv({
      MISTRAL_API_KEY: 'sk-live-secret',
      MISTRAL_TOKEN: 'tok',
      PATH: '/usr/bin'
    })
    expect(scrubbed.MISTRAL_API_KEY).toBeUndefined()
    expect(scrubbed.MISTRAL_TOKEN).toBeUndefined()
    expect(scrubbed.PATH).toBe('/usr/bin')
  })

  it('does not mutate the caller env', () => {
    // The caller's env is usually the shared resolved-env object; deleting in
    // place would scrub unrelated concurrent launches.
    const original = { MISTRAL_API_KEY: 'sk-live-secret', PATH: '/usr/bin' }
    scrubMistralCredentialEnv(original)
    expect(original.MISTRAL_API_KEY).toBe('sk-live-secret')
  })

  it('reports whether an env is clean', () => {
    expect(mistralCredentialEnvScrubbed({ PATH: '/usr/bin' })).toBe(true)
    expect(mistralCredentialEnvScrubbed({ MISTRAL_API_KEY: '' })).toBe(true)
    expect(mistralCredentialEnvScrubbed({ MISTRAL_API_KEY: 'sk-live' })).toBe(false)
    expect(mistralCredentialEnvScrubbed({ MISTRAL_TOKEN: 'tok' })).toBe(false)
  })

  it('round-trips: a scrubbed env reports clean', () => {
    const dirty = { MISTRAL_API_KEY: 'sk-live', MISTRAL_TOKEN: 'tok', HOME: '/Users/x' }
    expect(mistralCredentialEnvScrubbed(scrubMistralCredentialEnv(dirty))).toBe(true)
  })
})

describe('prompt preamble', () => {
  it('always prepends a steer, and a different one per tier', () => {
    const readOnly = applyMistralPromptPreamble('Do the thing.', false)
    const write = applyMistralPromptPreamble('Do the thing.', true)
    expect(readOnly).toContain('READ-ONLY mode')
    expect(readOnly).toContain('Do the thing.')
    expect(write).not.toContain('READ-ONLY mode')
    expect(write).toContain('Do the thing.')
    expect(readOnly).not.toBe(write)
  })

  it('tells a read-only seat not to dead-end on a refused tool', () => {
    // A seat whose write is refused mid-turn can hard-stop with no answer; the
    // steer is preventive UX, and the host gate remains the actual safety floor.
    expect(applyMistralPromptPreamble('x', false)).toContain('do NOT end your turn')
  })
})

describe('normalizeMistralPlanId', () => {
  it('recognises the known plans', () => {
    expect(normalizeMistralPlanId('free')).toBe('free')
    expect(normalizeMistralPlanId('Pro')).toBe('pro')
    expect(normalizeMistralPlanId(' TEAM ')).toBe('team')
  })

  it('treats anything else as unknown rather than erroring', () => {
    // 'unknown' is a first-class value: Vibe never reports which plan signed in,
    // so an un-configured seat legitimately sits here and the meter must still
    // produce an estimate.
    expect(normalizeMistralPlanId('enterprise')).toBe('unknown')
    expect(normalizeMistralPlanId('')).toBe('unknown')
    expect(normalizeMistralPlanId(null)).toBe('unknown')
  })
})
