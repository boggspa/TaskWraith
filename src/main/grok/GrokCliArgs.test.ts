import { describe, it, expect } from 'vitest'
import {
  buildGrokAcpCliArgs,
  buildGrokCliArgs,
  buildGrokProviderCliArgs,
  buildGrokProviderPrompt,
  applyGrokNativeGoalPrompt,
  formatGrokGoalSlashCommand,
  normalizeGrokEffortFlag,
  grokWriteCapable,
  applyGrokReadOnlyPromptPreamble,
  applyGrokPromptPreamble,
  GROK_READ_ONLY_PROMPT_PREAMBLE,
  GROK_WRITE_MODE_PROMPT_PREAMBLE,
  GROK_READ_ONLY_DENY_RULES,
  GROK_WRITE_MODE_DENY_RULES
} from './GrokCliArgs'
import type { ActiveGoal } from '../store/types'

const grokNativeGoal: ActiveGoal = {
  id: 'goal-1',
  objective: 'Migrate the auth module to the new API',
  status: 'active',
  mode: 'grok_native',
  provider: 'grok',
  createdAt: '2026-06-22T12:00:00Z',
  updatedAt: '2026-06-22T12:00:00Z'
}

describe('normalizeGrokEffortFlag', () => {
  it('returns null for nullish, empty, or off values', () => {
    expect(normalizeGrokEffortFlag(null)).toBeNull()
    expect(normalizeGrokEffortFlag(undefined)).toBeNull()
    expect(normalizeGrokEffortFlag('')).toBeNull()
    expect(normalizeGrokEffortFlag('off')).toBeNull()
  })

  it('passes through documented effort levels case-insensitively', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(normalizeGrokEffortFlag(level)).toBe(level)
    }
    expect(normalizeGrokEffortFlag('HIGH')).toBe('high')
  })

  it('rejects unknown values rather than passing them to the CLI', () => {
    expect(normalizeGrokEffortFlag('extreme')).toBeNull()
    expect(normalizeGrokEffortFlag('123')).toBeNull()
  })
})

describe('buildGrokCliArgs', () => {
  const base = { prompt: 'explain this repo', workspace: '/tmp/ws' }
  const discordPrompt = [
    'Summarize build status.',
    '',
    'External Discord channel snapshot context.',
    '<discord_messages channel="123" encoding="markdown-fence">',
    '``` text',
    '[2026-06-16T12:00:00.000Z] alice: CI failed on linux.',
    '```',
    '</discord_messages>'
  ].join('\n')

  it('emits the read-only baseline argv', () => {
    const args = buildGrokCliArgs(base)
    expect(args).toEqual([
      '--no-auto-update',
      '-p',
      'explain this repo',
      '--cwd',
      '/tmp/ws',
      '--output-format',
      'streaming-json',
      '--permission-mode',
      'plan',
      '--disable-web-search',
      '--deny',
      'Bash(*)',
      '--deny',
      'Shell(*)',
      '--deny',
      'Edit(*)',
      '--deny',
      'Write(*)'
    ])
  })

  it('always pins permission-mode to plan (never a write mode)', () => {
    const args = buildGrokCliArgs(base)
    const modeIndex = args.indexOf('--permission-mode')
    expect(args[modeIndex + 1]).toBe('plan')
    expect(args).not.toContain('acceptEdits')
    expect(args).not.toContain('auto')
    expect(args).not.toContain('dontAsk')
    expect(args).not.toContain('bypassPermissions')
  })

  it('NEVER emits --always-approve', () => {
    expect(buildGrokCliArgs(base)).not.toContain('--always-approve')
    expect(
      buildGrokCliArgs({ ...base, model: 'grok-code-fast-1', reasoningEffort: 'high' })
    ).not.toContain('--always-approve')
  })

  it('denies the write/shell/edit tools to keep the run read-only', () => {
    const args = buildGrokCliArgs(base)
    const denied = args
      .map((value, index) => (value === '--deny' ? args[index + 1] : null))
      .filter((value): value is string => value !== null)
    expect(denied).toEqual([...GROK_READ_ONLY_DENY_RULES])
  })

  it('denies BOTH Bash and Shell so the Composer shell tool cannot hard-cancel a read-only turn', () => {
    // Regression: Grok Composer 2.5 names its shell tool `Shell`, not `Bash`.
    // With only `Bash(*)` denied, a read-only Composer turn that reached for
    // `Shell` (e.g. `git status`) was refused by the host gate and HARD-CANCELLED
    // (stopReason: cancelled, no answer) instead of answering from its reads.
    // Both shell-tool names must be in the read-only deny set.
    const args = buildGrokCliArgs(base)
    expect(args).toContain('Bash(*)')
    expect(args).toContain('Shell(*)')
  })

  it('disables web search for hermeticity', () => {
    expect(buildGrokCliArgs(base)).toContain('--disable-web-search')
  })

  it('forwards --model only for genuine Grok model ids', () => {
    expect(buildGrokCliArgs(base)).not.toContain('--model')
    expect(buildGrokCliArgs({ ...base, model: 'default' })).not.toContain('--model')
    expect(buildGrokCliArgs({ ...base, model: 'cli-default' })).not.toContain('--model')
    // Regression guard (G3e): a model id carried over from another provider's
    // picker (e.g. Gemini's 'flash-lite') must NOT be forwarded — Grok rejects
    // unknown ids and the run fails with "unknown model id".
    expect(buildGrokCliArgs({ ...base, model: 'flash-lite' })).not.toContain('--model')
    expect(buildGrokCliArgs({ ...base, model: 'claude-opus-4-7' })).not.toContain('--model')
    const args = buildGrokCliArgs({ ...base, model: 'grok-code-fast-1' })
    expect(args[args.indexOf('--model') + 1]).toBe('grok-code-fast-1')
    const composerArgs = buildGrokCliArgs({ ...base, model: 'grok-composer-2.5-fast' })
    expect(composerArgs[composerArgs.indexOf('--model') + 1]).toBe('grok-composer-2.5-fast')
  })

  it('builds ACP stdio args with selected Grok model and effort before the subcommand', () => {
    const args = buildGrokAcpCliArgs({
      model: 'grok-composer-2.5-fast',
      reasoningEffort: 'high',
      readOnlySeat: true
    })

    expect(args[0]).toBe('--no-auto-update')
    expect(args[args.indexOf('--model') + 1]).toBe('grok-composer-2.5-fast')
    expect(args[args.indexOf('--effort') + 1]).toBe('high')
    expect(args.slice(-2)).toEqual(['agent', 'stdio'])
    expect(args.indexOf('--model')).toBeLessThan(args.indexOf('agent'))
    expect(args.indexOf('--effort')).toBeLessThan(args.indexOf('agent'))
    expect(
      args
        .map((value, index) => (value === '--deny' ? args[index + 1] : null))
        .filter(Boolean)
    ).toEqual([...GROK_READ_ONLY_DENY_RULES])
  })

  it('does not forward foreign model ids to ACP stdio', () => {
    expect(buildGrokAcpCliArgs({ model: 'composer-2.5-fast' })).not.toContain('--model')
    expect(buildGrokAcpCliArgs({ model: 'flash-lite' })).not.toContain('--model')
    expect(buildGrokAcpCliArgs({ model: 'grok-build' })).toContain('--model')
  })

  it('preserves Discord context prompt text as the Grok print prompt', () => {
    const args = buildGrokCliArgs({
      ...base,
      prompt: discordPrompt,
      approvalMode: 'default'
    })

    expect(args[args.indexOf('-p') + 1]).toBe(discordPrompt)
    expect(args[args.indexOf('-p') + 1]).toContain('External Discord channel snapshot context')
  })

  it('provider wrapper prepends Grok steering while preserving Discord context', () => {
    const args = buildGrokProviderCliArgs({
      ...base,
      prompt: discordPrompt,
      approvalMode: 'default'
    })
    const prompt = args[args.indexOf('-p') + 1]

    expect(prompt.startsWith(GROK_WRITE_MODE_PROMPT_PREAMBLE)).toBe(true)
    expect(prompt.endsWith(discordPrompt)).toBe(true)
    expect(prompt).toContain('<discord_messages')
  })

  it('provider wrapper anchors native Grok goals before all steering text', () => {
    const args = buildGrokProviderCliArgs({
      ...base,
      prompt: discordPrompt,
      approvalMode: 'default',
      activeGoal: grokNativeGoal
    })
    const prompt = args[args.indexOf('-p') + 1]

    expect(prompt.startsWith('/goal Migrate the auth module to the new API')).toBe(true)
    expect(prompt.indexOf('/goal')).toBe(0)
    expect(prompt).toContain(GROK_WRITE_MODE_PROMPT_PREAMBLE)
    expect(prompt.indexOf('/goal')).toBeLessThan(prompt.indexOf(GROK_WRITE_MODE_PROMPT_PREAMBLE))
    expect(prompt.endsWith(discordPrompt)).toBe(true)
  })

  it('maps reasoning effort onto --effort only for documented levels', () => {
    const args = buildGrokCliArgs({ ...base, reasoningEffort: 'high' })
    expect(args[args.indexOf('--effort') + 1]).toBe('high')
    expect(buildGrokCliArgs({ ...base, reasoningEffort: 'off' })).not.toContain('--effort')
    expect(buildGrokCliArgs({ ...base, reasoningEffort: 'bogus' })).not.toContain('--effort')
  })

  it('G6 — resumes a prior session via --resume only when an id is present', () => {
    // Fresh chat (no id): no --resume → a new session is started.
    expect(buildGrokCliArgs(base)).not.toContain('--resume')
    expect(buildGrokCliArgs({ ...base, providerSessionId: null })).not.toContain('--resume')
    expect(buildGrokCliArgs({ ...base, providerSessionId: '' })).not.toContain('--resume')
    expect(buildGrokCliArgs({ ...base, providerSessionId: '   ' })).not.toContain('--resume')
    // Follow-up turn: resume the captured session by id.
    const args = buildGrokCliArgs({ ...base, providerSessionId: 'sess_abc123' })
    expect(args[args.indexOf('--resume') + 1]).toBe('sess_abc123')
  })

  it('G6 — resume stays read-only (still plan mode, still denies writes)', () => {
    const args = buildGrokCliArgs({ ...base, providerSessionId: 'sess_abc123' })
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(args).toContain('Bash(*)')
    expect(args).not.toContain('--always-approve')
  })

  it('G5c — read-only when approvalMode is plan / unset', () => {
    for (const approvalMode of [undefined, null, '', '   ', 'plan']) {
      const args = buildGrokCliArgs({ ...base, approvalMode })
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
      // All write/shell tools denied — incl. Composer's `Shell` shell-tool name.
      expect(args).toContain('Edit(*)')
      expect(args).toContain('Write(*)')
      expect(args).toContain('Bash(*)')
      expect(args).toContain('Shell(*)')
    }
  })

  it('G5c — file-write mode (non-plan): acceptEdits, Edit/Write/Bash all allowed (no deny rules)', () => {
    const args = buildGrokCliArgs({ ...base, approvalMode: 'default' })
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
    // Edit/Write are applied + diff-reviewed; Bash is now ALSO allowed in write
    // mode (user-enabled perms — a denied Bash hard-cancelled the turn with no
    // answer). Nothing is denied in write mode any more.
    expect(args).not.toContain('Edit(*)')
    expect(args).not.toContain('Write(*)')
    expect(args).not.toContain('Bash(*)')
    expect(args).not.toContain('Shell(*)')
    const denied = args
      .map((value, index) => (value === '--deny' ? args[index + 1] : null))
      .filter((value): value is string => value !== null)
    expect(denied).toEqual([...GROK_WRITE_MODE_DENY_RULES])
    expect(denied).toEqual([])
  })

  it('G5c — write mode NEVER emits --always-approve (no auto-approve escape hatch)', () => {
    expect(buildGrokCliArgs({ ...base, approvalMode: 'default' })).not.toContain('--always-approve')
    expect(buildGrokCliArgs({ ...base, approvalMode: 'acceptEdits' })).not.toContain(
      '--always-approve'
    )
    expect(buildGrokCliArgs({ ...base, approvalMode: 'auto' })).not.toContain('--always-approve')
  })

  it('G5c — write mode composes with resume + model', () => {
    const args = buildGrokCliArgs({
      ...base,
      approvalMode: 'default',
      providerSessionId: 'sess_x',
      model: 'grok-code-fast-1'
    })
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
    expect(args[args.indexOf('--resume') + 1]).toBe('sess_x')
    expect(args[args.indexOf('--model') + 1]).toBe('grok-code-fast-1')
  })
})

describe('grokWriteCapable', () => {
  it('is false for read-only (plan / empty / nullish), true otherwise', () => {
    expect(grokWriteCapable(undefined)).toBe(false)
    expect(grokWriteCapable(null)).toBe(false)
    expect(grokWriteCapable('')).toBe(false)
    expect(grokWriteCapable('   ')).toBe(false)
    expect(grokWriteCapable('plan')).toBe(false)
    expect(grokWriteCapable('default')).toBe(true)
    expect(grokWriteCapable('acceptEdits')).toBe(true)
    expect(grokWriteCapable('auto')).toBe(true)
  })

  it('treats whitespace-padded plan as READ-ONLY (resume posture regression guard)', () => {
    expect(grokWriteCapable('plan ')).toBe(false)
    expect(grokWriteCapable(' plan')).toBe(false)
    expect(grokWriteCapable('\tplan\n')).toBe(false)
  })
})

describe('applyGrokPromptPreamble', () => {
  const discordPrompt = [
    'Summarize build status.',
    '',
    'External Discord channel snapshot context.',
    '<discord_messages channel="123" encoding="markdown-fence">',
    '``` text',
    '[2026-06-16T12:00:00.000Z] alice: CI failed on linux.',
    '```',
    '</discord_messages>'
  ].join('\n')

  it('prepends the WRITE steer for a write-capable seat', () => {
    const out = applyGrokPromptPreamble('write the files', true)
    expect(out.startsWith(GROK_WRITE_MODE_PROMPT_PREAMBLE)).toBe(true)
    expect(out.endsWith('write the files')).toBe(true)
    expect(out).not.toContain(GROK_READ_ONLY_PROMPT_PREAMBLE)
  })

  it('prepends the read-only steer for a read-only seat', () => {
    const out = applyGrokPromptPreamble('list the TODOs', false)
    expect(out.startsWith(GROK_READ_ONLY_PROMPT_PREAMBLE)).toBe(true)
    expect(out.endsWith('list the TODOs')).toBe(true)
  })

  it('ALWAYS steers — a write seat is no longer passed through unchanged (the dead-end fix)', () => {
    // The bug: write/'default' seats got no steer, so a refused shell tool
    // dead-ended the turn (stopReason: Cancelled, 0 output). Both seats must now
    // carry a steer.
    expect(applyGrokPromptPreamble('x', true)).not.toBe('x')
    expect(applyGrokPromptPreamble('x', false)).not.toBe('x')
  })

  it("steers 'default' approval mode as write-capable (the reported regression)", () => {
    const out = applyGrokPromptPreamble('write files', grokWriteCapable('default'))
    expect(out.startsWith(GROK_WRITE_MODE_PROMPT_PREAMBLE)).toBe(true)
  })

  it('write steer points at the file tools and tells Grok not to end on a refusal', () => {
    // Guards intent, not exact wording: mentions Write/Edit + don't-end/adapt.
    const lower = GROK_WRITE_MODE_PROMPT_PREAMBLE.toLowerCase()
    expect(lower).toContain('write')
    expect(lower).toContain('edit')
    expect(lower).toMatch(/do not end|don't end|adapt|switch/)
  })

  it('prepends Grok steering without dropping Discord context', () => {
    const out = applyGrokPromptPreamble(discordPrompt, true)

    expect(out.startsWith(GROK_WRITE_MODE_PROMPT_PREAMBLE)).toBe(true)
    expect(out.endsWith(discordPrompt)).toBe(true)
    expect(out).toContain('External Discord channel snapshot context')
  })

  it('provider ACP prompt helper preserves Discord context after steering', () => {
    const out = buildGrokProviderPrompt(discordPrompt, 'plan')

    expect(out.startsWith(GROK_READ_ONLY_PROMPT_PREAMBLE)).toBe(true)
    expect(out.endsWith(discordPrompt)).toBe(true)
    expect(out).toContain('<discord_messages')
  })
})

describe('formatGrokGoalSlashCommand', () => {
  it('formats active native Grok goals as a one-line slash command', () => {
    expect(
      formatGrokGoalSlashCommand({
        ...grokNativeGoal,
        objective: 'Migrate auth\n\nand keep tests passing'
      })
    ).toBe('/goal Migrate auth and keep tests passing')
  })

  it('formats blocked native Grok goals but ignores paused/completed or non-native goals', () => {
    expect(formatGrokGoalSlashCommand({ ...grokNativeGoal, status: 'blocked' })).toBe(
      '/goal Migrate the auth module to the new API'
    )
    expect(formatGrokGoalSlashCommand({ ...grokNativeGoal, status: 'paused' })).toBeNull()
    expect(formatGrokGoalSlashCommand({ ...grokNativeGoal, status: 'completed' })).toBeNull()
    expect(
      formatGrokGoalSlashCommand({ ...grokNativeGoal, mode: 'taskwraith_steered' })
    ).toBeNull()
  })

  it('keeps /goal as the first bytes of the provider prompt', () => {
    const prompt = applyGrokNativeGoalPrompt(
      `${GROK_READ_ONLY_PROMPT_PREAMBLE}\n\nInspect only.`,
      grokNativeGoal
    )

    expect(prompt.startsWith('/goal Migrate the auth module to the new API')).toBe(true)
    expect(prompt).toContain(GROK_READ_ONLY_PROMPT_PREAMBLE)
    expect(prompt.indexOf('/goal')).toBeLessThan(prompt.indexOf(GROK_READ_ONLY_PROMPT_PREAMBLE))
  })
})

describe('applyGrokReadOnlyPromptPreamble', () => {
  it('prepends the read-only steer for a read-only seat, preserving the prompt', () => {
    const out = applyGrokReadOnlyPromptPreamble('list the open TODOs', true)
    // The steer leads; the user's prompt is preserved verbatim after it.
    expect(out.startsWith(GROK_READ_ONLY_PROMPT_PREAMBLE)).toBe(true)
    expect(out.endsWith('list the open TODOs')).toBe(true)
    expect(out).toContain('READ-ONLY mode')
  })

  it('leaves a write-capable seat prompt untouched (no steer leak)', () => {
    const prompt = 'refactor the parser'
    expect(applyGrokReadOnlyPromptPreamble(prompt, false)).toBe(prompt)
    expect(applyGrokReadOnlyPromptPreamble(prompt, false)).not.toContain('READ-ONLY mode')
  })

  it('gates exactly on the read-only seat (mirrors grokWriteCapable)', () => {
    // The steer rides the same read-only seat the deny rules gate: plan/unset →
    // read-only (steer applied), anything else → write-capable (no steer).
    const readOnlySeatPlan = !grokWriteCapable('plan')
    const readOnlySeatDefault = !grokWriteCapable('default')
    expect(applyGrokReadOnlyPromptPreamble('x', readOnlySeatPlan)).toContain(
      GROK_READ_ONLY_PROMPT_PREAMBLE
    )
    expect(applyGrokReadOnlyPromptPreamble('x', readOnlySeatDefault)).toBe('x')
  })

  it('steer tells Grok not to attempt writes and to answer instead', () => {
    // Guards the intent (not exact wording): do-not-attempt + answer/explain.
    expect(GROK_READ_ONLY_PROMPT_PREAMBLE).toMatch(/do not attempt/i)
    expect(GROK_READ_ONLY_PROMPT_PREAMBLE).toMatch(/read/i)
    expect(GROK_READ_ONLY_PROMPT_PREAMBLE).toMatch(/explain what you would change/i)
  })
})
