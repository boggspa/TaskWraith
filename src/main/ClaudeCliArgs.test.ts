import { describe, it, expect } from 'vitest'
import {
  buildClaudeCliArgs,
  claudeDispatchPrompt,
  claudeFastModeSettingsArg,
  normalizeClaudeEffortFlag,
  normalizeClaudeEffortFlagForModel
} from './ClaudeCliArgs'

describe('normalizeClaudeEffortFlag', () => {
  it('returns null for nullish, empty, or off values', () => {
    expect(normalizeClaudeEffortFlag(null)).toBeNull()
    expect(normalizeClaudeEffortFlag(undefined)).toBeNull()
    expect(normalizeClaudeEffortFlag('')).toBeNull()
    expect(normalizeClaudeEffortFlag('off')).toBeNull()
    expect(normalizeClaudeEffortFlag('  ')).toBeNull()
  })

  it('passes through documented effort levels case-insensitively', () => {
    expect(normalizeClaudeEffortFlag('low')).toBe('low')
    expect(normalizeClaudeEffortFlag('Medium')).toBe('medium')
    expect(normalizeClaudeEffortFlag('HIGH')).toBe('high')
    expect(normalizeClaudeEffortFlag('xhigh')).toBe('xhigh')
    expect(normalizeClaudeEffortFlag('max')).toBe('max')
  })

  it('maps TaskWraith display aliases onto Claude-supported effort flags', () => {
    expect(normalizeClaudeEffortFlag('extra')).toBe('xhigh')
    expect(normalizeClaudeEffortFlag('ultracode')).toBe('max')
  })

  it('rejects unknown values rather than passing them to the CLI', () => {
    expect(normalizeClaudeEffortFlag('extreme')).toBeNull()
    expect(normalizeClaudeEffortFlag('123')).toBeNull()
  })
})

describe('normalizeClaudeEffortFlagForModel', () => {
  it('drops reasoning for Haiku models', () => {
    expect(normalizeClaudeEffortFlagForModel('max', 'claude-haiku-4-5')).toBeNull()
    expect(normalizeClaudeEffortFlagForModel('ultracode', 'haiku')).toBeNull()
  })

  it('keeps the legacy Sonnet 4.x line on its capped effort ladder', () => {
    expect(normalizeClaudeEffortFlagForModel('high', 'claude-sonnet-4-6')).toBe('high')
    expect(normalizeClaudeEffortFlagForModel('xhigh', 'claude-sonnet-4-6')).toBeNull()
    expect(normalizeClaudeEffortFlagForModel('ultracode', 'claude-sonnet-4-6')).toBe('max')
  })

  it('lets the Sonnet 5 family use the full Opus-equivalent Claude CLI ladder', () => {
    expect(normalizeClaudeEffortFlagForModel('high', 'claude-sonnet-5')).toBe('high')
    expect(normalizeClaudeEffortFlagForModel('xhigh', 'claude-sonnet-5')).toBe('xhigh')
    expect(normalizeClaudeEffortFlagForModel('ultracode', 'claude-sonnet-5')).toBe('max')
    // Future Sonnet 5 variants share the ladder...
    expect(normalizeClaudeEffortFlagForModel('xhigh', 'claude-sonnet-5-1m')).toBe('xhigh')
    // ...but a numeric lookalike must NOT be mistaken for the Sonnet 5 family.
    expect(normalizeClaudeEffortFlagForModel('xhigh', 'claude-sonnet-50')).toBeNull()
  })

  it('allows Opus/Fable/Mythos/custom models to use the full Claude CLI ladder', () => {
    expect(normalizeClaudeEffortFlagForModel('xhigh', 'claude-opus-5')).toBe('xhigh')
    expect(normalizeClaudeEffortFlagForModel('ultracode', 'claude-opus-5')).toBe('max')
    expect(normalizeClaudeEffortFlagForModel('xhigh', 'claude-opus-4-8')).toBe('xhigh')
    expect(normalizeClaudeEffortFlagForModel('ultracode', 'claude-fable-5-1m')).toBe('max')
    expect(normalizeClaudeEffortFlagForModel('xhigh', 'claude-mythos-5')).toBe('xhigh')
    expect(normalizeClaudeEffortFlagForModel('xhigh', 'custom-model')).toBe('xhigh')
  })
})

describe('buildClaudeCliArgs', () => {
  const base = {
    prompt: 'hello',
    permissionMode: 'default',
    model: 'default'
  }

  it('emits the baseline argv with required flags', () => {
    const args = buildClaudeCliArgs(base)
    expect(args).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'default',
      '--tools',
      '',
      '--setting-sources',
      '',
      '--strict-mcp-config'
    ])
    expect(args).not.toContain('--budget-tokens')
    expect(args).not.toContain('--effort')
  })

  it('appends --model only when not the placeholder default', () => {
    const args = buildClaudeCliArgs({ ...base, model: 'claude-opus-4-7' })
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-7')
  })

  it('translates claudeReasoningEffort=high into --effort high (never --budget-tokens)', () => {
    const args = buildClaudeCliArgs({ ...base, claudeReasoningEffort: 'high' })
    const effortIndex = args.indexOf('--effort')
    expect(effortIndex).toBeGreaterThan(-1)
    expect(args[effortIndex + 1]).toBe('high')
    expect(args).not.toContain('--budget-tokens')
  })

  it('omits --effort when reasoning is off or missing', () => {
    expect(buildClaudeCliArgs({ ...base, claudeReasoningEffort: 'off' })).not.toContain('--effort')
    expect(buildClaudeCliArgs({ ...base, claudeReasoningEffort: null })).not.toContain('--effort')
    expect(buildClaudeCliArgs({ ...base })).not.toContain('--effort')
  })

  it('maps every documented effort level 1:1', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const args = buildClaudeCliArgs({ ...base, claudeReasoningEffort: effort })
      expect(args).toContain('--effort')
      expect(args[args.indexOf('--effort') + 1]).toBe(effort)
    }
  })

  it('maps Ultracode to Claude max effort at dispatch', () => {
    const args = buildClaudeCliArgs({
      ...base,
      model: 'claude-opus-4-8',
      claudeReasoningEffort: 'ultracode'
    })
    expect(args).toContain('--effort')
    expect(args[args.indexOf('--effort') + 1]).toBe('max')
  })

  it('does not pass an effort flag for Haiku', () => {
    const args = buildClaudeCliArgs({
      ...base,
      model: 'claude-haiku-4-5',
      claudeReasoningEffort: 'max'
    })
    expect(args).not.toContain('--effort')
  })

  it('appends --resume when a provider session id is supplied', () => {
    const args = buildClaudeCliArgs({ ...base, providerSessionId: 'sess-123' })
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-123')
  })

  it('never emits an image flag — the installed CLI has none', () => {
    // `--image` was an invalid option (claude --help lists no image flag);
    // spawning with it would kill the fallback outright. Image delivery is
    // the SDK lane's job; the fallback refuses image runs upstream.
    const args = buildClaudeCliArgs(base)
    expect(args).not.toContain('--image')
  })

  it('passes the permissionMode through verbatim', () => {
    const args = buildClaudeCliArgs({ ...base, permissionMode: 'acceptEdits' })
    const modeIndex = args.indexOf('--permission-mode')
    expect(args[modeIndex + 1]).toBe('acceptEdits')
  })

  it('passes Claude fast mode through --settings when enabled', () => {
    const args = buildClaudeCliArgs({ ...base, claudeFastMode: true })
    const settingsIndex = args.indexOf('--settings')
    expect(settingsIndex).toBeGreaterThan(-1)
    expect(args[settingsIndex + 1]).toBe('{"fastMode":true}')
  })

  it('passes Claude fast mode through --settings when disabled', () => {
    const args = buildClaudeCliArgs({ ...base, claudeFastMode: false })
    const settingsIndex = args.indexOf('--settings')
    expect(settingsIndex).toBeGreaterThan(-1)
    expect(args[settingsIndex + 1]).toBe('{"fastMode":false}')
  })

  it('omits Claude fast-mode settings when the renderer did not choose a value', () => {
    expect(buildClaudeCliArgs({ ...base })).not.toContain('--settings')
    expect(buildClaudeCliArgs({ ...base, claudeFastMode: null })).not.toContain('--settings')
  })

  it('keeps empty --setting-sources by default and for suppress/tw-only posture', () => {
    expect(buildClaudeCliArgs(base)).toEqual(expect.arrayContaining(['--setting-sources', '']))
    expect(
      buildClaudeCliArgs({
        ...base,
        harnessPosture: { skills: 'suppress', hooks: 'suppress' }
      })
    ).toEqual(expect.arrayContaining(['--setting-sources', '']))
    expect(
      buildClaudeCliArgs({
        ...base,
        harnessPosture: { skills: 'tw-only', hooks: 'tw-only' }
      })
    ).toEqual(expect.arrayContaining(['--setting-sources', '']))
  })

  it('omits empty --setting-sources when both channels allow-native', () => {
    const args = buildClaudeCliArgs({
      ...base,
      harnessPosture: { skills: 'allow-native', hooks: 'allow-native' }
    })
    expect(args).not.toContain('--setting-sources')
    expect(args).toContain('--strict-mcp-config')
  })

  it('keeps empty --setting-sources when only one channel allows native', () => {
    const args = buildClaudeCliArgs({
      ...base,
      harnessPosture: { skills: 'allow-native', hooks: 'suppress' }
    })
    expect(args).toEqual(expect.arrayContaining(['--setting-sources', '']))
  })
})

describe('claudeFastModeSettingsArg', () => {
  it('serializes boolean fast-mode settings for Claude Code', () => {
    expect(claudeFastModeSettingsArg(true)).toBe('{"fastMode":true}')
    expect(claudeFastModeSettingsArg(false)).toBe('{"fastMode":false}')
  })

  it('returns null for unset values', () => {
    expect(claudeFastModeSettingsArg(null)).toBeNull()
    expect(claudeFastModeSettingsArg(undefined)).toBeNull()
  })
})

describe('claudeDispatchPrompt', () => {
  it('sends the slim prompt when a session will be resumed', () => {
    expect(
      claudeDispatchPrompt({
        prompt: 'slim',
        providerSessionId: 'sess-1',
        resumeFallbackPrompt: 'seeded recovery prompt'
      })
    ).toBe('slim')
  })

  it('sends the full-context recovery prompt on a sessionless dispatch', () => {
    expect(
      claudeDispatchPrompt({
        prompt: 'slim',
        providerSessionId: null,
        resumeFallbackPrompt: 'seeded recovery prompt'
      })
    ).toBe('seeded recovery prompt')
  })

  it('falls back to the plain prompt when no recovery prompt was composed', () => {
    expect(claudeDispatchPrompt({ prompt: 'slim' })).toBe('slim')
    expect(claudeDispatchPrompt({ prompt: 'slim', resumeFallbackPrompt: '' })).toBe('slim')
  })
})
